/**
 * 数据源域单测：列表 / 详情（脱敏）/ 连接测试 / 保存。
 * 全部使用桩客户端，不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATASOURCE,
  listDataSources,
  listAllDataSources,
  getDataSource,
  testDataSourceConnection,
  saveDataSource,
  maskDataSource,
} from '../../packages/core/src/datasource.ts';
import { stub, ok, fail } from './helpers.ts';

test('数据源：端点常量符合平台契约', () => {
  assert.equal(DATASOURCE.list, '/rest/core/datasource/list');
  assert.equal(DATASOURCE.listAll, '/rest/core/datasource/listall');
  assert.equal(DATASOURCE.detail('ds-1'), '/rest/core/datasource/ds-1');
  assert.equal(DATASOURCE.save, '/rest/core/datasource/save');
  assert.equal(DATASOURCE.delete, '/rest/core/datasource/delete');
  assert.equal(DATASOURCE.testConnect, '/rest/core/datasource/test/connect');
  assert.equal(DATASOURCE.categoryMenu, '/rest/core/datasource/category/menu');
});

test('数据源列表：默认分页参数（pageNo=1,pageSize=50）', async () => {
  const { client, calls } = stub(() => ok({ rows: [] }));
  const r = await listDataSources(client);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, DATASOURCE.list);
  assert.equal(calls[0].opts.method, 'GET');
  assert.deepEqual(calls[0].opts.query, { pageNo: 1, pageSize: 50, keyword: undefined, configType: undefined });
});

test('数据源列表：自定义关键字与类型过滤', async () => {
  const { client, calls } = stub(() => ok({ rows: [] }));
  await listDataSources(client, { pageNo: 3, pageSize: 20, keyword: '订单', configType: 'RDB' });
  assert.deepEqual(calls[0].opts.query, { pageNo: 3, pageSize: 20, keyword: '订单', configType: 'RDB' });
});

test('数据源全量列表：兼容 rows / data.rows / 裸数组 / data 数组四种形态', async () => {
  const row = { id: 'ds-1', configId: 'C1', configName: '订单库', configType: 'RDB', categoryId: 'cat', appId: 'app', state: '1', jdbcUrl: 'jdbc:mysql://h/db', driverClass: 'com.mysql' };

  const a = stub(() => ok({ rows: [row] }));
  assert.equal((await listAllDataSources(a.client)).length, 1);

  const b = stub(() => ok({ data: { rows: [row] } }));
  assert.equal((await listAllDataSources(b.client)).length, 1);

  const c = stub(() => ok([row]));
  assert.equal((await listAllDataSources(c.client)).length, 1);

  const d = stub(() => ok({ data: [row] }));
  assert.equal((await listAllDataSources(d.client)).length, 1);
});

test('数据源全量列表：字段映射与空结果兜底', async () => {
  const { client } = stub(() => ok({ rows: [{ id: 'ds-9', configName: '库A' }] }));
  const rows = await listAllDataSources(client);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'ds-9');
  assert.equal(rows[0].configName, '库A');
  assert.equal(rows[0].configType, undefined);

  const empty = stub(() => ok({}));
  assert.deepEqual(await listAllDataSources(empty.client), []);
});

test('数据源全量列表：响应体缺失时返回空列表', async () => {
  const { client } = stub(() => ({ ok: true, httpStatus: 200, request: { method: 'GET', url: '/x' } }));
  assert.deepEqual(await listAllDataSources(client), []);
});

test('数据源全量列表：data.data.rows 嵌套形态也能取出列表', async () => {
  const { client } = stub(() => ok({ data: { data: { rows: [{ id: 'ds-n' }] } } }));
  const rows = await listAllDataSources(client);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'ds-n');
});

test('数据源详情：成功时返回脱敏后的数据', async () => {
  const { client, calls } = stub(() => ok({ id: 'ds-1', configName: '订单库', password: '<secret>', jdbcUrl: 'jdbc:mysql://h/db?user=u&password=<secret>' }));
  const r = await getDataSource(client, 'ds-1');
  assert.equal(r.ok, true);
  assert.equal(calls[0].path, '/rest/core/datasource/ds-1');
  assert.equal(r.data?.configName, '订单库');
  assert.equal(r.data?.password, '***');
  assert.ok(!JSON.stringify(r.data).includes('<secret>'), '脱敏后不得泄露明文密码');
});

test('数据源详情：失败时不返回数据，仅带错误信息', async () => {
  const { client } = stub(() => fail('数据源不存在', 404));
  const r = await getDataSource(client, 'missing');
  assert.equal(r.ok, false);
  assert.equal(r.msg, '数据源不存在');
  assert.equal(r.data, undefined);
});

test('数据源详情：兼容 data.data 嵌套形态', async () => {
  const { client } = stub(() => ok({ data: { id: 'ds-2', secret: 'abc' } }));
  const r = await getDataSource(client, 'ds-2');
  assert.equal(r.data?.id, 'ds-2');
  assert.equal(r.data?.secret, '***');
});

test('脱敏：密码类字段一律替换为 ***', () => {
  const masked = maskDataSource({
    password: 'a',
    pwd: 'b',
    secret: 'c',
    token: 'd',
    accessKey: 'e',
    secretKey: 'f',
    keep: 'g',
  });
  assert.equal(masked.password, '***');
  assert.equal(masked.pwd, '***');
  assert.equal(masked.secret, '***');
  assert.equal(masked.token, '***');
  assert.equal(masked.accessKey, '***');
  assert.equal(masked.secretKey, '***');
  assert.equal(masked.keep, 'g');
});

test('脱敏：jdbc 连接串中的 password 参数被抹掉', () => {
  const masked = maskDataSource({ jdbcUrl: 'jdbc:mysql://h:3306/db?user=u&password=secret&x=1' });
  assert.ok(!masked.jdbcUrl.includes('secret'), '连接串不得回显密码');
  assert.ok(masked.jdbcUrl.includes('password=***'));
  assert.ok(masked.jdbcUrl.includes('user=u'));
});

test('脱敏：非对象输入原样返回', () => {
  assert.equal(maskDataSource(null), null);
  assert.equal(maskDataSource(undefined), undefined);
  assert.equal(maskDataSource('x'), 'x');
  assert.equal(maskDataSource(7), 7);
});

test('数据源连接测试：返回 ok/msg 与耗时', async () => {
  const good = stub(() => ok({ connected: true }));
  const r = await testDataSourceConnection(good.client, 'ds-1');
  assert.equal(r.ok, true);
  assert.equal(typeof r.latencyMs, 'number');
  assert.ok((r.latencyMs ?? 0) >= 0);
  assert.equal(good.calls[0].path, DATASOURCE.testConnect);
  assert.deepEqual(good.calls[0].opts.query, { id: 'ds-1' });
  assert.equal(good.calls[0].opts.dryRun, false);

  const bad = stub(() => fail('连接超时', 500));
  const r2 = await testDataSourceConnection(bad.client, 'ds-2');
  assert.equal(r2.ok, false);
  assert.equal(r2.msg, '连接超时');
});

test('数据源保存：默认 dry-run（写操作需显式确认）', async () => {
  const { client, calls } = stub(() => ok({ id: 'ds-1' }));
  const body = { id: 'ds-1', configName: '订单库' };
  const r = await saveDataSource(client, body);
  assert.equal(r.ok, true);
  assert.equal(calls[0].path, DATASOURCE.save);
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(calls[0].opts.body, body);
  assert.equal(calls[0].opts.dryRun, true);
});

test('数据源保存：显式关闭 dry-run 才真发（新建与更新同一入口）', async () => {
  const { client, calls } = stub(() => ok({ id: 'ds-1' }));
  await saveDataSource(client, { id: 'ds-1', configName: '改名' }, { dryRun: false });
  assert.equal(calls[0].opts.dryRun, false);

  const create = stub(() => ok({ id: 'ds-new' }));
  await saveDataSource(create.client, { configName: '新库', configType: 'RDB' }, { dryRun: false });
  assert.equal(create.calls[0].opts.method, 'POST');
  assert.deepEqual(create.calls[0].opts.body, { configName: '新库', configType: 'RDB' });
});
