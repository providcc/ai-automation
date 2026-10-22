/**
 * 慢查询与 profile 诊断。
 *
 * 数据来源两处，职责不同：
 *   - **`__internal_schema.audit_log`**：查"哪些查询慢/失败"，带 query_time、scan_rows、
 *     peak_memory_bytes，按时间倒序翻。比 `SHOW QUERY PROFILE "/"` 好用得多——
 *     后者只回一串文件路径，且只在 FE 本地留最近若干条。
 *   - **`SHOW QUERY PROFILE "<path>"`**：取单条查询的完整 profile 文本。
 *     路径要先从 `SHOW QUERY PROFILE "/"` 的列表里按 query_id 找出来，不能自己拼。
 *
 * MV 改写诊断（对齐 doris-best-practices 的 `MaterializedViewRewriteFail`）：
 * EXPLAIN 里出现 `MaterializedViewRewriteFail` 就说明 CBO **看到了** MV 但没用它，
 * 后面跟的原因才是要看的；"看不见 MV"（压根没这条）是另一类问题。
 */
import type { WarehouseTransport } from './transport.ts';
import { maskDdlText } from './query.ts';
import { quoteLiteral } from './mv.ts';
import { RcError } from '../errors.ts';

// ─────────────────────────── 审计日志 ───────────────────────────

export interface QueryStat {
  queryId: string;
  time?: string;
  user?: string;
  db?: string;
  state?: string;
  errorCode?: string;
  /** FE 侧耗时（毫秒） */
  queryTimeMs?: number;
  scanRows?: number;
  scanBytes?: number;
  cpuTimeMs?: number;
  peakMemoryBytes?: number;
  sqlDigest?: string;
  /** SQL 原文；默认脱敏后返回 */
  stmt?: string;
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function pick(row: Record<string, unknown>, key: string): unknown {
  const hit = Object.keys(row).find((k) => k.toLowerCase() === key.toLowerCase());
  return hit ? row[hit] : undefined;
}

function toStat(row: Record<string, unknown>, raw: boolean): QueryStat {
  const stmt = pick(row, 'stmt') as string | undefined;
  return {
    queryId: String(pick(row, 'query_id') ?? ''),
    time: pick(row, 'time') as string | undefined,
    user: pick(row, 'user') as string | undefined,
    db: pick(row, 'db') as string | undefined,
    state: pick(row, 'state') as string | undefined,
    errorCode: pick(row, 'error_code') as string | undefined,
    queryTimeMs: num(pick(row, 'query_time')),
    scanRows: num(pick(row, 'scan_rows')),
    scanBytes: num(pick(row, 'scan_bytes')),
    cpuTimeMs: num(pick(row, 'cpu_time_ms')),
    peakMemoryBytes: num(pick(row, 'peak_memory_bytes')),
    sqlDigest: pick(row, 'sql_digest') as string | undefined,
    stmt: stmt === undefined ? undefined : raw ? stmt : maskDdlText(stmt).text,
  };
}

/** audit_log 的列集合随版本变化，按需降级取列——第一次失败就退到最小列集。 */
const AUDIT_COLUMNS_FULL = [
  'query_id', 'time', 'user', 'db', 'state', 'error_code',
  'query_time', 'scan_rows', 'scan_bytes', 'cpu_time_ms', 'peak_memory_bytes', 'sql_digest', 'stmt',
].join(', ');
const AUDIT_COLUMNS_MIN = 'query_id, time, user, db, state, query_time, stmt';

export interface ProfileListOptions {
  limit?: number;
  hours?: number;
  /** 只看慢于该毫秒数的 */
  minMs?: number;
  db?: string;
  user?: string;
  /** 只看失败的 */
  failedOnly?: boolean;
  raw?: boolean;
  timeoutMs?: number;
}

/** 最近查询列表（按耗时倒序，便于一眼看出谁在拖）。 */
export async function listQueryStats(
  transport: WarehouseTransport,
  opts: ProfileListOptions = {},
): Promise<QueryStat[]> {
  const limit = Number(opts.limit ?? 30);
  const hours = Number(opts.hours ?? 24);
  const where = [
    `time >= DATE_SUB(NOW(), INTERVAL ${hours} HOUR)`,
    'is_query = 1',
    opts.minMs !== undefined ? `query_time >= ${Number(opts.minMs)}` : undefined,
    opts.db ? `db = ${quoteLiteral(opts.db)}` : undefined,
    opts.user ? `user = ${quoteLiteral(opts.user)}` : undefined,
    opts.failedOnly ? `state = 'ERR'` : undefined,
  ]
    .filter(Boolean)
    .join(' AND ');

  const run = (cols: string) =>
    transport.run(
      `SELECT ${cols} FROM __internal_schema.audit_log WHERE ${where} ` +
        `ORDER BY query_time DESC LIMIT ${limit}`,
      { timeoutMs: opts.timeoutMs ?? 30_000 },
    );

  let res = await run(AUDIT_COLUMNS_FULL);
  if (!res.ok) {
    // 老版本没有 sql_digest / peak_memory_bytes 等列
    res = await run(AUDIT_COLUMNS_MIN);
  }
  if (!res.ok) {
    throw new RcError(
      'E_UPSTREAM',
      `读取 audit_log 失败：${res.msg ?? res.code}。` +
        '该表需要开启审计插件（FE 配置 audit_plugin_enabled=true）；未开启时改用 query_id 直接取 profile。',
    );
  }
  return res.rows.map((r) => toStat(r, Boolean(opts.raw)));
}

/**
 * 按 SQL 摘要找历史趋势（对齐官方 `profile history <sql_pattern>`）。
 * 用 `sql_digest` 做分组，避免同一模板的不同字面量被算成不同查询。
 */
export async function queryHistory(
  transport: WarehouseTransport,
  pattern: string,
  opts: { days?: number; limit?: number; timeoutMs?: number } = {},
): Promise<{ digest: string; runs: number; avgMs: number; maxMs: number; lastTime?: string; sample?: string }[]> {
  const days = Number(opts.days ?? 7);
  const limit = Number(opts.limit ?? 20);
  const like = quoteLiteral(`%${pattern}%`);
  const res = await transport.run(
    `SELECT sql_digest, COUNT(*) AS runs, AVG(query_time) AS avg_ms, MAX(query_time) AS max_ms, ` +
      `MAX(time) AS last_time, MIN(stmt) AS sample ` +
      `FROM __internal_schema.audit_log ` +
      `WHERE is_query = 1 AND time >= DATE_SUB(NOW(), INTERVAL ${days} DAY) AND stmt LIKE ${like} ` +
      `GROUP BY sql_digest ORDER BY max_ms DESC LIMIT ${limit}`,
    { timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!res.ok) throw new RcError('E_UPSTREAM', `查询 audit_log 历史失败：${res.msg ?? res.code}`);
  return res.rows.map((r) => ({
    digest: String(pick(r, 'sql_digest') ?? ''),
    runs: num(pick(r, 'runs')) ?? 0,
    avgMs: Math.round(num(pick(r, 'avg_ms')) ?? 0),
    maxMs: num(pick(r, 'max_ms')) ?? 0,
    lastTime: pick(r, 'last_time') as string | undefined,
    sample: (() => {
      const s = pick(r, 'sample') as string | undefined;
      return s === undefined ? undefined : maskDdlText(s).text;
    })(),
  }));
}

// ─────────────────────────── 单条 profile ───────────────────────────

/** 从 `SHOW QUERY PROFILE "/"` 的列表里按 query_id 找 profile 文件路径。 */
export async function findProfilePath(
  transport: WarehouseTransport,
  queryId: string,
  opts: { timeoutMs?: number } = {},
): Promise<string | undefined> {
  const res = await transport.run('SHOW QUERY PROFILE "/"', { timeoutMs: opts.timeoutMs ?? 30_000 });
  if (!res.ok) throw new RcError('E_UPSTREAM', `SHOW QUERY PROFILE 失败：${res.msg ?? res.code}`);
  for (const row of res.rows) {
    for (const v of Object.values(row)) {
      const s = String(v ?? '');
      if (s.includes(queryId)) return s.startsWith('/') ? s : `/${s}`;
    }
  }
  return undefined;
}

/** 取单条查询的完整 profile 文本（默认脱敏）。 */
export async function getProfileText(
  transport: WarehouseTransport,
  queryId: string,
  opts: { raw?: boolean; timeoutMs?: number } = {},
): Promise<{ queryId: string; path?: string; text: string; masked: number }> {
  const path = await findProfilePath(transport, queryId, opts);
  if (!path) {
    throw new RcError(
      'E_UPSTREAM',
      `FE 上没有 ${queryId} 的 profile 文件。` +
        'profile 只在 FE 本地保留有限条数（enable_profile 未开时仅保留慢查询），过期即无。',
    );
  }
  const res = await transport.run(`SHOW QUERY PROFILE ${quoteLiteral(path)}`, {
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  if (!res.ok) throw new RcError('E_UPSTREAM', `读取 profile 失败：${res.msg ?? res.code}`);
  const text = res.rows.map((r) => String(Object.values(r)[0] ?? '')).join('\n');
  if (opts.raw) return { queryId, path, text, masked: 0 };
  const m = maskDdlText(text);
  return { queryId, path, text: m.text, masked: m.hits };
}

// ─────────────────────────── 对比 ───────────────────────────

export interface ProfileDiffLine {
  kind: 'same' | 'only-a' | 'only-b';
  text: string;
}

/** profile 里带时间戳/耗时的行永远不同，比对前先抹掉这些易变数字。 */
export function normalizeProfileText(text: string): string[] {
  return String(text ?? '')
    .split('\n')
    .map((l) =>
      l
        .replace(/\d+(\.\d+)?(us|ms|ns|s)\b/g, '<t>')
        .replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?\b/g, '<ts>')
        .replace(/\b\d{6,}\b/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

/**
 * 快慢两次 profile 的行级差异。
 * 只看"结构差异"——算子数量、是否落盘、是否被改写——而不是数字大小。
 */
export function diffProfiles(a: string, b: string, opts: { limit?: number } = {}): ProfileDiffLine[] {
  const la = normalizeProfileText(a);
  const lb = normalizeProfileText(b);
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  for (const l of la) countA.set(l, (countA.get(l) ?? 0) + 1);
  for (const l of lb) countB.set(l, (countB.get(l) ?? 0) + 1);

  const keys = [...new Set([...countA.keys(), ...countB.keys()])];
  const out: ProfileDiffLine[] = [];
  for (const k of keys) {
    const ca = countA.get(k) ?? 0;
    const cb = countB.get(k) ?? 0;
    if (ca === cb) {
      if (ca > 0) out.push({ kind: 'same', text: k });
    } else if (ca > cb) {
      out.push({ kind: 'only-a', text: `${k}${ca > 1 ? `  ×${ca - cb}` : ''}` });
    } else {
      out.push({ kind: 'only-b', text: `${k}${cb > 1 ? `  ×${cb - ca}` : ''}` });
    }
  }
  return out.slice(0, opts.limit ?? 400);
}

// ─────────────────────────── MV 改写诊断 ───────────────────────────

export interface MvRewriteDiagnosis {
  /** EXPLAIN 里是否提到物化视图 */
  mentioned: boolean;
  /** 是否被成功改写（命中） */
  rewritten: boolean;
  /** 失败原因原文（来自 MaterializedViewRewriteFail 等行） */
  reasons: string[];
  hint?: string;
}

/**
 * 从 EXPLAIN 文本里判断 MV 是否被 CBO 命中。
 * 关键区分：**"看见但没用"（有 RewriteFail 原因）与"压根没看见"**——
 * 前者改谓词/加物化视图就能解，后者要查 MV 状态或聚合上卷能力。
 */
export function diagnoseMvRewrite(explainText: string): MvRewriteDiagnosis {
  const text = String(explainText ?? '');
  const mentioned = /materialized\s*view|MaterializedView/i.test(text);
  const reasons = extractRewriteFailures(text);
  const rewritten = /MaterializedViewRewriteSuccess|RewriteSuccess|materialized_view\s*=\s*\S+/i.test(text) && reasons.length === 0;

  const diag: MvRewriteDiagnosis = { mentioned, rewritten, reasons };
  if (rewritten) diag.hint = 'MV 已被命中：性能问题不在改写，去 profile 里看算子。';
  else if (reasons.length) {
    diag.hint =
      'CBO 看到了 MV 但没用：常见原因是谓词不可推导（如日期函数包了列）、聚合无法上卷、' +
      '或 MV 的 State 不是 NORMAL。先 dw mv list --abnormal 看状态，再对失败原因逐条比谓词。';
  } else if (!mentioned) {
    diag.hint =
      'EXPLAIN 里完全没提物化视图：CBO 根本没看到候选。查 mv_infos 确认 State=NORMAL / RefreshState=SUCCESS，' +
      '并确认查询的表与 MV 的基表在同一 catalog/库。';
  } else {
    diag.hint = 'EXPLAIN 提到了物化视图但没有改写结论行：把完整 EXPLAIN（不加 ESTIMATE）贴出来看。';
  }
  return diag;
}

/**
 * 抽取改写失败原因。
 * **原因在标题行的下一行**（`FailSummary: ...`），只留标题等于什么都没说——
 * 实测形态：
 *   MaterializedViewRewriteFail:
 *     internal.<db>.<mv> fail,
 *     FailSummary: View original struct info is invalid
 * 所以要把标题之后的缩进续行一并收进来，直到空行或下一段。
 */
export function extractRewriteFailures(explainText: string, limit = 20): string[] {
  const lines = String(explainText ?? '').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i];
    if (!/MaterializedViewRewriteFail|RewriteFail|MV\s*rewrite\s*fail/i.test(line)) continue;
    const block: string[] = [line.replace(/\s+/g, ' ').trim()];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next.trim()) break;
      // 撞上新的标题行就停，交给外层循环处理
      if (/MaterializedViewRewriteFail|RewriteFail/i.test(next)) break;
      block.push(next.trim());
      i = j;
    }
    out.push(block.join(' ').replace(/\s+/g, ' ').trim());
  }
  return out;
}
