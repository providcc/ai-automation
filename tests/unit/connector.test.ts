import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTOR,
  maskConnector,
  listConnectorApps,
  connectorMenus,
  listConnectorConfigs,
  getConnectorConfig,
  saveConnectorConfig,
  deleteConnectorConfig,
  listConnectorDocs,
  getConnectorDoc,
  saveConnectorDoc,
  deleteConnectorDoc,
  exportConnectorConfigs,
  importConnectorConfigs,
} from '../../packages/core/src/connector.ts';
import { stub, ok, fail } from './helpers.ts';

test('maskConnector：敏感字段被替换为 ***', () => {
  const out = maskConnector({
    password: 'p@ss',
    pass: 'p',
    secret: 's',
    clientSecret: 'cs',
    token: 'tk',
    privateKey: 'pk',
    accessKey: 'ak',
    apiKey: 'ak2',
    name: '普通字段',
  }) as Record<string, unknown>;
  assert.equal(out.password, '***');
  assert.equal(out.pass, '***');
  assert.equal(out.secret, '***');
  assert.equal(out.clientSecret, '***');
  assert.equal(out.token, '***');
  assert.equal(out.privateKey, '***');
  assert.equal(out.accessKey, '***');
  assert.equal(out.apiKey, '***');
  assert.equal(out.name, '普通字段');
});

test('maskConnector：递归处理嵌套对象与数组', () => {
  const out = maskConnector({
    auth: { password: 'x', nested: { apiKey: 'y' } },
    list: [{ token: 't' }, { plain: 'ok' }],
  }) as any;
  assert.equal(out.auth.password, '***');
  assert.equal(out.auth.nested.apiKey, '***');
  assert.equal(out.list[0].token, '***');
  assert.equal(out.list[1].plain, 'ok');
});

test('maskConnector：数组/原始值原样处理', () => {
  assert.deepEqual(maskConnector([{ password: 'x' }]), [{ password: '***' }]);
  assert.equal(maskConnector('plain'), 'plain');
  assert.equal(maskConnector(42), 42);
  assert.equal(maskConnector(null), null);
});

test('maskConnector：脱敏结果不含明文密码', () => {
  const raw = { config: { password: '<secret>' } };
  const text = JSON.stringify(maskConnector(raw));
  assert.ok(!text.includes('<secret>'), '脱敏后不应包含明文密码');
});

test('listConnectorApps：返回连接器应用列表', async () => {
  const { client, calls } = stub(() => ok({ data: [{ id: 'w1', configType: 'wechat' }] }));
  const apps = await listConnectorApps(client);
  assert.equal(calls[0].path, '/rest/connector/list');
  assert.equal(calls[0].opts.method, 'GET');
  assert.deepEqual(apps, [{ id: 'w1', configType: 'wechat' }]);
});

test('listConnectorApps：兼容裸数组与 rows 包装', async () => {
  const { client } = stub(() => ok([{ id: 'w2' }]));
  assert.deepEqual(await listConnectorApps(client), [{ id: 'w2' }]);

  const { client: c2 } = stub(() => ok({ rows: [{ id: 'w3' }] }));
  assert.deepEqual(await listConnectorApps(c2), [{ id: 'w3' }]);
});

test('connectorMenus：返回菜单数据', async () => {
  const { client, calls } = stub(() => ok({ data: [{ id: 'm1' }] }));
  const menus = await connectorMenus(client);
  assert.equal(calls[0].path, '/rest/connector/menus');
  assert.deepEqual(menus, [{ id: 'm1' }]);
});

test('connectorMenus：无 data 包装时回落到原数据', async () => {
  const { client } = stub(() => ok({ items: [] }));
  assert.deepEqual(await connectorMenus(client), { items: [] });
});

test('listConnectorConfigs：按 configType 拉取配置列表', async () => {
  const { client, calls } = stub(() => ok({ data: [] }));
  await listConnectorConfigs(client, 'wechat', { pageNo: 1, pageSize: 50, keyword: 'k' });
  assert.equal(calls[0].path, '/rest/connector/config/list');
  assert.equal(calls[0].opts.method, 'GET');
  assert.deepEqual(calls[0].opts.query, { configType: 'wechat', pageNo: 1, pageSize: 50, keyword: 'k' });
});

test('listConnectorConfigs：不传分页参数时 query 为 undefined', async () => {
  const { client, calls } = stub(() => ok({ data: [] }));
  await listConnectorConfigs(client, 'sap');
  assert.deepEqual(calls[0].opts.query, { configType: 'sap', pageNo: undefined, pageSize: undefined, keyword: undefined });
});

test('getConnectorConfig：详情返回脱敏后的配置', async () => {
  const { client, calls } = stub(() => ok({ data: { id: 'c1', password: 'p@ss', name: '微信' } }));
  const r = await getConnectorConfig(client, 'c1');
  assert.equal(calls[0].path, '/rest/connector/config/getById');
  assert.deepEqual(calls[0].opts.query, { id: 'c1' });
  assert.equal(r.ok, true);
  assert.equal((r.data as any).password, '***');
  assert.equal((r.data as any).name, '微信');
  assert.ok(!JSON.stringify(r.data).includes('p@ss'), '脱敏结果不得包含明文密码');
});

test('getConnectorConfig：无 data 包装时直接脱敏原数据', async () => {
  const { client } = stub(() => ok({ id: 'c2', secret: 'abc' }));
  const r = await getConnectorConfig(client, 'c2');
  assert.equal((r.data as any).secret, '***');
  assert.equal((r.data as any).id, 'c2');
});

test('getConnectorConfig：失败时不返回 data', async () => {
  const { client } = stub(() => fail('配置不存在', 404));
  const r = await getConnectorConfig(client, 'missing');
  assert.equal(r.ok, false);
  assert.equal(r.msg, '配置不存在');
  assert.equal(r.data, undefined);
});

test('saveConnectorConfig：默认 dry-run，可显式关闭', async () => {
  const { client, calls } = stub(() => ok({}));
  await saveConnectorConfig(client, { configType: 'wechat', name: 'x' });
  assert.equal(calls[0].path, '/rest/connector/config/save');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(calls[0].opts.body, { configType: 'wechat', name: 'x' });
  assert.equal(calls[0].opts.dryRun, true);

  await saveConnectorConfig(client, { configType: 'wechat' }, { dryRun: false });
  assert.equal(calls[1].opts.dryRun, false);
});

test('deleteConnectorConfig：ids 转逗号分隔，默认 dry-run', async () => {
  const { client, calls } = stub(() => ok({}));
  await deleteConnectorConfig(client, 'c1');
  assert.equal(calls[0].path, '/rest/connector/config/delete');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(calls[0].opts.body, { ids: 'c1' });
  assert.equal(calls[0].opts.dryRun, true);

  await deleteConnectorConfig(client, ['c1', 'c2'], { dryRun: false });
  assert.deepEqual(calls[1].opts.body, { ids: 'c1,c2' });
  assert.equal(calls[1].opts.dryRun, false);
});

test('连接器文档 CRUD：路径与 dry-run 默认值', async () => {
  const { client, calls } = stub(() => ok({}));
  await listConnectorDocs(client, 'wechat', { pageNo: 2, pageSize: 10 });
  assert.equal(calls[0].path, '/rest/connector/doc/list');
  assert.deepEqual(calls[0].opts.query, { configType: 'wechat', pageNo: 2, pageSize: 10 });

  await getConnectorDoc(client, 'd1');
  assert.equal(calls[1].path, '/rest/connector/doc/get');
  assert.deepEqual(calls[1].opts.query, { id: 'd1' });

  await saveConnectorDoc(client, { title: 't' });
  assert.equal(calls[2].path, '/rest/connector/doc/save');
  assert.equal(calls[2].opts.dryRun, true);

  await deleteConnectorDoc(client, ['d1', 'd2']);
  assert.equal(calls[3].path, '/rest/connector/doc/delete');
  assert.deepEqual(calls[3].opts.body, { ids: 'd1,d2' });
  assert.equal(calls[3].opts.dryRun, true);

  await deleteConnectorDoc(client, 'd3', { dryRun: false });
  assert.equal(calls[4].opts.dryRun, false);
});

test('exportConnectorConfigs：逐条拉详情并脱敏导出', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('/config/list')) {
      return ok({ data: [{ id: 'c1', configName: '配置一' }, { configName: '无 id 行' }] });
    }
    if (path.includes('/config/getById')) {
      return ok({ data: { id: 'c1', configName: '配置一', password: 'p@ss' } });
    }
    return ok({});
  });
  const out = await exportConnectorConfigs(client, 'wechat');
  assert.equal(out.configType, 'wechat');
  assert.ok(typeof out.exportedAt === 'string' && out.exportedAt.length > 0);
  assert.equal(out.items.length, 2);
  assert.equal((out.items[0] as any).password, '***');
  assert.equal((out.items[0] as any).configName, '配置一');
  assert.deepEqual(out.items[1], { configName: '无 id 行' });
  assert.ok(!JSON.stringify(out).includes('p@ss'), '导出结果不得包含明文密码');
  assert.ok(calls.some((c) => c.path === '/rest/connector/config/getById'));
});

test('exportConnectorConfigs：详情失败时退化为 id 占位', async () => {
  const { client } = stub((path) => {
    if (path.includes('/config/list')) return ok({ data: [{ id: 'c9' }] });
    return fail('读取失败', 500);
  });
  const out = await exportConnectorConfigs(client, 'wechat', { pageSize: 10 });
  assert.deepEqual(out.items, [{ id: 'c9' }]);
});

test('exportConnectorConfigs：configId 也可作为条目标识', async () => {
  const { client } = stub((path) => {
    if (path.includes('/config/list')) return ok({ data: [{ configId: 'cc1' }] });
    return ok({ data: { configId: 'cc1', name: 'n' } });
  });
  const out = await exportConnectorConfigs(client, 'wechat');
  assert.equal((out.items[0] as any).configId, 'cc1');
});

test('importConnectorConfigs：逐条保存并汇总结果', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('/config/save')) return ok({ state: true });
    return ok({});
  });
  const out = await importConnectorConfigs(client, {
    configType: 'wechat',
    items: [{ name: '一' }, { name: '二', configType: 'dingtalk' }],
  });
  assert.equal(out.total, 2);
  assert.equal(out.ok, true);
  assert.deepEqual(out.results, [
    { index: 0, ok: true, msg: undefined },
    { index: 1, ok: true, msg: undefined },
  ]);
  assert.deepEqual(calls[0].opts.body, { name: '一', configType: 'wechat' });
  assert.deepEqual(calls[1].opts.body, { name: '二', configType: 'dingtalk' });
  assert.equal(calls[0].opts.dryRun, true);
});

test('importConnectorConfigs：单条失败时整体 ok=false，可关闭 dry-run', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('/config/save')) return fail('保存失败', 500);
    return ok({});
  });
  const out = await importConnectorConfigs(client, { configType: 'wechat', items: [{ name: '一' }] }, { dryRun: false });
  assert.equal(out.ok, false);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[0].msg, '保存失败');
  assert.equal(calls[0].opts.dryRun, false);
});

test('importConnectorConfigs：空条目列表直接返回空结果', async () => {
  const { client, calls } = stub(() => ok({}));
  const out = await importConnectorConfigs(client, { configType: 'wechat', items: [] });
  assert.deepEqual(out, { ok: true, total: 0, results: [] });
  assert.equal(calls.length, 0);
});

test('CONNECTOR：端点常量与平台契约一致', () => {
  assert.equal(CONNECTOR.apps, '/rest/connector/list');
  assert.equal(CONNECTOR.configs, '/rest/connector/config/list');
  assert.equal(CONNECTOR.configGet, '/rest/connector/config/getById');
  assert.equal(CONNECTOR.configSave, '/rest/connector/config/save');
  assert.equal(CONNECTOR.configDelete, '/rest/connector/config/delete');
});
