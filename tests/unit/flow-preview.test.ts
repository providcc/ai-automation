/**
 * 流程节点数据预览：端点白名单、请求体、行截断、错误提示。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewFlowNode, extractPreviewRows, formatPreviewTable } from '../../packages/core/src/flow-preview.ts';
import { stub, ok, fail } from './helpers.ts';

test('预览：只支持白名单里的节点类型，其余给可行动提示', async () => {
  const { client, calls } = stub(() => ok({ rows: [] }));
  const res = await previewFlowNode(client, { processId: 'p1', nodeId: 'T1' });
  assert.equal(res.ok, false);
  assert.match(res.msg ?? '', /没有平台预览端点/);
  assert.match(res.hint ?? '', /支持预览的节点类型/);
  assert.equal(calls.filter((c) => c.path.includes('preview')).length, 0, '不支持的类型不该发预览请求');
});

test('预览：请求体只取节点已保存的配置（不接受外部 SQL）', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('/node/props')) {
      return ok({
        id: 'r1', pNodeId: 'T1', pNodeType: 'tableReadNode',
        sqlCode: 'select * from t', tableName: 't', dbConnId: 'ds1', tableColumns: '[{"name":"a"}]',
      });
    }
    if (path.includes('previewdata')) return ok({ columns: ['a'], rows: [{ a: 1 }] });
    return ok({});
  });
  const res = await previewFlowNode(client, { processId: 'p1', nodeId: 'T1', limit: 5 });
  assert.equal(res.ok, true);
  const call = calls.find((c) => c.path.includes('previewdata'))!;
  assert.equal(call.path, '/rest/esb/process/tablereadnode/previewdata');
  const body = call.opts.body as any;
  assert.equal(body.sql, 'select * from t');
  assert.equal(body.dbConnId, 'ds1');
  assert.equal(body.nodeId, 'T1');
  assert.equal(body.processId, 'p1');
  assert.equal(body.limit, 5);
  assert.equal(body.sqlCode, undefined, '不要把业务字段当请求参数发出去');
});

test('预览：行按 limit 截断，并标记 truncated', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: i }));
  const { client } = stub((path) => {
    if (path.includes('/node/props')) return ok({ pNodeId: 'T1', pNodeType: 'tableReadNode', dbConnId: 'ds1' });
    if (path.includes('previewdata')) return ok({ columns: ['id'], rows });
    return ok({});
  });
  const res = await previewFlowNode(client, { processId: 'p1', nodeId: 'T1', limit: 5 });
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 5);
  assert.equal(res.totalRows, 30);
  assert.equal(res.truncated, true);
  assert.deepEqual(res.columns, ['id']);
});

test('预览：limit 有上限（最多 100 行）', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('/node/props')) return ok({ pNodeId: 'T1', pNodeType: 'tableReadNode', dbConnId: 'ds1' });
    if (path.includes('previewdata')) return ok({ rows: [] });
    return ok({});
  });
  await previewFlowNode(client, { processId: 'p1', nodeId: 'T1', limit: 9999 });
  const call = calls.find((c) => c.path.includes('previewdata'))!;
  assert.equal((call.opts.body as any).limit, 100);
});

test('预览：平台说"字段配置为空"时给可行动提示', async () => {
  const { client } = stub((path) => {
    if (path.includes('/node/props')) return ok({ pNodeId: 'T1', pNodeType: 'tableReadNode', dbConnId: 'ds1' });
    if (path.includes('previewdata')) return { ok: false, httpStatus: 200, msg: '字段配置中的字段不能为空!', data: {} };
    return ok({});
  });
  const res = await previewFlowNode(client, { processId: 'p1', nodeId: 'T1' });
  assert.equal(res.ok, false);
  assert.match(res.msg ?? '', /字段配置中的字段不能为空/);
  assert.match(res.hint ?? '', /字段\/列配置/);
  assert.match(res.hint ?? '', /flow props list --only sql/);
});

test('预览：连接失败时提示先测连通性', async () => {
  const { client } = stub((path) => {
    if (path.includes('/node/props')) return ok({ pNodeId: 'T1', pNodeType: 'tableReadNode', dbConnId: 'ds1' });
    if (path.includes('previewdata')) return fail('connection timeout', 500);
    return ok({});
  });
  const res = await previewFlowNode(client, { processId: 'p1', nodeId: 'T1' });
  assert.equal(res.ok, false);
  assert.match(res.hint ?? '', /datasource test/);
});

test('预览结果解析：兼容数组 / rows / records / data 多种形态', () => {
  assert.deepEqual(extractPreviewRows([{ a: 1 }]).rows, [{ a: 1 }]);
  assert.deepEqual(extractPreviewRows({ rows: [{ a: 1 }] }).rows, [{ a: 1 }]);
  assert.deepEqual(extractPreviewRows({ data: { records: [{ a: 1 }] } }).rows, [{ a: 1 }]);
  assert.deepEqual(extractPreviewRows({ columns: [{ name: 'a' }], rows: [{ a: 1 }] }).columns, ['a']);
  assert.deepEqual(extractPreviewRows(null), { columns: [], rows: [] });
});

test('预览结果渲染：表格 + 截断说明', () => {
  const text = formatPreviewTable({
    ok: true, nodeType: 'tableReadNode', columns: ['id', 'name'],
    rows: [{ id: '1', name: 'x'.repeat(80) }], totalRows: 3, truncated: true,
  });
  assert.match(text, /id\s+name/);
  assert.match(text, /…/);
  assert.match(text, /共 3 行/);
  const failText = formatPreviewTable({ ok: false, columns: [], rows: [], totalRows: 0, truncated: false, msg: '炸了', hint: '换个姿势' });
  assert.match(failText, /预览失败：炸了/);
  assert.match(failText, /换个姿势/);
});

test('预览：SQL 执行器走 ESB 的按 SQL 预览端点', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('/node/props')) return ok({ pNodeId: 'T1', pNodeType: 'sqlExecuterNode', dbConnId: 'ds1', sqlCode: 'select 1' });
    if (path.includes('previewdata')) return ok({ columns: ['a'], rows: [{ a: 1 }] });
    return ok({});
  });
  const res = await previewFlowNode(client, { processId: 'p1', nodeId: 'T1' });
  assert.equal(res.ok, true);
  assert.equal(calls.find((c) => c.path.includes('preview'))!.path, '/rest/esb/process/tablereadnode/previewdata');
});

test('预览：ETL 的 Mongo / ES 节点走各自端点', async () => {
  const seen: string[] = [];
  for (const [type, endpoint] of [
    ['mongoDbReadNode', '/rest/etl/process/mongodbreadnode/previewdata'],
    ['elasticReadNode', '/rest/etl/process/elasticsearch/previewdata'],
    ['sqlReadNode', '/rest/etl/process/sqlreadnode/previewdata'],
  ] as const) {
    const { client } = stub((path) => {
      if (path.includes('/node/props')) return ok({ pNodeId: 'T1', pNodeType: type });
      if (path.includes('preview')) { seen.push(path); return ok({ rows: [] }); }
      return ok({});
    });
    const res = await previewFlowNode(client, { processId: 'p1', nodeId: 'T1', kind: 'etl' });
    assert.equal(res.ok, true, type);
    assert.equal(seen[seen.length - 1], endpoint);
  }
});
