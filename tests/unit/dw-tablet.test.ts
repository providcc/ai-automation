/**
 * dw 分桶与副本体检单测。
 * 判定口径来自 doris-best-practices：**每 tablet 目标 1–10 GB**——桶数是手段，桶大小才是目标。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeBuckets,
  analyzeReplicaSkew,
  listTablets,
  replicaDistribution,
} from '../../packages/core/src/dw/tablet.ts';
import { bySql, qr, stubTransport } from './dw-helpers.ts';

const GB = 1024 ** 3;
/** 造一个「分区大小 + 桶数」的 SHOW PARTITIONS 响应。 */
const partRows = (sizeGb: number, buckets = 10, name = 'p20260930') => [
  { PartitionName: name, Buckets: String(buckets), ReplicationNum: '3', DataSize: `${sizeGb} GB`, RowCount: '1000' },
];

// ─────────────────────── tablet 明细 ───────────────────────

test('listTablets：列名按版本取；DataSize 走人读字符串解析', async () => {
  const { transport, calls } = stubTransport(() =>
    qr([
      { TabletId: '1', ReplicaId: '10', BackendId: '10005', PartitionName: 'p1', State: 'NORMAL', Version: '2', DataSize: '1.5 GB', RowCount: '9' },
    ]),
  );
  const rows = await listTablets(transport, 'db.tbl');
  assert.equal(rows[0].tabletId, '1');
  assert.equal(rows[0].backendId, '10005');
  assert.equal(rows[0].dataSize, 1.5 * GB);
  assert.match(calls[0].sql, /^SHOW TABLETS FROM `db`\.`tbl`$/);
});

test('listTablets：可按分区过滤与限行；上游失败抛 E_UPSTREAM', async () => {
  const { transport } = stubTransport(() =>
    qr([
      { TabletId: '1', PartitionName: 'p1' },
      { TabletId: '2', PartitionName: 'p2' },
    ]),
  );
  assert.equal((await listTablets(transport, 'tbl', { partition: 'p2' })).length, 1);
  assert.equal((await listTablets(transport, 'tbl', { limit: 1 })).length, 1);
  await assert.rejects(() => listTablets(stubTransport(() => 'x').transport, 'tbl'), /SHOW TABLETS 失败/);
});

test('replicaDistribution：读 BackendId/ReplicaNum，空行被丢掉', async () => {
  const { transport } = stubTransport(() => qr([{ BackendId: '10005', ReplicaNum: '10' }, { ReplicaNum: '3' }]));
  const d = await replicaDistribution(transport, 'db.tbl');
  assert.deepEqual(d, [{ backendId: '10005', replicaNum: 10 }]);
  await assert.rejects(() => replicaDistribution(stubTransport(() => 'x').transport, 'tbl'), /REPLICA DISTRIBUTION 失败/);
});

// ─────────────────────── 分桶体检 ───────────────────────

test('analyzeBuckets：每 tablet 落在 1–10 GB 区间 → ok', async () => {
  const { transport } = stubTransport(bySql({ 'SHOW PARTITIONS': qr(partRows(5, 1)) }));
  const { advice } = await analyzeBuckets(transport, 'db.tbl');
  assert.equal(advice.verdict, 'ok');
  assert.equal(advice.bucketsPerPartition, 1);
  assert.equal(advice.largestPartitionGb, 5);
  assert.equal(advice.avgTabletGb, 5);
  assert.match(advice.message, /落在 1–10 GB 目标区间/);
});

test('analyzeBuckets：每 tablet 太小 → too-small（桶数偏多）', async () => {
  const { transport } = stubTransport(bySql({ 'SHOW PARTITIONS': qr(partRows(4.108, 10)) }));
  const { advice } = await analyzeBuckets(transport, 'db.tbl');
  assert.equal(advice.verdict, 'too-small');
  assert.equal(advice.avgTabletGb, 0.411);
  assert.match(advice.hint ?? '', /桶数偏多/);
});

test('analyzeBuckets：每 tablet 太大 → too-large（并行度不够、单 tablet 修复慢）', async () => {
  const { transport } = stubTransport(bySql({ 'SHOW PARTITIONS': qr(partRows(100, 2)) }));
  const { advice } = await analyzeBuckets(transport, 'db.tbl');
  assert.equal(advice.verdict, 'too-large');
  assert.match(advice.hint ?? '', /并行度不够/);
});

test('analyzeBuckets：目标区间可调（不同表可以有不同的目标）', async () => {
  const { transport } = stubTransport(bySql({ 'SHOW PARTITIONS': qr(partRows(4.108, 10)) }));
  const { advice } = await analyzeBuckets(transport, 'db.tbl', { targetGbMin: 0.1, targetGbMax: 1 });
  assert.equal(advice.verdict, 'ok');
});

test('analyzeBuckets：取**最大分区**算每 tablet 大小（最新写入量才代表现状）', async () => {
  const { transport } = stubTransport(
    bySql({
      'SHOW PARTITIONS': qr([
        { PartitionName: 'old', Buckets: '10', DataSize: '0.1 GB' },
        { PartitionName: 'new', Buckets: '10', DataSize: '20 GB' },
      ]),
    }),
  );
  const { advice } = await analyzeBuckets(transport, 'db.tbl');
  assert.equal(advice.largestPartitionGb, 20);
  assert.equal(advice.avgTabletGb, 2);
});

test('analyzeBuckets：各分区桶数不一致时作为**旁注**报出（不被结论覆盖）', async () => {
  const { transport } = stubTransport(
    bySql({
      'SHOW PARTITIONS': qr([
        { PartitionName: 'a', Buckets: '10', DataSize: '20 GB' },
        { PartitionName: 'b', Buckets: '20', DataSize: '20 GB' },
      ]),
    }),
  );
  const { advice } = await analyzeBuckets(transport, 'db.tbl');
  assert.match(advice.notes?.[0] ?? '', /各分区桶数不一致（10\/20）/);
  // 结论本身仍然给出来了
  assert.equal(advice.verdict, 'ok');
});

test('analyzeBuckets：拿不到 DataSize 时说清原因，不给错的结论', async () => {
  const noSize = stubTransport(bySql({ 'SHOW PARTITIONS': qr([{ PartitionName: 'p', Buckets: '10' }]) }));
  const a = await analyzeBuckets(noSize.transport, 'tbl');
  assert.equal(a.advice.verdict, 'unknown');
  assert.match(a.advice.message, /未返回可解析的 DataSize/);
  assert.match(a.advice.hint ?? '', /人读字符串/);

  // 有 DataSize 但没有 Buckets 时必须报"缺桶数"，不能被上一条吞掉
  const noBuckets = stubTransport(bySql({ 'SHOW PARTITIONS': qr([{ PartitionName: 'p', DataSize: '5 GB' }]) }));
  const b = await analyzeBuckets(noBuckets.transport, 'tbl');
  assert.equal(b.advice.verdict, 'unknown');
  assert.match(b.advice.message, /未返回 Buckets/);
});

test('analyzeBuckets：连分区都读不到时把原始错误透出来', async () => {
  const { transport } = stubTransport(bySql({ 'SHOW PARTITIONS': 'table not found' }));
  await assert.rejects(() => analyzeBuckets(transport, 'tbl'), /SHOW PARTITIONS 失败/);
});

// ─────────────────────── 副本倾斜 ───────────────────────

test('analyzeReplicaSkew：分布均衡时通过', () => {
  const r = analyzeReplicaSkew([
    { backendId: '10005', replicaNum: 10 },
    { backendId: '10006', replicaNum: 10 },
    { backendId: '10007', replicaNum: 10 },
  ]);
  assert.equal(r.balanced, true);
  assert.match(r.message, /副本分布均衡（10–10，均值 10）/);
});

test('analyzeReplicaSkew：偏离超阈值时点名最热与最冷的 BE', () => {
  const r = analyzeReplicaSkew([
    { backendId: 'hot', replicaNum: 30 },
    { backendId: 'cold', replicaNum: 2 },
  ]);
  assert.equal(r.balanced, false);
  assert.match(r.message, /BE hot 有 30 个、BE cold 只有 2 个/);
});

test('analyzeReplicaSkew：容差可调；单个 BE 直接算均衡；全 0 不除零', () => {
  const dist = [{ backendId: 'a', replicaNum: 12 }, { backendId: 'b', replicaNum: 8 }];
  assert.equal(analyzeReplicaSkew(dist, { tolerance: 0.5 }).balanced, true);
  assert.equal(analyzeReplicaSkew([{ backendId: 'a', replicaNum: 1 }]).balanced, true);
  assert.equal(analyzeReplicaSkew([]).balanced, true);
  const zeros = analyzeReplicaSkew([{ backendId: 'a', replicaNum: 0 }, { backendId: 'b', replicaNum: 0 }]);
  assert.equal(zeros.balanced, true);
  assert.equal(Number.isNaN(zeros.balanced), false);
});

test('replicaDistribution 失败时 analyzeBuckets 仍能单独用（CLI 里是 catch 掉的）', async () => {
  const { transport } = stubTransport(bySql({ 'SHOW PARTITIONS': qr(partRows(5, 1)), 'REPLICA DISTRIBUTION': 'nope' }));
  assert.equal((await analyzeBuckets(transport, 'tbl')).advice.verdict, 'ok');
  await assert.rejects(() => replicaDistribution(transport, 'tbl'), /REPLICA DISTRIBUTION 失败/);
});
