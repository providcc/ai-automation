/**
 * 刷新方式诊断：判定"分区 MTMV 的增量退化成了全量"。
 *
 * 这是 `tasks('type'='mv')` 里 `RefreshMode` / `NeedRefreshPartitions` 两列的直接用途——
 * **不需要猜，也不需要读源码**：
 *
 *   - `RefreshMode=PARTIAL` 且 `NeedRefreshPartitions` 只有几条 → 增量正常；
 *   - `RefreshMode=COMPLETE` → 走了全量。若 `NeedRefreshPartitions` 条数 ≈ 全部分区数，
 *     就是"脏集 == 全分区数"，FE 因此判定只能全刷。
 *
 * 根因（读 MTMVPartitionUtil 源码 + 最小装置实测确认，2026-09-17）：
 * 分区 MTMV 的脏判定有两条腿——①驱动表对应**分区**的版本快照；
 * ②**非 excluded 的其他基表按整表版本**比对。所以只要有一张高频写入的分区基表
 * 不在 `excluded_trigger_tables` 里，整表版本被 bump 就会让全部 MV 分区判脏。
 *
 * **反直觉、必须写下来的一条**：把非驱动表也改成分区表**没用**。
 * 实测两张表同按同一列日分区，只往非驱动表的某个分区写一行，结果仍是
 * `COMPLETE` / 全分区——非驱动表无论自己分不分区都走整表版本比对。
 */
import type { MvTask } from './mv.ts';

export interface MvRefreshSummary {
  mvName: string;
  /** 时间窗内的任务总数 */
  runs: number;
  /** 按刷新方式计数（COMPLETE / PARTIAL / NOT_REFRESH / 其它原文） */
  byMode: Record<string, number>;
  failedRuns: number;
  fullRuns: number;
  partialRuns: number;
  /** `NOT_REFRESH` = 没有分区判脏、什么都没做——**这是正常行为，不是降级** */
  notRefreshRuns: number;
  /** 增量时脏分区数（取各轮最大值——一次爆掉就说明问题） */
  maxNeedPartitions: number;
  /** 全量时的已完成分区数（用于对比"脏集是否等于全分区数"） */
  maxCompletedPartitions: number;
  avgDurationSec?: number;
  maxDurationSec?: number;
  verdict: 'healthy' | 'intermittent' | 'degraded' | 'failing' | 'not-applicable' | 'unknown';
  message: string;
  hint?: string;
}

const MODE_COMPLETE = /^COMPLETE$/i;
const MODE_PARTIAL = /^PARTIAL$/i;
const MODE_NOT_REFRESH = /^NOT_REFRESH$/i;

export interface RefreshModeOptions {
  /**
   * 各 MV 的分区类型（来自 `mv_infos` 的 `MvPartitionInfo`）。
   * 给了就**只对 `EXPR` 判定降级**——只有分区级增量的 MV 才谈得上"退化"，
   * `SELF_MANAGE` / `FOLLOW_BASE_TABLE` 本来就走全量，报出来全是噪音。
   * 表里没有的 MV 一律视为 `not-applicable`：`tasks()` 是**全集群**的，
   * 而 `mv_infos` 是**按库**的，不在表里通常意味着它属于别的库。
   */
  partitionType?: Map<string, string | undefined>;
}

/**
 * 汇总每个 MV 的刷新方式分布，并判定是否退化。
 * 默认只返回**需要关注的**（`healthy` / `not-applicable` 由调用方决定是否展示）。
 */
export function analyzeRefreshMode(tasks: MvTask[], opts: RefreshModeOptions = {}): MvRefreshSummary[] {
  const groups = new Map<string, MvTask[]>();
  for (const t of tasks) {
    if (!t.mvName) continue;
    groups.set(t.mvName, [...(groups.get(t.mvName) ?? []), t]);
  }

  const out: MvRefreshSummary[] = [];
  for (const [mvName, list] of groups) {
    const byMode: Record<string, number> = {};
    for (const t of list) {
      const mode = t.refreshMode ?? '(未回)';
      byMode[mode] = (byMode[mode] ?? 0) + 1;
    }
    const failedRuns = list.filter((t) => t.status && !/SUCCESS/i.test(t.status)).length;
    const fullRuns = list.filter((t) => MODE_COMPLETE.test(t.refreshMode ?? '')).length;
    const partialRuns = list.filter((t) => MODE_PARTIAL.test(t.refreshMode ?? '')).length;
    const notRefreshRuns = list.filter((t) => MODE_NOT_REFRESH.test(t.refreshMode ?? '')).length;
    const needCounts = list.map((t) => t.needRefreshPartitions?.length ?? 0);
    const doneCounts = list.map((t) => t.completedPartitions?.length ?? 0);
    const durations = list.map((t) => t.durationSec).filter((d): d is number => d !== undefined);

    const s: MvRefreshSummary = {
      mvName,
      runs: list.length,
      byMode,
      failedRuns,
      fullRuns,
      partialRuns,
      notRefreshRuns,
      maxNeedPartitions: needCounts.length ? Math.max(...needCounts) : 0,
      maxCompletedPartitions: doneCounts.length ? Math.max(...doneCounts) : 0,
      avgDurationSec: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : undefined,
      maxDurationSec: durations.length ? Math.max(...durations) : undefined,
      verdict: 'unknown',
      message: '',
    };

    // 范围判定放**最前**：给了分区类型表就说明调用方只关心这个库的 EXPR MV，
    // 范围外的（别的库、非 EXPR）连失败都不该在这个命令里报出来。
    if (opts.partitionType && opts.partitionType.get(mvName) !== 'EXPR') {
      const t = opts.partitionType.get(mvName);
      s.verdict = 'not-applicable';
      s.message =
        t === undefined
          ? '不在当前库的 mv_infos 清单里（tasks() 是全集群的，它多半属于别的库）'
          : `分区类型 ${t}：本来就没有分区级增量，走全量是正常的`;
    } else if (failedRuns) {
      s.verdict = 'failing';
      s.message = `${failedRuns}/${list.length} 轮失败`;
      s.hint = '先看失败原因：dw mv tasks --mv <mv> 里的 ErrorMsg；类型不匹配类问题见 dw mv lint 的 W_DECIMAL_DIVISION';
    } else if (fullRuns && !partialRuns && s.maxCompletedPartitions <= 1) {
      // 只有一个分区时，脏集必然等于全分区数 → FE 只能全刷。这是定义使然，不是退化。
      s.verdict = 'not-applicable';
      s.message = `${fullRuns} 轮走全量，但该 MV 只有 ${s.maxCompletedPartitions} 个分区：脏集必然等于全分区数，谈不上增量`;
    } else if (fullRuns && !partialRuns) {
      s.verdict = 'degraded';
      s.message = `${fullRuns}/${list.length} 轮走全量（COMPLETE），一次增量都没有`;
      s.hint = degradedHint(s);
    } else if (fullRuns && partialRuns) {
      s.verdict = 'intermittent';
      s.message = `${fullRuns} 轮全量 / ${partialRuns} 轮增量，间歇性降级`;
      s.hint = degradedHint(s);
    } else if (partialRuns) {
      s.verdict = 'healthy';
      s.message = `${partialRuns} 轮增量，脏分区最多 ${s.maxNeedPartitions} 个`;
    } else {
      s.verdict = 'unknown';
      s.message = `没有 COMPLETE/PARTIAL 记录（${notRefreshRuns} 轮 NOT_REFRESH：没有分区判脏，什么都没做）`;
    }
    out.push(s);
  }
  return out.sort((a, b) => rank(a.verdict) - rank(b.verdict) || b.maxNeedPartitions - a.maxNeedPartitions);
}

function rank(v: MvRefreshSummary['verdict']): number {
  return { failing: 0, degraded: 1, intermittent: 2, unknown: 3, healthy: 4, 'not-applicable': 5 }[v];
}

function degradedHint(s: MvRefreshSummary): string {
  const ratio =
    s.maxCompletedPartitions > 0 && s.maxNeedPartitions >= s.maxCompletedPartitions
      ? `脏分区数（${s.maxNeedPartitions}）已接近/等于全分区数（${s.maxCompletedPartitions}）——脏集 == 全分区数，FE 只能全刷`
      : '脏分区数远超预期时同理：脏集一旦等于全分区数，FE 就只能全刷';
  return (
    `${ratio}。根因：分区 MTMV 的脏判定里，**非 excluded 的 join 基表按整表版本比对**，` +
    '一张每小时写入的基表即可否决所有分区的增量资格。' +
    '处置：① 用 information_schema.partitions 查各基表分区的 UPDATE_TIME，找出每小时被 bump 的那张；' +
    '② ALTER MATERIALIZED VIEW <mv> SET ("excluded_trigger_tables"=...) 把它摘出去——' +
    '**副作用必查**：摘掉的基表真变了（如改名、改负责人）不会触发重刷，老分区的属性列会陈旧；' +
    '③ MV 属性变更会清空脏账本，改后首轮预期仍是 COMPLETE，别据此判定没生效。' +
    '注意：把非驱动表也改成分区表**没有用**（已实测证伪）——非驱动表无论分不分区都走整表版本比对。'
  );
}
