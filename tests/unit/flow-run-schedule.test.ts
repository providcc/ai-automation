/**
 * 运行 / 调度两条端点的行为：
 *  - runFlow 先走 /process/run，失败且可重试时回退 /monitor/instance/run；
 *  - BPM 规则服务不可用时的降级路径（写流程记录 expression + /process/start）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as FLOW from '../../packages/core/src/flow-lifecycle.ts';

type Call = { path: string; opts: any };

function fake(handler: (path: string, opts: any, calls: Call[]) => any) {
  const calls: Call[] = [];
  const client = {
    baseUrl: 'https://example.test/restcloud',
    readOnly: false,
    request: async (path: string, opts: any = {}) => {
      calls.push({ path, opts });
      return handler(path, opts, calls);
    },
  };
  return { client: client as any, calls };
}

const res = (httpStatus: number, data: any = {}, msg?: string) => ({
  // 与 RestCloudClient 一致：state=false 时 ok=false（平台失败常带 HTTP 200）
  ok: httpStatus >= 200 && httpStatus < 300 && (data as any)?.state !== false && (data as any)?.state !== 'false',
  httpStatus,
  msg,
  data,
  request: { method: 'POST', url: '/x' },
});

test('runFlow 优先走 /process/run', async () => {
  const { client, calls } = fake(() => res(200, { state: true, msg: '执行结果:E00002 是否成功=是' }));
  const r = await FLOW.runFlow(client, 'p1');
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/rest/esb/process/run');
  assert.deepEqual(calls[0].opts.body, { processId: 'p1' });
});

test('runFlow：/process/run 返回 state=false 但 resultCode=1 → 视为成功', async () => {
  const { client } = fake(() =>
    res(200, { state: false, resultCode: 1, msg: '执行结果: 是否成功=是 需要补偿=否', transactionId: 't1' }),
  );
  const r = await FLOW.runFlow(client, 'p1');
  assert.equal(r.ok, true);
  assert.equal((r.data as any).transactionId, 't1');
});

test('runFlow：/process/run 5xx 时回退 /monitor/instance/run', async () => {
  const { client, calls } = fake((path) => {
    if (path.endsWith('/monitor/instance/run')) return res(200, { state: true, msg: 'ok' });
    return res(500, {}, 'Service run exception');
  });
  const r = await FLOW.runFlow(client, 'p1');
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.path), [
    '/rest/esb/process/run',
    '/rest/esb/process/monitor/instance/run',
  ]);
});

test('runFlow：/process/run 404（老版本无此端点）也回退', async () => {
  const { client, calls } = fake((path) => {
    if (path.endsWith('/monitor/instance/run')) return res(200, { state: true });
    return res(404, {}, '未匹配到任何API');
  });
  const r = await FLOW.runFlow(client, 'p1');
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
});

test('runFlow：4xx 业务错误不回退（避免流程被执行两次）', async () => {
  const { client, calls } = fake(() => res(400, {}, '参数错误'));
  const r = await FLOW.runFlow(client, 'p1');
  assert.equal(r.ok, false);
  assert.equal(r.httpStatus, 400);
  assert.equal(calls.length, 1);
});

test('runFlow：两个端点都失败时返回主端点错误', async () => {
  const { client, calls } = fake((path) =>
    path.endsWith('/monitor/instance/run') ? res(500, {}, 'fallback failed') : res(500, {}, 'primary failed'),
  );
  const r = await FLOW.runFlow(client, 'p1');
  assert.equal(r.ok, false);
  assert.equal(r.msg, 'primary failed');
  assert.equal(calls.length, 2);
});

test('saveScheduleViaProcess：写 expression → start → 回读校验', async () => {
  const { client, calls } = fake((path, opts) => {
    if (path === '/rest/esb/process/p1' && opts.method === 'GET') {
      return res(200, { processId: 'p1', configName: 'F', state: '2', expression: calls.length > 3 ? '0 0 * * * ?' : null });
    }
    if (path === '/rest/esb/process/save') return res(200, { state: true, msg: '流程保存成功!' });
    if (path === '/rest/esb/process/start') return res(200, { state: true, msg: '成功启动流程调度服务!' });
    return res(404, {});
  });
  const r = await FLOW.saveScheduleViaProcess(client, { processIds: ['p1'], cron: '0 0 * * * ?' });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].expression, '0 0 * * * ?');
  const saved = calls.find((c) => c.path === '/rest/esb/process/save')!;
  assert.equal(saved.opts.body.expression, '0 0 * * * ?');
  assert.equal(saved.opts.body.runExpression, '0 0 * * * ?');
  assert.equal(saved.opts.body.executeServer, 'Task');
  const started = calls.find((c) => c.path === '/rest/esb/process/start')!;
  assert.deepEqual(started.opts.body, { processId: 'p1' });
});

test('saveScheduleViaProcess：回读不到 expression 视为失败', async () => {
  const { client } = fake((path, opts) => {
    if (path === '/rest/esb/process/p1' && opts.method === 'GET') return res(200, { processId: 'p1', expression: null });
    if (path === '/rest/esb/process/save') return res(200, { state: true });
    if (path === '/rest/esb/process/start') return res(200, { state: true });
    return res(404, {});
  });
  const r = await FLOW.saveScheduleViaProcess(client, { processIds: ['p1'], cron: '0 0 * * * ?' });
  assert.equal(r.ok, false);
  assert.match(r.results[0].msg ?? '', /回读/);
});

test('saveScheduleViaProcess：启动失败时带出平台消息', async () => {
  const { client } = fake((path, opts) => {
    if (path === '/rest/esb/process/p1' && opts.method === 'GET') return res(200, { processId: 'p1' });
    if (path === '/rest/esb/process/save') return res(200, { state: true });
    if (path === '/rest/esb/process/start') return res(200, { state: false }, '启动失败,定时表达式不能为空!');
    return res(404, {});
  });
  const r = await FLOW.saveScheduleViaProcess(client, { processIds: ['p1'], cron: '0 0 * * * ?' });
  // 平台对"启动失败"仍返回 HTTP 200，只有 msg 带失败原因
  assert.equal(r.ok, false);
  assert.match(r.results[0].msg ?? '', /启动失败/);
});

test('listScheduledFlows：只列 expression 非空的流程', async () => {
  const { client } = fake(() =>
    res(200, {
      rows: [
        { processId: 'p1', configName: 'A', expression: '0 0 * * * ?' },
        { processId: 'p2', configName: 'B' },
        { processId: 'p3', configName: 'C', runExpression: '0 0/30 * * * ?' },
      ],
    }),
  );
  const r = await FLOW.listScheduledFlows(client);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map((x) => x.processIds), ['p1', 'p3']);
});
