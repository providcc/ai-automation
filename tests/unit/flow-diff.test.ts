/**
 * 语义 diff 与乐观并发保护（指纹）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffFlow, flowFingerprint, formatFlowDiff, businessProps } from '../../packages/core/src/flow-diff.ts';
import * as FLOW from '../../packages/core/src/flow-lifecycle.ts';
import { stub, ok, tmpDir, withEnv } from './helpers.ts';

const MODEL = {
  nodeDataArray: [
    { key: 'E00001', nodeType: 'start', text: '开始' },
    { key: 'T00001', nodeType: 'apiNode', text: '取数' },
    { key: 'E00002', nodeType: 'end', text: '结束' },
  ],
  linkDataArray: [
    { from: 'E00001', to: 'T00001', routerId: 'R00001', assertCondition: '0' },
    { from: 'T00001', to: 'E00002', routerId: 'R00002', assertCondition: '0' },
  ],
};

test('指纹：内容相同则相同，改动则不同；易变字段不影响', () => {
  const props = { T00001: { pNodeId: 'T00001', pNodeType: 'apiNode', apiUrl: 'https://x.test' } };
  const a = flowFingerprint({ model: MODEL, props });
  const b = flowFingerprint({
    model: MODEL,
    props: { T00001: { ...props.T00001, id: 'r1', editTime: '2026-01-01', creator: 'admin', appId: 'esb' } },
  });
  assert.equal(a, b, '平台易变字段不应影响指纹');
  const changed = flowFingerprint({
    model: MODEL,
    props: { T00001: { ...props.T00001, apiUrl: 'https://y.test' } },
  });
  assert.notEqual(a, changed, '业务字段变化必须改变指纹');
  const modelChanged = flowFingerprint({
    model: { ...MODEL, nodeDataArray: MODEL.nodeDataArray.map((n) => (n.key === 'T00001' ? { ...n, text: '改名' } : n)) },
    props,
  });
  assert.notEqual(a, modelChanged, '图变化必须改变指纹');
});

test('指纹：与 key 顺序无关（属性顺序变化不算改动）', () => {
  const p1 = { T00001: { pNodeId: 'T00001', apiUrl: 'u', methodType: 'GET' } };
  const p2 = { T00001: { methodType: 'GET', apiUrl: 'u', pNodeId: 'T00001' } };
  assert.equal(flowFingerprint({ model: MODEL, props: p1 }), flowFingerprint({ model: MODEL, props: p2 }));
});

test('语义 diff：列出新增/删除/变更的节点、连线、属性', () => {
  const current = {
    model: MODEL,
    props: { T00001: { pNodeId: 'T00001', pNodeType: 'apiNode', apiUrl: 'https://old.test' } },
  };
  const next = {
    model: {
      ...MODEL,
      nodeDataArray: [...MODEL.nodeDataArray, { key: 'T00002', nodeType: 'apiNode', text: '新增' }],
      linkDataArray: [...MODEL.linkDataArray, { from: 'E00002', to: 'T00002', routerId: 'R00003' }],
    },
    props: {
      T00001: { pNodeId: 'T00001', pNodeType: 'apiNode', apiUrl: 'https://new.test' },
      T00002: { pNodeId: 'T00002', pNodeType: 'apiNode', apiUrl: 'https://x.test' },
    },
  };
  const d = diffFlow(current, next);
  assert.deepEqual(d.nodes.added, ['T00002']);
  assert.deepEqual(d.nodes.removed, []);
  assert.deepEqual(d.links.added, ['R00003']);
  assert.deepEqual(d.props.added, ['T00002']);
  assert.deepEqual(d.props.changed, ['T00001']);
  assert.equal(d.empty, false);
  assert.match(d.summary, /节点 \+1/);
  const text = formatFlowDiff(d);
  assert.match(text, /节点：/);
  assert.match(text, /\+ 新增 T00002/);
  assert.match(text, /~ 变更 T00001/);
  assert.equal(formatFlowDiff(diffFlow(current, current)), '无变化');
});

test('语义 diff：删除的节点/连线/属性也会被列出', () => {
  const d = diffFlow({ model: MODEL, props: { T00001: { pNodeId: 'T00001' } } }, { model: { nodeDataArray: [], linkDataArray: [] }, props: {} });
  assert.deepEqual(d.nodes.removed, ['E00001', 'E00002', 'T00001']);
  assert.deepEqual(d.links.removed, ['R00001', 'R00002']);
  assert.deepEqual(d.props.removed, ['T00001']);
});

test('业务属性投影：剥掉平台易变字段', () => {
  const p = businessProps({ T00001: { id: 'r1', editTime: 'x', createTime: 'y', appId: 'esb', apiUrl: 'u' } });
  assert.deepEqual(p, { T00001: { apiUrl: 'u' } });
});

test('保存：平台状态与期望指纹不一致时拒绝写入（并发写保护）', async () => {
  const dir = tmpDir('rc-fp-');
  try {
    await withEnv({ RC_HOME: dir.dir, RC_SNAPSHOT_DIR: dir.dir }, async () => {
      const { client, calls } = stub((path) => {
        if (path.endsWith('/process/p1')) return ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) });
        if (path.endsWith('/node/props/list')) return ok({ T00001: { id: 'r1', pNodeId: 'T00001', pNodeType: 'apiNode', apiUrl: 'https://x.test' } });
        return ok({ state: true });
      });
      const rep = await FLOW.saveFlowComplete(client, {
        processId: 'p1', model: MODEL, nodeProps: { T00001: { pNodeId: 'T00001', pNodeType: 'apiNode', apiUrl: 'https://x.test' } },
        expectedFingerprint: 'deadbeefdeadbeef',
      });
      assert.equal(rep.ok, false);
      assert.equal(rep.fingerprint?.matched, false);
      assert.match(rep.msg ?? '', /已被修改/);
      // 拒绝发生在任何写操作之前
      assert.equal(calls.some((c) => c.path.endsWith('/node/save')), false);
      assert.equal(calls.some((c) => c.path.endsWith('/model/save')), false);
    });
  } finally {
    dir.cleanup();
  }
});

test('保存：--force 可以覆盖被改过的流程', async () => {
  const dir = tmpDir('rc-fp-');
  try {
    await withEnv({ RC_HOME: dir.dir, RC_SNAPSHOT_DIR: dir.dir }, async () => {
      const { client } = stub((path) => {
        if (path.endsWith('/process/p1')) return ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) });
        if (path.endsWith('/node/props/list')) {
          return ok({
            E00001: { id: 'e1', pNodeId: 'E00001', pNodeType: 'start' },
            E00002: { id: 'e2', pNodeId: 'E00002', pNodeType: 'end' },
            T00001: { id: 'r1', pNodeId: 'T00001', pNodeType: 'apiNode', apiUrl: 'https://x.test' },
            R00001: { id: 'q1', pNodeId: 'R00001', pNodeType: 'router' },
            R00002: { id: 'q2', pNodeId: 'R00002', pNodeType: 'router' },
          });
        }
        return ok({ state: true });
      });
      const rep = await FLOW.saveFlowComplete(client, {
        processId: 'p1', model: MODEL, nodeProps: { T00001: { pNodeId: 'T00001', pNodeType: 'apiNode', apiUrl: 'https://x.test' } },
        expectedFingerprint: 'deadbeefdeadbeef', force: true,
      });
      assert.equal(rep.ok, true);
      assert.equal(rep.fingerprint?.matched, true);
    });
  } finally {
    dir.cleanup();
  }
});

test('保存：dry-run 也会给出语义 diff（不改平台）', async () => {
  const dir = tmpDir('rc-fp-');
  try {
    await withEnv({ RC_HOME: dir.dir, RC_SNAPSHOT_DIR: dir.dir }, async () => {
      const { client, calls } = stub((path) => {
        if (path.endsWith('/process/p1')) return ok({ id: 'm1', processId: 'p1', processModel: JSON.stringify(MODEL) });
        if (path.endsWith('/node/props/list')) return ok({ T00001: { id: 'r1', pNodeId: 'T00001', pNodeType: 'apiNode', apiUrl: 'https://old.test' } });
        return ok({ state: true });
      });
      const rep = await FLOW.saveFlowComplete(client, {
        processId: 'p1', model: MODEL,
        nodeProps: { T00001: { pNodeId: 'T00001', pNodeType: 'apiNode', apiUrl: 'https://new.test' } },
        dryRun: true,
      });
      assert.equal(rep.ok, true);
      assert.deepEqual(rep.diff?.props.changed, ['T00001']);
      assert.equal(calls.some((c) => c.path.endsWith('/node/save')), false);
    });
  } finally {
    dir.cleanup();
  }
});
