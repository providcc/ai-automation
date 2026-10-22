/**
 * 数据源领域（v2 plan Phase 1）
 * 契约来源：WAR 萃取 @RestConfig（/rest/core/datasource/*）
 *
 * 实测确认（2026-10-20，ipaas-test）：
 *   GET  /rest/core/datasource/list?pageNo&pageSize   分页（payload.rows）
 *   GET  /rest/core/datasource/listall                全量
 *   GET  /rest/core/datasource/{id}                   详情（**含 password → 输出必须脱敏**）
 *   POST /rest/core/datasource/save                   保存/更新
 *   GET  /rest/core/datasource/test/connect?id=       连接测试
 *   GET  /rest/core/datasource/category/menu          分类树
 */
import type { RestCloudClient, ApiResult } from './client.ts';

export const DATASOURCE = {
  list: '/rest/core/datasource/list',
  listAll: '/rest/core/datasource/listall',
  detail: (id: string) => `/rest/core/datasource/${id}`,
  save: '/rest/core/datasource/save',
  delete: '/rest/core/datasource/delete',
  testConnect: '/rest/core/datasource/test/connect',
  categoryMenu: '/rest/core/datasource/category/menu',
} as const;

/** 列表行（脱敏后） */
export interface DataSourceRow {
  id: string;
  configId?: string;
  configName?: string;
  configType?: string; // RDB / rocketmq / ...
  categoryId?: string;
  appId?: string;
  state?: string;
  jdbcUrl?: string;
  driverClass?: string;
}

const rowsOf = (d: any): any[] => {
  if (Array.isArray(d)) return d;
  // 平台偶尔返回非数组的 rows/data，这里兜底成空数组，避免 .map 直接崩
  if (Array.isArray(d?.rows)) return d.rows;
  if (Array.isArray(d?.data?.rows)) return d.data.rows;
  if (Array.isArray(d?.data)) return d.data;
  return [];
};

/** 脱敏：密码/敏感连接串不回显 */
export function maskDataSource(d: any): any {
  if (!d || typeof d !== 'object') return d;
  const out: any = { ...d };
  for (const k of ['password', 'pwd', 'secret', 'token', 'accessKey', 'secretKey']) {
    if (out[k] !== undefined) out[k] = '***';
  }
  if (typeof out.jdbcUrl === 'string' && /password=/i.test(out.jdbcUrl)) {
    out.jdbcUrl = out.jdbcUrl.replace(/password=[^;&]*/gi, 'password=***');
  }
  return out;
}

export async function listDataSources(
  c: RestCloudClient,
  opts: { pageNo?: number; pageSize?: number; keyword?: string; configType?: string } = {},
): Promise<ApiResult> {
  return c.request(DATASOURCE.list, {
    method: 'GET',
    query: { pageNo: opts.pageNo ?? 1, pageSize: opts.pageSize ?? 50, keyword: opts.keyword, configType: opts.configType },
  });
}

export async function listAllDataSources(c: RestCloudClient): Promise<DataSourceRow[]> {
  const r = await c.request(DATASOURCE.listAll, { method: 'GET' });
  return rowsOf(r.data?.data ?? r.data).map((x: any) => ({
    id: x.id,
    configId: x.configId,
    configName: x.configName,
    configType: x.configType,
    categoryId: x.categoryId,
    appId: x.appId,
    state: x.state,
    jdbcUrl: x.jdbcUrl,
    driverClass: x.driverClass,
  }));
}

/** 详情（脱敏） */
export async function getDataSource(c: RestCloudClient, id: string): Promise<{ ok: boolean; msg?: string; data?: any }> {
  const r = await c.request(DATASOURCE.detail(id), { method: 'GET' });
  return { ok: r.ok, msg: r.msg, data: r.ok ? maskDataSource(r.data?.data ?? r.data) : undefined };
}

/** 连接测试（读操作，无需 dry-run） */
export async function testDataSourceConnection(
  c: RestCloudClient,
  id: string,
): Promise<{ ok: boolean; msg?: string; latencyMs?: number }> {
  const started = Date.now();
  const r = await c.request(DATASOURCE.testConnect, { method: 'GET', query: { id }, dryRun: false });
  return { ok: r.ok, msg: r.msg, latencyMs: Date.now() - started };
}

/** 保存（写操作：默认 dry-run，需显式确认） */
export async function saveDataSource(
  c: RestCloudClient,
  body: Record<string, unknown>,
  opts: { dryRun?: boolean } = {},
): Promise<ApiResult> {
  return c.request(DATASOURCE.save, { method: 'POST', body, dryRun: opts.dryRun ?? true });
}
