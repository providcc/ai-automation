/**
 * SQL 校验：把 SQL 交给平台**按真实数据源连接**走一遍（平台会真的执行这条只读 SELECT）。
 *
 * 平台没有"执行任意 SQL"的端点，但有"分析 SQL 语句获取字段列表"的端点：
 *   POST /rest/esb/process/tablereadnode/parsesql/columns   body: { dbConnId, sql }
 * 实测行为（重要，别写错）：
 *   - 它**会真的执行这条 SELECT**（返回的是真实结果集的列清单）；
 *   - 表/列不存在、语法错误 → 数据库原话（如 Unknown column 'a.x' in 'field list'）；
 *   - **结果集为空** → 平台回 state=false「SQL语句执行时未发现数据」——这是**合法但没数据**，
 *     不是 SQL 有问题，工具单独归类（reason='no-data'），不要当成失败。
 *
 * 因此只接受**单条**只读语句（SELECT/WITH/SHOW/EXPLAIN/DESCRIBE），并禁止 INTO OUTFILE/DUMPFILE、
 * FOR UPDATE、LOCK IN SHARE MODE 这类有副作用/加锁的写法。
 * 「单条」这条同样关键：`SELECT 1; DROP TABLE t` 的前缀完全合法，平台会两条都执行。
 * 判定见 `sql-text.ts`（与 dw 查询闸门共用一份）。
 *
 * 用途：流程里的 SQL 在存进去之前先验一遍，避免"存得进去、运行时才炸"。
 */
import type { RestCloudClient } from './client.ts';
import { RcError } from './errors.ts';
import { isReadOnlyStatement, type ReadOnlyVerdict } from './sql-text.ts';

export interface SqlCheckOptions {
  /** 数据源连接 id（流程节点属性里的 dbConnId） */
  conn: string;
  /** 要校验的 SQL */
  sql: string;
}

export interface SqlColumn {
  name: string;
  type?: string;
  length?: string;
}

export interface SqlCheckResult {
  ok: boolean;
  /** 校验前替换掉的平台占位符个数（${condition} 之类） */
  placeholdersReplaced?: number;
  /** 解析出的列 */
  columns: SqlColumn[];
  /** 数据库原话（失败时最有价值） */
  error?: string;
  /** 归一化后的原因分类 */
  reason?: 'column' | 'table' | 'syntax' | 'connection' | 'permission' | 'no-data' | 'other';
  /** 下一步提示 */
  hint?: string;
  traceId?: string;
}

/**
 * 只允许只读语句。
 *
 * 判定与 dw 的查询闸门**共用** `isReadOnlyStatement`：多语句、CTE 前缀、
 * 可执行注释这些坑在两个入口必须表现一致，否则一个口子就是全盘的口子。
 * 这里比 dw 更危险——平台会**真的执行**这条 SQL。
 */
export function isReadOnlySql(sql: string): boolean {
  return isReadOnlyStatement(sql).ok;
}

/** 只读判定的错误信息。`action` 决定尾缀是"不检查"还是"不执行"。 */
function notReadOnlyError(v: Exclude<ReadOnlyVerdict, { ok: true }>, action: string): RcError {
  // hint: '' —— 消息本身已经说清了该怎么改，别再追加"对照流程图规格"那类默认提示
  // （E_VALIDATION 的默认提示是给流程图/参数场景写的，用在这里会把人指向无关文档）。
  const opts = { hint: '' };
  if (v.kind === 'unsafe') {
    return new RcError(
      'E_VALIDATION',
      `语句里有有副作用或加锁的写法（INTO OUTFILE / DUMPFILE / FOR UPDATE / LOCK IN SHARE MODE），${action}`,
      opts,
    );
  }
  if (v.kind === 'multi') {
    return new RcError(
      'E_VALIDATION',
      `只允许单条语句：检测到多条语句（;）——平台会真的执行这条 SQL，${action}`,
      opts,
    );
  }
  if (v.kind === 'cte') {
    return new RcError(
      'E_VALIDATION',
      `只允许只读语句：WITH 之后的主语句是写操作（${v.detail ?? '无法识别'}），${action}`,
      opts,
    );
  }
  return new RcError('E_VALIDATION', '只允许只读语句（SELECT / WITH / SHOW / EXPLAIN / DESCRIBE）', opts);
}

/** 只读且没有副作用子句；否则抛可行动的错误。 */
function assertSafeSql(sql: string, action: string): void {
  const v = isReadOnlyStatement(sql);
  if (!v.ok) throw notReadOnlyError(v, action);
}

/** 从平台消息里剥掉通用 500 噪声，只留数据库原话。 */
export function extractDbError(msg: string): string {
  const s = String(msg ?? '');
  const cut = s.search(/平台内部错误（HTTP|平台网关|常见原因/);
  return (cut > 0 ? s.slice(0, cut) : s).trim();
}

/** 数据库报错 → 原因分类 + 提示。 */
export function classifySqlError(raw: string): { reason: SqlCheckResult['reason']; hint: string } {
  const m = raw.toLowerCase();
  if (/unknown column|unknown function|column .* doesn't exist/.test(m)) {
    return { reason: 'column', hint: 'SQL 里引用了不存在的列：对照表结构改字段名（`rc sql check` 会返回解析出的列清单）。' };
  }
  if (/doesn't exist|unknown table|table .* not found/.test(m)) {
    return { reason: 'table', hint: 'SQL 里引用的表不存在：检查库名/表名（含库前缀，如 `db`.`table`）。' };
  }
  if (/syntax|you have an error in your sql/.test(m)) {
    return { reason: 'syntax', hint: 'SQL 语法错误：先用数据库客户端或平台设计器校验语法。' };
  }
  if (/未发现数据|no data|empty result/.test(m)) {
    return { reason: 'no-data', hint: 'SQL 合法，但结果集为空——平台把"0 行"也回成失败，这不代表 SQL 有问题。' };
  }
  if (/access denied|permission|not allowed/.test(m)) {
    return { reason: 'permission', hint: '当前连接没有该表的权限：换一个只读账号或让 DBA 授权。' };
  }
  if (/connection|communications link|timeout|can't connect/.test(m)) {
    return { reason: 'connection', hint: '连不上数据源：先用 `rc datasource test <id>` 检查连通性。' };
  }
  return { reason: 'other', hint: '把上面的数据库原话贴给平台方/DBA 定位。' };
}

/**
 * 平台在运行时才替换 SQL 里的占位符（`${condition}` / `${offset}` / `${ids}` …），
 * 直接把原文丢给数据库解析必然报语法错误。校验前先把它们替换成**语义等价的安全字面量**：
 * 条件 → `1=1`，分页/行数 → 数字，id 列表 → 字符串。
 */
const PLACEHOLDER = /\$\{([^}]+)\}/g;

function normalizeSqlPlaceholders(sql: string): { sql: string; replaced: number } {
  let replaced = 0;
  const src = String(sql ?? '');
  const out = src.replace(PLACEHOLDER, (_m, rawName: string, offset: number) => {
    replaced++;
    const name = String(rawName).toLowerCase();
    if (/condition|where|filter|expr|having/.test(name)) {
      // 平台的 ${condition} 展开成一整串 `AND xxx`（不是裸布尔），
      // 所以要按"前面是不是已经在条件位"来决定补不补 AND。
      const before = src.slice(Math.max(0, offset - 60), offset);
      const inConditionSlot = /(where|and|or|having|on)\s*$/i.test(before);
      return inConditionSlot ? '1=1' : 'AND 1=1';
    }
    if (/offset|limit|pagesize|size|start|index|count|rownum|top/.test(name)) return '10';
    return "'x'";
  });
  return { sql: out, replaced };
}

/**
 * 校验一条 SQL（只解析、不执行）。
 */
export async function checkSql(c: RestCloudClient, opts: SqlCheckOptions): Promise<SqlCheckResult> {
  const sql = String(opts.sql ?? '').trim();
  const conn = String(opts.conn ?? '').trim();
  if (!conn) throw new RcError('E_VALIDATION', '需要 --conn <dbConnId>（数据源连接 id）');
  if (!sql) throw new RcError('E_VALIDATION', '需要 --query <SQL>');
  assertSafeSql(sql, '不检查');

  const normalized = normalizeSqlPlaceholders(sql);
  const r = await c.request('/rest/esb/process/tablereadnode/parsesql/columns', {
    method: 'POST',
    body: { dbConnId: conn, sql: normalized.sql },
    dryRun: false,
  });
  const payload = r.data?.data ?? r.data;
  const rows: any[] = Array.isArray(payload) ? payload : (payload?.rows ?? payload?.columns ?? []);
  if (r.ok) {
    const columns: SqlColumn[] = rows.map((c2: any) => ({
      name: String(c2?.colName ?? c2?.name ?? c2?.columnName ?? ''),
      type: c2?.colType === undefined ? undefined : String(c2.colType),
      length: c2?.colLength === undefined ? undefined : String(c2.colLength),
    })).filter((c2) => c2.name);
    return { ok: true, columns, placeholdersReplaced: normalized.replaced };
  }
  const raw = extractDbError(String(r.msg ?? '校验失败'));
  const { reason, hint } = classifySqlError(raw);
  return { ok: false, columns: [], error: raw, reason, hint, traceId: r.traceId, placeholdersReplaced: normalized.replaced };
}

/** 按顶层逗号切分 SQL 片段（忽略括号/反引号内的逗号）。 */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quote = '';
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '`' || ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * 本地推导 SELECT 列表的列名。
 * 平台的取数端点要求"字段配置"非空，但**先调用解析端点会污染这个状态**（之后预览一直报
 * "字段配置中的字段不能为空"）→ 所以先用本地推导的列名去取数，列名最终以平台返回的 columns 为准。
 */
export function deriveSqlColumns(sql: string): { colName: string; colType: string }[] {
  const m = /^\s*select\s+([\s\S]+?)\s+from\s/i.exec(String(sql ?? ''));
  if (!m) return [];
  const out: { colName: string; colType: string }[] = [];
  for (const item of splitTopLevel(m[1])) {
    const t = item.trim();
    if (!t) continue;
    if (t === '*' || /^\*/.test(t)) { out.push({ colName: '*', colType: '' }); continue; }
    const alias = /\s+as\s+([`"']?[\w\u4e00-\u9fa5]+[`"']?)\s*$/i.exec(t);
    const name = alias
      ? alias[1].replace(/[`"']/g, '')
      : (t.split('.').pop() ?? t).replace(/[`"'\s]/g, '').split(/\s+/)[0];
    if (name) out.push({ colName: name, colType: '' });
  }
  return out;
}

export interface SqlQueryResult {
  ok: boolean;
  columns: { colId: string; colName: string; colType?: string }[];
  rows: Record<string, unknown>[];
  total: number;
  error?: string;
  reason?: SqlCheckResult['reason'];
  hint?: string;
  /** 第一步解析时替换掉的占位符个数 */
  placeholdersReplaced?: number;
}

/**
 * 真取数：两步（与平台前端一致）。
 *   ① parsesql/columns  → 列清单（顺便就是 SQL 校验）
 *   ② previewdata（带 tableColumns 的 **JSON 字符串**）→ {rowsData, columns, total}
 *
 * 坑（实测）：
 *   - `tableColumns` 必须是 JSON 字符串，传数组会报 "MalformedJ array"；
 *   - 返回体是 `{rowsData, columns, total}`，不是 data/rows；
 *   - ① 报"未发现数据"= SQL 合法但 0 行，平台此时拿不到字段，② 也跑不了。
 */
export async function querySql(
  c: RestCloudClient,
  opts: { conn: string; sql: string; maxRows?: number; tableColumns?: string },
): Promise<SqlQueryResult> {
  const sql = String(opts.sql ?? '').trim();
  const conn = String(opts.conn ?? '').trim();
  if (!conn) throw new RcError('E_VALIDATION', '需要 --conn <dbConnId>（数据源连接 id）');
  if (!sql) throw new RcError('E_VALIDATION', '需要 --query <SQL>');
  assertSafeSql(sql, '不执行');
  const maxRows = Math.max(1, Math.min(500, opts.maxRows ?? 50));
  const normalized = normalizeSqlPlaceholders(sql);

  // ① 先取数（本地推导的列名做"字段配置"）——注意：先调解析端点会让后续取数一直失败
  const localCols = deriveSqlColumns(normalized.sql);
  const candidates: string[] = [];
  if (opts.tableColumns) candidates.push(opts.tableColumns);          // 用户显式给的字段配置优先
  if (localCols.length) candidates.push(JSON.stringify(localCols));
  let columns: { colId: string; colName: string; colType?: string }[] = [];
  let lastError = '取数失败';
  let lastReason: SqlQueryResult['reason'];
  let lastHint: string | undefined;

  for (const tableColumns of candidates) {
    const p2 = await c.request('/rest/esb/process/tablereadnode/previewdata', {
      method: 'POST',
      body: { dbConnId: conn, sql: normalized.sql, nodeId: 'SQL_CHECK', tableColumns },
      dryRun: false,
    });
    const d: any = p2.data?.data ?? p2.data;
    if (p2.ok) {
      const rows: Record<string, unknown>[] = Array.isArray(d?.rowsData) ? d.rowsData : (Array.isArray(d) ? d : []);
      const total = Number(d?.total ?? rows.length);
      const cols = Array.isArray(d?.columns)
        ? d.columns.map((c2: any) => ({
          colId: String(c2?.colId ?? c2?.colName ?? ''),
          colName: String(c2?.colName ?? c2?.name ?? ''),
          colType: c2?.colType === undefined ? undefined : String(c2.colType),
        }))
        : columns;
      return { ok: true, columns: cols, rows: rows.slice(0, maxRows), total, placeholdersReplaced: normalized.replaced };
    }
    const raw = extractDbError(String(p2.msg ?? '取数失败'));
    const cls = classifySqlError(raw);
    lastError = raw;
    lastReason = cls.reason;
    lastHint = cls.hint;
  }

  // ② 取数失败 → 走解析端点拿权威的列与错误信息（此时平台会给出列/表/语法错误）
  const p1 = await c.request('/rest/esb/process/tablereadnode/parsesql/columns', {
    method: 'POST', body: { dbConnId: conn, sql: normalized.sql }, dryRun: false,
  });
  const rawCols: any[] = Array.isArray(p1.data?.data) ? p1.data.data : (p1.data?.data?.columns ?? []);
  if (!p1.ok) {
    const raw = extractDbError(String(p1.msg ?? '解析失败'));
    const { reason, hint } = classifySqlError(raw);
    return { ok: false, columns: [], rows: [], total: 0, error: raw, reason, hint, placeholdersReplaced: normalized.replaced };
  }
  columns = rawCols.map((c2: any) => ({
    colId: String(c2?.colId ?? c2?.name ?? ''),
    colName: String(c2?.colName ?? c2?.name ?? ''),
    colType: c2?.colType === undefined ? undefined : String(c2.colType),
  })).filter((c2) => c2.colName);
  return {
    ok: false, columns, rows: [], total: 0, error: lastError, reason: lastReason,
    hint: lastHint ?? '平台取数端点依赖会话态的"字段配置"，偶发失败；重试一次，或从真实节点复制 tableColumns（JSON 字符串）用 --table-columns 传入',
    placeholdersReplaced: normalized.replaced,
  };
}

/** 渲染取数结果（表格）。 */
export function formatSqlQuery(res: SqlQueryResult): string {
  if (!res.ok) {
    return [`✖ 查询失败：${res.error ?? '未知原因'}`, res.hint ? `  → ${res.hint}` : ''].filter(Boolean).join('\n');
  }
  if (!res.rows.length) return '✔ 查询成功，但没有数据行';
  const cols = res.columns.length ? res.columns.map((c) => c.colName) : Object.keys(res.rows[0]);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    return s.length > 60 ? `${s.slice(0, 59)}…` : s;
  };
  const widths = cols.map((c) => Math.max(c.length, ...res.rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  const out = [line(cols)];
  out.push(widths.map((w) => '-'.repeat(w)).join('  ').trimEnd());
  for (const r of res.rows) out.push(line(cols.map((c) => cell(r[c]))));
  if (res.total > res.rows.length) out.push(`…（共 ${res.total} 行，只显示前 ${res.rows.length} 行）`);
  return out.join('\n');
}

/** 渲染校验结果（人读）。 */
export function formatSqlCheck(res: SqlCheckResult): string {
  if (res.ok) {
    if (!res.columns.length) return '✔ SQL 解析通过（平台没有返回列清单）';
    return [`✔ SQL 解析通过，解析出 ${res.columns.length} 列：`, ...res.columns.map((c) => `  ${c.name}${c.type ? ` (${c.type})` : ''}`)].join('\n');
  }
  if (res.reason === 'no-data') {
    return [`✔ SQL 通过校验（结果集为空：${res.error ?? '平台未返回数据'}）`, res.hint ? `  · ${res.hint}` : ''].filter(Boolean).join('\n');
  }
  return [`✖ SQL 校验失败：${res.error ?? '未知原因'}`, res.hint ? `  → ${res.hint}` : ''].filter(Boolean).join('\n');
}
