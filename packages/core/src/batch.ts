/**
 * 通用批处理框架（v2 Phase 2.4）
 *
 * 目标：任何"批量写"都具备进度、重试、断点续跑、失败即停与部分回滚能力。
 * 设计为纯执行器：具体动作由调用方注入，便于 CLI/测试共用。
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface BatchItem {
  id: string;
  action?: string;
  [k: string]: unknown;
}

export interface BatchOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** 可选：该条成功后的撤销动作（失败即停时按逆序执行） */
  undo?: () => Promise<void>;
}

export type BatchExecutor<T extends BatchItem> = (item: T, ctx: { attempt: number; index: number }) => Promise<BatchOutcome>;

export interface BatchOptions {
  concurrency?: number;
  /** 失败后的额外重试次数（总尝试 = retry + 1） */
  retry?: number;
  retryDelayMs?: number;
  /** 失败即停：停止派发新任务，并对已完成项执行 undo */
  stopOnError?: boolean;
  /** 进度文件（JSONL）；存在时自动跳过已成功项，实现断点续跑 */
  progressFile?: string;
  /** 每条完成后回调（用于打印进度） */
  onProgress?: (done: number, total: number, item: BatchItem, outcome: BatchOutcome) => void;
}

export interface BatchItemResult {
  id: string;
  action?: string;
  ok: boolean;
  attempts: number;
  ms: number;
  error?: string;
  result?: unknown;
  skipped?: boolean;
}

export interface BatchReport {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  rolledBack: number;
  stopped: boolean;
  items: BatchItemResult[];
}

interface ProgressLine {
  id: string;
  ok: boolean;
  attempts: number;
  ms: number;
  error?: string;
}

async function readCompleted(progressFile?: string): Promise<Set<string>> {
  const done = new Set<string>();
  if (!progressFile) return done;
  try {
    const text = await readFile(progressFile, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as ProgressLine;
        if (p.ok) done.add(String(p.id));
      } catch {
        /* 半行/损坏行忽略，允许继续 */
      }
    }
  } catch {
    /* 文件不存在 = 首次运行 */
  }
  return done;
}

async function appendProgress(file: string | undefined, line: ProgressLine): Promise<void> {
  if (!file) return;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(line) + '\n', 'utf8');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 执行批处理。不会因单条失败抛出；错误汇总在 report 中。
 */
export async function runBatch<T extends BatchItem>(
  items: T[],
  executor: BatchExecutor<T>,
  opts: BatchOptions = {},
): Promise<BatchReport> {
  const startedAt = new Date().toISOString();
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 32));
  const retry = Math.max(0, opts.retry ?? 0);
  const retryDelayMs = Math.max(0, opts.retryDelayMs ?? 500);
  const completed = await readCompleted(opts.progressFile);
  const results: BatchItemResult[] = [];
  const undoStack: (() => Promise<void>)[] = [];
  let cursor = 0;
  let done = 0;
  let stopped = false;

  const runOne = async (item: T, index: number): Promise<BatchItemResult> => {
    const t0 = Date.now();
    let attempts = 0;
    let lastError: string | undefined;
    while (attempts <= retry) {
      attempts++;
      try {
        const out = await executor(item, { attempt: attempts, index });
        if (out.ok) {
          if (out.undo) undoStack.push(out.undo);
          const res: BatchItemResult = {
            id: item.id,
            action: item.action,
            ok: true,
            attempts,
            ms: Date.now() - t0,
            result: out.result,
          };
          await appendProgress(opts.progressFile, { id: res.id, ok: true, attempts, ms: res.ms });
          return res;
        }
        lastError = out.error ?? '执行失败';
      } catch (e) {
        lastError = (e as Error).message;
      }
      if (attempts <= retry) await sleep(retryDelayMs * attempts);
    }
    const res: BatchItemResult = {
      id: item.id,
      action: item.action,
      ok: false,
      attempts,
      ms: Date.now() - t0,
      error: lastError,
    };
    await appendProgress(opts.progressFile, { id: res.id, ok: false, attempts, ms: res.ms, error: res.error });
    return res;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      if (completed.has(item.id)) {
        results.push({ id: item.id, action: item.action, ok: true, attempts: 0, ms: 0, skipped: true });
        done++;
        opts.onProgress?.(done, items.length, item, { ok: true });
        continue;
      }
      const res = await runOne(item, index);
      results.push(res);
      done++;
      opts.onProgress?.(done, items.length, item, { ok: res.ok, error: res.error, result: res.result });
      if (!res.ok && opts.stopOnError) {
        stopped = true;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => worker()));

  let rolledBack = 0;
  if (stopped && opts.stopOnError) {
    for (const undo of undoStack.reverse()) {
      try {
        await undo();
        rolledBack++;
      } catch {
        /* 回滚失败不掩盖原始错误；报告里体现在 rolledBack 计数 */
      }
    }
  }

  results.sort((a, b) => items.findIndex((x) => x.id === a.id) - items.findIndex((x) => x.id === b.id));
  const failed = results.filter((r) => !r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  return {
    ok: failed === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    total: items.length,
    passed: results.filter((r) => r.ok && !r.skipped).length,
    failed,
    skipped,
    rolledBack,
    stopped,
    items: results,
  };
}

/** 生成续跑命令提示 */
export function resumeHint(progressFile: string): string {
  return `断点续跑：保留进度文件 ${progressFile}，再次执行同一命令即可跳过已成功项`;
}

/** 把报告落到文件（JSON） */
export async function saveBatchReport(file: string, report: BatchReport): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2) + '\n', 'utf8');
}
