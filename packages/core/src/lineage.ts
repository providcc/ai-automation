/**
 * 血缘与影响面（v2 Phase 1.3）
 *
 * 平台端点（WAR 取证）：
 *   GET /rest/etl/relationship/tables/in|out       表级流入/流出
 *   GET /rest/etl/relationship/datasource          数据源关系
 *   GET /rest/etl/relationship/metatable/link      元数据模型血缘
 *   GET /rest/apiportal/application/relationship   应用关系图
 *   GET /rest/core/report/api/slim/application/call/relation  API 调用关系
 *
 * 额外：基于流程详情的静态深度影响面（含子流程递归、API id/名称/路径三种命中）。
 */
import type { RestCloudClient } from './client.ts';
import { impactOfApi, unwrapRows } from './api.ts';

export type Direction = 'in' | 'out';

export const LINEAGE = {
  tableIn: '/rest/etl/relationship/tables/in',
  tableOut: '/rest/etl/relationship/tables/out',
  datasource: '/rest/etl/relationship/datasource',
  metaTable: '/rest/etl/relationship/metatable/link',
  appRelationship: '/rest/apiportal/application/relationship',
  apiCallRelation: '/rest/core/report/api/slim/application/call/relation',
} as const;

export interface TableLineageNode {
  tableName: string;
  processId?: string;
  processName?: string;
  datasourceId?: string;
  datasourceName?: string;
  direction: Direction;
  raw?: unknown;
}

function pickRows(payload: any): any[] {
  const d = payload?.data ?? payload;
  return unwrapRows(d);
}

/** 表级血缘：表名可能是 db.table 或纯表名，平台按 tableName 查询 */
export interface TableLineageResult {
  rows: TableLineageNode[];
  /** 空结果时的原因说明（区分"没人写这张表"和"索引没建/没同步"） */
  note?: string;
}

export async function tableLineage(
  c: RestCloudClient,
  tableName: string,
  opts: { direction?: Direction; limit?: number } = {},
): Promise<TableLineageResult> {
  const direction = opts.direction ?? 'in';
  const path = direction === 'in' ? LINEAGE.tableIn : LINEAGE.tableOut;
  const r = await c.request(path, { method: 'GET', query: { tableName, name: tableName, limit: opts.limit ?? 200 } });
  const rows = pickRows(r.data);
  const nodes = rows.map((x: any) => ({
    tableName: String(x.tableName ?? x.table ?? tableName),
    processId: x.processId ? String(x.processId) : undefined,
    processName: x.processName ?? x.configName,
    datasourceId: x.datasourceId ?? x.dbConnId,
    datasourceName: x.datasourceName ?? x.dbConnName,
    direction,
    raw: x,
  }));
  const note = nodes.length ? undefined : (
    `平台血缘索引里没有 ${tableName} 的记录。两种可能：`
    + `① 没有任何流程写这张表（表名可能写错、或只被手工 SQL 引用）；`
    + `② 血缘索引没建或没同步到这张表。`
    + `区分办法：rc flow list --keyword ${tableName} 找相关流程，再用 rc flow export 看流程里是否真的引用了它。`
  );
  return { rows: nodes, note };
}

export interface DatasourceLineage {
  datasourceId?: string;
  datasourceName?: string;
  tables: string[];
  processes: { processId?: string; processName?: string }[];
  raw?: unknown;
}

export async function datasourceLineage(c: RestCloudClient): Promise<DatasourceLineage[]> {
  const r = await c.request(LINEAGE.datasource, { method: 'GET' });
  return pickRows(r.data).map((x: any) => ({
    datasourceId: x.datasourceId ?? x.id,
    datasourceName: x.datasourceName ?? x.configName,
    tables: Array.isArray(x.tables) ? x.tables.map(String) : [],
    processes: Array.isArray(x.processes) ? x.processes : [],
    raw: x,
  }));
}

export async function appRelationship(c: RestCloudClient): Promise<unknown> {
  const r = await c.request(LINEAGE.appRelationship, { method: 'GET' });
  return r.data?.data ?? r.data;
}

export async function apiCallRelation(c: RestCloudClient): Promise<unknown> {
  const r = await c.request(LINEAGE.apiCallRelation, { method: 'GET' });
  return r.data?.data ?? r.data;
}

export async function metaTableLineage(c: RestCloudClient, tableName?: string): Promise<unknown> {
  const r = await c.request(LINEAGE.metaTable, { method: 'GET', query: tableName ? { tableName } : undefined });
  return r.data?.data ?? r.data;
}

export interface DeepImpactHit {
  processId: string;
  processName?: string;
  directHits: number;
  viaSubProcess?: string;
  depth: number;
}

/**
 * API 深度影响面：
 *   1) 直接扫描 ESB/ETL 流程详情（apiId/名称/路径）
 *   2) 解析子流程引用（subProcessNode 的 subProcessId）
 *   3) 从直接命中出发，沿"被引用"关系反向扩展（调用者）
 */
export async function deepImpactOfApi(
  c: RestCloudClient,
  api: { id: string; name?: string; path?: string },
  opts: { kind?: 'esb' | 'etl'; maxProcesses?: number; includeCallers?: boolean } = {},
): Promise<{ direct: DeepImpactHit[]; indirect: DeepImpactHit[]; scanned: number }> {
  const kind = opts.kind ?? 'esb';
  const listPath = kind === 'etl' ? '/rest/etl/process/list' : '/rest/esb/process/list';
  const detailPath = (id: string) => (kind === 'etl' ? `/rest/etl/process/${id}` : `/rest/esb/process/${id}`);
  const list = await c.request(listPath, { method: 'GET' });
  const rows = unwrapRows(list.data?.data ?? list.data).slice(0, opts.maxProcesses ?? 300);
  const direct: DeepImpactHit[] = [];
  const details = new Map<string, any>();
  const needles = [api.id, api.name, api.path].filter((x): x is string => Boolean(x && String(x).length > 2));

  for (const row of rows) {
    const pid = row.processId ?? row.id;
    if (!pid) continue;
    const d = await c.request(detailPath(String(pid)), { method: 'GET' });
    const data = d.data?.data ?? d.data;
    details.set(String(pid), data);
    const raw = JSON.stringify(data ?? {});
    let hits = 0;
    for (const n of needles) hits += raw.split(n).length - 1;
    if (hits > 0) direct.push({ processId: String(pid), processName: row.processName ?? row.configName, directHits: hits, depth: 0 });
  }

  // 反向扩展：若某流程引用了直接命中的流程 id/名称，则它是调用者
  const indirect: DeepImpactHit[] = [];
  if (opts.includeCallers !== false) {
    const directIds = new Set(direct.map((x) => x.processId));
    const directNames = new Map(direct.map((x) => [x.processId, x.processName ?? '']));
    for (const [pid, data] of details) {
      if (directIds.has(pid)) continue;
      const raw = JSON.stringify(data ?? {});
      for (const id of directIds) {
        if (raw.includes(id)) {
          indirect.push({ processId: pid, directHits: 0, viaSubProcess: directNames.get(id) || id, depth: 1 });
          break;
        }
      }
    }
  }
  return { direct, indirect, scanned: details.size };
}

/** 兼容旧调用：直接走 api.ts 的轻量扫描 */
export async function impactByApiId(c: RestCloudClient, apiId: string, kind: 'esb' | 'etl' = 'esb') {
  return impactOfApi(c, apiId, { kind });
}
