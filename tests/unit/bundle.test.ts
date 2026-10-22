import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBundle, diffBundles, breakingInBundles, unwrapRows } from '../../packages/core/src/api.ts';

const bundle = [
  { '获取报告文档': { configId: 'SPAPI_API_1', mapUrl: '/spapi/reports/{id}', methodType: 'GET', configName: '获取报告文档', version: '1.0', state: '1' } },
  { '保存报告文档': { configId: 'SPAPI_API_2', mapUrl: '/spapi/reports', methodType: 'POST', configName: '保存报告文档', version: '1.0', state: '1' } },
];

test('基线归一：路由为身份键，configId 非唯一也能区分', () => {
  const m = normalizeBundle(bundle);
  assert.equal(m.size, 2);
  assert.ok(m.has('GET /spapi/reports/{id}'));
  assert.ok(m.has('POST /spapi/reports'));
  // 同一 configId 不同路由 → 两个条目
  const same = normalizeBundle([
    { a: { configId: 'X', mapUrl: '/a', methodType: 'GET', configName: 'A' } },
    { b: { configId: 'X', mapUrl: '/b', methodType: 'POST', configName: 'B' } },
  ]);
  assert.equal(same.size, 2);
});

test('基线归一：OpenAPI 文档同样支持', () => {
  const m = normalizeBundle({ paths: { '/x': { get: { summary: 'X' } } } });
  assert.equal(m.size, 1);
  assert.ok(m.has('GET /x'));
});

test('diff：删除/新增/变更识别', () => {
  const a = bundle;
  const b = [
    { '获取报告文档': { configId: 'SPAPI_API_1', mapUrl: '/spapi/reports/{id}', methodType: 'GET', configName: '获取报告文档(改)', version: '2.0', state: '1' } },
  ];
  const d = diffBundles(a, b);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, ['POST /spapi/reports']);
  assert.deepEqual(d.changed, ['GET /spapi/reports/{id}']);
});

test('破坏性变更：路由删除与方法变更', () => {
  const a = bundle;
  const b = [
    { '获取报告文档': { configId: 'SPAPI_API_1', mapUrl: '/spapi/reports/{id}', methodType: 'POST', configName: '获取报告文档', version: '1.0', state: '1' } },
  ];
  const br = breakingInBundles(a, b);
  assert.ok(br.some((x) => x.includes('方法变更')));
});

test('unwrapRows 兼容多种分页形态', () => {
  assert.equal(unwrapRows([1, 2]).length, 2);
  assert.equal(unwrapRows({ rows: [1] }).length, 1);
  assert.equal(unwrapRows({ data: [1, 2, 3] }).length, 3);
  assert.equal(unwrapRows(null).length, 0);
});
