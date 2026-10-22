/**
 * 血缘与影响面单测：表级血缘 / 数据源血缘 / 应用关系 / 元数据血缘 / 深度影响面。
 * 全部使用桩客户端，不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINEAGE,
  tableLineage,
  datasourceLineage,
  appRelationship,
  apiCallRelation,
  metaTableLineage,
  deepImpactOfApi,
  impactByApiId,
} from '../../packages/core/src/lineage.ts';
import { stub, ok, fail } from './helpers.ts';

test('血缘端点常量符合平台契约', () => {
  assert.equal(LINEAGE.tableIn, '/rest/etl/relationship/tables/in');
  assert.equal(LINEAGE.tableOut, '/rest/etl/relationship/tables/out');
  assert.equal(LINEAGE.datasource, '/rest/etl/relationship/datasource');
  assert.equal(LINEAGE.metaTable, '/rest/etl/relationship/metatable/link');
  assert.equal(LINEAGE.appRelationship, '/rest/apiportal/application/relationship');
  assert.equal(LINEAGE.apiCallRelation, '/rest/core/report/api/slim/application/call/relation');
});

test('表级血缘：默认查流入方向并带默认 limit', async () => {
  const { client, calls } = stub(() => ok({ rows: [] }));
  const { rows: nodes } = await tableLineage(client, 'orders');
  assert.equal(calls[0].path, LINEAGE.tableIn);
  assert.deepEqual(calls[0].opts.query, { tableName: 'orders', name: 'orders', limit: 200 });
  assert.deepEqual(nodes, []);
});

test('表级血缘：流出方向与自定义 limit', async () => {
  const { client, calls } = stub(() => ok({ rows: [] }));
  await tableLineage(client, 'db.orders', { direction: 'out', limit: 5 });
  assert.equal(calls[0].path, LINEAGE.tableOut);
  assert.equal(calls[0].opts.query.limit, 5);
  assert.equal(calls[0].opts.query.tableName, 'db.orders');
});

test('表级血缘：字段映射（标准字段与别名字段）', async () => {
  const { client } = stub(() => ok({
    rows: [
      { tableName: 'orders', processId: 123, processName: '流程A', datasourceId: 'ds-1', datasourceName: '源库A' },
      { table: 'orders_out', dbConnId: 'ds-2', dbConnName: '仓库库', configName: '出库流程' },
    ],
  }));
  const { rows: nodes } = await tableLineage(client, 'orders', { direction: 'out' });
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].tableName, 'orders');
  assert.equal(nodes[0].processId, '123');
  assert.equal(nodes[0].processName, '流程A');
  assert.equal(nodes[0].datasourceId, 'ds-1');
  assert.equal(nodes[0].datasourceName, '源库A');
  assert.equal(nodes[0].direction, 'out');
  assert.ok(nodes[0].raw);

  assert.equal(nodes[1].tableName, 'orders_out');
  assert.equal(nodes[1].processId, undefined);
  assert.equal(nodes[1].processName, '出库流程');
  assert.equal(nodes[1].datasourceId, 'ds-2');
  assert.equal(nodes[1].datasourceName, '仓库库');
});

test('表级血缘：缺少表名时回退到查询表名', async () => {
  const { client } = stub(() => ok({ rows: [{ processId: 'p1' }] }));
  const { rows: nodes } = await tableLineage(client, 'fallback_tbl');
  assert.equal(nodes[0].tableName, 'fallback_tbl');
  assert.equal(nodes[0].direction, 'in');
});

test('表级血缘：兼容裸数组与 data.rows 形态', async () => {
  const arr = stub(() => ok([{ tableName: 't1' }]));
  assert.equal((await tableLineage(arr.client, 't1')).rows.length, 1);

  const nested = stub(() => ok({ data: { rows: [{ tableName: 't1' }, { tableName: 't2' }] } }));
  assert.equal((await tableLineage(nested.client, 't1')).rows.length, 2);
});

test('表级血缘：空结果给出原因（区分没人写表 / 索引没建）', async () => {
  const { client } = stub(() => ok({ rows: [] }));
  const res = await tableLineage(client, 'orders');
  assert.equal(res.rows.length, 0);
  assert.match(res.note ?? '', /没有任何流程写这张表/);
  assert.match(res.note ?? '', /血缘索引没建或没同步/);
  assert.match(res.note ?? '', /rc flow list --keyword orders/);
});

test('表级血缘：有结果时不给原因', async () => {
  const { client } = stub(() => ok({ rows: [{ tableName: 'orders' }] }));
  const res = await tableLineage(client, 'orders');
  assert.equal(res.note, undefined);
});

test('数据源血缘：映射数据源、表与流程清单', async () => {
  const { client, calls } = stub(() => ok({
    rows: [
      { datasourceId: 'ds-1', datasourceName: '源库A', tables: ['orders', 2], processes: [{ processId: 'p1', processName: '同步' }] },
      { id: 'ds-2', configName: '仓库库' },
    ],
  }));
  const list = await datasourceLineage(client);
  assert.equal(calls[0].path, LINEAGE.datasource);
  assert.equal(list.length, 2);
  assert.equal(list[0].datasourceId, 'ds-1');
  assert.equal(list[0].datasourceName, '源库A');
  assert.deepEqual(list[0].tables, ['orders', '2']);
  assert.equal(list[0].processes.length, 1);
  assert.equal(list[1].datasourceId, 'ds-2');
  assert.equal(list[1].datasourceName, '仓库库');
  assert.deepEqual(list[1].tables, []);
  assert.deepEqual(list[1].processes, []);
});

test('应用关系图：取嵌套 data', async () => {
  const { client, calls } = stub(() => ok({ data: { nodes: [{ id: 'app-1' }] } }));
  const rel = await appRelationship(client);
  assert.equal(calls[0].path, LINEAGE.appRelationship);
  assert.deepEqual(rel, { nodes: [{ id: 'app-1' }] });

  const flat = stub(() => ok({ nodes: [] }));
  assert.deepEqual(await appRelationship(flat.client), { nodes: [] });
});

test('API 调用关系：取嵌套 data', async () => {
  const { client, calls } = stub(() => ok({ data: [{ from: 'a', to: 'b' }] }));
  const rel = await apiCallRelation(client);
  assert.equal(calls[0].path, LINEAGE.apiCallRelation);
  assert.deepEqual(rel, [{ from: 'a', to: 'b' }]);
});

test('API 调用关系：没有嵌套 data 时直接返回响应体', async () => {
  const { client } = stub(() => ok([{ from: 'a', to: 'b' }]));
  assert.deepEqual(await apiCallRelation(client), [{ from: 'a', to: 'b' }]);
});

test('元数据血缘：可带表名过滤', async () => {
  const { client, calls } = stub(() => ok({ data: { links: [] } }));
  const rel = await metaTableLineage(client, 'orders');
  assert.equal(calls[0].path, LINEAGE.metaTable);
  assert.deepEqual(calls[0].opts.query, { tableName: 'orders' });
  assert.deepEqual(rel, { links: [] });

  const all = stub(() => ok({ links: [] }));
  await metaTableLineage(all.client);
  assert.equal(all.calls[0].opts.query, undefined);
});

test('深度影响面：直接命中 + 反向调用者', async () => {
  const { client, calls } = stub((path) => {
    if (path === '/rest/esb/process/list') {
      return ok({ rows: [
        { processId: 'p1', processName: '订单流程' },
        { processId: 'p2', processName: '调用方流程' },
        { processId: 'p3', processName: '无关流程' },
        { id: 'p4', configName: '仅 id 的流程' },
        { processName: '没有 id 的行' },
      ] });
    }
    if (path === '/rest/esb/process/p1') return ok({ data: { nodes: [{ apiId: 'api-123' }] } });
    if (path === '/rest/esb/process/p2') return ok({ data: { nodes: [{ ref: 'p1' }] } });
    if (path === '/rest/esb/process/p3') return ok({ data: { nodes: [] } });
    if (path === '/rest/esb/process/p4') return ok({ data: { nodes: [{ apiId: 'api-123' }] } });
    return ok({});
  });

  const r = await deepImpactOfApi(client, { id: 'api-123', name: '订单API', path: '/order/list' });
  assert.equal(r.scanned, 4, '没有 id 的行不计入扫描数');
  assert.equal(r.direct.length, 2);
  assert.equal(r.direct[0].processId, 'p1');
  assert.equal(r.direct[0].processName, '订单流程');
  assert.ok(r.direct[0].directHits > 0);
  assert.equal(r.direct[0].depth, 0);
  assert.equal(r.direct[1].processId, 'p4');
  assert.equal(r.direct[1].processName, '仅 id 的流程');

  assert.equal(r.indirect.length, 1);
  assert.equal(r.indirect[0].processId, 'p2');
  assert.equal(r.indirect[0].viaSubProcess, '订单流程');
  assert.equal(r.indirect[0].depth, 1);
  assert.equal(r.indirect[0].directHits, 0);
  assert.ok(calls.some((c) => c.path === '/rest/esb/process/list'));
});

test('深度影响面：includeCallers=false 时不做反向扩展', async () => {
  const { client } = stub((path) => {
    if (path === '/rest/esb/process/list') return ok({ rows: [{ processId: 'p1', processName: '订单流程' }, { processId: 'p2' }] });
    if (path.endsWith('/p1')) return ok({ data: { apiId: 'api-123' } });
    return ok({ data: { ref: 'p1' } });
  });
  const r = await deepImpactOfApi(client, { id: 'api-123' }, { includeCallers: false });
  assert.equal(r.direct.length, 1);
  assert.deepEqual(r.indirect, []);
});

test('深度影响面：ETL 走 etl 端点，maxProcesses 限制扫描量', async () => {
  const { client, calls } = stub((path) => {
    if (path === '/rest/etl/process/list') return ok({ rows: [{ processId: 'e1' }, { processId: 'e2' }, { processId: 'e3' }] });
    return ok({ data: { apiId: 'api-9' } });
  });
  const r = await deepImpactOfApi(client, { id: 'api-9' }, { kind: 'etl', maxProcesses: 2 });
  assert.equal(r.scanned, 2);
  assert.ok(calls.every((c) => c.path.startsWith('/rest/etl/process')));
});

test('深度影响面：过短的标识不参与匹配', async () => {
  const { client } = stub((path) => {
    if (path === '/rest/esb/process/list') return ok({ rows: [{ processId: 'p1', processName: '流程' }] });
    return ok({ data: { note: 'ab and abc' } });
  });
  const r = await deepImpactOfApi(client, { id: 'ab' });
  assert.equal(r.direct.length, 0, '长度不足的标识不应命中');
  assert.equal(r.scanned, 1);
});

test('深度影响面：调用者缺少流程名时回退到流程 id', async () => {
  const { client } = stub((path) => {
    if (path === '/rest/esb/process/list') return ok({ rows: [{ processId: 'p1' }, { processId: 'p2' }] });
    if (path.endsWith('/p1')) return ok({ data: { apiId: 'api-1' } });
    return ok({ data: { ref: 'p1' } });
  });
  const r = await deepImpactOfApi(client, { id: 'api-1' });
  assert.equal(r.indirect.length, 1);
  assert.equal(r.indirect[0].viaSubProcess, 'p1');
});

test('深度影响面：直接命中流程自身不重复算作调用者', async () => {
  const { client } = stub((path) => {
    if (path === '/rest/esb/process/list') return ok({ rows: [{ processId: 'p1', processName: '命中' }] });
    return ok({ data: { apiId: 'api-1', self: 'p1' } });
  });
  const r = await deepImpactOfApi(client, { id: 'api-1' });
  assert.equal(r.direct.length, 1);
  assert.equal(r.indirect.length, 0);
});

test('深度影响面：流程详情没有嵌套 data 或整个缺失时按空内容处理', async () => {
  const { client } = stub((path) => {
    if (path === '/rest/esb/process/list') return ok({ rows: [{ processId: 'p1' }, { processId: 'p2' }] });
    if (path.endsWith('/p1')) return ok({ apiId: 'api-1' });
    return { ok: true, httpStatus: 200, request: { method: 'GET', url: '/x' } };
  });
  const r = await deepImpactOfApi(client, { id: 'api-1' });
  assert.equal(r.scanned, 2);
  assert.equal(r.direct.length, 1);
  assert.equal(r.indirect.length, 0);
});

test('轻量影响面：按 API id 扫描流程（ESB）', async () => {
  const { client, calls } = stub((path) => {
    if (path === '/rest/esb/process/list') return ok({ rows: [{ processId: 'p1', processName: '流程一' }, { processId: 'p2', name: '流程二' }] });
    if (path === '/rest/esb/process/p1') return ok({ data: { nodes: [{ apiId: 'api-7' }] } });
    if (path === '/rest/esb/process/p2') return ok({ data: { nodes: [] } });
    return ok({});
  });
  const hits = await impactByApiId(client, 'api-7');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].processId, 'p1');
  assert.equal(hits[0].processName, '流程一');
  assert.ok(hits[0].hits > 0);
  assert.ok(calls.some((c) => c.path === '/rest/esb/process/list'));
});

test('轻量影响面：ETL 走 etl 端点并跳过无 id 行', async () => {
  const { client, calls } = stub((path) => {
    if (path === '/rest/etl/process/list') return ok({ data: [{ processId: 'e1' }, { configName: '无 id' }] });
    return ok({ data: { apiId: 'api-3' } });
  });
  const hits = await impactByApiId(client, 'api-3', 'etl');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].processId, 'e1');
  assert.ok(calls.every((c) => c.path.startsWith('/rest/etl/process')));
});

test('轻量影响面：接口列表读取失败时返回空命中', async () => {
  const { client } = stub(() => fail('流程服务不可用', 500));
  const hits = await impactByApiId(client, 'api-7');
  assert.deepEqual(hits, []);
});
