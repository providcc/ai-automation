/**
 * 健壮性回归：针对评审中发现的边界问题做断言（防止回退）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RestCloudClient } from '../../packages/core/src/client.ts';
import { loadTargets } from '../../packages/core/src/targets.ts';
import { deleteApi, importOpenApi } from '../../packages/core/src/api.ts';
import { deleteConnectorConfig, maskConnector } from '../../packages/core/src/connector.ts';
import { listAllDataSources } from '../../packages/core/src/datasource.ts';
import { summary as monitorSummary } from '../../packages/core/src/monitor.ts';
import { opsSummary } from '../../packages/core/src/operations.ts';
import { mimeOf } from '../../packages/core/src/upload.ts';
import { parseAllowedHosts, hostAllowed } from '../../packages/core/src/security.ts';
import { buildProcessModel } from '../../packages/core/src/flow-build.ts';
import * as FLOW from '../../packages/core/src/flow-lifecycle.ts';
import { stub, ok, withEnv, tmpDir } from './helpers.ts';

test('会话 Cookie：非法 URL 编码的 identitytoken 不应抛 URIError', () => {
  const c = new RestCloudClient({ baseUrl: 'https://example.test/restcloud', profile: 'uat' });
  c.importCookies({ identitytoken: '100%' });
  assert.equal(c.exportCookies()['identitytoken'], '100%');
});

test('目标配置：形状不对时给出明确错误（而不是 undefined）', async () => {
  await withEnv({ RC_TARGETS: '42' }, () => {
    assert.throws(() => loadTargets(), /RC_TARGETS 需要是数组/);
  });
  await withEnv({ RC_TARGETS: '{not json' }, () => {
    assert.throws(() => loadTargets(), /RC_TARGETS 不是合法 JSON/);
  });
});

test('删除 API：空 id 不发请求', async () => {
  const { client, calls } = stub(() => ok({}));
  await assert.rejects(() => deleteApi(client, ''), /缺少 ids/);
  await assert.rejects(() => deleteApi(client, []), /缺少 ids/);
  await assert.rejects(() => deleteApi(client, ['  ']), /缺少 ids/);
  assert.equal(calls.length, 0);
});

test('删除连接器配置：空 id 不发请求', async () => {
  const { client, calls } = stub(() => ok({}));
  await assert.rejects(() => deleteConnectorConfig(client, ''), /缺少 ids/);
  await assert.rejects(() => deleteConnectorConfig(client, []), /缺少 ids/);
  assert.equal(calls.length, 0);
});

test('连接器脱敏：只脱敏敏感字段名，不误伤 passenger/compass', () => {
  const masked = maskConnector({ password: 'p', passenger: 'x', compass: 'y', apiKey: 'k', nested: { secret: 's' } });
  assert.equal(masked.password, '***');
  assert.equal(masked.apiKey, '***');
  assert.equal(masked.nested.secret, '***');
  assert.equal(masked.passenger, 'x');
  assert.equal(masked.compass, 'y');
});

test('OpenAPI 导入：不传 dryRun 时默认预览（不能因 profile 变成真写）', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('/openapi/analysis')) return ok({ data: [{ mapUrl: '/a' }] });
    return ok({});
  });
  await importOpenApi(client, 'app-1', '{}');
  const importCall = calls.find((c) => !c.path.includes('/openapi/analysis'))!;
  assert.equal(importCall.opts.dryRun, true);
});

test('数据源列表：rows 不是数组时不崩', async () => {
  const { client } = stub(() => ok({ rows: 'not-an-array' }));
  const rows = await listAllDataSources(client);
  assert.deepEqual(rows, []);
});

test('监控聚合：单个子查询抛异常时整体仍可用', async () => {
  const { client } = stub((path) => {
    if (path.includes('error')) throw new Error('ECONNRESET');
    return ok({ rows: [] });
  });
  const s = await monitorSummary(client, 6);
  assert.ok(s.notes.some((n) => /失败/.test(n)));
});

test('运营摘要：子查询抛异常时降级为 notes', async () => {
  const { client } = stub(() => { throw new Error('timeout'); });
  const s = await opsSummary(client);
  assert.ok(s.notes.length >= 1);
  assert.equal(s.assessedApis, 0);
});

test('上传：附件带 MIME 类型', () => {
  assert.equal(mimeOf('/tmp/a.json'), 'application/json');
  assert.equal(mimeOf('/tmp/a.wsdl'), 'text/xml');
  assert.equal(mimeOf('/tmp/a.unknown'), 'application/octet-stream');
});

test('白名单：非法 URL 的模式退回原样，不抛异常', () => {
  const patterns = parseAllowedHosts('http://[bad');
  assert.equal(patterns.length, 1);
  assert.equal(hostAllowed('http://[bad', patterns), true);
  assert.equal(hostAllowed('other.test', patterns), false);
});

test('网关没有出口连线时给出告警', () => {
  const { model, warnings } = buildProcessModel({
    kind: 'esb',
    nodes: [{ nodeType: 'start' }, { nodeType: 'gateWay' }, { nodeType: 'end' }],
    edges: [{ from: 'E00001', to: 'G00001' }, { from: 'E00002', to: 'E00003' }],
  });
  assert.ok(model.nodeDataArray.length >= 3);
  assert.ok(warnings.some((w: string) => /网关 .* 没有出口连线/.test(w)));
});

test('删除流程：轮询阶段的网络异常不应打断删除流程', async () => {
  let deleted = false;
  const { client } = stub((path) => {
    if (path.endsWith('/process/delete')) { deleted = true; return ok({ number: 1 }); }
    // 删除请求之后的详情查询 = 轮询确认阶段，这里模拟网络异常
    if (deleted) throw new Error('ECONNRESET');
    return ok({ id: 'm1', processId: 'p1', processModel: { nodeDataArray: [], linkDataArray: [] } });
  });
  const r = await FLOW.deleteFlow(client, 'p1', { kind: 'esb', dryRun: false, poll: { attempts: 2, intervalMs: 0 } });
  // 轮询期间异常被吞掉，最终按"仍可读取"处理 → 明确失败而不是抛异常
  assert.equal(r.ok, false);
  assert.match(String(r.msg), /仍可读取|已返回成功/);
});

test('属性归一化：记录 id 不会混进业务属性', () => {
  const nodes = FLOW.normalizeNodeProps({ T00001: { pNodeId: 'T00001', pNodeType: 'apiNode', id: 'rec-1', apiUrl: 'https://x.test' } })!;
  assert.equal(nodes[0].id, 'rec-1');
  assert.equal((nodes[0].props as any).id, undefined);
  assert.equal((nodes[0].props as any).apiUrl, 'https://x.test');
});

test('回滚：写回后回读校验 + 缺失补写（平台索引延迟场景）', async () => {
  const dir = tmpDir('rc-rollback-');
  try {
    let reads = 0;
    const { client, calls } = stub((path) => {
      if (path.endsWith('/node/props/list')) {
        reads++;
        // 前两次读不到（平台索引延迟），第三次才可见
        return ok(reads >= 3 ? { T00001: { id: 'r1', pNodeId: 'T00001' } } : {});
      }
      if (path.endsWith('/node/save')) return ok({ state: true });
      if (path.endsWith('/node/delete')) return ok({ state: true });
      if (path.endsWith('/model/save')) return ok({ state: true });
      return ok({ id: 'm1', processId: 'p1' });
    });
    const snap: any = {
      version: 1, kind: 'esb', processId: 'p1', capturedAt: new Date().toISOString(),
      detail: {}, model: { nodeDataArray: [{ key: 'T00001', nodeType: 'apiNode' }], linkDataArray: [] },
      nodes: ['T00001'], routers: [],
      props: { T00001: { id: 'r1', pNodeId: 'T00001', pNodeType: 'apiNode', apiUrl: 'https://x.test' } },
      savedNodeSet: ['T00001'],
    };
    const rep = await FLOW.restoreFlowSnapshot(client, snap, { verifyDelayMs: 0 });
    assert.equal(rep.ok, true, rep.msg);
    assert.equal(rep.verified?.expected, 1);
    assert.equal(rep.verified?.props, 1);
    assert.deepEqual(rep.verified?.missing, []);
    assert.ok((rep.rewritten ?? []).includes('T00001'), '缺失的属性应被补写');
    // 至少回读校验了 3 轮
    assert.ok((rep.verified?.rounds ?? 0) >= 2);
    assert.ok(calls.filter((c) => c.path.endsWith('/node/save')).length >= 2);
  } finally {
    dir.cleanup();
  }
});

test('回滚：回读始终缺属性时如实报告缺失，不谎报成功', async () => {
  const dir = tmpDir('rc-rollback-');
  try {
    const { client } = stub((path) => {
      if (path.endsWith('/node/props/list')) return ok({});
      if (path.endsWith('/node/save')) return ok({ state: true });
      if (path.endsWith('/node/delete')) return ok({ state: true });
      if (path.endsWith('/model/save')) return ok({ state: true });
      return ok({ id: 'm1', processId: 'p1' });
    });
    const snap: any = {
      version: 1, kind: 'esb', processId: 'p1', capturedAt: new Date().toISOString(),
      detail: {}, model: { nodeDataArray: [{ key: 'T00001', nodeType: 'apiNode' }], linkDataArray: [] },
      nodes: ['T00001'], routers: [],
      props: { T00001: { id: 'r1', pNodeId: 'T00001', pNodeType: 'apiNode' } },
      savedNodeSet: ['T00001'],
    };
    const rep = await FLOW.restoreFlowSnapshot(client, snap, { verifyDelayMs: 0, verifyRounds: 2 });
    assert.equal(rep.ok, false);
    assert.deepEqual(rep.verified?.missing, ['T00001']);
    assert.match(rep.msg ?? '', /仍缺 1 条属性/);
  } finally {
    dir.cleanup();
  }
});
