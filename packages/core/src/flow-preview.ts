/**
 * 流程节点数据预览（只读）。
 *
 * 平台没有"对数据源执行任意 SQL"的通用端点，只有**节点级预览**：
 *   ESB: POST /rest/esb/process/tablereadnode/previewdata   （按 SQL 预览）
 *        POST /rest/esb/process/tablewritenode/preview      （按表预览）
 *   ETL: POST /rest/etl/process/{sqlreadnode|metadatareadnode|mongodbreadnode}/previewdata
 *        POST /rest/etl/process/elasticsearch/previewdata
 *
 * 安全约束：
 *   1. 端点是**固定白名单**，不接受调用方传路径；
 *   2. **不接受命令行传入的裸 SQL**——SQL/表名/连接只能取自流程里已保存的节点配置；
 *   3. limit 有上限（默认 20，最大 100），只取前 N 行；
 *   4. 语义是只读预览（不写平台数据）。
 */
import type { RestCloudClient, ApiResult } from './client.ts';
import { getNodeProps, listFlowProps, type NodePropsRecord, type FlowKind } from './flow-lifecycle.ts';
import { deriveSqlColumns } from './sql-check.ts';

interface PreviewTarget {
  /** 平台预览端点 */
  endpoint: string;
  /** 节点类型说明（用于报错） */
  label: string;
}

/**
 * 节点类型 → 平台预览端点（白名单）。
 * 节点类型取自组件目录（catalog/components.json、catalog/etl-components.json），
 * 端点取自平台契约（catalog/war/endpoints.json）。
 */
const TARGETS: Record<string, PreviewTarget> = {
  // ESB：按 SQL 预览（表读取 / SQL 执行器）、按表预览（表写入目标表）
  tableReadNode: { endpoint: '/rest/esb/process/tablereadnode/previewdata', label: '表读取节点' },
  sqlExecuterNode: { endpoint: '/rest/esb/process/tablereadnode/previewdata', label: 'SQL 执行节点' },
  jdbcWriteNode: { endpoint: '/rest/esb/process/tablewritenode/preview', label: '表写入节点' },
  // ETL
  sqlReadNode: { endpoint: '/rest/etl/process/sqlreadnode/previewdata', label: 'SQL 读取节点' },
  tableBatchReadNode: { endpoint: '/rest/etl/process/sqlreadnode/previewdata', label: '批量表读取节点' },
  metadataReadNode: { endpoint: '/rest/etl/process/metadatareadnode/previewdata', label: '元数据读取节点' },
  mongoDbReadNode: { endpoint: '/rest/etl/process/mongodbreadnode/previewdata', label: 'Mongo 读取节点' },
  elasticReadNode: { endpoint: '/rest/etl/process/elasticsearch/previewdata', label: 'ES 读取节点' },
};

export interface PreviewOptions {
  processId: string;
  nodeId: string;
  kind?: FlowKind;
  /** 返回行数上限（默认 20，最大 100） */
  limit?: number;
}

export interface PreviewResult {
  ok: boolean;
  /** 预览的节点类型 */
  nodeType?: string;
  /** 表头 */
  columns: string[];
  /** 数据行（已按 limit 截断） */
  rows: Record<string, unknown>[];
  /** 实际返回的行数（截断前） */
  totalRows: number;
  /** 被截断时为 true */
  truncated: boolean;
  /** 平台原始消息（成功/失败都尽量带上） */
  msg?: string;
  /** 失败或不支持时的可行动提示 */
  hint?: string;
  traceId?: string;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/** 从平台返回里取出列与行（兼容多种形态）。 */
export function extractPreviewRows(payload: any): { columns: string[]; rows: Record<string, unknown>[] } {
  let data = payload;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    data = data.data ?? data.rows ?? data.records ?? data.list ?? data.result ?? data;
  }
  if (Array.isArray(data)) {
    const rows = data.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : { value: x }));
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { columns, rows };
  }
  if (!data || typeof data !== 'object') return { columns: [], rows: [] };

  const rawRows = data.rows ?? data.records ?? data.list ?? data.dataList ?? [];
  const rows: Record<string, unknown>[] = Array.isArray(rawRows)
    ? rawRows.map((x: any) => (x && typeof x === 'object' && !Array.isArray(x) ? x : { value: x }))
    : [];

  let columns: string[] = [];
  const rawCols = data.columns ?? data.fields ?? data.tableColumns ?? data.columnList;
  if (Array.isArray(rawCols)) {
    columns = rawCols.map((c: any) => (typeof c === 'string' ? c : String(c?.name ?? c?.columnName ?? c?.key ?? c?.label ?? ''))).filter(Boolean);
  }
  if (!columns.length && rows.length) columns = Object.keys(rows[0]);
  return { columns, rows };
}

/** 平台常见报错的可行动提示。 */
function hintFor(msg: string, nodeType?: string): string | undefined {
  if (/字段配置中的字段不能为空|字段不能为空/.test(msg)) {
    return '该节点的"字段/列配置"在平台上是空的，平台无法预览：'
      + '先在流程设计器里给这个节点配置字段（列），或用 `flow props list --only sql` 看它现在存了什么。';
  }
  if (/不能为空/.test(msg)) return '平台认为缺少必填参数（通常是连接/表名），先补齐节点属性再预览。';
  if (/没有权限|未授权|403/.test(msg)) return '当前账号没有该数据源的访问权限。';
  if (/连接|connect|timeout|超时/.test(msg)) return '数据源连不上：先用 `rc datasource test <id>` 检查连通性。';
  if (nodeType && !TARGETS[nodeType]) return `节点类型 ${nodeType} 没有平台预览端点（只有表/SQL/Mongo/ES 类节点支持）。`;
  return undefined;
}

/**
 * 预览一个流程节点的数据（只读）。
 */
export async function previewFlowNode(
  c: RestCloudClient,
  opts: PreviewOptions,
): Promise<PreviewResult> {
  const kind = opts.kind ?? 'esb';
  const limit = Math.max(1, Math.min(MAX_LIMIT, opts.limit ?? DEFAULT_LIMIT));

  // 1) 取节点属性（决定用哪个预览端点、拿 sql/表名/连接）
  let props: NodePropsRecord = {};
  try {
    props = await getNodeProps(c, opts.processId, opts.nodeId, { kind });
  } catch {
    props = {};
  }
  if (!props || !Object.keys(props).length) {
    // 退回到全量属性（有的节点读单条会 500）
    const all = await listFlowProps(c, opts.processId, { kind });
    props = all.props[opts.nodeId] ?? {};
  }
  const nodeType = String(props.pNodeType ?? '');
  const target = TARGETS[nodeType];
  if (!target) {
    return {
      ok: false, columns: [], rows: [], totalRows: 0, truncated: false,
      msg: `节点类型 ${nodeType || '(未知)'} 没有平台预览端点`,
      hint: `支持预览的节点类型：${Object.keys(TARGETS).join('、')}。`
        + 'SQL 节点可用 `flow props list --only sql` 看 SQL 原文。',
    };
  }

  // 2) 组装请求体：只取节点已保存的配置，不接受外部传入的 SQL
  const body: Record<string, unknown> = {
    processId: opts.processId,
    nodeId: opts.nodeId,
    limit,
  };
  const sql = props.sqlCode;
  if (sql) body.sql = sql;
  const tableName = props.tableName;
  if (tableName) body.tableName = tableName;
  const dbConnId = props.dbConnId ?? props.datasourceId;
  if (dbConnId) body.dbConnId = dbConnId;
  const columns = props.tableColumns ?? props.columns;
  if (columns) body.tableColumns = columns;

  // 3) 调平台（只读预览）。平台的取数端点要求"字段配置"非空，且**先调解析端点会污染这个状态**
  //    （之后一直报"字段配置中的字段不能为空"）→ 先用本地推导的列名取数。
  const localCols = deriveSqlColumns(String(sql ?? ''));
  if (localCols.length) body.tableColumns = JSON.stringify(localCols);
  let r: ApiResult = await c.request(target.endpoint, { method: 'POST', body, dryRun: false });
  if (!r.ok && /字段配置|字段不能为空/.test(String(r.msg ?? '')) && !body.tableColumns) {
    // 兜底：让平台解析一次列，再重试
    const cols = await c.request('/rest/esb/process/tablereadnode/parsesql/columns', {
      method: 'POST', body: { dbConnId: dbConnId, sql }, dryRun: false,
    });
    const rawCols: any[] = Array.isArray(cols.data?.data) ? cols.data.data : [];
    if (rawCols.length) {
      body.tableColumns = JSON.stringify(rawCols);
      r = await c.request(target.endpoint, { method: 'POST', body, dryRun: false });
    }
  }
  const payload = r.data?.data ?? r.data;
  if (!r.ok) {
    const msg = String(r.msg ?? '预览失败');
    return {
      ok: false, nodeType, columns: [], rows: [], totalRows: 0, truncated: false,
      msg, hint: hintFor(msg, nodeType), traceId: r.traceId,
    };
  }
  const { columns: cols, rows } = extractPreviewRows(payload);
  const totalRows = rows.length;
  const out = rows.slice(0, limit);
  return {
    ok: true, nodeType, columns: cols, rows: out, totalRows, truncated: totalRows > out.length,
    msg: r.msg, traceId: r.traceId,
  };
}

/** 把预览结果渲染成等宽表格（列多时自动截断单元格）。 */
export function formatPreviewTable(res: PreviewResult, maxCell = 60): string {
  if (!res.ok) return `✖ 预览失败：${res.msg ?? '未知原因'}${res.hint ? `\n  → ${res.hint}` : ''}`;
  if (!res.rows.length) return `✔ 预览成功，但没有数据行（节点类型 ${res.nodeType}）`;
  const cols = res.columns.length ? res.columns : Object.keys(res.rows[0]);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    return s.length > maxCell ? `${s.slice(0, maxCell - 1)}…` : s;
  };
  const widths = cols.map((c) => Math.max(c.length, ...res.rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  const out = [line(cols)];
  out.push(widths.map((w) => '-'.repeat(w)).join('  ').trimEnd());
  for (const r of res.rows) out.push(line(cols.map((c) => cell(r[c]))));
  if (res.truncated) out.push(`…（共 ${res.totalRows} 行，只显示前 ${res.rows.length} 行）`);
  return out.join('\n');
}
