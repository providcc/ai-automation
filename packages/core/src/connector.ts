/**
 * 连接器领域（v2 Phase 1.2）
 *
 * 契约来源：WAR @RestConfig /rest/connector/*
 * 实测：测试环境 /rest/connector/list 返回 4 个连接器应用；config/list 需要 configType。
 */
import type { RestCloudClient, ApiResult } from './client.ts';
import { unwrapRows } from './api.ts';

export const CONNECTOR = {
  apps: '/rest/connector/list',
  menus: '/rest/connector/menus',
  configs: '/rest/connector/config/list',
  configGet: '/rest/connector/config/getById',
  configSave: '/rest/connector/config/save',
  configDelete: '/rest/connector/config/delete',
  oauthSave: '/rest/connector/config/save/oauth',
  oauthTemporarySave: '/rest/connector/config/temporarily/save',
  docList: '/rest/connector/doc/list',
  docPage: '/rest/connector/doc/list/page',
  docGet: '/rest/connector/doc/get',
  docSave: '/rest/connector/doc/save',
  docDelete: '/rest/connector/doc/delete',
  docExport: '/rest/connector/doc/export',
  authItem: '/rest/connector/config/item/get',
  videoList: '/rest/connector/app/video/list',
  videoPage: '/rest/connector/app/video/list/page',
  videoGet: '/rest/connector/app/video/get',
  videoSave: '/rest/connector/app/video/save',
  videoDelete: '/rest/connector/app/video/delete',
} as const;

// 只在"整段等于敏感词"时脱敏，避免 passenger/compass 之类被误伤
const SENSITIVE = /^(pass(word)?|pwd|secret|token|privatekey|accesskey|clientsecret|apikey|credential)$/i;

/** 连接器配置脱敏（详情可能含 OAuth secret / 私钥） */
export function maskConnector(input: any): any {
  if (Array.isArray(input)) return input.map(maskConnector);
  if (input && typeof input === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = SENSITIVE.test(k) ? '***' : maskConnector(v);
    }
    return out;
  }
  return input;
}

export interface ConnectorApp {
  id?: string;
  configType?: string;
  configName?: string;
  appName?: string;
  name?: string;
  version?: string;
  [k: string]: unknown;
}

export async function listConnectorApps(c: RestCloudClient): Promise<ConnectorApp[]> {
  const r = await c.request(CONNECTOR.apps, { method: 'GET' });
  return unwrapRows(r.data?.data ?? r.data) as ConnectorApp[];
}

export async function connectorMenus(c: RestCloudClient): Promise<unknown> {
  const r = await c.request(CONNECTOR.menus, { method: 'GET' });
  return r.data?.data ?? r.data;
}

/**
 * 列出某连接器类型下的配置。
 * configType 来自 `rc connector apps`（例如 wechat / dingtalk / sap）。
 */
export async function listConnectorConfigs(
  c: RestCloudClient,
  configType: string,
  opts: { pageNo?: number; pageSize?: number; keyword?: string } = {},
): Promise<ApiResult> {
  return c.request(CONNECTOR.configs, {
    method: 'GET',
    query: { configType, pageNo: opts.pageNo, pageSize: opts.pageSize, keyword: opts.keyword },
  });
}

export async function getConnectorConfig(c: RestCloudClient, id: string): Promise<{ ok: boolean; msg?: string; data?: any }> {
  const r = await c.request(CONNECTOR.configGet, { method: 'GET', query: { id } });
  return { ok: r.ok, msg: r.msg, data: r.ok ? maskConnector(r.data?.data ?? r.data) : undefined };
}

/** 保存连接器配置（写；默认 dry-run） */
export async function saveConnectorConfig(
  c: RestCloudClient,
  body: Record<string, unknown>,
  opts: { dryRun?: boolean } = {},
): Promise<ApiResult> {
  return c.request(CONNECTOR.configSave, { method: 'POST', body, dryRun: opts.dryRun ?? true });
}

export async function deleteConnectorConfig(
  c: RestCloudClient,
  ids: string | string[],
  opts: { dryRun?: boolean } = {},
): Promise<ApiResult> {
  const list = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (list.length === 0) throw new Error('缺少 ids');
  return c.request(CONNECTOR.configDelete, { method: 'POST', body: { ids: list.join(',') }, dryRun: opts.dryRun ?? true });
}

export async function listConnectorDocs(
  c: RestCloudClient,
  configType: string,
  opts: { pageNo?: number; pageSize?: number } = {},
): Promise<ApiResult> {
  return c.request(CONNECTOR.docList, { method: 'GET', query: { configType, pageNo: opts.pageNo, pageSize: opts.pageSize } });
}

export async function getConnectorDoc(c: RestCloudClient, id: string): Promise<ApiResult> {
  return c.request(CONNECTOR.docGet, { method: 'GET', query: { id } });
}

export async function saveConnectorDoc(
  c: RestCloudClient,
  body: Record<string, unknown>,
  opts: { dryRun?: boolean } = {},
): Promise<ApiResult> {
  return c.request(CONNECTOR.docSave, { method: 'POST', body, dryRun: opts.dryRun ?? true });
}

export async function deleteConnectorDoc(
  c: RestCloudClient,
  ids: string | string[],
  opts: { dryRun?: boolean } = {},
): Promise<ApiResult> {
  const list = Array.isArray(ids) ? ids : [ids];
  return c.request(CONNECTOR.docDelete, { method: 'POST', body: { ids: list.join(',') }, dryRun: opts.dryRun ?? true });
}

/**
 * 导出连接器配置（脱敏，便于迁移）。
 * 平台没有批量导出端点：按 configType 拉取配置列表 + 详情。
 */
export async function exportConnectorConfigs(
  c: RestCloudClient,
  configType: string,
  opts: { pageSize?: number } = {},
): Promise<{ configType: string; exportedAt: string; items: any[] }> {
  const list = await listConnectorConfigs(c, configType, { pageNo: 1, pageSize: opts.pageSize ?? 200 });
  const rows = unwrapRows(list.data?.data ?? list.data);
  const items: any[] = [];
  for (const row of rows) {
    const id = row?.id ?? row?.configId;
    if (id) {
      const d = await getConnectorConfig(c, String(id));
      items.push(d.data ?? { id });
    } else {
      items.push(row);
    }
  }
  return { configType, exportedAt: new Date().toISOString(), items: maskConnector(items) };
}

/**
 * 导入连接器配置（顺序执行；默认 dry-run）。
 * 返回每个条目的执行结果，便于上层批处理/续跑。
 */
export async function importConnectorConfigs(
  c: RestCloudClient,
  payload: { configType: string; items: Record<string, unknown>[] },
  opts: { dryRun?: boolean } = {},
): Promise<{ ok: boolean; total: number; results: { index: number; ok: boolean; msg?: string }[] }> {
  const results: { index: number; ok: boolean; msg?: string }[] = [];
  for (let i = 0; i < payload.items.length; i++) {
    const body = { ...payload.items[i], configType: payload.items[i].configType ?? payload.configType };
    const r = await saveConnectorConfig(c, body, { dryRun: opts.dryRun ?? true });
    results.push({ index: i, ok: r.ok, msg: r.msg });
  }
  return { ok: results.every((x) => x.ok), total: payload.items.length, results };
}
