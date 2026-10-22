/**
 * dw 分区与滚动清理单测。
 * 两条安全约束必须钉死：**默认不动手**、**超过 max-drop 一律拒绝**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeRolloff,
  listPartitions,
  parseDorisSize,
  partitionOrderKey,
  planRolloff,
  qualify,
} from '../../packages/core/src/dw/partition.ts';
import { qr, stubTransport } from './dw-helpers.ts';

// ─────────────────────── 容量解析 ───────────────────────

test('parseDorisSize：**DataSize 是人读字符串**，直接 Number() 会静默变 undefined', () => {
  // 实测：单分区 4.108 GB 曾被判成"无 DataSize 列"，整条分桶体检因此失效
  assert.equal(parseDorisSize('4.108 GB'), 4.108 * 1024 ** 3);
  assert.equal(parseDorisSize('512.000 KB'), 512 * 1024);
  assert.equal(parseDorisSize('1.5 TB'), 1.5 * 1024 ** 4);
  assert.equal(parseDorisSize('2 MB'), 2 * 1024 ** 2);
  assert.equal(parseDorisSize('100'), 100);
  assert.equal(parseDorisSize(4096), 4096);
});

test('parseDorisSize：无法解析时返回 undefined，不猜', () => {
  assert.equal(parseDorisSize(''), undefined);
  assert.equal(parseDorisSize(undefined), undefined);
  assert.equal(parseDorisSize('N/A'), undefined);
  assert.equal(parseDorisSize('1 XB'), undefined);
  assert.equal(parseDorisSize(NaN), undefined);
  assert.equal(parseDorisSize('abc GB'), undefined);
});

test('parseDorisSize：单位大小写与复数都认', () => {
  assert.equal(parseDorisSize('1 gb'), 1024 ** 3);
  assert.equal(parseDorisSize('1 GBs'), 1024 ** 3);
});

// ─────────────────────── 标识符与排序键 ───────────────────────

test('qualify：一段名加反引号；两段名分别加；三段以上拒绝', () => {
  assert.equal(qualify('tbl'), '`tbl`');
  assert.equal(qualify('db.tbl'), '`db`.`tbl`');
  assert.throws(() => qualify('a.b.c'), /表名最多两段/);
});

test('partitionOrderKey：优先取名字里的日期数字段', () => {
  assert.equal(partitionOrderKey('p20260930'), '20260930');
  assert.equal(partitionOrderKey('2026-09-30'), '20260930');
  // 数字不够 6 位就退回原名，交给 warnings 提醒人工复核
  assert.equal(partitionOrderKey('p1'), 'p1');
});

// ─────────────────────── 列分区 ───────────────────────

test('listPartitions：列名按版本可选取，DataSize 走人读字符串解析', async () => {
  const { transport, calls } = stubTransport(() =>
    qr([
      { PartitionName: 'p20260930', PartitionId: '1', State: 'NORMAL', Buckets: '10', ReplicationNum: '3', DataSize: '4.108 GB', RowCount: '1000' },
      { PartitionName: 'p20261001' },
    ]),
  );
  const parts = await listPartitions(transport, 'db.tbl');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].dataSize, 4.108 * 1024 ** 3);
  assert.equal(parts[0].buckets, 10);
  assert.equal(parts[1].dataSize, undefined);
  assert.match(calls[0].sql, /^SHOW PARTITIONS FROM `db`\.`tbl`$/);
});

test('listPartitions：上游失败抛 E_UPSTREAM；没有名字的行被丢掉', async () => {
  const bad = stubTransport(() => 'nope').transport;
  await assert.rejects(() => listPartitions(bad, 'tbl'), /SHOW PARTITIONS 失败/);
  const { transport } = stubTransport(() => qr([{ Buckets: '1' }, { PartitionName: 'p' }]));
  assert.equal((await listPartitions(transport, 'tbl')).length, 1);
});

// ─────────────────────── 清理计划 ───────────────────────

/** 默认造**空分区**：这样"没有警告"才是干净基线，有数据的警告单独测。 */
const parts = (...names: string[]) =>
  names.map((name) => ({ name, dataSize: 0, rowCount: 0, buckets: 10 }));

test('planRolloff：按日期段降序保留最新 N 个，其余删除（最旧在前）', () => {
  const plan = planRolloff('db.tbl', parts('p20260901', 'p20260903', 'p20260902'), { keep: 2 });
  assert.deepEqual(plan.kept.map((k) => k.name), ['p20260903', 'p20260902']);
  assert.deepEqual(plan.drop.map((d) => d.name), ['p20260901']);
  assert.deepEqual(plan.statements, ['ALTER TABLE `db`.`tbl` DROP PARTITION `p20260901`']);
  assert.deepEqual(plan.warnings, []);
});

test('planRolloff：**无日期段的分区名按字典序排，并明确警告要人工复核**', () => {
  const plan = planRolloff('tbl', parts('pa', 'pb'), { keep: 1 });
  assert.equal(plan.warnings.some((w) => /没有可解析的日期段.*字典序/s.test(w)), true);
});

test('planRolloff：待删分区**有数据**时单独警告（删了不可恢复）', () => {
  const plan = planRolloff('tbl', [{ name: 'p20260101', dataSize: 5, rowCount: 9 }, { name: 'p20260201' }], { keep: 1 });
  assert.equal(plan.warnings.some((w) => /有数据.*不可恢复/s.test(w)), true);
  assert.equal(plan.drop[0].empty, false);
});

test('planRolloff：超过 max-drop 时警告并说明已阻断（大概率 --keep 写错了）', () => {
  const many = parts(...Array.from({ length: 15 }, (_, i) => `p2026${String(i + 1).padStart(2, '0')}01`));
  const plan = planRolloff('tbl', many, { keep: 1, maxDrop: 10 });
  assert.equal(plan.drop.length, 14);
  assert.equal(plan.warnings.some((w) => /超过 --max-drop 10/.test(w)), true);
});

test('planRolloff：keep 非正整数直接拒绝', () => {
  assert.throws(() => planRolloff('tbl', parts('p20260101'), { keep: 0 }), /--keep 需要是正整数/);
  assert.throws(() => planRolloff('tbl', parts('p20260101'), { keep: -1 }), /--keep 需要是正整数/);
  assert.throws(() => planRolloff('tbl', parts('p20260101'), { keep: 1.5 }), /--keep 需要是正整数/);
});

test('planRolloff：keep 大于分区总数时不删任何东西', () => {
  const plan = planRolloff('tbl', parts('p20260101'), { keep: 5 });
  assert.deepEqual(plan.drop, []);
  assert.deepEqual(plan.statements, []);
});

// ─────────────────────── 执行 ───────────────────────

test('executeRolloff：默认 dry-run，一条都不真发', async () => {
  const { transport, calls } = stubTransport(() => qr());
  const plan = planRolloff('tbl', parts('p20260901', 'p20260902'), { keep: 1 });
  await executeRolloff(transport, plan);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts?.dryRun, true);
});

test('executeRolloff：**超过 max-drop 一律拒绝**，不靠调用方自觉', async () => {
  const { transport, calls } = stubTransport(() => qr());
  const many = parts(...Array.from({ length: 5 }, (_, i) => `p20260${i + 1}01`));
  const plan = planRolloff('tbl', many, { keep: 1, maxDrop: 10 });
  await assert.rejects(
    () => executeRolloff(transport, plan, { apply: true, maxDrop: 2 }),
    (e: unknown) => {
      assert.equal((e as { code: string }).code, 'E_CONFIRM_REQUIRED');
      assert.match((e as Error).message, /复核 --keep 后显式放大 --max-drop/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('executeRolloff：--apply 且未超限时逐条执行', async () => {
  const { transport, calls } = stubTransport(() => qr());
  const plan = planRolloff('tbl', parts('p20260901', 'p20260902', 'p20260903'), { keep: 1 });
  const out = await executeRolloff(transport, plan, { apply: true });
  assert.equal(out.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts?.dryRun, false);
});
