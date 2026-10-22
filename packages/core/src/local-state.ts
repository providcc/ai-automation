/**
 * 本地状态清理：快照 / 审计 / 节点集合会无限增长，需要可预览、可执行的清理。
 * 只动本地文件，不触平台。
 */
import { readdir, stat, rm, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LocalStatePaths {
  home: string;
  snapshots: string;
  audit: string;
  flowNodes: string;
}

export function localStatePaths(home?: string): LocalStatePaths {
  // 显式指定 home 时，子目录一律从它派生（不受 RC_SNAPSHOT_DIR / RC_AUDIT_DIR 影响）；
  // 否则按 RC_HOME → RC_SNAPSHOT_DIR / RC_AUDIT_DIR 的环境变量优先级解析。
  if (home) {
    return {
      home,
      snapshots: join(home, 'snapshots'),
      audit: join(home, 'audit'),
      flowNodes: join(home, 'flow-nodes'),
    };
  }
  const h = process.env.RC_HOME ?? join(homedir(), '.rc');
  return {
    home: h,
    snapshots: process.env.RC_SNAPSHOT_DIR ?? join(h, 'snapshots'),
    audit: process.env.RC_AUDIT_DIR ?? join(h, 'audit'),
    flowNodes: join(h, 'flow-nodes'),
  };
}

export interface PruneCandidate {
  path: string;
  bytes: number;
  mtime: string;
}

export interface PruneResult {
  snapshots: PruneCandidate[];
  audit: PruneCandidate[];
  flowNodes: PruneCandidate[];
  freedBytes: number;
  removedBytes: number;
}

const DAY = 86_400_000;

/** 解析 '30d' / '12h' / 天数。 */
export function parseAge(input: string | number | undefined, fallbackDays: number): number {
  if (input === undefined) return fallbackDays * DAY;
  if (typeof input === 'number') return input * DAY;
  const m = /^(\d+)\s*([dhm])?$/i.exec(String(input).trim());
  if (!m) return fallbackDays * DAY;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'd').toLowerCase();
  return unit === 'h' ? n * 3_600_000 : unit === 'm' ? n * 60_000 : n * DAY;
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    const out: string[] = [];
    for (const n of names) {
      const p = join(dir, n);
      try {
        const st = await stat(p);
        if (st.isFile()) out.push(p);
      } catch { /* 忽略 */ }
    }
    return out;
  } catch {
    return [];
  }
}

async function collect(dir: string, olderThanMs: number, now: number): Promise<PruneCandidate[]> {
  const out: PruneCandidate[] = [];
  for (const p of await listFiles(dir)) {
    try {
      const st = await stat(p);
      if (now - st.mtimeMs > olderThanMs) {
        out.push({ path: p, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() });
      }
    } catch { /* 忽略 */ }
  }
  return out;
}

/**
 * 找出可以清理的本地文件（预览 + 执行同一套逻辑）。
 * @param apply true = 真删；false = 只统计
 */
export async function pruneLocalState(opts: {
  home?: string;
  snapshotDays?: string | number;
  auditDays?: string | number;
  nodeDays?: string | number;
  apply?: boolean;
  now?: number;
} = {}): Promise<PruneResult> {
  const paths = localStatePaths(opts.home);
  const now = opts.now ?? Date.now();
  const snapAge = parseAge(opts.snapshotDays, 30);
  const auditAge = parseAge(opts.auditDays, 90);
  const nodeAge = parseAge(opts.nodeDays, 30);

  const snapshots = await collect(paths.snapshots, snapAge, now);
  const audit = await collect(paths.audit, auditAge, now);
  const flowNodes = await collect(paths.flowNodes, nodeAge, now);
  const all = [...snapshots, ...audit, ...flowNodes];
  const freedBytes = all.reduce((s, x) => s + x.bytes, 0);

  let removedBytes = 0;
  if (opts.apply) {
    for (const c of all) {
      try {
        await rm(c.path, { force: true });
        removedBytes += c.bytes;
      } catch { /* 忽略单个失败 */ }
    }
  }
  return { snapshots, audit, flowNodes, freedBytes, removedBytes };
}

/** 审计日志按月分文件；裁剪时把超出保留期的整月文件删掉，其余原样保留（不做内容改写）。 */
export async function auditFileSummary(dir: string): Promise<{ file: string; bytes: number; lines: number }[]> {
  const out: { file: string; bytes: number; lines: number }[] = [];
  for (const p of await listFiles(dir)) {
    try {
      const st = await stat(p);
      const text = await readFile(p, 'utf8');
      out.push({ file: p, bytes: st.size, lines: text.split('\n').filter(Boolean).length });
    } catch { /* 忽略 */ }
  }
  return out;
}

/** 保留审计文件的最近 N 行（用于手工裁剪单个月份文件）。 */
export async function trimAuditFile(file: string, keepLines: number): Promise<number> {
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  if (lines.length <= keepLines) return 0;
  const kept = lines.slice(-keepLines);
  await writeFile(file, kept.join('\n') + '\n', 'utf8');
  return lines.length - kept.length;
}
