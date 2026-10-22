import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextId, prefixFor, buildProcessModel, buildSaveRequest } from '../../packages/core/src/flow-build.ts';
import { validateFlow, hasBlockingError } from '../../packages/core/src/flow-validate.ts';
import { buildNodeProps, buildSubProcessProps, assertNodeProps } from '../../packages/core/src/flow-props.ts';
import { fingerprint, canonicalize } from '../../packages/core/src/idempotency.ts';
import { RcError, classifyHttp, redact } from '../../packages/core/src/errors.ts';

test('ID 分配：填最小空缺，不从最大值+1', () => {
  assert.equal(nextId('E', []), 'E00001');
  assert.equal(nextId('E', ['E00001', 'E00003']), 'E00002');
  assert.equal(nextId('T', ['T00001', 'T00002']), 'T00003');
});

test('前缀规则与源码一致', () => {
  assert.equal(prefixFor('start'), 'E');
  assert.equal(prefixFor('end'), 'E');
  assert.equal(prefixFor('timeNode'), 'E');
  assert.equal(prefixFor('gateWay'), 'G');
  assert.equal(prefixFor('subProcessNode'), 'S');
  assert.equal(prefixFor('apiNode'), 'T');
  assert.equal(prefixFor('jdbcWriteNode'), 'T');
});

test('构造 4 节点流程并序列化', () => {
  const { model, warnings } = buildProcessModel({
    nodes: [
      { nodeType: 'start', text: '开始' },
      { nodeType: 'apiNode', text: '取数' },
      { nodeType: 'end', text: '结束' },
    ],
    edges: [
      { from: 'E00001', to: 'T00001' },
      { from: 'T00001', to: 'E00002' },
    ],
  });
  assert.equal(model.nodeDataArray.length, 3);
  assert.equal(model.linkDataArray.length, 2);
  assert.equal(model.nodeDataArray[0].key, 'E00001');
  assert.equal(model.nodeDataArray[1].key, 'T00001');
  assert.equal(model.nodeDataArray[2].key, 'E00002');
  assert.equal(model.linkDataArray[0].routerId, 'R00001');
  assert.equal(model.linkDataArray[0].label, 'NO_SHOW');
  assert.equal(model.linkDataArray[0].lineType, 'Curved');
  assert.equal(warnings.length, 0);

  const req = buildSaveRequest('SPAPI', 'p1', model);
  assert.equal(typeof req.processModel, 'string');
  assert.deepEqual(Object.keys(JSON.parse(req.processModel)), ['nodeDataArray', 'linkDataArray', 'transform', 'translate', 'detailFlag']);
});

test('排他网关缺省路由：报 GW_NO_DEFAULT', () => {
  const { model } = buildProcessModel({
    nodes: [
      { nodeType: 'start' },
      { nodeType: 'gateWay' },
      { nodeType: 'apiNode' },
      { nodeType: 'end' },
    ],
    edges: [
      { from: 'E00001', to: 'G00001' },
      { from: 'G00001', to: 'T00001', label: '大额', assertCondition: '$.amount > 1000' },
      { from: 'T00001', to: 'E00002' },
    ],
  });
  // gatewayType=1 排他网关：必须有一条缺省路由
  const issues = validateFlow(model, { nodeProps: { G00001: { gatewayType: '1' } } });
  assert.ok(issues.some((i) => i.code === 'GW_NO_DEFAULT' && i.level === 'error'), JSON.stringify(issues));
});

test('并行网关必须配对聚合网关（gateWay + joinNodeId）', () => {
  const spec = {
    nodes: [
      { nodeType: 'start' }, { nodeType: 'gateWay' }, { nodeType: 'dataMapNode' },
      { nodeType: 'gateWay' }, { nodeType: 'end' },
    ],
    edges: [
      { from: 'E00001', to: 'G00001' },
      { from: 'G00001', to: 'T00001', label: 'A', assertCondition: '$.a>1' },
      { from: 'G00001', to: 'G00002', label: '默认' },
      { from: 'T00001', to: 'G00002' },
      { from: 'G00002', to: 'E00002' },
    ],
  };
  const { model } = buildProcessModel(spec);
  // 缺 joinNodeId → 报 GW_MERGE_MISSING
  const noJoin = validateFlow(model, { nodeProps: { G00001: { gatewayType: '2' }, G00002: { gatewayType: '2' } } });
  assert.ok(noJoin.some((i) => i.code === 'GW_MERGE_MISSING'), JSON.stringify(noJoin));
  // joinNodeId 指向并行网关 → 通过
  const withJoin = validateFlow(model, {
    nodeProps: { G00001: { gatewayType: '2' }, G00002: { gatewayType: '2', joinNodeId: 'G00001' } },
  });
  assert.equal(withJoin.filter((i) => i.level === 'error' && i.code.startsWith('GW_')).length, 0, JSON.stringify(withJoin));
});

test('校验：缺 end / 未知类型 / 环 / 悬空连线', () => {
  const bad = {
    nodeDataArray: [{ key: 'E00001', nodeType: 'start' }, { key: 'X1', nodeType: 'notExist' }],
    linkDataArray: [{ routerId: 'R00001', from: 'E00001', to: 'NOPE' }],
  };
  const issues = validateFlow(bad, { knownTypes: new Set(['start', 'end', 'apiNode']) });
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes('NO_END'));
  assert.ok(codes.includes('UNKNOWN_TYPE'));
  assert.ok(codes.includes('EDGE_TO'));

  const cycle = {
    nodeDataArray: [
      { key: 'E00001', nodeType: 'start' },
      { key: 'T00001', nodeType: 'apiNode' },
      { key: 'E00002', nodeType: 'end' },
    ],
    linkDataArray: [
      { routerId: 'R00001', from: 'E00001', to: 'T00001' },
      { routerId: 'R00002', from: 'T00001', to: 'T00001' },
      { routerId: 'R00003', from: 'T00001', to: 'E00002' },
    ],
  };
  assert.ok(hasBlockingError(validateFlow(cycle)));
});

test('校验：生产禁用 mock、属性一致性、子流程引用', () => {
  const model = {
    nodeDataArray: [
      { key: 'E00001', nodeType: 'start' },
      { key: 'T00001', nodeType: 'mockResponseNode' },
      { key: 'S00001', nodeType: 'subProcessNode' },
      { key: 'E00002', nodeType: 'end' },
    ],
    linkDataArray: [
      { routerId: 'R00001', from: 'E00001', to: 'T00001' },
      { routerId: 'R00002', from: 'T00001', to: 'S00001' },
      { routerId: 'R00003', from: 'S00001', to: 'E00002' },
    ],
  };
  const issues = validateFlow(model, {
    allowMock: false,
    nodeProps: {
      T00001: { pNodeId: 'T00001', pNodeType: 'mockResponseNode' },
      S00001: { pNodeId: 'S00001', pNodeType: 'subProcessNode', subProcessId: 'sp-x' },
    },
    subProcessExists: () => false,
  });
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes('MOCK'));
  assert.ok(codes.includes('SUB_NOT_FOUND'));
});

test('节点属性：数组/JSON/布尔 的字符串化', () => {
  const p = buildNodeProps({
    appId: 'SPAPI', processId: 'p1', nodeId: 'T00003', nodeType: 'apiNode', nodeName: 'Restful API',
    values: {
      apiUrl: 'https://api.example.com/token',
      asyncFlag: false,
      retryNum: 0,
      inParams: [{ id: 0, paramsId: 'grant_type', paramsValue: 'refresh_token' }],
      roles: ['a', 'b'],
      compensateFlag: true,
    },
  });
  assert.equal(p.asyncFlag, '0');
  assert.equal(p.compensateFlag, '1');
  assert.equal(p.roles, 'a,b');
  assert.equal(typeof p.inParams, 'string');
  assert.equal(JSON.parse(String(p.inParams))[0].paramsId, 'grant_type');
  assert.equal(p.pNodeId, 'T00003');
  assert.deepEqual(assertNodeProps(p), []);
});

test('子流程属性默认值', () => {
  const p = buildSubProcessProps({
    appId: 'SPAPI', processId: 'p1', nodeId: 'S00001', nodeType: 'subProcessNode', nodeName: '子流程',
    subProcessId: 'sub-1',
  });
  assert.equal(p.inDataFlag, '0');
  assert.equal(p.outDataFlag, '0');
  assert.equal(p.responseData, '1');
});

test('幂等指纹：字段顺序无关，内容相关', () => {
  const a = fingerprint('POST', '/x', { b: 1, a: 2 });
  const b = fingerprint('POST', '/x', { a: 2, b: 1 });
  const c = fingerprint('POST', '/x', { a: 2, b: 3 });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(canonicalize({ z: 1, a: [{ y: 2, x: 1 }] }), '{"a":[{"x":1,"y":2}],"z":1}');
});

test('错误分类与脱敏', () => {
  assert.equal(classifyHttp(401), 'E_AUTH');
  assert.equal(classifyHttp(500), 'E_UPSTREAM');
  assert.equal(classifyHttp(400, 400), 'E_VALIDATION');
  const e = new RcError('E_AUTH', '登录失败');
  assert.equal(e.exitCode, 3);
  assert.ok(e.toUserMessage().includes('RC_USER'));
  assert.deepEqual(redact({ password: 'x', nested: { token: 'y', keep: 1 } }), { password: '***', nested: { token: '***', keep: 1 } });
});
