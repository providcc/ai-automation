import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { snapshotHome, snapshot, restore } from '../../packages/core/src/snapshot.ts';
import { RcError } from '../../packages/core/src/errors.ts';
import { stub, ok, fail, tmpDir, withEnv } from './helpers.ts';

test('snapshotHome：显式目录优先', () => {
  assert.equal(snapshotHome('/tmp/explicit-dir'), '/tmp/explicit-dir');
});

test('snapshotHome：RC_SNAPSHOT_DIR 可覆盖默认目录', async () => {
  await withEnv({ RC_SNAPSHOT_DIR: '/tmp/env-snapshots', RC_HOME: '/tmp/env-home' }, () => {
    assert.equal(snapshotHome(), '/tmp/env-snapshots');
  });
});

test('snapshotHome：RC_HOME 决定默认快照根目录', async () => {
  await withEnv({ RC_SNAPSHOT_DIR: undefined, RC_HOME: '/tmp/env-home' }, () => {
    assert.equal(snapshotHome(), join('/tmp/env-home', 'snapshots'));
  });
});

test('snapshotHome：无环境变量时落到 ~/.rc/snapshots', async () => {
  await withEnv({ RC_SNAPSHOT_DIR: undefined, RC_HOME: undefined }, () => {
    assert.equal(snapshotHome(), join(homedir(), '.rc', 'snapshots'));
  });
});

test('snapshot：快照写入目标目录且文件权限为 0600', async () => {
  const tmp = tmpDir('rc-snapshot-');
  try {
    const target = join(tmp.dir, 'snapshots');
    const { client, calls } = stub(() => ok({ data: { id: 'api-1', servicePath: '/a' } }));
    const out = await snapshot(client, 'api', 'api-1', target);
    assert.equal(calls[0].path, '/rest/core/services/api-1');
    assert.equal(calls[0].opts.method, 'GET');
    assert.ok(out.file.startsWith(target + '/api-api-1-'), out.file);
    assert.ok(out.file.endsWith('.json'));
    assert.equal(out.snapshot.kind, 'api');
    assert.equal(out.snapshot.id, 'api-1');
    assert.equal((out.snapshot.data as any).servicePath, '/a');
    assert.ok(typeof out.snapshot.capturedAt === 'string' && out.snapshot.capturedAt.length > 0);

    const st = statSync(out.file);
    assert.equal(st.mode & 0o077, 0, '快照文件不得有组/其他用户权限');
    assert.equal(st.mode & 0o600, 0o600, '快照文件必须是 0600（属主可读写）');
    const dirStat = statSync(target);
    assert.equal(dirStat.mode & 0o077, 0, '快照目录不得有组/其他用户权限');
    assert.equal(dirStat.mode & 0o700, 0o700, '快照目录必须是 0700');

    const content = JSON.parse(tmp.read('snapshots/' + out.file.slice(target.length + 1)));
    assert.equal(content.kind, 'api');
    assert.equal(content.id, 'api-1');
    assert.deepEqual(content.data, { id: 'api-1', servicePath: '/a' });
  } finally {
    tmp.cleanup();
  }
});

test('snapshot：数据无 data 包装时直接取原数据', async () => {
  const tmp = tmpDir('rc-snapshot-');
  try {
    const { client } = stub(() => ok({ plain: true }));
    const out = await snapshot(client, 'esb', 'p1', tmp.dir);
    assert.deepEqual(out.snapshot.data, { plain: true });
  } finally {
    tmp.cleanup();
  }
});

test('snapshot：读取失败时抛 E_SNAPSHOT 且不落盘', async () => {
  const tmp = tmpDir('rc-snapshot-');
  try {
    const { client } = stub(() => ({ ...fail('服务不存在', 404), traceId: 'tr-2' }));
    await assert.rejects(
      () => snapshot(client, 'api', 'missing', tmp.dir),
      (e: any) => {
        assert.ok(e instanceof RcError);
        assert.equal(e.code, 'E_SNAPSHOT');
        assert.match(e.message, /快照失败：无法读取 api\/missing（服务不存在）/);
        assert.equal(e.traceId, 'tr-2');
        return true;
      },
    );
  } finally {
    tmp.cleanup();
  }
});

test('snapshot：读取失败且无 msg 时回落到 HTTP 状态码', async () => {
  const tmp = tmpDir('rc-snapshot-');
  try {
    const { client } = stub(() => ({ ok: false, httpStatus: 500, data: {}, request: { method: 'GET', url: '/x' } }));
    await assert.rejects(() => snapshot(client, 'etl', 'e1', tmp.dir), /快照失败：无法读取 etl\/e1（500）/);
  } finally {
    tmp.cleanup();
  }
});

test('snapshot：三类实体使用各自的详情端点', async () => {
  const tmp = tmpDir('rc-snapshot-');
  try {
    const { client, calls } = stub(() => ok({}));
    await snapshot(client, 'api', 'a1', tmp.dir);
    await snapshot(client, 'esb', 'e1', tmp.dir);
    await snapshot(client, 'etl', 't1', tmp.dir);
    assert.deepEqual(calls.map((c) => c.path), [
      '/rest/core/services/a1',
      '/rest/esb/process/e1',
      '/rest/etl/process/t1',
    ]);
  } finally {
    tmp.cleanup();
  }
});

test('restore：api 快照回滚到服务保存端点', async () => {
  const tmp = tmpDir('rc-snapshot-');
  try {
    const file = tmp.write('api.json', JSON.stringify({
      kind: 'api',
      id: 'api-1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      data: { id: 'api-1', servicePath: '/a' },
    }));
    const { client, calls } = stub(() => ok({ state: true }));
    const r = await restore(client, file);
    assert.equal(r.ok, true);
    assert.equal(calls[0].path, '/rest/core/services/save');
    assert.equal(calls[0].opts.method, 'POST');
    assert.deepEqual(calls[0].opts.body, { id: 'api-1', servicePath: '/a' });
    assert.equal(calls[0].opts.dryRun, false);
  } finally {
    tmp.cleanup();
  }
});

test('restore：esb 快照回滚图模型（对象序列化为字符串）', async () => {
  const tmp = tmpDir('rc-snapshot-');
  try {
    const model = { nodeDataArray: [{ nodeId: 'n1' }], linkDataArray: [] };
    const file = tmp.write('esb.json', JSON.stringify({
      kind: 'esb',
      id: 'p1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      data: { appId: 'app-1', processModel: model },
    }));
    const { client, calls } = stub(() => ok({ state: true }));
    await restore(client, file);
    assert.equal(calls[0].path, '/rest/esb/process/model/save');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.dryRun, false);
    assert.deepEqual(calls[0].opts.body, {
      appId: 'app-1',
      processId: 'p1',
      processModel: JSON.stringify(model),
    });
  } finally {
    tmp.cleanup();
  }
});

test('restore：etl 快照回滚到 ETL 模型保存端点', async () => {
  const tmp = tmpDir('rc-snapshot-');
  try {
    const file = tmp.write('etl.json', JSON.stringify({
      kind: 'etl',
      id: 't1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      data: { appId: 'app-2', processModel: '{"nodeDataArray":[]}' },
    }));
    const { client, calls } = stub(() => ok({ state: true }));
    await restore(client, file);
    assert.equal(calls[0].path, '/rest/etl/process/model/save');
    assert.deepEqual(calls[0].opts.body, {
      appId: 'app-2',
      processId: 't1',
      processModel: '{"nodeDataArray":[]}',
    });
  } finally {
    tmp.cleanup();
  }
});

test('restore：processModel 可从 data.processModel 嵌套层取到', async () => {
  const tmp = tmpDir('rc-snapshot-');
  try {
    const file = tmp.write('esb-nested.json', JSON.stringify({
      kind: 'esb',
      id: 'p2',
      capturedAt: '2026-01-01T00:00:00.000Z',
      data: { data: { processModel: { nodes: [] } } },
    }));
    const { client, calls } = stub(() => ok({ state: true }));
    await restore(client, file);
    assert.equal(calls[0].opts.body.processModel, JSON.stringify({ nodes: [] }));
    assert.equal(calls[0].opts.body.processId, 'p2');
  } finally {
    tmp.cleanup();
  }
});

test('restore：快照没有 processModel 时抛 E_SNAPSHOT', async () => {
  const tmp = tmpDir('rc-snapshot-');
  try {
    const file = tmp.write('esb-empty.json', JSON.stringify({
      kind: 'esb',
      id: 'p3',
      capturedAt: '2026-01-01T00:00:00.000Z',
      data: { appId: 'app-3' },
    }));
    const { client, calls } = stub(() => ok({ state: true }));
    await assert.rejects(
      () => restore(client, file),
      (e: any) => {
        assert.ok(e instanceof RcError);
        assert.equal(e.code, 'E_SNAPSHOT');
        assert.match(e.message, /快照中没有 processModel，无法回滚图模型/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  } finally {
    tmp.cleanup();
  }
});

test('restore：未知快照类型抛 E_SNAPSHOT', async () => {
  const tmp = tmpDir('rc-snapshot-');
  try {
    const file = tmp.write('weird.json', JSON.stringify({
      kind: 'workflow',
      id: 'x1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      data: {},
    }));
    const { client, calls } = stub(() => ok({ state: true }));
    await assert.rejects(
      () => restore(client, file),
      (e: any) => {
        assert.ok(e instanceof RcError);
        assert.equal(e.code, 'E_SNAPSHOT');
        assert.match(e.message, /未知快照类型：workflow/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  } finally {
    tmp.cleanup();
  }
});

test('snapshot → restore 闭环：快照文件可直接回滚', async () => {
  const tmp = tmpDir('rc-snapshot-');
  try {
    const target = join(tmp.dir, 'snapshots');
    const { client: c1 } = stub(() => ok({ data: { appId: 'app-9', processModel: { nodes: [{ id: 'n' }] } } }));
    const { file } = await snapshot(c1, 'esb', 'p9', target);
    const { client: c2, calls } = stub(() => ok({ state: true }));
    await restore(c2, file);
    assert.equal(calls[0].path, '/rest/esb/process/model/save');
    assert.equal(calls[0].opts.body.processId, 'p9');
    assert.equal(calls[0].opts.body.appId, 'app-9');
  } finally {
    tmp.cleanup();
  }
});
