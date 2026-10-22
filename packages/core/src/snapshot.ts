/**
 * 快照与回滚：写操作前的保护网
 * api  → 快照 /rest/core/services/{id}，回滚 POST /rest/core/services/save
 * esb  → 快照 /rest/esb/process/{id}，回滚 POST /rest/esb/process/model/save
 * etl  → 快照 /rest/etl/process/{id}，回滚 POST /rest/etl/process/model/save
 */
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { RestCloudClient, ApiResult } from './client.ts';
import { RcError } from './errors.ts';

/** 快照目录：默认 ~/.rc/snapshots，可用 RC_SNAPSHOT_DIR / RC_HOME 覆盖。 */
export function snapshotHome(dir?: string): string {
  const home = process.env.RC_HOME ?? join(homedir(), '.rc');
  return dir ?? process.env.RC_SNAPSHOT_DIR ?? join(home, 'snapshots');
}

export type EntityKind = 'api' | 'esb' | 'etl';

const DETAIL: Record<EntityKind, (id: string) => string> = {
  api: (id) => `/rest/core/services/${id}`,
  esb: (id) => `/rest/esb/process/${id}`,
  etl: (id) => `/rest/etl/process/${id}`,
};

export interface Snapshot {
  kind: EntityKind;
  id: string;
  capturedAt: string;
  data: unknown;
}

export async function snapshot(
  c: RestCloudClient,
  kind: EntityKind,
  id: string,
  dir?: string,
): Promise<{ file: string; snapshot: Snapshot }> {
  const r = await c.request(DETAIL[kind](id), { method: 'GET' });
  if (!r.ok) throw new RcError('E_SNAPSHOT', `快照失败：无法读取 ${kind}/${id}（${r.msg ?? r.httpStatus}）`, { traceId: r.traceId });
  const snap: Snapshot = { kind, id, capturedAt: new Date().toISOString(), data: r.data?.data ?? r.data };
  const target = snapshotHome(dir);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const file = join(target, `${kind}-${id}-${snap.capturedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify(snap, null, 1), { mode: 0o600 });
  // mode 只在"创建时"生效：同名文件已存在时旧权限会保留，这里显式收紧。
  try {
    await chmod(file, 0o600);
  } catch {
    /* 权限收紧失败不阻断快照写入 */
  }
  return { file, snapshot: snap };
}

/** 回滚：把快照重新写回平台 */
export async function restore(c: RestCloudClient, file: string): Promise<ApiResult> {
  const snap = JSON.parse(await readFile(file, 'utf8')) as Snapshot;
  const d = snap.data as any;
  if (snap.kind === 'api') {
    return c.request('/rest/core/services/save', { method: 'POST', body: d, dryRun: false });
  }
  if (snap.kind === 'esb' || snap.kind === 'etl') {
    const model = d?.processModel ?? d?.data?.processModel;
    if (!model) throw new RcError('E_SNAPSHOT', '快照中没有 processModel，无法回滚图模型');
    return c.request(`/rest/${snap.kind}/process/model/save`, {
      method: 'POST',
      body: { appId: d.appId, processId: snap.id, processModel: typeof model === 'string' ? model : JSON.stringify(model) },
      dryRun: false,
    });
  }
  throw new RcError('E_SNAPSHOT', `未知快照类型：${snap.kind}`);
}
