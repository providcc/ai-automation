/**
 * dw MV 生命周期单测：清单/状态、真实相位、定义读取、调度解析、写操作闸门。
 * 口径全部来自线上实测，用例就是把这些口径钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHealthy,
  listMvInfos,
  listMvTasks,
  parseMvPartitionInfo,
  parseMvSchedule,
  parsePartitionList,
  pickCreateColumn,
  quoteIdent,
  quoteLiteral,
  runWrite,
  showMvDefinition,
  sqlMvManual,
  sqlMvSchedule,
  sqlRefreshMv,
} from '../../packages/core/src/dw/mv.ts';
import { bySql, qr, stubTransport } from './dw-helpers.ts';

// ─────────────────────── 标识符 ───────────────────────

test('quoteIdent：加反引号并转义内部反引号', () => {
  assert.equal(quoteIdent('mv'), '`mv`');
  assert.equal(quoteIdent('we`ird'), '`we``ird`');
  assert.equal(quoteIdent('db.tbl'), '`db.tbl`');
});

test('quoteLiteral：单引号转义成两个单引号', () => {
  assert.equal(quoteLiteral('demo_db'), "'demo_db'");
  assert.equal(quoteLiteral("it's"), "'it''s'");
});

// ─────────────────────── 清单与状态 ───────────────────────

test('listMvInfos：走 mv_infos 表函数，按列名取值以兼容版本差异', async () => {
  const { transport, calls } = stubTransport(() =>
    qr([
      { Name: 'mv_a', State: 'NORMAL', RefreshState: 'SUCCESS' },
      { Name: 'mv_b', State: 'SCHEMA_CHANGE', RefreshState: 'SUCCESS', ErrorMsg: 'oops' },
    ]),
  );
  const infos = await listMvInfos(transport, 'demo_db');
  assert.equal(infos.length, 2);
  assert.equal(infos[1].state, 'SCHEMA_CHANGE');
  assert.equal(infos[1].errorMsg, 'oops');
  assert.equal(infos[0].refreshMode, undefined);
  assert.match(calls[0].sql, /mv_infos\('database'='demo_db'\)/);
});

test('listMvInfos：3.1.4 只有三列也能跑；没有名字的行被丢掉', async () => {
  const { transport } = stubTransport(() =>
    qr([{ Name: 'x', State: 'NORMAL', RefreshState: 'SUCCESS' }, { State: 'NORMAL' }]),
  );
  const infos = await listMvInfos(transport, 'demo_db');
  assert.equal(infos.length, 1);
  assert.equal(infos[0].name, 'x');
});

test('listMvInfos：列名大小写不敏感（版本间命名不统一）', async () => {
  const { transport } = stubTransport(() => qr([{ name: 'lower', state: 'NORMAL', refreshstate: 'SUCCESS' }]));
  const infos = await listMvInfos(transport, 'demo_db');
  assert.equal(infos[0].name, 'lower');
  assert.equal(infos[0].refreshState, 'SUCCESS');
});

test('listMvInfos：上游失败抛 E_UPSTREAM', async () => {
  const { transport } = stubTransport(() => 'boom');
  await assert.rejects(() => listMvInfos(transport, 'demo_db'), /读取 mv_infos 失败/);
});

test('isHealthy：State=NORMAL 且 RefreshState=SUCCESS 才算正常', () => {
  assert.equal(isHealthy({ state: 'NORMAL', refreshState: 'SUCCESS' }), true);
  assert.equal(isHealthy({ state: 'SCHEMA_CHANGE', refreshState: 'SUCCESS' }), false);
  assert.equal(isHealthy({ state: 'NORMAL', refreshState: 'FAILED' }), false);
  assert.equal(isHealthy({}), false);
});

// ─────────────────────── 任务（真实相位） ───────────────────────

test('listMvTasks：走 tasks 表函数，算出耗时；SQL 里有时间窗与条数上限', async () => {
  const { transport, calls } = stubTransport(() =>
    qr([
      { MvName: 'mv_a', CreateTime: '2026-10-22 11:00:00', FinishTime: '2026-10-22 11:00:12', Status: 'SUCCESS' },
      { MvName: 'mv_b', CreateTime: '2026-10-22 11:01:00', Status: 'RUNNING' },
    ]),
  );
  const tasks = await listMvTasks(transport, { hours: 6, limit: 50 });
  assert.equal(tasks[0].durationSec, 12);
  assert.equal(tasks[1].durationSec, undefined);
  assert.match(calls[0].sql, /tasks\('type'='mv'\)/);
  assert.match(calls[0].sql, /INTERVAL 6 HOUR/);
  assert.match(calls[0].sql, /LIMIT 50/);
});

test('listMvTasks：指定 --mv 时加过滤；时间不可解析时不给耗时（不瞎猜）', async () => {
  const { transport, calls } = stubTransport(() =>
    qr([{ MvName: 'mv_a', CreateTime: 'not-a-time', FinishTime: 'also-not' }]),
  );
  const tasks = await listMvTasks(transport, { mvName: 'mv_a' });
  assert.match(calls[0].sql, /MvName = 'mv_a'/);
  assert.equal(tasks[0].durationSec, undefined);
});

test('listMvTasks：默认 24 小时 / 200 条', async () => {
  const { transport, calls } = stubTransport(() => qr());
  await listMvTasks(transport);
  assert.match(calls[0].sql, /INTERVAL 24 HOUR/);
  assert.match(calls[0].sql, /LIMIT 200/);
});

test('listMvTasks：上游失败抛 E_UPSTREAM', async () => {
  const { transport } = stubTransport(() => 'nope');
  await assert.rejects(() => listMvTasks(transport), /读取 tasks 失败/);
});

// ─────────────────────── 定义读取 ───────────────────────

test('pickCreateColumn：SHOW CREATE 回两列，必须挑定义列而不是名字', () => {
  // 实测：第 0 列是 View 名，第 1 列才是 Create View
  assert.equal(pickCreateColumn({ View: 'mv_a', 'Create View': 'CREATE MATERIALIZED VIEW mv_a ...' }), 'CREATE MATERIALIZED VIEW mv_a ...');
  // 列名不含 create 时取最长的那一列
  assert.equal(pickCreateColumn({ a: 'short', b: 'a much longer definition' }), 'a much longer definition');
  assert.equal(pickCreateColumn({ a: 1 }), '');
  assert.equal(pickCreateColumn(undefined), '');
});

test('showMvDefinition：默认脱敏 DDL 里的连接属性；--raw 回原值', async () => {
  const ddl = 'CREATE MATERIALIZED VIEW mv_a PROPERTIES ("password" = "p@ss") AS SELECT 1';
  const { transport } = stubTransport(() => qr([{ View: 'mv_a', 'Create View': ddl }]));
  const masked = await showMvDefinition(transport, 'mv_a');
  assert.equal(masked.masked, 1);
  assert.match(masked.ddl, /"password" = "\*\*\*"/);
  const raw = await showMvDefinition(transport, 'mv_a', { raw: true });
  assert.match(raw.ddl, /p@ss/);
  assert.equal(raw.masked, 0);
});

test('showMvDefinition：拿不到定义时明确报错，不返回空串', async () => {
  const { transport } = stubTransport(() => qr([{ View: 'mv_a' }]));
  await assert.rejects(() => showMvDefinition(transport, 'mv_a'), /没有返回定义/);
  const failing = stubTransport(() => 'Unknown table').transport;
  await assert.rejects(() => showMvDefinition(failing, 'mv_a'), /SHOW CREATE 失败/);
});

// ─────────────────────── 调度解析 ───────────────────────

test('parseMvSchedule：ON SCHEDULE 的 every/unit/starts 全解出来', () => {
  const s = parseMvSchedule(
    'CREATE MATERIALIZED VIEW mv_a\nBUILD DEFERRED REFRESH AUTO ON SCHEDULE EVERY 1 DAY STARTS "2026-10-23 14:32:00"\n' +
      'DUPLICATE KEY(id)\nDISTRIBUTED BY HASH(id) BUCKETS AUTO\nAS SELECT 1',
  );
  assert.equal(s.build, 'DEFERRED');
  assert.equal(s.every, 1);
  assert.equal(s.unit, 'DAY');
  assert.equal(s.starts, '2026-10-23 14:32:00');
  assert.equal(s.onCommit, false);
  assert.equal(s.onManual, false);
});

test('parseMvSchedule：ON COMMIT / ON MANUAL 分别识别，且没有 STARTS', () => {
  const onCommit = parseMvSchedule('CREATE MATERIALIZED VIEW m BUILD DEFERRED REFRESH AUTO ON COMMIT AS SELECT 1');
  assert.equal(onCommit.onCommit, true);
  assert.equal(onCommit.starts, undefined);
  const onManual = parseMvSchedule('CREATE MATERIALIZED VIEW m REFRESH AUTO ON MANUAL AS SELECT 1');
  assert.equal(onManual.onManual, true);
});

test('parseMvSchedule：只看 AS SELECT 之前的头部——体里的 REFRESH 字样不算调度', () => {
  const s = parseMvSchedule('CREATE MATERIALIZED VIEW m REFRESH AUTO ON MANUAL AS SELECT \'REFRESH AUTO ON COMMIT\' AS x');
  assert.equal(s.onCommit, false);
  assert.equal(s.onManual, true);
});

test('parseMvSchedule：MINUTE/HOUR/WEEK/MONTH 各档都认', () => {
  for (const [unit, txt] of [['MINUTE', 'EVERY 5 MINUTE'], ['HOUR', 'EVERY 2 HOUR'], ['WEEK', 'EVERY 1 WEEK'], ['MONTH', 'EVERY 1 MONTH']] as const) {
    const s = parseMvSchedule(`CREATE MATERIALIZED VIEW m REFRESH AUTO ON SCHEDULE ${txt} AS SELECT 1`);
    assert.equal(s.unit, unit);
  }
});

test('parseMvSchedule：空 DDL 不炸', () => {
  const s = parseMvSchedule('');
  assert.equal(s.build, undefined);
  assert.equal(s.refresh, undefined);
});

// ─────────────────────── 写操作 ───────────────────────

test('runWrite：默认 dry-run，且不发请求', async () => {
  const { transport, calls } = stubTransport(() => qr());
  const out = await runWrite(transport, 'REFRESH MATERIALIZED VIEW `mv`');
  assert.equal(out.dryRun, true);
  assert.equal(out.ok, true);
  assert.match(out.msg ?? '', /dry-run/);
  assert.equal(calls[0].opts?.dryRun, true);
});

test('runWrite：--apply + 只读环境 = 拒绝，且**连 dry-run 的请求都不发**', async () => {
  const { transport, calls } = stubTransport(() => qr());
  await assert.rejects(
    () => runWrite(transport, 'DROP MATERIALIZED VIEW `mv`', { apply: true, readonly: true }),
    (e: unknown) => {
      assert.equal((e as { code: string }).code, 'E_PROD_READONLY');
      assert.match((e as Error).message, /DW_ALLOW_PROD_WRITE=1/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('runWrite：--apply 且允许写时真执行；上游失败抛 E_UPSTREAM', async () => {
  const okRun = stubTransport(() => qr());
  const out = await runWrite(okRun.transport, 'REFRESH MATERIALIZED VIEW `mv` COMPLETE', { apply: true });
  assert.equal(out.dryRun, false);
  assert.equal(okRun.calls[0].opts?.dryRun, false);

  const bad = stubTransport(() => 'starts time must be greater than current time');
  await assert.rejects(() => runWrite(bad.transport, 'CREATE ...', { apply: true }), /执行失败/);
});

test('runWrite：DDL 默认超时放大到 10 分钟（刷新/换名本来就慢）', async () => {
  const { transport, calls } = stubTransport(() => qr());
  await runWrite(transport, 'REFRESH MATERIALIZED VIEW `mv`');
  assert.equal(calls[0].opts?.timeoutMs, 600_000);
});

test('SQL 构造：刷新、冻结、调度的形态与线上一致', () => {
  assert.equal(sqlRefreshMv('mv'), 'REFRESH MATERIALIZED VIEW `mv`');
  assert.equal(sqlRefreshMv('mv', true), 'REFRESH MATERIALIZED VIEW `mv` COMPLETE');
  assert.equal(sqlMvManual('mv'), 'ALTER MATERIALIZED VIEW `mv` REFRESH AUTO ON MANUAL');
  assert.equal(
    sqlMvSchedule('mv', 2, 'hour', '2026-10-23 14:32:00'),
    'ALTER MATERIALIZED VIEW `mv` REFRESH AUTO ON SCHEDULE EVERY 2 HOUR STARTS "2026-10-23 14:32:00"',
  );
});

test('SQL 构造：调度单位与时间格式都有校验（错在这里报，不要等 FE 报）', () => {
  assert.throws(() => sqlMvSchedule('mv', 1, 'SECOND', '2026-10-23 14:32:00'), /不支持的调度单位/);
  assert.throws(() => sqlMvSchedule('mv', 1, 'HOUR', '2026/10/23 14:32'), /STARTS 需要/);
});

test('SQL 构造：bySql 桩下多条 SQL 互不干扰（示例：mv_infos 与 tasks 各走各的）', async () => {
  const { transport } = stubTransport(
    bySql({
      mv_infos: qr([{ Name: 'a', State: 'NORMAL', RefreshState: 'SUCCESS' }]),
      tasks: qr([{ MvName: 'a', CreateTime: '2026-10-22 11:00:00', FinishTime: '2026-10-22 11:00:05' }]),
    }),
  );
  assert.equal((await listMvInfos(transport, 'demo_db')).length, 1);
  assert.equal((await listMvTasks(transport))[0].durationSec, 5);
});

// ─────────────────────── 分区类型与刷新方式（来自 memory 的两条硬口径） ───────────────────────

test('parseMvPartitionInfo：EXPR 形态解出驱动表与分区列', () => {
  const p = parseMvPartitionInfo(
    "MTMVPartitionInfo{partitionType=EXPR, relatedTable=dwd_orders, relatedCol='dt', partitionCol='dt'}",
  );
  assert.equal(p.partitionType, 'EXPR');
  assert.equal(p.relatedTable, 'dwd_orders');
  assert.equal(p.relatedCol, 'dt');
  assert.equal(p.partitionCol, 'dt');
});

test('parseMvPartitionInfo：SELF_MANAGE 只给类型（没有驱动表概念）', () => {
  const p = parseMvPartitionInfo('MTMVPartitionInfo{partitionType=SELF_MANAGE}');
  assert.equal(p.partitionType, 'SELF_MANAGE');
  assert.equal(p.relatedTable, undefined);
});

test('parseMvPartitionInfo：空值/乱码不崩，返回空对象', () => {
  assert.deepEqual(parseMvPartitionInfo(undefined), {});
  assert.deepEqual(parseMvPartitionInfo(null), {});
  assert.deepEqual(parseMvPartitionInfo(''), {});
  assert.deepEqual(parseMvPartitionInfo('garbage'), { partitionType: undefined, relatedTable: undefined, relatedCol: undefined, partitionCol: undefined });
});

test('parseMvPartitionInfo：类型大小写不敏感，统一成大写', () => {
  assert.equal(parseMvPartitionInfo('partitionType=expr').partitionType, 'EXPR');
});

test('listMvInfos：MvPartitionInfo 列被展开进 MvInfo（判退化的前提）', async () => {
  const { transport } = stubTransport(() =>
    qr([
      {
        Name: 'mv_a',
        State: 'NORMAL',
        RefreshState: 'SUCCESS',
        MvPartitionInfo: "MTMVPartitionInfo{partitionType=EXPR, relatedTable=t, relatedCol='dt', partitionCol='dt'}",
      },
      { Name: 'mv_b', State: 'NORMAL', RefreshState: 'SUCCESS', MvPartitionInfo: 'MTMVPartitionInfo{partitionType=SELF_MANAGE}' },
    ]),
  );
  const infos = await listMvInfos(transport, 'demo_db');
  assert.equal(infos[0].partitionType, 'EXPR');
  assert.equal(infos[0].relatedTable, 't');
  assert.equal(infos[1].partitionType, 'SELF_MANAGE');
});

test('parsePartitionList：JSON 数组字符串解成数组', () => {
  assert.deepEqual(parsePartitionList('["p1","p2"]'), ['p1', 'p2']);
  assert.deepEqual(parsePartitionList([]), []);
  assert.deepEqual(parsePartitionList(['p1']), ['p1']);
});

test('parsePartitionList：非 JSON 原样当单元素；空值给 undefined', () => {
  assert.deepEqual(parsePartitionList('p1'), ['p1']);
  assert.equal(parsePartitionList(undefined), undefined);
  assert.equal(parsePartitionList(null), undefined);
  assert.equal(parsePartitionList(''), undefined);
});

test('parsePartitionList：坏 JSON 退化成单元素，不抛', () => {
  assert.deepEqual(parsePartitionList('[not json'), ['[not json']);
});

test('listMvTasks：RefreshMode/NeedRefreshPartitions/CompletedPartitions/DurationMs 都解出来', async () => {
  const { transport } = stubTransport(() =>
    qr([
      {
        MvName: 'mv_a',
        Status: 'SUCCESS',
        RefreshMode: 'COMPLETE',
        NeedRefreshPartitions: '["p1","p2","p3"]',
        CompletedPartitions: '["p1","p2","p3"]',
        DurationMs: 540000,
      },
    ]),
  );
  const [t] = await listMvTasks(transport);
  assert.equal(t.refreshMode, 'COMPLETE');
  assert.deepEqual(t.needRefreshPartitions, ['p1', 'p2', 'p3']);
  assert.deepEqual(t.completedPartitions, ['p1', 'p2', 'p3']);
  assert.equal(t.durationSec, 540);
});
