/**
 * flow-lifecycle 边界分支补充单测：空载荷、缺字段、端点缺失、异常路径等。
 * 不修改任何源文件；不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as FLOW from '../../packages/core/src/flow-lifecycle.ts';
import { stub, ok, fail, tmpDir, withEnv } from './helpers.ts';

type Call = { path: string; opts: any };

/** 允许显式 undefined 数据体的响应（默认参数会替换 undefined，这里绕开） */
const rawOk = (data: unknown) => ({
  ok: true, httpStatus: 200, data, request: { method: 'GET', url: '/x' },
});

function route(table: Record<string, any>, fallback: any = ok()) {
  return (path: string, opts: any, calls: Call[]) => {
    for (const [k, v] of Object.entries(table)) {
      if (path.includes(k)) return typeof v === 'function' ? v(opts, calls) : v;
    }
    return fallback;
  };
}

const MODEL = {
  nodeDataArray: [
    { key: 'E00001', nodeType: 'start' },
    { key: 'T00001', nodeType: 'apiNode' },
    { key: 'E00002', nodeType: 'end' },
  ],
  linkDataArray: [
    { from: 'E00001', to: 'T00001', routerId: 'R00001', assertCondition: '1' },
    { from: 'T00001', to: 'E00002', routerId: 'R00002', assertCondition: '0' },
  ],
};

function baseRoutes(extra: Record<string, any> = {}) {
  return route({
    '/node/props/list': ok({ rows: [] }),
    '/node/props': ok({}),
    '/node/select': (opts: any) => (opts.query?.nodeType === 'router' ? ok([]) : ok([{ nodeId: 'T00001' }])),
    '/node/delete': ok({ state: true }),
    '/node/save': ok({ state: true }),
    '/node/batch/save': ok({ state: true }),
    '/model/save': ok({ state: true }),
    '/model/checkerror': ok({ state: true, msg: '未发现错误' }),
    ...extra,
  });
}

// ---------------- 列表分页边界 ----------------

test('listFlows 全量：平台返回空体时按空列表处理', async () => {
  const { client } = stub(() => rawOk(undefined));
  const r: any = await FLOW.listFlows(client, { all: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.rows, []);
  assert.equal(r.data.matched, 0);
});

test('listFlows 全量：满页之后遇到空页结束翻页', async () => {
  const { client, calls } = stub((_p, opts) => {
    if (opts.query.pageNo === 1) {
      return ok({ rows: Array.from({ length: 100 }, (_x, i) => ({ processId: `p${i}` })) });
    }
    return ok({ rows: [] });
  });
  const r: any = await FLOW.listFlows(client, { all: true, pageSize: 100 });
  assert.equal(calls.length, 2);
  assert.equal(r.data.rows.length, 100);
});

test('listFlows 全量：总数在 data.total 里也能识别最后一页', async () => {
  const { client, calls } = stub((_p, opts) => {
    if (opts.query.pageNo === 1) return ok({ data: { total: 1, rows: [{ processId: 'p1' }] } });
    return ok({ data: { total: 1, rows: [] } });
  });
  const r: any = await FLOW.listFlows(client, { all: true, pageSize: 10 });
  assert.equal(calls.length, 1);
  assert.equal(r.data.rows.length, 1);
});

test('列表过滤：行上没有应用字段时按空串比较', () => {
  const rows = [{ processId: 'p1', applicationId: 'APP' }, { processId: 'p2' }];
  assert.deepEqual(FLOW.filterFlows(rows, { appId: 'app' }).map((x) => x.processId), ['p1']);
});

// ---------------- 新建流程边界 ----------------

test('createFlow：失败响应没有 msg 时不触发编码重试', async () => {
  const { client, calls } = stub(() => ({ ok: false, httpStatus: 500, data: {}, request: { method: 'POST', url: '/x' } }));
  const r = await FLOW.createFlow(client, { applicationId: 'a', processName: 'X' });
  assert.equal(calls.length, 1);
  assert.equal(r.ok, false);
  assert.equal(r.msg, undefined);
});

test('createFlow：回查列表按 processName 命中且只有 id 也能取到流程', async () => {
  const { client } = stub((path) => {
    if (path.endsWith('/process/list')) return ok({ rows: [{ processName: '订单流程', id: 'p-id' }] });
    return ok({ state: true });
  });
  const r = await FLOW.createFlow(client, { applicationId: 'a', processName: '订单流程' });
  assert.equal(r.processId, 'p-id');
});

test('cloneFlow：响应没有新流程标识时只返回 ok', async () => {
  const { client } = stub(() => ok({ state: true }));
  const r = await FLOW.cloneFlow(client, { processId: 'p1' });
  assert.equal(r.ok, true);
  assert.equal(r.processId, undefined);
});

test('端点缺失时给出明确报错（发布 / 版本列表 / 版本恢复）', async () => {
  const { client } = stub(() => ok({}));
  const saved = { publish: FLOW.FLOW_ESB.publish, versionList: FLOW.FLOW_ESB.versionList, versionRestore: FLOW.FLOW_ESB.versionRestore };
  try {
    (FLOW.FLOW_ESB as any).publish = undefined;
    await assert.rejects(() => FLOW.publishFlow(client, 'p1'), /流程无 publish 端点/);
    (FLOW.FLOW_ESB as any).versionList = undefined;
    await assert.rejects(() => FLOW.listVersions(client, 'p1'), /流程无版本端点/);
    (FLOW.FLOW_ESB as any).versionRestore = undefined;
    await assert.rejects(() => FLOW.restoreVersion(client, 'p1', 'v1'), /流程无版本恢复端点/);
  } finally {
    Object.assign(FLOW.FLOW_ESB, saved);
  }
  // 复原后仍可用
  await FLOW.publishFlow(client, 'p1');
});

// ---------------- 属性解包边界 ----------------

test('normalizeNodeProps：既没有 nodeType 也没有 pNodeType 时用 unknown', () => {
  const out = FLOW.normalizeNodeProps({ T4: { apiUrl: 'x' } })!;
  assert.equal(out[0].nodeType, 'unknown');
  assert.equal(out[0].nodeName, undefined);
});

test('nodePropsMap：节点没有属性时只带元字段', () => {
  const map = FLOW.nodePropsMap([{ nodeId: 'T3', nodeType: 'apiNode' }])!;
  assert.deepEqual(map.T3, { pNodeId: 'T3', pNodeType: 'apiNode' });
});

test('getNodeProps：空数据体与数组里的非对象项都能安全处理', async () => {
  const { client } = stub(() => rawOk(null));
  assert.deepEqual(await FLOW.getNodeProps(client, 'p1', 'T1'), {});

  const { client: c2 } = stub(() => ok(['x', { pNodeId: 'T1' }]));
  const rec = await FLOW.getNodeProps(c2, 'p1', 'T1');
  assert.equal(rec.pNodeId, 'T1');
});

test('getNodeProps：data 里再包一层才能命中 data / data.rows 解包', async () => {
  const { client } = stub(() => rawOk({ data: { data: [{ pNodeId: 'T1', pNodeType: 'apiNode' }] } }));
  const rec = await FLOW.getNodeProps(client, 'p1', 'T1');
  assert.equal(rec.pNodeId, 'T1');

  const { client: c2 } = stub(() => rawOk({ data: { data: { rows: [{ pNodeId: 'T2' }] } } }));
  const rec2 = await FLOW.getNodeProps(c2, 'p1', 'T2');
  assert.equal(rec2.pNodeId, 'T2');

  const { client: c3 } = stub(() => rawOk({ data: { data: { foo: 1 } } }));
  const rec3 = await FLOW.getNodeProps(c3, 'p1', 'T3');
  assert.equal(rec3.pNodeId, 'data');
});

test('getNodePropsBatch：批量结果里没有 pNodeId 的记录被忽略', async () => {
  const { client } = stub(() => ok({ rows: [{ id: 'rX' }, { id: 'r1', pNodeId: 'T1' }] }));
  const recs = await FLOW.getNodePropsBatch(client, 'p1', ['T1']);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].pNodeId, 'T1');
});

// ---------------- 属性写入边界 ----------------

test('upsertNodeProps：节点没有属性字段也能提交', async () => {
  const { client, calls } = stub((path) => {
    if (path.endsWith('/node/batch/save')) return ok({ state: true });
    return ok({});
  });
  const rep = await FLOW.upsertNodeProps(client, {
    appId: 'esb', processId: 'p1',
    nodes: [
      { nodeId: 'T1', nodeType: 'apiNode' },
      { nodeId: 'T2', nodeType: 'apiNode' },
      { nodeId: 'T3', nodeType: 'apiNode' },
    ],
  });
  assert.deepEqual(rep.inserted, ['T1', 'T2', 'T3']);
  const batch = calls.find((c) => c.path.endsWith('/node/batch/save'))!;
  assert.deepEqual(Object.keys((batch.opts.body as any[])[0]).sort(), ['appId', 'pNodeId', 'pNodeName', 'pNodeType', 'processId']);
});

test('upsertNodeProps：降级逐节点时覆盖新增与重复清理两种结果', async () => {
  const { client } = stub((path, opts) => {
    if (path.endsWith('/node/props/list')) return ok({ rows: [] });
    if (path.endsWith('/node/batch/save')) return fail('批量失败', 500);
    if (path.endsWith('/node/props')) {
      const nodeId = String(opts.query?.nodeId ?? '');
      if (nodeId === 'T2') {
        return ok({ rows: [{ id: 'r1', pNodeId: 'T2' }, { id: 'r2', pNodeId: 'T2' }] });
      }
      return ok({ rows: [] });
    }
    if (path.endsWith('/node/save')) return ok({ state: true });
    if (path.endsWith('/node/delete')) return ok({ state: true });
    return ok({});
  });
  const rep = await FLOW.upsertNodeProps(client, {
    appId: 'esb', processId: 'p1',
    nodes: ['T1', 'T2', 'T3'].map((nodeId) => ({ nodeId, nodeType: 'apiNode', props: { x: 1 } })),
  });
  assert.deepEqual(rep.inserted, ['T1', 'T3']);
  assert.deepEqual(rep.updated, ['T2']);
  assert.deepEqual(rep.deduped, ['T2']);
});

// ---------------- 快照 / 回滚边界 ----------------

test('saveNodePropsComplete：不传 dryRun 时按 dry-run 处理', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client, calls } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processModel: JSON.stringify(MODEL) }),
    }));
    const rep = await FLOW.saveNodePropsComplete(client, {
      appId: 'esb', processId: 'p1',
      nodes: [{ nodeId: 'T00001', nodeType: 'apiNode', props: { apiUrl: 'u' } }],
    });
    assert.equal(rep.snapshotFile, undefined);
    assert.equal(calls.some((c) => c.path.endsWith('/node/save') && c.opts.dryRun === true), true);
    home.cleanup();
  });
});

test('captureFlowSnapshot：详情用 model 字段也能拿到图模型', async () => {
  const home = tmpDir('rc-snap-');
  const { client } = stub(baseRoutes({ '/process/p1': ok({ id: 'm1', model: MODEL }) }));
  const res = await FLOW.captureFlowSnapshot(client, 'esb', 'p1', { dir: home.dir });
  assert.deepEqual(res.snapshot.nodes, ['E00001', 'T00001', 'E00002']);
  assert.deepEqual(res.snapshot.routers, ['R00001', 'R00002']);
  home.cleanup();
});

test('captureFlowSnapshot：processModel 是对象时直接使用', async () => {
  const home = tmpDir('rc-snap-');
  const { client } = stub(baseRoutes({ '/process/p1': ok({ id: 'm1', processModel: MODEL }) }));
  const res = await FLOW.captureFlowSnapshot(client, 'esb', 'p1', { dir: home.dir });
  assert.deepEqual(res.snapshot.model, MODEL);
  assert.deepEqual(res.snapshot.nodes, ['E00001', 'T00001', 'E00002']);
  home.cleanup();
});

test('captureFlowSnapshot：图里只有连线时节点为空', async () => {
  const home = tmpDir('rc-snap-');
  const { client } = stub(baseRoutes({
    '/process/p1': ok({ id: 'm1', processModel: JSON.stringify({ linkDataArray: [{ routerId: 'R1' }] }) }),
  }));
  const res = await FLOW.captureFlowSnapshot(client, 'esb', 'p1', { dir: home.dir });
  assert.deepEqual(res.snapshot.nodes, []);
  assert.deepEqual(res.snapshot.routers, ['R1']);
  home.cleanup();
});

test('captureFlowSnapshot：图里只有节点时连���为空', async () => {
  const home = tmpDir('rc-snap-');
  const { client } = stub(baseRoutes({
    '/process/p1': ok({ id: 'm1', processModel: JSON.stringify({ nodeDataArray: [{ key: 'T1', nodeType: 'apiNode' }] }) }),
  }));
  const res = await FLOW.captureFlowSnapshot(client, 'esb', 'p1', { dir: home.dir });
  assert.deepEqual(res.snapshot.nodes, ['T1']);
  assert.deepEqual(res.snapshot.routers, []);
  home.cleanup();
});

test('captureFlowSnapshot：ETL 没有图模型时不查询 router', async () => {
  const home = tmpDir('rc-snap-');
  const { client, calls } = stub(baseRoutes({ '/process/p1': ok({ id: 'm1', processId: 'p1' }) }));
  const res = await FLOW.captureFlowSnapshot(client, 'etl', 'p1', { dir: home.dir });
  assert.deepEqual(res.snapshot.nodes, ['T00001']);
  assert.deepEqual(res.snapshot.routers, []);
  assert.equal(calls.filter((c) => c.path.endsWith('/node/select')).length, 1);
  home.cleanup();
});

test('captureFlowSnapshot：失败响应没有 msg 时用状态码兜底', async () => {
  const { client } = stub(() => ({ ok: false, httpStatus: 503, data: {}, request: { method: 'GET', url: '/x' } }));
  await assert.rejects(
    () => FLOW.captureFlowSnapshot(client, 'esb', 'p1'),
    /快照失败：无法读取 esb\/p1（503）/,
  );
});

test('captureFlowSnapshot：详情为空数据体时按空对象处理', async () => {
  const home = tmpDir('rc-snap-');
  const { client } = stub(baseRoutes({ '/process/p1': rawOk(undefined) }));
  const res = await FLOW.captureFlowSnapshot(client, 'esb', 'p1', { dir: home.dir });
  assert.deepEqual(res.snapshot.detail, {});
  assert.deepEqual(res.snapshot.nodes, ['T00001']);
  home.cleanup();
});

test('restoreFlowSnapshot：快照没有 kind 时按 ESB 处理', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir }, async () => {
    const { client, calls } = stub(baseRoutes({ '/process/p1': ok({ id: 'm1' }) }));
    const snap: any = {
      version: 1, processId: 'p1', capturedAt: '', detail: {},
      model: MODEL, nodes: [], routers: [], props: {}, savedNodeSet: [],
    };
    const rep = await FLOW.restoreFlowSnapshot(client, snap);
    assert.equal(rep.ok, true);
    assert.ok(calls.some((c) => c.path === '/rest/esb/process/model/save'));
    home.cleanup();
  });
});

test('restoreFlowSnapshot：删除属性抛异常时记录失败但继续写回', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir }, async () => {
    const { client } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1' }),
      '/node/props': () => { throw new Error('属性读取异常'); },
    }));
    const snap: any = {
      version: 1, kind: 'esb', processId: 'p1', capturedAt: '', detail: {},
      model: MODEL, nodes: ['T00001'], routers: [], props: {}, savedNodeSet: [],
    };
    const rep = await FLOW.restoreFlowSnapshot(client, snap);
    assert.equal(rep.ok, false);
    assert.equal(rep.failed.length, 1);
    assert.equal(rep.failed[0].id, 'T00001');
    assert.match(rep.failed[0].msg ?? '', /属性读取异常/);
    home.cleanup();
  });
});

test('restoreFlowSnapshot：快照没有图模型时只恢复属性', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir }, async () => {
    const { client, calls } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1' }),
      '/node/props': ok({ id: 'r1', pNodeId: 'TX' }),
      '/node/save': ok({ state: true }),
    }));
    const snap: any = {
      version: 1, kind: 'esb', processId: 'p1', capturedAt: '', detail: {},
      nodes: ['TX'], routers: [], props: { TX: { id: 'r1', pNodeId: 'TX', apiUrl: 'u' } },
    };
    const rep = await FLOW.restoreFlowSnapshot(client, snap);
    assert.equal(rep.modelSaved, undefined);
    assert.equal(calls.some((c) => c.path.endsWith('/model/save')), false);
    // 图里没有该节点 → nodeType 兜底 unknown
    const save = calls.find((c) => c.path.endsWith('/node/save'))!;
    assert.equal((save.opts.body as any).pNodeType, 'unknown');
    assert.deepEqual(rep.restored, ['TX']);
    // 平台一直读不到 → 校验会补写，报告里能看到补写与仍然缺失的节点
    assert.ok(Array.isArray(rep.rewritten));
    assert.equal(rep.verified?.expected, 1);
    home.cleanup();
  });
});

test('restoreFlowSnapshot：快照没有 savedNodeSet 时用图上的节点兜底', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir }, async () => {
    const { client } = stub(baseRoutes({ '/process/p1': ok({ id: 'm1' }) }));
    const snap: any = {
      version: 1, kind: 'esb', processId: 'p1', capturedAt: '', detail: {},
      model: MODEL, nodes: ['T00001'], routers: ['R00001'], props: {},
    };
    await FLOW.restoreFlowSnapshot(client, snap);
    assert.deepEqual(await FLOW.readSavedNodeSet('p1'), ['T00001', 'R00001']);
    home.cleanup();
  });
});

// ---------------- 完整保存边界 ----------------

test('saveFlowComplete：空图模型也能走完保存流程', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client, calls } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processModel: JSON.stringify(MODEL) }),
    }));
    const rep = await FLOW.saveFlowComplete(client, { processId: 'p1', model: {} });
    assert.equal(rep.ok, true);
    assert.deepEqual(rep.props, { inserted: [], updated: [], failed: [] });
    assert.ok(calls.some((c) => c.path.endsWith('/model/save')));
    home.cleanup();
  });
});

test('saveFlowComplete：连线缺 assertCondition 时用 0，补 condition 时原样带上', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const model = {
      nodeDataArray: [{ key: 'E00001', nodeType: 'start' }, { key: 'T00001', nodeType: 'apiNode' }],
      linkDataArray: [{ from: 'E00001', to: 'T00001', routerId: 'R00001', condition: 'x==1' }],
    };
    const { client, calls } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processModel: JSON.stringify(model) }),
      '/node/props/list': ok({ rows: [
        { pNodeId: 'E00001' },
        { pNodeId: 'T00001' },
        { pNodeId: 'R00001' },
      ] }),
    }));
    const rep = await FLOW.saveFlowComplete(client, { processId: 'p1', model });
    assert.equal(rep.ok, true);
    const batch = calls.find((c) => c.path.endsWith('/node/batch/save'))!;
    const router = (batch.opts.body as any[]).find((b) => b.pNodeId === 'R00001');
    assert.equal(router.assertCondition, '0');
    assert.equal(router.condition, 'x==1');
    home.cleanup();
  });
});

test('saveFlowComplete：既有属性没有 id 时不写 id，节点类型用图上的类型', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client, calls } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processModel: JSON.stringify(MODEL) }),
      '/node/props/list': ok({ rows: [
        { pNodeId: 'E00001' },
        { pNodeId: 'T00001' },
        { pNodeId: 'E00002' },
        { pNodeId: 'R00001' },
        { pNodeId: 'R00002' },
      ] }),
    }));
    const rep = await FLOW.saveFlowComplete(client, {
      processId: 'p1', model: MODEL,
      nodeProps: {
        T00001: { nodeType: 'apiNode', props: { apiUrl: 'u' } },
        R00001: { nodeType: 'router', props: { assertCondition: '2' } },
      },
    });
    assert.equal(rep.ok, true);
    const batch = calls.find((c) => c.path.endsWith('/node/batch/save'))!;
    const bodies = batch.opts.body as any[];
    assert.equal(bodies.find((b) => b.pNodeId === 'T00001').id, undefined);
    assert.equal(bodies.find((b) => b.pNodeId === 'E00001').pNodeType, 'start');
    assert.equal(bodies.find((b) => b.pNodeId === 'R00001').id, undefined);
    assert.equal(bodies.find((b) => b.pNodeId === 'R00001').assertCondition, '2');
    home.cleanup();
  });
});

test('saveFlowComplete：属性失败没有 msg 时报告显示占位符', async () => {
  const home = tmpDir('rc-home-');
  await withEnv({ RC_HOME: home.dir, RC_SNAPSHOT_DIR: home.dir }, async () => {
    const { client } = stub(baseRoutes({
      '/process/p1': ok({ id: 'm1', processModel: JSON.stringify(MODEL) }),
      '/node/batch/save': fail('批量失败', 500),
      '/node/save': () => ({ ok: false, httpStatus: 500, data: {}, request: { method: 'POST', url: '/x' } }),
    }));
    const rep = await FLOW.saveFlowComplete(client, { processId: 'p1', model: MODEL });
    assert.equal(rep.ok, false);
    assert.match(rep.msg ?? '', /节点属性保存失败：.*\(-[)]/);
    home.cleanup();
  });
});

// ---------------- 导出 / 必填项边界 ----------------

test('missingRequiredFields：模型没有 nodeDataArray 时返回空', () => {
  assert.deepEqual(FLOW.missingRequiredFields({}, {}, { apiNode: ['apiUrl'] }), []);
});

test('missingRequiredFields：节点缺 key / 缺 nodeType 时按空串处理', () => {
  const missing = FLOW.missingRequiredFields({
    nodeDataArray: [{ nodeType: 'apiNode' }, { key: 'T2' }],
  }, {}, { apiNode: ['apiUrl'] });
  assert.deepEqual(missing, ['.apiUrl']);
});

test('exportFlow：详情为空数据体时提示没有 processModel', async () => {
  const { client } = stub(baseRoutes({ '/process/p1': rawOk(undefined) }));
  const out = await FLOW.exportFlow(client, 'p1');
  assert.equal(out.ok, false);
  assert.match(out.msg ?? '', /没有 processModel/);
});

test('platformMissingRequired：模型没有 nodeDataArray 时返回空集合', async () => {
  const { client } = stub(baseRoutes({ '/process/p1': ok({ id: 'm1' }) }));
  const miss = await FLOW.platformMissingRequired(client, 'esb', 'p1', {});
  assert.equal(miss.size, 0);
});

test('platformMissingRequired：平台模型没有 nodeDataArray 时返回空集合', async () => {
  const { client } = stub(baseRoutes({
    '/process/p1': ok({ id: 'm1', processModel: JSON.stringify({}) }),
  }));
  const miss = await FLOW.platformMissingRequired(client, 'esb', 'p1', {
    nodeDataArray: [{ key: 'T1', nodeType: 'apiNode' }],
  });
  assert.equal(miss.size, 0);
});

test('platformMissingRequired：节点缺 key / 类型无必填规则时跳过', async () => {
  const { client } = stub(baseRoutes({
    '/process/p1': ok({
      id: 'm1',
      processModel: JSON.stringify({ nodeDataArray: [{ key: 'T1', nodeType: 'apiNode' }, { key: 'T9', nodeType: 'start' }] }),
    }),
    '/node/props/list': ok({ rows: [{ id: 'r1', pNodeId: 'T1' }] }),
  }));
  const miss = await FLOW.platformMissingRequired(client, 'esb', 'p1', {
    nodeDataArray: [
      { nodeType: 'apiNode' },   // 没有 key → 平台也没有 → 跳过
      { key: 'T9', nodeType: 'start' }, // start 没有必填规则 → 跳过
      { key: 'T8' },            // 没有 nodeType → 跳过
    ],
  });
  assert.equal(miss.size, 0);
});
