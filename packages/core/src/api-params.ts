/**
 * API（服务）的入参/出参管理。
 *
 * 实测坑：
 *   - `GET /rest/core/services/inparams/list` 有时回空 → 权威来源是
 *     `GET /rest/core/services/{id}` 的 `paramsDocs` / `outputParamsDocs`；
 *   - `POST /rest/core/services/inparams/save` 的 body 是 `{ id, paramsData: <JSON 字符串> }`
 *     （paramsData 传对象/数组会报 MalformedJ array）；
 *   - `inparams/parser` 的入参字段名未在契约里给出（实测各种字段名都回 "JSON格式错误"），
 *     所以 `from-json` 默认**本地推导**字段，再走 save。
 */
import type { RestCloudClient, ApiResult } from './client.ts';

export interface ApiParamDoc {
  fieldName: string;
  fieldId: string;
  fieldType: string;
  required?: boolean;
  sampleValue?: string;
  [k: string]: unknown;
}

export interface ApiParamsResult {
  ok: boolean;
  msg?: string;
  /** 入参（in）或出参（out） */
  params: ApiParamDoc[];
  /** 读回来源：services/{id} 的 paramsDocs（权威）还是 inparams/list */
  source?: string;
}

/** 服务的参数文档（读 services/{id}，避开 inparams/list 的空回读）。 */
export async function getApiParams(
  c: RestCloudClient,
  serviceId: string,
  kind: 'in' | 'out' = 'in',
): Promise<ApiParamsResult> {
  const g = await c.request(`/rest/core/services/${serviceId}`, { method: 'GET' });
  if (!g.ok) return { ok: false, msg: g.msg ?? String(g.httpStatus), params: [] };
  const d: any = g.data?.data ?? g.data;
  const key = kind === 'out' ? 'outputParamsDocs' : 'paramsDocs';
  const docs = Array.isArray(d?.[key]) ? d[key] : [];
  if (docs.length) {
    return { ok: true, params: docs, source: `services/${serviceId}.${key}` };
  }
  // 回退：inparams/list（有时是空的，但先试）
  const list = await c.request(`/rest/core/services/${kind === 'out' ? 'outparams' : 'inparams'}/list`, {
    method: 'GET', query: { id: serviceId },
  });
  const payload: any = list.data?.data ?? list.data;
  const arr = Array.isArray(payload) ? payload : (payload?.rows ?? payload?.list ?? []);
  return { ok: list.ok, msg: list.msg, params: arr, source: `${kind}params/list` };
}

/** 保存参数文档（paramsData 必须是 JSON 字符串）。 */
export async function saveApiParams(
  c: RestCloudClient,
  serviceId: string,
  params: ApiParamDoc[],
  kind: 'in' | 'out' = 'in',
): Promise<ApiResult> {
  return c.request(`/rest/core/services/${kind === 'out' ? 'outparams' : 'inparams'}/save`, {
    method: 'POST',
    body: { id: serviceId, paramsData: JSON.stringify(params) },
    dryRun: false,
  });
}

/** 从 JSON 样本推导字段类型。 */
export function inferType(v: unknown): string {
  if (v === null || v === undefined) return 'String';
  if (typeof v === 'number') return Number.isInteger(v) ? 'Integer' : 'Double';
  if (typeof v === 'boolean') return 'Boolean';
  if (Array.isArray(v)) return 'Array';
  if (typeof v === 'object') return 'Object';
  return 'String';
}

/**
 * 从 JSON 样本推导参数文档（本地推导，不依赖平台 parser）。
 * 样本是对象 → 取顶层键；是数组 → 取首个对象的键。
 */
export function deriveParamsFromJson(sample: unknown): ApiParamDoc[] {
  const obj = Array.isArray(sample) ? sample[0] : sample;
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj as Record<string, unknown>).map(([k, v]) => ({
    id: null,
    fieldName: k,
    fieldId: k,
    fieldType: inferType(v),
    hidden: false,
    breakFlag: false,
    required: false,
    sampleValue: v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)),
    enCode: 0,
    order: 0,
  }));
}
