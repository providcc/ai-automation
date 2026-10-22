/**
 * WP9.5 运营分析（operation 模块，原方案遗漏的 284 个文件对应域）
 */
import type { RestCloudClient, ApiResult } from './client.ts';

export const OPS = {
  assessList: '/rest/operation/assess/api/list/page',
  assessReport: '/rest/operation/assess/api/report',
  appReport: '/rest/operation/assess/api/list/app/report',
  assessSave: '/rest/operation/assess/api/save',
  assessConfigList: '/rest/operation/assess/api/config/list/page',
} as const;

export async function assessList(c: RestCloudClient, page = 1, size = 50): Promise<ApiResult> {
  return c.request(OPS.assessList, { method: 'GET', query: { page, size } });
}

export async function assessReport(c: RestCloudClient, query: Record<string, string | number> = {}): Promise<ApiResult> {
  return c.request(OPS.assessReport, { method: 'GET', query });
}

export async function appReport(c: RestCloudClient, appId?: string): Promise<ApiResult> {
  return c.request(OPS.appReport, { method: 'GET', query: { appId } });
}

/** 运营摘要：评估列表 + 应用报告，聚合为可读指标 */
export async function opsSummary(c: RestCloudClient): Promise<{
  assessedApis: number;
  top: unknown[];
  appReport: unknown;
  notes: string[];
}> {
  const notes: string[] = [];
  let rows: any[] = [];
  let appData: unknown;
  try {
    const list = await assessList(c, 1, 50);
    if (!list.ok) notes.push(`评估列表失败：${list.msg || list.httpStatus}`);
    rows = Array.isArray(list.data) ? list.data : (list.data?.data ?? list.data?.rows ?? []);
  } catch (e) {
    notes.push(`评估列表失败：${(e as Error).message}`);
  }
  try {
    const apps = await appReport(c);
    if (!apps.ok) notes.push(`应用报告失败：${apps.msg || apps.httpStatus}`);
    appData = apps.data?.data ?? apps.data;
  } catch (e) {
    notes.push(`应用报告失败：${(e as Error).message}`);
  }
  return { assessedApis: rows.length, top: rows.slice(0, 10), appReport: appData, notes };
}
