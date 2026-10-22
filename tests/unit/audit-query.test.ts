/**
 * 审计查询：过滤、聚合、渲染。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readAuditEntries, tailAudit, summarizeAudit, formatAuditRow, parseTime, auditDir } from '../../packages/core/src/audit-query.ts';
import { tmpDir, withEnv } from './helpers.ts';

function seed(dir: string) {
  mkdirSync(dir, { recursive: true });
  const lines = [
    { ts: '2026-10-20T10:00:00.000Z', actor: 'alice', profile: 'uat', method: 'GET', path: '/rest/esb/process/list', status: 200, ok: true, ms: 12 },
    { ts: '2026-10-20T10:05:00.000Z', actor: 'alice', profile: 'uat', method: 'POST', path: '/rest/esb/process/model/save', status: 200, ok: true, ms: 30, args: { processId: 'p1' } },
    { ts: '2026-10-21T10:05:00.000Z', actor: 'bob', profile: 'uat', method: 'POST', path: '/rest/esb/process/delete', status: 200, ok: true, ms: 22, args: { ids: 'm1,p1' } },
    { ts: '2026-10-21T10:06:00.000Z', actor: 'bob', profile: 'uat', method: 'POST', path: '/rest/esb/process/save', status: 500, ok: false, errcode: 500, traceId: 't-1', ms: 44 },
  ];
  writeFileSync(join(dir, '2026-10.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  writeFileSync(join(dir, 'broken.jsonl'), 'not-json\n{"ts":"2026-10-21T10:07:00.000Z","actor":"c","method":"GET","path":"/x","status":200,"ok":true}\n', 'utf8');
}

test('审计查询：按时间/路径/操作者/写操作过滤', async () => {
  const dir = tmpDir('rc-audit-');
  try {
    seed(dir.dir);
    const all = await readAuditEntries({ dir: dir.dir });
    assert.equal(all.length, 5, '坏行应被跳过，其余都读出来');
    const writes = await readAuditEntries({ dir: dir.dir, writesOnly: true });
    assert.equal(writes.length, 3);
    const byActor = await readAuditEntries({ dir: dir.dir, actor: 'bob' });
    assert.equal(byActor.length, 2);
    const byPath = await readAuditEntries({ dir: dir.dir, path: '/model/save' });
    assert.equal(byPath.length, 1);
    const since = await readAuditEntries({ dir: dir.dir, since: '2026-10-21' });
    assert.equal(since.length, 3);
    const limited = await readAuditEntries({ dir: dir.dir, limit: 2 });
    assert.equal(limited.length, 2);
  } finally {
    dir.cleanup();
  }
});

test('审计 tail：返回最后 N 条（倒序）', async () => {
  const dir = tmpDir('rc-audit-');
  try {
    seed(dir.dir);
    const rows = await tailAudit({ dir: dir.dir, lines: 2 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ts, '2026-10-21T10:07:00.000Z', 'tail 应是倒序');
  } finally {
    dir.cleanup();
  }
});

test('审计聚合：按天/操作者/接口统计写操作与失败数', async () => {
  const dir = tmpDir('rc-audit-');
  try {
    seed(dir.dir);
    const entries = await readAuditEntries({ dir: dir.dir });
    const sum = summarizeAudit(entries);
    assert.equal(sum.total, 5);
    assert.equal(sum.writes, 3);
    assert.equal(sum.failures, 1);
    assert.equal(sum.byDay['2026-10-20'], 2);
    assert.equal(sum.byDay['2026-10-21'], 3);
    assert.equal(sum.byActor.alice, 2);
    assert.equal(sum.byActor.bob, 2);
    assert.deepEqual(sum.traceIds, ['t-1']);
    // 路径里的长 id 会被归一，便于按接口聚合
    assert.ok(Object.keys(sum.byPath).some((k) => k.includes('/rest/esb/process/save')));
  } finally {
    dir.cleanup();
  }
});

test('审计渲染：带出关键标识（谁改了哪个流程）', async () => {
  const dir = tmpDir('rc-audit-');
  try {
    seed(dir.dir);
    const entries = await readAuditEntries({ dir: dir.dir, path: '/model/save' });
    const line = formatAuditRow(entries[0]);
    assert.match(line, /alice/);
    assert.match(line, /processId=p1/);
  } finally {
    dir.cleanup();
  }
});

test('时间参数：24h/2d/ISO 都能解析', () => {
  const now = new Date('2026-10-21T12:00:00.000Z');
  assert.equal(parseTime('24h', now)?.toISOString(), '2026-10-20T12:00:00.000Z');
  assert.equal(parseTime('2d', now)?.toISOString(), '2026-10-19T12:00:00.000Z');
  assert.equal(parseTime('2026-10-20', now)?.toISOString(), '2026-10-20T00:00:00.000Z');
  assert.equal(parseTime(undefined), undefined);
  assert.equal(parseTime('乱写', now), undefined);
});

test('审计目录解析：RC_AUDIT_DIR 优先', async () => {
  await withEnv({ RC_AUDIT_DIR: '/tmp/rc-audit-x' }, () => {
    assert.equal(auditDir(), '/tmp/rc-audit-x');
  });
  await withEnv({ RC_AUDIT_DIR: undefined, RC_HOME: '/tmp/rc-home-x' }, () => {
    assert.equal(auditDir(), '/tmp/rc-home-x/audit');
  });
});
