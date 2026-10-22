/**
 * dw 慢查询与 profile 诊断单测。
 * 两条口径：audit_log 找"哪些查询慢"，SHOW QUERY PROFILE 取单条详情；
 * MV 改写诊断要能区分"看见但没用"与"压根没看见"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnoseMvRewrite,
  diffProfiles,
  extractRewriteFailures,
  findProfilePath,
  getProfileText,
  listQueryStats,
  normalizeProfileText,
  queryHistory,
} from '../../packages/core/src/dw/profile.ts';
import { bySql, qr, stubTransport } from './dw-helpers.ts';

// ─────────────────────── 审计日志 ───────────────────────

test('listQueryStats：查 audit_log，带时间窗/条数/慢阈值/失败过滤', async () => {
  const { transport, calls } = stubTransport(() =>
    qr([
      {
        query_id: 'q1', time: '2026-10-22 10:00:00', user: 'root', db: 'demo_db', state: 'EOF',
        query_time: '90627', scan_rows: '2572', scan_bytes: '1024', cpu_time_ms: '10',
        peak_memory_bytes: '2048', sql_digest: 'd1', stmt: 'SELECT 1',
      },
    ]),
  );
  const stats = await listQueryStats(transport, { hours: 2, limit: 5, minMs: 1000, failedOnly: true, db: 'demo_db', user: 'root' });
  assert.equal(stats[0].queryId, 'q1');
  assert.equal(stats[0].queryTimeMs, 90627);
  assert.equal(stats[0].scanRows, 2572);
  assert.equal(stats[0].peakMemoryBytes, 2048);
  assert.match(calls[0].sql, /__internal_schema\.audit_log/);
  assert.match(calls[0].sql, /INTERVAL 2 HOUR/);
  assert.match(calls[0].sql, /is_query = 1/);
  assert.match(calls[0].sql, /query_time >= 1000/);
  assert.match(calls[0].sql, /state = 'ERR'/);
  assert.match(calls[0].sql, /db = 'demo_db'/);
  assert.match(calls[0].sql, /ORDER BY query_time DESC LIMIT 5/);
});

test('listQueryStats：老版本缺列时自动退到最小列集', async () => {
  const { transport, calls } = stubTransport((sql) =>
    sql.includes('sql_digest') ? 'Unknown column sql_digest' : qr([{ query_id: 'q1', query_time: '10' }]),
  );
  const stats = await listQueryStats(transport);
  assert.equal(stats.length, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /sql_digest/);
  assert.equal(calls[1].sql.includes('sql_digest'), false);
});

test('listQueryStats：两次都失败时给出"审计插件未开"的指引', async () => {
  const { transport } = stubTransport(() => 'table not found');
  await assert.rejects(
    () => listQueryStats(transport),
    (e: unknown) => {
      assert.equal((e as { code: string }).code, 'E_UPSTREAM');
      assert.match((e as Error).message, /audit_plugin_enabled/);
      return true;
    },
  );
});

test('listQueryStats：默认脱敏 SQL 原文，--raw 回原值', async () => {
  const rows = [{ query_id: 'q1', stmt: "SELECT * FROM t WHERE password = 'p@ss'" }];
  const masked = await listQueryStats(stubTransport(() => qr(rows)).transport);
  assert.match(masked[0].stmt ?? '', /password = '\*\*\*'/);
  const raw = await listQueryStats(stubTransport(() => qr(rows)).transport, { raw: true });
  assert.match(raw[0].stmt ?? '', /p@ss/);
});

test('listQueryStats：默认 24 小时 / 30 条，且不带多余过滤', async () => {
  const { transport, calls } = stubTransport(() => qr());
  await listQueryStats(transport);
  assert.match(calls[0].sql, /INTERVAL 24 HOUR/);
  assert.match(calls[0].sql, /LIMIT 30/);
  assert.equal(calls[0].sql.includes('query_time >='), false);
  assert.equal(calls[0].sql.includes("state = 'ERR'"), false);
});

test('queryHistory：按 sql_digest 分组，给次数/均值/最大值/最近一次', async () => {
  const { transport, calls } = stubTransport(() =>
    qr([{ sql_digest: 'd1', runs: '10', avg_ms: '5396.4', max_ms: '6835', last_time: '2026-10-22 10:44:03', sample: 'SELECT password FROM t' }]),
  );
  const rows = await queryHistory(transport, 'dws_all_sales', { days: 3, limit: 5 });
  assert.equal(rows[0].runs, 10);
  assert.equal(rows[0].avgMs, 5396);
  assert.equal(rows[0].maxMs, 6835);
  assert.match(rows[0].sample ?? '', /password FROM/); // 默认脱敏
  assert.match(calls[0].sql, /stmt LIKE '%dws_all_sales%'/);
  assert.match(calls[0].sql, /INTERVAL 3 DAY/);
  assert.match(calls[0].sql, /GROUP BY sql_digest/);
});

test('queryHistory：上游失败抛 E_UPSTREAM', async () => {
  await assert.rejects(() => queryHistory(stubTransport(() => 'x').transport, 'a'), /查询 audit_log 历史失败/);
});

// ─────────────────────── 单条 profile ───────────────────────

test('findProfilePath：从 SHOW QUERY PROFILE "/" 的列表里按 query_id 找路径', async () => {
  const { transport } = stubTransport(() =>
    qr([
      { Path: '/<fe-host>_9030/20261022/aaa' },
      { Path: '/<fe-host>_9030/20261022/bbb-q1-ccc' },
    ]),
  );
  assert.equal(await findProfilePath(transport, 'q1'), '/<fe-host>_9030/20261022/bbb-q1-ccc');
  assert.equal(await findProfilePath(transport, 'nope'), undefined);
});

test('findProfilePath：返回的相对路径补上前导斜杠', async () => {
  const { transport } = stubTransport(() => qr([{ Path: 'rel/q1' }]));
  assert.equal(await findProfilePath(transport, 'q1'), '/rel/q1');
});

test('getProfileText：先找路径再取内容，默认脱敏', async () => {
  const { transport, calls } = stubTransport(
    bySql({
      'SHOW QUERY PROFILE "/"': qr([{ Path: '/p/q1' }]),
      "SHOW QUERY PROFILE '/p/q1'": qr([{ 'Profile Text': 'detail password=p@ss' }]),
    }),
  );
  const r = await getProfileText(transport, 'q1');
  assert.equal(r.path, '/p/q1');
  assert.match(r.text, /password=\*\*\*/);
  assert.equal(r.masked, 1);
  assert.equal(calls.length, 2);
});

test('getProfileText：--raw 回原值；找不到路径时说明 profile 有保留上限', async () => {
  const raw = await getProfileText(
    stubTransport(bySql({ 'SHOW QUERY PROFILE "/"': qr([{ Path: '/p/q1' }]), "'/p/q1'": qr([{ t: 'password=x' }]) })).transport,
    'q1',
    { raw: true },
  );
  assert.equal(raw.masked, 0);
  assert.match(raw.text, /password=x/);

  await assert.rejects(
    () => getProfileText(stubTransport(() => qr([{ Path: '/other' }])).transport, 'q1'),
    /FE 上没有 q1 的 profile 文件.*保留有限条数/s,
  );
});

test('getProfileText：SHOW QUERY PROFILE 失败时透出原因', async () => {
  const { transport } = stubTransport(
    bySql({ 'SHOW QUERY PROFILE "/"': 'boom' }),
  );
  await assert.rejects(() => getProfileText(transport, 'q1'), /SHOW QUERY PROFILE 失败/);
});

// ─────────────────────── 结构对比 ───────────────────────

test('normalizeProfileText：抹掉耗时/时间戳/长数字，只留结构', () => {
  const lines = normalizeProfileText('ExecTime: 123.456ms  at 2026-10-22 10:00:00  rows 1234567\n\n');
  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'ExecTime: <t> at <ts> rows <n>');
});

test('diffProfiles：**只比结构**——慢查询多出来的算子才可疑', () => {
  const fast = 'HASH_JOIN\nSCAN t1\nExecTime 10ms';
  const slow = 'HASH_JOIN\nSCAN t1\nSORT\nExecTime 9999ms';
  const lines = diffProfiles(fast, slow);
  assert.deepEqual(lines.filter((l) => l.kind === 'only-b').map((l) => l.text), ['SORT']);
  assert.deepEqual(lines.filter((l) => l.kind === 'only-a'), []);
  assert.equal(lines.some((l) => l.kind === 'same' && l.text === 'HASH_JOIN'), true);
});

test('diffProfiles：重复行给出次数差；结果可限长', () => {
  const lines = diffProfiles('A\nA\nA', 'A');
  assert.equal(lines[0].kind, 'only-a');
  assert.match(lines[0].text, /×2/);
  assert.equal(diffProfiles('A\nB\nC', 'X\nY\nZ', { limit: 1 }).length, 1);
});

test('diffProfiles：空输入不炸', () => {
  assert.deepEqual(diffProfiles('', ''), []);
});

// ─────────────────────── MV 改写诊断 ───────────────────────

test('diagnoseMvRewrite：有 RewriteFail → 未命中，并给出可操作的原因', () => {
  const d = diagnoseMvRewrite(
    'MaterializedViewRewriteFail:\n  internal.<db>.mv_a fail,\n  FailSummary: View original struct info is invalid\n\n========== STATISTICS ==========',
  );
  assert.equal(d.mentioned, true);
  assert.equal(d.rewritten, false);
  assert.equal(d.reasons.length, 1);
  // **原因在标题行的下一行**，只留标题等于什么都没说
  assert.match(d.reasons[0], /mv_a fail/);
  assert.match(d.reasons[0], /View original struct info is invalid/);
  assert.match(d.hint ?? '', /dw mv list --abnormal/);
});

test('extractRewriteFailures：多处失败各自成条，标题不被重复收进', () => {
  const text = [
    'MaterializedViewRewriteFail:',
    '  mv_a fail,',
    '  FailSummary: reason A',
    '',
    'MaterializedViewRewriteFail:',
    '  mv_b fail,',
    '  FailSummary: reason B',
  ].join('\n');
  const r = extractRewriteFailures(text);
  assert.equal(r.length, 2);
  assert.match(r[0], /reason A/);
  assert.match(r[1], /reason B/);
  assert.equal(r[0].match(/MaterializedViewRewriteFail/g)?.length, 1);
});

test('extractRewriteFailures：limit 生效，且空文本给空数组', () => {
  const text = Array.from({ length: 30 }, (_, i) => `MaterializedViewRewriteFail:\n  mv_${i}`).join('\n');
  assert.equal(extractRewriteFailures(text, 3).length, 3);
  assert.deepEqual(extractRewriteFailures(''), []);
});

test('diagnoseMvRewrite：命中成功 → 指出性能问题不在改写', () => {
  const d = diagnoseMvRewrite('MaterializedViewRewriteSuccess: mv_a\nSCAN mv_a');
  assert.equal(d.rewritten, true);
  assert.match(d.hint ?? '', /去 profile 里看算子/);
});

test('diagnoseMvRewrite：**压根没提到物化视图**是另一类问题', () => {
  const d = diagnoseMvRewrite('SCAN t1\nAGGREGATE');
  assert.equal(d.mentioned, false);
  assert.equal(d.rewritten, false);
  assert.match(d.hint ?? '', /CBO 根本没看到候选/);
});

test('diagnoseMvRewrite：提到但既无成功也无失败行 → 要求看完整 EXPLAIN', () => {
  const d = diagnoseMvRewrite('materialized view candidate: mv_a');
  assert.equal(d.mentioned, true);
  assert.equal(d.rewritten, false);
  assert.equal(d.reasons.length, 0);
  assert.match(d.hint ?? '', /完整 EXPLAIN/);
});

test('diagnoseMvRewrite：失败原因最多列 20 条（免得把输出刷爆）', () => {
  const text = Array.from({ length: 50 }, (_, i) => `MaterializedViewRewriteFail:\n  mv_${i}`).join('\n');
  assert.equal(diagnoseMvRewrite(text).reasons.length, 20);
});

test('diagnoseMvRewrite：空 EXPLAIN 不炸', () => {
  const d = diagnoseMvRewrite('');
  assert.equal(d.mentioned, false);
  assert.match(d.hint ?? '', /CVM|CBO/);
});
