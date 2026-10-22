import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENDPOINTS,
  unwrapRows,
  listApis,
  filterApis,
  listAllApis,
  getApi,
  listApps,
  analyzeOpenApi,
  importOpenApi,
  saveApi,
  deleteApi,
  exportOpenApi,
  exportServiceBundle,
  normalizeBundle,
  diffBundles,
  breakingInBundles,
  diffSpecs,
  breakingChanges,
  impactOfApi,
} from '../../packages/core/src/api.ts';
import { stub, ok, fail } from './helpers.ts';

test('unwrapRows：兼容数组与多种平台分页字段', () => {
  assert.deepEqual(unwrapRows([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(unwrapRows({ rows: [{ id: 2 }] }), [{ id: 2 }]);
  assert.deepEqual(unwrapRows({ data: [{ id: 3 }] }), [{ id: 3 }]);
  assert.deepEqual(unwrapRows({ records: [{ id: 4 }] }), [{ id: 4 }]);
  assert.deepEqual(unwrapRows({ list: [{ id: 5 }] }), [{ id: 5 }]);
  assert.deepEqual(unwrapRows({ items: [{ id: 6 }] }), [{ id: 6 }]);
});

test('unwrapRows：非对象/空结构一律返回空数组', () => {
  assert.deepEqual(unwrapRows(null), []);
  assert.deepEqual(unwrapRows(undefined), []);
  assert.deepEqual(unwrapRows('rows'), []);
  assert.deepEqual(unwrapRows(42), []);
  assert.deepEqual(unwrapRows({}), []);
  assert.deepEqual(unwrapRows({ rows: 'not-an-array' }), []);
  assert.deepEqual(unwrapRows({ data: { nested: true } }), []);
});

test('listApis：GET /rest/core/services 并透传分页/关键词参数（平台认 pageNo/pageSize）', async () => {
  const { client, calls } = stub(() => ok({ rows: [] }));
  await listApis(client, { appId: 'app-1', keyword: 'order', pageNo: 2, pageSize: 20 });
  assert.equal(calls[0].path, ENDPOINTS.apiList);
  assert.equal(calls[0].path, '/rest/core/services');
  assert.equal(calls[0].opts.method, 'GET');
  assert.deepEqual(calls[0].opts.query, { appId: 'app-1', keyword: 'order', pageNo: 2, pageSize: 20 });
});

test('filterApis：appId 精确匹配、keyword 模糊匹配（平台自己的 appId/keyword 参数无效）', () => {
  const rows = [
    { id: '1', configName: '流水线B', configId: 'A1', mapUrl: '/a', methodType: 'GET', appId: 'app-b' },
    { id: '2', configName: '库存同步', configId: 'B2', mapUrl: '/b', methodType: 'POST', appId: 'app-c' },
    { id: '3', configName: '流水线C', configId: 'C3', mapUrl: '/c', methodType: 'GET', appId: 'app-b' },
  ];
  assert.deepEqual(filterApis(rows, { appId: 'app-b' }).map((x: any) => x.id), ['1', '3']);
  assert.deepEqual(filterApis(rows, { keyword: '流水线' }).map((x: any) => x.id), ['1', '3']);
  assert.deepEqual(filterApis(rows, { keyword: '/b' }).map((x: any) => x.id), ['2']);
  assert.deepEqual(filterApis(rows, { appId: 'app-b', keyword: '流水线C' }).map((x: any) => x.id), ['3']);
});

test('listAllApis：翻页拉全量 + 客户端过滤（平台自己的 appId/keyword 参数无效）', async () => {
  let page = 0;
  const { client, calls } = stub(() => {
    page++;
    // 平台每页返回满页，最后一页不满
    if (page === 1) {
      return ok({ total: 40, rows: Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, configName: `x${i}`, appId: i < 2 ? 'app-b' : 'app-c' })) });
    }
    return ok({ total: 40, rows: Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, configName: `z${i}`, appId: i < 1 ? 'app-b' : 'app-c' })) });
  });
  const res = await listAllApis(client, { appId: 'app-b', pageSize: 20 });
  assert.equal(res.matched, 3);
  assert.deepEqual(res.rows.map((x: any) => x.id), ['a0', 'a1', 'b0']);
  assert.equal(res.total, 40);
  assert.equal(calls.length, 2);
});

test('listApis：不传过滤条件时 query 全部为 undefined', async () => {
  const { client, calls } = stub(() => ok({ rows: [] }));
  await listApis(client);
  assert.deepEqual(calls[0].opts.query, { appId: undefined, keyword: undefined, pageNo: undefined, pageSize: undefined });
});

test('getApi：按 id 请求服务详情', async () => {
  const { client, calls } = stub(() => ok({ id: 'api-1' }));
  const r = await getApi(client, 'api-1');
  assert.equal(calls[0].path, '/rest/core/services/api-1');
  assert.equal(calls[0].opts.method, 'GET');
  assert.equal((r.data as any).id, 'api-1');
});

test('listApps：请求 /rest/core/apps', async () => {
  const { client, calls } = stub(() => ok({ data: [{ id: 'app-1' }] }));
  await listApps(client);
  assert.equal(calls[0].path, '/rest/core/apps');
  assert.equal(calls[0].opts.method, 'GET');
});

test('analyzeOpenApi：分析成功返回待导入条目数组', async () => {
  const { client, calls } = stub(() => ok({ data: [{ mapUrl: '/a', methodType: 'GET' }] }));
  const items = await analyzeOpenApi(client, 'app-1', '{"openapi":"3.0.0"}');
  assert.equal(calls[0].path, '/rest/core/v2/openapi/analysis?appId=app-1');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.body, '{"openapi":"3.0.0"}');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json;charset=UTF-8');
  assert.equal(calls[0].opts.dryRun, false);
  assert.deepEqual(items, [{ mapUrl: '/a', methodType: 'GET' }]);
});

test('analyzeOpenApi：兼容裸数组与 rows 包装形态', async () => {
  const { client } = stub(() => ok([{ mapUrl: '/a' }]));
  assert.deepEqual(await analyzeOpenApi(client, 'app-1', '{}'), [{ mapUrl: '/a' }]);

  const { client: c2 } = stub(() => ok({ rows: [{ mapUrl: '/b' }] }));
  assert.deepEqual(await analyzeOpenApi(c2, 'app-1', '{}'), [{ mapUrl: '/b' }]);
});

test('analyzeOpenApi：分析失败抛出带 traceId 的错误', async () => {
  const { client } = stub(() => ({ ...fail('分析炸了', 500), traceId: 'tr-9' }));
  await assert.rejects(() => analyzeOpenApi(client, 'app-1', '{}'), /OpenAPI 分析失败：分析炸了（traceId=tr-9）/);
});

test('analyzeOpenApi：失败且无 msg 时回落到 HTTP 状态码', async () => {
  const { client } = stub(() => ({ ok: false, httpStatus: 502, data: {}, request: { method: 'POST', url: '/x' } }));
  await assert.rejects(() => analyzeOpenApi(client, 'app-1', '{}'), /OpenAPI 分析失败：502（traceId=-）/);
});

test('analyzeOpenApi：返回结构异常时抛出明确错误', async () => {
  const { client } = stub(() => ok({ data: { unexpected: 1 } }));
  await assert.rejects(() => analyzeOpenApi(client, 'app-1', '{}'), /OpenAPI 分析返回结构异常/);
});

test('importOpenApi：缺少 appId 直接报错', async () => {
  const { client, calls } = stub(() => ok({ data: [] }));
  await assert.rejects(() => importOpenApi(client, '', '{}'), /缺少 appId/);
  assert.equal(calls.length, 0);
});

test('importOpenApi：默认补齐 categoryId/authType 后落库', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('/openapi/analysis')) return ok({ data: [{ mapUrl: '/a', methodType: 'GET', configName: 'A' }] });
    return ok({ state: true });
  });
  const r = await importOpenApi(client, 'app-1', '{}');
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, '/rest/core/v2/openapi/import');
  assert.equal(calls[1].opts.method, 'POST');
  const payload = JSON.parse(calls[1].opts.body as string);
  assert.deepEqual(payload, [
    {
      mapUrl: '/a',
      methodType: 'GET',
      configName: 'A',
      categoryId: 'app-1.ServiceCategory',
      authType: 1,
      authTypeStr: '1',
      approveAuthType: 1,
      approveAuthTypeStr: '1',
    },
  ]);
});

test('importOpenApi：可覆盖 categoryId/authType/approveAuthType', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('/openapi/analysis')) return ok({ data: [{ mapUrl: '/a' }] });
    return ok({});
  });
  await importOpenApi(client, 'app-1', '{}', { categoryId: 'cat-9', authType: 2, approveAuthType: 3 });
  const payload = JSON.parse(calls[1].opts.body as string);
  assert.equal(payload[0].categoryId, 'cat-9');
  assert.equal(payload[0].authType, 2);
  assert.equal(payload[0].authTypeStr, '2');
  assert.equal(payload[0].approveAuthType, 3);
  assert.equal(payload[0].approveAuthTypeStr, '3');
});

test('importOpenApi：未给 approveAuthType 时跟随 authType', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('/openapi/analysis')) return ok({ data: [{ mapUrl: '/a' }] });
    return ok({});
  });
  await importOpenApi(client, 'app-1', '{}', { authType: 7 });
  const payload = JSON.parse(calls[1].opts.body as string);
  assert.equal(payload[0].approveAuthType, 7);
  assert.equal(payload[0].approveAuthTypeStr, '7');
});

test('importOpenApi：dryRun 透传到导入请求', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('/openapi/analysis')) return ok({ data: [{ mapUrl: '/a' }] });
    return ok({});
  });
  await importOpenApi(client, 'app-1', '{}', { dryRun: true });
  assert.equal(calls[1].opts.dryRun, true);

  // 不传 dryRun 时默认 dry-run：不能因为 profile 不同，同一个调用在 uat 是预览、在 prod 却真写
  await importOpenApi(client, 'app-1', '{}');
  assert.equal(calls[3].opts.dryRun, true);
});

test('saveApi：默认 dry-run，可显式关闭', async () => {
  const { client, calls } = stub(() => ok({}));
  await saveApi(client, { servicePath: '/a' });
  assert.equal(calls[0].path, '/rest/core/services/save');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(calls[0].opts.body, { servicePath: '/a' });
  assert.equal(calls[0].opts.dryRun, true);

  await saveApi(client, { servicePath: '/b' }, { dryRun: false });
  assert.equal(calls[1].opts.dryRun, false);
});

test('deleteApi：字符串与数组都转成逗号分隔的 ids', async () => {
  const { client, calls } = stub(() => ok({}));
  await deleteApi(client, 'api-1');
  assert.equal(calls[0].path, '/rest/core/services/delete');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(calls[0].opts.body, { ids: 'api-1' });
  assert.equal(calls[0].opts.dryRun, false);

  await deleteApi(client, ['a', 'b']);
  assert.deepEqual(calls[1].opts.body, { ids: 'a,b' });
});

test('deleteApi：ids 为空数组时报错', async () => {
  const { client, calls } = stub(() => ok({}));
  await assert.rejects(() => deleteApi(client, []), /缺少 ids/);
  assert.equal(calls.length, 0);
});

test('exportOpenApi / exportServiceBundle：导出端点与查询参数', async () => {
  const { client, calls } = stub(() => ok({}));
  await exportOpenApi(client, 'svc-1');
  assert.equal(calls[0].path, '/rest/apiportal/openapi/v3/export');
  assert.equal(calls[0].opts.method, 'GET');
  assert.deepEqual(calls[0].opts.query, { serviceId: 'svc-1' });

  await exportServiceBundle(client, 'app-1');
  assert.equal(calls[1].path, '/rest/core/services/export');
  assert.deepEqual(calls[1].opts.query, { appId: 'app-1' });
});

test('normalizeBundle：OpenAPI paths 文档归一化为 METHOD PATH 键', () => {
  const m = normalizeBundle({
    paths: {
      '/a': { get: { summary: '查询A' }, post: { summary: '创建A' } },
      '/b': { get: {} },
    },
  });
  assert.deepEqual([...m.keys()], ['GET /a', 'POST /a', 'GET /b']);
  assert.equal(m.get('GET /a')?.name, '查询A');
  assert.equal(m.get('POST /a')?.method, 'POST');
  assert.equal(m.get('GET /b')?.name, '');
});

test('normalizeBundle：OpenAPI 文档节点缺失时容错', () => {
  const m = normalizeBundle({ paths: { '/a': null, '/b': { get: undefined } } });
  assert.deepEqual([...m.keys()], ['GET /b']);
  assert.equal(m.get('GET /b')?.name, '');
});

test('normalizeBundle：扁平服务数组取 mapUrl/methodType/configName/configId', () => {
  const m = normalizeBundle([
    { mapUrl: '/a', methodType: 'get', configName: '查询A', configId: 'c1', version: 'v1', state: 'ON' },
  ]);
  const e = m.get('GET /a');
  assert.deepEqual(e, {
    key: 'GET /a',
    path: '/a',
    method: 'GET',
    name: '查询A',
    configId: 'c1',
    version: 'v1',
    state: 'ON',
  });
});

test('normalizeBundle：兼容 servicePath/method/serviceName/serviceId 字段', () => {
  const m = normalizeBundle([{ servicePath: '/b', method: 'post', serviceName: '服务B', serviceId: 'c2' }]);
  assert.equal(m.get('POST /b')?.name, '服务B');
  assert.equal(m.get('POST /b')?.configId, 'c2');
});

test('normalizeBundle：path/url 与 name 字段回退', () => {
  const m = normalizeBundle([{ path: '/c', methodType: 'PUT', name: '名称C' }]);
  assert.equal(m.get('PUT /c')?.path, '/c');
  assert.equal(m.get('PUT /c')?.name, '名称C');

  const m2 = normalizeBundle([{ url: '/d', methodType: 'DELETE' }]);
  assert.equal(m2.get('DELETE /d')?.path, '/d');
  assert.equal(m2.get('DELETE /d')?.name, '');
});

test('normalizeBundle：{ 服务名: 服务对象 } 包装形态取别名', () => {
  const m = normalizeBundle([{ '订单服务': { mapUrl: '/e', methodType: 'GET' } }]);
  const e = m.get('GET /e');
  assert.equal(e?.name, '订单服务');
  assert.equal(e?.path, '/e');
});

test('normalizeBundle：包装对象里多于一个子对象时不猜别名', () => {
  const m = normalizeBundle([{ A: { mapUrl: '/f', methodType: 'GET' }, B: { mapUrl: '/g', methodType: 'GET' } }]);
  assert.deepEqual([...m.keys()], []);
});

test('normalizeBundle：包装对象里忽略空值子项', () => {
  const m = normalizeBundle([{ A: null, B: { mapUrl: '/j', methodType: 'GET' } }]);
  assert.equal(m.get('GET /j')?.name, 'B');
});

test('normalizeBundle：带 id 的条目不做别名包装', () => {
  const m = normalizeBundle([{ id: 'row-1', mapUrl: '/i', methodType: 'GET' }]);
  assert.equal(m.get('GET /i')?.path, '/i');
  assert.equal(m.get('GET /i')?.name, '');
});

test('normalizeBundle：无路径条目被跳过，同路由重复取首次', () => {
  const m = normalizeBundle([
    { configName: '无路由' },
    null,
    { mapUrl: '/h', methodType: 'GET', configName: '第一次' },
    { mapUrl: '/h', methodType: 'GET', configName: '第二次' },
  ]);
  assert.deepEqual([...m.keys()], ['GET /h']);
  assert.equal(m.get('GET /h')?.name, '第一次');
});

test('diffBundles：计算新增/删除/变更路由', () => {
  const base = [
    { mapUrl: '/keep', methodType: 'GET', configName: '保持' },
    { mapUrl: '/gone', methodType: 'GET', configName: '删除' },
    { mapUrl: '/chg', methodType: 'GET', configName: '旧名', version: 'v1', state: 'ON', configId: 'c1' },
  ];
  const cur = [
    { mapUrl: '/keep', methodType: 'GET', configName: '保持' },
    { mapUrl: '/new', methodType: 'GET', configName: '新增' },
    { mapUrl: '/chg', methodType: 'GET', configName: '新名', version: 'v2', state: 'ON', configId: 'c1' },
  ];
  const d = diffBundles(base, cur);
  assert.deepEqual(d.added, ['GET /new']);
  assert.deepEqual(d.removed, ['GET /gone']);
  assert.deepEqual(d.changed, ['GET /chg']);
});

test('diffBundles：完全一致时无差异', () => {
  const base = [{ mapUrl: '/a', methodType: 'GET', configName: 'A' }];
  assert.deepEqual(diffBundles(base, base), { added: [], removed: [], changed: [] });
});

test('diffBundles：version / state / configId 变化都算变更', () => {
  const base = [
    { mapUrl: '/v', methodType: 'GET', configName: '同名', version: 'v1', state: 'ON', configId: 'c1' },
  ];
  const versionOnly = [{ mapUrl: '/v', methodType: 'GET', configName: '同名', version: 'v2', state: 'ON', configId: 'c1' }];
  assert.deepEqual(diffBundles(base, versionOnly).changed, ['GET /v']);

  const stateOnly = [{ mapUrl: '/v', methodType: 'GET', configName: '同名', version: 'v1', state: 'OFF', configId: 'c1' }];
  assert.deepEqual(diffBundles(base, stateOnly).changed, ['GET /v']);

  const configOnly = [{ mapUrl: '/v', methodType: 'GET', configName: '同名', version: 'v1', state: 'ON', configId: 'c2' }];
  assert.deepEqual(diffBundles(base, configOnly).changed, ['GET /v']);
});

test('breakingInBundles：识别方法变更与路由删除', () => {
  const base = [
    { mapUrl: '/m', methodType: 'GET', configName: '方法变更' },
    { mapUrl: '/d', methodType: 'GET', configName: '被删' },
  ];
  const cur = [{ mapUrl: '/m', methodType: 'POST', configName: '方法变更' }];
  const out = breakingInBundles(base, cur);
  assert.deepEqual(out, ['方法变更 GET /m → POST /m', '删除路由 GET /d（被删）']);
});

test('diffSpecs：paths 级新增/删除/结构变更', () => {
  const base = { paths: { '/a': { get: { summary: 'A' } }, '/b': { get: {} } } };
  const cur = { paths: { '/a': { get: { summary: 'A2' } }, '/c': { get: {} } } };
  const d = diffSpecs(base, cur);
  assert.deepEqual(d.added, ['/c']);
  assert.deepEqual(d.removed, ['/b']);
  assert.deepEqual(d.changed, ['/a']);
});

test('diffSpecs：缺省 paths 视为空对象', () => {
  assert.deepEqual(diffSpecs({}, {}), { added: [], removed: [], changed: [] });
  assert.deepEqual(diffSpecs(undefined, { paths: { '/x': {} } }).added, ['/x']);
});

test('breakingChanges：删除路径/删除方法/请求体结构变更', () => {
  const base = {
    paths: {
      '/gone': { get: {} },
      '/method': { get: {}, post: {} },
      '/body': {
        post: { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
  };
  const cur = {
    paths: {
      '/method': { get: {} },
      '/body': {
        post: { requestBody: { content: { 'application/json': { schema: { type: 'string' } } } } },
      },
    },
  };
  const out = breakingChanges(base, cur);
  assert.deepEqual(out, [
    '删除路径 /gone',
    '删除方法 POST /method',
    '请求体结构变更 POST /body',
  ]);
});

test('breakingChanges：无破坏性变更时返回空数组', () => {
  const spec = { paths: { '/a': { get: { summary: 'x' } } } };
  assert.deepEqual(breakingChanges(spec, spec), []);
  assert.deepEqual(breakingChanges({}, {}), []);
});

test('breakingChanges：路径节点为空或请求体被移除时不误报', () => {
  const emptyNode = { paths: { '/x': null } };
  assert.deepEqual(breakingChanges(emptyNode, { paths: { '/x': {} } }), []);

  const base = {
    paths: {
      '/b': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } },
    },
  };
  const cur = { paths: { '/b': { post: { summary: '无请求体' } } } };
  assert.deepEqual(breakingChanges(base, cur), []);
});

test('impactOfApi：扫描 ESB 流程并统计 apiId 命中次数', async () => {
  const { client, calls } = stub((path) => {
    if (path === '/rest/esb/process/list') {
      return ok({ data: [{ processId: 'p1', processName: '流程一' }, { id: 'p2' }, { processId: 'p3' }] });
    }
    if (path === '/rest/esb/process/p1') {
      return ok({ data: { processModel: { nodes: [{ apiId: 'api-1' }, { apiId: 'api-1' }] } } });
    }
    if (path === '/rest/esb/process/p2') return ok({ data: { nothing: true } });
    return ok({ data: {} });
  });
  const hits = await impactOfApi(client, 'api-1');
  assert.equal(calls[0].path, '/rest/esb/process/list');
  assert.deepEqual(hits, [{ processId: 'p1', processName: '流程一', hits: 2 }]);
});

test('impactOfApi：支持 ETL 流程与 maxProcesses 截断', async () => {
  const { client, calls } = stub((path) => {
    if (path === '/rest/etl/process/list') return ok([{ processId: 'e1', name: 'ETL流程' }, { processId: 'e2' }]);
    if (path === '/rest/etl/process/e1') return ok({ data: { model: 'api-1 api-1 api-1' } });
    return ok({});
  });
  const hits = await impactOfApi(client, 'api-1', { kind: 'etl', maxProcesses: 1 });
  assert.equal(calls[0].path, '/rest/etl/process/list');
  assert.equal(calls[1].path, '/rest/etl/process/e1');
  assert.deepEqual(hits, [{ processId: 'e1', processName: 'ETL流程', hits: 3 }]);
});

test('impactOfApi：列表为 rows 包装且无 id 的行被跳过', async () => {
  const { client, calls } = stub((path) => {
    if (path === '/rest/esb/process/list') return ok({ rows: [{ processName: '无 id' }, { processId: 'p9' }] });
    if (path === '/rest/esb/process/p9') return ok({ data: { x: 'api-1' } });
    return ok({});
  });
  const hits = await impactOfApi(client, 'api-1');
  assert.equal(calls.length, 2);
  assert.deepEqual(hits, [{ processId: 'p9', processName: undefined, hits: 1 }]);
});

test('impactOfApi：列表结构异常时返回空命中，详情无 data 时不误判', async () => {
  const { client, calls } = stub((path) => {
    if (path === '/rest/esb/process/list') return ok({ unexpected: true });
    return ok({});
  });
  const hits = await impactOfApi(client, 'api-1');
  assert.deepEqual(hits, []);
  assert.equal(calls.length, 1);
});
