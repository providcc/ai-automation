/**
 * ETL 域：列表 / 详情 / 试跑 / 补偿
 * 注意：ETL 与 apiflow 共用 flow-json 概念，但接口前缀不同（/rest/etl/process/*）
 */
import type { RestCloudClient, ApiResult } from './client.ts';
import { RcError } from './errors.ts';

export const ETL = {
  list: '/rest/etl/process/list',
  detail: (id: string) => `/rest/etl/process/${id}`,
  save: '/rest/etl/process/save',
  modelSave: '/rest/etl/process/model/save',
  checkerror: '/rest/etl/process/model/checkerror',
  run: '/rest/etl/process/run',
  compensate: '/rest/etl/process/compensate',
  publish: '/rest/etl/process/publish',
  stop: '/rest/etl/process/stop',
} as const;

/**
 * ETL 写入闸门：**默认关闭**。
 *
 * ETL 模块是否可用由平台侧是否开通决定；未开通的环境执行 ETL 试跑/补偿/发布
 * 既无意义也可能产生脏数据，因此这里默认封禁写路径，只保留只读查询。
 *
 * 只有在确认平台已开通 ETL 能力的环境里，才显式设置 RC_ENABLE_ETL_WRITE=1。
 */
export function etlWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RC_ENABLE_ETL_WRITE === '1' || env.RC_ENABLE_ETL_WRITE === 'true';
}

export function assertEtlWriteAllowed(action: string): void {
  if (etlWriteEnabled()) return;
  throw new RcError(
    'E_FORBIDDEN',
    `ETL 写操作已封禁：${action}。当前环境未开通 ETL 能力，不要执行 ETL 试跑/补偿/发布；`
    + '请改用 ESB 编排与只读排查手段（如需执行，确认平台已开通后再设置 RC_ENABLE_ETL_WRITE=1）。',
  );
}

export async function listEtl(c: RestCloudClient, keyword?: string): Promise<ApiResult> {
  return c.request(ETL.list, { method: 'GET', query: { keyword } });
}

export async function getEtl(c: RestCloudClient, id: string): Promise<ApiResult> {
  return c.request(ETL.detail(id), { method: 'GET' });
}

/** mode=test 限量试跑；mode=full 全量（需 confirm）。ETL 写路径默认封禁。 */
export async function runEtl(
  c: RestCloudClient,
  processId: string,
  opts: { mode?: 'test' | 'full'; limit?: number; dryRun?: boolean } = {},
): Promise<ApiResult> {
  assertEtlWriteAllowed('ETL 试跑');
  const mode = opts.mode ?? 'test';
  if (mode === 'full' && opts.dryRun === false) {
    // 全量运行属危险操作，必须在调用方显式确认
    if (process.env.RC_CONFIRM_FULL_RUN !== '1') {
      throw new Error('全量运行被拒绝：需设置 RC_CONFIRM_FULL_RUN=1，并显式使用 --apply');
    }
  }
  return c.request(ETL.run, {
    method: 'POST',
    body: { processId, mode, limit: opts.limit ?? (mode === 'test' ? 100 : undefined) },
    dryRun: opts.dryRun,
  });
}

export async function compensateEtl(c: RestCloudClient, processId: string, batchId?: string): Promise<ApiResult> {
  assertEtlWriteAllowed('ETL 补偿');
  return c.request(ETL.compensate, { method: 'POST', body: { processId, batchId }, dryRun: false });
}

export async function publishEtl(c: RestCloudClient, processId: string): Promise<ApiResult> {
  assertEtlWriteAllowed('ETL 发布');
  return c.request(ETL.publish, { method: 'POST', body: { processId }, dryRun: false });
}
