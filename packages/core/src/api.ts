/**
 * API 资产域：列表 / 详情 / OpenAPI 导入导出 / 契约 diff / 影响面
 * 端点来源：catalog/endpoints.json（core 模块）
 */
import type { RestCloudClient } from './client.ts';
import type { ApiResult } from './client.ts';

export const ENDPOINTS = {
  apiList: '/rest/core/services',
  apiDetail: (id: string) => `/rest/core/services/${id}`,
  apiSave: '/rest/core/services/save',
  apiDelete: '/rest/core/services/delete',
  /** OpenAPI 分析（预览）：body 为 OpenAPI 文档原文，Content-Type: application/json */
  openapiAnalysis: (appId: string) => `/rest/core/v2/openapi/analysis?appId=${appId}`,
  /** OpenAPI 导入（落库）：body 为条目数组的 JSON 字符串 */
  openapiImport: '/rest/core/v2/openapi/import',
  exportOpenApi: '/rest/apiportal/openapi/v3/export',
  serviceExport: '/rest/core/services/export',
  apps: '/rest/core/apps',
  esbProcessList: '/rest/esb/process/list',
  esbProcessDetail: (id: string) => `/rest/esb/process/${id}`,
  etlProcessList: '/rest/etl/process/list',
  etlProcessDetail: (id: string) => `/rest/etl/process/${id}`,
} as const;

export interface ApiSummary {
  id?: string;
  serviceName?: string;
  servicePath?: string;
  method?: string;
  appId?: string;
  status?: string;
  updateTime?: string;
}

/** 平台分页响应统一形态：{state,pageNo,total,rows|data} 或裸数组 */
export function unwrapRows(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const k of ['rows', 'data', 'records', 'list', 'items']) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  return [];
}

/**
 * API（服务）列表。
 *
 * 实测：平台认的是 **pageNo / pageSize**（`page`/`size` 会被忽略，永远回第一页 20 条），
 * 而且**忽略 appId / keyword**（传什么都是同一批数据）→ 过滤只能在客户端做。
 */
export async function listApis(
  c: RestCloudClient,
  opts: { appId?: string; keyword?: string; pageNo?: number; pageSize?: number } = {},
): Promise<ApiResult> {
  return c.request(ENDPOINTS.apiList, {
    method: 'GET',
    query: {
      appId: opts.appId,
      keyword: opts.keyword,
      pageNo: opts.pageNo,
      pageSize: opts.pageSize,
    },
  });
}

/** 客户端过滤：appId 精确匹配（业务应用/平台模块都可能是它），keyword 模糊匹配。 */
export function filterApis(
  rows: any[],
  opts: { appId?: string; keyword?: string } = {},
): any[] {
  const appId = String(opts.appId ?? '').trim().toLowerCase();
  const keyword = String(opts.keyword ?? '').trim().toLowerCase();
  return rows.filter((x) => {
    if (appId) {
      const app = String(x.appId ?? x.categoryId ?? '').toLowerCase();
      if (app !== appId) return false;
    }
    if (!keyword) return true;
    const text = [x.configName, x.configId, x.mapUrl, x.methodType, x.appId, x.categoryId, x.remark]
      .filter(Boolean).join(' ').toLowerCase();
    return text.includes(keyword);
  });
}

/**
 * 拉全量（按平台分页）并客户端过滤；命中够 limit 条就提前停止翻页。
 */
export async function listAllApis(
  c: RestCloudClient,
  opts: { appId?: string; keyword?: string; pageSize?: number; limit?: number } = {},
): Promise<{ rows: any[]; matched: number; truncated: boolean; total?: number }> {
  const pageSize = Math.max(20, Math.min(500, opts.pageSize ?? 200));
  const out: any[] = [];
  const seen = new Set<string>();
  let matched = 0;
  let total: number | undefined;
  let truncated = false;
  for (let pageNo = 1; pageNo <= 200; pageNo++) {
    const r = await listApis(c, { pageNo, pageSize });
    if (!r.ok) break;
    const d: any = r.data?.data ?? r.data;
    const rows: any[] = Array.isArray(d) ? d : (d?.rows ?? d?.list ?? []);
    if (total === undefined && d?.total !== undefined) total = Number(d.total);
    if (!rows.length) break;
    for (const row of rows) {
      const key = String(row?.id ?? row?.configId ?? '');
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(row);
    }
    matched = filterApis(out, opts).length;
    if (opts.limit && matched >= opts.limit) { truncated = true; break; }
    // 平台给了 total 就按 total 收口（最后一页可能正好是满页）
    if (total !== undefined && out.length >= total) break;
    if (rows.length < pageSize) break;
  }
  return { rows: filterApis(out, opts), matched, truncated, total };
}

export async function getApi(c: RestCloudClient, id: string): Promise<ApiResult> {
  return c.request(ENDPOINTS.apiDetail(id), { method: 'GET' });
}

export async function listApps(c: RestCloudClient): Promise<ApiResult> {
  return c.request(ENDPOINTS.apps, { method: 'GET' });
}

/**
 * OpenAPI 导入（v2 两阶段契约，实测自平台前端）
 *   ① 分析：POST /rest/core/v2/openapi/analysis?appId=<appId>，body = OpenAPI 文档原文
 *      → 返回待导入条目数组（含 mapUrl / methodType / summary 等）
 *   ② 导入：POST /rest/core/v2/openapi/import，body = 条目数组的 JSON 字符串
 *      → 每项需补 categoryId / authType / authTypeStr / approveAuthType / approveAuthTypeStr
 */
export interface OpenApiItem {
  mapUrl?: string;
  methodType?: string;
  configName?: string;
  categoryId?: string;
  authType?: number;
  authTypeStr?: string;
  approveAuthType?: number;
  approveAuthTypeStr?: string;
  [k: string]: unknown;
}

export async function analyzeOpenApi(
  c: RestCloudClient,
  appId: string,
  specText: string,
): Promise<OpenApiItem[]> {
  const r = await c.request(ENDPOINTS.openapiAnalysis(appId), {
    method: 'POST',
    body: specText,
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    dryRun: false,
  });
  if (!r.ok) throw new Error(`OpenAPI 分析失败：${r.msg || r.httpStatus}（traceId=${r.traceId ?? '-'}）`);
  const data = r.data?.data ?? r.data;
  if (Array.isArray(data)) return data as OpenApiItem[];
  if (Array.isArray((data as any)?.rows)) return (data as any).rows;
  throw new Error('OpenAPI 分析返回结构异常');
}

export async function importOpenApi(
  c: RestCloudClient,
  appId: string,
  specText: string,
  opts: { categoryId?: string; authType?: number; approveAuthType?: number; dryRun?: boolean } = {},
): Promise<ApiResult> {
  if (!appId) throw new Error('缺少 appId');
  const items = await analyzeOpenApi(c, appId, specText);
  const categoryId = opts.categoryId ?? `${appId}.ServiceCategory`;
  const authType = opts.authType ?? 1;
  const approveAuthType = opts.approveAuthType ?? authType;
  const payload = items.map((it) => ({
    ...it,
    categoryId,
    authType,
    authTypeStr: String(authType),
    approveAuthType,
    approveAuthTypeStr: String(approveAuthType),
  }));
  return c.request(ENDPOINTS.openapiImport, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    // 默认 dry-run：不能因为 profile 不同，同一个调用在 uat 是预览、在 prod 却真写
    dryRun: opts.dryRun ?? true,
  });
}

/** 新增/修改 API 配置（service 对象；默认 dry-run） */
export async function saveApi(
  c: RestCloudClient,
  body: Record<string, unknown>,
  opts: { dryRun?: boolean } = {},
): Promise<ApiResult> {
  return c.request(ENDPOINTS.apiSave, { method: 'POST', body, dryRun: opts.dryRun ?? true });
}

/** 删除 API（真实契约：body 为 { ids }，可逗号分隔多个） */
export async function deleteApi(c: RestCloudClient, ids: string | string[]): Promise<ApiResult> {
  const list = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (list.length === 0) throw new Error('缺少 ids');
  return c.request(ENDPOINTS.apiDelete, {
    method: 'POST',
    body: { ids: list.join(',') },
    dryRun: false,
  });
}

export async function exportOpenApi(c: RestCloudClient, serviceId: string): Promise<ApiResult> {
  return c.request(ENDPOINTS.exportOpenApi, { method: 'GET', query: { serviceId } });
}

/** 导出整应用的服务定义（契约基线，用于 diff） */
export async function exportServiceBundle(c: RestCloudClient, appId: string): Promise<ApiResult> {
  return c.request(ENDPOINTS.serviceExport, { method: 'GET', query: { appId } });
}

export interface SpecDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** 统一"契约基线"形态：服务数组（configId/mapUrl/methodType）或 OpenAPI paths */
export interface BundleEntry {
  key: string;
  path: string;
  method: string;
  name: string;
  configId?: string;
  version?: string;
  state?: string;
}

/**
 * 统一"契约基线"形态。
 * 身份键 = METHOD + PATH（实测：configId 非唯一，同一 configId 会对应多条路由）
 */
export function normalizeBundle(payload: unknown): Map<string, BundleEntry> {
  const out = new Map<string, BundleEntry>();
  const raw = unwrapRows(payload as any);
  // OpenAPI 文档
  if (raw.length === 0 && payload && typeof payload === 'object' && (payload as any).paths) {
    for (const [p, item] of Object.entries((payload as any).paths as Record<string, any>)) {
      for (const [m, op] of Object.entries(item ?? {})) {
        const key = `${m.toUpperCase()} ${p}`;
        out.set(key, { key, path: p, method: m.toUpperCase(), name: (op as any)?.summary ?? '' });
      }
    }
    return out;
  }
  for (const rawItem of raw as any[]) {
    // 导出形态有两种：① 扁平服务对象；② { 服务名: 服务对象 } 的包装
    let s = rawItem;
    let alias = '';
    if (s && typeof s === 'object' && !s.configId && !s.serviceId && !s.id) {
      const entries = Object.entries(s).filter(([, v]) => v && typeof v === 'object');
      if (entries.length === 1) {
        alias = entries[0][0];
        s = entries[0][1];
      }
    }
    const path = s?.mapUrl ?? s?.servicePath ?? s?.path ?? s?.url ?? '';
    const method = String(s?.methodType ?? s?.method ?? '').toUpperCase();
    if (!path) continue;
    const key = `${method} ${path}`;
    if (out.has(key)) continue; // 同路由重复导出取首次
    out.set(key, {
      key,
      path,
      method,
      name: s?.configName ?? s?.serviceName ?? s?.name ?? alias,
      configId: s?.configId ?? s?.serviceId,
      version: s?.version,
      state: s?.state,
    });
  }
  return out;
}

/** 基线 diff（同时支持服务数组与 OpenAPI） */
export function diffBundles(a: unknown, b: unknown): SpecDiff {
  const ma = normalizeBundle(a);
  const mb = normalizeBundle(b);
  const added = [...mb.keys()].filter((k) => !ma.has(k));
  const removed = [...ma.keys()].filter((k) => !mb.has(k));
  const changed = [...mb.keys()].filter((k) => {
    if (!ma.has(k)) return false;
    const x = ma.get(k)!; const y = mb.get(k)!;
    return x.name !== y.name || x.version !== y.version || x.state !== y.state || x.configId !== y.configId;
  });
  return { added, removed, changed };
}

/** 破坏性变更：基线路由消失 / 方法或路径变更 */
export function breakingInBundles(a: unknown, b: unknown): string[] {
  const ma = normalizeBundle(a);
  const mb = normalizeBundle(b);
  const out: string[] = [];
  for (const [k, x] of ma) {
    const y = mb.get(k);
    if (!y) {
      const alt = [...mb.values()].find((v) => v.path === x.path && v.method !== x.method);
      if (alt) out.push(`方法变更 ${x.method} ${x.path} → ${alt.method} ${x.path}`);
      else out.push(`删除路由 ${x.method} ${x.path}（${x.name}）`);
    }
  }
  return out;
}

/** 纯函数：OpenAPI paths 级 diff（不联网，可单测） */
export function diffSpecs(baseline: unknown, current: unknown): SpecDiff {
  const a = (baseline as any)?.paths ?? {};
  const b = (current as any)?.paths ?? {};
  const added = Object.keys(b).filter((k) => !(k in a));
  const removed = Object.keys(a).filter((k) => !(k in b));
  const changed = Object.keys(b).filter((k) => k in a && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return { added, removed, changed };
}

/** 破坏性变更判定：删除路径、收紧必填、改类型 */
export function breakingChanges(baseline: unknown, current: unknown): string[] {
  const out: string[] = [];
  const a = (baseline as any)?.paths ?? {};
  const b = (current as any)?.paths ?? {};
  for (const p of Object.keys(a)) {
    if (!(p in b)) out.push(`删除路径 ${p}`);
    else {
      for (const m of Object.keys(a[p] ?? {})) {
        const before = a[p][m];
        const after = b[p]?.[m];
        if (!after) { out.push(`删除方法 ${m.toUpperCase()} ${p}`); continue; }
        const rb = before?.requestBody?.content?.['application/json']?.schema;
        const ra = after?.requestBody?.content?.['application/json']?.schema;
        if (rb && ra && JSON.stringify(rb) !== JSON.stringify(ra)) out.push(`请求体结构变更 ${m.toUpperCase()} ${p}`);
      }
    }
  }
  return out;
}

/** 影响面：扫描流程是否引用该 API（apiId 出现在 processModel 中） */
export async function impactOfApi(
  c: RestCloudClient,
  apiId: string,
  opts: { maxProcesses?: number; kind?: 'esb' | 'etl' } = {},
): Promise<{ processId: string; processName?: string; hits: number }[]> {
  const listPath = opts.kind === 'etl' ? ENDPOINTS.etlProcessList : ENDPOINTS.esbProcessList;
  const list = await c.request(listPath, { method: 'GET' });
  const rows: any[] = Array.isArray(list.data) ? list.data : (list.data?.data ?? list.data?.rows ?? []);
  const slice = rows.slice(0, opts.maxProcesses ?? 200);
  const hits: { processId: string; processName?: string; hits: number }[] = [];
  for (const row of slice) {
    const pid = row.processId ?? row.id;
    if (!pid) continue;
    const detailPath = opts.kind === 'etl' ? ENDPOINTS.etlProcessDetail(pid) : ENDPOINTS.esbProcessDetail(pid);
    const d = await c.request(detailPath, { method: 'GET' });
    const raw = JSON.stringify(d.data ?? {});
    const count = raw.split(apiId).length - 1;
    if (count > 0) hits.push({ processId: pid, processName: row.processName ?? row.name, hits: count });
  }
  return hits;
}
