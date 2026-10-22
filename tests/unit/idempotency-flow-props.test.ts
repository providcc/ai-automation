/**
 * idempotency 与 flow-props 单测：
 *  - 幂等键：method + path + 规范化 body 的稳定哈希
 *  - 节点属性 payload 组装（平台字符串化规则）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, fingerprint, idempotencyKey } from '../../packages/core/src/idempotency.ts';
import { buildNodeProps, buildSubProcessProps, assertNodeProps } from '../../packages/core/src/flow-props.ts';

// ---------------- idempotency ----------------

test('canonicalize：原始值按类型归一', () => {
  assert.equal(canonicalize(null), 'null');
  assert.equal(canonicalize(undefined), 'undefined');
  assert.equal(canonicalize(undefined), 'undefined');
  assert.equal(canonicalize(42), '42');
  assert.equal(canonicalize(true), 'true');
  assert.equal(canonicalize(false), 'false');
  assert.equal(canonicalize('x'), '"x"');
});

test('canonicalize：数组保持顺序，元素递归归一', () => {
  assert.equal(canonicalize([]), '[]');
  assert.equal(canonicalize([1, 'a', null, true]), '[1,"a",null,true]');
  assert.equal(canonicalize([[1], { a: 2 }]), '[[1],{"a":2}]');
});

test('canonicalize：对象按键名排序，消除字段顺序差异', () => {
  assert.equal(canonicalize({}), '{}');
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalize({ b: 1, a: 2 }) === canonicalize({ a: 2, b: 1 }), true);
});

test('canonicalize：值为 undefined 的字段被忽略', () => {
  assert.equal(canonicalize({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalize({ a: undefined }), '{}');
});

test('canonicalize：函数等其它类型退化成字符串表示', () => {
  const fn = () => 1;
  assert.equal(canonicalize(fn), JSON.stringify(String(fn)));
  assert.equal(canonicalize(Symbol('s')), JSON.stringify(String(Symbol('s'))));
});

test('fingerprint：同一逻辑请求命中同一个键，方法大小写不敏感', () => {
  const a = fingerprint('post', '/rest/x/save', { a: 1, b: 2 });
  const b = fingerprint('POST', '/rest/x/save', { b: 2, a: 1 });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, fingerprint('get', '/rest/x/save', { a: 1, b: 2 }));
  assert.notEqual(a, fingerprint('post', '/rest/y/save', { a: 1, b: 2 }));
});

test('fingerprint：不带 body 时按 null 处理', () => {
  assert.equal(fingerprint('get', '/rest/x'), fingerprint('get', '/rest/x', null));
  assert.equal(fingerprint('get', '/rest/x', undefined), fingerprint('get', '/rest/x', null));
});

test('idempotencyKey：显式键优先，否则回落到指纹', () => {
  assert.equal(idempotencyKey('post', '/x', { a: 1 }, 'explicit-key'), 'explicit-key');
  assert.equal(idempotencyKey('post', '/x', { a: 1 }), fingerprint('post', '/x', { a: 1 }));
  assert.equal(idempotencyKey('post', '/x'), fingerprint('post', '/x'));
});

// ---------------- flow-props ----------------

test('buildNodeProps：布尔 / 数组 / 嵌套对象按平台规则字符串化', () => {
  const p = buildNodeProps({
    appId: 'esb', processId: 'p1', nodeId: 'T1', nodeType: 'apiNode', nodeName: '接口',
    values: {
      flag: true,
      off: false,
      num: 7,
      text: 'x',
      list: ['a', 'b'],
      objList: [{ a: 1 }, 'b'],
      nested: { a: 1 },
      inParams: [{ name: 'x' }],
      tableColumns: ['c1'],
      nil: null,
      missing: undefined,
    },
  });
  assert.equal(p.flag, '1');
  assert.equal(p.off, '0');
  assert.equal(p.num, 7);
  assert.equal(p.text, 'x');
  assert.equal(p.list, 'a,b');
  assert.equal(p.objList, '{"a":1},b');
  assert.equal(p.nested, '{"a":1}');
  assert.equal(p.inParams, '[{"name":"x"}]');
  assert.equal(p.tableColumns, '["c1"]');
  assert.equal(p.nil, '');
  assert.equal('missing' in p, false);
  assert.equal(p.appId, 'esb');
  assert.equal(p.processId, 'p1');
  assert.equal(p.pNodeId, 'T1');
  assert.equal(p.pNodeType, 'apiNode');
  assert.equal(p.pNodeName, '接口');
});

test('buildNodeProps：base 与 values 合并，values 优先', () => {
  const p = buildNodeProps({
    appId: 'a', processId: 'p', nodeId: 'n', nodeType: 't', nodeName: 'nm',
    base: { keep: 'yes', over: 'old' },
    values: { over: 'new' },
  });
  assert.equal(p.keep, 'yes');
  assert.equal(p.over, 'new');
});

test('buildNodeProps：不传 base / values 时只有元字段', () => {
  const p = buildNodeProps({ appId: 'a', processId: 'p', nodeId: 'n', nodeType: 't', nodeName: 'nm' });
  assert.deepEqual(p, { appId: 'a', processId: 'p', pNodeId: 'n', pNodeType: 't', pNodeName: 'nm' });
});

test('buildNodeProps：base 里的元字段不会被业务值覆盖', () => {
  const p = buildNodeProps({
    appId: 'a', processId: 'p', nodeId: 'n', nodeType: 't', nodeName: 'nm',
    base: { pNodeId: 'x', pNodeType: 'y', pNodeName: 'z' },
    values: { pNodeId: 'x2' },
  });
  assert.equal(p.pNodeId, 'n');
  assert.equal(p.pNodeType, 't');
  assert.equal(p.pNodeName, 'nm');
});

test('assertNodeProps：缺字段与空串都算缺失', () => {
  assert.deepEqual(
    assertNodeProps({ appId: 'a', processId: 'p', pNodeId: 'n', pNodeType: 't', pNodeName: 'x' }),
    [],
  );
  assert.deepEqual(
    assertNodeProps({ appId: 'a', processId: 'p', pNodeId: 'n', pNodeType: 't', pNodeName: '' }),
    ['pNodeName'],
  );
  assert.deepEqual(
    assertNodeProps({ appId: '', processId: 'p', pNodeId: 'n', pNodeType: 't', pNodeName: 'x' }),
    ['appId'],
  );
  assert.deepEqual(
    assertNodeProps({} as any),
    ['appId', 'processId', 'pNodeId', 'pNodeType', 'pNodeName'],
  );
});

test('buildSubProcessProps：默认标记与可选字段', () => {
  const p = buildSubProcessProps({
    appId: 'a', processId: 'p', nodeId: 'n', nodeType: 'sub', nodeName: 'nm',
    subProcessId: 'SP_1',
  });
  assert.equal(p.subProcessId, 'SP_1');
  assert.equal(p.inDataFlag, '0');
  assert.equal(p.outDataFlag, '0');
  assert.equal(p.responseData, '1');
  assert.equal('exceptionAssert' in p, false);
  assert.equal('subProcessFailed' in p, false);
  assert.equal('assertAction' in p, false);
});

test('buildSubProcessProps：显式传值时原样带上', () => {
  const p = buildSubProcessProps({
    appId: 'a', processId: 'p', nodeId: 'n', nodeType: 'sub', nodeName: 'nm',
    subProcessId: 'SP_2', inDataFlag: '1', outDataFlag: '1', responseData: '2',
    exceptionAssert: '1', subProcessFailed: '0', assertAction: 'continue',
  });
  assert.equal(p.subProcessId, 'SP_2');
  assert.equal(p.inDataFlag, '1');
  assert.equal(p.outDataFlag, '1');
  assert.equal(p.responseData, '2');
  assert.equal(p.exceptionAssert, '1');
  assert.equal(p.subProcessFailed, '0');
  assert.equal(p.assertAction, 'continue');
});
