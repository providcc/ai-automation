/**
 * 刷新方式（增量退化）诊断单测。
 *
 * 这一层来自两个 memory：
 *   - `doris-mtmv-partial-degradation-excluded-triggers`：非 excluded 基表按整表版本比对，
 *     一张高频写入的基表即可否决所有分区的增量资格。
 *   - `doris-mtmv-selfjoin-view-limits`：`RefreshMode`/`NeedRefreshPartitions` 是判定退化的直接证据。
 *
 * 判定必须**只在 EXPR 分区 MV 上做**，否则满屏噪音。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRefreshMode } from '../../packages/core/src/dw/refresh-mode.ts';
import type { MvTask } from '../../packages/core/src/dw/mv.ts';

const t = (over: Partial<MvTask> = {}): MvTask => ({ mvName: 'mv_a', status: 'SUCCESS', ...over });

const exprScope = (names: string[]) => ({
  partitionType: new Map(names.map((n) => [n, 'EXPR'])),
});

test('analyzeRefreshMode：全部走增量 → healthy', () => {
  const [s] = analyzeRefreshMode(
    [t({ refreshMode: 'PARTIAL', needRefreshPartitions: ['p1', 'p2'], durationSec: 2 })],
    exprScope(['mv_a']),
  );
  assert.equal(s.verdict, 'healthy');
  assert.equal(s.partialRuns, 1);
  assert.equal(s.maxNeedPartitions, 2);
  assert.match(s.message, /1 轮增量，脏分区最多 2 个/);
});

test('analyzeRefreshMode：一次增量都没有 → degraded，并给出根因与处置', () => {
  const [s] = analyzeRefreshMode(
    [
      t({ refreshMode: 'COMPLETE', completedPartitions: ['p1', 'p2', 'p3'], durationSec: 540 }),
      t({ refreshMode: 'COMPLETE', completedPartitions: ['p1', 'p2', 'p3'], durationSec: 530 }),
    ],
    exprScope(['mv_a']),
  );
  assert.equal(s.verdict, 'degraded');
  assert.match(s.message, /2\/2 轮走全量（COMPLETE），一次增量都没有/);
  assert.match(s.hint ?? '', /非 excluded 的 join 基表按整表版本比对/);
  assert.match(s.hint ?? '', /excluded_trigger_tables/);
  // 副作用必须写出来
  assert.match(s.hint ?? '', /副作用必查/);
  // 反直觉的那条也要写出来
  assert.match(s.hint ?? '', /把非驱动表也改成分区表\*\*没有用\*\*/);
  // 属性变更会清空脏账本，别据此判定没生效
  assert.match(s.hint ?? '', /清空脏账本/);
});

test('analyzeRefreshMode：全量与增量交替 → intermittent（间歇性降级）', () => {
  const [s] = analyzeRefreshMode(
    [
      t({ refreshMode: 'COMPLETE', completedPartitions: ['p1', 'p2'] }),
      t({ refreshMode: 'PARTIAL', needRefreshPartitions: ['p1'] }),
      t({ refreshMode: 'COMPLETE', completedPartitions: ['p1', 'p2'] }),
    ],
    exprScope(['mv_a']),
  );
  assert.equal(s.verdict, 'intermittent');
  assert.equal(s.fullRuns, 2);
  assert.equal(s.partialRuns, 1);
  assert.match(s.message, /2 轮全量 \/ 1 轮增量，间歇性降级/);
});

test('analyzeRefreshMode：**NOT_REFRESH 不算降级**（没有分区判脏 = 什么都没做，是正常行为）', () => {
  const [s] = analyzeRefreshMode(
    [t({ refreshMode: 'NOT_REFRESH' }), t({ refreshMode: 'NOT_REFRESH' })],
    exprScope(['mv_a']),
  );
  assert.equal(s.verdict, 'unknown');
  assert.equal(s.notRefreshRuns, 2);
  assert.equal(s.fullRuns, 0);
  assert.match(s.message, /2 轮 NOT_REFRESH：没有分区判脏，什么都没做/);
});

test('analyzeRefreshMode：NOT_REFRESH 与 COMPLETE 混着也不算"全部走全量"', () => {
  const [s] = analyzeRefreshMode(
    [t({ refreshMode: 'NOT_REFRESH' }), t({ refreshMode: 'COMPLETE', completedPartitions: ['p1', 'p2'] })],
    exprScope(['mv_a']),
  );
  assert.equal(s.verdict, 'degraded');
  // 分母是总轮数，分子是全量轮数——不能写成"2 轮全部走全量"
  assert.match(s.message, /1\/2 轮走全量/);
});

test('analyzeRefreshMode：**只有一个分区时不算退化**（脏集必然等于全分区数）', () => {
  const [s] = analyzeRefreshMode([t({ refreshMode: 'COMPLETE', completedPartitions: ['only'] })], exprScope(['mv_a']));
  assert.equal(s.verdict, 'not-applicable');
  assert.match(s.message, /只有 1 个分区/);
  assert.equal(s.hint, undefined);
});

test('analyzeRefreshMode：**非 EXPR 分区不判降级**（SELF_MANAGE 走全量本来就正常）', () => {
  const [s] = analyzeRefreshMode([t({ refreshMode: 'COMPLETE' })], {
    partitionType: new Map([['mv_a', 'SELF_MANAGE']]),
  });
  assert.equal(s.verdict, 'not-applicable');
  assert.match(s.message, /分区类型 SELF_MANAGE：本来就没有分区级增量/);
});

test('analyzeRefreshMode：不在清单里的 MV 标为 not-applicable（tasks() 是全集群的）', () => {
  const [s] = analyzeRefreshMode([t({ mvName: 'other_db_mv', refreshMode: 'COMPLETE' })], exprScope(['mv_a']));
  assert.equal(s.verdict, 'not-applicable');
  assert.match(s.message, /不在当前库的 mv_infos 清单里/);
});

test('analyzeRefreshMode：**范围判定优先于失败判定**——别的库的失败不在本命令报出来', () => {
  const [s] = analyzeRefreshMode([t({ mvName: 'other_db_mv', status: 'FAILED' })], exprScope(['mv_a']));
  assert.equal(s.verdict, 'not-applicable');
});

test('analyzeRefreshMode：范围**内**的失败照常报 failing', () => {
  const [s] = analyzeRefreshMode(
    [t({ status: 'FAILED', errorMsg: 'x' }), t({ status: 'SUCCESS', refreshMode: 'PARTIAL' })],
    exprScope(['mv_a']),
  );
  assert.equal(s.verdict, 'failing');
  assert.equal(s.failedRuns, 1);
  assert.match(s.message, /1\/2 轮失败/);
});

test('analyzeRefreshMode：不给 partitionType 时不做范围收敛（显式 --mv 的场景）', () => {
  const [s] = analyzeRefreshMode([t({ refreshMode: 'COMPLETE', completedPartitions: ['p1', 'p2'] })]);
  assert.equal(s.verdict, 'degraded');
});

test('analyzeRefreshMode：按严重度排序，同级按脏分区数降序', () => {
  const out = analyzeRefreshMode(
    [
      t({ mvName: 'healthy_a', refreshMode: 'PARTIAL', needRefreshPartitions: ['p1'] }),
      t({ mvName: 'fail_a', status: 'FAILED' }),
      t({ mvName: 'degrade_small', refreshMode: 'COMPLETE', completedPartitions: ['p1', 'p2'] }),
      t({ mvName: 'degrade_big', refreshMode: 'COMPLETE', needRefreshPartitions: new Array(50).fill('p'), completedPartitions: ['p1', 'p2'] }),
    ],
    exprScope(['healthy_a', 'fail_a', 'degrade_small', 'degrade_big']),
  );
  assert.deepEqual(out.map((s) => s.mvName), ['fail_a', 'degrade_big', 'degrade_small', 'healthy_a']);
});

test('analyzeRefreshMode：耗时统计（均值/最大）与 byMode 计数', () => {
  const [s] = analyzeRefreshMode(
    [
      t({ refreshMode: 'PARTIAL', durationSec: 2 }),
      t({ refreshMode: 'PARTIAL', durationSec: 4 }),
      t({ refreshMode: 'NOT_REFRESH', durationSec: 0 }),
    ],
    exprScope(['mv_a']),
  );
  assert.equal(s.avgDurationSec, 2);
  assert.equal(s.maxDurationSec, 4);
  assert.deepEqual(s.byMode, { PARTIAL: 2, NOT_REFRESH: 1 });
});

test('analyzeRefreshMode：refreshMode 缺失时归到"(未回)"，不崩', () => {
  const [s] = analyzeRefreshMode([t()], exprScope(['mv_a']));
  assert.deepEqual(s.byMode, { '(未回)': 1 });
  assert.equal(s.verdict, 'unknown');
});

test('analyzeRefreshMode：没有 mvName 的行被忽略；空输入给空数组', () => {
  assert.deepEqual(analyzeRefreshMode([], exprScope(['mv_a'])), []);
  assert.deepEqual(analyzeRefreshMode([{ mvName: '' }]), []);
});

test('analyzeRefreshMode：脏分区数≈全分区数时，提示语点明"脏集 == 全分区数"', () => {
  const [s] = analyzeRefreshMode(
    [t({ refreshMode: 'COMPLETE', needRefreshPartitions: new Array(1355).fill('p'), completedPartitions: new Array(1355).fill('p') })],
    exprScope(['mv_a']),
  );
  assert.match(s.hint ?? '', /脏分区数（1355）已接近\/等于全分区数（1355）——脏集 == 全分区数，FE 只能全刷/);
});
