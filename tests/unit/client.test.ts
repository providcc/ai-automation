/**
 * RestCloudClient 单测：全部通过桩 fetch，不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RestCloudClient, createClient, describeNetworkError } from '../../packages/core/src/client.ts';
import { tmpDir, withEnv, captureLog } from './helpers.ts';

type FetchCall = { url: string; init: any };

/** 安装桩 fetch（记录调用），返回恢复函数 */
function withFetch(
  handler: (url: string, init: any, n: number) => Response | Promise<Response>,
): { calls: FetchCall[]; restore: () => void } {
  const prev = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push({ url: String(input), init });
    return await handler(String(input), init, calls.length);
  }) as any;
  return { calls, restore: () => { globalThis.fetch = prev; } };
}

function jsonRes(
  body: unknown,
  status = 200,
  headers: Record<string, string | string[]> = {},
): Response {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) for (const one of v) h.append(k, one);
    else h.set(k, v);
  }
  return new Response(JSON.stringify(body), { status, headers: h });
}

const BASE = 'https://platform.example.test/restcloud';

test('网络错误归一化：DNS/连接/超时/证书提示可行动', () => {
  assert.match(describeNetworkError({ cause: { code: 'ENOTFOUND' }, message: 'fetch failed' }), /域名无法解析/);
  assert.match(describeNetworkError({ code: 'EAI_AGAIN', message: 'fetch failed' }), /域名解析超时/);
  assert.match(describeNetworkError({ cause: { code: 'ECONNREFUSED' }, message: 'fetch failed' }), /连接被拒绝/);
  assert.match(describeNetworkError({ code: 'ECONNRESET', message: 'fetch failed' }), /连接被重置/);
  assert.match(describeNetworkError({ cause: { code: 'ETIMEDOUT' }, message: 'fetch failed' }), /连接超时/);
  assert.match(describeNetworkError({ code: 'UND_ERR_CONNECT_TIMEOUT', message: 'fetch failed' }), /连接超时/);
  assert.match(describeNetworkError({ code: 'CERT_HAS_EXPIRED', message: 'fetch failed' }), /证书过期/);
  assert.match(describeNetworkError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'fetch failed' }), /自签名证书/);
  // 未知错误码：保留原始码
  assert.match(describeNetworkError({ code: 'EWEIRD', message: 'fetch failed' }), /（EWEIRD）/);
  // cause 存在但 cause.code 缺失 → 回落到 e.code
  assert.match(describeNetworkError({ cause: {}, code: 'ECONNRESET', message: 'fetch failed' }), /连接被重置/);
  // 无错误码：无后缀
  assert.equal(describeNetworkError({ message: 'boom' }), '网络请求失败：boom');
  // 附带主机名
  assert.match(describeNetworkError({ message: 'boom' }, 'https://a.test/x'), /\[a\.test\]$/);
  // 非法 URL：原样回显
  assert.match(describeNetworkError({ message: 'boom' }, 'not a url'), /\[not a url\]$/);
  // 无 message 时回退到 String(e)
  assert.equal(describeNetworkError('plain-string'), '网络请求失败：plain-string');
  // 空对象：既无 code 也无 message
  assert.equal(describeNetworkError({}), '网络请求失败：[object Object]');
});

test('构造：去掉尾部斜杠并执行主机白名单校验', () => {
  const c = new RestCloudClient({ baseUrl: 'https://a.test/rest///', profile: 'dev' });
  assert.equal(c.baseUrl, 'https://a.test/rest');

  // 白名单未配置时不拦截
  const c2 = new RestCloudClient({ baseUrl: 'https://any.test/rest', profile: 'dev' });
  assert.equal(c2.baseUrl, 'https://any.test/rest');

  // 白名单命中 → 通过
  const c3 = new RestCloudClient({ baseUrl: 'https://ok.test/rest', profile: 'dev' });
  assert.ok(c3);
});

test('白名单：命中放行、未命中拒绝', async () => {
  await withEnv({ RC_ALLOWED_HOSTS: 'allowed.test, *.corp.test' }, () => {
    const okHost = new RestCloudClient({ baseUrl: 'https://allowed.test/rest', profile: 'dev' });
    assert.equal(okHost.baseUrl, 'https://allowed.test/rest');
    const wildcard = new RestCloudClient({ baseUrl: 'https://a.corp.test/rest', profile: 'dev' });
    assert.equal(wildcard.baseUrl, 'https://a.corp.test/rest');
    assert.throws(
      () => new RestCloudClient({ baseUrl: 'https://evil.test/rest', profile: 'dev' }),
      /不在 RC_ALLOWED_HOSTS 白名单内/,
    );
    // 非法 URL → 抛错（白名单存在时才会校验）
    assert.throws(
      () => new RestCloudClient({ baseUrl: 'nope', profile: 'dev' }),
      /不是合法 URL/,
    );
  });
});

test('只读判定：prod 默认只读，RC_ALLOW_PROD_WRITE=1 才可写', async () => {
  await withEnv({ RC_ALLOW_PROD_WRITE: undefined }, async () => {
    const prod = new RestCloudClient({ baseUrl: BASE, profile: 'prod' });
    assert.equal(prod.readOnly, true);
    await assert.rejects(
      () => prod.request('/rest/x', { method: 'POST', body: { a: 1 } }),
      /profile=prod 为只读模式/,
    );
  });
  await withEnv({ RC_ALLOW_PROD_WRITE: '1' }, () => {
    const prod = new RestCloudClient({ baseUrl: BASE, profile: 'prod' });
    assert.equal(prod.readOnly, false);
  });
  await withEnv({ RC_ALLOW_PROD_WRITE: undefined }, () => {
    const dev = new RestCloudClient({ baseUrl: BASE, profile: 'dev' });
    assert.equal(dev.readOnly, false);
    const uat = new RestCloudClient({ baseUrl: BASE, profile: 'uat' });
    assert.equal(uat.readOnly, false);
  });
});

test('缺少目标地址：请求期给出可行动提示', async () => {
  const c = new RestCloudClient({ baseUrl: '   ', profile: 'dev' });
  await assert.rejects(() => c.request('/rest/x'), /缺少目标地址：请设置 RC_BASE_URL/);
  // baseUrl 缺失字段（运行时可能为 undefined）
  const c2 = new RestCloudClient({ baseUrl: undefined as any, profile: 'dev' });
  await assert.rejects(() => c2.request('/rest/x'), /缺少目标地址：请设置 RC_BASE_URL/);
});

test('dry-run：写操作默认不发送，httpStatus=0 且回显请求', async () => {
  const f = withFetch(() => {
    throw new Error('dry-run 不应发起请求');
  });
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/core/api/save', { method: 'POST', body: { name: 'x' } });
    assert.equal(r.ok, true);
    assert.equal(r.httpStatus, 0);
    assert.equal(r.msg, 'dry-run: 请求未发送');
    assert.equal(r.request.method, 'POST');
    assert.equal(r.request.url, `${BASE}/rest/core/api/save`);
    assert.deepEqual(r.request.body, { name: 'x' });
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test('dry-run：GET 显式 dryRun=true 也不发送', async () => {
  const f = withFetch(() => jsonRes({ ok: 1 }));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/x', { dryRun: true });
    assert.equal(r.httpStatus, 0);
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test('真实请求：URL/查询串/请求头/请求体/幂等键', async () => {
  const f = withFetch(() => jsonRes({ state: true, data: { id: '7' } }));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/core/api/get', {
      method: 'GET',
      query: { id: '7', flag: true, skip: undefined },
      headers: { 'X-Extra': 'yes' },
    });
    assert.equal(r.ok, true);
    assert.equal(r.httpStatus, 200);
    assert.deepEqual(r.data, { state: true, data: { id: '7' } });
    assert.equal(f.calls.length, 1);
    const call = f.calls[0];
    assert.equal(call.url, `${BASE}/rest/core/api/get?id=7&flag=true`);
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.body, undefined);
    assert.equal(call.init.headers.Accept, 'application/json');
    assert.equal(call.init.headers['X-Extra'], 'yes');
    assert.equal(call.init.headers['Content-Type'], undefined);
    // GET 不是写操作 → 不带幂等键
    assert.equal(call.init.headers['X-Idempotency-Key'], undefined);
  } finally {
    f.restore();
  }
});

test('真实请求：对象 body 走 JSON.stringify，字符串 body 原样发送', async () => {
  const f = withFetch(() => jsonRes({ state: true }));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    await c.request('/rest/core/api/save', { method: 'POST', body: { a: 1, b: 'x' }, dryRun: false });
    assert.equal(f.calls[0].init.body, '{"a":1,"b":"x"}');
    assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');

    await c.request('/rest/core/doc/upload', { method: 'POST', body: 'raw-body', dryRun: false });
    assert.equal(f.calls[1].init.body, 'raw-body');

    // null body → "null"，数组 body → JSON 数组
    await c.request('/rest/core/api/save', { method: 'POST', body: null, dryRun: false });
    assert.equal(f.calls[2].init.body, 'null');
    await c.request('/rest/core/api/save', { method: 'POST', body: [1, 2], dryRun: false });
    assert.equal(f.calls[3].init.body, '[1,2]');
  } finally {
    f.restore();
  }
});

test('prod 显式放开写入：请求真正发出', async () => {
  const f = withFetch(() => jsonRes({ state: true }));
  try {
    await withEnv({ RC_ALLOW_PROD_WRITE: '1' }, async () => {
      const c = new RestCloudClient({ baseUrl: BASE, profile: 'prod', auditDir: tmpDir().dir });
      const r = await c.request('/rest/core/api/save', { method: 'POST', body: { a: 1 } });
      assert.equal(r.ok, true);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].init.method, 'POST');
    });
  } finally {
    f.restore();
  }
});

test('traceId：优先取响应头 traceid，其次 x-trace-id', async () => {
  const f1 = withFetch(() => jsonRes({ state: true }, 200, { traceid: 'tr-header' }));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/core/api/get');
    assert.equal(r.traceId, 'tr-header');
  } finally {
    f1.restore();
  }
});

test('响应体不含 traceId 时回落到请求头', async () => {
  const f = withFetch(() => jsonRes({ state: true }, 200, { 'x-trace-id': 'tr-x' }));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/core/api/get');
    assert.equal(r.traceId, 'tr-x');
  } finally {
    f.restore();
  }
});

test('Set-Cookie 非法行被忽略；无 getSetCookie 的响应也能处理', async () => {
  const f1 = withFetch(() => jsonRes({ state: true }, 200, { 'set-cookie': ['novalue', '=weird', 'ok=1'] }));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    await c.request('/rest/core/api/get');
    assert.deepEqual(c.exportCookies(), { ok: '1' });
  } finally {
    f1.restore();
  }

  const f2 = withFetch(() => ({
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ state: true }),
  }) as any);
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/core/api/get');
    assert.equal(r.ok, true);
    assert.deepEqual(c.exportCookies(), {});
  } finally {
    f2.restore();
  }
});

test('非 2xx（含 1xx/3xx）一律判失败', async () => {
  const f1 = withFetch(() => ({
    status: 199,
    headers: { get: () => null },
    text: async () => JSON.stringify({ state: true }),
  }) as any);
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/core/api/get');
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 199);
  } finally {
    f1.restore();
  }

  const f2 = withFetch(() => jsonRes({ state: true }, 302));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/core/api/get');
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 302);
  } finally {
    f2.restore();
  }
});

test('审计：actor 缺省时依次回落到 USER 与 unknown', async () => {
  const dir = tmpDir('rc-audit-');
  try {
    const f = withFetch(() => jsonRes({ state: true }));
    try {
      await withEnv({ RC_ACTOR: undefined, USER: undefined }, async () => {
        const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: dir.dir });
        await c.request('/rest/core/api/get');
      });
    } finally {
      f.restore();
    }
    const files = readdirSync(dir.dir);
    const entry = JSON.parse(readFileSync(join(dir.dir, files[0]), 'utf8').trim());
    assert.equal(entry.actor, 'unknown');
  } finally {
    dir.cleanup();
  }
});

test('幂等键：写操作自动生成指纹，自定义键优先，同体同键异体异键', async () => {
  const f = withFetch(() => jsonRes({ state: true }));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    await c.request('/rest/core/api/save', { method: 'POST', body: { a: 1, b: 2 }, dryRun: false });
    await c.request('/rest/core/api/save', { method: 'POST', body: { b: 2, a: 1 }, dryRun: false });
    await c.request('/rest/core/api/save', { method: 'POST', body: { a: 9 }, dryRun: false });
    await c.request('/rest/core/api/save', { method: 'POST', body: { a: 1 }, idempotencyKey: 'my-key', dryRun: false });

    const k1 = f.calls[0].init.headers['X-Idempotency-Key'];
    const k2 = f.calls[1].init.headers['X-Idempotency-Key'];
    const k3 = f.calls[2].init.headers['X-Idempotency-Key'];
    assert.match(k1, /^[0-9a-f]{32}$/);
    assert.equal(k1, k2, '键顺序不同但内容相同 → 指纹一致');
    assert.notEqual(k1, k3);
    assert.equal(f.calls[3].init.headers['X-Idempotency-Key'], 'my-key');
  } finally {
    f.restore();
  }
});

test('Cookie：响应 Set-Cookie 被捕获并在下一次请求回送', async () => {
  const f = withFetch(() => jsonRes({ state: true }, 200, {
    'set-cookie': ['identitytoken=tok-1; Path=/; HttpOnly', 'locale=zh-CN'],
  }));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    await c.request('/rest/core/auth/login', { method: 'GET', query: { token: 'x' } });
    assert.deepEqual(c.exportCookies(), { identitytoken: 'tok-1', locale: 'zh-CN' });
    await c.request('/rest/base/users/context');
    assert.equal(f.calls[1].init.headers.Cookie, 'identitytoken=tok-1; locale=zh-CN');
  } finally {
    f.restore();
  }
});

test('Cookie：导入导出与 URL 编码 token 解码', () => {
  const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev' });
  assert.deepEqual(c.exportCookies(), {});
  c.importCookies({ identitytoken: 'abc%20def', other: 'v' });
  assert.deepEqual(c.exportCookies(), { identitytoken: 'abc def', other: 'v' });
  c.importCookies({ plain: 'x' });
  assert.deepEqual(c.exportCookies(), { identitytoken: 'abc def', other: 'v', plain: 'x' });
  // 空 token：不触发解码
  c.importCookies({ identitytoken: '' });
  assert.equal(c.exportCookies().identitytoken, '');
});

test('登录类接口：loginByPassword / loginByToken / refreshToken / session', async () => {
  const f = withFetch((url) => {
    if (url.includes('/rest/core/auth/login')) return jsonRes({ state: true, identitytoken: 'tk' });
    if (url.includes('/rest/core/auth/refreshToken')) return jsonRes({ state: true, identitytoken: 'tk2' });
    return jsonRes({ state: true, userId: 'u1' });
  });
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const lp = await c.loginByPassword('admin', 'pwd');
    assert.equal(lp.ok, true);
    assert.equal(f.calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { username: 'admin', password: 'pwd' });
    assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');

    const lt = await c.loginByToken('token-abc');
    assert.equal(lt.ok, true);
    assert.match(f.calls[1].url, /\/rest\/core\/auth\/login\?token=token-abc$/);
    assert.equal(c.exportCookies().identitytoken, 'token-abc');

    const rt = await c.refreshToken();
    assert.equal(rt.ok, true);
    assert.equal(f.calls[2].init.method, 'POST');
    assert.match(f.calls[2].url, /refreshToken$/);

    const s = await c.session();
    assert.equal(s.ok, true);
    assert.match(f.calls[3].url, /\/rest\/base\/users\/context$/);
  } finally {
    f.restore();
  }
});

test('401：触发重授权并重试一次', async () => {
  let n = 0;
  const f = withFetch(() => {
    n++;
    if (n === 1) return jsonRes({ msg: '未授权' }, 401);
    return jsonRes({ state: true, data: { ok: 1 } });
  });
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    let reauth = 0;
    c.setReauthorizer(async () => { reauth++; });
    const r = await c.request('/rest/core/api/get');
    assert.equal(reauth, 1);
    assert.equal(f.calls.length, 2);
    assert.equal(r.ok, true);
    assert.equal(r.httpStatus, 200);
  } finally {
    f.restore();
  }
});

test('401：未注册重授权器 / 重授权抛错时保留原 401 结果', async () => {
  const f1 = withFetch(() => jsonRes({ msg: '未授权' }, 401));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/core/api/get');
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 401);
    assert.equal(r.msg, '未授权');
    assert.equal(f1.calls.length, 1);
  } finally {
    f1.restore();
  }

  const f2 = withFetch(() => jsonRes({ msg: '未授权' }, 401));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    c.setReauthorizer(async () => { throw new Error('重授权失败'); });
    const r = await c.request('/rest/core/api/get');
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 401);
    assert.equal(f2.calls.length, 1);
  } finally {
    f2.restore();
  }
});

test('401：_retried 标记存在时不重复重授权', async () => {
  const f = withFetch(() => jsonRes({ msg: '未授权' }, 401));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    let reauth = 0;
    c.setReauthorizer(async () => { reauth++; });
    const r = await c.request('/rest/core/api/get', { _retried: true });
    assert.equal(r.httpStatus, 401);
    assert.equal(reauth, 0);
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test('5xx：平台通用异常被归一化为可行动消息', async () => {
  const cases: Array<[number, RegExp]> = [
    [500, /平台内部错误（HTTP 500）/],
    [502, /平台网关\/服务暂不可用（HTTP 502）/],
    [503, /平台网关\/服务暂不可用（HTTP 503）/],
    [504, /平台网关\/服务暂不可用（HTTP 504）/],
    [599, /平台返回 HTTP 599/],
  ];
  for (const [status, re] of cases) {
    const f = withFetch(() => jsonRes({ msg: 'Service run exception' }, status, { 'x-trace-id': 'tid-1' }));
    try {
      const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
      const r = await c.request('/rest/core/api/get');
      assert.equal(r.ok, false, `status=${status}`);
      assert.equal(r.httpStatus, status);
      assert.ok(r.msg);
      assert.match(r.msg, re);
      assert.match(r.msg, /Service run exception/);
      assert.match(r.msg, /traceId=tid-1/);
      assert.equal(r.traceId, 'tid-1');
    } finally {
      f.restore();
    }
  }
});

test('5xx：无平台 msg 时仅给出归一化提示；4xx 不做归一化', async () => {
  const f1 = withFetch(() => jsonRes({}, 500));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/core/api/get');
    assert.ok(r.msg);
    assert.match(r.msg, /平台内部错误（HTTP 500）/);
    assert.equal(r.msg.includes('traceId='), false);
  } finally {
    f1.restore();
  }

  const f2 = withFetch(() => jsonRes({ msg: '参数错误' }, 400));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/core/api/get');
    assert.equal(r.msg, '参数错误');
    assert.equal(r.ok, false);
  } finally {
    f2.restore();
  }
});

test('业务失败：state=false 视为失败；errcode/traceId 透传', async () => {
  const f = withFetch(() => jsonRes({ state: false, errcode: 40001, msg: '业务校验失败', traceId: 'tr-9' }));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/core/api/get');
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 200);
    assert.equal(r.errcode, 40001);
    assert.equal(r.msg, '业务校验失败');
    assert.equal(r.traceId, 'tr-9');
  } finally {
    f.restore();
  }
});

test('非 JSON 响应体降级为 raw 片段', async () => {
  const f = withFetch(() => new Response('<html>bad gateway</html>', { status: 200 }));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/core/api/get');
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, { raw: '<html>bad gateway</html>' });
  } finally {
    f.restore();
  }
});

test('空响应体 → data 为 null', async () => {
  const f = withFetch(() => new Response('', { status: 200 }));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/core/api/get');
    assert.equal(r.ok, true);
    assert.equal(r.data, null);
    assert.equal(r.msg, undefined);
  } finally {
    f.restore();
  }
});

test('网络异常：转成可行动提示，httpStatus=-1（**不能用 0**，0 是 dry-run 的取值）', async () => {
  const f = withFetch(() => {
    const e: any = new Error('fetch failed');
    e.cause = { code: 'ENOTFOUND' };
    throw e;
  });
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/core/api/get');
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, -1);
    assert.ok(r.msg);
    assert.match(r.msg, /网络请求失败：fetch failed/);
    assert.match(r.msg, /域名无法解析/);
    assert.match(r.msg, /platform\.example\.test/);
  } finally {
    f.restore();
  }
});

test('超时：超时后中止请求并返回失败', async () => {
  const f = withFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e: any = new Error('The operation was aborted');
      e.name = 'AbortError';
      reject(e);
    });
  }));
  try {
    const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: tmpDir().dir });
    const r = await c.request('/rest/core/api/get', { timeoutMs: 20 });
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, -1);
    assert.ok(r.msg);
    assert.match(r.msg, /网络请求失败/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.signal.aborted, true);
  } finally {
    f.restore();
  }
});

test('审计：请求落盘 jsonl，含 actor/profile/status/traceId', async () => {
  const dir = tmpDir('rc-audit-');
  try {
    const f = withFetch(() => jsonRes({ state: true, traceId: 'tr-1' }));
    try {
      await withEnv({ RC_ACTOR: 'tester' }, async () => {
        const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: dir.dir });
        await c.request('/rest/core/api/get');
      });
    } finally {
      f.restore();
    }
    const files = readdirSync(dir.dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{4}-\d{2}\.jsonl$/);
    const lines = readFileSync(join(dir.dir, files[0]), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.actor, 'tester');
    assert.equal(entry.profile, 'dev');
    assert.equal(entry.method, 'GET');
    assert.equal(entry.path, '/rest/core/api/get');
    assert.equal(entry.status, 200);
    assert.equal(entry.ok, true);
    assert.equal(entry.traceId, 'tr-1');
    assert.equal(typeof entry.ms, 'number');
  } finally {
    dir.cleanup();
  }
});

test('审计：默认目录取 ~/.rc/audit（HOME 可重定向）', async () => {
  const home = tmpDir('rc-home-');
  try {
    const f = withFetch(() => jsonRes({ state: true }));
    try {
      await withEnv({ HOME: home.dir, USER: 'envuser' }, async () => {
        const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev' });
        await c.request('/rest/core/api/get');
      });
    } finally {
      f.restore();
    }
    assert.ok(existsSync(join(home.dir, '.rc', 'audit')));
    const files = readdirSync(join(home.dir, '.rc', 'audit'));
    const entry = JSON.parse(readFileSync(join(home.dir, '.rc', 'audit', files[0]), 'utf8').trim());
    assert.equal(entry.actor, 'envuser');
  } finally {
    home.cleanup();
  }
});

test('审计：写入失败不阻断（非 prod 静默，prod 打印阻断提示）', async () => {
  const home = tmpDir('rc-home-');
  try {
    const badDir = join(home.dir, 'file.txt');
    writeFileSync(badDir, 'x');

    const f1 = withFetch(() => jsonRes({ state: true }));
    let out1 = '';
    try {
      const c = new RestCloudClient({ baseUrl: BASE, profile: 'dev', auditDir: join(badDir, 'sub') });
      out1 = (await captureLog(() => c.request('/rest/core/api/get'))).err;
      // 非 prod：审计失败不阻断，但必须可见
      assert.match(out1, /审计写入失败（未阻断）/);
    } finally {
      f1.restore();
    }

    const f2 = withFetch(() => jsonRes({ state: true }));
    try {
      // prod：审计写不进去 = 这次写操作没有留痕 → 真正阻断（E_AUDIT）
      const { err: out2 } = await captureLog(async () => {
        const c = new RestCloudClient({ baseUrl: BASE, profile: 'prod', auditDir: join(badDir, 'sub') });
        await assert.rejects(() => c.request('/rest/core/api/get'), (e: any) => e.code === 'E_AUDIT');
      });
      assert.equal(out2, '');
    } finally {
      f2.restore();
    }
  } finally {
    home.cleanup();
  }
});

test('createClient：环境变量/参数优先级与缺地址报错', async () => {
  await withEnv({ RC_BASE_URL: undefined, RC_PROFILE: undefined }, () => {
    assert.throws(() => createClient(), /缺少平台地址：请设置 RC_BASE_URL/);
  });

  await withEnv({ RC_BASE_URL: 'https://env.test/rest', RC_PROFILE: 'dev' }, () => {
    const c = createClient();
    assert.equal(c.baseUrl, 'https://env.test/rest');
    assert.equal(c.readOnly, false);
  });

  await withEnv({ RC_BASE_URL: 'https://env.test/rest', RC_PROFILE: 'prod' }, () => {
    const c = createClient();
    assert.equal(c.readOnly, true);
  });

  // RC_PROFILE 未设置 → 默认 uat
  await withEnv({ RC_BASE_URL: 'https://env.test/rest', RC_PROFILE: undefined }, () => {
    const c = createClient();
    assert.equal(c.readOnly, false);
  });

  const dir = tmpDir('rc-cc-');
  try {
    const c = createClient({ baseUrl: 'https://arg.test/rest', profile: 'uat', auditDir: dir.dir });
    assert.equal(c.baseUrl, 'https://arg.test/rest');
    assert.equal(c.readOnly, false);
  } finally {
    dir.cleanup();
  }
});
