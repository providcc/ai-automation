/**
 * 运营分析域单测：评估列表 / 评估报表 / 应用报表 / 运营摘要。
 * 全部使用桩客户端，不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessList, assessReport, appReport, opsSummary, OPS } from '../../packages/core/src/operations.ts';
import { stub, ok, fail } from './helpers.ts';

test('运营端点常量符合平台契约', () => {
  assert.equal(OPS.assessList, '/rest/operation/assess/api/list/page');
  assert.equal(OPS.assessReport, '/rest/operation/assess/api/report');
  assert.equal(OPS.appReport, '/rest/operation/assess/api/list/app/report');
  assert.equal(OPS.assessSave, '/rest/operation/assess/api/save');
  assert.equal(OPS.assessConfigList, '/rest/operation/assess/api/config/list/page');
});

test('运营：评估列表默认分页与自定义分页', async () => {
  const { client, calls } = stub(() => ok({ rows: [] }));
  await assessList(client);
  assert.equal(calls[0].path, OPS.assessList);
  assert.deepEqual(calls[0].opts.query, { page: 1, size: 50 });

  const paged = stub(() => ok({ rows: [] }));
  await assessList(paged.client, 3, 20);
  assert.deepEqual(paged.calls[0].opts.query, { page: 3, size: 20 });
});

test('运营：评估报表支持自定义查询条件', async () => {
  const { client, calls } = stub(() => ok({}));
  await assessReport(client, { appId: 'app-1', dimension: 'latency' });
  assert.equal(calls[0].path, OPS.assessReport);
  assert.deepEqual(calls[0].opts.query, { appId: 'app-1', dimension: 'latency' });

  const empty = stub(() => ok({}));
  await assessReport(empty.client);
  assert.deepEqual(empty.calls[0].opts.query, {});
});

test('运营：应用报表可指定 appId', async () => {
  const { client, calls } = stub(() => ok({}));
  await appReport(client, 'app-9');
  assert.equal(calls[0].path, OPS.appReport);
  assert.deepEqual(calls[0].opts.query, { appId: 'app-9' });

  const none = stub(() => ok({}));
  await appReport(none.client);
  assert.deepEqual(none.calls[0].opts.query, { appId: undefined });
});

test('运营摘要：聚合评估数量、Top 列表与应用报告', async () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ configId: `API${i}`, score: i }));
  const { client, calls } = stub((path) => {
    if (path.includes('/list/page')) return ok({ rows });
    if (path.includes('/app/report')) return ok({ data: { appId: 'app-1', count: 4 } });
    return ok({});
  });

  const s = await opsSummary(client);
  assert.equal(s.assessedApis, 15);
  assert.equal(s.top.length, 10);
  assert.equal((s.top[0] as any).configId, 'API0');
  assert.deepEqual(s.appReport, { appId: 'app-1', count: 4 });
  assert.deepEqual(s.notes, []);
  assert.equal(calls.length, 2);
});

test('运营摘要：兼容裸数组与 data 数组形态的列表', async () => {
  const arr = stub((path) => (path.includes('/list/page') ? ok([{ id: 1 }, { id: 2 }]) : ok({})));
  assert.equal((await opsSummary(arr.client)).assessedApis, 2);

  const data = stub((path) => (path.includes('/list/page') ? ok({ data: [{ id: 1 }] }) : ok({})));
  assert.equal((await opsSummary(data.client)).assessedApis, 1);
});

test('运营摘要：列表失败与应用报告失败都写入 notes', async () => {
  const { client } = stub((path) => {
    if (path.includes('/list/page')) return fail('评估服务不可用', 500);
    if (path.includes('/app/report')) return { ok: false, httpStatus: 502, data: {}, request: { method: 'GET', url: '/x' } };
    return ok({});
  });
  const s = await opsSummary(client);
  assert.equal(s.assessedApis, 0);
  assert.deepEqual(s.top, []);
  assert.equal(s.notes.length, 2);
  assert.ok(s.notes[0].includes('评估列表失败') && s.notes[0].includes('评估服务不可用'));
  assert.ok(s.notes[1].includes('应用报告失败') && s.notes[1].includes('502'));
});

test('运营摘要：应用报告取 data.data 优先于 data', async () => {
  const { client } = stub((path) => {
    if (path.includes('/list/page')) return ok([]);
    if (path.includes('/app/report')) return ok({ data: { inner: true }, outer: 1 });
    return ok({});
  });
  const s = await opsSummary(client);
  assert.deepEqual(s.appReport, { inner: true });
});

test('运营摘要：列表失败且无 msg 时回退到 HTTP 状态码', async () => {
  const { client } = stub((path) => {
    if (path.includes('/list/page')) {
      return { ok: false, httpStatus: 503, data: {}, request: { method: 'GET', url: '/x' } };
    }
    return ok({});
  });
  const s = await opsSummary(client);
  assert.ok(s.notes[0].includes('503'), `notes 未包含状态码：${s.notes[0]}`);
});
