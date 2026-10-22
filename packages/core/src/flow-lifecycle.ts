/**
 * 流程生命周期 + 节点属性落库闭环
 *
 * 契约来源（前端 + 实测）：
 *   GET  /rest/{esb|etl}/process/node/props?processId=&nodeId=   单节点属性（含 id → upsert 依据）
 *   GET  /rest/esb/process/node/props/list?processId=&nodeIds=  批量属性（ETL 无此端点，逐节点降级）
 *   GET  /rest/{esb|etl}/process/node/select?processId=[&nodeType=]  流程内节点（ESB 可用 router）
 *   POST /rest/{esb|etl}/process/node/save                      节点属性 upsert（带 id=更新，不带=插入）
 *   POST /rest/esb/process/node/batch/save                      节点属性批量保存（body 为属性数组）
 *   POST /rest/{esb|etl}/process/node/delete                    删除节点属性
 *   POST /rest/{esb|etl}/process/model/save                     保存图模型
 *   POST /rest/{esb|etl}/process/model/checkerror               平台侧校验（图 + 属性）
 *   GET  /rest/{esb|etl}/process/version/list                   历史版本
 *   POST /rest/{esb|etl}/process/version/restore                body: {id}
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { RestCloudClient, ApiResult } from './client.ts';
import { RcError } from './errors.ts';
import { snapshotHome } from './snapshot.ts';
import { Catalog } from './catalog.ts';
import { hasPropValue } from './flow-validate.ts';
import { listAllApis } from './api.ts';
import { diffFlow, flowFingerprint, type FlowDiff } from './flow-diff.ts';

export type FlowKind = 'esb' | 'etl';

export interface FlowEndpoints {
  /** 端点前缀（如 /rest/esb/process） */
  base: string;
  list: string;
  save: string;
  detail: (id: string) => string;
  copy: string;
  delete: string;
  publish?: string;
  modelSave: string;
  modelCheck: string;
  nodeSave: string;
  /** ESB 独有：body 直接是属性数组 */
  nodeBatchSave?: string;
  nodeProps: string;
  /** ESB 独有：一次读取多个节点的属性 */
  nodePropsList?: string;
  nodeDelete: string;
  nodeSelect: string;
  versionList?: string;
  versionRestore?: string;
}

/** 端点族：ESB 与 ETL 同构（WAR 取证：两侧端点路径规律一致），按 kind 选择 */
export const FLOW_ESB: FlowEndpoints = {
  base: '/rest/esb/process',
  list: '/rest/esb/process/list',
  save: '/rest/esb/process/save',
  detail: (id: string) => `/rest/esb/process/${id}`,
  copy: '/rest/esb/process/copy',
  delete: '/rest/esb/process/delete',
  publish: '/rest/esb/process/publish',
  modelSave: '/rest/esb/process/model/save',
  modelCheck: '/rest/esb/process/model/checkerror',
  nodeSave: '/rest/esb/process/node/save',
  nodeBatchSave: '/rest/esb/process/node/batch/save',
  nodeProps: '/rest/esb/process/node/props',
  nodePropsList: '/rest/esb/process/node/props/list',
  nodeDelete: '/rest/esb/process/node/delete',
  nodeSelect: '/rest/esb/process/node/select',
  versionList: '/rest/esb/process/version/list',
  versionRestore: '/rest/esb/process/version/restore',
};

export const FLOW_ETL: FlowEndpoints = {
  base: '/rest/etl/process',
  list: '/rest/etl/process/list',
  save: '/rest/etl/process/save',
  detail: (id: string) => `/rest/etl/process/${id}`,
  copy: '/rest/etl/process/copy',
  delete: '/rest/etl/process/delete',
  publish: '/rest/etl/process/publish',
  modelSave: '/rest/etl/process/model/save',
  modelCheck: '/rest/etl/process/model/checkerror',
  nodeSave: '/rest/etl/process/node/save',
  nodeProps: '/rest/etl/process/node/props',
  nodeDelete: '/rest/etl/process/node/delete',
  nodeSelect: '/rest/etl/process/node/select',
  versionList: '/rest/etl/process/version/list',
  versionRestore: '/rest/etl/process/version/restore',
};

/** 兼容旧引用（默认 ESB） */
export const FLOW = FLOW_ESB;

/** 按 kind 取端点族 */
export function flowEndpoints(kind: FlowKind = 'esb'): FlowEndpoints {
  return kind === 'etl' ? FLOW_ETL : FLOW_ESB;
}

/** 平台模块 appId（不是业务应用 applicationId） */
export function flowAppId(kind: FlowKind = 'esb'): string {
  return kind === 'etl' ? 'etl' : 'esb';
}

const dataOf = (r: ApiResult) => (r.data?.data ?? r.data) as any;

/** 统一的列表解包：裸数组 / rows / data.rows / data */
export function unwrapFlowRows(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.data?.rows)) return payload.data.rows;
  if (Array.isArray(payload.records)) return payload.records;
  return [];
}

function unwrapTotal(payload: any): number | undefined {
  for (const v of [payload?.total, payload?.data?.total, payload?.totalCount, payload?.data?.totalCount]) {
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// ---------------- 生命周期 ----------------

export interface ListFlowsOptions {
  keyword?: string;
  /** 业务应用（applicationId，形如 `<appId>`） */
  appId?: string;
  /** 平台模块（appId：esb / etl） */
  module?: string;
  kind?: FlowKind;
  pageNo?: number;
  pageSize?: number;
  /** 拉取全部分页后在调用方做客户端过滤 */
  all?: boolean;
  /** 客户端过滤条件：命中 limit 条即可提前结束翻页（大平台省请求） */
  filter?: { keyword?: string; appId?: string; module?: string };
  /** 需要命中的条数（配合 filter 提前停止） */
  limit?: number;
}

export async function listFlows(c: RestCloudClient, opts: ListFlowsOptions = {}): Promise<ApiResult> {
  const E = flowEndpoints(opts.kind);
  const size = opts.pageSize ?? (opts.all ? 100 : undefined);
  const firstPage = opts.pageNo ?? 1;
  if (!opts.all) {
    return c.request(E.list, {
      method: 'GET',
      query: { keyword: opts.keyword, appId: opts.appId, pageNo: firstPage, pageSize: size },
    });
  }

  const all: any[] = [];
  const seen = new Set<string>();
  let last: ApiResult | undefined;
  let pageNo = firstPage;
  let truncated = false;
  // 平台默认每页 20 条，也可能忽略较大的 pageSize；显式翻页并去重。
  // 最多 100 页，避免异常响应导致死循环。
  for (let guard = 0; guard < 100; guard++) {
    last = await c.request(E.list, {
      method: 'GET',
      query: { keyword: opts.keyword, appId: opts.appId, pageNo, pageSize: size },
    });
    if (!last.ok) return last;
    const payload = dataOf(last);
    const batch = unwrapFlowRows(payload);
    for (const row of batch) {
      const key = String(row?.processId ?? row?.id ?? row?.configId ?? '');
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      all.push(row);
    }
    const total = unwrapTotal(payload);
    if (batch.length === 0) break;
    // 是否最后一页：有 total 看累计条数，没有 total 看本页是否不足 pageSize。
    const isLastPage = total !== undefined ? all.length >= total : batch.length < (size ?? 20);
    // 客户端过滤：命中够 limit 条就停，不再翻后面的页（平台 keyword 不可用时的省请求手段）。
    if (!isLastPage && opts.filter && opts.limit && filterFlows(all, opts.filter).length >= opts.limit) {
      truncated = true;
      break;
    }
    if (isLastPage) break;
    pageNo++;
  }
  const matched = opts.filter ? filterFlows(all, opts.filter).length : all.length;
  return {
    ...(last ?? { ok: true, httpStatus: 200, request: { method: 'GET', url: E.list } }),
    data: { state: true, rows: all, total: all.length, matched, truncated },
  } as ApiResult;
}

/** 客户端过滤：平台 keyword 对编码/名称匹配不稳定，列表展示统一再过滤一次 */
/**
 * 流程行过滤。
 *
 * 两个"应用"字段含义不同，不能混用：
 *   - `applicationId`：**业务应用**（形如 `<appId>`）——流程归属的业务系统；
 *   - `appId`：**平台模块**（恒为 esb / etl）——流程跑在哪个平台模块上。
 * `appId` 参数只按业务应用匹配，`module` 参数按平台模块匹配。
 */
export function filterFlows(
  rows: any[],
  opts: { keyword?: string; appId?: string; module?: string } = {},
): any[] {
  const keyword = String(opts.keyword ?? '').trim().toLowerCase();
  const appId = String(opts.appId ?? '').trim().toLowerCase();
  const module = String(opts.module ?? '').trim().toLowerCase();
  return rows.filter((x) => {
    if (appId) {
      // 业务应用：只看 applicationId（不再回落到 appId，避免把"模块"当"业务应用"）
      const app = String(x.applicationId ?? '').toLowerCase();
      if (app !== appId) return false;
    }
    if (module) {
      const m = String(x.appId ?? '').toLowerCase();
      if (m !== module) return false;
    }
    if (!keyword) return true;
    const text = [
      x.processId, x.configId, x.configName, x.processName,
      x.applicationId, x.applicationName, x.categoryId, x.appId,
    ].filter(Boolean).join(' ').toLowerCase();
    return text.includes(keyword);
  });
}

/** 流程行的稳定字段集（CLI 共用，字段名固定，不随平台返回变化）。 */
export interface FlowRow {
  processId: string;
  configId: string;
  /** 流程名称（平台字段是 configName，这里同时给出 processName 别名） */
  configName: string;
  processName: string;
  /** 业务应用（形如 `<appId>`） */
  applicationId: string;
  /** 平台模块（esb / etl） */
  appId: string;
  state?: string;
  categoryId?: string;
  createTime?: string;
  editTime?: string;
}

/** 把平台返回的流程行归一成稳定字段（CLI 输出一致）。 */
export function normalizeFlowRow(x: any): FlowRow {
  const configName = String(x?.configName ?? x?.processName ?? '');
  return {
    processId: String(x?.processId ?? x?.id ?? ''),
    configId: String(x?.configId ?? ''),
    configName,
    processName: configName,
    applicationId: String(x?.applicationId ?? ''),
    appId: String(x?.appId ?? ''),
    state: x?.state === undefined ? undefined : String(x.state),
    categoryId: x?.categoryId === undefined ? undefined : String(x.categoryId),
    createTime: x?.createTime === undefined ? undefined : String(x.createTime),
    editTime: x?.editTime === undefined ? undefined : String(x.editTime),
  };
}

/**
 * 业务应用清单：平台没有"业务应用"接口（/rest/core/apps 列的是平台模块），
 * 业务应用要从流程的 applicationId 聚合出来——这正是排查时最需要的那张表。
 */
export async function listBusinessApps(
  c: RestCloudClient,
  opts: { kind?: FlowKind; pageSize?: number } = {},
): Promise<{ apps: { applicationId: string; flows: number; modules: string[] }[]; modules: { appId: string; appName: string }[] }> {
  const kind = opts.kind ?? 'esb';
  const res = await listFlows(c, { kind, all: true, pageSize: opts.pageSize ?? 100 });
  const rows = unwrapFlowRows(dataOf(res));
  const byApp = new Map<string, { flows: number; modules: Set<string> }>();
  for (const r of rows) {
    const app = String(r?.applicationId ?? '').trim();
    if (!app) continue;
    const cur = byApp.get(app) ?? { flows: 0, modules: new Set<string>() };
    cur.flows++;
    if (r?.appId) cur.modules.add(String(r.appId));
    byApp.set(app, cur);
  }
  const apps = [...byApp.entries()]
    .map(([applicationId, v]) => ({ applicationId, flows: v.flows, modules: [...v.modules].sort() }))
    .sort((a, b) => b.flows - a.flows || a.applicationId.localeCompare(b.applicationId));
  return { apps, modules: [] };
}

/**
 * 新建流程。
 * 实测结论：
 *   ① 必须带**唯一 configId**（如 ESB_FLOW_261020001），否则报"流程编码已存在"；
 *   ② 响应体**不含 processId**，需按 configId/configName 回查；
 *   ③ appId 是平台模块（ESB 恒为 esb，ETL 为 etl），applicationId 才是业务应用。
 */
export async function createFlow(
  c: RestCloudClient,
  input: {
    applicationId: string;
    processName: string;
    /** 流程编码；缺省自动生成（ESB_FLOW_/ETL_FLOW_<yyMMdd><seq>） */
    configId?: string;
    appId?: string;
    categoryId?: string;
    kind?: FlowKind;
  },
  opts: { dryRun?: boolean; kind?: FlowKind } = {},
): Promise<{ ok: boolean; processId?: string; configId: string; msg?: string; raw?: unknown }> {
  const kind = opts.kind ?? input.kind ?? 'esb';
  const E = flowEndpoints(kind);
  let configId = input.configId ?? defaultConfigId(new Date(), kind);
  const body: Record<string, unknown> = {
    applicationId: input.applicationId,
    appId: input.appId ?? flowAppId(kind),
    categoryId: input.categoryId ?? 'all',
    configId,
    configName: input.processName,
    processName: input.processName,
    state: '2',
    version: '1.0',
    transaction: kind === 'etl' ? false : 'true',
    processTransaction: '1',
    debug: '1',
    pNodeType: 'process',
    pNodeId: 'Process',
    maxRunProcess: '0',
    maxRunProcessOption: '0',
    maxLogDay: '30',
    compensateRule: '5,15,30,60,120',
    executeServer: 'SingleServer',
    eventType: '0',
    eventUrl: c.baseUrl,
    taskLevel: '1',
    repeatGenerationTask: '1',
    dependentMinuteTime: '60',
    logBeanId: '',
    loadBalanceId: '',
    lockedUserId: '',
    testParams: '',
    parentProcessId: '',
    ...(kind === 'etl' ? {
      LogStrategy: '1',
      transactionIsolation: 100,
      compensateFlag: '1',
      maxNodeCount: '0',
      maxReRunCount: '0',
      maxMemoryUseRate: '0',
    } : {}),
  };
  let r = await c.request(E.save, { method: 'POST', body, dryRun: opts.dryRun ?? false });
  let d = dataOf(r);
  // 并发/批量创建时 3 位随机编码仍可能撞车：自动换一个编码重试（显式 configId 不重试）
  for (let attempt = 0; attempt < 3 && !r.ok && !input.configId && /编码已存在|已存在/.test(r.msg ?? ''); attempt++) {
    configId = defaultConfigId(new Date(), kind);
    body.configId = configId;
    r = await c.request(E.save, { method: 'POST', body, dryRun: opts.dryRun ?? false });
    d = dataOf(r);
  }
  let processId = d?.processId ?? d?.id ?? d?.configId;
  // 响应不带 processId → 按 configId/configName 回查
  if (!processId && r.ok) {
    const list = await listFlows(c, { keyword: input.processName, kind, pageSize: 100 });
    const hit = unwrapFlowRows(dataOf(list)).find(
      (x: any) => x.configId === configId || x.configName === input.processName || x.processName === input.processName,
    );
    processId = hit?.processId ?? hit?.id;
  }
  return { ok: r.ok, processId: processId ? String(processId) : undefined, configId, msg: r.msg, raw: d };
}

/** 生成流程编码：ESB_FLOW_/ETL_FLOW_<yyMMdd><3 位序号> */
export function defaultConfigId(date = new Date(), kind: FlowKind = 'esb'): string {
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const seq = String(Math.floor(Math.random() * 900) + 100);
  return `${kind === 'etl' ? 'ETL' : 'ESB'}_FLOW_${yy}${mm}${dd}${seq}`;
}

export async function getFlow(
  c: RestCloudClient,
  processId: string,
  opts: { kind?: FlowKind } = {},
): Promise<ApiResult> {
  return c.request(flowEndpoints(opts.kind).detail(processId), { method: 'GET' });
}

export async function cloneFlow(
  c: RestCloudClient,
  input: { processId: string; processName?: string; applicationId?: string; kind?: FlowKind },
  opts: { dryRun?: boolean; kind?: FlowKind } = {},
): Promise<{ ok: boolean; processId?: string; msg?: string; raw?: unknown }> {
  const kind = opts.kind ?? input.kind ?? 'esb';
  const E = flowEndpoints(kind);
  const r = await c.request(E.copy, {
    method: 'POST',
    body: { processId: input.processId, processName: input.processName, applicationId: input.applicationId },
    dryRun: opts.dryRun,
  });
  const d = dataOf(r);
  const processId = d?.processId ?? d?.id ?? d?.configId;
  return { ok: r.ok, processId: processId ? String(processId) : undefined, msg: r.msg, raw: d };
}

export async function deleteFlow(
  c: RestCloudClient,
  processId: string,
  opts: {
    dryRun?: boolean;
    retries?: number;
    kind?: FlowKind;
    /** 删除确认轮询参数（默认 20 次 × 500ms；测试可调小） */
    poll?: { attempts?: number; intervalMs?: number };
  } = {},
): Promise<ApiResult & { snapshotFile?: string }> {
  const kind = opts.kind ?? 'esb';
  const dry = opts.dryRun ?? true;
  const E = flowEndpoints(kind);
  // 删除前强制快照：删除无法从平台"撤销"，快照是唯一可审计的还原依据。
  let snapshotFile: string | undefined;
  if (!dry) {
    const snap = await captureFlowSnapshot(c, kind, processId);
    snapshotFile = snap.file;
  }
  // 实测：删除端点只认 Mongo id（用 processId 会"返回成功但没删掉"），
  // 且删除是异步的。重复调用删除会把队列里的删除再次置为待处理（number=0），
  // 所以默认只发一次请求，然后轮询详情确认；retries 仅供显式重试场景使用。
  const retries = opts.retries ?? 0;
  let last: ApiResult | undefined;
  for (let i = 0; i <= retries; i++) {
    let ids = processId;
    try {
      const detail = await c.request(E.detail(processId), { method: 'GET' });
      const d = dataOf(detail);
      if (d?.id) ids = `${d.id},${processId}`;
    } catch { /* 查不到就用 processId */ }
    last = await c.request(E.delete, {
      method: 'POST',
      body: { ids, appId: flowAppId(kind) },
      dryRun: dry,
    });
    if (!last.ok || dry) break;

    // 平台删除进入队列后，详情接口可能还会短暂返回 200；轮询确认。
    const pollAttempts = opts.poll?.attempts ?? 20;
    const pollInterval = opts.poll?.intervalMs ?? 500;
    let gone = false;
    for (let poll = 0; poll < pollAttempts; poll++) {
      if (pollInterval > 0) await new Promise((r) => setTimeout(r, pollInterval));
      try {
        const check = await c.request(E.detail(processId), { method: 'GET' });
        if (!check.ok && [404, 500].includes(check.httpStatus)) {
          gone = true;
          break;
        }
      } catch {
        // 轮询时网络异常：当作"还没删掉"继续等，不让异常打断删除流程
      }
    }
    if (gone) break;
    if (i < retries) await new Promise((r) => setTimeout(r, 1000));
  }
  const out = last! as ApiResult & { snapshotFile?: string };
  if (snapshotFile) out.snapshotFile = snapshotFile;
  // 请求成功但轮询后仍可读取：不能报告删除成功，避免调用方误以为已清理。
  if (out.ok && !dry) {
    let alive = true;
    try {
      const detail = await c.request(E.detail(processId), { method: 'GET' });
      alive = detail.ok;
    } catch (e) {
      // 确认阶段网络异常：无法证明已删除 → 按"仍可读取"处理（不谎报成功）
      alive = true;
      return Object.assign(out, {
        ok: false,
        msg: `删除请求已返回成功，但无法确认流程已消失（${processId}，${(e as Error).message}）；请稍后用 flow get 复核`,
      }) as ApiResult & { snapshotFile?: string };
    }
    if (alive) {
      return Object.assign(out, {
        ok: false,
        msg: `删除请求已返回成功，但流程仍可读取（${processId}）；请稍后重试或检查平台删除队列`,
      }) as ApiResult & { snapshotFile?: string };
    }
  }
  return out;
}

export async function publishFlow(
  c: RestCloudClient,
  processId: string,
  opts: { dryRun?: boolean; kind?: FlowKind } = {},
): Promise<ApiResult> {
  const E = flowEndpoints(opts.kind);
  if (!E.publish) throw new Error(`${opts.kind ?? 'esb'} 流程无 publish 端点`);
  return c.request(E.publish, { method: 'POST', body: { processId }, dryRun: opts.dryRun ?? true });
}

export async function listVersions(
  c: RestCloudClient,
  processId: string,
  opts: { kind?: FlowKind } = {},
): Promise<ApiResult> {
  const E = flowEndpoints(opts.kind);
  if (!E.versionList) throw new Error(`${opts.kind ?? 'esb'} 流程无版本端点`);
  return c.request(E.versionList, { method: 'GET', query: { processId } });
}

/** 恢复历史版本；恢复前快照当前流程，避免恢复错版本后无法回退。 */
export async function restoreVersion(
  c: RestCloudClient,
  processId: string,
  versionId: string,
  opts: { dryRun?: boolean; kind?: FlowKind } = {},
): Promise<ApiResult & { snapshotFile?: string }> {
  const kind = opts.kind ?? 'esb';
  const dry = opts.dryRun ?? true;
  const E = flowEndpoints(kind);
  if (!E.versionRestore) throw new Error(`${kind} 流程无版本恢复端点`);
  let snapshotFile: string | undefined;
  if (!dry) {
    const snap = await captureFlowSnapshot(c, kind, processId);
    snapshotFile = snap.file;
  }
  const r = await c.request(E.versionRestore, {
    method: 'POST',
    body: { id: versionId },
    dryRun: dry,
  });
  const out = r as ApiResult & { snapshotFile?: string };
  if (snapshotFile) out.snapshotFile = snapshotFile;
  return out;
}

// ---------------- 平台校验 ----------------

export interface PlatformCheck {
  ok: boolean;
  msg: string;
  /** 平台返回的问题节点（若有） */
  errorNodeList?: { id?: string; nodeId?: string; name?: string; msg?: string; [k: string]: unknown }[];
  raw?: unknown;
}

/** 调用平台 checkerror（图 + 节点属性的联合校验） */
export async function checkFlow(
  c: RestCloudClient,
  input: { appId?: string; processId: string; processModel: string; kind?: FlowKind },
): Promise<PlatformCheck> {
  const kind = input.kind ?? 'esb';
  const appId = input.appId ?? flowAppId(kind);
  const E = flowEndpoints(kind);
  const r = await c.request(E.modelCheck, {
    method: 'POST',
    body: { appId, processId: input.processId, processModel: input.processModel },
    dryRun: false,
  });
  const d = dataOf(r);
  const errList = d?.errorNodeList;
  return {
    ok: r.ok && d?.state !== false,
    msg: d?.msg ?? r.msg ?? '',
    errorNodeList: Array.isArray(errList) ? errList : undefined,
    raw: d,
  };
}

// ---------------- 节点属性 ----------------

export interface NodePropsInput {
  nodeId: string;
  nodeType: string;
  nodeName?: string;
  /** 业务属性（会按平台规则字符串化） */
  props?: Record<string, unknown>;
  /** 读回/快照中的属性记录 id；带 id 提交是更新而非插入 */
  id?: string;
}

export interface NodePropsRecord extends Record<string, unknown> {
  id?: string;
  pNodeId?: string;
  pNodeType?: string;
}

const META_KEYS = new Set(['pNodeId', 'pNodeType', 'pNodeName', 'nodeId', 'nodeType', 'nodeName', 'props', 'id']);

function stripMeta(v: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(v).filter(([k]) => !META_KEYS.has(k)));
}

/**
 * 属性格式统一入口。支持：
 *   1. [{nodeId,nodeType,nodeName?,props:{...}}]
 *   2. [{pNodeId,pNodeType,pNodeName,...业务字段}]
 *   3. { T00001: {pNodeId,pNodeType,...}, ... }
 *   4. { model, props } 组合文件
 * 返回去重后的 NodePropsInput[]；重复 nodeId 以最后一次为准。
 */
export function normalizeNodeProps(input: unknown): NodePropsInput[] | undefined {
  if (input === undefined || input === null) return undefined;
  let raw = input;
  if (typeof raw === 'object' && !Array.isArray(raw) && (raw as any).model !== undefined && (raw as any).props !== undefined) {
    raw = (raw as any).props;
  }
  const out: NodePropsInput[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const v = item as Record<string, any>;
      const nodeId = String(v.nodeId ?? v.pNodeId ?? '');
      if (!nodeId) continue;
      const explicit = v.props && typeof v.props === 'object' && !Array.isArray(v.props);
      const props = explicit ? { ...(v.props as Record<string, unknown>) } : stripMeta(v);
      out.push({
        nodeId,
        nodeType: String(v.nodeType ?? v.pNodeType ?? 'unknown'),
        nodeName: v.nodeName ?? v.pNodeName,
        props,
        ...(v.id ? { id: String(v.id) } : {}),
      });
    }
  } else if (typeof raw === 'object') {
    for (const [nodeId, value] of Object.entries(raw as Record<string, any>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const v = value as Record<string, any>;
      out.push({
        nodeId,
        nodeType: String(v.pNodeType ?? v.nodeType ?? 'unknown'),
        nodeName: v.pNodeName ?? v.nodeName,
        props: v.props && typeof v.props === 'object' && !Array.isArray(v.props) ? { ...v.props } : stripMeta(v),
        ...(v.id ? { id: String(v.id) } : {}),
      });
    }
  }
  const byId = new Map<string, NodePropsInput>();
  for (const n of out) byId.set(n.nodeId, n);
  return [...byId.values()];
}

/** 把 NodePropsInput[] 转成校验器需要的 nodeId → props 映射 */
export function nodePropsMap(nodes: NodePropsInput[] | undefined): Record<string, Record<string, unknown>> | undefined {
  if (!nodes?.length) return undefined;
  return Object.fromEntries(nodes.map((n) => [n.nodeId, {
    pNodeId: n.nodeId,
    pNodeType: n.nodeType,
    ...(n.nodeName ? { pNodeName: n.nodeName } : {}),
    ...(n.props ?? {}),
  }]));
}

function propsRecords(payload: any): NodePropsRecord[] {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.flatMap((x) => (x && typeof x === 'object' ? propsRecords(x) : []));
  }
  if (typeof payload !== 'object') return [];
  if (Array.isArray(payload.rows)) return payload.rows.flatMap((x: any) => propsRecords(x));
  if (Array.isArray(payload.data)) return payload.data.flatMap((x: any) => propsRecords(x));
  if (Array.isArray(payload.data?.rows)) return payload.data.rows.flatMap((x: any) => propsRecords(x));
  if (payload.pNodeId !== undefined || payload.pNodeType !== undefined || payload.id !== undefined) {
    return [payload as NodePropsRecord];
  }
  return Object.entries(payload)
    .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
    .map(([k, v]) => ({ ...(v as NodePropsRecord), pNodeId: (v as any).pNodeId ?? k }));
}

export async function getNodeProps(
  c: RestCloudClient,
  processId: string,
  nodeId: string,
  opts: { kind?: FlowKind } = {},
): Promise<NodePropsRecord> {
  const r = await c.request(flowEndpoints(opts.kind).nodeProps, {
    method: 'GET',
    query: { processId, nodeId },
  });
  return propsRecords(dataOf(r))[0] ?? {};
}

/** 批量读取的原始结果：保留同一 pNodeId 的重复记录，供保存时清理。 */
async function readNodePropsBatch(
  c: RestCloudClient,
  processId: string,
  nodeIds: string[],
  opts: { kind?: FlowKind } = {},
): Promise<NodePropsRecord[]> {
  const ids = [...new Set(nodeIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const E = flowEndpoints(opts.kind);
  if (E.nodePropsList) {
    const r = await c.request(E.nodePropsList, {
      method: 'GET',
      query: { processId, nodeIds: ids.join(',') },
    });
    if (r.ok) {
      const wanted = new Set(ids);
      return propsRecords(dataOf(r)).filter((x) => wanted.has(String(x.pNodeId ?? '')));
    }
  }
  // ETL 没有批量端点；逐节点读取，保持与 ESB 相同的返回结构。
  const out: NodePropsRecord[] = [];
  for (const id of ids) out.push(await getNodeProps(c, processId, id, opts));
  return out;
}

export async function getNodePropsBatch(
  c: RestCloudClient,
  processId: string,
  nodeIds: string[],
  opts: { kind?: FlowKind } = {},
): Promise<NodePropsRecord[]> {
  const ids = [...new Set(nodeIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const records = await readNodePropsBatch(c, processId, ids, opts);
  // 平台返回对象映射时，顺序不保证；按请求顺序稳定输出（同一节点只保留一条）。
  const byId = new Map(records.map((x) => [String(x.pNodeId ?? ''), x]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

/** 流程内已有节点（省略 nodeType 返回全部节点；ESB 可用 nodeType=router） */
export async function listFlowNodes(
  c: RestCloudClient,
  processId: string,
  nodeType?: string,
  opts: { kind?: FlowKind } = {},
): Promise<{ nodeId: string; nodeName?: string }[]> {
  const r = await c.request(flowEndpoints(opts.kind).nodeSelect, {
    method: 'GET',
    query: { processId, nodeType },
  });
  return unwrapFlowRows(dataOf(r))
    .map((x: any) => ({ nodeId: String(x.nodeId ?? x.id ?? x.pNodeId ?? ''), nodeName: x.nodeName ?? x.pNodeName }))
    .filter((x) => x.nodeId !== '');
}

/** 平台规则：数组 join(',')，布尔 "0"/"1"，嵌套 JSON 字符串 */
function toPlatformProps(props: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'boolean') out[k] = v ? '1' : '0';
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(',');
    else if (typeof v === 'object') out[k] = JSON.stringify(v);
    else out[k] = v as string | number;
  }
  return out;
}

export interface UpsertReport {
  inserted: string[];
  updated: string[];
  failed: { nodeId: string; msg?: string }[];
  /** 清理掉的重复属性记录所属节点（历史上未带 id 提交产生的重复） */
  deduped?: string[];
}

function nodeBody(input: {
  appId: string;
  processId: string;
  node: NodePropsInput;
  existingId?: string;
}): Record<string, unknown> {
  return {
    ...toPlatformProps(input.node.props ?? {}),
    ...(input.node.id ?? input.existingId ? { id: input.node.id ?? input.existingId } : {}),
    appId: input.appId,
    processId: input.processId,
    pNodeId: input.node.nodeId,
    pNodeType: input.node.nodeType,
    pNodeName: input.node.nodeName ?? input.node.nodeId,
  };
}

const chunks = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/** 按属性记录 id 删除一条记录（不会误删同节点其他记录）。 */
async function deletePropRecord(
  c: RestCloudClient,
  input: { kind: FlowKind; appId: string; processId: string; nodeId: string; recordId: string },
  dryRun: boolean,
): Promise<ApiResult> {
  return c.request(flowEndpoints(input.kind).nodeDelete, {
    method: 'POST',
    body: {
      processId: input.processId,
      nodeId: input.nodeId,
      pNodeId: input.nodeId,
      appId: input.appId,
      id: input.recordId,
      ids: input.recordId,
    },
    dryRun,
  });
}

/**
 * 节点属性幂等 upsert：先读既有属性（拿 id），再带 id 提交。
 * 不带 id 的提交会插入新记录 → 造成同一节点重复（平台随后报"网关未配对"）。
 * ESB 可用 batch/save 批量提交（body 为属性数组）；ETL 逐节点降级。
 */
export async function upsertNodeProps(
  c: RestCloudClient,
  input: { appId: string; processId: string; nodes: NodePropsInput[]; kind?: FlowKind },
  opts: { dryRun?: boolean; useBatch?: boolean } = {},
): Promise<UpsertReport> {
  const report: UpsertReport = { inserted: [], updated: [], failed: [], deduped: [] };
  const kind = input.kind ?? 'esb';
  const E = flowEndpoints(kind);
  const nodes = input.nodes.filter((n) => n?.nodeId);
  if (nodes.length === 0) return report;
  const dry = opts.dryRun ?? false;
  const useBatch = opts.useBatch ?? (kind === 'esb' && Boolean(E.nodeBatchSave) && nodes.length >= 3);

  if (useBatch && E.nodeBatchSave) {
    let existingAll: NodePropsRecord[] = [];
    try {
      existingAll = await readNodePropsBatch(c, input.processId, nodes.map((n) => n.nodeId), { kind });
    } catch {
      existingAll = [];
    }
    const existingById = new Map(existingAll.map((x) => [String(x.pNodeId ?? ''), x]));
    for (const group of chunks(nodes, 100)) {
      const bodies = group.map((n) => nodeBody({
        appId: input.appId,
        processId: input.processId,
        node: n,
        existingId: existingById.get(n.nodeId)?.id,
      }));
      const br = await c.request(E.nodeBatchSave, { method: 'POST', body: bodies, dryRun: dry });
      if (br.ok) {
        for (const n of group) {
          if (n.id || existingById.get(n.nodeId)?.id) report.updated.push(n.nodeId);
          else report.inserted.push(n.nodeId);
        }
        continue;
      }
      // 批量接口失败时降级为逐节点，拿到更具体的失败原因；批量请求按数组原子提交，
      // 不会出现"一半写成功"后再次逐节点插入的重复记录。
      for (const n of group) {
        const one = await upsertOne(c, kind, input.appId, input.processId, n, dry);
        if (one.ok) {
          if (one.existing) report.updated.push(n.nodeId);
          else report.inserted.push(n.nodeId);
          if (one.deduped) report.deduped!.push(n.nodeId);
        } else {
          report.failed.push({ nodeId: n.nodeId, msg: one.msg });
        }
      }
    }

    // 清理历史重复记录：早期不带 id 的写入可能给同一 pNodeId 留下多条属性。
    // 保留本次用于更新的那条，其余按属性记录 id 删除。
    const byNode = new Map<string, NodePropsRecord[]>();
    for (const rec of existingAll) {
      const id = String(rec.pNodeId ?? '');
      if (!id) continue;
      byNode.set(id, [...(byNode.get(id) ?? []), rec]);
    }
    for (const [nodeId, recs] of byNode) {
      if (recs.length < 2) continue;
      const keepId = existingById.get(nodeId)?.id;
      for (const rec of recs) {
        if (!rec.id || rec.id === keepId) continue;
        const dr = await deletePropRecord(c, {
          kind, appId: input.appId, processId: input.processId, nodeId, recordId: rec.id,
        }, dry);
        if (dr.ok) report.deduped!.push(nodeId);
        else report.failed.push({ nodeId, msg: `清理重复属性 ${rec.id} 失败：${dr.msg ?? dr.httpStatus}` });
      }
    }
    report.deduped = [...new Set(report.deduped)];
    return report;
  }

  for (const n of nodes) {
    const one = await upsertOne(c, kind, input.appId, input.processId, n, dry);
    if (one.ok) {
      if (one.existing) report.updated.push(n.nodeId);
      else report.inserted.push(n.nodeId);
      if (one.deduped) report.deduped!.push(n.nodeId);
    } else {
      report.failed.push({ nodeId: n.nodeId, msg: one.msg });
      break; // 失败即停，避免半截状态
    }
  }
  report.deduped = [...new Set(report.deduped)];
  return report;
}

export interface SaveNodePropsReport extends UpsertReport {
  snapshotFile?: string;
  rolledBack?: boolean;
  rollback?: RestoreReport;
}

/**
 * 属性单独保存：先快照，失败时回滚。
 * 与 saveFlowComplete 共用同一套归一化后的 NodePropsInput[]。
 */
export async function saveNodePropsComplete(
  c: RestCloudClient,
  input: { appId: string; processId: string; nodes: NodePropsInput[]; kind?: FlowKind },
  opts: { dryRun?: boolean; snapshot?: boolean } = {},
): Promise<SaveNodePropsReport> {
  const kind = input.kind ?? 'esb';
  const dry = opts.dryRun ?? true;
  let snap: FlowSnapshotResult | undefined;
  if (!dry && opts.snapshot !== false) {
    snap = await captureFlowSnapshot(c, kind, input.processId);
  }
  const rep = await upsertNodeProps(c, input, { dryRun: dry });
  const out: SaveNodePropsReport = { ...rep, snapshotFile: snap?.file };
  if (!dry && rep.failed.length > 0 && snap) {
    const rb = await restoreFlowSnapshot(c, snap.snapshot, {
      attemptedIds: input.nodes.map((n) => n.nodeId),
    });
    out.rolledBack = rb.ok;
    out.rollback = rb;
  }
  return out;
}

async function upsertOne(
  c: RestCloudClient,
  kind: FlowKind,
  appId: string,
  processId: string,
  n: NodePropsInput,
  dryRun: boolean,
): Promise<{ ok: boolean; existing: boolean; msg?: string; deduped?: boolean }> {
  // 单节点读回在极端情况下也会返回多条历史记录；先保留第一条用于更新。
  const raw = await c.request(flowEndpoints(kind).nodeProps, {
    method: 'GET',
    query: { processId, nodeId: n.nodeId },
  });
  const records = propsRecords(dataOf(raw)).filter(
    (x) => !x.pNodeId || String(x.pNodeId) === n.nodeId,
  );
  const existing = records[0] ?? {};
  const existingId = n.id ?? existing.id;
  const body = nodeBody({ appId, processId, node: n, existingId });
  const r = await c.request(flowEndpoints(kind).nodeSave, { method: 'POST', body, dryRun });
  let deduped = false;
  if (r.ok && !dryRun && records.length > 1) {
    for (const rec of records) {
      if (!rec.id || rec.id === existingId) continue;
      const dr = await deletePropRecord(c, { kind, appId, processId, nodeId: n.nodeId, recordId: rec.id }, dryRun);
      if (dr.ok) deduped = true;
    }
  }
  return { ok: r.ok, existing: Boolean(existingId), msg: r.msg, deduped };
}

/** 本地记录"某流程上次保存的节点集合"，用于下次清理旧属性（平台无"枚举属性"接口） */
async function nodeSetFile(processId: string): Promise<string> {
  const home = process.env.RC_HOME ?? join(homedir(), '.rc');
  return join(home, 'flow-nodes', `${processId}.json`);
}

export async function readSavedNodeSet(processId: string): Promise<string[]> {
  try {
    const raw = await readFile(await nodeSetFile(processId), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

export async function writeSavedNodeSet(processId: string, ids: string[]): Promise<void> {
  const file = await nodeSetFile(processId);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify(ids), 'utf8');
}

/** 删除单个节点的属性记录（含 id 与 nodeId 两种平台口径） */
export async function deleteNodeProps(
  c: RestCloudClient,
  input: { processId: string; nodeId: string; kind?: FlowKind },
  opts: { dryRun?: boolean } = {},
): Promise<ApiResult> {
  const kind = input.kind ?? 'esb';
  const props = await getNodeProps(c, input.processId, input.nodeId, { kind });
  const body: Record<string, unknown> = {
    processId: input.processId,
    nodeId: input.nodeId,
    pNodeId: input.nodeId,
    appId: flowAppId(kind),
    ...(props?.id ? { id: props.id, ids: props.id } : {}),
  };
  return c.request(flowEndpoints(kind).nodeDelete, {
    method: 'POST',
    body,
    dryRun: opts.dryRun ?? false,
  });
}

/**
 * 清理图上已删除节点遗留的属性（否则平台报"图形已被删除"或"网关没有成对"）。
 * keepNodeIds：当前图中保留的节点 key + routerId。
 */
export async function pruneNodeProps(
  c: RestCloudClient,
  input: { processId: string; keepNodeIds: string[]; kind?: FlowKind },
  opts: { dryRun?: boolean } = {},
): Promise<{ removed: string[]; failed: { id: string; msg?: string }[] }> {
  const kind = input.kind ?? 'esb';
  const out = { removed: [] as string[], failed: [] as { id: string; msg?: string }[] };
  const keep = new Set(input.keepNodeIds);
  const nodes = await listFlowNodes(c, input.processId, undefined, { kind }); // 全部节点
  const routers = kind === 'esb' ? await listFlowNodes(c, input.processId, 'router', { kind }) : []; // 连线
  const prev = await readSavedNodeSet(input.processId);              // 上次保存的节点集合
  const known = new Map<string, string>();
  for (const n of [...nodes, ...routers]) known.set(n.nodeId, n.nodeId);
  for (const id of prev) if (!known.has(id)) known.set(id, id);
  const stale = [...known.keys()].filter((id) => !keep.has(id));
  if (process.env.RC_DEBUG_PRUNE) {
    console.error(`[prune] processId=${input.processId} known=${[...known.keys()].join(',')} keep=${[...keep].join(',')} stale=${stale.join(',')}`);
  }
  for (const id of stale) {
    const r = await deleteNodeProps(c, { processId: input.processId, nodeId: id, kind }, { dryRun: opts.dryRun ?? false });
    if (r.ok) out.removed.push(id);
    else out.failed.push({ id, msg: r.msg });
  }
  return out;
}

// ---------------- 快照 / 回滚 ----------------

export interface FlowSnapshot {
  version: 1;
  kind: FlowKind;
  processId: string;
  capturedAt: string;
  detail: any;
  model?: unknown;
  nodes: string[];
  routers: string[];
  props: Record<string, NodePropsRecord>;
  savedNodeSet: string[];
}

export interface FlowSnapshotResult {
  file: string;
  snapshot: FlowSnapshot;
}

function snapshotDir(dir?: string): string {
  return snapshotHome(dir);
}

function parseModel(detail: any): unknown {
  const raw = detail?.processModel ?? detail?.model ?? detail?.data?.processModel;
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return undefined; }
  }
  return raw;
}

/**
 * 图上的全部节点/连线 ID。
 * ETL 的 node/select 不返回 router，必须从 processModel.linkDataArray 补齐；
 * ESB 也以图为准，避免 select 索引延迟导致快照/导出漏属性。
 */
async function graphIds(
  c: RestCloudClient,
  processId: string,
  kind: FlowKind,
  detail?: any,
): Promise<{ nodes: string[]; routers: string[]; model?: any }> {
  const d = detail ?? dataOf(await getFlow(c, processId, { kind }));
  const model = parseModel(d) as any;
  if (model?.nodeDataArray || model?.linkDataArray) {
    return {
      nodes: (model.nodeDataArray ?? []).map((n: any) => String(n.key)).filter(Boolean),
      routers: (model.linkDataArray ?? []).map((l: any) => String(l.routerId)).filter(Boolean),
      model,
    };
  }
  const nodes = await listFlowNodes(c, processId, undefined, { kind });
  const routers = kind === 'esb' ? await listFlowNodes(c, processId, 'router', { kind }) : [];
  return { nodes: nodes.map((x) => x.nodeId), routers: routers.map((x) => x.nodeId) };
}

/** 保存流程图 + 属性的本地快照；删除/保存/版本恢复前调用。 */
export async function captureFlowSnapshot(
  c: RestCloudClient,
  kind: FlowKind,
  processId: string,
  opts: { dir?: string } = {},
): Promise<FlowSnapshotResult> {
  const r = await getFlow(c, processId, { kind });
  if (!r.ok) {
    throw new RcError('E_SNAPSHOT', `快照失败：无法读取 ${kind}/${processId}（${r.msg ?? r.httpStatus}）`, { traceId: r.traceId });
  }
  const detail = dataOf(r) ?? {};
  const graph = await graphIds(c, processId, kind, detail);
  const savedNodeSet = await readSavedNodeSet(processId);
  const ids = [...new Set([...graph.nodes, ...graph.routers, ...savedNodeSet])];
  const props: Record<string, NodePropsRecord> = {};
  const records = await getNodePropsBatch(c, processId, ids, { kind });
  for (const p of records) {
    const id = String(p.pNodeId ?? '');
    if (id && Object.keys(p).length) props[id] = p;
  }
  const snapshot: FlowSnapshot = {
    version: 1,
    kind,
    processId,
    capturedAt: new Date().toISOString(),
    detail,
    model: graph.model ?? parseModel(detail),
    nodes: graph.nodes,
    routers: graph.routers,
    props,
    savedNodeSet,
  };
  const dir = snapshotDir(opts.dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `flow-${kind}-${processId}-${snapshot.capturedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify(snapshot, null, 1), { mode: 0o600 });
  return { file, snapshot };
}

export interface RestoreReport {
  ok: boolean;
  modelSaved?: boolean;
  deleted: string[];
  restored: string[];
  failed: { id: string; msg?: string }[];
  /** 回读校验后补写的节点（平台索引延迟导致第一次没读到） */
  rewritten?: string[];
  msg?: string;
  /**
   * 回写后的回读校验：平台属性索引有延迟，写完立刻读可能少几条。
   * 这里记录实际读到的条数、仍然缺失的节点，以及补写轮数。
   */
  verified?: { props: number; expected: number; missing: string[]; rounds: number };
}

/**
 * 把流程快照写回平台。顺序：恢复图模型 → 删除本次尝试过的属性 → 写回快照属性。
 * 这是失败回滚，不追求保留属性记录 id；图与业务字段以快照为准。
 */
export async function restoreFlowSnapshot(
  c: RestCloudClient,
  snapshotOrFile: FlowSnapshot | string,
  opts: {
    attemptedIds?: string[];
    dir?: string;
    /** 回写后的回读校验轮数（默认 3；0 表示不校验） */
    verifyRounds?: number;
    /** 每轮之间的等待（默认 300ms；平台属性索引延迟） */
    verifyDelayMs?: number;
  } = {},
): Promise<RestoreReport> {
  const snap: FlowSnapshot = typeof snapshotOrFile === 'string'
    ? JSON.parse(await readFile(snapshotOrFile, 'utf8')) as FlowSnapshot
    : snapshotOrFile;
  const kind = snap.kind ?? 'esb';
  const E = flowEndpoints(kind);
  const report: RestoreReport = { ok: false, deleted: [], restored: [], failed: [], rewritten: [] };
  let modelSaved: boolean | undefined;

  if (snap.model) {
    const r = await c.request(E.modelSave, {
      method: 'POST',
      body: {
        appId: flowAppId(kind),
        processId: snap.processId,
        processModel: typeof snap.model === 'string' ? snap.model : JSON.stringify(snap.model),
      },
      dryRun: false,
    });
    modelSaved = r.ok;
    if (!r.ok) report.failed.push({ id: '__model__', msg: r.msg });
  }
  report.modelSaved = modelSaved;

  const originalIds = new Set([...snap.nodes, ...snap.routers, ...Object.keys(snap.props)]);
  const attemptedIds = new Set(opts.attemptedIds ?? []);
  const toDelete = new Set([...originalIds, ...attemptedIds]);
  for (const id of toDelete) {
    try {
      const r = await deleteNodeProps(c, { processId: snap.processId, nodeId: id, kind });
      if (r.ok) report.deleted.push(id);
    } catch (e) {
      // 属性本来就不存在时平台可能返回 500；不影响后续写回。
      report.failed.push({ id, msg: (e as Error).message });
    }
  }

  const model = (snap.model ?? {}) as any;
  const typeOf = new Map<string, string>((model.nodeDataArray ?? []).map((n: any) => [String(n.key), String(n.nodeType)]));
  const nodes = Object.entries(snap.props).map(([nodeId, p]) => ({
    nodeId,
    nodeType: String(p.pNodeType ?? typeOf.get(nodeId) ?? 'unknown'),
    nodeName: p.pNodeName ? String(p.pNodeName) : undefined,
    id: p.id,
    props: stripMeta(p),
  }));
  if (nodes.length) {
    const ur = await upsertNodeProps(c, {
      appId: flowAppId(kind), processId: snap.processId, nodes, kind,
    }, { useBatch: false });
    report.restored.push(...ur.inserted, ...ur.updated);
    report.failed.push(...ur.failed.map((f) => ({ id: f.nodeId, msg: f.msg })));
  }
  // ⑧ 回写后回读校验：平台的属性索引有延迟，写完立刻批量读可能少几条。
  // 读 → 缺哪条补哪条 → 再读，最多 verifyRounds 轮；结果写进报告（verified）。
  const expectedIds = Object.keys(snap.props);
  const rounds = opts.verifyRounds ?? 3;
  const delayMs = opts.verifyDelayMs ?? 300;
  let missing = expectedIds;
  let roundsUsed = 0;
  for (let round = 0; round < rounds; round++) {
    roundsUsed = round + 1;
    let current: NodePropsRecord[] = [];
    try {
      current = await getNodePropsBatch(c, snap.processId, expectedIds, { kind });
    } catch {
      current = [];
    }
    const have = new Set(current.map((p) => String(p.pNodeId ?? '')));
    missing = expectedIds.filter((id) => !have.has(id));
    if (!missing.length) break;
    // 缺失补写（幂等 upsert）
    const redo = missing
      .map((id) => nodes.find((n) => n.nodeId === id))
      .filter((n): n is (typeof nodes)[number] => Boolean(n));
    if (!redo.length) break;
    const ur = await upsertNodeProps(c, {
      appId: flowAppId(kind), processId: snap.processId, nodes: redo, kind,
    }, { useBatch: false });
    report.restored.push(...ur.inserted, ...ur.updated);
    report.rewritten!.push(...redo.map((n) => n.nodeId));
    report.failed.push(...ur.failed.map((f) => ({ id: f.nodeId, msg: f.msg })));
    if (round + 1 < rounds && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  report.verified = {
    props: expectedIds.length - missing.length,
    expected: expectedIds.length,
    missing,
    rounds: roundsUsed,
  };

  await writeSavedNodeSet(snap.processId, snap.savedNodeSet ?? [...snap.nodes, ...snap.routers]);
  report.restored = [...new Set(report.restored)];
  report.rewritten = [...new Set(report.rewritten ?? [])];
  report.ok = report.failed.length === 0 && missing.length === 0;
  report.msg = report.ok
    ? `已回滚到快照（属性回读 ${expectedIds.length}/${expectedIds.length}）`
    : missing.length
      ? `回滚有 ${report.failed.length} 项失败，仍缺 ${missing.length} 条属性：${missing.slice(0, 5).join(',')}`
      : `回滚有 ${report.failed.length} 项失败`;
  return report;
}

// ---------------- 完整保存 ----------------

export interface SaveFlowOptions {
  appId?: string;
  processId: string;
  /** 图模型对象或已序列化的字符串 */
  model: unknown;
  /** 节点属性（支持数组、nodeId 映射、组合文件 {model,props}） */
  nodeProps?: unknown;
  /** 保存前调用平台 checkerror（默认 true） */
  check?: boolean;
  /** 清理图外旧属性（默认 true） */
  prune?: boolean;
  dryRun?: boolean;
  kind?: FlowKind;
  /** 保存前快照（默认 true；dry-run 时自动跳过） */
  snapshot?: boolean;
  /** 平台校验/回读失败时自动回滚（默认 true） */
  rollbackOnFailure?: boolean;
  /** 回读重试的等待间隔（默认 300/600ms；测试可设为 0） */
  readbackDelayMs?: number;
  /** 回滚后回读校验轮数（默认 3） */
  rollbackVerifyRounds?: number;
  /** 回滚回读校验每轮之间的等待（默认 300ms） */
  rollbackVerifyDelayMs?: number;
  /** 快照目录 */
  snapshotDir?: string;
  /**
   * 期望的平台状态指纹（来自 flow export 的 fingerprint）。
   * 不一致 → 拒绝写入（别人已经改过这条流程），提示重新导出。
   */
  expectedFingerprint?: string;
  /** 忽略指纹检查（强制覆盖） */
  force?: boolean;
}

export interface SaveFlowReport {
  ok: boolean;
  /** 保存前的语义 diff（相对平台当前状态） */
  diff?: FlowDiff;
  /** 平台当前状态指纹（与 expectedFingerprint 比对的结果） */
  fingerprint?: { expected?: string; actual?: string; matched?: boolean };
  check?: PlatformCheck;
  props?: UpsertReport;
  pruned?: { removed: string[]; failed: { id: string; msg?: string }[] };
  modelSaved?: boolean;
  verified?: { nodes: number; routers: number; propsOk: boolean; missing: string[] };
  snapshotFile?: string;
  rolledBack?: boolean;
  rollback?: RestoreReport;
  msg?: string;
  traceId?: string;
}

/**
 * 完整保存（图 + 节点属性 + 平台校验 + 旧属性清理 + 回读校验）。
 * 顺序：快照 → 节点属性 upsert → 图保存 → 清理旧属性 → 平台校验 → 回读。
 * 平台校验/回读失败自动回滚到保存前快照。
 */
export async function saveFlowComplete(c: RestCloudClient, opts: SaveFlowOptions): Promise<SaveFlowReport> {
  const kind = opts.kind ?? 'esb';
  const appId = opts.appId ?? flowAppId(kind);
  const E = flowEndpoints(kind);
  const dry = opts.dryRun ?? false;
  const processModel = typeof opts.model === 'string' ? opts.model : JSON.stringify(opts.model);
  const report: SaveFlowReport = { ok: false };
  let parsed: any;
  try {
    parsed = JSON.parse(processModel);
  } catch (e) {
    report.msg = `图模型不是合法 JSON：${(e as Error).message}`;
    return report;
  }
  const nodeKeys: string[] = (parsed.nodeDataArray ?? []).map((n: any) => String(n.key));
  const routerIds: string[] = (parsed.linkDataArray ?? []).map((l: any) => String(l.routerId));
  const typeOf = new Map<string, string>((parsed.nodeDataArray ?? []).map((n: any) => [String(n.key), String(n.nodeType)]));
  const linkOf = new Map<string, any>((parsed.linkDataArray ?? []).map((l: any) => [String(l.routerId), l]));

  // ① 保存前快照：快照失败即中止，避免"改了一半无法回退"。
  let snap: FlowSnapshotResult | undefined;
  if (!dry && (opts.snapshot ?? true)) {
    try {
      snap = await captureFlowSnapshot(c, kind, opts.processId, { dir: opts.snapshotDir });
      report.snapshotFile = snap.file;
    } catch (e) {
      report.msg = `保存前快照失败，已中止：${(e as Error).message}`;
      return report;
    }
  }

  // ①b 当前平台状态：复用快照（省一次读）；dry-run 或未开快照时单独读一次。
  //     用途：算指纹（乐观并发保护）+ 算语义 diff（保存前告诉人改了什么）。
  let currentState: { model?: unknown; props?: Record<string, Record<string, unknown>> } | undefined;
  if (snap) {
    currentState = { model: snap.snapshot.model, props: snap.snapshot.props };
  } else {
    try {
      const detail = await getFlow(c, opts.processId, { kind });
      if (detail.ok) {
        const d = dataOf(detail) ?? {};
        const graph = await graphIds(c, opts.processId, kind, d);
        const curProps: Record<string, Record<string, unknown>> = {};
        const recs = await getNodePropsBatch(c, opts.processId, [...graph.nodes, ...graph.routers], { kind });
        for (const p of recs) {
          const id = String(p.pNodeId ?? '');
          if (id) curProps[id] = p;
        }
        currentState = { model: graph.model ?? parseModel(d), props: curProps };
      }
    } catch {
      // 读不到当前状态 → 不做指纹校验（但 diff 也没有基准）
    }
  }
  if (currentState) {
    report.fingerprint = { actual: flowFingerprint(currentState) };
    if (opts.expectedFingerprint) report.fingerprint.expected = opts.expectedFingerprint;
    if (
      opts.expectedFingerprint && !opts.force
      && report.fingerprint.actual !== opts.expectedFingerprint
    ) {
      report.ok = false;
      report.fingerprint.matched = false;
      report.msg = `平台上的流程已被修改（期望指纹 ${opts.expectedFingerprint}，当前 ${report.fingerprint.actual}），已拒绝写入；`
        + '请重新 `flow export` 后再保存，或确认要覆盖时加 --force';
      return report;
    }
    report.fingerprint.matched = true;
  }

  const rollback = async (attemptedIds: string[]): Promise<void> => {
    if (!snap || opts.rollbackOnFailure === false) return;
    report.rollback = await restoreFlowSnapshot(c, snap.snapshot, {
      attemptedIds,
      verifyRounds: opts.rollbackVerifyRounds,
      verifyDelayMs: opts.rollbackVerifyDelayMs,
    });
    report.rolledBack = report.rollback.ok;
  };

  const provided = new Map((normalizeNodeProps(opts.nodeProps) ?? []).map((n) => [n.nodeId, n]));
  const routerDefaults = (routerId: string): Record<string, unknown> => {
    const l = linkOf.get(routerId) ?? {};
    return {
      assertCondition: String(l.assertCondition ?? '0'),
      ...(l.routerCondition != null ? { routerCondition: String(l.routerCondition) } : {}),
      ...(l.condition != null ? { condition: String(l.condition) } : {}),
    };
  };

  // ② 组装属性：ESB/ETL 都要求图上每个节点/路由有属性记录（ETL 的 start/end/router 同样校验）。
  const full: NodePropsInput[] = [];
  full.push(...nodeKeys.map((k) => {
    const p = provided.get(k);
    const old = snap?.snapshot.props[k];
    if (!p && !old) return { nodeId: k, nodeType: typeOf.get(k) ?? 'unknown', props: {} };
    if (p && !old) return p;
    if (!p && old) {
      return {
        nodeId: k,
        nodeType: String(old.pNodeType ?? typeOf.get(k) ?? 'unknown'),
        nodeName: old.pNodeName ? String(old.pNodeName) : undefined,
        id: old.id,
        props: stripMeta(old),
      };
    }
    return { ...p!, props: { ...stripMeta(old ?? {}), ...(p!.props ?? {}) }, ...(p!.id ?? old?.id ? { id: p!.id ?? old!.id } : {}) };
  }));
  full.push(...routerIds.map((r) => {
    const p = provided.get(r);
    const old = snap?.snapshot.props[r];
    return {
      nodeId: r,
      nodeType: 'router',
      // router 的显示名也要带，否则语义 diff 会把每条 router 都算成"变更"
      nodeName: p?.nodeName ?? (old?.pNodeName ? String(old.pNodeName) : undefined),
      props: { ...routerDefaults(r), ...stripMeta(old ?? {}), ...(p?.props ?? {}) },
      ...(p?.id ?? old?.id ? { id: p?.id ?? old?.id } : {}),
    };
  }));

  // ②b 保存前的语义 diff：相对平台当前状态，列出新增/删除/变更的节点、连线、属性。
  if (currentState) {
    const nextProps: Record<string, Record<string, unknown>> = {};
    for (const n of full) {
      nextProps[n.nodeId] = {
        pNodeId: n.nodeId,
        pNodeType: n.nodeType,
        ...(n.nodeName ? { pNodeName: n.nodeName } : {}),
        ...(n.props ?? {}),
      };
    }
    report.diff = diffFlow(currentState, { model: parsed, props: nextProps });
  }

  // ③ 节点属性 upsert
  if (full.length) {
    report.props = await upsertNodeProps(c, { appId, processId: opts.processId, nodes: full, kind }, { dryRun: dry });
    if (report.props.failed.length) {
      report.msg = `节点属性保存失败：${report.props.failed.map((f) => `${f.nodeId}(${f.msg ?? '-'})`).join(', ')}`;
      await rollback([...nodeKeys, ...routerIds]);
      return report;
    }
  } else {
    report.props = { inserted: [], updated: [], failed: [] };
  }

  // ④ 图保存（保存后 node/select 才反映新图）
  const mr = await c.request(E.modelSave, {
    method: 'POST',
    body: { appId, processId: opts.processId, processModel },
    dryRun: dry,
  });
  report.modelSaved = mr.ok;
  if (!mr.ok) {
    report.msg = `图保存失败：${mr.msg ?? mr.httpStatus}`;
    report.traceId = mr.traceId;
    await rollback([...nodeKeys, ...routerIds]);
    return report;
  }

  // ⑤ 清理图外旧属性（必须在图保存之后：此时 node/select 已是新图；
  //    残留的旧网关属性会让平台校验报"并行网关和聚合网关没有成对"）
  if (opts.prune !== false && !dry) {
    report.pruned = await pruneNodeProps(c, {
      processId: opts.processId, keepNodeIds: [...nodeKeys, ...routerIds], kind,
    });
  }

  // 记录本次节点集合（供下次清理）
  if (!dry) await writeSavedNodeSet(opts.processId, [...nodeKeys, ...routerIds]);

  // ⑥ 平台校验（属性齐全 + 旧属性已清理）。
  // dry-run 时图没有真正落库，平台 checkerror 校验的是旧图，结果会误导 → 跳过。
  if (opts.check !== false && !dry) {
    const chk = await checkFlow(c, { appId, processId: opts.processId, processModel, kind });
    report.check = chk;
    if (!chk.ok) {
      report.msg = `平台校验未通过：${chk.msg}`;
      await rollback([...nodeKeys, ...routerIds]);
      return report;
    }
  }

  // ⑦ 回读校验（平台索引有延迟，重试后再判定）
  if (!dry) {
    let last: { nodes: number; routers: number; propsOk: boolean; missing: string[] } | undefined;
    const expected = [...new Set([...nodeKeys, ...routerIds])];
    for (let attempt = 0; attempt < 3; attempt++) {
      const records = await getNodePropsBatch(c, opts.processId, expected, { kind });
      const got = new Set(records.map((p) => String(p.pNodeId ?? '')));
      const missing = expected.filter((id) => !got.has(id));
      last = { nodes: nodeKeys.length, routers: routerIds.length, propsOk: missing.length === 0, missing };
      if (last.propsOk) break;
      const delay = opts.readbackDelayMs ?? 300 * (attempt + 1);
      if (attempt < 2 && delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
    report.verified = last ?? { nodes: 0, routers: 0, propsOk: true, missing: [] };
    if (!report.verified.propsOk) {
      report.msg = `回读校验：缺少 ${report.verified.missing.length} 个节点属性（${report.verified.missing.slice(0, 5).join(',')}）`;
      await rollback([...nodeKeys, ...routerIds]);
      return report;
    }
  }

  report.ok = true;
  report.msg = dry ? 'dry-run：未落库' : (report.rolledBack ? '保存失败，已回滚' : '保存完成');
  return report;
}

// ---------------- 导出 / 属性列表 ----------------

export interface FlowExport {
  processId: string;
  kind: FlowKind;
  configId?: string;
  configName?: string;
  applicationId?: string;
  model: unknown;
  props: Record<string, NodePropsRecord>;
  /**
   * 导出内容存在缺失的必填属性 → 标记为骨架。
   * 校验/保存时只提示不阻断：导出的是平台现状，不应该因为"导出→再保存"就被拦下。
   */
  skeleton?: boolean;
  /** 缺失的必填项（nodeId.field） */
  missingRequired?: string[];
  /**
   * 导出时平台状态的指纹（图 + 业务属性）。
   * 保存时带上它 → 平台状态变了就拒绝写入（乐观并发保护）。
   */
  fingerprint?: string;
}

/** 计算图上缺失的必填项（nodeId.field 列表）。 */
export function missingRequiredFields(
  model: unknown,
  props: Record<string, Record<string, unknown>>,
  requiredFields: Record<string, string[]>,
): string[] {
  const nodes = ((model as any)?.nodeDataArray ?? []) as any[];
  const out: string[] = [];
  for (const n of nodes) {
    const req = requiredFields[String(n.nodeType ?? '')];
    if (!req?.length) continue;
    const nodeId = String(n.key ?? '');
    const p = props[nodeId];
    for (const f of req) {
      if (!hasPropValue(p, f)) out.push(`${nodeId}.${f}`);
    }
  }
  return out;
}

/** 导出图 + 属性，可直接作为 flow save 的输入组合文件。 */
export async function exportFlow(
  c: RestCloudClient,
  processId: string,
  opts: { kind?: FlowKind } = {},
): Promise<{ ok: boolean; msg?: string; doc?: FlowExport }> {
  const kind = opts.kind ?? 'esb';
  const r = await getFlow(c, processId, { kind });
  if (!r.ok) return { ok: false, msg: r.msg };
  const detail = dataOf(r) ?? {};
  const graph = await graphIds(c, processId, kind, detail);
  if (!graph.model) return { ok: false, msg: '流程详情中没有 processModel' };
  const model = graph.model;
  const records = await getNodePropsBatch(c, processId, [...graph.nodes, ...graph.routers], { kind });
  const props: Record<string, NodePropsRecord> = {};
  for (const p of records) {
    const id = String(p.pNodeId ?? '');
    if (id) props[id] = p;
  }
  // 导出的是平台现状：缺必填属性时标记 skeleton，校验/保存只提示不阻断。
  const missing = missingRequiredFields(model, props, new Catalog().requiredFields(kind));
  const fingerprint = flowFingerprint({ model, props });
  return {
    ok: true,
    doc: {
      processId,
      kind,
      configId: detail.configId,
      configName: detail.configName ?? detail.processName,
      applicationId: detail.applicationId,
      model,
      props,
      // 导出的是平台现状：缺必填属性时标记 skeleton，校验/保存只提示不阻断。
      ...(missing.length ? { skeleton: true, missingRequired: missing } : {}),
      fingerprint,
    },
  };
}

/**
 * 平台当前就缺失的必填项（`nodeId|field` 集合）。
 *
 * 用途："沿用平台现状"——流程在平台上本来就没有这个字段，本次保存也没补上，
 * 那就不该因为本地规则把保存拦死（导出 → 再保存是常见动作）。
 * 平台读不到流程时返回空集合（不降级，按错误处理）。
 */
export async function platformMissingRequired(
  c: RestCloudClient,
  kind: FlowKind,
  processId: string,
  model: unknown,
  incomingProps?: Record<string, Record<string, unknown>>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const required = new Catalog().requiredFields(kind);
  const nodes = ((model as any)?.nodeDataArray ?? []) as any[];
  if (!nodes.length) return out;

  // 平台现状：读不到流程就不降级（按错误处理）。
  const detail = await getFlow(c, processId, { kind });
  if (!detail.ok) return out;
  const curModel = parseModel(dataOf(detail)) as any;
  const existing = new Set(((curModel?.nodeDataArray ?? []) as any[]).map((n: any) => String(n.key ?? '')));
  const nodeIds = [...existing];
  if (!nodeIds.length) return out;

  let current: NodePropsRecord[] = [];
  try {
    current = await getNodePropsBatch(c, processId, nodeIds, { kind });
  } catch {
    return out;
  }
  const byId = new Map(current.map((p) => [String(p.pNodeId ?? ''), p]));
  for (const n of nodes) {
    const req = required[String(n.nodeType ?? '')];
    if (!req?.length) continue;
    const nodeId = String(n.key ?? '');
    if (!existing.has(nodeId)) continue;          // 新增节点 → 不算"沿用现状"
    const cur = byId.get(nodeId);
    const next = incomingProps?.[nodeId];
    for (const f of req) {
      if (hasPropValue(next, f)) continue;        // 本次补上了 → 不降级
      if (hasPropValue(cur, f)) continue;          // 平台上有值 → 不算缺失
      out.add(`${nodeId}|${f}`);                   // 平台本来就缺 → 沿用现状
    }
  }
  return out;
}

/** SQL / 数据库类节点类型（"这个流程有几个 SQL 节点、各自 SQL 是什么"）。 */
export const SQL_NODE_TYPES = new Set([
  'sqlExecuterNode', 'sqlReadNode', 'jdbcWriteNode', 'jdbcReadNode', 'tableReadNode',
]);

/**
 * 属性过滤：
 *   - `only: 'sql'` → 只留 SQL/数据库类节点（并只保留 SQL 相关字段）；
 *   - `fields: [...]` → 只留指定字段。
 */
export function filterNodeProps(
  props: Record<string, NodePropsRecord>,
  opts: { only?: 'sql' | string; fields?: string[] } = {},
): Record<string, NodePropsRecord> {
  const only = opts.only ? String(opts.only).toLowerCase() : '';
  const fields = (opts.fields ?? []).map((f) => f.trim()).filter(Boolean);
  const out: Record<string, NodePropsRecord> = {};
  for (const [id, raw] of Object.entries(props ?? {})) {
    const type = String(raw.pNodeType ?? '');
    if (only === 'sql' && !SQL_NODE_TYPES.has(type)) continue;
    if (!fields.length) { out[id] = raw; continue; }
    const keep: NodePropsRecord = { pNodeId: raw.pNodeId ?? id, pNodeType: type } as NodePropsRecord;
    if (raw.pNodeName) keep.pNodeName = raw.pNodeName;
    for (const f of fields) if (raw[f] !== undefined) keep[f] = raw[f];
    out[id] = keep;
  }
  return out;
}

/** 节点属性里"平台元数据"（排查时不需要看的那部分）。 */
const NODE_META_FIELDS = new Set([
  'pNodeId', 'pNodeType', 'pNodeName', 'id', 'appId', 'processId', 'applicationId',
  'createTime', 'editTime', 'creator', 'creatorName', 'editor', 'editorName',
  'expireAfterIndexTime', 'pNodeRole',
]);

export interface FlowNodeSearchHit {
  processId: string;
  configId: string;
  configName: string;
  applicationId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  /** 去掉平台元数据后的属性（学"正确写法"用） */
  props: Record<string, unknown>;
  /**
   * 使用提示：这些样例来自**别的环境/别的部署**，不能直接照抄。
   * 典型问题：apiUrl 指向的是网关主机（与平台主机不同）、跨环境、占位符、注册表里的 apiId 换环境就失效。
   */
  notes: string[];
}

/**
 * 按节点类型找流程（"这种节点到底该怎么配？"）。
 *
 * 平台的组件目录里 initialValue 可能是截断的（apiUrl 的默认值就是这样），
 * 真正可靠的写法来自**真实流程**：这里扫描若干条流程的节点属性，
 * 把命中节点的业务属性（去掉平台元数据）列出来。
 */
export async function searchFlowsByNodeType(
  c: RestCloudClient,
  opts: {
    kind?: FlowKind; nodeType?: string; keyword?: string; maxFlows?: number; limit?: number;
    /** 顺带查当前环境的接口注册表，标注"apiId 在本环境查不到" */
    checkRegistry?: boolean;
    /** 扫全部流程（上限 500 条） */
    all?: boolean;
    /** 只保留属性命中 key=value 的节点（值支持子串匹配） */
    props?: Record<string, string>;
  } = {},
): Promise<{ hits: FlowNodeSearchHit[]; scanned: number; matched: number; hosts: string[] }> {
  const kind = opts.kind ?? 'esb';
  const nodeType = String(opts.nodeType ?? '').trim();
  if (!nodeType) return { hits: [], scanned: 0, matched: 0, hosts: [] };
  const maxFlows = opts.all ? 500 : Math.max(1, Math.min(500, opts.maxFlows ?? 30));
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  const list = await listFlows(c, { kind, all: true, pageSize: 100, keyword: opts.keyword });
  const flows = unwrapFlowRows(dataOf(list));
  const hits: FlowNodeSearchHit[] = [];
  let scanned = 0;
  const hostSet = new Set<string>();
  for (const f of flows) {
    if (scanned >= maxFlows || hits.length >= limit) break;
    const pid = String(f?.processId ?? '');
    if (!pid) continue;
    scanned++;
    let props: Record<string, NodePropsRecord> = {};
    try {
      props = (await listFlowProps(c, pid, { kind })).props;
    } catch {
      continue;
    }
    for (const [nodeId, p] of Object.entries(props)) {
      if (String(p.pNodeType ?? '') !== nodeType) continue;
      // 属性过滤：只要这些 key 的值命中（子串）就保留
      const want = opts.props ?? {};
      const hit = Object.entries(want).every(([k, v]) => {
        const actual = String((p as any)[k] ?? '');
        return actual !== '' && actual.toLowerCase().includes(String(v).toLowerCase());
      });
      if (!hit) continue;
      const clean: Record<string, unknown> = {};
      for (const k of Object.keys(p)) {
        if (NODE_META_FIELDS.has(k)) continue;
        const v = p[k];
        if (v === undefined || v === null || v === '') continue;
        clean[k] = typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v;
      }
      const host = urlHost(clean.apiUrl);
      if (host) hostSet.add(host);
      hits.push({
        processId: pid,
        configId: String(f?.configId ?? ''),
        configName: String(f?.configName ?? ''),
        applicationId: String(f?.applicationId ?? ''),
        nodeId,
        nodeName: String(p.pNodeName ?? ''),
        nodeType: nodeType,
        props: clean,
        notes: [],
      });
      if (hits.length >= limit) break;
    }
  }

  // ---- 使用提示：样例来自真实流程，但多半不能照抄 ----
  const currentHost = urlHost(c.baseUrl);
  const allHosts = [...hostSet].sort();
  for (const h of hits) {
    const notes: string[] = h.notes;
    const apiUrl = h.props.apiUrl;
    if (typeof apiUrl === 'string' && apiUrl) {
      if (/\$\{/.test(apiUrl)) {
        notes.push(`apiUrl 是占位符写法（${apiUrl.slice(0, 40)}…），由平台在运行时替换，照抄没有意义`);
      } else {
        const host = urlHost(apiUrl);
        if (host && currentHost && host !== currentHost) {
          notes.push(`样例 apiUrl 的主机是 ${host}，与当前平台主机 ${currentHost} 不同（多半是网关地址）：`
            + '照抄前先确认该主机在当前环境可达，否则要换成当前环境的地址');
        }
        if (host && currentHost && host === currentHost) {
          notes.push('样例 apiUrl 指向当前平台主机；若目标 API 在网关注册过，仍要按当前环境重新确认路径与凭据');
        }
      }
    }
    if (h.props.apiId && !apiUrl) {
      notes.push('样例只给了 apiId（引用接口注册表）：换环境时这个 id 会失效，要重新取');
    }
    if (allHosts.length > 1) {
      notes.push(`本环境出现多个网关主机：${allHosts.join('、')}；用哪个要看流程归属，别默认取第一个`);
    }
  }

  // 可选：核对当前环境的接口注册表
  if (opts.checkRegistry) {
    try {
      const reg = await listAllApis(c, { pageSize: 200 });
      const known = new Set(reg.rows.map((r: any) => String(r.id)));
      for (const h of hits) {
        const apiId = h.props.apiId ? String(h.props.apiId) : '';
        if (apiId && !known.has(apiId)) {
          h.notes.push(`apiId ${apiId} 在当前环境的接口注册表里查不到（多半是别的环境的 id）`);
        }
      }
    } catch {
      for (const h of hits) h.notes.push('接口注册表核对失败（可能是权限或网络问题），未能确认 apiId 是否属于当前环境');
    }
  }

  return { hits, scanned, matched: hits.length, hosts: allHosts };
}

/** 取 URL 的 host（非 URL 字符串返回空）。 */
function urlHost(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(value.trim());
  if (m) return m[1].toLowerCase();
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 运行一条 ESB 流程（同步触发一次实例）。
 * 平台端点：POST /rest/esb/process/monitor/instance/run，body { processId }。
 * 注意：这是**真的执行**流程（会触发外部调用/写库），CLI 侧要求 --apply。
 */
export async function runFlow(
  c: RestCloudClient,
  processId: string,
  opts: { kind?: FlowKind } = {},
): Promise<ApiResult> {
  const kind = opts.kind ?? 'esb';
  const E = flowEndpoints(kind);
  return c.request(`${E.base}/monitor/instance/run`, { method: 'POST', body: { processId }, dryRun: false });
}

/**
 * 一次流程运行的节点级记录（每个节点的入参/出参/断言结果）。
 * 平台端点：GET /rest/esb/process/monitor/node/instance/list?transactionId=...
 */
export async function runLog(
  c: RestCloudClient,
  transactionId: string,
  opts: { kind?: FlowKind } = {},
): Promise<{ ok: boolean; msg?: string; nodes: any[] }> {
  const kind = opts.kind ?? 'esb';
  const E = flowEndpoints(kind);
  const r = await c.request(`${E.base}/monitor/node/instance/list`, {
    method: 'GET', query: { transactionId },
  });
  const d: any = r.data?.data ?? r.data;
  const nodes = Array.isArray(d) ? d : (d?.rows ?? d?.list ?? []);
  return { ok: r.ok, msg: r.msg, nodes };
}

/**
 * 流程调度规则（BPM 规则表）。
 *
 * 实测：
 *   - 保存用 `POST /bpm/rules/save`，body 里 `processIds` 必须是**逗号分隔的字符串**
 *     （传数组会被序列化成一个元素，是个坑）；
 *   - **"启用"没有可用端点**（`rule/start` 恒报"启动失败"），只能由人在平台上启用；
 *     所以本工具只负责"建规则"，并在结果里明确提示还需要人工启用。
 */
export async function listScheduleRules(
  c: RestCloudClient,
  opts: { pageNo?: number; pageSize?: number } = {},
): Promise<ApiResult> {
  return c.request('/bpm/rules/list/page', {
    method: 'GET', query: { pageNo: opts.pageNo ?? 1, pageSize: opts.pageSize ?? 50 },
  });
}

export async function saveScheduleRule(
  c: RestCloudClient,
  body: { processIds: string; timeNumber?: number; cron?: string; name?: string; [k: string]: unknown },
): Promise<ApiResult> {
  const processIds = String(body.processIds ?? '').split(',').map((x) => x.trim()).filter(Boolean).join(',');
  if (!processIds) throw new RcError('E_VALIDATION', '需要 --process-ids "id1,id2"（逗号分隔的字符串）');
  return c.request('/bpm/rules/save', {
    method: 'POST',
    body: { ...body, processIds },
    dryRun: false,
  });
}

export async function deleteScheduleRule(c: RestCloudClient, id: string): Promise<ApiResult> {
  return c.request('/bpm/rules/delete', { method: 'POST', body: { id }, dryRun: false });
}

/** 列出流程全部节点属性（ESB 走批量端点；ETL 自动逐节点降级）。 */
export async function listFlowProps(
  c: RestCloudClient,
  processId: string,
  opts: { kind?: FlowKind } = {},
): Promise<{ ok: boolean; msg?: string; props: Record<string, NodePropsRecord> }> {
  const kind = opts.kind ?? 'esb';
  const graph = await graphIds(c, processId, kind);
  const records = await getNodePropsBatch(c, processId, [...graph.nodes, ...graph.routers], { kind });
  const props: Record<string, NodePropsRecord> = {};
  for (const p of records) {
    const id = String(p.pNodeId ?? '');
    if (id) props[id] = p;
  }
  return { ok: true, props };
}
