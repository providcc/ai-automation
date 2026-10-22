/**
 * batch：通用批处理框架（并发 / 重试 / 断点续跑 / 失败即停 / 部分回滚）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runBatch, resumeHint, saveBatchReport } from '../../packages/core/src/batch.ts';
import { tmpDir } from './helpers.ts';

const items = (n: number, prefix = 'i') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, action: `act${i}` }));

test('batch：空列表返回空报告', async () => {
  const report = await runBatch([], async () => ({ ok: true }));
  assert.equal(report.total, 0);
  assert.equal(report.passed, 0);
  assert.equal(report.failed, 0);
  assert.equal(report.skipped, 0);
  assert.equal(report.ok, true);
  assert.equal(report.stopped, false);
  assert.deepEqual(report.items, []);
  assert.ok(report.startedAt);
  assert.ok(report.finishedAt);
});

test('batch：全部成功时逐条记录结果', async () => {
  const report = await runBatch(items(3), async (item, ctx) => {
    assert.equal(ctx.index >= 0, true);
    assert.equal(ctx.attempt, 1);
    return { ok: true, result: `done:${item.id}` };
  });
  assert.equal(report.ok, true);
  assert.equal(report.passed, 3);
  assert.equal(report.failed, 0);
  assert.equal(report.items.length, 3);
  assert.equal(report.items[0].id, 'i0');
  assert.equal(report.items[0].action, 'act0');
  assert.equal(report.items[0].result, 'done:i0');
  assert.equal(report.items[0].attempts, 1);
  assert.equal(report.items[0].ok, true);
});

test('batch：并发数受上限约束（最多同时执行 concurrency 条）', async () => {
  let active = 0;
  let maxActive = 0;
  const report = await runBatch(
    items(8),
    async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { ok: true };
    },
    { concurrency: 3 },
  );
  assert.equal(maxActive, 3);
  assert.equal(report.passed, 8);
});

test('batch：并发数小于 1 时按 1 处理', async () => {
  let active = 0;
  let maxActive = 0;
  await runBatch(
    items(4),
    async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { ok: true };
    },
    { concurrency: 0 },
  );
  assert.equal(maxActive, 1);
});

test('batch：失败重试后成功', async () => {
  const seen: number[] = [];
  const report = await runBatch(
    items(1),
    async (_item, ctx) => {
      seen.push(ctx.attempt);
      if (ctx.attempt < 3) return { ok: false, error: '暂时失败' };
      return { ok: true };
    },
    { retry: 2, retryDelayMs: 0 },
  );
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(report.ok, true);
  assert.equal(report.items[0].attempts, 3);
  assert.equal(report.items[0].ok, true);
});

test('batch：重试用尽后记为失败并保留错误文案', async () => {
  const report = await runBatch(
    items(1),
    async () => ({ ok: false, error: '永久失败' }),
    { retry: 1, retryDelayMs: 0 },
  );
  assert.equal(report.ok, false);
  assert.equal(report.failed, 1);
  assert.equal(report.items[0].error, '永久失败');
  assert.equal(report.items[0].attempts, 2);
});

test('batch：执行器没有返回错误文案时用默认文案', async () => {
  const report = await runBatch(items(1), async () => ({ ok: false }));
  assert.equal(report.items[0].error, '执行失败');
});

test('batch：执行器抛异常时错误来自异常信息', async () => {
  const report = await runBatch(items(1), async () => {
    throw new Error('炸了');
  });
  assert.equal(report.ok, false);
  assert.equal(report.items[0].error, '炸了');
});

test('batch：单条失败不影响其它条目', async () => {
  const report = await runBatch(items(3), async (item) => (item.id === 'i1' ? { ok: false, error: 'bad' } : { ok: true }));
  assert.equal(report.ok, false);
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 1);
  assert.equal(report.items[1].error, 'bad');
});

test('batch：失败即停时停止派发新任务并回滚已完成项', async () => {
  const undoOrder: string[] = [];
  const executed: string[] = [];
  const report = await runBatch(
    items(4),
    async (item) => {
      executed.push(item.id);
      if (item.id === 'i1') return { ok: false, error: 'boom' };
      return { ok: true, undo: async () => { undoOrder.push(item.id); } };
    },
    { concurrency: 1, stopOnError: true },
  );
  assert.equal(report.stopped, true);
  assert.equal(report.ok, false);
  assert.deepEqual(executed, ['i0', 'i1']);
  assert.deepEqual(undoOrder, ['i0']);
  assert.equal(report.rolledBack, 1);
});

test('batch：多个成功项按逆序回滚', async () => {
  const undoOrder: string[] = [];
  const report = await runBatch(
    items(4),
    async (item) => {
      if (item.id === 'i2') return { ok: false, error: 'boom' };
      return { ok: true, undo: async () => { undoOrder.push(item.id); } };
    },
    { concurrency: 1, stopOnError: true },
  );
  assert.equal(report.stopped, true);
  assert.deepEqual(undoOrder, ['i1', 'i0'], '回滚应按逆序');
  assert.equal(report.rolledBack, 2);
});

test('batch：回滚失败不掩盖原始错误', async () => {
  const report = await runBatch(
    items(2),
    async (item) => {
      if (item.id === 'i1') return { ok: false, error: 'boom' };
      return { ok: true, undo: async () => { throw new Error('回滚也失败'); } };
    },
    { concurrency: 1, stopOnError: true },
  );
  assert.equal(report.rolledBack, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.items[1].error, 'boom');
});

test('batch：进度文件写入成功记录并支持断点续跑', async () => {
  const tmp = tmpDir('rc-batch-');
  try {
    const progress = tmp.file('progress.jsonl');
    const first = await runBatch(items(3), async () => ({ ok: true }), { progressFile: progress });
    assert.equal(first.passed, 3);
    const raw = readFileSync(progress, 'utf8').trim().split('\n');
    assert.equal(raw.length, 3);
    assert.equal(JSON.parse(raw[0]).ok, true);

    const second = await runBatch(items(3), async () => ({ ok: true }), { progressFile: progress });
    assert.equal(second.skipped, 3);
    assert.equal(second.passed, 0);
    assert.equal(second.failed, 0);
    assert.equal(second.ok, true);
    assert.equal(second.items[0].skipped, true);
    assert.equal(second.items[0].attempts, 0);
  } finally {
    tmp.cleanup();
  }
});

test('batch：进度文件里的失败记录与损坏行会被忽略', async () => {
  const tmp = tmpDir('rc-batch-');
  try {
    const progress = tmp.write('progress.jsonl', '{"id":"i0","ok":true,"attempts":1,"ms":1}\nnot-json\n{"id":"i1","ok":false,"attempts":2,"ms":2}\n');
    const report = await runBatch(items(3), async (_item) => ({ ok: true }), { progressFile: progress });
    assert.equal(report.skipped, 1);
    assert.equal(report.passed, 2);
  } finally {
    tmp.cleanup();
  }
});

test('batch：进度文件不存在时视为首次运行', async () => {
  const tmp = tmpDir('rc-batch-');
  try {
    const report = await runBatch(items(1), async () => ({ ok: true }), { progressFile: tmp.file('missing.jsonl') });
    assert.equal(report.skipped, 0);
    assert.equal(report.passed, 1);
  } finally {
    tmp.cleanup();
  }
});

test('batch：onProgress 回调逐条汇报', async () => {
  const seen: [number, number, string][] = [];
  await runBatch(
    items(2),
    async () => ({ ok: true, result: 1 }),
    { onProgress: (done, total, item, outcome) => seen.push([done, total, String(item.id) + ':' + outcome.ok]) },
  );
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((s) => s[1]), [2, 2]);
  assert.ok(seen.every((s) => s[2].endsWith(':true')));
});

test('batch：onProgress 在跳过项时也会回调', async () => {
  const tmp = tmpDir('rc-batch-');
  try {
    const progress = tmp.write('progress.jsonl', '{"id":"i0","ok":true,"attempts":1,"ms":1}\n');
    const seen: string[] = [];
    const report = await runBatch(items(1), async () => ({ ok: true }), {
      progressFile: progress,
      onProgress: (_d, _t, item) => seen.push(item.id),
    });
    assert.equal(report.skipped, 1);
    assert.deepEqual(seen, ['i0']);
  } finally {
    tmp.cleanup();
  }
});

test('batch：resumeHint 与 saveBatchReport', async () => {
  const tmp = tmpDir('rc-batch-');
  try {
    const hint = resumeHint('/tmp/progress.jsonl');
    assert.ok(hint.includes('/tmp/progress.jsonl'));
    assert.ok(hint.includes('断点续跑'));

    const report = await runBatch(items(1), async () => ({ ok: true }));
    const file = tmp.file('report.json');
    await saveBatchReport(file, report);
    const saved = JSON.parse(tmp.read('report.json'));
    assert.equal(saved.total, 1);
    assert.equal(saved.ok, true);
    assert.ok(saved.finishedAt);
  } finally {
    tmp.cleanup();
  }
});
