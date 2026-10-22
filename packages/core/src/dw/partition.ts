/**
 * 分区清单与滚动清理（对齐数仓脚本里的 `rolloff-partitions.sh`）。
 *
 * 这里只做"通用能力"：列出分区、按保留数算出该删哪些、生成 `ALTER TABLE ... DROP PARTITION`。
 * **保留策略来自命令行，不来自代码**——哪个表留多少期是运维决策，
 * 写死在工具里，换个表就会删错东西。
 *
 * 两条安全约束（踩过的都是这两类）：
 *   1. **空分区不占空间但要占元数据**：`DROP PARTITION` 会真的删数据，
 *      所以计划里把"该分区是否有数据"一并报出来，让人看清删的是空的还是有数的。
 *   2. **默认不动手**：dry-run 是默认；`--apply` 之外还要过 `--max-drop` 闸门，
 *      一次删掉超过上限说明 `--keep` 大概率写错了，直接拒。
 */
import type { WarehouseTransport } from './transport.ts';
import { quoteIdent, runWrite, type WriteOutcome } from './mv.ts';
import { RcError } from '../errors.ts';

export interface PartitionInfo {
  name: string;
  id?: string;
  state?: string;
  /** 分区键范围原文，如 [types: [DATE]; keys: [2026-09-01]; ...) */
  range?: string;
  buckets?: number;
  replicationNum?: number;
  dataSize?: number;
  rowCount?: number;
}

function pick(row: Record<string, unknown>, key: string): unknown {
  const hit = Object.keys(row).find((k) => k.toLowerCase() === key.toLowerCase());
  return hit ? row[hit] : undefined;
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
  PB: 1024 ** 5,
};

/**
 * 解析 Doris 的容量字段。
 * **`DataSize` 回的是人读字符串**（`"4.108 GB"` / `"512.000 KB"`），不是数字——
 * 直接 `Number()` 会得到 NaN 并静默变成 undefined，于是"桶太小/太大"的判断全部失效
 * （实测踩到：单分区 4.1GB 被判成"无 DataSize 列"）。
 */
export function parseDorisSize(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  const m = /^([\d.]+)\s*([A-Za-z]+)?$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] ?? 'B').toUpperCase();
  const mult = SIZE_UNITS[unit] ?? SIZE_UNITS[unit.replace(/S$/, '')];
  return mult === undefined ? undefined : n * mult;
}

/** 容量字段回显：`4.108 GB` 这类字符串原样保留，数字则换算。 */
function sizeOf(v: unknown): number | undefined {
  return parseDorisSize(v);
}

/** 列分区。列名按版本差异逐列可选取。 */
export async function listPartitions(
  transport: WarehouseTransport,
  table: string,
  opts: { timeoutMs?: number } = {},
): Promise<PartitionInfo[]> {
  const res = await transport.run(`SHOW PARTITIONS FROM ${qualify(table)}`, {
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  if (!res.ok) throw new RcError('E_UPSTREAM', `SHOW PARTITIONS 失败：${res.msg ?? res.code}`);
  return res.rows
    .map((row) => ({
      name: String(pick(row, 'PartitionName') ?? ''),
      id: pick(row, 'PartitionId') === undefined ? undefined : String(pick(row, 'PartitionId')),
      state: pick(row, 'State') as string | undefined,
      range: pick(row, 'Range') as string | undefined,
      buckets: num(pick(row, 'Buckets')),
      replicationNum: num(pick(row, 'ReplicationNum')),
      dataSize: sizeOf(pick(row, 'DataSize')),
      rowCount: num(pick(row, 'RowCount')),
    }))
    .filter((p) => p.name);
}

/** 表名允许 `db.table`；单段名直接加反引号（库上下文由连接默认库决定）。 */
export function qualify(table: string): string {
  const parts = String(table).split('.');
  if (parts.length > 2) throw new RcError('E_VALIDATION', `表名最多两段（db.table）：${table}`);
  return parts.map(quoteIdent).join('.');
}

/** 分区名的自然排序键：优先取名字里的日期数字段（p20260930 / 2026-09-30）。 */
export function partitionOrderKey(name: string): string {
  const digits = String(name).replace(/\D/g, '');
  return digits.length >= 6 ? digits : String(name);
}

export interface RolloffPlanEntry {
  name: string;
  dataSize?: number;
  rowCount?: number;
  /** 该分区是否为空（空分区删了省元数据，不省空间） */
  empty?: boolean;
}

export interface RolloffPlan {
  table: string;
  keep: number;
  total: number;
  /** 保留（最新的 keep 个） */
  kept: RolloffPlanEntry[];
  /** 计划删除 */
  drop: RolloffPlanEntry[];
  /** 删除语句，按最旧在前 */
  statements: string[];
  warnings: string[];
}

/**
 * 生成滚动清理计划：按分区名的日期段降序，保留最新 keep 个，其余删除。
 * 无日期段可解析时按名字字典序——并在 warnings 里明确说明，让人复核。
 */
export function planRolloff(
  table: string,
  partitions: PartitionInfo[],
  opts: { keep: number; maxDrop?: number },
): RolloffPlan {
  const keep = Math.max(0, Number(opts.keep));
  if (!Number.isInteger(keep) || keep <= 0) {
    throw new RcError('E_VALIDATION', `--keep 需要是正整数，收到 ${opts.keep}`);
  }
  const warnings: string[] = [];
  const undated = partitions.filter((p) => partitionOrderKey(p.name).length < 6);
  if (undated.length) {
    warnings.push(
      `${undated.length} 个分区名里没有可解析的日期段（${undated.map((p) => p.name).join('、')}），` +
        '按字典序参与排序——务必人工复核后再执行。',
    );
  }

  const sorted = [...partitions].sort((a, b) => (partitionOrderKey(a.name) < partitionOrderKey(b.name) ? 1 : -1));
  const kept = sorted.slice(0, keep);
  const drop = sorted.slice(keep);
  const toEntry = (p: PartitionInfo): RolloffPlanEntry => ({
    name: p.name,
    dataSize: p.dataSize,
    rowCount: p.rowCount,
    empty: (p.dataSize ?? 0) === 0 && (p.rowCount ?? 0) === 0,
  });

  const maxDrop = opts.maxDrop ?? 10;
  if (drop.length > maxDrop) {
    warnings.push(
      `本次将删除 ${drop.length} 个分区，超过 --max-drop ${maxDrop}：` +
        '大概率是 --keep 写错了，已阻断。确认无误请显式放大 --max-drop。',
    );
  }
  const withData = drop.filter((d) => !toEntry(d).empty);
  if (withData.length) {
    warnings.push(`${withData.length} 个待删分区**有数据**（非空），删除后不可恢复：${withData.map((d) => d.name).join('、')}`);
  }

  return {
    table,
    keep,
    total: partitions.length,
    kept: kept.map(toEntry),
    drop: drop.map(toEntry),
    statements: drop.map((p) => `ALTER TABLE ${qualify(table)} DROP PARTITION ${quoteIdent(p.name)}`),
    warnings,
  };
}

/** 执行清理（dry-run 默认）。超过 maxDrop 一律拒绝，不靠调用方自觉。 */
export async function executeRolloff(
  transport: WarehouseTransport,
  plan: RolloffPlan,
  opts: { apply?: boolean; maxDrop?: number; timeoutMs?: number; readonly?: boolean } = {},
): Promise<WriteOutcome[]> {
  const maxDrop = opts.maxDrop ?? 10;
  if (plan.drop.length > maxDrop) {
    throw new RcError(
      'E_CONFIRM_REQUIRED',
      `计划删除 ${plan.drop.length} 个分区，超过 --max-drop ${maxDrop}；请复核 --keep 后显式放大 --max-drop。`,
    );
  }
  const out: WriteOutcome[] = [];
  for (const sql of plan.statements) {
    out.push(await runWrite(transport, sql, opts));
  }
  return out;
}
