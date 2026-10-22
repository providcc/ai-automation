/**
 * flow-lifecycle 补充单测：覆盖生命周期、节点属性、快照/回滚、完整保存、导出等分支。
 * 约定：不触网，用桩客户端替换 RestCloudClient；不修改任何源文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as FLOW from '../../packages/core/src/flow-lifecycle.ts';
import { stub, ok, fail, tmpDir, withEnv, captureLog } from './helpers.ts';

type Call = { path: string; opts: any };

/** 按路径关键字路由（先匹配到的先生效），值可以是返回对象或 (opts, calls) => 结果 */
function route(table: Record<string, any>, fallback: any = ok()) {
  return (path: string, opts: any, calls: Call[]) => {
    for (const [k, v] of Object.entries(table)) {
      if (path.includes(k)) return typeof v === 'function' ? v(opts, calls) : v;
    }
    return fallback;
  };
}

/** 在 mock 时钟下推进定时器，避免真实等待（轮询 / 重试退避） */


const MODEL = {
  nodeDataArray: [
    { key: 'E00001', nodeType: 'start' },
    { key: 'T00001', nodeType: 'apiNode' },
    { key: 'E00002', nodeType: 'end' },
  ],
  linkDataArray: [
    { from: 'E00001', to: 'T00001', routerId: 'R00001', assertCondition: '1', routerCondition: 'x==1' },
    { from: 'T00001', to: 'E00002', routerId: 'R00002', assertCondition: '0' },
  ],
};

const PROP_ROWS = [
  { id: 'r0', pNodeId: 'E00001', pNodeType: 'start', pNodeName: '开始' },
  { id: 'r1', pNodeId: 'T00001', pNodeType: 'apiNode', pNodeName: '旧名', apiUrl: 'https://old.test' },
  { id: 'r2', pNodeId: 'E00002', pNodeType: 'end', pNodeName: '结束' },
  { id: 'r3', pNodeId: 'R00001', pNodeType: 'router' },
  { id: 'r4', pNodeId: 'R00002', pNodeType: 'router' },
];

/** 详情 + 属性 + 节点列表的标准桩 */
function baseRoutes(extra: Record<string, any> = {}) {
  return route({
    '/node/props/list': ok({ rows: PROP_ROWS }),
    '/node/props': ok({ id: 'r1', pNodeId: 'T00001', pNodeType: 'apiNode' }),
    '/node/select': (opts: any) => (opts.query?.nodeType === 'router'
      ? ok([])
      : ok([{ nodeId: 'T00001', nodeName: '接口' }])),
    '/node/delete': ok({ state: true }),
    '/node/save': ok({ state: true }),
    '/node/batch/save': ok({ state: true }),
    '/model/save': ok({ state: true }),
    '/model/checkerror': ok({ state: true, msg: '未发现错误' }),
    ...extra,
  });
}

// ---------------- 列表解包 / 过滤 ----------------

test('列表解包：裸数组 / rows / data / data.rows / records / 非对象', () => {
  assert.deepEqual(FLOW.unwrapFlowRows([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(FLOW.unwrapFlowRows({ rows: [{ id: 2 }] }), [{ id: 2 }]);
  assert.deepEqual(FLOW.unwrapFlowRows({ data: [{ id: 3 }] }), [{ id: 3 }]);
  assert.deepEqual(FLOW.unwrapFlowRows({ data: { rows: [{ id: 4 }] } }), [{ id: 4 }]);
  assert.deepEqual(FLOW.unwrapFlowRows({ records: [{ id: 5 }] }), [{ id: 5 }]);
  assert.deepEqual(FLOW.unwrapFlowRows(null), []);
  assert.deepEqual(FLOW.unwrapFlowRows('x'), []);
  assert.deepEqual(FLOW.unwrapFlowRows({ other: 1 }), []);
});

test('listFlows 非全量：只请求一次并带上分页参数', async () => {
  const { client, calls } = stub(() => ok({ rows: [{ processId: 'p1' }] }));
  const r = await FLOW.listFlows(client, { keyword: 'k', appId: 'a', pageNo: 2, pageSize: 20 });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/rest/esb/process/list');
  assert.equal(calls[0].opts.method, 'GET');
  assert.equal(calls[0].opts.query.pageNo, 2);
  assert.equal(calls[0].opts.query.pageSize, 20);
  assert.equal(calls[0].opts.query.keyword, 'k');
  assert.equal(calls[0].opts.query.appId, 'a');
});

test('listFlows 非全量：缺省页码为 1 且不带 pageSize', async () => {
  const { client, calls } = stub(() => ok({ rows: [] }));
  await FLOW.listFlows(client, {});
  assert.equal(calls[0].opts.query.pageNo, 1);
  assert.equal(calls[0].opts.query.pageSize, undefined);
});

test('listFlows 全量：第一页失败直接返回错误', async () => {
  const { client, calls } = stub(() => fail('平台异常', 500));
  const r = await FLOW.listFlows(client, { all: true });
  assert.equal(r.ok, false);
  assert.equal(r.msg, '平台异常');
  assert.equal(calls.length, 1);
});

test('listFlows 全量：客户端过滤命中 limit 条后提前停止翻页', async () => {
  const { client, calls } = stub((_path, opts) => {
    if (opts.query.pageNo === 1) {
      return ok({ total: 100, rows: [{ processId: 'p1', configName: '订单' }, { processId: 'p2', configName: '库存' }] });
    }
    return ok({ total: 100, rows: [{ processId: 'p3', configName: '流程C' }] });
  });
  const r: any = await FLOW.listFlows(client, { all: true, pageSize: 2, filter: { keyword: '订单' }, limit: 1 });
  assert.equal(calls.length, 1, '命中 limit 后不应继续翻页');
  assert.equal(r.data.truncated, true);
  assert.equal(r.data.matched, 1);
  assert.equal(r.data.total, 2);
});

test('listFlows 全量：无过滤条件时 matched 等于总数', async () => {
  const { client } = stub((_path, opts) => {
    if (opts.query.pageNo === 1) return ok({ rows: [{ processId: 'p1' }] });
    return ok({ rows: [] });
  });
  const r: any = await FLOW.listFlows(client, { all: true, pageSize: 5 });
  assert.equal(r.data.matched, 1);
  assert.equal(r.data.truncated, false);
});

test('listFlows 全量：processId / id / configId 都作为去重键', async () => {
  const { client } = stub((_path, opts) => {
    if (opts.query.pageNo === 1) {
      return ok({ rows: [{ processId: 'p1' }, { id: 'p2' }, { configId: 'p3' }, { nothing: true }] });
    }
    return ok({ rows: [{ processId: 'p1' }, { id: 'p2' }, { configId: 'p3' }] });
  });
  const r: any = await FLOW.listFlows(client, { all: true, pageSize: 4 });
  const rows = r.data.rows;
  assert.equal(rows.length, 4, '重复行应被去重，无主键行保留');
  assert.deepEqual(rows.map((x: any) => x.processId ?? x.id ?? x.configId ?? ''), ['p1', 'p2', 'p3', '']);
});

test('listFlows 全量：平台忽略 pageSize 时按页码上限兜底（最多 100 页）', async () => {
  let pages = 0;
  const { client } = stub(() => {
    pages++;
    const rows = Array.from({ length: 100 }, (_x, i) => ({ processId: `p${i}` }));
    return ok({ rows }); // 没有 total → 只有页大小不足才算最后一页
  });
  const r: any = await FLOW.listFlows(client, { all: true });
  assert.equal(pages, 100);
  assert.equal(r.data.rows.length, 100);
});

test('列表过滤：业务应用(applicationId) 与平台模块(appId) 分开匹配', () => {
  const rows = [
    { processId: 'p1', applicationId: 'APP', appId: 'esb' },
    { processId: 'p2', applicationId: 'other', appId: 'esb' },
    { processId: 'p3', applicationId: 'APP', appId: 'etl' },
    { processId: 'p4', applicationId: 'other', appId: 'etl' },
  ];
  // --app 只认业务应用（applicationId），不再回落到平台模块（appId）
  assert.deepEqual(FLOW.filterFlows(rows, { appId: 'app' }).map((x) => x.processId), ['p1', 'p3']);
  assert.deepEqual(FLOW.filterFlows(rows, { appId: 'other' }).map((x) => x.processId), ['p2', 'p4']);
  // --module 按平台模块匹配
  assert.deepEqual(FLOW.filterFlows(rows, { module: 'esb' }).map((x) => x.processId), ['p1', 'p2']);
  assert.deepEqual(FLOW.filterFlows(rows, { module: 'etl' }).map((x) => x.processId), ['p3', 'p4']);
  assert.deepEqual(FLOW.filterFlows(rows, {}).length, 4);
  assert.deepEqual(FLOW.filterFlows(rows, { keyword: '  ' }).length, 4);
});

test('流程行归一：字段名固定（processName 是 configName 的别名，两个应用字段不混）', () => {
  const row = FLOW.normalizeFlowRow({
    processId: 'p1', configId: 'C1', configName: '流程A', applicationId: 'app-a', appId: 'esb', state: '2',
  });
  assert.equal(row.processId, 'p1');
  assert.equal(row.configName, '流程A');
  assert.equal(row.processName, '流程A');
  assert.equal(row.applicationId, 'app-a');
  assert.equal(row.appId, 'esb');
  assert.equal(row.state, '2');
});

test('列表过滤：关键词匹配编码 / 名称 / 分类', () => {
  const rows = [
    { processId: 'p1', configId: 'ESB_FLOW_1', configName: '订单' },
    { processId: 'p2', processName: '库存', categoryId: 'cat-1' },
    { processId: 'p3', configName: '无关' },
  ];
  assert.deepEqual(FLOW.filterFlows(rows, { keyword: 'esb_flow' }).map((x) => x.processId), ['p1']);
  assert.deepEqual(FLOW.filterFlows(rows, { keyword: '库存' }).map((x) => x.processId), ['p2']);
  assert.deepEqual(FLOW.filterFlows(rows, { keyword: 'cat-1' }).map((x) => x.processId), ['p2']);
});

// ---------------- 新建 / 复制 / 发布 / 版本 ----------------

test('createFlow 成功：响应带 processId 直接返回，body 字段完整', async () => {
  const { client, calls } = stub(() => ok({ state: true, processId: 'p1' }));
  const r = await FLOW.createFlow(client, { applicationId: 'app-1', processName: '订单流程' }, { kind: 'esb' });
  assert.equal(r.ok, true);
  assert.equal(r.processId, 'p1');
  assert.match(r.configId, /^ESB_FLOW_\d{9}$/);
  const body = calls[0].opts.body;
  assert.equal(calls[0].path, '/rest/esb/process/save');
  assert.equal(body.applicationId, 'app-1');
  assert.equal(body.appId, 'esb');
  assert.equal(body.categoryId, 'all');
  assert.equal(body.configName, '订单流程');
  assert.equal(body.processName, '订单流程');
  assert.equal(body.state, '2');
  assert.equal(body.transaction, 'true');
  assert.equal(body.eventUrl, 'https://example.test/restcloud');
  assert.equal(body.LogStrategy, undefined);
  assert.equal(body.configId, r.configId);
});

test('createFlow：ETL 走 etl 端点并带 ETL 专属字段', async () => {
  const { client, calls } = stub(() => ok({ state: true, id: 'm1' }));
  const r = await FLOW.createFlow(client, { applicationId: 'app-1', processName: 'ETL 流程', categoryId: 'cat' }, { kind: 'etl' });
  assert.equal(calls[0].path, '/rest/etl/process/save');
  const body = calls[0].opts.body;
  assert.equal(body.appId, 'etl');
  assert.equal(body.categoryId, 'cat');
  assert.equal(body.transaction, false);
  assert.equal(body.LogStrategy, '1');
  assert.equal(body.transactionIsolation, 100);
  assert.equal(body.compensateFlag, '1');
  assert.equal(r.processId, 'm1', 'id 也作为 processId 兜底');
});

test('createFlow：编码冲突时自动换编码重试', async () => {
  const seen: string[] = [];
  let n = 0;
  const { client, calls } = stub((_p, opts) => {
    seen.push(String(opts.body.configId));
    n++;
    if (n === 1) return fail('流程编码已存在', 500);
    return ok({ state: true, processId: 'p9' });
  });
  const r = await FLOW.createFlow(client, { applicationId: 'app-1', processName: 'X' });
  assert.equal(calls.length, 2);
  assert.equal(seen.length, 2);
  assert.match(seen[1], /^ESB_FLOW_\d{9}$/);
  assert.equal(r.ok, true);
  assert.equal(r.processId, 'p9');
});

test('createFlow：编码冲突最多重试 3 次后放弃', async () => {
  const { client, calls } = stub(() => fail('编码已存在', 500));
  const r = await FLOW.createFlow(client, { applicationId: 'app-1', processName: 'X' });
  assert.equal(calls.length, 4, '首次 + 3 次重试');
  assert.equal(r.ok, false);
  assert.match(r.msg ?? '', /编码已存在/);
});

test('createFlow：显式 configId 时编码冲突不重试', async () => {
  const { client, calls } = stub(() => fail('编码已存在', 500));
  const r = await FLOW.createFlow(client, { applicationId: 'app-1', processName: 'X', configId: 'MY_FIXED_ID' });
  assert.equal(calls.length, 1);
  assert.equal(r.configId, 'MY_FIXED_ID');
  assert.equal(r.ok, false);
});

test('createFlow：响应不带 processId 时按名称回查列表', async () => {
  const { client, calls } = stub((path) => {
    if (path.endsWith('/process/list')) return ok({ rows: [{ processId: 'p-l', configId: 'OTHER', configName: '订单流程' }] });
    return ok({ state: true });
  });
  const r = await FLOW.createFlow(client, { applicationId: 'app-1', processName: '订单流程' });
  assert.equal(r.processId, 'p-l');
  const listCall = calls.find((c) => c.path.endsWith('/process/list'))!;
  assert.equal(listCall.opts.query.keyword, '订单流程');
  assert.equal(listCall.opts.query.pageSize, 100);
});

test('createFlow：回查列表时按 configId 命中也能拿到 processId', async () => {
  const { client } = stub((path, _o, calls) => {
    if (path.endsWith('/process/list')) {
      const cfg = calls.find((c) => c.path.endsWith('/process/save'))!.opts.body.configId;
      return ok({ rows: [{ processId: 'p-cfg', configId: cfg }] });
    }
    return ok({ state: true });
  });
  const r = await FLOW.createFlow(client, { applicationId: 'app-1', processName: 'X' });
  assert.equal(r.processId, 'p-cfg');
});

test('createFlow：dry-run 只构造请求', async () => {
  const { client, calls } = stub(() => ok({ state: true, processId: 'p1' }));
  await FLOW.createFlow(client, { applicationId: 'a', processName: 'X' }, { dryRun: true });
  assert.equal(calls[0].opts.dryRun, true);
});

test('defaultConfigId：前缀与日期格式', () => {
  const d = new Date(2026, 0, 5);
  assert.match(FLOW.defaultConfigId(d, 'esb'), /^ESB_FLOW_260105\d{3}$/);
  assert.match(FLOW.defaultConfigId(d, 'etl'), /^ETL_FLOW_260105\d{3}$/);
});

test('cloneFlow：复制成功返回新 processId 并透传参数', async () => {
  const { client, calls } = stub(() => ok({ state: true, processId: 'p-new' }));
  const r = await FLOW.cloneFlow(client, { processId: 'p1', processName: '副本', applicationId: 'app' });
  assert.equal(r.ok, true);
  assert.equal(r.processId, 'p-new');
  assert.equal(calls[0].path, '/rest/esb/process/copy');
  assert.deepEqual(calls[0].opts.body, { processId: 'p1', processName: '副本', applicationId: 'app' });
});

test('cloneFlow：ETL 端点 + configId 兜底 + 失败信息', async () => {
  const { client, calls } = stub(() => ok({ state: true, configId: 'CFG_1' }));
  const r = await FLOW.cloneFlow(client, { processId: 'p1' }, { kind: 'etl' });
  assert.equal(calls[0].path, '/rest/etl/process/copy');
  assert.equal(r.processId, 'CFG_1');
});

test('publishFlow：默认 dry-run，ETL 走 etl 端点', async () => {
  const { client, calls } = stub(() => ok({ state: true }));
  await FLOW.publishFlow(client, 'p1');
  assert.equal(calls[0].path, '/rest/esb/process/publish');
  assert.equal(calls[0].opts.dryRun, true);
  assert.deepEqual(calls[0].opts.body, { processId: 'p1' });
  await FLOW.publishFlow(client, 'p1', { kind: 'etl', dryRun: false });
  assert.equal(calls[1].path, '/rest/etl/process/publish');
  assert.equal(calls[1].opts.dryRun, false);
});

test('listVersions：查询 ESB 历史版本', async () => {
  const { client, calls } = stub(() => ok({ rows: [{ id: 'v1' }] }));
  const r = await FLOW.listVersions(client, 'p1');
  assert.equal(r.ok, true);
  assert.equal(calls[0].path, '/rest/esb/process/version/list');
  assert.deepEqual(calls[0].opts.query, { processId: 'p1' });
});

test('restoreVersion：dry-run 不快照直接预览恢复请求', async () => {
  const { client, calls } = stub(() => ok({ state: true }));
  const r = await FLOW.restoreVersion(client, 'p1', 'v1');
  assert.equal(r.ok, true);
  assert.equal(r.snapshotFile, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/rest/esb/process/version/restore');
  assert.deepEqual(calls[0].opts.body, { id: 'v1' });
  assert.equal(calls[0].opts.dryRun, true);
});

test('restoreVersion：真实恢复前先快照当前流程', async () => {
  const home = tmpDir('rc-snap-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client, calls } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
    }));
    const r = await FLOW.restoreVersion(client, 'p1', 'v1', { dryRun: false });
    assert.equal(r.ok, true);
    assert.ok(r.snapshotFile, '应返回快照文件');
    assert.ok(readdirSync(home.dir).some((f) => f.startsWith('flow-esb-p1-')));
    const restore = calls.find((c) => c.path.endsWith('/version/restore'))!;
    assert.equal(restore.opts.dryRun, false);
    assert.deepEqual(restore.opts.body, { id: 'v1' });
    home.cleanup();
  });
});

// ---------------- 平台校验 ----------------

test('checkFlow：state=false 视为失败并透传错误节点列表', async () => {
  const { client, calls } = stub(() => ok({ state: false, msg: '网关没有成对', errorNodeList: [{ id: 'G1', msg: '缺少聚合网关' }] }));
  const chk = await FLOW.checkFlow(client, { processId: 'p1', processModel: '{}' });
  assert.equal(chk.ok, false);
  assert.equal(chk.msg, '网关没有成对');
  assert.equal(chk.errorNodeList?.length, 1);
  assert.equal(calls[0].path, '/rest/esb/process/model/checkerror');
  assert.deepEqual(calls[0].opts.body, { appId: 'esb', processId: 'p1', processModel: '{}' });
});

test('checkFlow：请求失败时用响应 msg，缺省为空串', async () => {
  const { client } = stub(() => fail('平台校验异常', 500));
  const chk = await FLOW.checkFlow(client, { processId: 'p1', processModel: '{}' });
  assert.equal(chk.ok, false);
  assert.equal(chk.msg, '平台校验异常');

  const { client: c2 } = stub(() => ({ ok: false, httpStatus: 500, data: {}, request: { method: 'POST', url: '/x' } } as any));
  const chk2 = await FLOW.checkFlow(c2, { processId: 'p1', processModel: '{}' });
  assert.equal(chk2.msg, '');
});

// ---------------- 节点属性读取 ----------------

test('getNodeProps：多种返回形态都能解包出属性记录', async () => {
  const cases: any[] = [
    { pNodeId: 'T1', pNodeType: 'apiNode' },
    { rows: [{ pNodeId: 'T1', pNodeType: 'apiNode' }] },
    { data: [{ pNodeId: 'T1', pNodeType: 'apiNode' }] },
    { data: { rows: [{ pNodeId: 'T1', pNodeType: 'apiNode' }] } },
    { T1: { pNodeType: 'apiNode', apiUrl: 'u' } },
  ];
  for (const payload of cases) {
    const { client, calls } = stub(() => ok(payload));
    const rec = await FLOW.getNodeProps(client, 'p1', 'T1');
    assert.equal(rec.pNodeId, 'T1');
    assert.equal(calls[0].path, '/rest/esb/process/node/props');
    assert.deepEqual(calls[0].opts.query, { processId: 'p1', nodeId: 'T1' });
  }
});

test('getNodeProps：非对象返回空记录', async () => {
  const { client } = stub(() => ok('not-an-object'));
  const rec = await FLOW.getNodeProps(client, 'p1', 'T1');
  assert.deepEqual(rec, {});
});

test('getNodePropsBatch：ESB 走批量端点并按请求顺序输出', async () => {
  const { client, calls } = stub(() => ok({ rows: [
    { id: 'r2', pNodeId: 'T2' },
    { id: 'r1', pNodeId: 'T1' },
    { id: 'rx', pNodeId: 'OTHER' },
  ] }));
  const recs = await FLOW.getNodePropsBatch(client, 'p1', ['T1', 'T2']);
  assert.deepEqual(recs.map((r) => r.pNodeId), ['T1', 'T2']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/rest/esb/process/node/props/list');
  assert.equal(calls[0].opts.query.nodeIds, 'T1,T2');
});

test('getNodePropsBatch：空节点列表直接返回空数组', async () => {
  const { client, calls } = stub(() => ok({}));
  assert.deepEqual(await FLOW.getNodePropsBatch(client, 'p1', []), []);
  assert.deepEqual(await FLOW.getNodePropsBatch(client, 'p1', ['', '']), []);
  assert.equal(calls.length, 0);
});

test('getNodePropsBatch：批量端点失败时降级为逐节点读取', async () => {
  const { client, calls } = stub((path) => {
    if (path.endsWith('/node/props/list')) return fail('批量不支持', 500);
    return ok({ id: 'r1', pNodeId: opts_nodeId(calls), pNodeType: 'apiNode' });
  });
  const recs = await FLOW.getNodePropsBatch(client, 'p1', ['T1', 'T2']);
  assert.equal(calls.filter((c) => c.path.endsWith('/node/props')).length, 2);
  assert.equal(recs.length, 2);
});

function opts_nodeId(calls: Call[]): string {
  return String(calls[calls.length - 1].opts.query?.nodeId ?? '');
}

test('getNodePropsBatch：ETL 无批量端点时逐节点降级', async () => {
  const { client, calls } = stub((path) => {
    if (path.endsWith('/node/props')) return ok({ id: 'r1', pNodeId: 'T1', pNodeType: 'apiNode' });
    return ok({});
  });
  const recs = await FLOW.getNodePropsBatch(client, 'p1', ['T1'], { kind: 'etl' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/rest/etl/process/node/props');
  assert.equal(recs.length, 1);
});

test('listFlowNodes：兼容 nodeId / id / pNodeId 字段并过滤空 key', async () => {
  const { client, calls } = stub(() => ok([
    { nodeId: 'T1', nodeName: '甲' },
    { id: 'T2' },
    { pNodeId: 'T3', pNodeName: '丙' },
    { nodeName: '没有 key' },
  ]));
  const nodes = await FLOW.listFlowNodes(client, 'p1');
  assert.deepEqual(nodes.map((n) => n.nodeId), ['T1', 'T2', 'T3']);
  assert.equal(nodes[0].nodeName, '甲');
  assert.equal(nodes[1].nodeName, undefined);
  assert.equal(nodes[2].nodeName, '丙');
  assert.equal(calls[0].path, '/rest/esb/process/node/select');
  assert.deepEqual(calls[0].opts.query, { processId: 'p1', nodeType: undefined });
});

test('listFlowNodes：按 nodeType 查询 router', async () => {
  const { client, calls } = stub(() => ok([{ nodeId: 'R1' }]));
  await FLOW.listFlowNodes(client, 'p1', 'router');
  assert.equal(calls[0].opts.query.nodeType, 'router');
});

// ---------------- 属性归一化 ----------------

test('normalizeNodeProps：非法项与缺 nodeId 的项被跳过', () => {
  assert.equal(FLOW.normalizeNodeProps(undefined), undefined);
  assert.equal(FLOW.normalizeNodeProps(null), undefined);
  const out = FLOW.normalizeNodeProps([
    null,
    'x',
    [],
    { nodeType: 'apiNode' },
    { nodeId: 'T1', nodeType: 'apiNode', props: { a: 1 } },
    { nodeId: 'T1', nodeType: 'apiNode', props: { b: 2 } },
  ])!;
  assert.equal(out.length, 1, '重复 nodeId 以最后一次为准');
  assert.deepEqual(out[0].props, { b: 2 });
  assert.equal(out[0].nodeType, 'apiNode');
});

test('normalizeNodeProps：对象映射形态支持 props / id / 缺省 nodeType', () => {
  const out = FLOW.normalizeNodeProps({
    T1: { pNodeType: 'apiNode', pNodeName: '甲', id: 'r1', apiUrl: 'u' },
    T2: { nodeType: 'apiNode', props: { apiUrl: 'v' } },
    T3: { pNodeType: 'apiNode' },
    BAD: 'not-object',
  })!;
  assert.deepEqual(out.map((x) => x.nodeId), ['T1', 'T2', 'T3']);
  assert.equal(out[0].id, 'r1');
  assert.equal(out[0].nodeName, '甲');
  assert.equal((out[0].props as any).apiUrl, 'u');
  assert.deepEqual(out[1].props, { apiUrl: 'v' });
  assert.equal(out[2].nodeType, 'apiNode');
  assert.equal(out[2].nodeName, undefined);
});

test('normalizeNodeProps：组合文件形态只取 props 部分', () => {
  const out = FLOW.normalizeNodeProps({ model: MODEL, props: [{ nodeId: 'T1', nodeType: 'apiNode' }] })!;
  assert.deepEqual(out.map((x) => x.nodeId), ['T1']);
});

test('nodePropsMap：空输入返回 undefined，含节点名时补 pNodeName', () => {
  assert.equal(FLOW.nodePropsMap(undefined), undefined);
  assert.equal(FLOW.nodePropsMap([]), undefined);
  const map = FLOW.nodePropsMap([
    { nodeId: 'T1', nodeType: 'apiNode', nodeName: '甲', props: { apiUrl: 'u' } },
    { nodeId: 'T2', nodeType: 'apiNode', props: {} },
  ])!;
  assert.equal(map.T1.pNodeId, 'T1');
  assert.equal(map.T1.pNodeType, 'apiNode');
  assert.equal(map.T1.pNodeName, '甲');
  assert.equal(map.T1.apiUrl, 'u');
  assert.equal(map.T2.pNodeName, undefined);
});

// ---------------- 属性写入 ----------------

test('upsertNodeProps：空节点集合直接返回空报告', async () => {
  const { client, calls } = stub(() => ok({}));
  const rep = await FLOW.upsertNodeProps(client, { appId: 'esb', processId: 'p1', nodes: [] });
  assert.deepEqual(rep, { inserted: [], updated: [], failed: [], deduped: [] });
  assert.equal(calls.length, 0);
});

test('upsertNodeProps：批量写入区分新增与更新', async () => {
  const { client, calls } = stub((path) => {
    if (path.endsWith('/node/props/list')) return ok({ rows: [{ id: 'r1', pNodeId: 'T1' }] });
    if (path.endsWith('/node/batch/save')) return ok({ state: true });
    return ok({});
  });
  const rep = await FLOW.upsertNodeProps(client, {
    appId: 'esb', processId: 'p1',
    nodes: [
      { nodeId: 'T1', nodeType: 'apiNode', props: { apiUrl: 'u' } },
      { nodeId: 'T2', nodeType: 'apiNode', props: { apiUrl: 'v' } },
      { nodeId: 'T3', nodeType: 'apiNode', props: { apiUrl: 'w' } },
    ],
  });
  assert.deepEqual(rep.inserted, ['T2', 'T3']);
  assert.deepEqual(rep.updated, ['T1']);
  assert.deepEqual(rep.failed, []);
  const batch = calls.find((c) => c.path.endsWith('/node/batch/save'))!;
  assert.equal(batch.opts.body[0].id, 'r1', '已有属性带上记录 id 走更新');
  assert.equal(batch.opts.body[1].id, undefined);
  assert.equal(batch.opts.body[0].pNodeName, 'T1', '缺节点名时用 nodeId 兜底');
});

test('upsertNodeProps：属性值按平台规则字符串化', async () => {
  const { client, calls } = stub((path) => {
    if (path.endsWith('/node/save')) return ok({ state: true });
    return ok({});
  });
  await FLOW.upsertNodeProps(client, {
    appId: 'esb', processId: 'p1',
    nodes: [{
      nodeId: 'T1', nodeType: 'apiNode',
      props: {
        flagOn: true, flagOff: false, list: ['a', 'b'],
        objects: [{ a: 1 }], nested: { x: 1 }, num: 3, nil: null, undef: undefined,
      },
    }],
  }, { useBatch: false });
  const save = calls.find((c) => c.path.endsWith('/node/save'))!;
  const body = save.opts.body;
  assert.equal(body.flagOn, '1');
  assert.equal(body.flagOff, '0');
  assert.equal(body.list, 'a,b');
  assert.equal(body.objects, '{"a":1}');
  assert.equal(body.nested, '{"x":1}');
  assert.equal(body.num, 3);
  assert.equal('nil' in body, false);
  assert.equal('undef' in body, false);
});

test('upsertNodeProps：批量接口失败时降级逐节点并记录失败原因', async () => {
  const { client, calls } = stub((path, opts) => {
    if (path.endsWith('/node/props/list')) return ok({ rows: [{ id: 'r1', pNodeId: 'T1' }] });
    if (path.endsWith('/node/batch/save')) return fail('批量保存失败', 500);
    if (path.endsWith('/node/props')) {
      const nodeId = String(opts.query?.nodeId ?? '');
      return ok({ id: `rid-${nodeId}`, pNodeId: nodeId });
    }
    if (path.endsWith('/node/save')) {
      const nodeId = String((calls[calls.length - 1].opts as any).body?.pNodeId ?? '');
      if (nodeId === 'T3') return fail('节点写入失败', 500);
      return ok({ state: true });
    }
    return ok({});
  });
  const rep = await FLOW.upsertNodeProps(client, {
    appId: 'esb', processId: 'p1',
    nodes: ['T1', 'T2', 'T3'].map((nodeId) => ({ nodeId, nodeType: 'apiNode', props: { x: 1 } })),
  });
  assert.deepEqual(rep.updated, ['T1', 'T2']);
  assert.deepEqual(rep.inserted, []);
  assert.equal(rep.failed.length, 1);
  assert.equal(rep.failed[0].nodeId, 'T3');
  assert.match(rep.failed[0].msg ?? '', /节点写入失败/);
  assert.ok(calls.some((c) => c.path.endsWith('/node/save')));
});

test('upsertNodeProps：批量读取异常时忽略既有属性继续保存', async () => {
  const { client, calls } = stub((path) => {
    if (path.endsWith('/node/props/list')) throw new Error('网络异常');
    if (path.endsWith('/node/batch/save')) return ok({ state: true });
    return ok({});
  });
  const rep = await FLOW.upsertNodeProps(client, {
    appId: 'esb', processId: 'p1',
    nodes: ['T1', 'T2', 'T3'].map((nodeId) => ({ nodeId, nodeType: 'apiNode', props: { x: 1 } })),
  });
  assert.deepEqual(rep.inserted, ['T1', 'T2', 'T3']);
  assert.ok(calls.some((c) => c.path.endsWith('/node/batch/save')));
});

test('upsertNodeProps：清理历史重复记录，删除失败记入 failed', async () => {
  const { client, calls } = stub((path) => {
    if (path.endsWith('/node/props/list')) {
      return ok({ rows: [
        { id: 'r1', pNodeId: 'T1' },
        { id: 'r2', pNodeId: 'T1' },
        { id: 'r3', pNodeId: 'T2' },
      ] });
    }
    if (path.endsWith('/node/batch/save')) return ok({ state: true });
    if (path.endsWith('/node/delete')) return fail('删除失败', 500);
    return ok({});
  });
  const rep = await FLOW.upsertNodeProps(client, {
    appId: 'esb', processId: 'p1',
    nodes: ['T1', 'T2', 'T3'].map((nodeId) => ({ nodeId, nodeType: 'apiNode', props: { x: 1 } })),
  });
  assert.deepEqual(rep.deduped, []);
  assert.equal(rep.failed.length, 1);
  assert.match(rep.failed[0].msg ?? '', /清理重复属性 r1 失败/);
  const del = calls.find((c) => c.path.endsWith('/node/delete'))!;
  assert.equal((del.opts.body as any).ids, 'r1');
});

test('upsertNodeProps：单节点路径也会清理同节点的历史重复记录', async () => {
  const { client, calls } = stub((path) => {
    if (path.endsWith('/node/props')) {
      return ok({ rows: [
        { id: 'r1', pNodeId: 'T1' },
        { id: 'r2', pNodeId: 'T1' },
      ] });
    }
    if (path.endsWith('/node/save')) return ok({ state: true });
    if (path.endsWith('/node/delete')) return ok({ state: true });
    return ok({});
  });
  const rep = await FLOW.upsertNodeProps(client, {
    appId: 'esb', processId: 'p1',
    nodes: [{ nodeId: 'T1', nodeType: 'apiNode', props: { x: 1 } }],
  }, { useBatch: false });
  assert.deepEqual(rep.updated, ['T1']);
  assert.deepEqual(rep.deduped, ['T1']);
  const del = calls.find((c) => c.path.endsWith('/node/delete'))!;
  assert.equal((del.opts.body as any).ids, 'r2');
});

test('upsertNodeProps：逐节点模式遇到失败立即停止', async () => {
  const { client, calls } = stub((path) => {
    if (path.endsWith('/node/save')) return fail('写入失败', 500);
    return ok({});
  });
  const rep = await FLOW.upsertNodeProps(client, {
    appId: 'esb', processId: 'p1',
    nodes: ['T1', 'T2', 'T3'].map((nodeId) => ({ nodeId, nodeType: 'apiNode', props: { x: 1 } })),
  }, { useBatch: false });
  assert.equal(rep.failed.length, 1);
  assert.equal(rep.failed[0].nodeId, 'T1');
  assert.equal(calls.filter((c) => c.path.endsWith('/node/save')).length, 1, '失败即停，不再继续写后面的节点');
});

test('upsertNodeProps：ETL 不使用批量端点', async () => {
  const { client, calls } = stub((path, opts) => {
    if (path.endsWith('/node/props')) {
      const nodeId = String(opts.query?.nodeId ?? '');
      return ok({ id: `rid-${nodeId}`, pNodeId: nodeId });
    }
    if (path.endsWith('/node/save')) return ok({ state: true });
    return ok({});
  });
  const rep = await FLOW.upsertNodeProps(client, {
    appId: 'etl', processId: 'p1', kind: 'etl',
    nodes: ['T1', 'T2', 'T3'].map((nodeId) => ({ nodeId, nodeType: 'apiNode', props: { x: 1 } })),
  });
  assert.equal(calls.some((c) => c.path.endsWith('/node/batch/save')), false);
  assert.deepEqual(rep.updated, ['T1', 'T2', 'T3']);
});

// ---------------- 属性删除 / 清理 ----------------

test('deleteNodeProps：带上属性记录 id 再删除', async () => {
  const { client, calls } = stub((path) => {
    if (path.endsWith('/node/props')) return ok({ id: 'r1', pNodeId: 'T1' });
    return ok({ state: true });
  });
  const r = await FLOW.deleteNodeProps(client, { processId: 'p1', nodeId: 'T1' });
  assert.equal(r.ok, true);
  const del = calls.find((c) => c.path.endsWith('/node/delete'))!;
  assert.deepEqual(del.opts.body, {
    processId: 'p1', nodeId: 'T1', pNodeId: 'T1', appId: 'esb', id: 'r1', ids: 'r1',
  });
  assert.equal(del.opts.dryRun, false);
});

test('deleteNodeProps：读不到 id 时只带 nodeId，ETL 用 etl 模块', async () => {
  const { client, calls } = stub(() => ok({}));
  await FLOW.deleteNodeProps(client, { processId: 'p1', nodeId: 'T1', kind: 'etl' }, { dryRun: true });
  const del = calls.find((c) => c.path.endsWith('/node/delete'))!;
  assert.equal(del.opts.body.id, undefined);
  assert.equal(del.opts.body.appId, 'etl');
  assert.equal(del.opts.dryRun, true);
});

test('pruneNodeProps：删除图上已不存在的历史节点属性', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir }, async () => {
    await FLOW.writeSavedNodeSet('p1', ['T00001', 'T00002']);
    const { client, calls } = stub((path) => {
      if (path.endsWith('/node/select')) {
        return ok([{ nodeId: 'T00001', nodeName: '接口' }]);
      }
      if (path.endsWith('/node/props')) return ok({ id: 'r2', pNodeId: 'T00002' });
      if (path.endsWith('/node/delete')) return ok({ state: true });
      return ok({});
    });
    const out = await FLOW.pruneNodeProps(client, { processId: 'p1', keepNodeIds: ['T00001'] });
    assert.deepEqual(out.removed, ['T00002']);
    assert.deepEqual(out.failed, []);
    const del = calls.find((c) => c.path.endsWith('/node/delete'))!;
    assert.equal((del.opts.body as any).nodeId, 'T00002');
    home.cleanup();
  });
});

test('pruneNodeProps：删除失败时记入 failed', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir }, async () => {
    await FLOW.writeSavedNodeSet('p1', ['T00002']);
    const { client } = stub((path) => {
      if (path.endsWith('/node/select')) return ok([]);
      if (path.endsWith('/node/props')) return ok({});
      if (path.endsWith('/node/delete')) return fail('删除失败', 500);
      return ok({});
    });
    const out = await FLOW.pruneNodeProps(client, { processId: 'p1', keepNodeIds: [] });
    assert.deepEqual(out.removed, []);
    assert.equal(out.failed.length, 1);
    assert.equal(out.failed[0].id, 'T00002');
    home.cleanup();
  });
});

test('pruneNodeProps：ETL 不查询 router，RC_DEBUG_PRUNE 输出诊断信息', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_DEBUG_PRUNE: '1' }, async () => {
    await FLOW.writeSavedNodeSet('p1', ['T00002']);
    const { client, calls } = stub((path) => {
      if (path.endsWith('/node/select')) return ok([]);
      if (path.endsWith('/node/props')) return ok({});
      if (path.endsWith('/node/delete')) return ok({ state: true });
      return ok({});
    });
    const { result, err } = await captureLog(() => FLOW.pruneNodeProps(client, { processId: 'p1', keepNodeIds: [], kind: 'etl' }));
    assert.deepEqual(result.removed, ['T00002']);
    assert.equal(calls.filter((c) => c.path.endsWith('/node/select')).length, 1, 'ETL 只查一次节点列表');
    assert.match(err, /\[prune\] processId=p1/);
    home.cleanup();
  });
});

test('节点集合记录：写入后可读回，非法内容按空处理', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir }, async () => {
    await FLOW.writeSavedNodeSet('p1', ['T1', 'T2']);
    assert.deepEqual(await FLOW.readSavedNodeSet('p1'), ['T1', 'T2']);
    home.write('flow-nodes/p2.json', 'not json');
    assert.deepEqual(await FLOW.readSavedNodeSet('p2'), []);
    home.write('flow-nodes/p3.json', '{"a":1}');
    assert.deepEqual(await FLOW.readSavedNodeSet('p3'), []);
    assert.deepEqual(await FLOW.readSavedNodeSet('missing'), []);
    home.cleanup();
  });
});

// ---------------- 快照 / 回滚 ----------------

test('captureFlowSnapshot：写入快照文件，包含图与属性', async () => {
  const home = tmpDir('rc-snap-');
  const { client } = stub(baseRoutes({
    '/process/p1': ok({ id: 'm1', processId: 'p1', configId: 'C1', processModel: JSON.stringify(MODEL) }),
  }));
  const res = await FLOW.captureFlowSnapshot(client, 'esb', 'p1', { dir: home.dir });
  assert.match(res.file, /flow-esb-p1-/);
  const snap = res.snapshot;
  assert.equal(snap.kind, 'esb');
  assert.equal(snap.processId, 'p1');
  assert.deepEqual(snap.nodes, ['E00001', 'T00001', 'E00002']);
  assert.deepEqual(snap.routers, ['R00001', 'R00002']);
  assert.equal(snap.props.T00001?.id, 'r1');
  assert.ok(snap.capturedAt);
  const saved = JSON.parse(readFileSync(res.file, 'utf8'));
  assert.equal(saved.version, 1);
  home.cleanup();
});

test('captureFlowSnapshot：读不到流程时抛出快照错误', async () => {
  const { client } = stub(() => fail('流程不存在', 404));
  await assert.rejects(() => FLOW.captureFlowSnapshot(client, 'esb', 'p1'), /快照失败/);
});

test('captureFlowSnapshot：详情没有 processModel 时回退到节点列表', async () => {
  const home = tmpDir('rc-snap-');
  const { client } = stub(baseRoutes({
    '/process/p1': ok({ id: 'm1', processId: 'p1' }),
  }));
  const res = await FLOW.captureFlowSnapshot(client, 'esb', 'p1', { dir: home.dir });
  assert.deepEqual(res.snapshot.nodes, ['T00001']);
  assert.deepEqual(res.snapshot.routers, []);
  assert.equal(res.snapshot.model, undefined);
  home.cleanup();
});

test('captureFlowSnapshot：processModel 是非法 JSON 时忽略模型', async () => {
  const home = tmpDir('rc-snap-');
  const { client } = stub(baseRoutes({
    '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: 'not-json' }),
  }));
  const res = await FLOW.captureFlowSnapshot(client, 'esb', 'p1', { dir: home.dir });
  assert.equal(res.snapshot.model, undefined);
  assert.deepEqual(res.snapshot.nodes, ['T00001']);
  home.cleanup();
});

test('captureFlowSnapshot：RC_SNAPSHOT_DIR 决定默认快照目录', async () => {
  const home = tmpDir('rc-snap-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
    }));
    const res = await FLOW.captureFlowSnapshot(client, 'esb', 'p1');
    assert.ok(res.file.startsWith(home.dir));
    home.cleanup();
  });
});

test('restoreFlowSnapshot：恢复图模型、删除属性并写回快照属性', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir }, async () => {
    const { client, calls } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1' }),
    }));
    const snap: any = {
      version: 1, kind: 'esb', processId: 'p1', capturedAt: new Date().toISOString(),
      detail: {}, model: MODEL, nodes: ['T00001'], routers: [],
      props: { T00001: { id: 'r1', pNodeId: 'T00001', pNodeType: 'apiNode', pNodeName: '接口', apiUrl: 'https://x.test' } },
      savedNodeSet: ['T00001'],
    };
    const rep = await FLOW.restoreFlowSnapshot(client, snap);
    assert.equal(rep.ok, true);
    assert.equal(rep.modelSaved, true);
    assert.deepEqual(rep.deleted, ['T00001']);
    assert.deepEqual(rep.restored, ['T00001']);
    assert.match(rep.msg ?? '', /^已回滚到快照/);
    // 回写后回读校验：属性条数与缺失项写进报告
    assert.equal(rep.verified?.expected, 1);
    assert.equal(rep.verified?.props, 1);
    assert.deepEqual(rep.verified?.missing, []);
    const modelSave = calls.find((c) => c.path.endsWith('/model/save'))!;
    assert.equal((modelSave.opts.body as any).appId, 'esb');
    assert.equal((modelSave.opts.body as any).processId, 'p1');
    assert.deepEqual(await FLOW.readSavedNodeSet('p1'), ['T00001']);
    home.cleanup();
  });
});

test('restoreFlowSnapshot：可以从快照文件恢复', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir }, async () => {
    const { client } = stub(baseRoutes({ '/process/p1': ok({ id: 'm1', processId: 'p1' }) }));
    const snap = {
      version: 1, kind: 'esb', processId: 'p1', capturedAt: new Date().toISOString(),
      detail: {}, model: JSON.stringify(MODEL), nodes: ['T00001'], routers: [],
      props: {}, savedNodeSet: [],
    };
    const file = home.write('snap.json', JSON.stringify(snap));
    const rep = await FLOW.restoreFlowSnapshot(client, file);
    assert.equal(rep.ok, true);
    assert.equal(rep.modelSaved, true);
    home.cleanup();
  });
});

test('restoreFlowSnapshot：图模型保存失败时报告失败项', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir }, async () => {
    const { client } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1' }),
      '/model/save': fail('模型保存失败', 500),
    }));
    const snap: any = {
      version: 1, kind: 'esb', processId: 'p1', capturedAt: new Date().toISOString(),
      detail: {}, model: MODEL, nodes: [], routers: [], props: {}, savedNodeSet: [],
    };
    const rep = await FLOW.restoreFlowSnapshot(client, snap);
    assert.equal(rep.ok, false);
    assert.equal(rep.failed.length, 1);
    assert.equal(rep.failed[0].id, '__model__');
    assert.match(rep.msg ?? '', /回滚有 1 项失败/);
    home.cleanup();
  });
});

// ---------------- 完整保存 ----------------

test('saveFlowComplete：图模型不是合法 JSON 时直接报错', async () => {
  const { client, calls } = stub(() => ok({}));
  const rep = await FLOW.saveFlowComplete(client, { processId: 'p1', model: '{not json' });
  assert.equal(rep.ok, false);
  assert.match(rep.msg ?? '', /图模型不是合法 JSON/);
  assert.equal(calls.length, 0);
});

test('saveFlowComplete：快照失败时中止保存', async () => {
  const { client, calls } = stub(() => fail('流程不存在', 404));
  const rep = await FLOW.saveFlowComplete(client, { processId: 'p1', model: MODEL });
  assert.equal(rep.ok, false);
  assert.match(rep.msg ?? '', /保存前快照失败，已中止/);
  assert.equal(calls.some((c) => c.path.endsWith('/model/save')), false);
});

test('saveFlowComplete：完整保存成功并回读校验通过', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client, calls } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', configId: 'C1', processModel: JSON.stringify(MODEL) }),
    }));
    const rep = await FLOW.saveFlowComplete(client, {
      processId: 'p1', model: MODEL,
      nodeProps: { T00001: { nodeType: 'apiNode', props: { apiUrl: 'https://new.test' } } },
    });
    assert.equal(rep.ok, true);
    assert.equal(rep.msg, '保存完成');
    assert.ok(rep.snapshotFile);
    assert.equal(rep.modelSaved, true);
    assert.equal(rep.check?.ok, true);
    assert.equal(rep.verified?.propsOk, true);
    assert.deepEqual(rep.verified?.missing, []);
    assert.ok(calls.some((c) => c.path.endsWith('/model/save')));
    assert.ok(calls.some((c) => c.path.endsWith('/model/checkerror')));
    assert.ok(calls.some((c) => c.path.endsWith('/node/select')), '保存后应清理图外属性');
    assert.deepEqual(await FLOW.readSavedNodeSet('p1'), ['E00001', 'T00001', 'E00002', 'R00001', 'R00002']);
    home.cleanup();
  });
});

test('saveFlowComplete：dry-run 不落库不校验', async () => {
  const { client, calls } = stub(baseRoutes({
    '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
  }));
  const rep = await FLOW.saveFlowComplete(client, { processId: 'p1', model: MODEL, dryRun: true });
  assert.equal(rep.ok, true);
  assert.equal(rep.msg, 'dry-run：未落库');
  assert.equal(rep.snapshotFile, undefined);
  assert.equal(rep.check, undefined);
  assert.equal(rep.verified, undefined);
  assert.equal(calls.some((c) => c.path.endsWith('/model/checkerror')), false);
});

test('saveFlowComplete：平台校验不通过时回滚到快照', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
      '/model/checkerror': ok({ state: false, msg: '网关没有成对' }),
    }));
    const rep = await FLOW.saveFlowComplete(client, { processId: 'p1', model: MODEL });
    assert.equal(rep.ok, false);
    assert.match(rep.msg ?? '', /平台校验未通过：网关没有成对/);
    assert.equal(rep.rolledBack, true);
    assert.equal(rep.rollback?.ok, true);
    home.cleanup();
  });
});

test('saveFlowComplete：图保存失败时回滚', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    let saveCount = 0;
    const { client } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
      '/model/save': () => {
        saveCount++;
        return saveCount === 1 ? fail('图保存失败', 500) : ok({ state: true });
      },
    }));
    const rep = await FLOW.saveFlowComplete(client, { processId: 'p1', model: MODEL });
    assert.equal(rep.ok, false);
    assert.match(rep.msg ?? '', /图保存失败/);
    assert.equal(rep.modelSaved, false);
    assert.equal(rep.rolledBack, true);
    assert.equal(rep.rollback?.ok, true);
    home.cleanup();
  });
});

test('saveFlowComplete：节点属性写入失败时回滚', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
      '/node/batch/save': fail('批量失败', 500),
      '/node/save': (opts: any) => ((opts.body?.apiUrl === 'boom')
        ? fail('节点失败', 500)
        : ok({ state: true })),
    }));
    const rep = await FLOW.saveFlowComplete(client, {
      processId: 'p1', model: MODEL,
      nodeProps: { T00001: { nodeType: 'apiNode', props: { apiUrl: 'boom' } } },
    });
    assert.equal(rep.ok, false);
    assert.match(rep.msg ?? '', /节点属性保存失败/);
    assert.ok((rep.props?.failed.length ?? 0) > 0);
    assert.equal(rep.rolledBack, true);
    assert.equal(rep.rollback?.ok, true);
    home.cleanup();
  });
});

test('saveFlowComplete：回读缺少节点属性时判定失败并回滚', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
      '/node/props/list': ok({ rows: [{ id: 'r1', pNodeId: 'T00001' }] }),
    }));
    const rep = await FLOW.saveFlowComplete(client, { processId: 'p1', model: MODEL, readbackDelayMs: 0 });
    assert.equal(rep.ok, false);
    assert.match(rep.msg ?? '', /回读校验：缺少 \d+ 个节点属性/);
    assert.equal(rep.verified?.propsOk, false);
    assert.equal(rep.rolledBack, true);
    home.cleanup();
  });
});

test('saveFlowComplete：snapshot=false 时不做快照也不回滚', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
      '/model/checkerror': ok({ state: false, msg: '校验不通过' }),
    }));
    const rep = await FLOW.saveFlowComplete(client, { processId: 'p1', model: MODEL, snapshot: false });
    assert.equal(rep.snapshotFile, undefined);
    assert.equal(rep.rolledBack, undefined);
    assert.equal(rep.rollback, undefined);
    home.cleanup();
  });
});

test('saveFlowComplete：rollbackOnFailure=false 时不自动回滚', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
      '/model/checkerror': ok({ state: false, msg: '校验不通过' }),
    }));
    const rep = await FLOW.saveFlowComplete(client, {
      processId: 'p1', model: MODEL, rollbackOnFailure: false,
    });
    assert.equal(rep.ok, false);
    assert.equal(rep.rolledBack, undefined);
    home.cleanup();
  });
});

test('saveFlowComplete：prune=false 时不清理图外属性，check=false 时跳过平台校验', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client, calls } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
    }));
    const rep = await FLOW.saveFlowComplete(client, {
      processId: 'p1', model: MODEL, prune: false, check: false,
    });
    assert.equal(rep.ok, true);
    assert.equal(rep.pruned, undefined);
    assert.equal(rep.check, undefined);
    assert.equal(calls.some((c) => c.path.endsWith('/node/select')), false);
    assert.equal(calls.some((c) => c.path.endsWith('/model/checkerror')), false);
    home.cleanup();
  });
});

test('saveFlowComplete：图上节点没有属性时生成空属性记录', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    let listCalls = 0;
    const { client, calls } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
      '/node/props/list': () => {
        listCalls++;
        // 第一次是快照（平台还没有属性），之后是保存后的回读
        return ok({ rows: listCalls === 1 ? [] : PROP_ROWS });
      },
    }));
    const rep = await FLOW.saveFlowComplete(client, { processId: 'p1', model: MODEL });
    assert.equal(rep.ok, true);
    const batch = calls.find((c) => c.path.endsWith('/node/batch/save'))!;
    const bodies = batch.opts.body as any[];
    const t1 = bodies.find((b) => b.pNodeId === 'T00001');
    assert.equal(t1.pNodeType, 'apiNode', '缺属性时用图上的 nodeType');
    assert.equal(t1.apiUrl, undefined);
    const r1 = bodies.find((b) => b.pNodeId === 'R00001');
    assert.equal(r1.pNodeType, 'router');
    assert.equal(r1.assertCondition, '1');
    home.cleanup();
  });
});

test('saveNodePropsComplete：dry-run 不快照，成功后返回快照文件', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
    }));
    const rep = await FLOW.saveNodePropsComplete(client, {
      appId: 'esb', processId: 'p1',
      nodes: [{ nodeId: 'T00001', nodeType: 'apiNode', props: { apiUrl: 'u' } }],
    }, { dryRun: true });
    assert.equal(rep.inserted.length + rep.updated.length, 1);
    assert.equal(rep.snapshotFile, undefined);

    const rep2 = await FLOW.saveNodePropsComplete(client, {
      appId: 'esb', processId: 'p1',
      nodes: [{ nodeId: 'T00001', nodeType: 'apiNode', props: { apiUrl: 'u' } }],
    }, { dryRun: false });
    assert.ok(rep2.snapshotFile);
    assert.equal(rep2.rolledBack, undefined);
    home.cleanup();
  });
});

test('saveNodePropsComplete：属性写入失败时回滚', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
      '/node/save': (opts: any) => ((opts.body?.apiUrl === 'boom')
        ? fail('节点写入失败', 500)
        : ok({ state: true })),
    }));
    const rep = await FLOW.saveNodePropsComplete(client, {
      appId: 'esb', processId: 'p1',
      nodes: [{ nodeId: 'T00001', nodeType: 'apiNode', props: { apiUrl: 'boom' } }],
    }, { dryRun: false });
    assert.equal(rep.failed.length, 1);
    assert.equal(rep.rolledBack, true);
    assert.equal(rep.rollback?.ok, true);
    home.cleanup();
  });
});

// ---------------- 导出 / 属性列表 ----------------

test('exportFlow：导出图与属性，缺必填属性时标记骨架', async () => {
  const { client } = stub(baseRoutes({
    '/process/p1': ok({
      id: 'm1', processId: 'p1', configId: 'C1', configName: '订单流程', applicationId: 'app',
      processModel: JSON.stringify({ nodeDataArray: [{ key: 'T00001', nodeType: 'apiNode' }], linkDataArray: [] }),
    }),
    '/node/props/list': ok({ rows: [{ id: 'r1', pNodeId: 'T00001', pNodeType: 'apiNode' }] }),
  }));
  const out = await FLOW.exportFlow(client, 'p1');
  assert.equal(out.ok, true);
  const doc = out.doc!;
  assert.equal(doc.processId, 'p1');
  assert.equal(doc.kind, 'esb');
  assert.equal(doc.configId, 'C1');
  assert.equal(doc.configName, '订单流程');
  assert.equal(doc.skeleton, true);
  assert.deepEqual(doc.missingRequired, ['T00001.apiUrl']);
  assert.ok(doc.props.T00001);
});

test('exportFlow：属性齐全时不标记骨架', async () => {
  const { client } = stub(baseRoutes({
    '/process/p1': ok({
      id: 'm1', processId: 'p1',
      processModel: JSON.stringify({ nodeDataArray: [{ key: 'T00001', nodeType: 'apiNode' }], linkDataArray: [] }),
    }),
    '/node/props/list': ok({ rows: [{ id: 'r1', pNodeId: 'T00001', pNodeType: 'apiNode', apiUrl: 'https://x.test' }] }),
  }));
  const out = await FLOW.exportFlow(client, 'p1');
  assert.equal(out.ok, true);
  assert.equal(out.doc?.skeleton, undefined);
  assert.equal(out.doc?.missingRequired, undefined);
});

test('exportFlow：读不到流程时返回失败', async () => {
  const { client } = stub(() => fail('流程不存在', 404));
  const out = await FLOW.exportFlow(client, 'p1');
  assert.equal(out.ok, false);
  assert.equal(out.msg, '流程不存在');
});

test('exportFlow：详情没有 processModel 时返回失败', async () => {
  const { client } = stub(baseRoutes({ '/process/p1': ok({ id: 'm1', processId: 'p1' }) }));
  const out = await FLOW.exportFlow(client, 'p1');
  assert.equal(out.ok, false);
  assert.match(out.msg ?? '', /没有 processModel/);
});

test('listFlowProps：列出流程全部节点属性', async () => {
  const { client } = stub(baseRoutes({
    '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
  }));
  const out = await FLOW.listFlowProps(client, 'p1');
  assert.equal(out.ok, true);
  assert.deepEqual(Object.keys(out.props).sort(), ['E00001', 'E00002', 'R00001', 'R00002', 'T00001']);
  assert.equal(out.props.T00001?.id, 'r1');
});

test('missingRequiredFields：列出缺失的 nodeId.field，空串与空数组都算缺失', () => {
  const model = {
    nodeDataArray: [
      { key: 'T1', nodeType: 'apiNode' },
      { key: 'T2', nodeType: 'apiNode' },
      { key: 'T3', nodeType: 'other' },
    ],
  };
  const props = { T1: { apiUrl: 'https://x.test', apiMethod: '' }, T2: { apiUrl: [] as any } };
  const missing = FLOW.missingRequiredFields(model, props, { apiNode: ['apiUrl', 'apiMethod'] });
  assert.deepEqual(missing, ['T1.apiMethod', 'T2.apiUrl', 'T2.apiMethod']);
});

test('platformMissingRequired：平台本来就缺的必填项沿用现状，新增节点不沿用', async () => {
  const model = {
    nodeDataArray: [
      { key: 'T1', nodeType: 'apiNode' },
      { key: 'T2', nodeType: 'apiNode' },
      { key: 'T3', nodeType: 'apiNode' },
    ],
  };
  const { client } = stub(baseRoutes({
    '/process/p1': ok({
      id: 'm1', processId: 'p1',
      processModel: JSON.stringify({ nodeDataArray: [{ key: 'T1', nodeType: 'apiNode' }, { key: 'T3', nodeType: 'apiNode' }] }),
    }),
    '/node/props/list': ok({ rows: [
      { id: 'r1', pNodeId: 'T1', pNodeType: 'apiNode' },
      { id: 'r3', pNodeId: 'T3', pNodeType: 'apiNode', apiUrl: 'https://x.test' },
    ] }),
  }));
  const miss = await FLOW.platformMissingRequired(client, 'esb', 'p1', model, { T1: { apiUrl: 'https://new.test' } });
  assert.deepEqual([...miss], [], '本次补上的与平台已有的都不算缺失');
});

test('platformMissingRequired：平台缺且本次没补的字段进入集合', async () => {
  const model = { nodeDataArray: [{ key: 'T1', nodeType: 'apiNode' }] };
  const { client } = stub(baseRoutes({
    '/process/p1': ok({
      id: 'm1', processId: 'p1',
      processModel: JSON.stringify({ nodeDataArray: [{ key: 'T1', nodeType: 'apiNode' }] }),
    }),
    '/node/props/list': ok({ rows: [{ id: 'r1', pNodeId: 'T1', pNodeType: 'apiNode' }] }),
  }));
  const miss = await FLOW.platformMissingRequired(client, 'esb', 'p1', model);
  assert.deepEqual([...miss], ['T1|apiUrl']);
});

test('platformMissingRequired：平台读不到流程时返回空集合（不降级）', async () => {
  const model = { nodeDataArray: [{ key: 'T1', nodeType: 'apiNode' }] };
  const { client } = stub(() => fail('流程不存在', 404));
  const miss = await FLOW.platformMissingRequired(client, 'esb', 'p1', model);
  assert.equal(miss.size, 0);
});

test('platformMissingRequired：图为空或平台没有节点时返回空集合', async () => {
  const { client } = stub(baseRoutes({
    '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify({ nodeDataArray: [] }) }),
  }));
  assert.equal((await FLOW.platformMissingRequired(client, 'esb', 'p1', { nodeDataArray: [] })).size, 0);
  assert.equal((await FLOW.platformMissingRequired(client, 'esb', 'p1', { nodeDataArray: [{ key: 'T1', nodeType: 'apiNode' }] })).size, 0);
});

test('platformMissingRequired：读取属性异常时返回空集合', async () => {
  const { client } = stub(baseRoutes({
    '/process/p1': ok({
      id: 'm1', processId: 'p1',
      processModel: JSON.stringify({ nodeDataArray: [{ key: 'T1', nodeType: 'apiNode' }] }),
    }),
    '/node/props/list': () => { throw new Error('网络异常'); },
  }));
  const miss = await FLOW.platformMissingRequired(client, 'esb', 'p1', {
    nodeDataArray: [{ key: 'T1', nodeType: 'apiNode' }],
  });
  assert.equal(miss.size, 0);
});

// ---------------- 删除流程 ----------------

test('deleteFlow：真实删除前先快照，删除后轮询确认已消失', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    let deleted = false;
    const { client, calls } = stub(baseRoutes({
      '/process/p1': () => (deleted
        ? { ok: false, httpStatus: 404, msg: 'not found', data: {}, request: { method: 'GET', url: '/x' } }
        : ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) })),
      '/process/delete': () => { deleted = true; return ok({ state: true }); },
    }));
    const r = await FLOW.deleteFlow(client, 'p1', { dryRun: false, poll: { attempts: 2, intervalMs: 0 } });
    assert.equal(r.ok, true);
    assert.ok(r.snapshotFile);
    const del = calls.find((c) => c.path.endsWith('/process/delete'))!;
    assert.equal((del.opts.body as any).ids, 'm1,p1');
    assert.equal((del.opts.body as any).appId, 'esb');
    home.cleanup();
  });
});

test('deleteFlow：轮询后仍可读取时不能报告删除成功', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
      '/process/delete': ok({ state: true }),
    }));
    const r = await FLOW.deleteFlow(client, 'p1', { dryRun: false, poll: { attempts: 2, intervalMs: 0 } });
    assert.equal(r.ok, false);
    assert.match(r.msg ?? '', /删除请求已返回成功，但流程仍可读取/);
    home.cleanup();
  });
});

test('deleteFlow：删除端点失败时直接返回失败', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
      '/process/delete': fail('删除失败', 500),
    }));
    const r = await FLOW.deleteFlow(client, 'p1', { dryRun: false, poll: { attempts: 2, intervalMs: 0 } });
    assert.equal(r.ok, false);
    assert.equal(r.msg, '删除失败');
    home.cleanup();
  });
});

test('deleteFlow：显式 retries 时最多重试并保留快照', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client, calls } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) }),
      '/process/delete': ok({ state: true }),
    }));
    const r = await FLOW.deleteFlow(client, 'p1', { dryRun: false, retries: 1, poll: { attempts: 2, intervalMs: 0 } });
    assert.equal(r.ok, false);
    assert.equal(calls.filter((c) => c.path.endsWith('/process/delete')).length, 2);
    assert.ok(r.snapshotFile);
    home.cleanup();
  });
});

test('deleteFlow：查不到 Mongo id 时用 processId 删除', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    let detailCount = 0;
    const { client, calls } = stub((path) => {
      if (path.endsWith('/process/p1')) {
        detailCount++;
        // 第 1 次是快照读取，第 2 次是删除前的 id 查询 → 直接抛异常
        if (detailCount === 1) return ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) });
        if (detailCount === 2) throw new Error('详情查询异常');
        return ok({ id: 'm1', processId: 'p1' });
      }
      if (path.endsWith('/process/delete')) return ok({ state: true });
      if (path.endsWith('/node/props/list')) return ok({ rows: [] });
      if (path.endsWith('/node/select')) return ok([]);
      return ok({});
    });
    const r = await FLOW.deleteFlow(client, 'p1', { dryRun: false, poll: { attempts: 2, intervalMs: 0 } });
    const del = calls.find((c) => c.path.endsWith('/process/delete'))!;
    assert.equal((del.opts.body as any).ids, 'p1');
    assert.equal(r.ok, false);
    home.cleanup();
  });
});

test('deleteFlow：轮询阶段详情查询异常被吞掉，按"无法确认删除"处理', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    let detailCount = 0;
    const { client } = stub((path) => {
      if (path.endsWith('/process/p1')) {
        detailCount++;
        if (detailCount <= 2) return ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) });
        throw new Error('轮询详情异常');
      }
      if (path.endsWith('/process/delete')) return ok({ state: true });
      if (path.endsWith('/node/props/list')) return ok({ rows: [] });
      if (path.endsWith('/node/select')) return ok([]);
      return ok({});
    });
    // 网络异常不能把删除流程炸掉：按"无法确认已删除"返回 ok:false
    const r = await FLOW.deleteFlow(client, 'p1', { dryRun: false, poll: { attempts: 2, intervalMs: 0 } });
    assert.equal(r.ok, false);
    assert.match(String(r.msg), /无法确认流程已消失|仍可读取/);
    home.cleanup();
  });
});

test('deleteFlow：ETL 走 etl 端点并带 etl 模块', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client, calls } = stub((path) => {
      if (path.endsWith('/process/p1')) return ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) });
      if (path.endsWith('/process/delete')) return ok({ state: true });
      if (path.endsWith('/node/props')) return ok({});
      return ok({});
    });
    await FLOW.deleteFlow(client, 'p1', { dryRun: true, kind: 'etl' });
    const del = calls.find((c) => c.path.endsWith('/process/delete'))!;
    assert.equal(del.path, '/rest/etl/process/delete');
    assert.equal((del.opts.body as any).appId, 'etl');
    home.cleanup();
  });
});
