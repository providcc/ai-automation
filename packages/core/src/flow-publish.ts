/**
 * 把流程「发布成接口」：草稿态 → 上线态。
 *
 * 平台没有"一键发布"端点，必须两步（实测）：
 *   ① POST /rest/core/services/save   body { ..., state: '0' }  → 服务建好（草稿态）
 *   ② POST /rest/core/services/save   body { ..., state: '1' }  → 上线态
 * 只做第①步的话，接口存在但调用恒 500（路由没生效）。
 */
import type { RestCloudClient, ApiResult } from './client.ts';

export interface PublishAsApiOptions {
  /** 业务应用 id（流程的 applicationId，默认取流程自己的） */
  appId?: string;
  /** 对外路径（网关路由，如 /erp/api/xxx/invoke） */
  url: string;
  /** 接口名称 */
  name: string;
  /** 方法 */
  method?: string;
  /** 认证方式：1=无需认证（与平台默认一致） */
  authType?: number;
}

export interface PublishAsApiResult {
  ok: boolean;
  serviceId?: string;
  mapUrl?: string;
  state?: string;
  msg?: string;
  steps: { draft: ApiResult; online?: ApiResult; verify?: ApiResult };
}

export async function publishFlowAsApi(
  c: RestCloudClient,
  processId: string,
  opts: PublishAsApiOptions,
): Promise<PublishAsApiResult> {
  const method = (opts.method ?? 'POST').toUpperCase();
  const detail = await c.request(`/rest/esb/process/${processId}`, { method: 'GET' });
  if (!detail.ok) {
    return { ok: false, msg: `读取流程失败：${detail.msg ?? detail.httpStatus}`, steps: { draft: detail } };
  }
  const d: any = detail.data?.data ?? detail.data;
  const body: Record<string, unknown> = {
    configName: opts.name,
    mapUrl: opts.url,
    methodType: method,
    applicationId: opts.appId ?? d?.applicationId,
    appId: d?.appId ?? 'esb',
    categoryId: d?.categoryId ?? 'all',
    processId,
    configType: 'REG',
    registerFlag: 1,
    authType: opts.authType ?? 1,
    approveAuthType: opts.authType ?? 1,
    requestBodyAuto: '0',
    requestBodyFlag: true,
    logType: 2,
    state: '0',
  };
  // ① 草稿态
  const draft = await c.request('/rest/core/services/save', { method: 'POST', body, dryRun: false });
  if (!draft.ok) {
    return { ok: false, msg: `创建接口草稿失败：${draft.msg ?? draft.httpStatus}`, steps: { draft } };
  }
  const dd: any = draft.data?.data ?? draft.data;
  const serviceId = String(dd?.id ?? '');
  // ② 上线态
  let online: ApiResult | undefined;
  let verify: ApiResult | undefined;
  if (serviceId) {
    online = await c.request('/rest/core/services/save', {
      method: 'POST', body: { ...body, id: serviceId, state: '1' }, dryRun: false,
    });
    verify = await c.request(`/rest/core/services/${serviceId}`, { method: 'GET' });
  }
  const vd: any = verify?.data?.data ?? verify?.data;
  const state = vd?.state === undefined ? undefined : String(vd.state);
  const ok = Boolean(online?.ok) && state === '1';
  return {
    ok,
    serviceId: serviceId || undefined,
    mapUrl: opts.url,
    state,
    msg: ok
      ? `已发布并上线：${opts.name}（${method} ${opts.url}，serviceId=${serviceId}）`
      : `创建了草稿但上线未确认${online && !online.ok ? `：${online.msg ?? online.httpStatus}` : ''}`,
    steps: { draft, online, verify },
  };
}
