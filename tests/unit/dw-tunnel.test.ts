/**
 * dw 隧道单测：命令行组装、探活、重建、生效地址。
 * 全部用桩运行时，**不真的起 ssh**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSshInvocation,
  diagnoseTunnelFailure,
  effectiveEndpoint,
  ensureTunnel,
  filterSshNoise,
  tunnelDown,
  tunnelSignature,
  tunnelStatus,
  tunnelUp,
} from '../../packages/core/src/dw/tunnel.ts';
import { tunnelFixture, stubTunnelRuntime } from './dw-helpers.ts';

const SPEC = tunnelFixture();

// ─────────────────────── ssh 报错归因（纯函数） ───────────────────────

const NOISY = [
  '** WARNING: connection is not using a post-quantum key exchange algorithm.',
  '** This session may be vulnerable to "store now, decrypt later" attacks.',
  '** The server may need to be upgraded. See https://openssh.com/pq.html',
  'Warning: Permanently added "jump-host" (ED25519) to the list of known hosts.',
].join('\n');

test('filterSshNoise：剥掉 OpenSSH 横幅与 known_hosts 提示，并回报丢了几行', () => {
  const r = filterSshNoise(`${NOISY}\nbind [::1]:19030: Address already in use\n`);
  assert.deepEqual(r.lines, ['bind [::1]:19030: Address already in use']);
  assert.equal(r.dropped, 4);
  // 空输入不炸
  assert.deepEqual(filterSshNoise(''), { lines: [], dropped: 0 });
});

test('diagnoseTunnelFailure：端口占用 → 原因置顶 + 查占用者的命令 + forwards 引导', () => {
  const d = diagnoseTunnelFailure(`${NOISY}\nbind [::1]:19030: Address already in use`, SPEC, {
    listeningLocals: [19030],
    exitCode: 255,
  });
  assert.equal(d.reason, 'port-in-use');
  assert.match(d.summary, /本地端口 19030 已被占用/);
  assert.deepEqual(d.keyLines, ['bind [::1]:19030: Address already in use']);
  assert.match(d.action, /lsof -nP -iTCP:19030/); // 探到端口就用真实端口号，可直接粘贴执行
  assert.match(d.action, /forwards/);
  assert.equal(d.droppedNoise, 4);
});

test('diagnoseTunnelFailure：各类 ssh 原话归到正确原因', () => {
  const cases: [string, string][] = [
    ['Could not request local forwarding.', 'forward-refused'],
    ['Permission denied (publickey,password).', 'auth'],
    ['sshpass: Failed to run command', 'auth'],
    ['Host key verification failed.', 'host-key'],
    ['Connection refused', 'unreachable'],
    ['ssh: Could not resolve hostname jump-host', 'unreachable'],
    ['spawn ssh ENOENT', 'ssh-missing'],
  ];
  for (const [stderr, reason] of cases) {
    assert.equal(diagnoseTunnelFailure(stderr, SPEC).reason, reason, stderr);
  }
});

test('diagnoseTunnelFailure：端口在监听但 ssh 没给可识别原话 → 也能反推成占用', () => {
  const d = diagnoseTunnelFailure('', SPEC, { listeningLocals: [19030, 18030], exitCode: 255 });
  assert.equal(d.reason, 'port-in-use');
  assert.match(d.summary, /19030、18030 已被占用/);
});

test('diagnoseTunnelFailure：完全归不到时保留原文，并提示手工复现', () => {
  const d = diagnoseTunnelFailure('weird thing', SPEC, { exitCode: 255 });
  assert.equal(d.reason, 'unknown');
  assert.match(d.summary, /ssh 以退出码 255 退出：weird thing/);
  assert.deepEqual(d.keyLines, []); // 已被摘要引用，不重复列
  assert.match(d.action, /手工跑一遍同一条命令/);
});

test('buildSshInvocation：-N -f 加三条保命选项，转发对逐个 -L', () => {
  const { cmd, args } = buildSshInvocation(SPEC);
  assert.equal(cmd, 'ssh');
  assert.ok(args.includes('-N'));
  assert.ok(args.includes('-f'));
  assert.ok(args.includes('ServerAliveInterval=30'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=accept-new'));
  assert.ok(args.includes('-p') && args.includes('22'));
  assert.equal(args.filter((a) => a === '-L').length, 2);
  assert.equal(args[args.length - 1], 'jumpuser@jump-host');
});

test('buildSshInvocation：有 passwordFile 时走 sshpass -f，**密码不进 argv**', () => {
  const { cmd, args } = buildSshInvocation(tunnelFixture({ passwordFile: '/tmp/pw' }));
  assert.equal(cmd, 'sshpass');
  assert.deepEqual(args.slice(0, 3), ['-f', '/tmp/pw', 'ssh']);
  assert.equal(args.includes('--password'), false);
});

test('buildSshInvocation：identityFile 与 extraArgs 都带上；无 jumpUser 时不加 @', () => {
  const { args } = buildSshInvocation(
    tunnelFixture({ identityFile: '/tmp/key', extraArgs: ['-o', 'ProxyCommand=nc %h %p'], jumpUser: undefined }),
  );
  assert.ok(args.includes('-i') && args.includes('/tmp/key'));
  assert.ok(args.includes('ProxyCommand=nc %h %p'));
  assert.equal(args[args.length - 1], 'jump-host');
});

test('buildSshInvocation：sshpassPath 可覆盖（有的机器装在别处）', () => {
  const { cmd } = buildSshInvocation(tunnelFixture({ passwordFile: '/tmp/pw' }), { sshpassPath: '/opt/sshpass' });
  assert.equal(cmd, '/opt/sshpass');
});

test('tunnelSignature：含跳板机与全部转发对，避免 pkill ssh 误伤别人的隧道', () => {
  const sig = tunnelSignature(SPEC);
  assert.match(sig, /-L 19030:dw-host:9030/);
  assert.match(sig, /.*-L 18030:dw-host:8030/);
});

test('tunnelStatus：未启用直接返回 enabled=false，不探端口', async () => {
  const { runtime, execs } = stubTunnelRuntime({});
  const st = await tunnelStatus(tunnelFixture({ enabled: false }), runtime);
  assert.equal(st.enabled, false);
  assert.equal(st.up, false);
  assert.equal(execs.length, 0);
});

test('tunnelStatus：**探活看端口不看进程**——端口全通才算 up', async () => {
  const { runtime } = stubTunnelRuntime({ listening: [19030, 18030] });
  const st = await tunnelStatus(SPEC, runtime);
  assert.equal(st.up, true);
  assert.ok(st.forwards.every((f) => f.listening));
});

test('tunnelStatus：端口通但匹配不到本工具进程 → 明说"不是 dw 起的"', async () => {
  // 这条隧道（手工 ssh / 别的工具起的）能用，但 dw tunnel down 关不掉它。
  // 只说"进程 0 个"用户读不出这层意思，所以必须显式标注 owner。
  const { runtime } = stubTunnelRuntime({ listening: [19030, 18030] });
  const st = await tunnelStatus(SPEC, runtime);
  assert.equal(st.owner, 'foreign');
  assert.match(st.hint ?? '', /不是 dw 起的/);
  assert.match(st.hint ?? '', /关不掉/);
});

test('tunnelStatus：端口通且能匹配到本工具进程 → owner=tool', async () => {
  const { runtime } = stubTunnelRuntime({ listening: [19030, 18030], pids: [42] });
  const st = await tunnelStatus(SPEC, runtime);
  assert.equal(st.owner, 'tool');
  assert.equal(st.hint, undefined);
});

test('tunnelStatus：不通时 owner=none', async () => {
  const { runtime } = stubTunnelRuntime({ listening: [] });
  assert.equal((await tunnelStatus(SPEC, runtime)).owner, 'none');
});

test('tunnelStatus：进程在但端口不通 → 提示"合盖休眠后残留"', async () => {
  const { runtime } = stubTunnelRuntime({ listening: [], pids: [123] });
  const st = await tunnelStatus(SPEC, runtime);
  assert.equal(st.up, false);
  assert.match(st.hint ?? '', /合盖休眠后进程残留/);
});

test('tunnelStatus：没有进程也没端口 → 提示起隧道', async () => {
  const { runtime } = stubTunnelRuntime({ listening: [] });
  const st = await tunnelStatus(SPEC, runtime);
  assert.match(st.hint ?? '', /dw tunnel up/);
});

test('tunnelStatus：匹配到多个隧道进程 → 建议重建，避免重复副本', async () => {
  const { runtime } = stubTunnelRuntime({ listening: [19030, 18030], pids: [1, 2] });
  const st = await tunnelStatus(SPEC, runtime);
  assert.equal(st.up, true);
  assert.match(st.hint ?? '', /2 个隧道进程/);
});

test('tunnelDown：按特征串精确杀，返回成功的 pid', async () => {
  const { runtime, execs } = stubTunnelRuntime({ pids: [11, 22] });
  const r = await tunnelDown(SPEC, runtime);
  assert.deepEqual(r.killed, [11, 22]);
  assert.deepEqual(execs.map((e) => e.cmd), ['kill', 'kill']);
  assert.deepEqual(execs.map((e) => e.args[0]), ['11', '22']);
});

test('tunnelDown：没杀到进程但端口仍通 → 回报 stillListening（否则用户以为端口空着）', async () => {
  const { runtime } = stubTunnelRuntime({ pids: [], listening: [19030, 18030] });
  const r = await tunnelDown(SPEC, runtime);
  assert.deepEqual(r.killed, []);
  assert.deepEqual(r.stillListening, [19030, 18030]);
});

test('tunnelDown：杀干净后端口不再监听 → stillListening 为空', async () => {
  const { runtime } = stubTunnelRuntime({ pids: [7] });
  const r = await tunnelDown(SPEC, runtime);
  assert.deepEqual(r.killed, [7]);
  assert.deepEqual(r.stillListening, []);
});

test('tunnelUp：未启用直接拒绝', async () => {
  const { runtime } = stubTunnelRuntime({});
  const r = await tunnelUp(tunnelFixture({ enabled: false }), runtime);
  assert.equal(r.ok, false);
  assert.match(r.message, /未启用隧道/);
});

test('tunnelUp：已在且健康时幂等返回，不重建', async () => {
  const { runtime, execs } = stubTunnelRuntime({ listening: [19030, 18030] });
  const r = await tunnelUp(SPEC, runtime);
  assert.equal(r.ok, true);
  assert.match(r.message, /已在且健康/);
  assert.equal(execs.length, 0);
});

test('tunnelUp：不健康时先清残留再起（否则本地端口占用会直接失败）', async () => {
  const { runtime, execs } = stubTunnelRuntime({
    listening: [],
    pids: [99],
    listenAfterExec: [19030, 18030],
  });
  const r = await tunnelUp(SPEC, runtime, { waitMs: 10 });
  assert.equal(r.ok, true);
  assert.match(r.message, /隧道已建立/);
  assert.deepEqual(execs.map((e) => e.cmd), ['kill', 'ssh']);
});

test('tunnelUp：force 时即使健康也重建', async () => {
  const { runtime, execs } = stubTunnelRuntime({ listening: [19030, 18030] });
  await tunnelUp(SPEC, runtime, { force: true, waitMs: 10 });
  assert.equal(execs.some((e) => e.cmd === 'ssh'), true);
});

test('tunnelUp：ssh 非零退出 → 归因到"认证失败"，并给出复现命令', async () => {
  const pw = stubTunnelRuntime({ execResult: (cmd) => (cmd === 'sshpass' ? { code: 255, stdout: '', stderr: 'Permission denied' } : { code: 0, stdout: '', stderr: '' }) });
  await assert.rejects(
    () => tunnelUp(tunnelFixture({ passwordFile: '/tmp/pw' }), pw.runtime, { waitMs: 10 }),
    (e: Error) => {
      assert.match(e.message, /建立隧道失败：跳板机认证失败/);
      assert.match(e.message, /Permission denied/);          // 原始行必须保留
      assert.match(e.message, /passwordFile 时检查文件内容与权限/);
      assert.match(e.message, /ssh -v/);                     // 可复现的命令（-v 看认证细节）
      return true;
    },
  );

  const key = stubTunnelRuntime({ execResult: (cmd) => (cmd === 'ssh' ? { code: 255, stdout: 'host unreachable', stderr: '' } : { code: 0, stdout: '', stderr: '' }) });
  await assert.rejects(
    () => tunnelUp(SPEC, key.runtime, { waitMs: 10 }),
    /建立隧道失败：跳板机不可达[\s\S]*host unreachable/,
  );
});

/**
 * 实测踩过的坑：真实原因是 `bind [::1]:19030: Address already in use`，
 * 但 stderr 里最先出现、最长的是 OpenSSH 的 post-quantum `** WARNING` 横幅——
 * 原实现把整段 stderr 塞进消息，用户完全看不到端口占用，最后靠手工跑同一条 ssh 才发现。
 */
test('tunnelUp：端口占用时，真实原因置顶、噪声被略过、并给出 forwards 引导', async () => {
  const noisy = [
    '** WARNING: connection is not using a post-quantum key exchange algorithm.',
    '** This session may be vulnerable to "store now, decrypt later" attacks.',
    '** The server may need to be upgraded. See https://openssh.com/pq.html',
    'Warning: Permanently added "jump-host" (ED25519) to the list of known hosts.',
    'bind [::1]:19030: Address already in use',
    'Could not request local forwarding.',
  ].join('\n');
  // 端口正被**别的进程**占着：探活为真，但匹配不到本工具的隧道进程
  const rt = stubTunnelRuntime({ listening: [19030], execResult: () => ({ code: 255, stdout: '', stderr: noisy }) });
  await assert.rejects(
    () => tunnelUp(SPEC, rt.runtime, { waitMs: 10 }),
    (e: Error) => {
      assert.match(e.message, /本地端口 19030 已被占用/);
      assert.match(e.message, /Address already in use/);
      assert.match(e.message, /已略过 4 行 OpenSSH 噪声/);
      // 噪声行本身一行都不该出现在消息里（横幅 / known_hosts 提示）
      for (const line of e.message.split('\n')) {
        assert.equal(/^\*\*/.test(line), false, `噪声横幅漏进消息：${line}`);
        assert.equal(/known hosts/.test(line), false, `known_hosts 提示漏进消息：${line}`);
      }
      assert.match(e.message, /forwards/);                    // 约定不同就显式写本地端口
      assert.match(e.message, /lsof -nP -iTCP:19030/);        // 先告诉人怎么查占用者
      return true;
    },
  );
});

test('tunnelUp：端口占用时不再给"确认 passwordFile"这类方向错的提示', async () => {
  const rt = stubTunnelRuntime({
    listening: [19030],
    execResult: () => ({ code: 255, stdout: '', stderr: 'bind [::1]:19030: Address already in use' }),
  });
  await assert.rejects(
    () => tunnelUp(tunnelFixture({ passwordFile: '/tmp/pw' }), rt.runtime, { waitMs: 10 }),
    (e: Error) => {
      assert.equal(/认证失败/.test(e.message), false, '端口占用与认证无关，不能提认证');
      assert.equal(/passwordFile/.test(e.message), false);
      return true;
    },
  );
});

test('tunnelUp：归不到已知类别时，把原文第一行抬进摘要（别让人再从下面找）', async () => {
  const rt = stubTunnelRuntime({ execResult: () => ({ code: 255, stdout: '', stderr: 'something odd happened' }) });
  await assert.rejects(
    () => tunnelUp(SPEC, rt.runtime, { waitMs: 10 }),
    /建立隧道失败：ssh 以退出码 255 退出：something odd happened/,
  );
});

test('tunnelUp：命令成功但端口一直不通 → 明确失败，不留半死连接', async () => {
  const { runtime } = stubTunnelRuntime({ listening: [] });
  await assert.rejects(() => tunnelUp(SPEC, runtime, { waitMs: 10 }), /端口未就绪/);
});

test('ensureTunnel：未启用返回 undefined；已通直接返回；不通则拉起', async () => {
  assert.equal(await ensureTunnel(undefined), undefined);
  assert.equal(await ensureTunnel(tunnelFixture({ enabled: false })), undefined);

  const up = stubTunnelRuntime({ listening: [19030, 18030] });
  const st = await ensureTunnel(SPEC, up.runtime);
  assert.equal(st?.up, true);

  const down = stubTunnelRuntime({ listening: [], listenAfterExec: [19030, 18030] });
  const st2 = await ensureTunnel(SPEC, down.runtime);
  assert.equal(st2?.up, true);
  assert.equal(down.execs.some((e) => e.cmd === 'ssh'), true);
});

test('effectiveEndpoint：未启用隧道时用配置里的内网地址直连', () => {
  const e = effectiveEndpoint({ host: 'dw-host', mysqlPort: 9030, httpPort: 8030 });
  assert.deepEqual(e, { mysqlHost: 'dw-host', mysqlPort: 9030, httpHost: 'dw-host', httpPort: 8030 });
});

test('effectiveEndpoint：启用隧道时**改走本机 loopback**，按远端端口找本地转发', () => {
  const e = effectiveEndpoint({ host: 'dw-host', mysqlPort: 9030, httpPort: 8030, tunnel: SPEC });
  assert.deepEqual(e, { mysqlHost: '127.0.0.1', mysqlPort: 19030, httpHost: '127.0.0.1', httpPort: 18030 });
});

test('effectiveEndpoint：没有对应转发时回落到原端口（不静默换成错的）', () => {
  const e = effectiveEndpoint({
    host: 'dw-host',
    mysqlPort: 9030,
    httpPort: 9999,
    tunnel: tunnelFixture({ forwards: [{ local: 19030, remoteHost: 'dw-host', remotePort: 9030 }] }),
  });
  assert.equal(e.mysqlPort, 19030);
  assert.equal(e.httpPort, 9999);
});
