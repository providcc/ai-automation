/**
 * 监控域单测：摘要聚合 / 服务日志 / 错误码分组。
 * 全部使用桩客户端，不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summary, serviceLogs, MONITOR } from '../../packages/core/src/monitor.ts';
import { stub, ok, fail } from './helpers.ts';

test('监控端点常量符合平台契约', () => {
  assert.equal(MONITOR.apis, '/rest/core/apimonitor/apis');
  assert.equal(MONITOR.callsPerMinute, '/rest/core/monitor/apicalls/minute');
  assert.equal(MONITOR.logs('svc-1'), '/rest/core/monitor/logs/svc-1');
  assert.equal(MONITOR.logToday, '/rest/core/monitor/log/today');
  assert.equal(MONITOR.errorReport, '/rest/core/monitor/errorcode/report');
});

test('监控摘要：聚合接口数、调用序列与错误码分组', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('apimonitor/apis')) return ok([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]);
    if (path.includes('apicalls/minute')) return ok([1, 2, 3, 4]);
    if (path.includes('errorcode/report')) {
      return ok([
        { code: 'E_TIMEOUT', count: 12 },
        { code: 'E_AUTH', count: 3 },
      ]);
    }
    return ok({});
  });

  const s = await summary(client);
  assert.equal(s.hours, 24);
  assert.equal(s.apiCount, 3);
  assert.deepEqual(s.callSeries, [1, 2, 3, 4]);
  assert.deepEqual(s.errorCodes, [
    { code: 'E_TIMEOUT', count: 12 },
    { code: 'E_AUTH', count: 3 },
  ]);
  assert.deepEqual(s.notes, []);
  assert.ok(typeof s.fetchedAt === 'string' && s.fetchedAt.length > 0);
  assert.equal(calls.length, 3);
});

test('监控摘要：自定义时间窗口', async () => {
  const { client } = stub(() => ok([]));
  const s = await summary(client, 72);
  assert.equal(s.hours, 72);
});

test('监控摘要：接口列表非数组时取 total 字段', async () => {
  const { client } = stub((path) => {
    if (path.includes('apimonitor/apis')) return ok({ total: 42 });
    return ok([]);
  });
  const s = await summary(client);
  assert.equal(s.apiCount, 42);
});

test('监控摘要：调用序列非数组时为空，错误码分组为嵌套 data', async () => {
  const { client } = stub((path) => {
    if (path.includes('apicalls/minute')) return ok({ total: 0 });
    if (path.includes('errorcode/report')) return ok({ data: [{ code: 'E_X', count: 1 }] });
    return ok([]);
  });
  const s = await summary(client);
  assert.equal(s.callSeries, undefined);
  assert.deepEqual(s.errorCodes, [{ code: 'E_X', count: 1 }]);
});

test('监控摘要：单个子查询失败不整体失败，失败原因写入 notes', async () => {
  const { client } = stub((path) => {
    if (path.includes('apicalls/minute')) return fail('统计服务不可用', 503);
    if (path.includes('errorcode/report')) return fail('没有权限', 403);
    return ok([{ id: 'a1' }]);
  });
  const s = await summary(client);
  assert.equal(s.apiCount, 1);
  assert.equal(s.notes.length, 2);
  assert.ok(s.notes.some((n) => n.includes('/rest/core/monitor/apicalls/minute') && n.includes('统计服务不可用')));
  assert.ok(s.notes.some((n) => n.includes('/rest/core/monitor/errorcode/report') && n.includes('没有权限')));
});

test('监控摘要：失败且无 msg 时回退到 HTTP 状态码', async () => {
  const { client } = stub((path) => {
    if (path.includes('apimonitor/apis')) {
      return { ok: false, httpStatus: 500, data: {}, request: { method: 'GET', url: '/x' } };
    }
    return ok([]);
  });
  const s = await summary(client);
  assert.ok(s.notes[0].includes('500'), `notes 未包含状态码：${s.notes[0]}`);
});

test('监控摘要：空响应体归一为 null', async () => {
  const { client } = stub(() => ok(null));
  const s = await summary(client);
  assert.equal(s.apiCount, undefined);
  assert.equal(s.callSeries, undefined);
  assert.equal(s.errorCodes, null);
});

test('服务日志：按 serviceId 拉取日志', async () => {
  const { client, calls } = stub(() => ok({ rows: [{ ts: '2026-10-20', level: 'ERROR' }] }));
  const r = await serviceLogs(client, 'svc-42');
  assert.equal(r.ok, true);
  assert.equal(calls[0].path, '/rest/core/monitor/logs/svc-42');
  assert.equal(calls[0].opts.method, 'GET');
});
