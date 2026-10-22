/**
 * 认证模块单测：密码加密、登录/刷新、会话持久化。
 * 使用桩客户端（tests/unit/helpers.ts 风格），不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import {
  encryptPassword,
  loginByPassword,
  loginByToken,
  refresh,
  saveSession,
  loadSession,
  loadSessionSync,
  saveSessionSync,
  sessionFile,
} from '../../packages/core/src/auth.ts';
import { stub, ok, tmpDir, withEnv } from './helpers.ts';

/** 在 helpers 桩客户端上补齐 cookie 能力（对齐 RestCloudClient 的接口） */
function authStub(handler: (path: string, opts: any, calls: any[]) => any) {
  const { client, calls } = stub(handler);
  const jar = new Map<string, string>();
  client.importCookies = (c: Record<string, string>) => {
    for (const [k, v] of Object.entries(c)) jar.set(k, v);
  };
  client.exportCookies = () => Object.fromEntries(jar);
  client.jar = jar;
  // 与 RestCloudClient.session() 同路径
  client.session = async () => client.request('/rest/base/users/context', { method: 'GET', dryRun: false });
  return { client, calls, jar };
}

test('密码加密：默认公钥可加密，长度符合 2048 位 PKCS1', () => {
  const enc = encryptPassword('p@ssw0rd');
  assert.match(enc, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(Buffer.from(enc, 'base64').length, 256);
  // PKCS1 填充带随机数 → 两次结果不同
  assert.notEqual(enc, encryptPassword('p@ssw0rd'));
});

test('密码加密：RC_PUBLIC_KEY 可覆盖公钥并可解密还原', () => {
  const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  withEnv({ RC_PUBLIC_KEY: pub }, () => {
    const enc = encryptPassword('secret-123');
    const plain = privateDecrypt(
      { key: kp.privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(enc, 'base64'),
    ).toString('utf8');
    assert.equal(plain, 'secret-123');
  });
});

test('密码加密：非法公钥抛错', () => {
  withEnv({ RC_PUBLIC_KEY: 'not-a-pem' }, () => {
    assert.throws(() => encryptPassword('x'));
  });
});

test('账号密码登录：缺少账号或密码直接拒绝', async () => {
  const { client } = authStub(() => ok());
  await assert.rejects(() => loginByPassword(client, '', 'p'), /缺少账号或密码/);
  await assert.rejects(() => loginByPassword(client, 'u', ''), /缺少账号或密码/);
});

test('账号密码登录：成功时导入 identitytoken 并回传用户信息', async () => {
  const { client, calls, jar } = authStub(() => ok({
    identitytoken: 'tk-1',
    userId: 'u-9',
    userName: 'admin',
    expiresSecond: 3600,
    expiresTime: '2026-12-31T00:00:00Z',
  }));
  const r = await loginByPassword(client, 'admin', 'pwd');
  assert.equal(r.token, 'tk-1');
  assert.equal(r.userId, 'u-9');
  assert.equal(r.userName, 'admin');
  assert.equal(r.expiresSecond, 3600);
  assert.equal(r.expiresTime, '2026-12-31T00:00:00Z');
  assert.equal(r.dualLogin, false);
  assert.equal(jar.get('identitytoken'), 'tk-1');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/rest/core/auth/login');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.dryRun, false);
  assert.equal(calls[0].opts.body.userName, 'admin');
  assert.equal(calls[0].opts.body.systemlogin, '1');
  assert.notEqual(calls[0].opts.body.password, 'pwd');
});

test('账号密码登录：密码经公钥加密后可还原', async () => {
  const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const { client, calls } = authStub(() => ok({ identitytoken: 'tk' }));
  await withEnv({ RC_PUBLIC_KEY: pub }, async () => {
    await loginByPassword(client, 'admin', 'pwd-明文');
  });
  const plain = privateDecrypt(
    { key: kp.privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(calls[0].opts.body.password, 'base64'),
  ).toString('utf8');
  assert.equal(plain, 'pwd-明文');
});

test('账号密码登录：平台失败时抛 E_AUTH 并带 traceId', async () => {
  const { client } = authStub(() => ({
    ok: false, httpStatus: 401, msg: '账号或密码错误', traceId: 'tr-1', data: {},
    request: { method: 'POST', url: '/x' },
  }));
  await assert.rejects(
    () => loginByPassword(client, 'admin', 'pwd'),
    (e: any) => {
      assert.equal(e.code, 'E_AUTH');
      assert.match(e.message, /登录失败：账号或密码错误/);
      assert.equal(e.traceId, 'tr-1');
      return true;
    },
  );
});

test('账号密码登录：失败且无 msg 时给默认文案', async () => {
  const { client } = authStub(() => ({
    ok: false, httpStatus: 500, data: {}, request: { method: 'POST', url: '/x' },
  }));
  await assert.rejects(() => loginByPassword(client, 'admin', 'pwd'), /登录失败：未知原因/);
});

test('账号密码登录：二次验证（dualLogin=1）给出替代方案', async () => {
  const { client } = authStub(() => ok({ dualLogin: '1' }));
  await assert.rejects(() => loginByPassword(client, 'admin', 'pwd'), /二次验证（dualLogin=1）/);
});

test('账号密码登录：响应缺少 identitytoken 报错', async () => {
  const { client } = authStub(() => ok({ userId: 'u' }));
  await assert.rejects(() => loginByPassword(client, 'admin', 'pwd'), /登录响应缺少 identitytoken/);
});

test('账号密码登录：响应无 data 字段时按空对象处理', async () => {
  const { client } = authStub(() => ({
    ok: true, httpStatus: 200, request: { method: 'POST', url: '/x' },
  }));
  await assert.rejects(() => loginByPassword(client, 'admin', 'pwd'), /登录响应缺少 identitytoken/);
});

test('token 登录：缺少 token 直接拒绝', async () => {
  const { client } = authStub(() => ok());
  await assert.rejects(() => loginByToken(client, ''), /缺少 token/);
});

test('token 登录：先落 cookie 再校验会话', async () => {
  const { client, calls, jar } = authStub((path) => {
    if (path.includes('/rest/base/users/context')) return ok({ userId: 'u-1', userName: 'bob' });
    return ok();
  });
  const r = await loginByToken(client, 'tk-2');
  assert.equal(r.token, 'tk-2');
  assert.equal(r.userId, 'u-1');
  assert.equal(r.userName, 'bob');
  assert.equal(jar.get('identitytoken'), 'tk-2');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/rest/base/users/context');
});

test('token 登录：会话无效时抛 E_AUTH', async () => {
  const { client } = authStub(() => ({
    ok: false, httpStatus: 401, msg: '未授权', traceId: 'tr-2', data: {},
    request: { method: 'GET', url: '/x' },
  }));
  await assert.rejects(
    () => loginByToken(client, 'bad'),
    (e: any) => {
      assert.equal(e.code, 'E_AUTH');
      assert.match(e.message, /token 无效或已过期：未授权/);
      assert.equal(e.traceId, 'tr-2');
      return true;
    },
  );
});

test('token 登录：会话无效且无 msg 时消息留空', async () => {
  const { client } = authStub(() => ({
    ok: false, httpStatus: 401, data: {}, request: { method: 'GET', url: '/x' },
  }));
  await assert.rejects(() => loginByToken(client, 'bad'), /token 无效或已过期：\s*$/);
});

test('token 登录：会话响应无 data 时用户信息为空', async () => {
  const { client } = authStub(() => ({
    ok: true, httpStatus: 200, request: { method: 'GET', url: '/x' },
  }));
  const r = await loginByToken(client, 'tk-3');
  assert.equal(r.token, 'tk-3');
  assert.equal(r.userId, undefined);
  assert.equal(r.userName, undefined);
});

test('刷新令牌：成功时更新 cookie', async () => {
  const { client, calls, jar } = authStub(() => ok({ identitytoken: 'tk-new' }));
  await refresh(client);
  assert.equal(jar.get('identitytoken'), 'tk-new');
  assert.equal(calls[0].path, '/rest/core/auth/refreshToken');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.dryRun, false);
});

test('刷新令牌：失败抛 E_AUTH；无新 token 时保持原 cookie', async () => {
  const { client } = authStub(() => ({
    ok: false, httpStatus: 500, msg: '刷新失败', traceId: 'tr-3', data: {},
    request: { method: 'POST', url: '/x' },
  }));
  await assert.rejects(
    () => refresh(client),
    (e: any) => {
      assert.equal(e.code, 'E_AUTH');
      assert.match(e.message, /刷新失败：刷新失败/);
      assert.equal(e.traceId, 'tr-3');
      return true;
    },
  );

  const { client: c2, jar } = authStub(() => ({
    ok: true, httpStatus: 200, request: { method: 'POST', url: '/x' },
  }));
  c2.importCookies({ identitytoken: 'old' });
  await refresh(c2);
  assert.equal(jar.get('identitytoken'), 'old');
});

test('刷新令牌：失败且无 msg 时消息留空', async () => {
  const { client } = authStub(() => ({
    ok: false, httpStatus: 500, data: {}, request: { method: 'POST', url: '/x' },
  }));
  await assert.rejects(() => refresh(client), /刷新失败：\s*$/);
});

test('会话落盘：0600 权限，JSON 仅为 cookie', async () => {
  const dir = tmpDir('rc-auth-');
  try {
    const { client } = authStub(() => ok());
    client.importCookies({ identitytoken: 'tk', other: 'v' });
    const file = join(dir.dir, 'session-dev.json');
    await saveSession(client, file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { identitytoken: 'tk', other: 'v' });
  } finally {
    dir.cleanup();
  }
});

test('会话恢复：文件有效时导入 cookie，损坏或缺失时返回 false', async () => {
  const dir = tmpDir('rc-auth-');
  try {
    const { client, jar } = authStub(() => ok());
    const file = join(dir.dir, 'session.json');
    writeFileSync(file, JSON.stringify({ identitytoken: 'tk-9' }), 'utf8');
    assert.equal(await loadSession(client, file), true);
    assert.equal(jar.get('identitytoken'), 'tk-9');

    const bad = join(dir.dir, 'bad.json');
    writeFileSync(bad, 'not-json', 'utf8');
    assert.equal(await loadSession(client, bad), false);

    assert.equal(await loadSession(client, join(dir.dir, 'missing.json')), false);
  } finally {
    dir.cleanup();
  }
});

test('会话文件路径：RC_HOME 优先，否则 ~/.rc', async () => {
  await withEnv({ RC_HOME: '/tmp/rc-home-x' }, () => {
    assert.equal(sessionFile('dev'), join('/tmp/rc-home-x', 'session-dev.json'));
  });
  const home = tmpDir('rc-home-');
  try {
    withEnv({ RC_HOME: undefined, HOME: home.dir }, () => {
      assert.equal(sessionFile('uat'), join(home.dir, '.rc', 'session-uat.json'));
    });
  } finally {
    home.cleanup();
  }
});

test('同步会话：保存 0600/目录 0700，读取成功与失败', () => {
  const dir = tmpDir('rc-auth-');
  try {
    const { client } = authStub(() => ok());
    client.importCookies({ identitytoken: 'tk-sync' });
    const file = join(dir.dir, 'nested', 'session.json');
    saveSessionSync(client, file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir.dir, 'nested')).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { identitytoken: 'tk-sync' });

    const { client: c2, jar } = authStub(() => ok());
    assert.equal(loadSessionSync(c2, file), true);
    assert.equal(jar.get('identitytoken'), 'tk-sync');

    const bad = join(dir.dir, 'bad.json');
    writeFileSync(bad, '{oops', 'utf8');
    assert.equal(loadSessionSync(c2, bad), false);
    assert.equal(loadSessionSync(c2, join(dir.dir, 'none.json')), false);
  } finally {
    dir.cleanup();
  }
});
