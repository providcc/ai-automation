/**
 * flow search 的样例注解：这些样例来自真实流程，但多半不能直接照抄。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchFlowsByNodeType } from '../../packages/core/src/flow-lifecycle.ts';
import { stub, ok } from './helpers.ts';

/** 造一个"列表 + 属性"的桩平台。 */
function platform(propsByFlow: Record<string, any>, listRows: any[] = [{ processId: 'p1', configId: 'C1', configName: '流程一' }]) {
  return stub((path, opts) => {
    if (path.includes('/process/list')) return ok({ rows: listRows });
    if (path.includes('/node/props/list')) {
      const pid = String(opts?.query?.processId ?? 'p1');
      return ok(propsByFlow[pid] ?? {});
    }
    if (path.includes('/process/p')) {
      return ok({ id: 'm1', processModel: { nodeDataArray: [{ key: 'T00001', nodeType: 'apiNode' }], linkDataArray: [] } });
    }
    if (path.includes('/core/services')) return ok({ rows: [], total: 0 });
    return ok({});
  });
}

test('flow search：样例主机与当前环境不一致时给出"勿照抄"提示', async () => {
  const { client } = platform({
    p1: { T00001: { pNodeId: 'T00001', pNodeType: 'apiNode', apiUrl: 'https://gateway.other-env.test/restcloud/x/y', apiId: 'a1' } },
  });
  const res = await searchFlowsByNodeType(client, { nodeType: 'apiNode' });
  assert.equal(res.hits.length, 1);
  const notes = res.hits[0].notes.join('\n');
  assert.match(notes, /主机是 gateway\.other-env\.test/);
  assert.match(notes, /与当前平台主机 .* 不同/);
  assert.match(notes, /照抄前先确认该主机在当前环境可达/);
});

test('flow search：占位符写法与"只给 apiId"的样例各有提示', async () => {
  const { client } = platform({
    p1: { T00001: { pNodeId: 'T00001', pNodeType: 'apiNode', apiUrl: '${#config.apiserver}/x/y' } },
    p2: { T00001: { pNodeId: 'T00001', pNodeType: 'apiNode', apiId: 'a2' } },
  }, [{ processId: 'p1', configId: 'C1' }, { processId: 'p2', configId: 'C2' }]);
  const res = await searchFlowsByNodeType(client, { nodeType: 'apiNode' });
  const all = res.hits.map((h) => h.notes.join('\n')).join('\n');
  assert.match(all, /apiUrl 是占位符写法/);
  assert.match(all, /样例只给了 apiId/);
  assert.match(all, /换环境时这个 id 会失效/);
});

test('flow search：本环境出现多个网关主机时提示别默认取第一个', async () => {
  const { client } = platform({
    p1: { T00001: { pNodeId: 'T00001', pNodeType: 'apiNode', apiUrl: 'https://gw-a.test/x' } },
    p2: { T00001: { pNodeId: 'T00001', pNodeType: 'apiNode', apiUrl: 'https://gw-b.test/x' } },
  }, [{ processId: 'p1', configId: 'C1' }, { processId: 'p2', configId: 'C2' }]);
  const res = await searchFlowsByNodeType(client, { nodeType: 'apiNode' });
  assert.deepEqual(res.hosts, ['gw-a.test', 'gw-b.test']);
  assert.match(res.hits[0].notes.join('\n'), /本环境出现多个网关主机/);
});

test('flow search：--check-registry 能发现"apiId 在当前环境查不到"', async () => {
  const { client } = stub((path) => {
    if (path.includes('/process/list')) return ok({ rows: [{ processId: 'p1', configId: 'C1' }] });
    if (path.includes('/node/props/list')) {
      return ok({ T00001: { pNodeId: 'T00001', pNodeType: 'apiNode', apiId: 'from-other-env' } });
    }
    if (path.includes('/process/p')) {
      return ok({ id: 'm1', processModel: { nodeDataArray: [{ key: 'T00001', nodeType: 'apiNode' }], linkDataArray: [] } });
    }
    if (path.includes('/core/services')) return ok({ rows: [{ id: 'known-api' }], total: 1 });
    return ok({});
  });
  const res = await searchFlowsByNodeType(client, { nodeType: 'apiNode', checkRegistry: true });
  assert.match(res.hits[0].notes.join('\n'), /apiId from-other-env 在当前环境的接口注册表里查不到/);
});
