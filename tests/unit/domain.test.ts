import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSpecs, breakingChanges } from '../../packages/core/src/api.ts';
import { resolveTarget, loadTargets, networkHint } from '../../packages/core/src/targets.ts';
import { buildNodeProps, assertNodeProps } from '../../packages/core/src/flow-props.ts';
import { uploadFile } from '../../packages/core/src/upload.ts';
import { RestCloudClient } from '../../packages/core/src/client.ts';
import { encryptPassword } from '../../packages/core/src/auth.ts';
import { RcError } from '../../packages/core/src/errors.ts';

test('OpenAPI diff：新增/删除/变更', () => {
  const a = { paths: { '/a': { get: {} }, '/b': { post: {} } } };
  const b = { paths: { '/a': { get: { summary: 'x' } }, '/c': { get: {} } } };
  const d = diffSpecs(a, b);
  assert.deepEqual(d.added, ['/c']);
  assert.deepEqual(d.removed, ['/b']);
  assert.deepEqual(d.changed, ['/a']);
});

test('破坏性变更：删除路径/方法/请求体结构变化', () => {
  const a = { paths: { '/a': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } }, '/b': { get: {} } } };
  const b = { paths: { '/a': { post: { requestBody: { content: { 'application/json': { schema: { type: 'array' } } } } } } } };
  const br = breakingChanges(a, b);
  assert.ok(br.some((x) => x.includes('删除路径 /b')));
  assert.ok(br.some((x) => x.includes('请求体结构变更')));
});

test('多目标：未配置时给出空目标，未知目标报错', () => {
  const targets = loadTargets({ file: '/nonexistent.json' });
  assert.equal(targets.length, 0);
  assert.equal(resolveTarget(undefined, { file: '/nonexistent.json' }).name, 'default');
  assert.throws(() => resolveTarget('gateway', { file: '/nonexistent.json' }), /未知 target/);
  assert.throws(() => resolveTarget('nope', { file: '/nonexistent.json' }), /未知 target/);
  assert.match(networkHint({ name: 'x', baseUrl: '', role: '', network: 'intranet' }), /VPN/);
});

test('属性组装：base 与 values 合并，标识不可被覆盖', () => {
  const p = buildNodeProps({
    appId: 'A', processId: 'P', nodeId: 'T00001', nodeType: 'apiNode', nodeName: 'API',
    base: { retryNum: '3', stale: 'x' },
    values: { pNodeId: 'HACK', apiUrl: 'http://x' },
  });
  assert.equal(p.pNodeId, 'T00001');
  assert.equal(p.retryNum, '3');
  assert.equal(p.apiUrl, 'http://x');
  assert.deepEqual(assertNodeProps(p), []);
});

test('上传：dry-run 不触网；prod 只读拦截', async () => {
  const c = new RestCloudClient({ baseUrl: 'https://example.invalid/restcloud', profile: 'uat' });
  const r = await uploadFile(c, '/rest/core/monitor/upload', '/etc/hosts', { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.status, 0);

  const prod = new RestCloudClient({ baseUrl: 'https://example.invalid/restcloud', profile: 'prod' });
  delete process.env.RC_ALLOW_PROD_WRITE;
  await assert.rejects(() => uploadFile(prod, '/x', '/etc/hosts', {}), (e: any) => e instanceof RcError && e.code === 'E_PROD_READONLY');
});

test('RSA 加密可复现且非明文', () => {
  const a = encryptPassword('secret');
  const b = encryptPassword('secret');
  assert.notEqual(a, 'secret');
  assert.equal(a.length, b.length);
  assert.equal(Buffer.from(a, 'base64').length, 256);
});
