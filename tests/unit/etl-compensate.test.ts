/**
 * etl-compensate：补偿计划（plan）与补偿执行（apply）
 * 全部使用桩客户端，不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listEtlProcesses,
  buildEtlDependencies,
  listEtlInstances,
  listCompensations,
  planCompensation,
  executeCompensation,
  formatCompensationPlan,
  ETL_COMP,
} from '../../packages/core/src/etl-compensate.ts';
import { stub, ok, fail, withEnv } from './helpers.ts';

interface StubOpts {
  processes?: any[];
  instances?: any[];
  compensations?: any[];
  total?: number;
  compensateResponse?: any;
}

function makeClient(opts: StubOpts = {}) {
  const { client, calls } = stub((path: string) => {
    if (path.includes('/monitor/list/page')) return ok({ data: { rows: opts.instances ?? [] } });
    if (path.includes('/compensate/list')) return ok({ data: { rows: opts.compensations ?? [] } });
    if (path.includes('/process/list')) return ok({ data: { rows: opts.processes ?? [], total: opts.total ?? 0 } });
    if (path.includes('/compensate')) return opts.compensateResponse ?? ok({ compensationId: 'c1' });
    return ok({});
  });
  return { client, calls };
}

test('etl-compensate：端点常量', () => {
  assert.equal(ETL_COMP.compensate, '/rest/etl/process/compensate');
  assert.equal(ETL_COMP.list, '/rest/etl/process/compensate/list');
  assert.equal(ETL_COMP.monitor, '/rest/etl/process/monitor/list/page');
  assert.equal(ETL_COMP.history, '/rest/etl/process/monitor/historyinfo');
});

test('etl-compensate：listEtlProcesses 映射字段', async () => {
  const { client, calls } = makeClient({
    processes: [
      { processId: 'p1', processName: '父流程', configId: 'c1', categoryId: 'cat', state: 'ON', processModel: '{"a":1}' },
      { id: 'p2', configName: '子流程', parentProcessId: '', categoryId: 'cat2', state: 'OFF' },
    ],
  });
  const list = await listEtlProcesses(client);
  assert.equal(calls[0].path, '/rest/etl/process/list');
  assert.equal(calls[0].opts.method, 'GET');
  assert.equal(calls[0].opts.query.pageNo, 1);
  assert.equal(calls[0].opts.query.pageSize, 100);
  assert.equal(list.length, 2);
  assert.equal(list[0].processId, 'p1');
  assert.equal(list[0].processName, '父流程');
  assert.equal(list[0].configId, 'c1');
  assert.equal(list[0].categoryId, 'cat');
  assert.equal(list[0].state, 'ON');
  assert.equal(list[0].processModel, '{"a":1}');
  assert.equal(list[1].processId, 'p2');
  assert.equal(list[1].processName, '子流程');
  assert.equal(list[1].parentProcessId, undefined);
  assert.equal(list[1].processModel, undefined);
});

test('etl-compensate：listEtlProcesses 支持扁平分页响应（rows/total 同级）', async () => {
  const { client, calls } = stub((path: string) => {
    if (path.includes('/process/list')) return ok({ rows: [{ processId: 'p1' }, { processId: 'p2' }], total: 2 });
    return ok({});
  });
  const list = await listEtlProcesses(client);
  assert.equal(list.length, 2);
  assert.equal(calls.length, 1, '达到 total 后应停止翻页');
});

test('etl-compensate：listEtlProcesses 过滤没有 id 的记录', async () => {
  const { client } = makeClient({ processes: [{ configName: '没有 id' }] });
  const list = await listEtlProcesses(client);
  assert.equal(list.length, 0);
});

test('etl-compensate：listEtlProcesses 分页拉取', async () => {
  const rows100 = Array.from({ length: 100 }, (_, i) => ({ processId: `p${i}` }));
  const rows50 = Array.from({ length: 50 }, (_, i) => ({ processId: `q${i}` }));
  let page = 0;
  const { client, calls } = stub((path: string) => {
    if (path.includes('/process/list')) {
      page++;
      return ok({ data: { rows: page === 1 ? rows100 : rows50, total: 150 } });
    }
    return ok({});
  });
  const list = await listEtlProcesses(client);
  assert.equal(list.length, 150);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.query.pageNo, 2);
});

test('etl-compensate：listEtlProcesses 遵守 max 上限', async () => {
  const { client } = makeClient({ processes: [{ processId: 'p1' }, { processId: 'p2' }] });
  const list = await listEtlProcesses(client, 1);
  assert.equal(list.length, 1);
  assert.equal(list[0].processId, 'p1');
});

test('etl-compensate：buildEtlDependencies 计算父子依赖与深度', () => {
  const deps = buildEtlDependencies([
    { processId: 'p1', processName: '父' },
    { processId: 'p2', processName: '子', parentProcessId: 'p1' },
    { processId: 'p3', processName: '孙', parentProcessId: 'p2' },
    { processId: 'p4', processName: '孤儿', parentProcessId: 'pX' },
  ]);
  const byId = new Map(deps.map((d) => [d.processId, d]));
  assert.deepEqual(byId.get('p1')!.dependsOn, []);
  assert.equal(byId.get('p1')!.depth, 0);
  assert.deepEqual(byId.get('p2')!.dependsOn, ['p1']);
  assert.equal(byId.get('p2')!.depth, 1);
  assert.deepEqual(byId.get('p3')!.dependsOn, ['p2']);
  assert.equal(byId.get('p3')!.depth, 2);
  assert.deepEqual(byId.get('p4')!.dependsOn, []);
  assert.equal(byId.get('p4')!.depth, 0);
});

test('etl-compensate：buildEtlDependencies 遇到环不会死循环', () => {
  const deps = buildEtlDependencies([
    { processId: 'p1', parentProcessId: 'p2' },
    { processId: 'p2', parentProcessId: 'p1' },
  ]);
  assert.equal(deps.length, 2);
  for (const d of deps) assert.ok(Number.isFinite(d.depth));
});

test('etl-compensate：listEtlInstances 查询运行实例', async () => {
  const { client, calls } = makeClient({ instances: [{ transactionId: 't1' }] });
  const rows = await listEtlInstances(client, { processId: 'p1', state: 'FAIL', pageNo: 2, pageSize: 10 });
  assert.equal(calls[0].path, '/rest/etl/process/monitor/list/page');
  assert.deepEqual(calls[0].opts.query, { pageNo: 2, pageSize: 10, processId: 'p1', state: 'FAIL' });
  assert.equal(rows.length, 1);

  await listEtlInstances(client);
  assert.equal(calls[1].opts.query.pageNo, 1);
  assert.equal(calls[1].opts.query.pageSize, 100);
});

test('etl-compensate：listCompensations 查询补偿记录', async () => {
  const { client, calls } = makeClient({ compensations: [{ id: 'c1' }] });
  const rows = await listCompensations(client);
  assert.equal(calls[0].path, '/rest/etl/process/compensate/list');
  assert.equal(calls[0].opts.query.pageNo, 1);
  assert.equal(calls[0].opts.query.pageSize, 100);
  assert.equal(rows.length, 1);

  await listCompensations(client, { pageNo: 3, pageSize: 20 });
  assert.equal(calls[1].opts.query.pageNo, 3);
  assert.equal(calls[1].opts.query.pageSize, 20);
});

test('etl-compensate：planCompensation 从平台实例生成计划', async () => {
  const { client, calls } = makeClient({
    processes: [{ processId: 'p1', processName: '流程A' }],
    instances: [
      { transactionId: 't1', processId: 'p1', state: 'FAIL', startTime: '2026-01-02 10:00:00', errorMsg: '字段缺失' },
      { transactionId: 't2', processId: 'p1', state: 'ERROR', startTime: '2026-01-01 10:00:00' },
    ],
  });
  const plan = await planCompensation(client);
  assert.equal(plan.ok, true);
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].transactionId, 't2', '按开始时间排序');
  assert.equal(plan.items[0].processId, 'p1');
  assert.equal(plan.items[0].processName, '流程A');
  assert.equal(plan.items[0].depth, 0);
  assert.equal(plan.items[0].state, 'ERROR');
  assert.equal(plan.items[1].errorMsg, '字段缺失');
  assert.ok(plan.generatedAt);

  const monitor = calls.find((c) => c.path.includes('monitor/list/page'))!;
  assert.equal(monitor.opts.query.state, 'FAIL', '默认只查失败实例');
});

test('etl-compensate：planCompensation 支持自定义 state 与 processId', async () => {
  const { client, calls } = makeClient({ instances: [] });
  await planCompensation(client, { state: 'ERROR', processId: 'p9' });
  const monitor = calls.find((c) => c.path.includes('monitor/list/page'))!;
  assert.equal(monitor.opts.query.state, 'ERROR');
  assert.equal(monitor.opts.query.processId, 'p9');
});

test('etl-compensate：planCompensation 显式 transactionIds 时不再查实例', async () => {
  const { client, calls } = makeClient({ processes: [{ processId: 'p1', processName: '流程A' }] });
  const plan = await planCompensation(client, { transactionIds: ['t1', 't2'] });
  assert.equal(calls.filter((c) => c.path.includes('monitor/list/page')).length, 0);
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].transactionId, 't1');
  assert.equal(plan.items[0].processId, undefined);
  assert.equal(plan.items[0].processName, undefined);
  assert.equal(plan.items[0].depth, 0);
});

test('etl-compensate：planCompensation 跳过缺 id / 重复 / 成功的实例', async () => {
  const { client } = makeClient({
    instances: [
      { transactionId: 't1', state: 'FAIL' },
      { transactionId: 't1', state: 'FAIL' },
      { state: 'FAIL' },
      { transactionId: 't2', state: 'SUCCESS' },
      { id: 't3', status: 'FAIL' },
    ],
  });
  const plan = await planCompensation(client);
  assert.equal(plan.items.length, 2);
  assert.ok(plan.skipped.some((s) => s.reason === '记录缺少 transactionId'));
  assert.ok(plan.skipped.some((s) => s.reason === '重复实例'));
  assert.ok(plan.skipped.some((s) => s.reason.includes('无需补偿')));
  assert.equal(plan.ok, true);
});

test('etl-compensate：planCompensation 进程不在目录中时深度兜底为 0', async () => {
  const { client } = makeClient({
    processes: [{ processId: 'p1', processName: '流程A' }],
    instances: [{ transactionId: 't9', processId: 'pX', state: 'FAIL' }],
  });
  const plan = await planCompensation(client);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].depth, 0);
  assert.equal(plan.items[0].processName, undefined);
});

test('etl-compensate：planCompensation 没有实例时给出告警', async () => {
  const { client } = makeClient({ instances: [] });
  const plan = await planCompensation(client);
  assert.equal(plan.ok, false);
  assert.equal(plan.items.length, 0);
  assert.ok(plan.warnings.some((w) => w.includes('未查询到失败实例')));
});

test('etl-compensate：planCompensation 达到上限时截断并告警', async () => {
  const { client } = makeClient({
    instances: [{ transactionId: 't1' }, { transactionId: 't2' }, { transactionId: 't3' }],
  });
  const plan = await planCompensation(client, { max: 2 });
  assert.equal(plan.items.length, 2);
  assert.ok(plan.warnings.some((w) => w.includes('达到上限 2')));
});

test('etl-compensate：executeCompensation 默认 dry-run 且不发请求', async () => {
  const { client, calls } = makeClient({});
  const plan: any = { ok: true, generatedAt: 'x', items: [{ transactionId: 't1', depth: 0 }], skipped: [], warnings: [] };
  const res = await executeCompensation(client, plan);
  assert.equal(res.dryRun, true);
  assert.equal(res.report, undefined);
  assert.equal(calls.length, 0);
});

test('etl-compensate：executeCompensation apply 需要打开写闸门', async () => {
  await withEnv({ RC_ENABLE_ETL_WRITE: undefined }, async () => {
    const { client, calls } = makeClient({});
    const plan: any = { ok: true, generatedAt: 'x', items: [{ transactionId: 't1', depth: 0 }], skipped: [], warnings: [] };
    await assert.rejects(() => executeCompensation(client, plan, { apply: true }), /ETL 写操作已封禁/);
    assert.equal(calls.length, 0);
  });
});

test('etl-compensate：executeCompensation apply 按 transactionId 串行补偿', async () => {
  await withEnv({ RC_ENABLE_ETL_WRITE: '1' }, async () => {
    const { client, calls } = makeClient({});
    const plan: any = {
      ok: true,
      generatedAt: 'x',
      items: [{ transactionId: 't1', depth: 0 }, { transactionId: 't2', depth: 0 }],
      skipped: [],
      warnings: [],
    };
    const res = await executeCompensation(client, plan, { apply: true });
    assert.equal(res.dryRun, false);
    assert.equal(res.report!.passed, 2);
    assert.equal(res.report!.failed, 0);
    assert.equal(res.report!.ok, true);
    const posts = calls.filter((c) => c.path === '/rest/etl/process/compensate');
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[0].opts.body, { transactionId: 't1' });
    assert.deepEqual(posts[1].opts.body, { transactionId: 't2' });
    assert.equal(posts[0].opts.dryRun, false);
  });
});

test('etl-compensate：executeCompensation 单条失败即停并记录错误', async () => {
  await withEnv({ RC_ENABLE_ETL_WRITE: '1' }, async () => {
    const { client } = makeClient({ compensateResponse: fail('补偿失败', 500) });
    const plan: any = {
      ok: true,
      generatedAt: 'x',
      items: [{ transactionId: 't1', depth: 0 }, { transactionId: 't2', depth: 0 }],
      skipped: [],
      warnings: [],
    };
    const res = await executeCompensation(client, plan, { apply: true });
    assert.equal(res.report!.failed, 1);
    assert.equal(res.report!.stopped, true);
    assert.equal(res.report!.items[0].error, '补偿失败');
  });
});

test('etl-compensate：executeCompensation 空计划不执行', async () => {
  await withEnv({ RC_ENABLE_ETL_WRITE: '1' }, async () => {
    const { client, calls } = makeClient({});
    const plan: any = { ok: false, generatedAt: 'x', items: [], skipped: [], warnings: [] };
    const res = await executeCompensation(client, plan, { apply: true });
    assert.equal(res.dryRun, false);
    assert.equal(res.report, undefined);
    assert.equal(calls.length, 0);
  });
});

test('etl-compensate：listEtlInstances / listCompensations 支持扁平响应', async () => {
  const { client } = stub((path: string) => {
    if (path.includes('/monitor/list/page')) return ok({ rows: [{ transactionId: 't1' }] });
    if (path.includes('/compensate/list')) return ok({ records: [{ id: 'c1' }] });
    return ok({});
  });
  const instances = await listEtlInstances(client);
  assert.equal(instances.length, 1);
  const comps = await listCompensations(client);
  assert.equal(comps.length, 1);
});

test('etl-compensate：formatCompensationPlan 输出可读计划', () => {
  const plan: any = {
    ok: true,
    generatedAt: '2026-01-01T00:00:00.000Z',
    items: [
      { transactionId: 't1', processName: '流程A', depth: 1, state: 'FAIL', errorMsg: '字段缺失' },
      { transactionId: 't3', depth: 0 },
    ],
    skipped: [
      { transactionId: 't2', reason: '状态为 SUCCESS，无需补偿' },
      { transactionId: '', reason: '记录缺少 transactionId' },
    ],
    warnings: ['注意'],
  };
  const text = formatCompensationPlan(plan);
  assert.ok(text.includes('补偿计划：2 个实例'));
  assert.ok(text.includes('t1'));
  assert.ok(text.includes('流程A'));
  assert.ok(text.includes('depth=1'));
  assert.ok(text.includes('字段缺失'));
  assert.ok(text.includes('跳过 t2'));
  assert.ok(text.includes('跳过 (空)'));
  assert.ok(text.includes('! 注意'));
});
