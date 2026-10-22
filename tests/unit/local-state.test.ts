/**
 * 本地状态清理：预览 vs 真删、保留期解析。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { pruneLocalState, parseAge, localStatePaths, auditFileSummary, trimAuditFile } from '../../packages/core/src/local-state.ts';
import { tmpDir } from './helpers.ts';

function seed(_root: string, ageDays: number) {
  const dir = tmpDir('rc-prune-');
  const home = dir.dir;
  const snaps = join(home, 'snapshots');
  const audit = join(home, 'audit');
  const nodes = join(home, 'flow-nodes');
  for (const d of [snaps, audit, nodes]) mkdirSync(d, { recursive: true });
  const old = new Date(Date.now() - ageDays * 86_400_000);
  writeFileSync(join(snaps, 'old.json'), 'x'.repeat(100));
  writeFileSync(join(audit, '2026-01.jsonl'), '{}\n'.repeat(10));
  writeFileSync(join(nodes, 'p1.json'), '[]');
  for (const f of [join(snaps, 'old.json'), join(audit, '2026-01.jsonl'), join(nodes, 'p1.json')]) {
    utimesSync(f, old, old);
  }
  return { home, snaps, audit, nodes, cleanup: () => dir.cleanup() };
}

test('pruneLocalState：预览只统计，不删文件', async () => {
  const s = seed('', 60);
  try {
    const res = await pruneLocalState({ home: s.home, snapshotDays: 30, auditDays: 30, nodeDays: 30 });
    assert.equal(res.snapshots.length, 1);
    assert.equal(res.audit.length, 1);
    assert.equal(res.flowNodes.length, 1);
    assert.ok(res.freedBytes >= 100);
    assert.equal(res.removedBytes, 0, '预览不该真删');
    assert.ok(existsSync(join(s.snaps, 'old.json')));
  } finally {
    s.cleanup();
  }
});

test('pruneLocalState：--apply 才删，且按各自保留期判断', async () => {
  const s = seed('', 60);
  try {
    // 只清快照（审计/节点保留期设成 365 天 → 不动）
    const res = await pruneLocalState({ home: s.home, snapshotDays: 30, auditDays: 365, nodeDays: 365, apply: true });
    assert.equal(res.snapshots.length, 1);
    assert.equal(res.audit.length, 0);
    assert.equal(res.flowNodes.length, 0);
    assert.equal(existsSync(join(s.snaps, 'old.json')), false);
    assert.ok(existsSync(join(s.audit, '2026-01.jsonl')));
    assert.ok(res.removedBytes > 0);
  } finally {
    s.cleanup();
  }
});

test('pruneLocalState：保留期内的文件不动', async () => {
  const s = seed('', 1);
  try {
    const res = await pruneLocalState({ home: s.home, snapshotDays: 30, auditDays: 30, nodeDays: 30 });
    assert.equal(res.snapshots.length, 0);
    assert.equal(res.audit.length, 0);
    assert.equal(res.flowNodes.length, 0);
  } finally {
    s.cleanup();
  }
});

test('保留期解析：30d / 12h / 数字 / 非法值', () => {
  const day = 86_400_000;
  assert.equal(parseAge('30d', 7), 30 * day);
  assert.equal(parseAge('12h', 7), 12 * 3_600_000);
  assert.equal(parseAge(3, 7), 3 * day);
  assert.equal(parseAge('乱写', 7), 7 * day);
  assert.equal(parseAge(undefined, 7), 7 * day);
});

test('本地路径解析：RC_HOME / RC_SNAPSHOT_DIR 优先', () => {
  const p = localStatePaths('/tmp/rc-home-x');
  assert.equal(p.home, '/tmp/rc-home-x');
  assert.equal(p.snapshots, join('/tmp/rc-home-x', 'snapshots'));
  assert.equal(p.audit, join('/tmp/rc-home-x', 'audit'));
  assert.equal(p.flowNodes, join('/tmp/rc-home-x', 'flow-nodes'));
});

test('审计文件：统计与按行裁剪', async () => {
  const s = seed('', 1);
  try {
    const files = await auditFileSummary(s.audit);
    assert.equal(files.length, 1);
    assert.equal(files[0].lines, 10);
    const removed = await trimAuditFile(join(s.audit, '2026-01.jsonl'), 3);
    assert.equal(removed, 7);
    const after = await auditFileSummary(s.audit);
    assert.equal(after[0].lines, 3);
  } finally {
    s.cleanup();
  }
});
