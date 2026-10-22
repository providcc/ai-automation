import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as FLOW from '../../packages/core/src/flow-lifecycle.ts';
import { buildProcessModel } from '../../packages/core/src/flow-build.ts';
import { validateFlow } from '../../packages/core/src/flow-validate.ts';
import { parseAllowedHosts, hostAllowed, assertAllowedHost } from '../../packages/core/src/security.ts';
import { resolveCredentials } from '../../packages/core/src/credentials.ts';
import { Catalog } from '../../packages/core/src/catalog.ts';

type Call = { path: string; opts: any };
const ok = (data: unknown = {}) => ({ ok: true, httpStatus: 200, data, request: { method: 'GET', url: '/x' } });

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

test('属性格式统一：数组 / nodeId 映射 / 组合文件 / 原始 pNodeId 记录', () => {
  const map = {
    T00001: { pNodeId: 'T00001', pNodeType: 'apiNode', pNodeName: 'A', gatewayType: '1', id: 'id-1' },
    T00002: { pNodeId: 'T00002', pNodeType: 'apiNode', pNodeName: 'B', assertCondition: '0' },
  };
  const a = FLOW.normalizeNodeProps(map)!;
  assert.equal(a.length, 2);
  assert.equal(a[0].nodeId, 'T00001');
  assert.equal(a[0].nodeType, 'apiNode');
  assert.equal(a[0].id, 'id-1');
  assert.equal((a[0].props as any).pNodeId, undefined);
  assert.equal((a[0].props as any).gatewayType, '1');

  const b = FLOW.normalizeNodeProps([{ nodeId: 'G00001', nodeType: 'gateWay', props: { gatewayType: '2' } }])!;
  assert.equal(b[0].nodeId, 'G00001');
  assert.equal((b[0].props as any).gatewayType, '2');

  const c = FLOW.normalizeNodeProps({ model: {}, props: map })!;
  assert.deepEqual(c.map((x) => x.nodeId), ['T00001', 'T00002']);

  const d = FLOW.normalizeNodeProps([{ pNodeId: 'R00001', pNodeType: 'router', assertCondition: '0' }])!;
  assert.equal(d[0].nodeId, 'R00001');
  assert.equal((d[0].props as any).assertCondition, '0');
});

test('ETL 端点路由：check / props / select / versions 全部走 /rest/etl', async () => {
  const { client, calls } = fake((path, opts) => {
    if (path.endsWith('/model/checkerror')) return ok({ state: true, msg: '未发现错误' });
    if (path.endsWith('/version/list')) return ok({ rows: [{ id: 'v1' }] });
    if (path.endsWith('/node/props')) return ok({ pNodeId: opts.query.nodeId, pNodeType: 'apiNode', id: 'p1' });
    if (path.endsWith('/node/select')) return ok([{ nodeId: 'T00001', nodeName: 'A' }]);
    return ok();
  });
  const chk = await FLOW.checkFlow(client, { processId: 'p1', processModel: '{}', kind: 'etl' });
  assert.equal(chk.ok, true);
  await FLOW.getNodeProps(client, 'p1', 'T00001', { kind: 'etl' });
  await FLOW.listFlowNodes(client, 'p1', undefined, { kind: 'etl' });
  await FLOW.listVersions(client, 'p1', { kind: 'etl' });
  assert.deepEqual(calls.map((x) => x.path), [
    '/rest/etl/process/model/checkerror',
    '/rest/etl/process/node/props',
    '/rest/etl/process/node/select',
    '/rest/etl/process/version/list',
  ]);
  assert.equal(calls[0].opts.body.appId, 'etl');
});

test('build 输出规格属性；没有属性时校验器不假设网关是并行网关', () => {
  const built = buildProcessModel({
    kind: 'esb',
    nodes: [
      { nodeType: 'start', text: '开始' },
      { nodeType: 'gateWay', text: '排他', props: { gatewayType: '1' } },
      { nodeType: 'apiNode', text: 'A' },
      { nodeType: 'apiNode', text: 'B' },
      { nodeType: 'end', text: '结束' },
    ],
    edges: [
      { from: 'E00001', to: 'G00001' },
      { from: 'G00001', to: 'T00001', assertCondition: '1', props: { routerCondition: '1==1' } },
      { from: 'G00001', to: 'T00002', assertCondition: '0' },
      { from: 'T00001', to: 'E00002' },
      { from: 'T00002', to: 'E00002' },
    ],
  });
  const ids = built.props.map((p) => p.nodeId);
  assert.ok(ids.includes('G00001'));
  assert.ok(ids.some((x) => x.startsWith('R')));

  // 只给图、不给属性：不能把 G00001 当成并行网关而报 GW_MERGE_MISSING
  const issues = validateFlow(built.model, { allowMock: false });
  assert.equal(issues.some((i) => i.code === 'GW_MERGE_MISSING'), false);
  // 显式网关属性才触发排他网关缺省分支检查
  const issuesWithProps = validateFlow(built.model, {
    allowMock: false,
    nodeProps: FLOW.nodePropsMap(built.props),
  });
  assert.equal(issuesWithProps.some((i) => i.code === 'GW_NO_DEFAULT'), false);
});

test('批量属性写入：ESB >=3 个节点走 batch/save，body 是属性数组', async () => {
  const { client, calls } = fake((path) => {
    if (path.endsWith('/node/props/list')) return ok({});
    if (path.endsWith('/node/batch/save')) return ok({ state: true, msg: 'Y' });
    return ok();
  });
  const rep = await FLOW.upsertNodeProps(client, {
    appId: 'esb', processId: 'p1', kind: 'esb',
    nodes: ['T00001', 'T00002', 'T00003'].map((nodeId) => ({ nodeId, nodeType: 'apiNode', props: { x: 1 } })),
  });
  assert.equal(rep.inserted.length, 3);
  const batch = calls.find((x) => x.path.endsWith('/node/batch/save'))!;
  assert.ok(Array.isArray(batch.opts.body));
  assert.equal(batch.opts.body[0].pNodeId, 'T00001');
  assert.equal(batch.opts.body[0].appId, 'esb');
});

test('批量属性写入：清理同一 pNodeId 的历史重复记录', async () => {
  const { client, calls } = fake((path) => {
    if (path.endsWith('/node/props/list')) return ok([
      { id: 'r1', pNodeId: 'T00001', pNodeType: 'apiNode', old: '1' },
      { id: 'r2', pNodeId: 'T00001', pNodeType: 'apiNode', old: '2' },
      { id: 'r3', pNodeId: 'T00002', pNodeType: 'apiNode' },
      { id: 'r4', pNodeId: 'T00003', pNodeType: 'apiNode' },
    ]);
    if (path.endsWith('/node/batch/save')) return ok({ state: true, msg: 'Y' });
    return ok();
  });
  const rep = await FLOW.upsertNodeProps(client, {
    appId: 'esb', processId: 'p1', kind: 'esb',
    nodes: ['T00001', 'T00002', 'T00003'].map((nodeId) => ({ nodeId, nodeType: 'apiNode', props: { x: 1 } })),
  });
  assert.deepEqual(rep.deduped, ['T00001']);
  const del = calls.find((x) => x.path.endsWith('/node/delete'))!;
  assert.equal((del.opts.body as any).ids, 'r1');
});

test('flow list 全量：多页拉取 + 按 processId 去重', async () => {
  const { client, calls } = fake((_path, opts) => {
    if (opts.query?.pageNo === 1) return ok({ state: true, total: 3, rows: [{ processId: 'p1' }, { processId: 'p2' }] });
    return ok({ state: true, total: 3, rows: [{ processId: 'p2' }, { processId: 'p3' }] });
  });
  const r = await FLOW.listFlows(client, { all: true, pageSize: 2 });
  const rows = FLOW.unwrapFlowRows(r.data?.data ?? r.data);
  assert.deepEqual(rows.map((x) => x.processId), ['p1', 'p2', 'p3']);
  assert.equal(calls.length, 2);
});

test('列表客户端过滤：关键词 + 应用 + 分页语义', () => {
  const rows = [
    { processId: 'p1', configId: 'A', configName: '流水线A', applicationId: 'test' },
    { processId: 'p2', configId: 'B', configName: '库存同步', applicationId: 'prod' },
    { processId: 'p3', configId: 'C', configName: '流水线C', applicationId: 'test' },
  ];
  assert.deepEqual(FLOW.filterFlows(rows, { keyword: '流水线', appId: 'test' }).map((x) => x.processId), ['p1', 'p3']);
  assert.deepEqual(FLOW.filterFlows(rows, { appId: 'prod' }).map((x) => x.processId), ['p2']);
});

test('ETL dry-run：只构造请求，不调用平台 checkerror，不创建快照', async () => {
  const { client, calls } = fake((path) => {
    if (path.endsWith('/node/props')) return ok({});
    return ok({ state: true });
  });
  const rep = await FLOW.saveFlowComplete(client, {
    kind: 'etl', appId: 'etl', processId: 'p1', dryRun: true, snapshot: true,
    model: buildProcessModel({ kind: 'etl', nodes: [{ nodeType: 'start' }, { nodeType: 'end' }], edges: [{ from: 'E00001', to: 'E00002' }] }).model,
    nodeProps: { E00001: { pNodeType: 'start' }, E00002: { pNodeType: 'end' } },
  });
  assert.equal(rep.ok, true);
  assert.equal(rep.msg, 'dry-run：未落库');
  assert.equal(rep.snapshotFile, undefined);
  assert.equal(rep.check, undefined);
  assert.equal(calls.some((x) => x.path.endsWith('/model/checkerror')), false);
  assert.ok(calls.some((x) => x.path === '/rest/etl/process/node/save' && x.opts.dryRun === true));
  assert.ok(calls.some((x) => x.path === '/rest/etl/process/model/save' && x.opts.dryRun === true));
});

test('删除默认 dry-run：不创建快照', async () => {
  const { client, calls } = fake((path) => {
    if (path.endsWith('/process/p1')) return ok({ id: 'm1', processId: 'p1' });
    return ok({ state: true });
  });
  const r = await FLOW.deleteFlow(client, 'p1', { kind: 'esb' });
  assert.equal(r.ok, true);
  assert.equal(r.snapshotFile, undefined);
  const del = calls.find((x) => x.path === '/rest/esb/process/delete')!;
  assert.equal(del.opts.dryRun, true);
});

test('删除前置快照失败时中止，不调用删除端点', async () => {
  const { client, calls } = fake((path) => {
    if (path.startsWith('/rest/esb/process/') && !path.includes('/node/')) return { ok: false, httpStatus: 500, msg: 'not found', data: {} };
    return ok();
  });
  await assert.rejects(
    () => FLOW.deleteFlow(client, 'missing', { kind: 'esb', dryRun: false }),
    /快照失败/,
  );
  assert.equal(calls.some((x) => x.path === '/rest/esb/process/delete'), false);
});

test('目标主机白名单：精确/通配符/未配置', () => {
  const patterns = parseAllowedHosts('ipaas-test.example.com,*.corp.example.com');
  assert.equal(hostAllowed('ipaas-test.example.com', patterns), true);
  assert.equal(hostAllowed('a.corp.example.com', patterns), true);
  assert.equal(hostAllowed('a.corp.example.com:8443', patterns), true);
  assert.equal(hostAllowed('evil.example.com', patterns), false);
  assert.doesNotThrow(() => assertAllowedHost('https://ipaas-test.example.com/restcloud', patterns));
  assert.throws(() => assertAllowedHost('https://evil.example.com/restcloud', patterns), /不在 RC_ALLOWED_HOSTS/);
});

test('凭据解析：环境变量优先，不触碰钥匙串', () => {
  const c = resolveCredentials({ RC_USER: 'u', RC_PASS: 'p' }, { platform: 'darwin' });
  assert.equal(c.user, 'u');
  assert.equal(c.pass, 'p');
  assert.equal(c.source, 'env');
});

test('组件目录必填属性：只保留没有默认值的必填项', () => {
  const cat = new Catalog();
  const req = cat.requiredFields('esb');
  assert.deepEqual(req.apiNode, ['apiUrl']);
  assert.ok(!req.apiNode?.includes('connectTimeout'), '有默认值的字段不应强制');
  assert.ok(!req.apiNode?.includes('pNodeName'), '元字段不应强制');
  // ETL 组件目录没有采集参数 → 只有启发式规则（SQL/DB、网关类型）
  const etl = cat.requiredFields('etl');
  assert.equal(etl.apiNode, undefined, 'ETL 不应有组件目录派生的规则');
  assert.deepEqual(etl.sqlExecuterNode, ['dbConnId', 'sqlCode']);
  assert.deepEqual(etl.gateWay, ['gatewayType']);
  // ESB 额外带 SQL/DB 启发式
  assert.deepEqual(cat.requiredFields('esb').tableReadNode, ['dbConnId', 'tableName']);
});

test('必填属性缺失：默认阻断，可用 warn/off 降级', () => {
  const model = {
    nodeDataArray: [
      { key: 'E00001', nodeType: 'start' },
      { key: 'T00001', nodeType: 'apiNode' },
      { key: 'E00002', nodeType: 'end' },
    ],
    linkDataArray: [
      { from: 'E00001', to: 'T00001', routerId: 'R00001' },
      { from: 'T00001', to: 'E00002', routerId: 'R00002' },
    ],
  };
  const required = { apiNode: ['apiUrl'] };
  // 节点完全没有属性记录时也要报出来（否则"删掉整条属性"可以绕过校验）
  const errs = validateFlow(model, { requiredFields: required, nodeProps: {} });
  const hit = errs.filter((i) => i.code === 'REQUIRED_FIELD');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].level, 'error');
  assert.match(hit[0].msg, /apiUrl/);
  // 骨架模板：降级为警告
  const warns = validateFlow(model, { requiredFields: required, nodeProps: {}, requiredLevel: 'warn' });
  assert.equal(warns.filter((i) => i.code === 'REQUIRED_FIELD')[0].level, 'warn');
  // 关闭该规则
  const off = validateFlow(model, { requiredFields: required, nodeProps: {}, requiredLevel: 'off' });
  assert.equal(off.filter((i) => i.code === 'REQUIRED_FIELD').length, 0);
});

test('必填属性：apiId 视为 apiUrl 的替代写法', () => {
  const model = {
    nodeDataArray: [
      { key: 'E00001', nodeType: 'start' },
      { key: 'T00001', nodeType: 'apiNode' },
      { key: 'E00002', nodeType: 'end' },
    ],
    linkDataArray: [
      { from: 'E00001', to: 'T00001', routerId: 'R00001' },
      { from: 'T00001', to: 'E00002', routerId: 'R00002' },
    ],
  };
  const required = { apiNode: ['apiUrl'] };
  const byApiId = validateFlow(model, { requiredFields: required, nodeProps: { T00001: { apiId: 'SVC_1' } } });
  assert.equal(byApiId.filter((i) => i.code === 'REQUIRED_FIELD').length, 0);
  const byUrl = validateFlow(model, { requiredFields: required, nodeProps: { T00001: { apiUrl: 'https://example.test/x' } } });
  assert.equal(byUrl.filter((i) => i.code === 'REQUIRED_FIELD').length, 0);
});

test('flow search：按节点类型找真实流程，属性去掉平台元数据', async () => {
  const { client, calls } = fake((path, opts) => {
    if (path.includes('/process/list')) {
      return ok({ rows: [
        { processId: 'p1', configId: 'C1', configName: '流程A', applicationId: 'app-a' },
        { processId: 'p2', configId: 'C2', configName: '其它流程', applicationId: 'app-b' },
      ] });
    }
    if (path.includes('/node/props/list')) {
      // 只有 p1 里有 apiNode 节点（processId 在 query 里）
      if (String(opts?.query?.processId ?? '') === 'p2') return ok({});
      return ok({ T00001: { id: 'r1', pNodeId: 'T00001', pNodeType: 'apiNode', pNodeName: '调用', apiUrl: 'https://x/y', appId: 'esb', createTime: '2026-01-01' } });
    }
    if (path.endsWith('/process/p1') || path.endsWith('/process/p2')) {
      return ok({ id: 'm1', processId: 'p1', processModel: { nodeDataArray: [{ key: 'T00001', nodeType: 'apiNode' }], linkDataArray: [] } });
    }
    return ok({});
  });
  const res = await FLOW.searchFlowsByNodeType(client, { nodeType: 'apiNode' });
  assert.equal(res.matched, 1);
  assert.equal(res.hits[0].processId, 'p1');
  assert.equal(res.hits[0].nodeId, 'T00001');
  assert.equal(res.hits[0].props.apiUrl, 'https://x/y');
  assert.equal((res.hits[0].props as any).createTime, undefined, '平台元数据应被剥掉');
  assert.equal((res.hits[0].props as any).appId, undefined);
  assert.ok(calls.length >= 1);
});
