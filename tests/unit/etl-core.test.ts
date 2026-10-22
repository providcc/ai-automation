/**
 * etl：ETL 只读查询 + 写路径闸门（E_FORBIDDEN）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ETL,
  etlWriteEnabled,
  assertEtlWriteAllowed,
  listEtl,
  getEtl,
  runEtl,
  compensateEtl,
  publishEtl,
} from '../../packages/core/src/etl.ts';
import { stub, ok, withEnv } from './helpers.ts';

test('etl：端点常量', () => {
  assert.equal(ETL.list, '/rest/etl/process/list');
  assert.equal(ETL.detail('p1'), '/rest/etl/process/p1');
  assert.equal(ETL.run, '/rest/etl/process/run');
  assert.equal(ETL.compensate, '/rest/etl/process/compensate');
  assert.equal(ETL.publish, '/rest/etl/process/publish');
});

test('etl：写开关只认 1 / true', () => {
  assert.equal(etlWriteEnabled({}), false);
  assert.equal(etlWriteEnabled({ RC_ENABLE_ETL_WRITE: '1' }), true);
  assert.equal(etlWriteEnabled({ RC_ENABLE_ETL_WRITE: 'true' }), true);
  assert.equal(etlWriteEnabled({ RC_ENABLE_ETL_WRITE: '0' }), false);
  assert.equal(etlWriteEnabled({ RC_ENABLE_ETL_WRITE: 'yes' }), false);
  assert.equal(etlWriteEnabled({ RC_ENABLE_ETL_WRITE: 'TRUE' }), false);
});

test('etl：未开闸门时写操作抛 E_FORBIDDEN', async () => {
  await withEnv({ RC_ENABLE_ETL_WRITE: undefined }, async () => {
    const { client, calls } = stub(() => ok());
    await assert.rejects(() => runEtl(client, 'p1'), (e: any) => {
      assert.equal(e.code, 'E_FORBIDDEN');
      assert.equal(e.exitCode, 6);
      assert.match(e.message, /ETL 写操作已封禁/);
      return true;
    });
    assert.equal(calls.length, 0, '封禁时不应发出请求');
  });
});

test('etl：assertEtlWriteAllowed 开闸后不抛错', () => {
  assert.throws(() => assertEtlWriteAllowed('ETL 试跑'), /ETL 写操作已封禁/);
  const prev = process.env.RC_ENABLE_ETL_WRITE;
  process.env.RC_ENABLE_ETL_WRITE = '1';
  try {
    assert.doesNotThrow(() => assertEtlWriteAllowed('ETL 试跑'));
  } finally {
    if (prev === undefined) delete process.env.RC_ENABLE_ETL_WRITE;
    else process.env.RC_ENABLE_ETL_WRITE = prev;
  }
});

test('etl：listEtl 只读查询', async () => {
  const { client, calls } = stub(() => ok({ rows: [] }));
  await listEtl(client);
  assert.equal(calls[0].path, '/rest/etl/process/list');
  assert.equal(calls[0].opts.method, 'GET');
  assert.equal(calls[0].opts.query.keyword, undefined);

  await listEtl(client, 'order');
  assert.equal(calls[1].opts.query.keyword, 'order');
});

test('etl：getEtl 只读详情', async () => {
  const { client, calls } = stub(() => ok({}));
  await getEtl(client, 'p42');
  assert.equal(calls[0].path, '/rest/etl/process/p42');
  assert.equal(calls[0].opts.method, 'GET');
});

test('etl：runEtl 开闸后按 test 模式限量试跑', async () => {
  await withEnv({ RC_ENABLE_ETL_WRITE: '1' }, async () => {
    const { client, calls } = stub(() => ok({}));
    const r = await runEtl(client, 'p1');
    assert.equal(r.ok, true);
    assert.equal(calls[0].path, '/rest/etl/process/run');
    assert.equal(calls[0].opts.method, 'POST');
    assert.deepEqual(calls[0].opts.body, { processId: 'p1', mode: 'test', limit: 100 });
  });
});

test('etl：runEtl 支持自定义 limit 与 dryRun 透传', async () => {
  await withEnv({ RC_ENABLE_ETL_WRITE: '1' }, async () => {
    const { client, calls } = stub(() => ok({}));
    await runEtl(client, 'p1', { mode: 'test', limit: 5, dryRun: true });
    assert.deepEqual(calls[0].opts.body, { processId: 'p1', mode: 'test', limit: 5 });
    assert.equal(calls[0].opts.dryRun, true);
  });
});

test('etl：全量运行必须显式确认', async () => {
  await withEnv({ RC_ENABLE_ETL_WRITE: '1', RC_CONFIRM_FULL_RUN: undefined }, async () => {
    const { client, calls } = stub(() => ok({}));
    await assert.rejects(() => runEtl(client, 'p1', { mode: 'full', dryRun: false }), /RC_CONFIRM_FULL_RUN=1/);
    assert.equal(calls.length, 0);
  });
});

test('etl：全量运行确认后放行', async () => {
  await withEnv({ RC_ENABLE_ETL_WRITE: '1', RC_CONFIRM_FULL_RUN: '1' }, async () => {
    const { client, calls } = stub(() => ok({}));
    const r = await runEtl(client, 'p1', { mode: 'full', dryRun: false });
    assert.equal(r.ok, true);
    assert.deepEqual(calls[0].opts.body, { processId: 'p1', mode: 'full', limit: undefined });
  });
});

test('etl：全量运行在 dry-run 模式不需要确认', async () => {
  await withEnv({ RC_ENABLE_ETL_WRITE: '1', RC_CONFIRM_FULL_RUN: undefined }, async () => {
    const { client, calls } = stub(() => ok({}));
    await runEtl(client, 'p1', { mode: 'full' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.body.mode, 'full');
  });
});

test('etl：compensateEtl / publishEtl 走对应端点', async () => {
  await withEnv({ RC_ENABLE_ETL_WRITE: '1' }, async () => {
    const { client, calls } = stub(() => ok({}));
    await compensateEtl(client, 'p1');
    assert.equal(calls[0].path, '/rest/etl/process/compensate');
    assert.deepEqual(calls[0].opts.body, { processId: 'p1', batchId: undefined });
    assert.equal(calls[0].opts.dryRun, false);

    await compensateEtl(client, 'p1', 'b1');
    assert.deepEqual(calls[1].opts.body, { processId: 'p1', batchId: 'b1' });

    await publishEtl(client, 'p1');
    assert.equal(calls[2].path, '/rest/etl/process/publish');
    assert.deepEqual(calls[2].opts.body, { processId: 'p1' });
    assert.equal(calls[2].opts.dryRun, false);
  });
});

test('etl：补偿与发布同样受写闸门保护', async () => {
  await withEnv({ RC_ENABLE_ETL_WRITE: undefined }, async () => {
    const { client, calls } = stub(() => ok({}));
    await assert.rejects(() => compensateEtl(client, 'p1'), /ETL 写操作已封禁/);
    await assert.rejects(() => publishEtl(client, 'p1'), /ETL 写操作已封禁/);
    assert.equal(calls.length, 0);
  });
});
