/**
 * 监控域：指标聚合、服务日志
 */
import type { RestCloudClient, ApiResult } from './client.ts';

export const MONITOR = {
  apis: '/rest/core/apimonitor/apis',
  callsPerMinute: '/rest/core/monitor/apicalls/minute',
  logs: (serviceId: string) => `/rest/core/monitor/logs/${serviceId}`,
  logToday: '/rest/core/monitor/log/today',
  errorReport: '/rest/core/monitor/errorcode/report',
} as const;

export interface MonitorSummary {
  hours: number;
  apiCount?: number;
  /** 每分钟调用量序列（近 N 分钟） */
  callSeries?: number[];
  /** 响应码分布 [{item,count}] */
  errorCodes?: unknown;
  fetchedAt: string;
  notes: string[];
}

/** 聚合监控（容错：单个子查询失败不整体失败） */
export async function summary(c: RestCloudClient, hours = 24): Promise<MonitorSummary> {
  const notes: string[] = [];
  const safe = async (p: string, query?: Record<string, unknown>): Promise<any> => {
    try {
      const r = await c.request(p, { method: 'GET', query: query as any });
      if (!r.ok) notes.push(`${p} 失败：${r.msg || r.httpStatus}`);
      return r.data?.data ?? r.data ?? null;
    } catch (e) {
      // 网络异常/超时也不能让整个聚合挂掉
      notes.push(`${p} 失败：${(e as Error).message}`);
      return null;
    }
  };
  const [apis, calls, errs] = await Promise.all([
    safe(MONITOR.apis),
    safe(MONITOR.callsPerMinute),
    safe(MONITOR.errorReport),
  ]);
  return {
    hours,
    apiCount: Array.isArray(apis) ? apis.length : apis?.total,
    callSeries: Array.isArray(calls) ? calls : undefined,
    errorCodes: errs,
    fetchedAt: new Date().toISOString(),
    notes,
  };
}

export async function serviceLogs(c: RestCloudClient, serviceId: string): Promise<ApiResult> {
  return c.request(MONITOR.logs(serviceId), { method: 'GET' });
}
