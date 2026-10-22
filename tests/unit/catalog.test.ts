/**
 * catalog：接口目录与组件目录的加载、检索、必填规则
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, hasUsableDefault } from '../../packages/core/src/catalog.ts';

const cat = new Catalog();

test('catalog：接口目录加载', () => {
  const eps = cat.endpointsCatalog();
  assert.ok(Array.isArray(eps));
  assert.ok(eps.length > 100);
  assert.ok(eps.every((e) => typeof e.path === 'string' && typeof e.module === 'string' && typeof e.name === 'string'));
  assert.equal(cat.endpointsCatalog(), eps, '目录应被缓存');
});

test('catalog：searchEndpoints 按路径/名称/模块检索', () => {
  const byPath = cat.searchEndpoints('/rest/core/services');
  assert.ok(byPath.length > 0);
  assert.ok(byPath.some((e) => e.path === '/rest/core/services'));

  const byName = cat.searchEndpoints('adminIndexUrl');
  assert.ok(byName.length > 0);
  assert.ok(byName.some((e) => e.name === 'adminIndexUrl'));

  const byModule = cat.searchEndpoints('LIST_CORE_SERVICES');
  assert.ok(byModule.length > 0);
  assert.ok(byModule.every((e) => e.module === 'LIST_CORE_SERVICES'));
});

test('catalog：searchEndpoints 支持 module 过滤与 limit', () => {
  const filtered = cat.searchEndpoints('list', { module: 'LIST_CORE_SERVICES' });
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((e) => e.module === 'LIST_CORE_SERVICES'));

  const limited = cat.searchEndpoints('/', { limit: 2 });
  assert.equal(limited.length, 2);
});

test('catalog：searchEndpoints 按 path 去重且无命中返回空数组', () => {
  const dup = cat.searchEndpoints('/rest/core/auth/login');
  const paths = dup.map((e) => e.path);
  assert.equal(new Set(paths).size, paths.length, '相同 path 只保留一条');

  assert.deepEqual(cat.searchEndpoints('__不存在的关键字__'), []);
});

test('catalog：component 查单个组件', () => {
  const api = cat.component('apiNode');
  assert.ok(api);
  assert.equal(api!.id, 'apiNode');
  assert.equal(api!.label, 'Restful API');
  assert.ok(Array.isArray(api!.params));
  assert.equal(cat.component('__不存在__'), undefined);
});

test('catalog：nodeTypes 返回 ESB nodeType 白名单', () => {
  const types = cat.nodeTypes();
  assert.ok(types instanceof Set);
  for (const t of ['start', 'end', 'apiNode', 'gateWay', 'sqlExecuterNode']) {
    assert.ok(types.has(t), `缺少 ${t}`);
  }
});

test('catalog：ETL 组件目录与白名单', () => {
  const etl = cat.etlComponentCatalog();
  assert.ok(etl.nodes.length > 0);
  const types = cat.etlNodeTypes();
  assert.ok(types.has('sqlReadNode'));
  assert.ok(types.has('jdbcWriteNode'));
  assert.equal(cat.hasEtlCatalog(), true);
});

test('catalog：etlComponentsByCategory 按分类过滤', () => {
  const all = cat.etlComponentsByCategory();
  assert.equal(all.length, cat.etlComponentCatalog().nodes.length);
  const one = cat.etlComponentsByCategory('数据输入组件');
  assert.ok(one.length > 0);
  assert.ok(one.every((n) => n.category === '数据输入组件'));
  assert.deepEqual(cat.etlComponentsByCategory('__没有这个分类__'), []);
});

test('catalog：componentsByCategory 按分类过滤', () => {
  const all = cat.componentsByCategory();
  assert.equal(all.length, cat.componentCatalog().nodes.length);
  const one = cat.componentsByCategory('流程基本组件');
  assert.ok(one.length > 0);
  assert.ok(one.every((n) => n.category === '流程基本组件'));
  assert.deepEqual(cat.componentsByCategory('__没有这个分类__'), []);
});

test('catalog：hasUsableDefault 判定默认值是否可用', () => {
  assert.equal(hasUsableDefault(null), false);
  assert.equal(hasUsableDefault(undefined), false);
  assert.equal(hasUsableDefault(''), false);
  assert.equal(hasUsableDefault('   '), false);
  assert.equal(hasUsableDefault('${config.apiserver}'), false);
  assert.equal(hasUsableDefault('this.nodeObj.text'), false);
  assert.equal(hasUsableDefault('formData.x'), false);
  assert.equal(hasUsableDefault('props.a'), false);
  assert.equal(hasUsableDefault('node.a'), false);
  assert.equal(hasUsableDefault('state.a'), false);
  assert.equal(hasUsableDefault('config.a'), false);
  assert.equal(hasUsableDefault('formData.x || "30"'), true);
  assert.equal(hasUsableDefault('30000'), true);
  assert.equal(hasUsableDefault("'GET'"), true);
});

test('catalog：requiredFields(esb) 汇总组件必填 + 启发式规则', () => {
  const req = cat.requiredFields('esb');
  assert.deepEqual(req.apiNode, ['apiUrl']);
  assert.deepEqual(req.sqlExecuterNode, ['dbConnId', 'sqlCode']);
  assert.deepEqual(req.jdbcWriteNode, ['dbConnId', 'tableName']);
  assert.deepEqual(req.tableReadNode, ['dbConnId', 'tableName']);
  assert.deepEqual(req.dataSplitNode, ['dataFieldId']);
  assert.deepEqual(req.gateWay, ['gatewayType']);
  // 元字段（pNodeId/pNodeName/...）不算用户必填
  const api = cat.component('apiNode')!;
  const apiKeys = api.params.filter((p) => p.required).map((p) => p.key);
  assert.ok(apiKeys.includes('pNodeName'));
  assert.ok(!req.apiNode!.includes('pNodeName'));
});

test('catalog：requiredFields(etl) 只套用启发式规则', () => {
  const req = cat.requiredFields('etl');
  assert.deepEqual(req.sqlExecuterNode, ['dbConnId', 'sqlCode']);
  assert.deepEqual(req.gateWay, ['gatewayType']);
  assert.equal(req.apiNode, undefined, 'ETL 目录未采集参数，不应有组件必填项');
});
