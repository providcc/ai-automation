/**
 * dw 连接装配与审计留痕单测。
 * 装配是"配置里写内网地址、运行时改走本机 loopback"的唯一改写点，只允许有一处。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { connect, createTransport } from '../../packages/core/src/dw/connect.ts';
import { CmdWarehouseTransport, HttpWarehouseTransport } from '../../packages/core/src/dw/transport.ts';
import { auditDwWrite, dwAuditSink } from '../../packages/core/src/dw/audit.ts';
import { MemoryAuditSink } from '../../packages/core/src/audit.ts';
import { envFixture, stubTunnelRuntime, tunnelFixture } from './dw-helpers.ts';
import { tmpDir, withEnv } from './helpers.ts';

// ─────────────────────── 传输装配 ───────────────────────

test('createTransport：按 env.transport 选实现', () => {
  assert.equal(createTransport(envFixture({ transport: 'http' })).kind, 'http');
  assert.ok(createTransport(envFixture({ transport: 'http' })) instanceof HttpWarehouseTransport);
  const cmd = createTransport(envFixture({ transport: 'cmd', cmd: 'stub {sql}' }));
  assert.equal(cmd.kind, 'cmd');
  assert.ok(cmd instanceof CmdWarehouseTransport);
});

test('createTransport：cmd 缺模板时抛参数错误（配置问题早报）', () => {
  assert.throws(() => createTransport(envFixture({ transport: 'cmd', cmd: undefined })), /未配置命令模板/);
});

test('createTransport：http 走 effectiveEndpoint 给出的地址（未启用隧道=内网地址）', async () => {
  const { transport } = await connect(envFixture(), { noTunnel: true });
  const d = transport.describe() as { endpoint: string };
  assert.equal(d.endpoint, 'dw-host:8030');
});

// ─────────────────────── 隧道装配 ───────────────────────

test('connect：未启用隧道时不碰隧道，endpoint 就是配置里的地址', async () => {
  const { endpoint, tunnel } = await connect(envFixture(), { noTunnel: true });
  assert.equal(tunnel, undefined);
  assert.deepEqual(endpoint, { mysqlHost: 'dw-host', mysqlPort: 9030, httpHost: 'dw-host', httpPort: 8030 });
});

test('connect：隧道已通 → 直接复用，不重建', async () => {
  const rt = stubTunnelRuntime({ listening: [19030, 18030] });
  const { endpoint, tunnel } = await connect(envFixture({ tunnel: tunnelFixture() }), { tunnelRuntime: rt.runtime });
  assert.equal(tunnel?.up, true);
  assert.equal(rt.execs.length, 0);
  assert.deepEqual(endpoint, { mysqlHost: '127.0.0.1', mysqlPort: 19030, httpHost: '127.0.0.1', httpPort: 18030 });
});

test('connect：隧道不通时先拉起再装配（半死连接会让后续每条查询都超时）', async () => {
  const rt = stubTunnelRuntime({ listening: [], listenAfterExec: [19030, 18030] });
  const { endpoint, tunnel } = await connect(envFixture({ tunnel: tunnelFixture() }), { tunnelRuntime: rt.runtime });
  assert.equal(tunnel?.up, true);
  assert.equal(rt.execs.some((e) => e.cmd === 'ssh'), true);
  assert.equal(endpoint.httpPort, 18030);
});

test('connect：noTunnel 时启用隧道的环境也不去动隧道，endpoint 仍按隧道改写', async () => {
  const rt = stubTunnelRuntime({ listening: [19030, 18030] });
  const { tunnel, endpoint } = await connect(envFixture({ tunnel: tunnelFixture() }), { noTunnel: true, tunnelRuntime: rt.runtime });
  assert.equal(tunnel, undefined);
  assert.equal(rt.execs.length, 0);
  // 地址改写仍然发生：配置里写的是内网地址，实际连的是转发端口
  assert.equal(endpoint.mysqlHost, '127.0.0.1');
  assert.equal(endpoint.mysqlPort, 19030);
});

test('connect：隧道拉不起来就失败（不返回一个用不了的连接）', async () => {
  const rt = stubTunnelRuntime({ listening: [], execResult: (cmd) => (cmd === 'ssh' ? { code: 255, stdout: '', stderr: 'denied' } : { code: 0, stdout: '', stderr: '' }) });
  await assert.rejects(
    () => connect(envFixture({ tunnel: tunnelFixture() }), { tunnelRuntime: rt.runtime }),
    /建立隧道失败：ssh 以退出码 255 退出：denied/,
  );
});

// ─────────────────────── 审计 ───────────────────────

test('auditDwWrite：把动作映射成审计条目（方法/目标/是否 dry-run）', async () => {
  const sink = new MemoryAuditSink();
  await auditDwWrite(
    { env: 'test', action: 'swap', target: 'mv_a', ok: true, dryRun: false, sql: 'ALTER ...', msg: 'ok', extra: { source: 'mv_tmp' } },
    sink,
  );
  assert.equal(sink.entries.length, 1);
  assert.equal(sink.entries[0].method, 'SWAP');
  assert.equal(sink.entries[0].path, 'mv_a');
  assert.equal(sink.entries[0].profile, 'test');
  assert.equal(sink.entries[0].dryRun, false);
  assert.equal(sink.entries[0].status, 0);
  assert.deepEqual((sink.entries[0].args as { source: string }).source, 'mv_tmp');
});

test('auditDwWrite：失败动作 status=1，但**不抛**（审计不该盖过业务结果）', async () => {
  const sink = new MemoryAuditSink();
  await auditDwWrite({ env: 'test', action: 'rolloff', target: 'tbl', ok: false, dryRun: false, msg: 'boom' }, sink);
  assert.equal(sink.entries[0].status, 1);
  assert.equal(sink.entries[0].ok, false);
});

test('auditDwWrite：记下**打码后的 host**（只记环境名的话，纯环境变量启动时根本分不清生产/测试）', async () => {
  const sink = new MemoryAuditSink();
  await auditDwWrite({ env: 'env', host: 'd***t', action: 'freeze', target: 'mv', ok: true, dryRun: true }, sink);
  assert.equal((sink.entries[0].args as { host: string }).host, 'd***t');
});

test('auditDwWrite：**审计里不许出现凭据**（连值里嵌的 `password=...` 也要抹掉）', async () => {
  const sink = new MemoryAuditSink();
  await auditDwWrite(
    {
      env: 'test',
      host: 'h***t',
      action: 'refresh',
      target: 'mv',
      ok: true,
      dryRun: false,
      sql: `ALTER CATALOG c SET PROPERTIES("password"="<secret>")`,
    },
    sink,
  );
  const dump = JSON.stringify(sink.entries[0]);
  assert.ok(!dump.includes('<secret>'), `审计里出现了明文密码：${dump}`);
  // 断言脱敏后的原文（不要断言 JSON dump——里面的引号是转义过的）
  assert.equal((sink.entries[0].args as { sql: string }).sql, `ALTER CATALOG c SET PROPERTIES("password"="***")`);
});

test('auditDwWrite：sink 抛错时只提醒到 stderr，不阻断调用方', async () => {
  const failing = { write: async () => { throw new Error('disk full'); } };
  const original = process.stderr.write;
  const errs: string[] = [];
  process.stderr.write = ((s: string) => { errs.push(String(s)); return true; }) as typeof process.stderr.write;
  try {
    await auditDwWrite({ env: 'test', action: 'refresh', target: 'mv', ok: true, dryRun: false }, failing);
  } finally {
    process.stderr.write = original;
  }
  assert.match(errs.join(''), /审计写入失败（不影响本次结果）：disk full/);
});

test('dwAuditSink：默认写到 DW_HOME/audit，与 ~/.rc/audit 隔离', async () => {
  const t = tmpDir('dw-audit-');
  try {
    await withEnv({ DW_HOME: t.dir }, async () => {
      await auditDwWrite({ env: 'test', action: 'freeze', target: 'mv_a', ok: true, dryRun: false });
      const dir = `${t.dir}/audit`;
      assert.equal(existsSync(dir), true);
      const file = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
      assert.ok(file, '应生成 jsonl 审计文件');
      const line = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8').trim().split('\n')[0]);
      assert.equal(line.method, 'FREEZE');
      assert.equal(line.path, 'mv_a');
      assert.ok(line.ts, '带时间戳');
    });
  } finally {
    t.cleanup();
  }
});

test('dwAuditSink：strict 模式下写入失败会抛（需要硬保证的场景）', async () => {
  const sink = dwAuditSink({ dir: '/dev/null/not-a-dir', strict: true });
  await assert.rejects(() => sink.write({
    actor: 'x', profile: 'p', method: 'M', path: '/x', status: 0, ok: true, ms: 0,
  }));
});
