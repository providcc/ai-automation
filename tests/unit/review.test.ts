/**
 * review：流程/API 上线前评审（blocker/major/minor/info 四级）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewFlow, reviewApiBundle, formatReview } from '../../packages/core/src/review.ts';

const KNOWN = new Set(['start', 'end', 'apiNode', 'gateWay', 'sqlExecuterNode', 'mockResponseNode', 'returnDataNode']);

const baseModel = (): any => ({
  nodeDataArray: [
    { key: 'E00001', nodeType: 'start' },
    { key: 'T00001', nodeType: 'apiNode' },
    { key: 'E00002', nodeType: 'end' },
  ],
  linkDataArray: [
    { routerId: 'R00001', from: 'E00001', to: 'T00001', assertCondition: '0' },
    { routerId: 'R00002', from: 'T00001', to: 'E00002', assertCondition: '0' },
  ],
});

const find = (r: any, code: string) => r.findings.find((f: any) => f.code === code);

test('review：多个开始节点是 blocker', () => {
  const model = baseModel();
  model.nodeDataArray.push({ key: 'E00003', nodeType: 'start' });
  const r = reviewFlow(model, { knownTypes: KNOWN });
  const f = find(r, 'START_COUNT');
  assert.ok(f, '应报告开始节点数量');
  assert.equal(f!.severity, 'blocker');
  assert.match(f!.message, /实际 2 个/);
  assert.equal(r.ok, false);
  assert.ok(r.summary.blocker >= 1);
});

test('review：缺少结束节点是 major', () => {
  const model = baseModel();
  model.nodeDataArray = model.nodeDataArray.filter((n: any) => n.nodeType !== 'end');
  model.linkDataArray = model.linkDataArray.filter((e: any) => e.to !== 'E00002');
  const r = reviewFlow(model, { knownTypes: KNOWN });
  const f = find(r, 'END_MISSING');
  assert.ok(f);
  assert.equal(f!.severity, 'major');
  assert.equal(r.ok, false);
});

test('review：未知节点类型由平台校验拦截（blocker）', () => {
  const model = baseModel();
  model.nodeDataArray.push({ key: 'T00002', nodeType: 'weirdNode' });
  model.linkDataArray.push({ routerId: 'R00003', from: 'T00001', to: 'T00002', assertCondition: '0' });
  const r = reviewFlow(model, { knownTypes: KNOWN });
  const f = find(r, 'VALIDATE_UNKNOWN_TYPE');
  assert.ok(f);
  assert.equal(f!.severity, 'blocker');
  assert.equal(r.ok, false);
});

test('review：生产环境的 mock 节点是 blocker', () => {
  const model = baseModel();
  model.nodeDataArray.push({ key: 'T00002', nodeType: 'mockResponseNode' });
  model.linkDataArray.push({ routerId: 'R00003', from: 'T00001', to: 'T00002', assertCondition: '0' });
  model.linkDataArray.push({ routerId: 'R00004', from: 'T00002', to: 'E00002', assertCondition: '0' });
  const r = reviewFlow(model, { production: true, knownTypes: KNOWN });
  assert.ok(find(r, 'VALIDATE_MOCK'), '生产应禁用 mock 节点');
  assert.ok(find(r, 'MOCK_IN_PROD'), '应报告生产含模拟节点');
  assert.equal(find(r, 'MOCK_IN_PROD')!.severity, 'blocker');
  assert.equal(r.ok, false);
});

test('review：非生产环境允许 mock 节点', () => {
  const model = baseModel();
  model.nodeDataArray.push({ key: 'T00002', nodeType: 'mockResponseNode' });
  model.linkDataArray.push({ routerId: 'R00003', from: 'T00001', to: 'T00002', assertCondition: '0' });
  model.linkDataArray.push({ routerId: 'R00004', from: 'T00002', to: 'E00002', assertCondition: '0' });
  const r = reviewFlow(model, { knownTypes: KNOWN });
  assert.equal(find(r, 'VALIDATE_MOCK'), undefined);
  assert.equal(find(r, 'MOCK_IN_PROD'), undefined);
});

test('review：API 节点缺必填属性/明文 HTTP/本机地址都会提示', () => {
  const model = baseModel();
  const r = reviewFlow(model, {
    knownTypes: KNOWN,
    nodeProps: { T00001: { apiUrl: 'http://localhost:8080/x' } },
  });
  assert.equal(find(r, 'HTTP_PLAIN')!.severity, 'major');
  assert.equal(find(r, 'LOCALHOST')!.severity, 'major');
  assert.equal(find(r, 'NO_RETRY')!.severity, 'minor');
  assert.equal(find(r, 'NO_TIMEOUT')!.severity, 'minor');
  assert.match(find(r, 'LOCALHOST')!.message, /本机\/回环地址/);
  assert.ok(r.ok === false);
});

test('review：API 节点配置齐全时不再提示重试/超时', () => {
  const model = baseModel();
  const r = reviewFlow(model, {
    knownTypes: KNOWN,
    nodeProps: { T00001: { apiUrl: 'https://api.test/x', retryNum: 2, connectTimeout: 1000 } },
  });
  assert.equal(find(r, 'NO_RETRY'), undefined);
  assert.equal(find(r, 'NO_TIMEOUT'), undefined);
  assert.equal(find(r, 'HTTP_PLAIN'), undefined);
});

test('review：异步节点未见异常/回调处理是 minor', () => {
  const model = baseModel();
  const r = reviewFlow(model, {
    knownTypes: KNOWN,
    nodeProps: { T00001: { apiUrl: 'https://api.test/x', retryNum: 1, connectTimeout: 1, asyncFlag: '1' } },
  });
  assert.equal(find(r, 'ASYNC_NO_CALLBACK')!.severity, 'minor');
});

test('review：异步节点配置了 responseData 后不再提示', () => {
  const model = baseModel();
  const r = reviewFlow(model, {
    knownTypes: KNOWN,
    nodeProps: { T00001: { apiUrl: 'https://api.test/x', retryNum: 1, connectTimeout: 1, asyncFlag: '1', responseData: '1' } },
  });
  assert.equal(find(r, 'ASYNC_NO_CALLBACK'), undefined);
});

test('review：SQL 节点变量插值只是提示（平台的唯一写法），生产环境破坏性 SQL 是 blocker', () => {
  const model = baseModel();
  model.nodeDataArray[1] = { key: 'T00001', nodeType: 'sqlExecuterNode' };
  const r = reviewFlow(model, {
    knownTypes: KNOWN,
    nodeProps: { T00001: { sqlCode: "select * from t where id = '${$.id}'" } },
  });
  // 平台的 ${...} 模板拼接是唯一可用的写法，不该当成 major 问题
  assert.equal(find(r, 'SQL_INTERPOLATION')!.severity, 'info');

  const prod = reviewFlow(model, {
    production: true,
    knownTypes: KNOWN,
    nodeProps: { T00001: { sqlCode: 'DROP TABLE t' } },
  });
  assert.equal(find(prod, 'SQL_DESTRUCTIVE')!.severity, 'blocker');
  assert.equal(prod.ok, false);
});

test('review：网关缺少默认分支/只有一个出口', () => {
  const model = baseModel();
  model.nodeDataArray = [
    { key: 'E00001', nodeType: 'start' },
    { key: 'G00001', nodeType: 'gateWay' },
    { key: 'T00001', nodeType: 'apiNode' },
    { key: 'E00002', nodeType: 'end' },
  ];
  model.linkDataArray = [
    { routerId: 'R00001', from: 'E00001', to: 'G00001', assertCondition: '0' },
    { routerId: 'R00002', from: 'G00001', to: 'T00001', assertCondition: '3' },
    { routerId: 'R00003', from: 'T00001', to: 'E00002', assertCondition: '0' },
  ];
  const r = reviewFlow(model, { knownTypes: KNOWN });
  assert.equal(find(r, 'GW_NO_DEFAULT')!.severity, 'major');
  assert.equal(find(r, 'GW_SINGLE_OUT')!.severity, 'minor');
});

test('review：网关有默认分支且多出口时不再提示', () => {
  const model = baseModel();
  model.nodeDataArray = [
    { key: 'E00001', nodeType: 'start' },
    { key: 'G00001', nodeType: 'gateWay' },
    { key: 'T00001', nodeType: 'apiNode' },
    { key: 'T00002', nodeType: 'returnDataNode' },
    { key: 'E00002', nodeType: 'end' },
  ];
  model.linkDataArray = [
    { routerId: 'R00001', from: 'E00001', to: 'G00001', assertCondition: '0' },
    { routerId: 'R00002', from: 'G00001', to: 'T00001', assertCondition: '3' },
    { routerId: 'R00003', from: 'G00001', to: 'T00002', assertCondition: '0' },
    { routerId: 'R00004', from: 'T00001', to: 'E00002', assertCondition: '0' },
  ];
  const r = reviewFlow(model, { knownTypes: KNOWN });
  assert.equal(find(r, 'GW_NO_DEFAULT'), undefined);
  assert.equal(find(r, 'GW_SINGLE_OUT'), undefined);
});

test('review：明文凭据（字段名 + 字符串值）都是 blocker', () => {
  const model = baseModel();
  const r = reviewFlow(model, {
    knownTypes: KNOWN,
    nodeProps: { T00001: { password: '<secret>' } },
  });
  const f = find(r, 'SECRET_FIELD');
  assert.ok(f);
  assert.equal(f!.severity, 'blocker');
  assert.match(f!.message, /敏感字段/);
});

test('review：字符串里的 password=xxx 命中明文凭据', () => {
  const model = baseModel();
  const r = reviewFlow(model, {
    knownTypes: KNOWN,
    nodeProps: { T00001: { note: 'password=abc123' } },
  });
  assert.ok(find(r, 'SECRET_LITERAL'));
  assert.equal(find(r, 'SECRET_LITERAL')!.severity, 'blocker');
});

test('review：数组与嵌套对象里的凭据也能被发现', () => {
  const model = baseModel();
  const r = reviewFlow(model, {
    knownTypes: KNOWN,
    nodeProps: { T00001: { list: ['token=abcdef'], cfg: { clientSecret: 'abc' } } },
  });
  assert.ok(find(r, 'SECRET_LITERAL'), '数组里的 token=...');
  assert.ok(find(r, 'SECRET_FIELD'), '嵌套对象里的 clientSecret');
});

test('review：占位符与掩码不算明文凭据', () => {
  const model = baseModel();
  const r = reviewFlow(model, {
    knownTypes: KNOWN,
    nodeProps: { T00001: { password: '${$.secret}', token: '***', note: '****' } },
  });
  assert.equal(find(r, 'SECRET_FIELD'), undefined);
  assert.equal(find(r, 'SECRET_LITERAL'), undefined);
});

test('review：属性可以来自 model.props / model.nodeProps / 注入参数', () => {
  const withProps = baseModel();
  (withProps as any).props = { T00001: { apiUrl: 'https://from-model-props.test/x' } };
  const a = reviewFlow(withProps, { knownTypes: KNOWN });
  assert.equal(find(a, 'NO_RETRY')!.severity, 'minor');

  const withNodeProps = baseModel();
  (withNodeProps as any).nodeProps = { T00001: { apiUrl: 'https://from-model-nodeProps.test/x' } };
  const b = reviewFlow(withNodeProps, { knownTypes: KNOWN });
  assert.equal(find(b, 'NO_RETRY')!.severity, 'minor');

  const injected = reviewFlow(baseModel(), {
    knownTypes: KNOWN,
    nodeProps: { T00001: { apiUrl: 'https://injected.test/x' } },
  });
  assert.equal(find(injected, 'NO_RETRY')!.severity, 'minor');
});

test('review：流程名称不规范是 minor', () => {
  const r = reviewFlow(baseModel(), { knownTypes: KNOWN, processName: 'ab' });
  assert.equal(find(r, 'NAME')!.severity, 'minor');
  const okName = reviewFlow(baseModel(), { knownTypes: KNOWN, processName: '同步流程A' });
  assert.equal(find(okName, 'NAME'), undefined);
});

test('review：存在外部调用但无显式错误分支是 info', () => {
  const r = reviewFlow(baseModel(), { knownTypes: KNOWN });
  assert.equal(find(r, 'NO_ERROR_BRANCH')!.severity, 'info');
  assert.match(find(r, 'NO_ERROR_BRANCH')!.message, /1 个外部调用节点/);

  const model = baseModel();
  model.linkDataArray[1].label = 'fail branch';
  const withBranch = reviewFlow(model, { knownTypes: KNOWN });
  assert.equal(find(withBranch, 'NO_ERROR_BRANCH'), undefined);
});

test('review：空模型与非数组节点数组都能安全处理', () => {
  const empty = reviewFlow(null, { knownTypes: KNOWN });
  assert.ok(find(empty, 'VALIDATE_SHAPE'));
  assert.ok(find(empty, 'START_COUNT'));
  assert.ok(find(empty, 'END_MISSING'));

  const weird = reviewFlow({ nodeDataArray: 'oops', linkDataArray: 'oops' }, { knownTypes: KNOWN });
  assert.ok(find(weird, 'START_COUNT'));
});

test('review：评审结果统计与 ok 判定', () => {
  const r = reviewFlow(baseModel(), { knownTypes: KNOWN });
  assert.equal(r.target, 'flow');
  const total = r.summary.blocker + r.summary.major + r.summary.minor + r.summary.info;
  assert.equal(total, r.findings.length);
  assert.equal(r.ok, r.summary.blocker === 0 && r.summary.major === 0);
});

test('reviewApiBundle：空输入是 major', () => {
  const r = reviewApiBundle([]);
  assert.equal(find(r, 'API_EMPTY')!.severity, 'major');
  assert.equal(r.target, 'api');

  const none = reviewApiBundle({});
  assert.ok(find(none, 'API_EMPTY'));
});

test('reviewApiBundle：缺路径/名称/方法分别报告', () => {
  const r = reviewApiBundle([{ id: 's1' }]);
  assert.equal(find(r, 'API_NO_PATH')!.severity, 'major');
  assert.equal(find(r, 'API_NO_NAME')!.severity, 'minor');
  assert.equal(find(r, 'API_NO_METHOD')!.severity, 'major');
  assert.equal(r.ok, false);
});

test('reviewApiBundle：重复路由是 blocker', () => {
  const r = reviewApiBundle([
    { id: 's1', mapUrl: '/a/b', methodType: 'GET', configName: 'A' },
    { id: 's2', mapUrl: '/a/b', methodType: 'GET', configName: 'B' },
  ]);
  const f = find(r, 'API_DUP');
  assert.ok(f);
  assert.equal(f!.severity, 'blocker');
  assert.match(f!.message, /GET \/a\/b/);
  assert.equal(r.ok, false);
});

test('reviewApiBundle：路径参数未声明是 minor', () => {
  const r = reviewApiBundle([{ id: 's1', mapUrl: '/user/{id}', methodType: 'GET', configName: 'A' }]);
  assert.equal(find(r, 'API_PATH_PARAM')!.severity, 'minor');
  assert.match(find(r, 'API_PATH_PARAM')!.message, /\{id\}/);

  const declared = reviewApiBundle([
    { id: 's1', mapUrl: '/user/{id}', methodType: 'GET', configName: 'A', inParams: [{ name: 'id' }] },
  ]);
  assert.equal(find(declared, 'API_PATH_PARAM'), undefined);
});

test('reviewApiBundle：路径含重复斜杠是 minor', () => {
  const r = reviewApiBundle([{ id: 's1', mapUrl: '/a//b', methodType: 'GET', configName: 'A' }]);
  assert.equal(find(r, 'API_PATH_SLASH')!.severity, 'minor');
});

test('reviewApiBundle：生产环境未配置认证是 major', () => {
  const r = reviewApiBundle(
    [{ id: 's1', mapUrl: '/a', methodType: 'GET', configName: 'A', authType: '0' }],
    { production: true },
  );
  assert.equal(find(r, 'API_NO_AUTH')!.severity, 'major');

  const dev = reviewApiBundle([{ id: 's1', mapUrl: '/a', methodType: 'GET', configName: 'A', authType: '0' }]);
  assert.equal(find(dev, 'API_NO_AUTH'), undefined);
});

test('reviewApiBundle：配置里含明文凭据是 blocker', () => {
  const r = reviewApiBundle([
    { id: 's1', mapUrl: '/login', methodType: 'POST', configName: '登录', description: 'password=abc123' },
  ]);
  assert.equal(find(r, 'API_SECRET')!.severity, 'blocker');
  assert.equal(r.ok, false);
});

test('reviewApiBundle：多种输入形态都能解析', () => {
  const item = { id: 's1', mapUrl: '/a', methodType: 'get', configName: 'A' };
  assert.equal(find(reviewApiBundle([item]), 'API_NO_METHOD'), undefined);
  assert.equal(find(reviewApiBundle({ services: [item] }), 'API_NO_METHOD'), undefined);
  assert.equal(find(reviewApiBundle({ rows: [item] }), 'API_NO_METHOD'), undefined);
  assert.equal(find(reviewApiBundle({ data: { rows: [item] } }), 'API_NO_METHOD'), undefined);
  assert.equal(find(reviewApiBundle({ data: { services: [item] } }), 'API_NO_METHOD'), undefined);
  assert.equal(find(reviewApiBundle({ data: [item] }), 'API_NO_METHOD'), undefined);
});

test('review：formatReview 输出可读报告', () => {
  const r = reviewFlow(baseModel(), { knownTypes: KNOWN });
  const text = formatReview(r);
  assert.ok(text.includes('评审对象：flow'));
  assert.ok(text.includes('汇总：blocker='));
  assert.ok(text.includes('[minor]'));
});

test('review：平台开关字段（addIdentitytoken）不再被当成明文凭据', () => {
  const model = baseModel();
  const r = reviewFlow(model, {
    knownTypes: KNOWN,
    nodeProps: { T00001: { apiUrl: 'https://api.test/x', addIdentitytoken: '1', connectTimeout: '30000', retryNum: '1' } },
  });
  assert.equal(find(r, 'SECRET_FIELD'), undefined, 'addIdentitytoken 是开关，不是凭据');
  assert.equal(r.summary.blocker, 0, '不该有 blocker');
});

test('review：真的是密钥的值仍然判 blocker', () => {
  const model = baseModel();
  const r = reviewFlow(model, {
    knownTypes: KNOWN,
    nodeProps: { T00001: { password: '<secret>', clientSecret: '<client-secret>' } },
  });
  assert.ok(find(r, 'SECRET_FIELD'));
  assert.equal(find(r, 'SECRET_FIELD')!.severity, 'blocker');
});
