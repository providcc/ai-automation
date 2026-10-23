/**
 * 新增能力：发布成接口（草稿→上线）、API 参数管理、流程运行/运行记录、调度规则。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishFlowAsApi } from '../../packages/core/src/flow-publish.ts';
import { getApiParams, saveApiParams, deriveParamsFromJson, inferType } from '../../packages/core/src/api-params.ts';
import { deriveSqlColumns } from '../../packages/core/src/sql-check.ts';
import * as FLOW from '../../packages/core/src/flow-lifecycle.ts';
import { stub, ok, fail } from './helpers.ts';

test('发布成接口：草稿态 → 上线态两步，并回读确认 state=1', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('/services/save')) return ok({ id: 'svc1', msg: '保存成功' });
    if (path.includes('/core/services/svc1')) return ok({ id: 'svc1', state: '1', mapUrl: '/x/y' });
    if (path.includes('/esb/process/p1')) return ok({ applicationId: 'app-a', appId: 'esb', categoryId: 'all' });
    return ok({});
  });
  const res = await publishFlowAsApi(client, 'p1', { url: '/x/y', name: '我的接口', method: 'POST' });
  assert.equal(res.ok, true);
  assert.equal(res.serviceId, 'svc1');
  assert.equal(res.state, '1');
  const saves = calls.filter((c) => c.path === '/rest/core/services/save');
  assert.equal(saves.length, 2, '应保存两次（草稿 + 上线）');
  assert.equal((saves[0].opts.body as any).state, '0');
  assert.equal((saves[1].opts.body as any).state, '1');
  assert.equal((saves[0].opts.body as any).processId, 'p1');
  assert.equal((saves[0].opts.body as any).mapUrl, '/x/y');
});

test('发布成接口：草稿保存失败时不上线', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('/services/save')) return fail('保存失败', 500);
    if (path.includes('/esb/process/p1')) return ok({ applicationId: 'app-a' });
    return ok({});
  });
  const res = await publishFlowAsApi(client, 'p1', { url: '/x', name: 'n' });
  assert.equal(res.ok, false);
  assert.equal(calls.filter((c) => c.path === '/rest/core/services/save').length, 1);
});

test('API 参数：读 services/{id} 的 paramsDocs（避开 inparams/list 的空回读）', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('/core/services/svc1')) {
      return ok({ paramsDocs: [{ fieldName: '款号', fieldId: 'styleNo', fieldType: 'String' }], outputParamsDocs: [] });
    }
    return ok({});
  });
  const res = await getApiParams(client, 'svc1', 'in');
  assert.equal(res.ok, true);
  assert.equal(res.params.length, 1);
  assert.equal(res.source, 'services/svc1.paramsDocs');
  assert.equal(calls.some((c) => c.path.includes('inparams/list')), false, 'paramsDocs 有值时不该再问 inparams/list');
});

test('API 参数：paramsDocs 为空时回退 inparams/list', async () => {
  const { client } = stub((path) => {
    if (path.includes('/core/services/svc1')) return ok({ paramsDocs: [] });
    if (path.includes('inparams/list')) return ok([{ fieldName: 'a', fieldId: 'a' }]);
    return ok({});
  });
  const res = await getApiParams(client, 'svc1', 'in');
  assert.equal(res.params.length, 1);
  assert.equal(res.source, 'inparams/list');
});

test('API 参数：保存用 paramsData（JSON 字符串）', async () => {
  const { client, calls } = stub(() => ok({ msg: '保存成功' }));
  const r = await saveApiParams(client, 'svc1', [{ fieldName: 'a', fieldId: 'a', fieldType: 'String' }], 'in');
  assert.equal(r.ok, true);
  const call = calls[0];
  assert.equal(call.path, '/rest/core/services/inparams/save');
  assert.equal(typeof (call.opts.body as any).paramsData, 'string');
  assert.equal((call.opts.body as any).id, 'svc1');
});

test('API 参数：从 JSON 样本推导字段（类型与样例值）', () => {
  const docs = deriveParamsFromJson({ id: 1, name: 'x', ok: true, ratio: 1.5, extra: null });
  assert.deepEqual(docs.map((d) => d.fieldId), ['id', 'name', 'ok', 'ratio', 'extra']);
  assert.equal(docs[0].fieldType, 'Integer');
  assert.equal(docs[1].fieldType, 'String');
  assert.equal(docs[2].fieldType, 'Boolean');
  assert.equal(docs[3].fieldType, 'Double');
  assert.equal(docs[0].sampleValue, '1');
  assert.equal(inferType([1]), 'Array');
  assert.deepEqual(deriveParamsFromJson('not json'), []);
});

test('SQL：本地推导 SELECT 列名（取数端点需要非空字段配置）', () => {
  const cols = deriveSqlColumns('select a.id, b.name as nm from t a join u b');
  assert.deepEqual(cols.map((c) => c.colName), ['id', 'nm']);
  assert.deepEqual(deriveSqlColumns('select * from t').map((c) => c.colName), ['*']);
  assert.deepEqual(deriveSqlColumns('update t set a=1'), []);
});

test('流程运行：优先 POST process/run，body 只有 processId', async () => {
  const { client, calls } = stub(() => ok({ state: true }));
  const r = await FLOW.runFlow(client, 'p1');
  assert.equal(r.ok, true);
  assert.equal(calls[0].path, '/rest/esb/process/run');
  assert.deepEqual(calls[0].opts.body, { processId: 'p1' });
});

test('运行记录：读 monitor/node/instance/list?transactionId=', async () => {
  const { client, calls } = stub(() => ok({ rows: [{ nodeId: 'T00001', currentStatus: 'success' }] }));
  const res = await FLOW.runLog(client, 'tid-1');
  assert.equal(res.ok, true);
  assert.equal(res.nodes.length, 1);
  assert.equal(calls[0].path, '/rest/esb/process/monitor/node/instance/list');
  assert.equal((calls[0].opts.query as any).transactionId, 'tid-1');
});

test('调度规则：processIds 必须是逗号分隔的字符串', async () => {
  const { client, calls } = stub(() => ok({ state: true }));
  await FLOW.saveScheduleRule(client, { processIds: 'a,b', cron: '0 0 * * * ?' });
  assert.equal(calls[0].path, '/bpm/rules/save');
  assert.equal((calls[0].opts.body as any).processIds, 'a,b');
  await assert.rejects(() => FLOW.saveScheduleRule(client, { processIds: '' }), /--process-ids/);
});

test('SQL：行注释/块注释开头的 SELECT 也能推导列名', () => {
  assert.deepEqual(
    deriveSqlColumns('-- 生产版：说明文字\nselect a.id, b.name as nm from t a join u b').map((c) => c.colName),
    ['id', 'nm'],
  );
  assert.deepEqual(deriveSqlColumns('/* block */ select x as y from t').map((c) => c.colName), ['y']);
  assert.deepEqual(deriveSqlColumns('# mysql 行注释\nselect 1 as n from dual').map((c) => c.colName), ['n']);
  assert.deepEqual(deriveSqlColumns('-- 只有注释'), []);
});
