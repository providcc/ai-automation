/**
 * 审计日志单测：文件 sink（脱敏/追加/strict 阻断）与内存 sink。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuditSink, MemoryAuditSink, type AuditEntry } from '../../packages/core/src/audit.ts';
import { tmpDir, withEnv } from './helpers.ts';

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    actor: 'tester',
    profile: 'dev',
    method: 'GET',
    path: '/rest/core/api/list',
    status: 200,
    ok: true,
    ms: 12,
    ...over,
  };
}

test('文件 sink：写入 jsonl 并追加时间戳', async () => {
  const dir = tmpDir('rc-audit-');
  try {
    const sink = new FileAuditSink({ dir: dir.dir });
    await sink.write(entry());
    await sink.write(entry({ path: '/rest/core/api/get', status: 404, ok: false, errcode: 40004 }));

    const files = readdirSync(dir.dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{4}-\d{2}\.jsonl$/);

    const lines = readFileSync(join(dir.dir, files[0]), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.actor, 'tester');
    assert.equal(first.profile, 'dev');
    assert.equal(first.method, 'GET');
    assert.equal(first.path, '/rest/core/api/list');
    assert.equal(first.status, 200);
    assert.equal(first.ok, true);
    assert.equal(first.ms, 12);
    assert.equal(typeof first.ts, 'string');

    const second = JSON.parse(lines[1]);
    assert.equal(second.path, '/rest/core/api/get');
    assert.equal(second.status, 404);
    assert.equal(second.ok, false);
    assert.equal(second.errcode, 40004);
  } finally {
    dir.cleanup();
  }
});

test('文件 sink：敏感字段被脱敏', async () => {
  const dir = tmpDir('rc-audit-');
  try {
    const sink = new FileAuditSink({ dir: dir.dir });
    await sink.write(entry({
      args: { password: 'p', token: 't', nested: { apiSecret: 's', keep: 'ok' } },
    } as Partial<AuditEntry>));
    const files = readdirSync(dir.dir);
    const line = JSON.parse(readFileSync(join(dir.dir, files[0]), 'utf8').trim());
    assert.equal(line.args.password, '***');
    assert.equal(line.args.token, '***');
    assert.equal(line.args.nested.apiSecret, '***');
    assert.equal(line.args.nested.keep, 'ok');
  } finally {
    dir.cleanup();
  }
});

test('文件 sink：默认目录为 ~/.rc/audit（HOME 可重定向）', async () => {
  const home = tmpDir('rc-home-');
  try {
    await withEnv({ HOME: home.dir }, async () => {
      const sink = new FileAuditSink();
      await sink.write(entry());
    });
    const files = readdirSync(join(home.dir, '.rc', 'audit'));
    assert.equal(files.length, 1);
    const line = JSON.parse(readFileSync(join(home.dir, '.rc', 'audit', files[0]), 'utf8').trim());
    assert.equal(line.actor, 'tester');
  } finally {
    home.cleanup();
  }
});

test('文件 sink：strict 模式写入失败时抛错', async () => {
  const dir = tmpDir('rc-audit-');
  try {
    const blocker = join(dir.dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    const sink = new FileAuditSink({ dir: join(blocker, 'sub'), strict: true });
    await assert.rejects(() => sink.write(entry()), /审计写入失败：/);
  } finally {
    dir.cleanup();
  }
});

test('文件 sink：非 strict 模式写入失败不抛错（不阻断主流程）', async () => {
  const dir = tmpDir('rc-audit-');
  try {
    const blocker = join(dir.dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    const sink = new FileAuditSink({ dir: join(blocker, 'sub') });
    await sink.write(entry());
  } finally {
    dir.cleanup();
  }
});

test('内存 sink：记录全部条目', async () => {
  const sink = new MemoryAuditSink();
  assert.equal(sink.entries.length, 0);
  await sink.write(entry({ path: '/a' }));
  await sink.write(entry({ path: '/b' }));
  assert.equal(sink.entries.length, 2);
  assert.equal(sink.entries[0].path, '/a');
  assert.equal(sink.entries[1].path, '/b');
});
