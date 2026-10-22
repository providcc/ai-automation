/**
 * dw 传输层单测：Doris `result_set` 解析、FE HTTP 信封、cmd 逃生通道。
 * fetch 与子进程全部打桩，不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CmdWarehouseTransport,
  HttpWarehouseTransport,
  columnarToRows,
  databaseContext,
  defaultCmdRunner,
  envelopeError,
  extractRows,
  resultSetTimeMs,
  resultSetToRows,
} from '../../packages/core/src/dw/transport.ts';
import { envFixture } from './dw-helpers.ts';

// ─────────────────────── 结果集解析 ───────────────────────

test('resultSetToRows：Doris 的 result_set 是**位置式**数组，列名只在 meta 里', () => {
  const r = resultSetToRows({
    type: 'result_set',
    meta: [{ name: 'version', type: 'VARCHAR' }, { name: 'n', type: 'TINYINT' }],
    data: [['5.7.99', 1], ['x', 2]],
    time: 5,
  });
  assert.deepEqual(r?.columns, ['version', 'n']);
  assert.deepEqual(r?.rows, [{ version: '5.7.99', n: 1 }, { version: 'x', n: 2 }]);
});

test('resultSetToRows：meta 缺 name 时退化为 col_i，短行不炸', () => {
  const r = resultSetToRows({ type: 'result_set', meta: [{}, { name: 'b' }], data: [[1]] });
  assert.deepEqual(r?.columns, ['col_0', 'b']);
  assert.deepEqual(r?.rows, [{ col_0: 1 }]);
});

test('resultSetToRows：非 result_set 一律 undefined（交给别的解析器）', () => {
  assert.equal(resultSetToRows({ type: 'exec_status', status: {} }), undefined);
  assert.equal(resultSetToRows(undefined), undefined);
  assert.equal(resultSetToRows('str'), undefined);
  assert.equal(resultSetToRows({ type: 'result_set' }), undefined);
});

test('extractRows：先认 result_set，再退列式与 {rows}/{data:[...]}', () => {
  // result_set 优先——把它当列式解析会得到 type/meta/data/time 四个假列
  const rs = extractRows({ data: { type: 'result_set', meta: [{ name: 'a' }], data: [[7]] } });
  assert.deepEqual(rs, { columns: ['a'], rows: [{ a: 7 }] });

  const rowsShape = extractRows({ rows: [{ a: 1 }], columns: [{ name: 'a' }] });
  assert.deepEqual(rowsShape.columns, ['a']);

  const rowsNoCols = extractRows({ rows: [{ a: 1, b: 2 }] });
  assert.deepEqual(rowsNoCols.columns, ['a', 'b']);

  const dataArr = extractRows({ data: [{ a: 1 }] });
  assert.deepEqual(dataArr.columns, ['a']);

  const columnar = extractRows({ data: { a: [1, 2], b: ['x', 'y'] } });
  assert.deepEqual(columnar.rows, [{ a: 1, b: 'x' }, { a: 2, b: 'y' }]);

  assert.deepEqual(extractRows(null), { columns: [], rows: [] });
  assert.deepEqual(extractRows({}), { columns: [], rows: [] });
});

test('columnarToRows：数组形态与空对象都安全', () => {
  assert.deepEqual(columnarToRows([{ a: 1 }]).columns, ['a']);
  assert.deepEqual(columnarToRows({}), { columns: [], rows: [] });
  assert.deepEqual(columnarToRows({ a: [1], b: [] }).rows, [{ a: 1, b: undefined }]);
  assert.deepEqual(columnarToRows(42), { columns: [], rows: [] });
});

test('resultSetTimeMs：只认 data.time 数字', () => {
  assert.equal(resultSetTimeMs({ data: { time: 12 } }), 12);
  assert.equal(resultSetTimeMs({ data: { time: '12' } }), undefined);
  assert.equal(resultSetTimeMs({ data: {} }), undefined);
  assert.equal(resultSetTimeMs(null), undefined);
});

test('envelopeError：FE 的 msg 常常只有 "Error"，真原因在 data 里', () => {
  // 实测形态：{ msg: "Error", code: 1, data: "Failed to execute sql: ... mismatched input 'LIMIT'" }
  assert.match(
    envelopeError({ msg: 'Error', code: 1, data: 'Failed to execute sql: mismatched input LIMIT' }) ?? '',
    /mismatched input LIMIT/,
  );
  // msg 有实质内容时两者都要带上
  assert.match(envelopeError({ msg: 'Unauthorized', data: 'detail here' }) ?? '', /Unauthorized: detail here/);
  // 只有 msg
  assert.equal(envelopeError({ msg: 'Unauthorized' }), 'Unauthorized');
  // 什么都没有
  assert.equal(envelopeError({}), undefined);
  assert.equal(envelopeError(null), undefined);
  // data 不是字符串时不当错误文本用
  assert.equal(envelopeError({ msg: 'Error', data: { a: 1 } }), 'Error');
});

test('databaseContext：未配置库时落到 information_schema（配合三段式命名）', () => {
  assert.equal(databaseContext({ database: 'demo_db' }), 'demo_db');
  assert.equal(databaseContext({ database: undefined }), 'information_schema');
});

// ─────────────────────── HTTP 传输 ───────────────────────

/** 临时替换 globalThis.fetch，返回响应体文本。 */
async function withFetch(
  body: string,
  fn: () => Promise<void>,
  over: { status?: number; capture?: (url: string, init: RequestInit) => void } = {},
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    over.capture?.(String(url), init);
    return new Response(body, { status: over.status ?? 200 });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('HTTP 传输：请求体必须是 JSON {stmt}，Content-Type 是 application/json', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const body = JSON.stringify({
    code: 0,
    msg: 'success',
    data: { type: 'result_set', meta: [{ name: 'version' }], data: [['5.7.99']], time: 4 },
  });
  await withFetch(
    body,
    async () => {
      const t = new HttpWarehouseTransport(envFixture(), { host: 'dw-host', port: 8030 });
      const r = await t.run('SELECT VERSION()');
      assert.equal(r.ok, true);
      assert.deepEqual(r.rows, [{ version: '5.7.99' }]);
      assert.equal(r.execTimeMs, 4);
    },
    { capture: (url, init) => { seen = { url, init }; } },
  );
  assert.equal(seen?.url, 'http://dw-host:8030/api/query/internal/demo_db');
  assert.equal(seen?.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(seen?.init.body)), { stmt: 'SELECT VERSION()' });
  const headers = seen?.init.headers as Record<string, string>;
  assert.equal(headers['Content-Type'], 'application/json');
  assert.match(headers.Authorization, /^Basic /);
});

test('HTTP 传输：业务失败也回 HTTP 200，靠 code 判定，并把 data 里的原因带出来', async () => {
  const body = JSON.stringify({
    msg: 'Error',
    code: 1,
    data: "Failed to execute sql: java.sql.SQLException: mismatched input 'LIMIT'",
  });
  await withFetch(body, async () => {
    const t = new HttpWarehouseTransport(envFixture(), { host: 'dw-host', port: 8030 });
    const r = await t.run('SHOW TABLES LIMIT 1');
    assert.equal(r.ok, false);
    assert.equal(r.code, 1);
    assert.match(r.msg ?? '', /mismatched input 'LIMIT'/);
    assert.deepEqual(r.rows, []);
  });
});

test('HTTP 传输：401 也是 HTTP 200 + code 401，msg 直接可用', async () => {
  await withFetch(JSON.stringify({ msg: 'Unauthorized', code: 401, data: '', count: 0 }), async () => {
    const t = new HttpWarehouseTransport(envFixture(), { host: 'dw-host', port: 8030 });
    const r = await t.run('SELECT 1');
    assert.equal(r.ok, false);
    assert.equal(r.code, 401);
    assert.equal(r.msg, 'Unauthorized');
  });
});

test('HTTP 传输：非 JSON 响应给出 HTTP 状态与片段，便于排查', async () => {
  await withFetch('<html>502 Bad Gateway</html>', async () => {
    const t = new HttpWarehouseTransport(envFixture(), { host: 'dw-host', port: 8030 });
    await assert.rejects(() => t.run('SELECT 1'), /不是 JSON（HTTP 200）.*502 Bad Gateway/s);
  });
});

test('HTTP 传输：dry-run 不发请求；URL 里 catalog 与库都被编码', async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
  try {
    const t = new HttpWarehouseTransport(envFixture({ catalog: 'cat', database: 'db x' }), { host: 'h', port: 1 });
    const r = await t.run('SELECT 1', { dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(called, false);
    assert.equal(r.request.url, 'http://h:1/api/query/cat/db%20x');
  } finally {
    globalThis.fetch = original;
  }
});

test('HTTP 传输：超时转成明确提示（长任务要放大 --timeout）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  }) as typeof fetch;
  try {
    const t = new HttpWarehouseTransport(envFixture(), { host: 'h', port: 1 });
    await assert.rejects(() => t.run('SELECT 1', { timeoutMs: 10 }), /查询超时（10ms）.*--timeout/s);
  } finally {
    globalThis.fetch = original;
  }
});

test('HTTP 传输：网络错误提示先查隧道', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  try {
    const t = new HttpWarehouseTransport(envFixture(), { host: 'h', port: 1 });
    await assert.rejects(() => t.run('SELECT 1'), /请求 FE 失败.*dw tunnel status/s);
  } finally {
    globalThis.fetch = original;
  }
});

test('HTTP 传输：describe 只回端点与库，**不含凭据**', () => {
  const t = new HttpWarehouseTransport(envFixture({ password: '<secret>' }), { host: 'h', port: 9 });
  const d = t.describe();
  assert.equal(d.transport, 'http');
  assert.equal(d.endpoint, 'h:9');
  assert.equal(JSON.stringify(d).includes('<secret>'), false);
});

test('HTTP 传输：probe 走 SELECT VERSION()', async () => {
  let sql = '';
  const original = globalThis.fetch;
  globalThis.fetch = (async (_u: string | URL, init: RequestInit) => {
    sql = String(JSON.parse(String(init.body)).stmt);
    return new Response(JSON.stringify({ code: 0, msg: 'success', data: { type: 'result_set', meta: [{ name: 'v' }], data: [['x']] } }));
  }) as typeof fetch;
  try {
    await new HttpWarehouseTransport(envFixture(), { host: 'h', port: 1 }).probe();
    assert.match(sql, /SELECT VERSION\(\) AS version/);
  } finally {
    globalThis.fetch = original;
  }
});

// ─────────────────────── cmd 传输 ───────────────────────

test('cmd 传输：未配命令模板直接拒绝', () => {
  assert.throws(() => new CmdWarehouseTransport(envFixture(), async () => ({ code: 0, stdout: '', stderr: '' })), /未配置命令模板/);
});

test('cmd 传输：{sql} 作为**单个 argv 元素**替换，不经 shell', async () => {
  const seen: string[][] = [];
  const t = new CmdWarehouseTransport(
    envFixture({ transport: 'cmd', cmd: 'mytool --env {env} --sql {sql}' }),
    async (_cmd, args) => {
      seen.push(args);
      return { code: 0, stdout: JSON.stringify({ rows: [{ a: 1 }] }), stderr: '' };
    },
  );
  const r = await t.run('SELECT 1; DROP TABLE t');
  assert.equal(r.ok, true);
  assert.deepEqual(seen[0], ['--env', 'test', '--sql', 'SELECT 1; DROP TABLE t']);
});

test('cmd 传输：模板没有 {sql} 时把 SQL 追加为最后一个参数', async () => {
  const seen: string[][] = [];
  const t = new CmdWarehouseTransport(envFixture({ transport: 'cmd', cmd: 'mytool --json' }), async (_c, args) => {
    seen.push(args);
    return { code: 0, stdout: '{}', stderr: '' };
  });
  await t.run('SELECT 1');
  assert.deepEqual(seen[0], ['--json', 'SELECT 1']);
});

test('cmd 传输：dry-run 不执行；非零退出码把 stdout 也当线索', async () => {
  let ran = false;
  const t = new CmdWarehouseTransport(envFixture({ transport: 'cmd', cmd: 'x {sql}' }), async () => {
    ran = true;
    return { code: 0, stdout: '', stderr: '' };
  });
  await t.run('SELECT 1', { dryRun: true });
  assert.equal(ran, false);

  const failing = new CmdWarehouseTransport(envFixture({ transport: 'cmd', cmd: 'x {sql}' }), async () => ({
    code: 3,
    stdout: 'SQL syntax error here',
    stderr: '',
  }));
  await assert.rejects(() => failing.run('SELECT 1'), /外部命令失败（退出码 3）：SQL syntax error here/);
});

test('cmd 传输：空输出、非 JSON 输出、{ok:false} 三种形态都能收敛', async () => {
  const mk = (stdout: string) =>
    new CmdWarehouseTransport(envFixture({ transport: 'cmd', cmd: 'x {sql}' }), async () => ({ code: 0, stdout, stderr: '' }));

  const empty = await mk('   ').run('SELECT 1');
  assert.deepEqual(empty.rows, []);

  const text = await mk('line1\nline2').run('SELECT 1');
  assert.deepEqual(text.columns, ['result']);
  assert.equal(text.rows.length, 2);

  const notOk = await mk(JSON.stringify({ ok: false, msg: 'nope' })).run('SELECT 1');
  assert.equal(notOk.ok, false);
  assert.equal(notOk.msg, 'nope');
});

test('cmd 传输：exec_time_ms 与 describe 都可用', async () => {
  const t = new CmdWarehouseTransport(envFixture({ transport: 'cmd', cmd: 'x {sql}', name: 'cmd-env' }), async () => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, exec_time_ms: 88, data: [{ a: 1 }] }),
    stderr: '',
  }));
  const r = await t.run('SELECT 1');
  assert.equal(r.execTimeMs, 88);
  assert.deepEqual(t.describe(), { transport: 'cmd', env: 'cmd-env' });
});

test('defaultCmdRunner：真起一个进程，超时会 SIGKILL', async () => {
  const okRun = await defaultCmdRunner(process.execPath, ['-e', 'process.stdout.write("hi")'], { timeoutMs: 10_000 });
  assert.equal(okRun.code, 0);
  assert.equal(okRun.stdout, 'hi');

  const bad = await defaultCmdRunner('/definitely/not/a/binary', [], { timeoutMs: 5_000 });
  assert.equal(bad.code, -1);
  assert.match(bad.stderr, /\S/);
});
