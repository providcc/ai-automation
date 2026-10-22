/**
 * 分桶与副本体检。
 *
 * 判定口径来自 doris-best-practices 的 `schema-bucket-target-size`：
 * **每个 tablet 目标 1–10 GB**。太小 → 元数据与 compaction 压力；太大 → 并行度不够、单 tablet 修复慢。
 * 所以这里算的不是"桶数对不对"，而是"**每桶实际多大**"——桶数是手段，桶大小才是目标。
 *
 * 副本分布看 `ADMIN SHOW REPLICA DISTRIBUTION`：同一张表的副本在各 BE 上明显不均，
 * 就是分桶键倾斜，得换复合分桶键（`schema-bucket-composite-for-skew`）。
 */
import type { WarehouseTransport } from './transport.ts';
import { listPartitions, parseDorisSize, qualify, type PartitionInfo } from './partition.ts';
import { RcError } from '../errors.ts';

const GB = 1024 ** 3;

function pick(row: Record<string, unknown>, key: string): unknown {
  const hit = Object.keys(row).find((k) => k.toLowerCase() === key.toLowerCase());
  return hit ? row[hit] : undefined;
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export interface TabletRow {
  tabletId?: string;
  replicaId?: string;
  backendId?: string;
  partitionName?: string;
  state?: string;
  version?: string;
  dataSize?: number;
  rowCount?: number;
}

/** 列 tablet（`SHOW TABLETS FROM`）。可选按分区过滤。 */
export async function listTablets(
  transport: WarehouseTransport,
  table: string,
  opts: { partition?: string; limit?: number; timeoutMs?: number } = {},
): Promise<TabletRow[]> {
  const res = await transport.run(`SHOW TABLETS FROM ${qualify(table)}`, {
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
  if (!res.ok) throw new RcError('E_UPSTREAM', `SHOW TABLETS 失败：${res.msg ?? res.code}`);
  const rows = res.rows.map((row) => ({
    tabletId: pick(row, 'TabletId') === undefined ? undefined : String(pick(row, 'TabletId')),
    replicaId: pick(row, 'ReplicaId') === undefined ? undefined : String(pick(row, 'ReplicaId')),
    backendId: pick(row, 'BackendId') === undefined ? undefined : String(pick(row, 'BackendId')),
    partitionName: pick(row, 'PartitionName') as string | undefined,
    state: pick(row, 'State') as string | undefined,
    version: pick(row, 'Version') === undefined ? undefined : String(pick(row, 'Version')),
    dataSize: parseDorisSize(pick(row, 'DataSize')),
    rowCount: num(pick(row, 'RowCount')),
  }));
  const filtered = opts.partition ? rows.filter((r) => r.partitionName === opts.partition) : rows;
  return opts.limit ? filtered.slice(0, opts.limit) : filtered;
}

/** 副本在各 BE 的分布。 */
export async function replicaDistribution(
  transport: WarehouseTransport,
  table: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ backendId: string; replicaNum: number }[]> {
  const res = await transport.run(`ADMIN SHOW REPLICA DISTRIBUTION FROM ${qualify(table)}`, {
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  if (!res.ok) throw new RcError('E_UPSTREAM', `ADMIN SHOW REPLICA DISTRIBUTION 失败：${res.msg ?? res.code}`);
  return res.rows
    .map((row) => ({
      backendId: String(pick(row, 'BackendId') ?? ''),
      replicaNum: num(pick(row, 'ReplicaNum')) ?? 0,
    }))
    .filter((r) => r.backendId);
}

export interface BucketAdvice {
  table: string;
  partitions: number;
  /** 每分区的桶数（取各分区众数/最小值——分区桶数应一致） */
  bucketsPerPartition?: number;
  totalSizeGb: number;
  /** 每个 tablet 的平均大小（GB） */
  avgTabletGb?: number;
  largestPartitionGb?: number;
  verdict: 'ok' | 'too-small' | 'too-large' | 'unknown';
  message: string;
  hint?: string;
  /** 与结论并列的旁注（如各分区桶数不一致），不会被结论覆盖 */
  notes?: string[];
}

/**
 * 分桶体检。桶数从分区的 `Buckets` 列取（比解析 DDL 更可靠，DDL 里可能写的是自动分桶）。
 * 只对**最新分区**给建议——历史分区大小不代表当前写入量。
 */
export async function analyzeBuckets(
  transport: WarehouseTransport,
  table: string,
  opts: { targetGbMin?: number; targetGbMax?: number; timeoutMs?: number } = {},
): Promise<{ advice: BucketAdvice; partitions: PartitionInfo[] }> {
  const min = opts.targetGbMin ?? 1;
  const max = opts.targetGbMax ?? 10;
  const partitions = await listPartitions(transport, table, opts);
  const sized = partitions.filter((p) => p.dataSize !== undefined);
  const totalBytes = sized.reduce((s, p) => s + (p.dataSize ?? 0), 0);
  const totalSizeGb = totalBytes / GB;
  const buckets = [...new Set(partitions.map((p) => p.buckets).filter((b): b is number => typeof b === 'number'))];
  const bucketsPerPartition = buckets.length ? buckets[0] : undefined;

  const sortedBySize = [...sized].sort((a, b) => (b.dataSize ?? 0) - (a.dataSize ?? 0));
  const largest = sortedBySize[0];
  const largestPartitionGb = largest ? (largest.dataSize ?? 0) / GB : undefined;

  const advice: BucketAdvice = {
    table,
    partitions: partitions.length,
    bucketsPerPartition,
    totalSizeGb: Number(totalSizeGb.toFixed(3)),
    largestPartitionGb: largestPartitionGb === undefined ? undefined : Number(largestPartitionGb.toFixed(3)),
    verdict: 'unknown',
    message: '',
  };
  if (buckets.length > 1) {
    advice.notes = [`各分区桶数不一致（${buckets.join('/')}）——分区桶数应当一致，取 ${bucketsPerPartition} 计算`];
  }

  // 先判 DataSize 再判 Buckets：没有桶数时 avgTabletGb 也必然是 undefined，
  // 顺序反了会让"缺桶数"永远被报成"缺 DataSize"。
  if (largestPartitionGb === undefined) {
    advice.message = '分区未返回可解析的 DataSize，无法判定桶大小';
    advice.hint = 'Doris 的 DataSize 是人读字符串（如 "4.108 GB"）；若版本回空值就只能逐 tablet 看，用 dw tablet --detail';
    return { advice, partitions };
  }
  if (!bucketsPerPartition) {
    advice.message = `分区未返回 Buckets（最大分区 ${advice.largestPartitionGb}GB），无法算每 tablet 大小`;
    advice.hint = '用 SHOW CREATE TABLE 看分桶方式，或 dw tablet --detail 逐 tablet 看 DataSize';
    return { advice, partitions };
  }
  const avgTabletGb = largestPartitionGb / bucketsPerPartition;
  advice.avgTabletGb = Number(avgTabletGb.toFixed(3));

  if (avgTabletGb < min) {
    advice.verdict = 'too-small';
    advice.message = `最新分区每 tablet 约 ${advice.avgTabletGb} GB，低于目标下限 ${min} GB`;
    advice.hint = `桶数偏多：建议按「分区大小 / ${min} GB」重算，或改用复合分桶键拉开数据量`;
  } else if (avgTabletGb > max) {
    advice.verdict = 'too-large';
    advice.message = `最新分区每 tablet 约 ${advice.avgTabletGb} GB，高于目标上限 ${max} GB`;
    advice.hint = '桶数偏少：并行度不够、单 tablet 修复慢，建议按「分区大小 / 5 GB」上调桶数';
  } else {
    advice.verdict = 'ok';
    advice.message = `最新分区每 tablet 约 ${advice.avgTabletGb} GB，落在 ${min}–${max} GB 目标区间`;
  }
  return { advice, partitions };
}

/** 副本倾斜：各 BE 的副本数差异超过阈值即报警。 */
export function analyzeReplicaSkew(
  dist: { backendId: string; replicaNum: number }[],
  opts: { tolerance?: number } = {},
): { balanced: boolean; message: string } {
  if (dist.length <= 1) return { balanced: true, message: `只有 ${dist.length} 个 BE 持有副本` };
  const tol = opts.tolerance ?? 0.2;
  const counts = dist.map((d) => d.replicaNum);
  const avg = counts.reduce((s, c) => s + c, 0) / counts.length;
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  const skew = avg === 0 ? 0 : (max - min) / avg;
  const worst = dist.reduce((a, b) => (b.replicaNum > a.replicaNum ? b : a));
  const best = dist.reduce((a, b) => (b.replicaNum < a.replicaNum ? b : a));
  return {
    balanced: skew <= tol,
    message:
      skew <= tol
        ? `副本分布均衡（${min}–${max}，均值 ${avg.toFixed(0)}）`
        : `副本分布不均：BE ${worst.backendId} 有 ${max} 个、BE ${best.backendId} 只有 ${min} 个（偏离 ${(skew * 100).toFixed(0)}%）`,
  };
}
