import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uploadFile } from '../../packages/core/src/upload.ts';
import { RcError } from '../../packages/core/src/errors.ts';
import { stub, ok, tmpDir } from './helpers.ts';

/** 构造一个带 Cookie 能力的桩客户端（upload 需要 exportCookies / baseUrl / readOnly）。 */
function uploadClient(cookies: Record<string, string> = {}) {
  const { client, calls } = stub(() => ok({}));
  client.exportCookies = () => ({ ...cookies });
  return { client, calls };
}

/** 临时替换全局 fetch，捕获调用参数。 */
async function withFetch(
  impl: (url: string, init: any) => Promise<any>,
  fn: () => Promise<void>,
): Promise<void> {
  const orig = globalThis.fetch;
  (globalThis as any).fetch = impl;
  try {
    await fn();
  } finally {
    (globalThis as any).fetch = orig;
  }
}

test('uploadFile：只读环境拒绝上传', async () => {
  const tmp = tmpDir('rc-upload-');
  try {
    const file = tmp.write('a.txt', 'hello');
    const { client } = uploadClient();
    client.readOnly = true;
    await assert.rejects(
      () => uploadFile(client, '/rest/upload', file),
      (e: any) => {
        assert.ok(e instanceof RcError);
        assert.equal(e.code, 'E_PROD_READONLY');
        assert.match(e.message, /prod 只读/);
        return true;
      },
    );
  } finally {
    tmp.cleanup();
  }
});

test('uploadFile：文件不存在时抛出底层读取错误', async () => {
  const tmp = tmpDir('rc-upload-');
  try {
    const { client } = uploadClient();
    await assert.rejects(() => uploadFile(client, '/rest/upload', join(tmp.dir, 'missing.txt')), /ENOENT/);
  } finally {
    tmp.cleanup();
  }
});

test('uploadFile：超过 20MB 上限时报 E_VALIDATION', async () => {
  const tmp = tmpDir('rc-upload-');
  try {
    const file = join(tmp.dir, 'big.bin');
    writeFileSync(file, Buffer.alloc(20 * 1024 * 1024 + 1));
    const { client } = uploadClient();
    await assert.rejects(
      () => uploadFile(client, '/rest/upload', file),
      (e: any) => {
        assert.ok(e instanceof RcError);
        assert.equal(e.code, 'E_VALIDATION');
        assert.match(e.message, /文件过大（20\.0MB）/);
        return true;
      },
    );
  } finally {
    tmp.cleanup();
  }
});

test('uploadFile：dry-run 只预览不触网', async () => {
  const tmp = tmpDir('rc-upload-');
  try {
    const file = tmp.write('demo.txt', 'hello');
    const { client } = uploadClient();
    let fetched = 0;
    await withFetch(
      async () => {
        fetched += 1;
        return { ok: true, status: 200, text: async () => '{}' };
      },
      async () => {
        const r = await uploadFile(client, '/rest/upload', file, { dryRun: true, fields: { kind: 'wsdl' } });
        assert.equal(r.ok, true);
        assert.equal(r.status, 0);
        assert.equal(r.dryRun, true);
        assert.match(r.msg as string, /dry-run：将上传 demo\.txt（5B）到 \/rest\/upload，字段 file/);
        assert.deepEqual(r.data, { fields: { kind: 'wsdl' } });
      },
    );
    assert.equal(fetched, 0);
  } finally {
    tmp.cleanup();
  }
});

test('uploadFile：multipart 表单上传并携带 Cookie', async () => {
  const tmp = tmpDir('rc-upload-');
  try {
    const file = tmp.write('demo.txt', 'hello');
    const { client, calls } = uploadClient({ identitytoken: 'abc' });
    let seenUrl = '';
    let seenInit: any;
    await withFetch(
      async (url: string, init: any) => {
        seenUrl = url;
        seenInit = init;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ state: true, msg: '上传成功', traceId: 'tr-1', data: { fileId: 'f1' } }),
        };
      },
      async () => {
        const r = await uploadFile(client, '/rest/upload/file', file, { fields: { kind: 'excel', version: 2 } });
        assert.equal(r.ok, true);
        assert.equal(r.status, 200);
        assert.equal(r.msg, '上传成功');
        assert.equal(r.traceId, 'tr-1');
        assert.deepEqual(r.data, { state: true, msg: '上传成功', traceId: 'tr-1', data: { fileId: 'f1' } });
      },
    );
    assert.equal(seenUrl, 'https://example.test/restcloud/rest/upload/file');
    assert.equal(seenInit.method, 'POST');
    assert.equal(seenInit.headers.Cookie, 'identitytoken=abc');
    const fd = seenInit.body as FormData;
    assert.ok(fd instanceof FormData);
    const uploaded = fd.get('file') as any;
    assert.equal(uploaded.name, 'demo.txt');
    assert.equal(await uploaded.text(), 'hello');
    assert.equal(fd.get('kind'), 'excel');
    assert.equal(fd.get('version'), '2');
    // 已有 Cookie 时不再触发认证请求
    assert.equal(calls.length, 0);
  } finally {
    tmp.cleanup();
  }
});

test('uploadFile：自定义表单字段名', async () => {
  const tmp = tmpDir('rc-upload-');
  try {
    const file = tmp.write('cert.p12', 'cert');
    const { client } = uploadClient({ identitytoken: 'abc' });
    let fd: FormData | undefined;
    await withFetch(
      async (_url: string, init: any) => {
        fd = init.body as FormData;
        return { ok: true, status: 200, text: async () => '{}' };
      },
      async () => {
        const r = await uploadFile(client, '/rest/upload/cert', file, { field: 'certFile' });
        assert.equal(r.ok, true);
      },
    );
    assert.equal((fd!.get('certFile') as any).name, 'cert.p12');
    assert.equal(fd!.get('file'), null);
  } finally {
    tmp.cleanup();
  }
});

test('uploadFile：无 Cookie 时先触发一次认证请求', async () => {
  const tmp = tmpDir('rc-upload-');
  try {
    const file = tmp.write('demo.txt', 'hello');
    const { client, calls } = uploadClient();
    await withFetch(
      async () => ({ ok: true, status: 200, text: async () => '{"state":true}' }),
      async () => {
        await uploadFile(client, '/rest/upload/file', file);
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/rest/base/users/context');
    assert.equal(calls[0].opts.method, 'GET');
  } finally {
    tmp.cleanup();
  }
});

test('uploadFile：非 JSON 响应被收敛为 raw 文本', async () => {
  const tmp = tmpDir('rc-upload-');
  try {
    const file = tmp.write('demo.txt', 'hello');
    const { client } = uploadClient({ identitytoken: 'abc' });
    await withFetch(
      async () => ({ ok: true, status: 200, text: async () => 'not-json-body' }),
      async () => {
        const r = await uploadFile(client, '/rest/upload/file', file);
        assert.equal(r.ok, true);
        assert.deepEqual(r.data, { raw: 'not-json-body' });
        assert.equal(r.msg, undefined);
      },
    );
  } finally {
    tmp.cleanup();
  }
});

test('uploadFile：HTTP 失败或 state=false 时返回 ok=false', async () => {
  const tmp = tmpDir('rc-upload-');
  try {
    const file = tmp.write('demo.txt', 'hello');
    const { client } = uploadClient({ identitytoken: 'abc' });
    await withFetch(
      async () => ({ ok: false, status: 500, text: async () => '{"msg":"内部错误","state":false}' }),
      async () => {
        const r = await uploadFile(client, '/rest/upload/file', file);
        assert.equal(r.ok, false);
        assert.equal(r.status, 500);
        assert.equal(r.msg, '内部错误');
      },
    );

    const { client: c2 } = uploadClient({ identitytoken: 'abc' });
    await withFetch(
      async () => ({ ok: true, status: 200, text: async () => '{"state":false,"msg":"业务拒绝"}' }),
      async () => {
        const r = await uploadFile(c2, '/rest/upload/file', file);
        assert.equal(r.ok, false);
        assert.equal(r.status, 200);
      },
    );
  } finally {
    tmp.cleanup();
  }
});

test('uploadFile：网络异常被翻译为 E_UPSTREAM', async () => {
  const tmp = tmpDir('rc-upload-');
  try {
    const file = tmp.write('demo.txt', 'hello');
    const { client } = uploadClient({ identitytoken: 'abc' });
    await withFetch(
      async () => {
        throw new Error('socket hang up');
      },
      async () => {
        await assert.rejects(
          () => uploadFile(client, '/rest/upload/file', file),
          (e: any) => {
            assert.ok(e instanceof RcError);
            assert.equal(e.code, 'E_UPSTREAM');
            assert.match(e.message, /上传失败：socket hang up/);
            return true;
          },
        );
      },
    );
  } finally {
    tmp.cleanup();
  }
});

test('uploadFile：超时触发 AbortController 并收敛为 E_UPSTREAM', async () => {
  const tmp = tmpDir('rc-upload-');
  try {
    const file = tmp.write('demo.txt', 'hello');
    const { client } = uploadClient({ identitytoken: 'abc' });
    await withFetch(
      async (_url: string, init: any) => {
        await new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('请求已中止')), { once: true });
        });
        return { ok: true, status: 200, text: async () => '{}' };
      },
      async () => {
        await assert.rejects(
          () => uploadFile(client, '/rest/upload/file', file, { timeoutMs: 10 }),
          (e: any) => {
            assert.ok(e instanceof RcError);
            assert.equal(e.code, 'E_UPSTREAM');
            assert.match(e.message, /上传失败：请求已中止/);
            return true;
          },
        );
      },
    );
  } finally {
    tmp.cleanup();
  }
});
