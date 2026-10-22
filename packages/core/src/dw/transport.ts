/**
 * 数仓传输层：把 SQL 送到 FE 并拿回结构化结果。
 *
 * 两种实现，都是"自己实现"，不 shell 出官方 CLI：
 *
 *   http —— Doris FE REST：`POST /api/query/{catalog}/{db}`，Basic 认证，原生 fetch，零依赖。
 *           **请求体必须是 JSON `{"stmt": "<sql>"}`**（可选 `database` 字段），
 *           直接发裸 SQL 会被 FE 当 JSON 解析并回
 *           `Expected BEGIN_OBJECT but was STRING`（实测，code 500）——
 *           这个坑很隐蔽：报错看着像 SQL 语法问题，实际是 Content-Type/body 形状。
 *           **响应是位置式的 `result_set`**：
 *             `{ code, msg, data: { type: 'result_set', meta: [{name,type}], data: [[...]], time } }`
 *           列名只在 `meta` 里，行是数组的数组——这里统一转成行式，调用方不必关心。
 *           注意：该端点的写能力取决于 FE 配置，所以写操作前先由 `dw doctor` 探测，不假设它能跑 DDL。
 *
 *   cmd  —— 逃生通道：把 SQL 交给配置好的外部命令（模板里的 {sql} 占位），
 *           解析其 JSON 输出。argv 直传、**不经 shell**，因此不存在 shell 注入面。
 *
 * 传输层只管"送 SQL、取结果"；脱敏、只读闸门、行数上限都在 query.ts 做。
 */
import type { ResolvedWarehouseEnv } from './config.ts';
import { assertAllowedHost } from '../security.ts';
import { RcError } from '../errors.ts';

export interface QueryResult {
  ok: boolean;
  /** 列名（列顺序即响应顺序） */
  columns: string[];
  rows: Record<string, unknown>[];
  execTimeMs?: number;
  msg?: string;
  /** FE 返回的业务码（HTTP 信封里的 code） */
  code?: number;
  /** 实际发出的请求（dry-run / 排查用，**不含凭据**） */
  request: { method: string; url: string };
}

export interface TransportOptions {
  /** 超时；查询默认 60s，DDL/刷新可能很久，调用方按需放大 */
  timeoutMs?: number;
  /** 只构造请求不发送 */
  dryRun?: boolean;
}

export interface WarehouseTransport {
  readonly kind: 'http' | 'cmd';
  run(sql: string, opts?: TransportOptions): Promise<QueryResult>;
  /** 连通性/权限探测，供 doctor 使用 */
  probe(opts?: TransportOptions): Promise<QueryResult>;
  /** 面向输出的描述，**不含凭据** */
  describe(): Record<string, unknown>;
}

/**
 * Doris `result_set` → 行式 rows。
 * `meta` 给列名，`data` 是**数组的数组**（位置对应），不是列式对象——别按列式解析。
 */
export function resultSetToRows(data: unknown): { columns: string[]; rows: Record<string, unknown>[] } | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  if (d.type !== 'result_set' || !Array.isArray(d.data)) return undefined;
  const meta = Array.isArray(d.meta) ? (d.meta as { name?: string }[]) : [];
  const columns = meta.map((m, i) => String(m?.name ?? `col_${i}`));
  const rows = (d.data as unknown[][]).map((arr) => {
    const row: Record<string, unknown> = {};
    arr.forEach((v, i) => {
      row[columns[i] ?? `col_${i}`] = v;
    });
    return row;
  });
  return { columns, rows };
}

/** 列式 data → 行式 rows。列名从 data 的键取（FE 不单独回列清单）。 */
export function columnarToRows(data: unknown): { columns: string[]; rows: Record<string, unknown>[] } {
  if (Array.isArray(data)) {
    const rows = data as Record<string, unknown>[];
    return { columns: rows.length ? Object.keys(rows[0]) : [], rows };
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown[]>;
    const columns = Object.keys(obj);
    if (columns.length === 0) return { columns: [], rows: [] };
    const len = Math.max(...columns.map((c) => (Array.isArray(obj[c]) ? obj[c].length : 0)));
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < len; i++) {
      const row: Record<string, unknown> = {};
      for (const c of columns) row[c] = Array.isArray(obj[c]) ? obj[c][i] : undefined;
      rows.push(row);
    }
    return { columns, rows };
  }
  return { columns: [], rows: [] };
}

/**
 * 从任意"结果信封"里尽力取出 rows。
 * 顺序很重要：**先认 Doris 的 `result_set`**，再退到列式与 `{rows}/{data:[...]}`——
 * 把 `result_set` 当列式解析会得到 type/meta/data/time 四个假列。
 */
export function extractRows(payload: unknown): { columns: string[]; rows: Record<string, unknown>[] } {
  if (!payload || typeof payload !== 'object') return { columns: [], rows: [] };
  const p = payload as Record<string, unknown>;
  const rs = resultSetToRows(p.data);
  if (rs) return rs;
  if (Array.isArray(p.rows)) {
    const rows = p.rows as Record<string, unknown>[];
    const columns = Array.isArray(p.columns)
      ? (p.columns as unknown[]).map((c) => (typeof c === 'string' ? c : String((c as { name?: string })?.name ?? c)))
      : rows.length
        ? Object.keys(rows[0])
        : [];
    return { columns, rows };
  }
  if (Array.isArray(p.data)) {
    const rows = p.data as Record<string, unknown>[];
    return { columns: rows.length ? Object.keys(rows[0]) : [], rows };
  }
  if (p.data) return columnarToRows(p.data);
  return { columns: [], rows: [] };
}

/** 结果集耗时（毫秒），来自 `data.time`。 */
export function resultSetTimeMs(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const data = (payload as Record<string, unknown>).data;
  if (!data || typeof data !== 'object') return undefined;
  const t = (data as Record<string, unknown>).time;
  return typeof t === 'number' ? t : undefined;
}

/**
 * 失败时的可读原因。
 * FE 的 `msg` 常常只有一句 `"Error"`，**真正的 SQL 报错在 `data` 里**（字符串）：
 *   `{ msg: "Error", code: 1, data: "Failed to execute sql: ... mismatched input 'LIMIT' ..." }`
 * 只看 `msg` 等于什么都没看到——这条是实测踩出来的。
 */
export function envelopeError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const msg = typeof p.msg === 'string' ? p.msg.trim() : undefined;
  const detail = typeof p.data === 'string' ? p.data.replace(/\s+/g, ' ').trim() : undefined;
  if (detail && msg && msg !== 'Error' && msg !== 'success') return `${msg}: ${detail}`;
  if (detail) return detail;
  return msg;
}

/** 数据库上下文：未配置时落到 information_schema，配合三段式命名 internal.<db>.<table> 使用。 */
export function databaseContext(env: Pick<ResolvedWarehouseEnv, 'database'>): string {
  return env.database ?? 'information_schema';
}

export class HttpWarehouseTransport implements WarehouseTransport {
  readonly kind = 'http' as const;
  private readonly env: ResolvedWarehouseEnv;
  private readonly endpoint: { host: string; port: number };
  private readonly baseUrl: string;
  private readonly auth: string;
  private readonly database: string;

  constructor(env: ResolvedWarehouseEnv, endpoint: { host: string; port: number }) {
    this.env = env;
    this.endpoint = endpoint;
    this.baseUrl = `http://${endpoint.host}:${endpoint.port}`;
    this.database = databaseContext(env);
    this.auth = `Basic ${Buffer.from(`${env.user ?? ''}:${env.password ?? ''}`).toString('base64')}`;
  }

  private url(): string {
    return `${this.baseUrl}/api/query/${encodeURIComponent(this.env.catalog)}/${encodeURIComponent(this.database)}`;
  }

  async run(sql: string, opts: TransportOptions = {}): Promise<QueryResult> {
    const url = this.url();
    const request = { method: 'POST', url };
    if (opts.dryRun) return { ok: true, columns: [], rows: [], request, msg: 'dry-run：未发送' };

    // 目标地址白名单：只在用户显式配置了 RC_ALLOWED_HOSTS 时才拦截
    assertAllowedHost(this.baseUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
        // 必须发 JSON：裸 SQL 会被 FE 当 JSON 解析，回 "Expected BEGIN_OBJECT but was STRING"
        body: JSON.stringify({ stmt: sql }),
        signal: controller.signal,
      });
      const text = await res.text();
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new RcError('E_UPSTREAM', `FE 返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
      }
      const code = typeof payload.code === 'number' ? payload.code : undefined;
      // FE 的惯例：业务失败也回 HTTP 200，靠 code 判定（401 = 认证问题）
      const ok = res.ok && (code === undefined || code === 0);
      const msg = ok ? (typeof payload.msg === 'string' ? payload.msg : undefined) : envelopeError(payload);
      const { columns, rows } = ok ? extractRows(payload) : { columns: [], rows: [] };
      const execTimeMs = resultSetTimeMs(payload) ?? Date.now() - started;
      return { ok, columns, rows, msg, code, execTimeMs, request };
    } catch (e) {
      if (e instanceof RcError) throw e;
      const err = e as Error;
      if (err.name === 'AbortError') {
        throw new RcError(
          'E_UPSTREAM',
          `查询超时（${opts.timeoutMs ?? 60_000}ms）。长任务（刷新/DDL）请显式放大 --timeout。`,
        );
      }
      throw new RcError('E_UPSTREAM', `请求 FE 失败：${err.message}。若走隧道，先 'dw tunnel status' 确认转发可用。`);
    } finally {
      clearTimeout(timer);
    }
  }

  async probe(opts: TransportOptions = {}): Promise<QueryResult> {
    return this.run('SELECT VERSION() AS version', { timeoutMs: 15_000, ...opts });
  }

  describe(): Record<string, unknown> {
    return {
      transport: 'http',
      endpoint: `${this.endpoint.host}:${this.endpoint.port}`,
      catalog: this.env.catalog,
      database: this.database,
    };
  }
}

export type CmdRunner = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export class CmdWarehouseTransport implements WarehouseTransport {
  readonly kind = 'cmd' as const;
  private readonly env: ResolvedWarehouseEnv;
  private readonly runner: CmdRunner;

  constructor(env: ResolvedWarehouseEnv, runner: CmdRunner) {
    if (!env.cmd) throw new RcError('E_VALIDATION', 'transport=cmd 但未配置命令模板（DW_CMD 或配置里的 cmd）');
    this.env = env;
    this.runner = runner;
  }

  /** 模板按空白切分；{sql} 只作为**单个 argv 元素**替换，不经 shell。 */
  private invocation(sql: string): { cmd: string; args: string[] } {
    const parts = String(this.env.cmd).trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1).map((a) => a.replace(/\{sql\}/g, sql).replace(/\{env\}/g, this.env.name));
    if (!parts.slice(1).some((a) => a.includes('{sql}'))) args.push(sql);
    return { cmd, args };
  }

  async run(sql: string, opts: TransportOptions = {}): Promise<QueryResult> {
    const { cmd, args } = this.invocation(sql);
    const request = { method: cmd, url: args.map((a) => (a === sql ? '<sql>' : a)).join(' ') };
    if (opts.dryRun) return { ok: true, columns: [], rows: [], request, msg: 'dry-run：未执行' };

    const r = await this.runner(cmd, args, { timeoutMs: opts.timeoutMs ?? 60_000 });
    const raw = r.stdout.trim();
    if (r.code !== 0) {
      // 外部命令常把 SQL 错误写在 stdout，别只看 stderr
      const detail = (r.stderr || raw).trim().slice(0, 400);
      throw new RcError('E_UPSTREAM', `外部命令失败（退出码 ${r.code}）：${detail}`);
    }
    if (!raw) return { ok: true, columns: [], rows: [], request };

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      // 非 JSON 输出按纯文本结果处理（单列），保留原文便于排查
      const lines = raw.split('\n').filter(Boolean);
      return { ok: true, columns: ['result'], rows: lines.map((l) => ({ result: l })), request };
    }
    const envl = payload as Record<string, unknown>;
    const ok = envl.ok === undefined ? true : Boolean(envl.ok);
    const { columns, rows } = extractRows(payload);
    return {
      ok,
      columns,
      rows,
      msg: typeof envl.msg === 'string' ? envl.msg : undefined,
      execTimeMs: typeof envl.exec_time_ms === 'number' ? envl.exec_time_ms : undefined,
      request,
    };
  }

  async probe(opts: TransportOptions = {}): Promise<QueryResult> {
    return this.run('SELECT VERSION() AS version', { timeoutMs: 20_000, ...opts });
  }

  describe(): Record<string, unknown> {
    return { transport: 'cmd', env: this.env.name };
  }
}

/** 默认的命令运行器（cmd 传输用）。 */
export const defaultCmdRunner: CmdRunner = async (cmd, args, opts) => {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, opts.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${(e as Error).message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
};
