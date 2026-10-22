/**
 * ETL 补偿编排（v2 Phase 1.4）
 *
 * 平台契约（WAR 取证）：
 *   POST /rest/etl/process/compensate              body: { transactionId }
 *   GET  /rest/etl/process/compensate/list         补偿记录
 *   GET  /rest/etl/process/monitor/list/page       运行实例
 *   GET  /rest/etl/process/monitor/historyinfo     节点历史
 *
 * 关键修正：补偿的单位是 **transactionId（实例 id）**，不是 processId。
 * 本模块先 plan（只读）再 apply，且按依赖顺序串行执行。
 */
import type { RestCloudClient } from './client.ts';
import { unwrapRows } from './api.ts';
import { runBatch, type BatchReport } from './batch.ts';
import { assertEtlWriteAllowed } from './etl.ts';

export const ETL_COMP = {
  compensate: '/rest/etl/process/compensate',
  list: '/rest/etl/process/compensate/list',
  delete: '/rest/etl/process/compensate/delete',
  monitor: '/rest/etl/process/monitor/list/page',
  history: '/rest/etl/process/monitor/historyinfo',
} as const;

export interface EtlProcessNode {
  processId: string;
  processName?: string;
  configId?: string;
  parentProcessId?: string;
  categoryId?: string;
  state?: string;
  processModel?: string;
}

export interface EtlDependency {
  processId: string;
  processName?: string;
  dependsOn: string[];
  depth: number;
}

export interface CompensationItem {
  transactionId: string;
  processId?: string;
  processName?: string;
  state?: string;
  startTime?: string;
  endTime?: string;
  errorMsg?: string;
  /** 依赖深度：越小越先执行 */
  depth: number;
  raw?: unknown;
}

export interface CompensationPlan {
  ok: boolean;
  generatedAt: string;
  items: CompensationItem[];
  skipped: { transactionId: string; reason: string }[];
  warnings: string[];
}

export interface MonitorQuery {
  processId?: string;
  state?: string;
  pageNo?: number;
  pageSize?: number;
}

/** 拉取 ETL 流程（含 processModel，用于依赖分析） */
export async function listEtlProcesses(c: RestCloudClient, max = 500): Promise<EtlProcessNode[]> {
  const out: EtlProcessNode[] = [];
  for (let pageNo = 1; out.length < max; pageNo++) {
    const r = await c.request('/rest/etl/process/list', { method: 'GET', query: { pageNo, pageSize: 100 } });
    const rows = unwrapRows(r.data?.data ?? r.data);
    if (!rows.length) break;
    for (const x of rows) {
      out.push({
        processId: String(x.processId ?? x.id ?? ''),
        processName: x.processName ?? x.configName,
        configId: x.configId,
        parentProcessId: x.parentProcessId || undefined,
        categoryId: x.categoryId,
        state: x.state,
        processModel: typeof x.processModel === 'string' ? x.processModel : undefined,
      });
      if (out.length >= max) break;
    }
    // total 与 rows 可能同层，也可能在 data 里（平台两种形态都出现过）
    const payload: any = r.data?.data ?? r.data;
    const total = Number(payload?.total ?? (r.data as any)?.total ?? 0);
    if (total && out.length >= total) break;
    if (rows.length < 100) break;
  }
  return out.filter((x) => x.processId);
}

/**
 * 依赖图：优先 parentProcessId；其次同分类下按流程编码前缀排序（稳定兜底）。
 * 不做"猜测式"依赖——没有明确父子关系时依赖为空。
 */
export function buildEtlDependencies(processes: EtlProcessNode[]): EtlDependency[] {
  const byId = new Map(processes.map((p) => [p.processId, p]));
  const deps = processes.map((p) => ({
    processId: p.processId,
    processName: p.processName,
    dependsOn: [] as string[],
    depth: 0,
  }));
  const depMap = new Map(deps.map((d) => [d.processId, d]));
  for (const p of processes) {
    if (p.parentProcessId && byId.has(p.parentProcessId)) {
      const d = depMap.get(p.processId)!;
      d.dependsOn.push(p.parentProcessId);
    }
  }
  // 计算深度（防环：最多 N 轮）
  for (let round = 0; round < processes.length; round++) {
    let changed = false;
    for (const d of depMap.values()) {
      for (const parent of d.dependsOn) {
        const pd = depMap.get(parent);
        if (pd && d.depth <= pd.depth) {
          d.depth = pd.depth + 1;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return [...depMap.values()];
}

/** 查询运行实例（只读） */
export async function listEtlInstances(c: RestCloudClient, query: MonitorQuery = {}): Promise<any[]> {
  const r = await c.request(ETL_COMP.monitor, {
    method: 'GET',
    query: {
      pageNo: query.pageNo ?? 1,
      pageSize: query.pageSize ?? 100,
      processId: query.processId,
      state: query.state,
    },
  });
  return unwrapRows(r.data?.data ?? r.data);
}

/** 补偿记录（只读） */
export async function listCompensations(c: RestCloudClient, opts: { pageNo?: number; pageSize?: number } = {}): Promise<any[]> {
  const r = await c.request(ETL_COMP.list, { method: 'GET', query: { pageNo: opts.pageNo ?? 1, pageSize: opts.pageSize ?? 100 } });
  return unwrapRows(r.data?.data ?? r.data);
}

/**
 * 生成补偿计划。
 * 输入优先级：显式 transactionIds > 按 processId/state 查询到失败实例。
 */
export async function planCompensation(
  c: RestCloudClient,
  opts: { transactionIds?: string[]; processId?: string; state?: string; pageSize?: number; max?: number } = {},
): Promise<CompensationPlan> {
  const warnings: string[] = [];
  const skipped: { transactionId: string; reason: string }[] = [];
  const processes = await listEtlProcesses(c);
  const deps = buildEtlDependencies(processes);
  const depthOf = new Map(deps.map((d) => [d.processId, d.depth]));
  const nameOf = new Map(processes.map((p) => [p.processId, p.processName]));
  let rows: any[] = [];
  if (opts.transactionIds?.length) {
    rows = opts.transactionIds.map((id) => ({ transactionId: id }));
  } else {
    rows = await listEtlInstances(c, { processId: opts.processId, state: opts.state ?? 'FAIL', pageSize: opts.pageSize ?? 100 });
    if (!rows.length) warnings.push('未查询到失败实例：确认 state 过滤值（平台常见值：FAIL/ERROR/失败），或直接传 --transaction');
  }
  const max = opts.max ?? 200;
  const seen = new Set<string>();
  const items: CompensationItem[] = [];
  for (const row of rows) {
    const tid = String(row.transactionId ?? row.id ?? row.instanceId ?? '');
    if (!tid) {
      skipped.push({ transactionId: '', reason: '记录缺少 transactionId' });
      continue;
    }
    if (seen.has(tid)) {
      skipped.push({ transactionId: tid, reason: '重复实例' });
      continue;
    }
    seen.add(tid);
    const pid = row.processId ? String(row.processId) : opts.processId;
    const state = row.state ?? row.status;
    if (state && /SUCCESS|SUCCEED|成功/i.test(String(state))) {
      skipped.push({ transactionId: tid, reason: `状态为 ${state}，无需补偿` });
      continue;
    }
    items.push({
      transactionId: tid,
      processId: pid,
      processName: pid ? nameOf.get(pid) : undefined,
      state: state ? String(state) : undefined,
      startTime: row.startTime ?? row.createTime,
      endTime: row.endTime,
      errorMsg: row.errorMsg ?? row.msg,
      depth: pid ? depthOf.get(pid) ?? 0 : 0,
      raw: row,
    });
    if (items.length >= max) {
      warnings.push(`达到上限 ${max}，其余实例未纳入计划`);
      break;
    }
  }
  items.sort((a, b) => a.depth - b.depth || String(a.startTime ?? '').localeCompare(String(b.startTime ?? '')));
  return { ok: items.length > 0, generatedAt: new Date().toISOString(), items, skipped, warnings };
}

export interface CompensationResult {
  plan: CompensationPlan;
  report?: BatchReport;
  dryRun: boolean;
}

/**
 * 执行补偿计划。默认 dry-run；apply 时串行（concurrency=1），失败即停。
 */
export async function executeCompensation(
  c: RestCloudClient,
  plan: CompensationPlan,
  opts: { apply?: boolean; dryRun?: boolean; retry?: number } = {},
): Promise<CompensationResult> {
  const dryRun = opts.dryRun ?? !opts.apply;
  if (dryRun) return { plan, dryRun: true };
  // ETL 补偿写路径默认封禁（未开通 ETL 能力的环境不执行）。
  assertEtlWriteAllowed('ETL 补偿');
  if (!plan.items.length) return { plan, dryRun: false, report: undefined };
  const report = await runBatch(
    plan.items.map((x) => ({ id: x.transactionId, action: 'etl.compensate', item: x })),
    async (item) => {
      const x = item.item as CompensationItem;
      const r = await c.request(ETL_COMP.compensate, { method: 'POST', body: { transactionId: x.transactionId }, dryRun: false });
      return { ok: r.ok, error: r.msg, result: r.data };
    },
    { concurrency: 1, retry: opts.retry ?? 0, stopOnError: true },
  );
  return { plan, report, dryRun: false };
}

export function formatCompensationPlan(plan: CompensationPlan): string {
  const lines = [`补偿计划：${plan.items.length} 个实例（${plan.generatedAt}）`];
  for (const x of plan.items) {
    lines.push(`  ${x.transactionId}  ${x.processName ?? x.processId ?? '-'}  depth=${x.depth}  state=${x.state ?? '-'}${x.errorMsg ? `  ${x.errorMsg}` : ''}`);
  }
  for (const s of plan.skipped) lines.push(`  - 跳过 ${s.transactionId || '(空)'}：${s.reason}`);
  for (const w of plan.warnings) lines.push(`  ! ${w}`);
  return lines.join('\n');
}
