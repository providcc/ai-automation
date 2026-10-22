/**
 * 灰度换名（swap）、DDL 漂移、依赖链路单测。
 * 这是整个数仓能力里最该被钉死的部分——每条用例都对应一个线上踩过的坑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraphFromDdls,
  buildMvGraph,
  createViewName,
  cteNamesReferencedTwice,
  diffMvDdl,
  diffMvProps,
  downstreamOf,
  executeMvSwap,
  extractTableRefs,
  hasBlockingFinding,
  lintMvDdl,
  lintPartitionedBody,
  maskStarts,
  namesLookLikeView,
  normalizeDdl,
  onCommitRisk,
  partitionCommentTrap,
  planMvSwap,
  scanMvDrift,
  splitMvDdl,
  sqlReplaceWithSwap,
  swapTookEffect,
  viewBody,
  stripDdlComments,
  tablesReferencedTwice,
  verifySwapPhase,
} from '../../packages/core/src/dw/swap.ts';
import { goodTmpDdl, qualifiedTmpDdl, qr, stubTransport, bySql } from './dw-helpers.ts';

const NOW = new Date('2026-10-22T12:00:00Z');

// ─────────────────────── 静态检查 ───────────────────────

test('lintMvDdl：合规的替换源零发现', () => {
  assert.deepEqual(lintMvDdl(goodTmpDdl(), { now: NOW }), []);
});

test('lintMvDdl：找不到 CREATE 直接报错', () => {
  const f = lintMvDdl('SELECT 1', { now: NOW });
  assert.equal(f[0].code, 'E_NO_CREATE');
  assert.equal(f[0].level, 'error');
});

test('lintMvDdl：**带库名限定的名字也要认出来**（反引号不能把名字切一半）', () => {
  // 只匹配第一个反引号会把 `db`.`mv` 误读成 db，于是这条检查永远不触发
  assert.equal(createViewName(qualifiedTmpDdl('mv_tmp', 'demo_db')), 'demo_db.mv_tmp');
  assert.equal(createViewName(goodTmpDdl('mv_tmp')), 'mv_tmp');
  assert.equal(createViewName('CREATE MATERIALIZED VIEW db.mv AS SELECT 1'), 'db.mv');
  assert.equal(createViewName('SELECT 1'), undefined);
  const f = lintMvDdl(qualifiedTmpDdl(), { now: NOW });
  assert.ok(f.some((x) => x.code === 'E_QUALIFIED_NAME'));
});

test('lintMvDdl：替换源与目标同名是阻断级', () => {
  const f = lintMvDdl(goodTmpDdl('mv_tmp'), { now: NOW, targetName: 'mv_tmp' });
  assert.ok(f.some((x) => x.code === 'E_SAME_NAME' && x.level === 'error'));
  assert.equal(lintMvDdl(goodTmpDdl('mv_tmp'), { now: NOW, targetName: 'other' }).some((x) => x.code === 'E_SAME_NAME'), false);
});

test('lintMvDdl：STARTS 已过期 → 阻断（starts time must be greater than current time）', () => {
  const f = lintMvDdl(goodTmpDdl('m', '2020-01-01 03:20:00'), { now: NOW });
  const hit = f.find((x) => x.code === 'E_STARTS_PAST');
  assert.equal(hit?.level, 'error');
  assert.match(hit?.hint ?? '', /时分秒相位原样保留/);
});

test('lintMvDdl：STARTS 在未来 → 不报；ON SCHEDULE 缺 STARTS → 警告', () => {
  assert.equal(lintMvDdl(goodTmpDdl('m', '2099-01-01 03:20:00'), { now: NOW }).some((x) => x.code === 'E_STARTS_PAST'), false);
  const noStarts = `CREATE MATERIALIZED VIEW m REFRESH AUTO ON SCHEDULE EVERY 1 HOUR AS SELECT 1`;
  const f = lintMvDdl(noStarts, { now: NOW });
  assert.ok(f.some((x) => x.code === 'W_NO_STARTS' && x.level === 'warn'));
});

test('lintMvDdl：BUILD IMMEDIATE 提示"会被 swap 带过去"', () => {
  const f = lintMvDdl(qualifiedTmpDdl(), { now: NOW });
  assert.ok(f.some((x) => x.code === 'I_BUILD_IMMEDIATE' && x.level === 'info'));
});

test('lintMvDdl：DECIMAL 除法没有 CAST 兜住 → 警告（下游 UNION 会报 column type not same）', () => {
  const bad = `CREATE MATERIALIZED VIEW m AS SELECT SUM(a) / COUNT(*) AS v FROM t`;
  const hit = lintMvDdl(bad, { now: NOW }).find((x) => x.code === 'W_DECIMAL_DIVISION');
  assert.equal(hit?.level, 'warn');
  assert.match(hit?.hint ?? '', /CAST\(SUM\(\.\.\.\) AS DECIMAL\(38, 2\)\)/);

  const ok = `CREATE MATERIALIZED VIEW m AS SELECT CAST(SUM(a) AS DECIMAL(38, 2)) / COUNT(*) AS v FROM t`;
  assert.equal(lintMvDdl(ok, { now: NOW }).some((x) => x.code === 'W_DECIMAL_DIVISION'), false);
});

test('lintMvDdl：注释里的斜杠不算除法（免得注释一写就报警）', () => {
  const ddl = `CREATE MATERIALIZED VIEW m AS SELECT 1 AS v FROM t /* a/b */`;
  assert.equal(lintMvDdl(ddl, { now: NOW }).some((x) => x.code === 'W_DECIMAL_DIVISION'), false);
});

test('hasBlockingFinding：只有 error 级才算阻断', () => {
  assert.equal(hasBlockingFinding([{ level: 'warn', code: 'W', message: '' }]), false);
  assert.equal(hasBlockingFinding([{ level: 'info', code: 'I', message: '' }]), false);
  assert.equal(hasBlockingFinding([{ level: 'error', code: 'E', message: '' }]), true);
});

// ─────────────────────── swap 语句与清单 ───────────────────────

test('sqlReplaceWithSwap：库限定只出现在目标上，替换源必须裸名，PROPERTIES 不可省', () => {
  assert.equal(
    sqlReplaceWithSwap('demo_db.mv', 'mv_tmp'),
    'ALTER MATERIALIZED VIEW `demo_db.mv` REPLACE WITH MATERIALIZED VIEW `mv_tmp` PROPERTIES (\'swap\'=\'true\')',
  );
});

test('sqlReplaceWithSwap：替换源带库名限定直接拒绝（FE 会报 mismatched input "."）', () => {
  assert.throws(
    () => sqlReplaceWithSwap('mv', 'demo_db.mv_tmp'),
    (e: unknown) => {
      assert.equal((e as { code: string }).code, 'E_VALIDATION');
      assert.match((e as Error).message, /替换源不能带库名限定/);
      return true;
    },
  );
});

test('planMvSwap：五步顺序固定，**先冻结再删**、**最后补下游**', () => {
  const { steps, warnings } = planMvSwap({ target: 'mv', source: 'mv_tmp', database: 'demo_db' });
  assert.deepEqual(
    steps.map((s) => s.title.split(' ')[0]),
    ['全量刷替换源', '校验替换源', '原子换名（USE', '冻结旧定义（现在挂在', '清理旧副本', '回读校验'],
  );
  assert.match(steps[0].sql ?? '', /^REFRESH MATERIALIZED VIEW `mv_tmp` COMPLETE$/);
  assert.equal(steps[1].manual, true);
  assert.match(steps[2].sql ?? '', /^USE `demo_db`; ALTER MATERIALIZED VIEW `mv` REPLACE WITH/);
  assert.match(steps[3].sql ?? '', /^ALTER MATERIALIZED VIEW `mv_tmp` REFRESH AUTO ON MANUAL$/);
  assert.match(steps[4].sql ?? '', /^DROP MATERIALIZED VIEW `mv_tmp`$/);
  assert.equal(steps[5].manual, true);
  // 三条关键提醒必须在
  assert.equal(warnings.length, 3);
  assert.match(warnings.join('\n'), /调度一起换到替换源名下/);
  assert.match(warnings.join('\n'), /STARTS 重置/);
  assert.match(warnings.join('\n'), /ON COMMIT 下游.*不会自愈/s);
});

test('planMvSwap：有 ON COMMIT 下游时插入手动 COMPLETE 步，编号连续且回读在最后', () => {
  const { steps } = planMvSwap({
    target: 'mv',
    source: 'mv_tmp',
    database: 'demo_db',
    onCommitDownstream: ['down_a', 'down_b'],
  });
  const orders = steps.map((s) => s.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  assert.equal(new Set(orders).size, orders.length);
  const completeSteps = steps.filter((s) => /手动全刷 ON COMMIT 下游/.test(s.title));
  assert.equal(completeSteps.length, 2);
  assert.match(completeSteps[0].sql ?? '', /^REFRESH MATERIALIZED VIEW `down_a` COMPLETE$/);
  assert.match(completeSteps[0].note ?? '', /SCHEMA_CHANGE/);
  assert.equal(steps[steps.length - 1].manual, true);
});

test('executeMvSwap：跳过人工确认点（没有 sql 的步），逐条按清单执行', async () => {
  const { transport, calls } = stubTransport(() => qr());
  const { steps } = planMvSwap({ target: 'mv', source: 'mv_tmp', database: 'demo_db', onCommitDownstream: ['down'] });
  const out = await executeMvSwap(transport, { steps }, { apply: true });
  assert.equal(out.length, 5); // 5 条 SQL，2 个人工确认点被跳过
  assert.equal(calls.length, 5);
  assert.match(calls[1].sql, /REPLACE WITH MATERIALIZED VIEW/);
  assert.match(calls[2].sql, /REFRESH AUTO ON MANUAL/);
});

test('executeMvSwap：默认 dry-run，一条都不真发', async () => {
  const { transport, calls } = stubTransport(() => qr());
  const { steps } = planMvSwap({ target: 'mv', source: 'mv_tmp', database: 'demo_db' });
  await executeMvSwap(transport, { steps });
  assert.ok(calls.every((c) => c.opts?.dryRun === true));
});

test('verifySwapPhase：**只比时分秒**——swap 会把 STARTS 的日期改写成当天', async () => {
  const ddl = 'CREATE MATERIALIZED VIEW m REFRESH AUTO ON SCHEDULE EVERY 1 DAY STARTS "2026-10-23 14:32:00" AS SELECT 1';
  const { transport } = stubTransport(() => qr([{ View: 'm', 'Create View': ddl }]));
  const ok = await verifySwapPhase(transport, 'm', '14:32:00');
  assert.equal(ok.ok, true);
  assert.match(ok.message, /相位保持：14:32:00/);

  const bad = await verifySwapPhase(transport, 'm', '09:00:00');
  assert.equal(bad.ok, false);
  assert.match(bad.message, /相位被改动：期望 09:00:00，实际 14:32:00/);
});

test('verifySwapPhase：没有 STARTS（ON COMMIT / ON MANUAL）时明说', async () => {
  const { transport } = stubTransport(() => qr([{ View: 'm', 'Create View': 'CREATE MATERIALIZED VIEW m REFRESH AUTO ON COMMIT AS SELECT 1' }]));
  const r = await verifySwapPhase(transport, 'm', '14:32:00');
  assert.equal(r.ok, false);
  assert.match(r.message, /未解析到 STARTS/);
});

// ─────────────────────── 归一化与注释剥离 ───────────────────────

test('normalizeDdl：抹平反引号、限定名、空白、括号内侧空格', () => {
  assert.equal(normalizeDdl('CREATE  MATERIALIZED\nVIEW `a`.`b`'), 'CREATE MATERIALIZED VIEW b');
  // SHOW CREATE 会在左括号后塞空格，仓库文件不会——不抹就是"满屏假差异"
  assert.equal(normalizeDdl('mv ( a, b )'), normalizeDdl('mv (a, b)'));
  assert.equal(normalizeDdl('SELECT `t`.`c` FROM `t`'), 'SELECT c FROM t');
  assert.equal(normalizeDdl('SELECT a.b.c FROM x'), 'SELECT c FROM x');
});

test('stripDdlComments：**行内注释也要删**（SHOW CREATE 会把 SELECT 体里的注释存下来）', () => {
  // 实测形态：AS WITH -- 注释\n latest_fiscal AS (...)
  assert.equal(stripDdlComments('AS WITH -- 1. 计算最新财年\n x AS (SELECT 1)'), 'AS WITH \n x AS (SELECT 1)');
  assert.equal(stripDdlComments('-- 整行注释\nSELECT 1'), 'SELECT 1');
  assert.equal(stripDdlComments('SELECT 1 /* 块\n注释 */'), 'SELECT 1');
  assert.equal(stripDdlComments('SELECT 1 /* 未闭合'), 'SELECT 1');
});

test('stripDdlComments：引号里的 -- 不是注释（朴素正则会截断语句）', () => {
  assert.equal(stripDdlComments("SELECT '--not a comment' AS x"), "SELECT '--not a comment' AS x");
  assert.equal(stripDdlComments('SELECT "a--b" AS x'), 'SELECT "a--b" AS x');
  assert.equal(stripDdlComments('SELECT `col--x` FROM t'), 'SELECT `col--x` FROM t');
  // 反斜杠转义
  assert.equal(stripDdlComments("SELECT 'a\\'--b' AS x"), "SELECT 'a\\'--b' AS x");
});

// ─────────────────────── 属性与漂移 ───────────────────────

test('splitMvDdl：PROPERTIES 按括号配对提取，语义部分不含它', () => {
  const { semantic, props } = splitMvDdl(
    'CREATE MATERIALIZED VIEW m (a comment \'x(y)\') DUPLICATE KEY(a) PROPERTIES ("replication_num" = "1", "k" = "v") AS SELECT 1',
  );
  assert.deepEqual(props, { replication_num: '1', k: 'v' });
  assert.equal(semantic.includes('PROPERTIES'), false);
  assert.match(semantic, /x\(y\)/); // 注释里的括号不能被当成分隔点
});

test('splitMvDdl：没有 PROPERTIES 时 props 为空对象', () => {
  const { props } = splitMvDdl('CREATE MATERIALIZED VIEW m AS SELECT 1');
  assert.deepEqual(props, {});
});

test('diffMvProps：**只比仓库声明过的键**——线上自动补的那十几个不算漂移', () => {
  const local = { replication_num: '1', excluded_trigger_tables: 'a,b' };
  const live = { replication_num: '1', excluded_trigger_tables: 'a,c', storage_medium: 'hdd', is_being_synced: 'false' };
  const d = diffMvProps(local, live);
  assert.equal(d.length, 1);
  assert.equal(d[0].key, 'excluded_trigger_tables');
  assert.equal(d[0].local, 'a,b');
  assert.equal(d[0].live, 'a,c');
});

test('diffMvProps：仓库有、线上没有 = 漂移（被谁删了）', () => {
  const d = diffMvProps({ replication_num: '1' }, {});
  assert.deepEqual(d, [{ key: 'replication_num', local: '1' }]);
});

test('diffMvDdl：语义与属性都一致 → same', () => {
  const ddl = goodTmpDdl();
  const d = diffMvDdl(ddl, ddl);
  assert.equal(d.same, true);
  assert.equal(d.semanticSame, true);
  assert.deepEqual(d.propsDiffering, []);
});

test('diffMvDdl：只有属性不同 → props-only（语义一致）', () => {
  const d = diffMvDdl(goodTmpDdl(), goodTmpDdl().replace('"replication_num" = "1"', '"replication_num" = "3"'));
  assert.equal(d.same, false);
  assert.equal(d.semanticSame, true);
  assert.deepEqual(d.propsDiffering.map((p) => p.key), ['replication_num']);
});

test('diffMvDdl：只有 STARTS 不同 → phase-only（相位被改过，定义未变）', () => {
  const d = diffMvDdl(goodTmpDdl('m', '2026-01-01 03:20:00'), goodTmpDdl('m', '2026-10-23 03:20:00'));
  assert.equal(d.semanticSame, false);
  assert.equal(d.phaseOnly, true);
  assert.equal(maskStarts('STARTS "x"'), 'STARTS "<ts>"');
});

test('diffMvDdl：列变了 → 真漂移，并给出首个差异位置', () => {
  const local = 'CREATE MATERIALIZED VIEW m (a, b) DUPLICATE KEY(a) AS SELECT 1';
  const live = 'CREATE MATERIALIZED VIEW m (a, b, c) DUPLICATE KEY(a) AS SELECT 1';
  const d = diffMvDdl(local, live);
  assert.equal(d.semanticSame, false);
  assert.equal(d.phaseOnly, false);
  assert.ok(d.firstDivergence && d.firstDivergence.index > 0);
  assert.match(d.firstDivergence!.local, /a, b\)/);
});

test('diffMvDdl：注释差异不算漂移（**两边都要剥**）', () => {
  const local = '-- 本地说明\nCREATE MATERIALIZED VIEW m AS SELECT 1';
  const live = 'CREATE MATERIALIZED VIEW m AS WITH -- 线上注释\nx AS (SELECT 1) SELECT * FROM x';
  // 语义不同（体不一样），但注释本身不该被算进差异——用同体不同注释验证
  const a = '-- 注释A\nCREATE MATERIALIZED VIEW m AS SELECT 1';
  const b = 'CREATE MATERIALIZED VIEW m AS SELECT 1 -- 注释B';
  assert.equal(diffMvDdl(a, b).same, true);
  assert.equal(diffMvDdl(local, live).same, false);
});

test('scanMvDrift：四种状态各就各位（含 **table not found** 也算线上缺失）', async () => {
  const good = goodTmpDdl('mv_a');
  const { transport } = stubTransport(
    bySql({
      '`mv_a`': qr([{ View: 'mv_a', 'Create View': good }]),
      '`mv_b`': qr([{ View: 'mv_b', 'Create View': good.replace('SUM(a)', 'SUM(b)') }]),
      '`mv_c`': 'Failed to execute sql: ... table not found, tableName=mv_c',
      '`mv_d`': 'connect timeout',
    }),
  );
  const entries = await scanMvDrift(transport, [
    { name: 'mv_a', ddl: good },
    { name: 'mv_b', ddl: good },
    { name: 'mv_c', ddl: good },
    { name: 'mv_d', ddl: good },
  ]);
  assert.deepEqual(entries.map((e) => e.status), ['same', 'drift', 'missing-live', 'error']);
});

test('scanMvDrift：只有仓库声明过的属性不同 → props-only，不算语义漂移', async () => {
  const good = goodTmpDdl('mv_a');
  const { transport } = stubTransport(() => qr([{ View: 'mv_a', 'Create View': good.replace('"1"', '"3"') }]));
  const [e] = await scanMvDrift(transport, [{ name: 'mv_a', ddl: good }]);
  assert.equal(e.status, 'props-only');
  assert.match(e.detail ?? '', /replication_num/);
});

test('scanMvDrift：只有 STARTS 不同 → phase-only，并带上差异片段', async () => {
  const { transport } = stubTransport(() => qr([{ View: 'mv_a', 'Create View': goodTmpDdl('mv_a', '2099-06-01 03:20:00') }]));
  const [e] = await scanMvDrift(transport, [{ name: 'mv_a', ddl: goodTmpDdl('mv_a', '2099-01-01 03:20:00') }]);
  assert.equal(e.status, 'phase-only');
  assert.match(e.detail ?? '', /仅 STARTS 时刻不同/);
});

test('scanMvDrift：进度回调按序报数', async () => {
  const good = goodTmpDdl('mv_a');
  const { transport } = stubTransport(() => qr([{ View: 'mv_a', 'Create View': good }]));
  const seen: string[] = [];
  await scanMvDrift(transport, [{ name: 'mv_a', ddl: good }, { name: 'mv_a', ddl: good }], {
    onProgress: (i, total, name) => seen.push(`${i}/${total}:${name}`),
  });
  assert.deepEqual(seen, ['1/2:mv_a', '2/2:mv_a']);
});

// ─────────────────────── 依赖链路 ───────────────────────

test('viewBody：抹掉名字与格式，只留定义内容', () => {
  const a = viewBody('CREATE MATERIALIZED VIEW `mv_a` BUILD DEFERRED REFRESH AUTO ON MANUAL AS SELECT 1');
  const b = viewBody('CREATE MATERIALIZED VIEW mv_a   BUILD DEFERRED REFRESH AUTO ON MANUAL AS SELECT   1');
  assert.equal(a, b, '名字与空白差异不该算不同');
  assert.equal(a.includes('mv_a'), false, '名字要被抹掉');
});

test('swapTookEffect：只认"目标定义是否真的变了"（单向确定性证据）', () => {
  const before = 'CREATE MATERIALIZED VIEW mv_a BUILD DEFERRED AS SELECT 1';
  const after = 'CREATE MATERIALIZED VIEW mv_a BUILD DEFERRED AS SELECT 2';
  assert.equal(swapTookEffect(before, after), true);
  // 逐字未变 → 一定没换（这是唯一敢下硬结论的方向）
  assert.equal(swapTookEffect(before, before), false);
  // 只是格式/名字差异 → 不算"变了"（避免误报）
  assert.equal(swapTookEffect(before, 'CREATE MATERIALIZED VIEW `mv_a`  BUILD DEFERRED AS SELECT 1'), false);
  // 注释差异不算
  assert.equal(swapTookEffect(before, 'CREATE MATERIALIZED VIEW mv_a BUILD DEFERRED AS SELECT 1 -- x'), false);
});

test('extractTableRefs：三段式与 FROM/JOIN 裸名都抽出来', () => {
  const refs = extractTableRefs(
    'SELECT * FROM `db`.`tbl`.`up1` JOIN `up2` ON 1 LEFT JOIN `up3` x ON 2',
  );
  assert.deepEqual(refs.sort(), ['up1', 'up2', 'up3']);
});

test('buildGraphFromDdls：同库内的 MV 才算边；不出现自环', () => {
  const graph = buildGraphFromDdls([
    { name: 'a', ddl: 'CREATE MATERIALIZED VIEW a AS SELECT * FROM `b`' },
    { name: 'b', ddl: 'CREATE MATERIALIZED VIEW b AS SELECT * FROM `outside_tbl`' },
    { name: 'c', ddl: 'CREATE MATERIALIZED VIEW c AS SELECT * FROM `a` JOIN `c` ON 1' },
  ]);
  assert.deepEqual(graph.get('a')?.reads, ['b']);
  assert.deepEqual(graph.get('b')?.reads, []);
  assert.deepEqual(graph.get('c')?.reads, ['a']); // 自环被排掉
  assert.deepEqual(graph.get('a')?.readBy, ['c']);
  assert.deepEqual(graph.get('b')?.readBy, ['a']);
});

test('downstreamOf：递归取下游，重复路径只算一次', () => {
  const graph = buildGraphFromDdls([
    { name: 'a', ddl: 'CREATE MATERIALIZED VIEW a AS SELECT 1' },
    { name: 'b', ddl: 'CREATE MATERIALIZED VIEW b AS SELECT * FROM `a`' },
    { name: 'c', ddl: 'CREATE MATERIALIZED VIEW c AS SELECT * FROM `b`' },
    { name: 'd', ddl: 'CREATE MATERIALIZED VIEW d AS SELECT * FROM `a` JOIN `c` ON 1' },
  ]);
  assert.deepEqual(downstreamOf('a', graph).sort(), ['b', 'c', 'd']);
  assert.deepEqual(downstreamOf('d', graph), []);
});

test('buildMvGraph：逐张读 DDL 建图；单张读不到不影响整图', async () => {
  const { transport, calls } = stubTransport(
    bySql({
      'mv_infos': qr([{ Name: 'a', State: 'NORMAL', RefreshState: 'SUCCESS' }, { Name: 'b', State: 'NORMAL', RefreshState: 'SUCCESS' }]),
      '`a`': qr([{ View: 'a', 'Create View': 'CREATE MATERIALIZED VIEW a AS SELECT * FROM `b`' }]),
      '`b`': 'read failed',
    }),
  );
  const { graph, infos } = await buildMvGraph(transport, 'demo_db');
  assert.equal(infos.length, 2);
  assert.deepEqual(graph.get('a')?.reads, ['b']);
  assert.equal(calls.filter((c) => c.sql.startsWith('SHOW CREATE')).length, 2);
});

test('buildMvGraph：limit 只影响读 DDL 的张数，清单仍是全量', async () => {
  const { transport, calls } = stubTransport(
    bySql({
      'mv_infos': qr([{ Name: 'a' }, { Name: 'b' }, { Name: 'c' }]),
      'SHOW CREATE': qr([{ View: 'x', 'Create View': 'CREATE MATERIALIZED VIEW x AS SELECT 1' }]),
    }),
  );
  const { infos } = await buildMvGraph(transport, 'demo_db', { limit: 1 });
  assert.equal(infos.length, 3);
  assert.equal(calls.filter((c) => c.sql.startsWith('SHOW CREATE')).length, 1);
});

test('onCommitRisk：从下游 DDL 里认出 ON COMMIT —— 换基表后唯一可靠依据', async () => {
  const { transport } = stubTransport(
    bySql({
      '`a`': qr([{ View: 'a', 'Create View': 'CREATE MATERIALIZED VIEW a AS SELECT 1' }]),
      '`b`': qr([{ View: 'b', 'Create View': 'CREATE MATERIALIZED VIEW b REFRESH AUTO ON COMMIT AS SELECT * FROM `a`' }]),
      '`c`': qr([{ View: 'c', 'Create View': 'CREATE MATERIALIZED VIEW c REFRESH AUTO ON SCHEDULE EVERY 1 HOUR AS SELECT * FROM `b`' }]),
    }),
  );
  const graph = buildGraphFromDdls([
    { name: 'a', ddl: 'CREATE MATERIALIZED VIEW a AS SELECT 1' },
    { name: 'b', ddl: 'CREATE MATERIALIZED VIEW b AS SELECT * FROM `a`' },
    { name: 'c', ddl: 'CREATE MATERIALIZED VIEW c AS SELECT * FROM `b`' },
  ]);
  const r = await onCommitRisk(transport, 'a', graph);
  assert.deepEqual(r.downstream.sort(), ['b', 'c']);
  assert.deepEqual(r.onCommit, ['b']);
});

test('onCommitRisk：读不到下游 DDL 时不猜（宁可漏报也不误报）', async () => {
  const { transport } = stubTransport(() => 'read failed');
  const graph = buildGraphFromDdls([
    { name: 'a', ddl: 'CREATE MATERIALIZED VIEW a AS SELECT 1' },
    { name: 'b', ddl: 'CREATE MATERIALIZED VIEW b AS SELECT * FROM `a`' },
  ]);
  const r = await onCommitRisk(transport, 'a', graph);
  assert.deepEqual(r.downstream, ['b']);
  assert.deepEqual(r.onCommit, []);
});

// ─────────────────────── 分区 MTMV 建表硬限制（memory: doris-mtmv-selfjoin-view-limits） ───────────────────────

const partHead = 'CREATE MATERIALIZED VIEW `db`.`mv` BUILD DEFERRED REFRESH AUTO ON SCHEDULE EVERY 1 HOUR\nPARTITION BY (`dt`) ()\nDISTRIBUTED BY HASH(`dt`) BUCKETS 3\nPROPERTIES ("replication_num" = "1")\n';

test('lintPartitionedBody：UNION 无条件阻断', () => {
  const f = lintPartitionedBody('SELECT a FROM t1 UNION ALL SELECT a FROM t2');
  assert.equal(f[0].code, 'E_PARTITION_UNION');
  assert.equal(f[0].level, 'error');
  assert.match(f[0].hint ?? '', /LogicalUnion/);
});

test('lintPartitionedBody：CTE 只引用 1 次放行，引用 ≥2 次报锚点', () => {
  assert.deepEqual(cteNamesReferencedTwice('WITH c AS (SELECT 1 AS x) SELECT x FROM c'), []);
  assert.deepEqual(cteNamesReferencedTwice('WITH c AS (SELECT 1 AS x) SELECT a.x FROM c a JOIN c b ON a.x=b.x'), ['c']);
  const f = lintPartitionedBody('WITH c AS (SELECT 1 AS x) SELECT a.x FROM c a JOIN c b ON a.x=b.x');
  assert.equal(f[0].code, 'E_PARTITION_CTE_ANCHOR');
  assert.match(f[0].message, /`c` 被引用 ≥2 次/);
});

test('cteNamesReferencedTwice：多个 CTE 各自独立计数', () => {
  const body = 'WITH a AS (SELECT 1 AS x), b AS (SELECT 2 AS y) SELECT p.x, q.y, r.y FROM a p JOIN b q ON 1=1 JOIN b r ON 1=1';
  assert.deepEqual(cteNamesReferencedTwice(body), ['b']);
});

test('cteNamesReferencedTwice：没有 WITH 就返回空', () => {
  assert.deepEqual(cteNamesReferencedTwice('SELECT 1 FROM t'), []);
});

test('lintPartitionedBody：引用 VIEW 报错（限定名/裸名/CREATE VIEW 都认）', () => {
  assert.equal(lintPartitionedBody('SELECT * FROM `db`.`my_view`')[0].code, 'E_PARTITION_VIEW');
  assert.equal(lintPartitionedBody('SELECT * FROM my_view')[0].code, 'E_PARTITION_VIEW');
  assert.equal(lintPartitionedBody('SELECT * FROM t1 JOIN `d`.`a_view` ON 1=1')[0].code, 'E_PARTITION_VIEW');
  assert.equal(lintPartitionedBody('CREATE VIEW x AS SELECT 1')[0].code, 'E_PARTITION_VIEW');
});

test('namesLookLikeView：只看限定名最后一段，且要求以 view 结尾', () => {
  assert.equal(namesLookLikeView('SELECT * FROM `db`.`my_view`'), true);
  assert.equal(namesLookLikeView('SELECT * FROM `db`.`view_log`'), false);
  assert.equal(namesLookLikeView('SELECT * FROM `db`.`view`'), true);
  assert.equal(namesLookLikeView('SELECT * FROM t'), false);
});

test('lintPartitionedBody：名字里带 view 但**不以 view 结尾**的表不误报（error 级不能错杀）', () => {
  assert.deepEqual(lintPartitionedBody('SELECT * FROM `db`.`view_log`'), []);
  assert.deepEqual(lintPartitionedBody('SELECT * FROM `db`.`order_view_log`'), []);
  assert.deepEqual(lintPartitionedBody('SELECT * FROM vw_order'), []);
  assert.deepEqual(lintPartitionedBody('SELECT * FROM `db`.`my_view2`'), []);
});

test('tablesReferencedTwice：同一张表 JOIN 两次才算 self join 信号', () => {
  assert.deepEqual(tablesReferencedTwice('SELECT * FROM `a` JOIN `b` ON 1=1'), []);
  assert.deepEqual(tablesReferencedTwice('SELECT * FROM `a` JOIN `a` ON 1=1'), ['a']);
  // 带库名的 3 段式不当作表名
  assert.deepEqual(tablesReferencedTwice('SELECT * FROM `db`.`a`.`up1`'), []);
});

test('lintPartitionedBody：重复 JOIN 只给 warn（自连接未分区表是允许的）', () => {
  const f = lintPartitionedBody('SELECT * FROM `dwd_order` o1 JOIN `dwd_order` o2 ON 1=1');
  assert.equal(f[0].code, 'W_PARTITION_SELF_JOIN');
  assert.equal(f[0].level, 'warn');
  assert.match(f[0].hint ?? '', /未分区/);
});

test('partitionCommentTrap：PARTITION BY (...) 紧跟 COMMENT 才命中', () => {
  assert.equal(partitionCommentTrap("PARTITION BY (`dt`) () COMMENT 'x'"), true);
  assert.equal(partitionCommentTrap('PARTITION BY (`dt`) () DISTRIBUTED BY HASH(`dt`)'), false);
  assert.equal(partitionCommentTrap('PARTITION BY (`dt`) ()'), false);
});

test('partitionCommentTrap：没有 PARTITION BY 直接 false；嵌套括号要配对', () => {
  assert.equal(partitionCommentTrap('DISTRIBUTED BY HASH(`dt`)'), false);
  assert.equal(partitionCommentTrap("PARTITION BY (date_trunc(`dt`, 'day')) () COMMENT 'x'"), true);
});

test('lintMvDdl：不带 PARTITION BY 的 MV 不查分区硬限制（线上真有这种 MV）', () => {
  const ddl =
    'CREATE MATERIALIZED VIEW `db`.`mv` BUILD DEFERRED REFRESH AUTO ON SCHEDULE EVERY 1 HOUR\n' +
    'DISTRIBUTED BY HASH(`dt`) BUCKETS 3\nPROPERTIES ("replication_num" = "1")\n' +
    'AS SELECT a FROM t1 UNION ALL SELECT a FROM t2';
  assert.deepEqual(lintMvDdl(ddl, { now: NOW }).filter((f) => f.code.startsWith('E_PARTITION_')), []);
});

test('lintMvDdl：带 PARTITION BY 才把 UNION 揪出来', () => {
  const ddl = partHead + 'AS SELECT a FROM t1 UNION ALL SELECT a FROM t2';
  assert.ok(lintMvDdl(ddl, { now: NOW }).some((f) => f.code === 'E_PARTITION_UNION'));
});

test('lintMvDdl：CREATE 里 REFRESH COMPLETE 会被钉死 → 告警（与语句级 REFRESH ... COMPLETE 区分）', () => {
  const ddl =
    'CREATE MATERIALIZED VIEW `db`.`mv` BUILD DEFERRED REFRESH COMPLETE ON SCHEDULE EVERY 1 HOUR\n' +
    'DISTRIBUTED BY HASH(`dt`) BUCKETS 3\nPROPERTIES ("replication_num" = "1")\nAS SELECT a FROM t1';
  const f = lintMvDdl(ddl, { now: NOW }).find((x) => x.code === 'W_REFRESH_COMPLETE_PINNED');
  assert.ok(f);
  assert.match(f.message, /钉死/);
  assert.match(f.hint ?? '', /REFRESH MATERIALIZED VIEW/);
});

test('lintMvDdl：REFRESH AUTO 不触发钉死告警', () => {
  const ddl =
    'CREATE MATERIALIZED VIEW `db`.`mv` BUILD DEFERRED REFRESH AUTO ON SCHEDULE EVERY 1 HOUR\n' +
    'DISTRIBUTED BY HASH(`dt`) BUCKETS 3\nPROPERTIES ("replication_num" = "1")\nAS SELECT a FROM t1';
  assert.deepEqual(lintMvDdl(ddl, { now: NOW }).filter((x) => x.code === 'W_REFRESH_COMPLETE_PINNED'), []);
});

test('lintMvDdl：PARTITION BY 后紧跟 COMMENT 报错', () => {
  const ddl = partHead.replace('DISTRIBUTED', "COMMENT 'mv' DISTRIBUTED");
  assert.ok(lintMvDdl(ddl, { now: NOW }).some((f) => f.code === 'E_PARTITION_COMMENT_ORDER'));
});

test('lintMvDdl：除法检查先剥注释——注释里写 a/b 不该报警', () => {
  const ddl =
    'CREATE MATERIALIZED VIEW `db`.`mv` BUILD DEFERRED REFRESH AUTO ON SCHEDULE EVERY 1 HOUR\n' +
    'DISTRIBUTED BY HASH(`dt`) BUCKETS 3\nPROPERTIES ("replication_num" = "1")\n' +
    'AS SELECT -- 这里 a/b 是注释\n a FROM t1';
  assert.deepEqual(lintMvDdl(ddl, { now: NOW }).filter((f) => f.code === 'W_DECIMAL_DIVISION'), []);
});
