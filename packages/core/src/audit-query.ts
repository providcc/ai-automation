/**
 * 审计查询：把 jsonl 审计日志读出来、按条件过滤、聚合。
 * 目的："谁在什么时候改了哪个流程"可查（写入侧已记录 path / method / actor / traceId）。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AuditRecord {
  ts: string;
  actor?: string;
  profile?: string;
  method?: string;
  path?: string;
  status?: number;
  ok?: boolean;
  errcode?: number;
  traceId?: string;
  ms?: number;
  /** 写入侧记录的关键标识（processId / id / configId…），用于回答"改了哪个流程" */
  args?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface AuditQuery {
  /** 审计目录，默认 RC_AUDIT_DIR → RC_HOME/audit → ~/.rc/audit */
  dir?: string;
  /** 起始时间：Date 或 '24h' / '2d' / ISO 字符串 */
  since?: string | Date;
  until?: string | Date;
  /** 路径子串匹配 */
  path?: string;
  /** 操作者 */
  actor?: string;
  /** 只看写操作（POST/PUT/DELETE/PATCH） */
  writesOnly?: boolean;
  limit?: number;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/** 审计目录解析（与 client / doctor 保持一致） */
export function auditDir(dir?: string): string {
  if (dir) return dir;
  if (process.env.RC_AUDIT_DIR) return process.env.RC_AUDIT_DIR;
  const home = process.env.RC_HOME ?? join(homedir(), '.rc');
  return join(home, 'audit');
}

/** 解析时间参数：'24h' / '2d' / '30m' / ISO 字符串 */
export function parseTime(input: string | Date | undefined, now = new Date()): Date | undefined {
  if (input === undefined) return undefined;
  if (input instanceof Date) return input;
  const s = String(input).trim();
  const rel = /^(\d+)\s*(m|h|d)$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return new Date(now.getTime() - n * ms);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

async function auditFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((n) => n.endsWith('.jsonl'));
  const out: string[] = [];
  for (const f of files) {
    const p = join(dir, f);
    try {
      const st = await stat(p);
      if (st.isFile()) out.push(p);
    } catch { /* 读不到就跳过 */ }
  }
  return out.sort();
}

/** 读取并过滤审计记录（按时间升序）。 */
export async function readAuditEntries(q: AuditQuery = {}): Promise<AuditRecord[]> {
  const dir = auditDir(q.dir);
  const since = parseTime(q.since);
  const until = parseTime(q.until);
  const out: AuditRecord[] = [];
  for (const file of await auditFiles(dir)) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec: AuditRecord;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // 坏行不阻断
      }
      const ts = new Date(rec.ts ?? 0);
      if (since && ts < since) continue;
      if (until && ts > until) continue;
      if (q.path && !String(rec.path ?? '').includes(q.path)) continue;
      if (q.actor && !String(rec.actor ?? '').includes(q.actor)) continue;
      if (q.writesOnly && !WRITE_METHODS.has(String(rec.method ?? '').toUpperCase())) continue;
      out.push(rec);
    }
  }
  out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return q.limit && q.limit > 0 ? out.slice(-q.limit) : out;
}

/** 最后 N 条（时间倒序返回，方便 tail）。 */
export async function tailAudit(opts: { dir?: string; lines?: number } = {}): Promise<AuditRecord[]> {
  const all = await readAuditEntries({ dir: opts.dir });
  const n = Math.max(1, opts.lines ?? 20);
  return all.slice(-n).reverse();
}

export interface AuditSummary {
  total: number;
  writes: number;
  failures: number;
  byDay: Record<string, number>;
  byActor: Record<string, number>;
  byPath: Record<string, number>;
  /** 出现过的 traceId（便于和平台日志对账） */
  traceIds: string[];
}

/** 聚合：按天 / 操作者 / 路径前缀。 */
export function summarizeAudit(entries: AuditRecord[]): AuditSummary {
  const byDay: Record<string, number> = {};
  const byActor: Record<string, number> = {};
  const byPath: Record<string, number> = {};
  const traceIds: string[] = [];
  let writes = 0;
  let failures = 0;
  for (const e of entries) {
    const day = String(e.ts ?? '').slice(0, 10) || 'unknown';
    byDay[day] = (byDay[day] ?? 0) + 1;
    const actor = String(e.actor ?? 'unknown');
    byActor[actor] = (byActor[actor] ?? 0) + 1;
    // 路径归一：去掉 id 段，便于按接口聚合
    const p = String(e.path ?? '').replace(/\/[0-9a-f]{16,}/gi, '/:id');
    byPath[p] = (byPath[p] ?? 0) + 1;
    if (WRITE_METHODS.has(String(e.method ?? '').toUpperCase())) writes++;
    if (e.ok === false) failures++;
    if (e.traceId && !traceIds.includes(e.traceId)) traceIds.push(e.traceId);
  }
  return { total: entries.length, writes, failures, byDay, byActor, byPath, traceIds };
}

/** 一行渲染（表格用）。 */
export function formatAuditRow(e: AuditRecord): string {
  const ts = String(e.ts ?? '').replace('T', ' ').slice(0, 19);
  const method = String(e.method ?? '').padEnd(6);
  const status = String(e.status ?? '-').padStart(3);
  const actor = String(e.actor ?? '-').padEnd(10);
  const target = e.args && Object.keys(e.args).length
    ? Object.entries(e.args).map(([k, v]) => `${k}=${v}`).join(' ')
    : String(e.path ?? '');
  return `${ts} ${method} ${status} ${actor} ${target}`;
}
