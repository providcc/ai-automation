/**
 * 刷新相位分布与错峰。
 *
 * 为什么单独成模块：错峰不是"好看"，是**抢资源**。线上踩出来的三条：
 *   1. **「零间隔」比重叠更致命**：两张任务相位相隔不到一分钟，前一张还没落盘后一张就起，
 *      表现为随机 FAILED 且重试即过——比明显重叠更难归因。
 *   2. **相位只看时分秒**：swap 会把 STARTS 的日期改写成当天，日期不可信（见 swap.ts 第 3 条）。
 *   3. **依赖倒置要按图判**：下游相位早于上游，靠人眼扫表几乎必漏，必须拿依赖图对。
 */
import { parseMvSchedule } from './mv.ts';
import type { MvDependency } from './swap.ts';

export interface PhaseSlot {
  name: string;
  /** HH:MM:SS */
  timeOfDay: string;
  hour: number;
  minute: number;
  second: number;
  every?: number;
  unit?: string;
  build?: string;
  /** 该 MV 的刷新方式原文（判断 ON COMMIT / ON MANUAL） */
  refresh?: string;
}

/** 从 DDL 列表里抽相位。解析不出 STARTS 的（ON COMMIT / ON MANUAL）会被跳过并单独报出。 */
export function collectPhases(items: { name: string; ddl: string }[]): {
  slots: PhaseSlot[];
  unphased: { name: string; reason: string }[];
} {
  const slots: PhaseSlot[] = [];
  const unphased: { name: string; reason: string }[] = [];
  for (const it of items) {
    const s = parseMvSchedule(it.ddl);
    if (!s.starts) {
      unphased.push({ name: it.name, reason: s.onCommit ? 'ON COMMIT（无固定相位）' : s.onManual ? 'ON MANUAL（已冻结）' : '未解析到 STARTS' });
      continue;
    }
    const tod = s.starts.slice(11);
    const [h, m, sec] = tod.split(':').map((x) => Number(x));
    slots.push({
      name: it.name,
      timeOfDay: tod,
      hour: h,
      minute: m,
      second: sec,
      every: s.every,
      unit: s.unit,
      build: s.build,
      refresh: s.refresh,
    });
  }
  return { slots, unphased };
}

/** 一天内的分钟序号，便于算间隔。 */
function minuteOfDay(s: PhaseSlot): number {
  return s.hour * 60 + s.minute;
}

export interface StaggerFinding {
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  hint?: string;
}

export interface StaggerOptions {
  /** 依赖图；给了才做依赖倒置检查 */
  graph?: Map<string, MvDependency>;
  /** 同一分钟位超过几张算拥挤（默认 2） */
  crowdThreshold?: number;
  /** 间隔小于多少分钟算「同分钟位冲突」（默认 1，即只判同一分钟） */
  minGapMinutes?: number;
  /**
   * 各 MV 的**实测刷新耗时（秒）**，来自 `tasks('type'='mv')`。
   * 给了才做"前一张还没跑完后一张就起"的判定——这才是真正会 FAILED 的那种撞车。
   */
  durations?: Map<string, number>;
}

/**
 * 错峰体检。只对**同一调度周期**的相位互相比较——
 * 小时级和日级在同一分钟起跑并不冲突（日级一天只跑一次）。
 *
 * 两级判定，刻意分开：
 *   - `W_CROWDED_MINUTE` / `W_SAME_MINUTE`：纯相位问题，不需要额外证据。
 *   - `W_DURATION_OVERLAP`：**间隔 < 前一张的实测耗时**。这条才对应
 *     "前一张未落盘后一张就起 → 随机 FAILED、重试即过"。
 *     没有 durations 时不猜——按相位间隔硬报会把"1 分钟错峰"这种正常排布报成满屏告警
 *     （本库 75 张小时级分布在 60 个分钟位上，2 分钟间隔在数学上就做不到）。
 */
export function analyzeStagger(slots: PhaseSlot[], opts: StaggerOptions = {}): StaggerFinding[] {
  const out: StaggerFinding[] = [];
  const crowd = opts.crowdThreshold ?? 2;
  const minGap = opts.minGapMinutes ?? 1;

  const groups = new Map<string, PhaseSlot[]>();
  for (const s of slots) {
    const key = `${s.every ?? '?'}${s.unit ?? '?'}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }

  for (const [key, list] of groups) {
    const sorted = [...list].sort((a, b) => minuteOfDay(a) - minuteOfDay(b));
    // 同一分钟位拥挤
    const byMinute = new Map<number, PhaseSlot[]>();
    for (const s of sorted) {
      const k = minuteOfDay(s);
      byMinute.set(k, [...(byMinute.get(k) ?? []), s]);
    }
    for (const [minute, group] of byMinute) {
      if (group.length > crowd) {
        const tod = fmtTod(minute);
        out.push({
          level: 'warn',
          code: 'W_CROWDED_MINUTE',
          message: `${key} 组在 ${tod} 同时起跑 ${group.length} 张：${group.map((g) => g.name).join('、')}`,
          hint: '错峰的目标是让同一分钟位只有一张；把其中若干张按分钟级平移',
        });
      }
    }
    // 同分钟位冲突 / 间隔不足
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const gap = minuteOfDay(cur) - minuteOfDay(prev);
      if (gap === 0) {
        out.push({
          level: 'warn',
          code: 'W_SAME_MINUTE',
          message: `${key} 组：${prev.name} 与 ${cur.name} 同在 ${cur.timeOfDay} 起跑`,
          hint: '同一分钟起跑会争抢 BE 资源；按分钟级平移',
        });
        continue;
      }
      if (gap < minGap) continue;
      const durSec = opts.durations?.get(prev.name);
      if (durSec !== undefined && gap * 60 < durSec) {
        out.push({
          level: 'warn',
          code: 'W_DURATION_OVERLAP',
          message:
            `${key} 组：${prev.name}(${prev.timeOfDay}，实测耗时 ${durSec}s) → ` +
            `${cur.name}(${cur.timeOfDay}) 只隔 ${gap} 分钟，前一张还没跑完后一张就起`,
          hint: '「零间隔」比重叠更致命：表现为随机 FAILED 且重试即过；把下游后移到上游实测耗时之外',
        });
      }
    }
  }

  // 依赖倒置：下游相位早于上游
  const graph = opts.graph;
  if (graph) {
    const byName = new Map(slots.map((s) => [s.name, s]));
    const seen = new Set<string>();
    for (const s of slots) {
      for (const up of graph.get(s.name)?.reads ?? []) {
        const upSlot = byName.get(up);
        if (!upSlot) continue;
        // 只有同一周期才可比
        if (upSlot.every !== s.every || upSlot.unit !== s.unit) continue;
        const pair = `${up}->${s.name}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        if (minuteOfDay(s) < minuteOfDay(upSlot)) {
          // 上游是维表时降级为警告：维表虽然也高频刷新，但内容变化慢，
          // 差一个周期的维表滞后通常无害（本库 dim_* 全是这种）。
          // 上游是事实/汇总表（dwd_/dws_）才是真问题——下游会稳定读到上一周期的数据。
          const upstreamIsDim = /^dim_/i.test(up);
          out.push({
            level: upstreamIsDim ? 'warn' : 'error',
            code: 'E_DEPENDENCY_INVERSION',
            message:
              `依赖倒置：${s.name}(${s.timeOfDay}) 读 ${up}(${upSlot.timeOfDay})，下游比上游先跑` +
              (upstreamIsDim ? '（上游是维表，滞后通常无害）' : ''),
            hint: upstreamIsDim
              ? '维表变化慢，可接受；若该维表近期有高频变更，再考虑后移下游'
              : '下游永远读到上一周期的数据；把下游相位改到上游之后',
          });
        }
      }
    }
  }

  return out;
}

function fmtTod(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** 从 `tasks()` 结果里取各 MV 的实测最大耗时（秒）。 */
export function durationsFromTasks(tasks: { mvName: string; durationSec?: number; status?: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tasks) {
    if (t.durationSec === undefined) continue;
    if (t.status && !/SUCCESS/i.test(t.status)) continue;
    out.set(t.mvName, Math.max(out.get(t.mvName) ?? 0, t.durationSec));
  }
  return out;
}

/**
 * 给出重排建议：按当前分布，把同一分钟位的多余任务平移到最近的空位。
 * 只产出建议，不自动改——相位变更属于运维决策，必须人确认。
 */
export function suggestStagger(
  slots: PhaseSlot[],
  opts: { unit?: string; minGapMinutes?: number } = {},
): { name: string; from: string; to: string; reason: string }[] {
  const minGap = opts.minGapMinutes ?? 2;
  const target = slots.filter((s) => (opts.unit ? s.unit === opts.unit : true));
  const occupied = new Set(target.map(minuteOfDay));
  const out: { name: string; from: string; to: string; reason: string }[] = [];
  const used = new Set<number>();

  const groups = new Map<number, PhaseSlot[]>();
  for (const s of target) groups.set(minuteOfDay(s), [...(groups.get(minuteOfDay(s)) ?? []), s]);

  for (const [minute, group] of groups) {
    if (group.length <= 1) {
      used.add(minute);
      continue;
    }
    group.forEach((s, idx) => {
      if (idx === 0) {
        used.add(minute);
        return;
      }
      let candidate = minute;
      for (let step = 1; step <= 24 * 60; step++) {
        const probe = (minute + step) % (24 * 60);
        const clash = [...used, ...occupied].some((m) => Math.abs(m - probe) < minGap);
        if (!clash) {
          candidate = probe;
          break;
        }
      }
      used.add(candidate);
      const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
      out.push({
        name: s.name,
        from: s.timeOfDay,
        to: fmt(candidate),
        reason: `与 ${group[0].name} 同分钟位（${fmt(minute)}），平移后间隔 ≥ ${minGap} 分钟`,
      });
    });
  }
  return out;
}
