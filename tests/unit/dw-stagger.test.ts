/**
 * dw 相位错峰单测。
 * 核心口径：**相位间隔不足 ≠ 撞车**——要看前一张的实测耗时。
 * 本库 75 张小时级分布在 60 个分钟位上，按"2 分钟间隔"硬报会满屏噪声。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeStagger,
  collectPhases,
  durationsFromTasks,
  suggestStagger,
} from '../../packages/core/src/dw/stagger.ts';
import { buildGraphFromDdls } from '../../packages/core/src/dw/swap.ts';

const ddl = (starts?: string, every = 1, unit = 'HOUR', extra = '') =>
  `CREATE MATERIALIZED VIEW m REFRESH AUTO ON SCHEDULE EVERY ${every} ${unit}` +
  `${starts ? ` STARTS "${starts}"` : ''} ${extra} AS SELECT 1`;

// ─────────────────────── 相位抽取 ───────────────────────

test('collectPhases：从 DDL 抽时分秒，并带上周期与 BUILD 方式', () => {
  const { slots, unphased } = collectPhases([
    { name: 'a', ddl: `CREATE MATERIALIZED VIEW a BUILD DEFERRED REFRESH AUTO ON SCHEDULE EVERY 1 HOUR STARTS "2026-10-23 13:24:00" AS SELECT 1` },
  ]);
  assert.deepEqual(unphased, []);
  assert.equal(slots[0].timeOfDay, '13:24:00');
  assert.equal(slots[0].hour, 13);
  assert.equal(slots[0].minute, 24);
  assert.equal(slots[0].unit, 'HOUR');
  assert.equal(slots[0].build, 'DEFERRED');
});

test('collectPhases：ON COMMIT / ON MANUAL / 无 STARTS 的分别报出原因，不混进相位表', () => {
  const { slots, unphased } = collectPhases([
    { name: 'commit', ddl: ddl(undefined, 1, 'HOUR', '').replace('ON SCHEDULE EVERY 1 HOUR', 'ON COMMIT') },
    { name: 'manual', ddl: 'CREATE MATERIALIZED VIEW m REFRESH AUTO ON MANUAL AS SELECT 1' },
    { name: 'nostarts', ddl: ddl() },
  ]);
  assert.equal(slots.length, 0);
  assert.deepEqual(unphased.map((u) => u.reason), ['ON COMMIT（无固定相位）', 'ON MANUAL（已冻结）', '未解析到 STARTS']);
});

// ─────────────────────── 体检 ───────────────────────

test('analyzeStagger：同一分钟起跑 → W_SAME_MINUTE（不需要额外证据）', () => {
  const { slots } = collectPhases([
    { name: 'a', ddl: ddl('2026-10-23 03:30:00') },
    { name: 'b', ddl: ddl('2026-10-23 03:30:00') },
  ]);
  const f = analyzeStagger(slots);
  assert.ok(f.some((x) => x.code === 'W_SAME_MINUTE' && /a 与 b/.test(x.message)));
});

test('analyzeStagger：**1 分钟间隔不算撞车**（没有耗时就别硬报）', () => {
  const { slots } = collectPhases([
    { name: 'a', ddl: ddl('2026-10-23 10:52:00') },
    { name: 'b', ddl: ddl('2026-10-23 10:53:00') },
  ]);
  assert.deepEqual(analyzeStagger(slots), []);
});

test('analyzeStagger：间隔 < 前一张实测耗时 → W_DURATION_OVERLAP（这才是会 FAILED 的那种）', () => {
  const { slots } = collectPhases([
    { name: 'a', ddl: ddl('2026-10-23 10:52:00') },
    { name: 'b', ddl: ddl('2026-10-23 10:53:00') },
  ]);
  const f = analyzeStagger(slots, { durations: new Map([['a', 300]]) });
  const hit = f.find((x) => x.code === 'W_DURATION_OVERLAP');
  assert.match(hit?.message ?? '', /实测耗时 300s/);
  assert.match(hit?.hint ?? '', /随机 FAILED 且重试即过/);
});

test('analyzeStagger：耗时不覆盖间隔时保持安静', () => {
  const { slots } = collectPhases([
    { name: 'a', ddl: ddl('2026-10-23 10:52:00') },
    { name: 'b', ddl: ddl('2026-10-23 10:53:00') },
  ]);
  assert.deepEqual(analyzeStagger(slots, { durations: new Map([['a', 30]]) }), []);
});

test('analyzeStagger：同一分钟位超过阈值 → W_CROWDED_MINUTE，阈值可调', () => {
  const { slots } = collectPhases([
    { name: 'a', ddl: ddl('2026-10-23 00:30:00', 1, 'DAY') },
    { name: 'b', ddl: ddl('2026-10-23 00:30:00', 1, 'DAY') },
    { name: 'c', ddl: ddl('2026-10-23 00:30:00', 1, 'DAY') },
  ]);
  assert.ok(analyzeStagger(slots).some((x) => x.code === 'W_CROWDED_MINUTE'));
  // 阈值放到 3 就不报了
  assert.equal(analyzeStagger(slots, { crowdThreshold: 3 }).some((x) => x.code === 'W_CROWDED_MINUTE'), false);
});

test('analyzeStagger：**不同周期互不比较**（日级与小时级同分钟起跑不冲突）', () => {
  const { slots } = collectPhases([
    { name: 'a', ddl: ddl('2026-10-23 00:30:00', 1, 'DAY') },
    { name: 'b', ddl: ddl('2026-10-23 00:30:00', 1, 'HOUR') },
  ]);
  assert.deepEqual(analyzeStagger(slots), []);
});

test('analyzeStagger：依赖倒置 → 上游是事实/汇总表时报 error', () => {
  const graph = buildGraphFromDdls([
    { name: 'down', ddl: 'CREATE MATERIALIZED VIEW down AS SELECT * FROM `dws_up`' },
    { name: 'dws_up', ddl: 'CREATE MATERIALIZED VIEW dws_up AS SELECT 1' },
  ]);
  const { slots } = collectPhases([
    { name: 'down', ddl: ddl('2026-10-23 13:24:00') },
    { name: 'dws_up', ddl: ddl('2026-10-23 17:30:00') },
  ]);
  const f = analyzeStagger(slots, { graph });
  const hit = f.find((x) => x.code === 'E_DEPENDENCY_INVERSION');
  assert.equal(hit?.level, 'error');
  assert.match(hit?.hint ?? '', /下游永远读到上一周期的数据/);
});

test('analyzeStagger：上游是维表时降级为 warn（维表变化慢，滞后通常无害）', () => {
  const graph = buildGraphFromDdls([
    { name: 'down', ddl: 'CREATE MATERIALIZED VIEW down AS SELECT * FROM `dim_store`' },
    { name: 'dim_store', ddl: 'CREATE MATERIALIZED VIEW dim_store AS SELECT 1' },
  ]);
  const { slots } = collectPhases([
    { name: 'down', ddl: ddl('2026-10-23 13:24:00') },
    { name: 'dim_store', ddl: ddl('2026-10-23 20:05:00') },
  ]);
  const hit = analyzeStagger(slots, { graph }).find((x) => x.code === 'E_DEPENDENCY_INVERSION');
  assert.equal(hit?.level, 'warn');
  assert.match(hit?.message ?? '', /上游是维表，滞后通常无害/);
});

test('analyzeStagger：下游在上游之后 → 不报；跨周期依赖也不报', () => {
  const graph = buildGraphFromDdls([
    { name: 'down', ddl: 'CREATE MATERIALIZED VIEW down AS SELECT * FROM `up`' },
    { name: 'up', ddl: 'CREATE MATERIALIZED VIEW up AS SELECT 1' },
  ]);
  const ok = collectPhases([
    { name: 'up', ddl: ddl('2026-10-23 10:00:00') },
    { name: 'down', ddl: ddl('2026-10-23 11:00:00') },
  ]).slots;
  assert.deepEqual(analyzeStagger(ok, { graph }), []);

  const cross = collectPhases([
    { name: 'up', ddl: ddl('2026-10-23 10:00:00', 1, 'HOUR') },
    { name: 'down', ddl: ddl('2026-10-23 05:00:00', 1, 'DAY') },
  ]).slots;
  assert.deepEqual(analyzeStagger(cross, { graph }), []);
});

// ─────────────────────── 耗时与建议 ───────────────────────

test('durationsFromTasks：取成功的最大耗时；失败任务不算（耗时不可比）', () => {
  const d = durationsFromTasks([
    { mvName: 'a', durationSec: 10, status: 'SUCCESS' },
    { mvName: 'a', durationSec: 40, status: 'SUCCESS' },
    { mvName: 'a', durationSec: 999, status: 'FAILED' },
    { mvName: 'b', status: 'SUCCESS' },
  ]);
  assert.equal(d.get('a'), 40);
  assert.equal(d.has('b'), false);
});

test('durationsFromTasks：没写 status 也接受（tasks() 老版本列不全）', () => {
  assert.equal(durationsFromTasks([{ mvName: 'a', durationSec: 7 }]).get('a'), 7);
});

test('suggestStagger：同分钟位只留一张，其余平移到最近空位', () => {
  const { slots } = collectPhases([
    { name: 'a', ddl: ddl('2026-10-23 00:30:00', 1, 'DAY') },
    { name: 'b', ddl: ddl('2026-10-23 00:30:00', 1, 'DAY') },
    { name: 'c', ddl: ddl('2026-10-23 00:30:00', 1, 'DAY') },
  ]);
  const s = suggestStagger(slots);
  assert.equal(s.length, 2); // 第一张原地不动
  assert.deepEqual(s.map((x) => x.name), ['b', 'c']);
  assert.equal(s[0].from, '00:30:00');
  assert.notEqual(s[0].to, '00:30:00');
  assert.match(s[0].reason, /同分钟位/);
});

test('suggestStagger：没有冲突时不给建议', () => {
  const { slots } = collectPhases([
    { name: 'a', ddl: ddl('2026-10-23 01:00:00') },
    { name: 'b', ddl: ddl('2026-10-23 02:00:00') },
  ]);
  assert.deepEqual(suggestStagger(slots), []);
});

test('suggestStagger：可按周期筛选，只重排指定 unit 的那组', () => {
  const { slots } = collectPhases([
    { name: 'd1', ddl: ddl('2026-10-23 00:30:00', 1, 'DAY') },
    { name: 'd2', ddl: ddl('2026-10-23 00:30:00', 1, 'DAY') },
    { name: 'h1', ddl: ddl('2026-10-23 05:00:00', 1, 'HOUR') },
  ]);
  const s = suggestStagger(slots, { unit: 'HOUR' });
  assert.deepEqual(s, []);
  assert.equal(suggestStagger(slots, { unit: 'DAY' }).length, 1);
});
