/**
 * L0 契约层：RestCloud iPaaS 客户端
 * 无第三方依赖（Node 18+ 原生 fetch），负责：认证 / Cookie 复用 / 幂等 / 审计 / dry-run
 */

import { createHash } from 'node:crypto';
import { RcError } from './errors.ts';
import { assertAllowedHost } from './security.ts';

export interface RcConfig {
  /** 平台根地址，例如 https://<your-host>/<app-path> */
  baseUrl: string;
  profile: 'dev' | 'uat' | 'prod';
  /** 审计日志目录，默认 ~/.rc/audit */
  auditDir?: string;
}

export interface ApiResult<T = any> {
  ok: boolean;
  errcode?: number;
  msg?: string;
  traceId?: string;
  data?: T;
  httpStatus: number;
  /**
   * 是否**只构造了请求、没有发送**（dry-run）。
   *
   * 必须显式给这个字段，**不能再用 `httpStatus === 0` 当 dry-run 的哨兵**：
   * 网络层失败（DNS 解析不了、连不上、超时）同样拿不到 HTTP 状态码，
   * 两者会撞在一起——于是"写操作根本没发出去"被当成 dry-run 打印 `[dry-run]` 并以 **0** 退出。
   * 那是明确的假成功：CI、Agent、运维脚本只看退出码就会判定成功；
   * 超时的情况下请求还可能已经到达平台并生效了。
   */
  dryRun?: boolean;
  /** 实际发出的请求（dry-run 时也返回，便于复核） */
  request: { method: string; url: string; body?: unknown };
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** 自定义请求头（覆盖默认 Content-Type，例如纯文本 body 的接口） */
  headers?: Record<string, string>;
  /** 写操作默认 true：只构造请求，不发送 */
  dryRun?: boolean;
  /** 幂等键；缺省按 method+path+body 规范化哈希生成 */
  idempotencyKey?: string;
  timeoutMs?: number;
  /** 内部：401 重授权后重试标记，调用方不要设置 */
  _retried?: boolean;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE']);

/** 把底层网络异常翻译成可行动的提示（区分地址错误 / 内网不可达 / 超时） */
/**
 * 服务端错误归一化：平台对"资源不存在/缺必填参数"等场景常直接返回 HTTP 500 且业务 msg 为空
 * （后端异常被框架兜底）。工具侧把这类响应转成可行动的消息，而不是把裸 500 抛给调用方。
 */
function normalizeServerError(httpStatus: number, traceId?: string): string | undefined {
  if (httpStatus < 500) return undefined;
  const t = traceId ? `，traceId=${traceId}（可提供给平台方定位）` : '';
  if (httpStatus === 500) {
    return `平台内部错误（HTTP 500）${t}。常见原因：请求的资源不存在、缺少必填参数、或平台服务异常；请检查请求参数后重试，若参数正确请携带 traceId 联系平台方`;
  }
  if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
    return `平台网关/服务暂不可用（HTTP ${httpStatus}）${t}。请稍后重试或检查平台运行状态`;
  }
  return `平台返回 HTTP ${httpStatus}${t}`;
}

export function describeNetworkError(e: any, url?: string): string {
  const code = e?.cause?.code ?? e?.code ?? '';
  const host = url ? (() => { try { return new URL(url).host; } catch { return url; } })() : '';
  const hint: Record<string, string> = {
    ENOTFOUND: '域名无法解析：请检查地址拼写与 DNS',
    EAI_AGAIN: '域名解析超时：检查 DNS/网络',
    ECONNREFUSED: '连接被拒绝：目标端口未开放或服务未启动',
    ECONNRESET: '连接被重置：可能被防火墙/代理中断，或需 VPN',
    ETIMEDOUT: '连接超时：目标可能仅内网可达（需 VPN）或网络不通',
    UND_ERR_CONNECT_TIMEOUT: '连接超时：检查目标地址与网络域',
    CERT_HAS_EXPIRED: '证书过期：检查平台证书或使用 http 内网地址',
    DEPTH_ZERO_SELF_SIGNED_CERT: '自签名证书：改用 http 或配置 NODE_EXTRA_CA_CERTS',
  };
  const base = e?.message ?? String(e);
  const extra = hint[code] ?? (code ? `（${code}）` : '');
  return `网络请求失败：${base}${extra}${host ? ` [${host}]` : ''}`;
}

/** 从请求体里挑出关键标识（processId/id/ids/configId…），用于审计可查。 */
const AUDIT_ARG_KEYS = ['processId', 'id', 'ids', 'configId', 'appId', 'applicationId', 'categoryId', 'name', 'processName'];
function auditArgs(body: unknown): Record<string, unknown> | undefined {
  let obj: any = body;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return undefined; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of AUDIT_ARG_KEYS) {
    const v = (obj as any)[k];
    if (v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120);
  }
  return Object.keys(out).length ? out : undefined;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`).join(',')}}`;
}

function fingerprint(method: string, path: string, body: unknown): string {
  const h = createHash('sha256');
  h.update(`${method}:${path}:${stableStringify(body ?? null)}`);
  return h.digest('hex').slice(0, 32);
}

export class RestCloudClient {
  private cookies = new Map<string, string>();
  private readonly base: string;
  private readonly cfg: RcConfig;

  constructor(cfg: RcConfig) {
    this.cfg = cfg;
    // 缺地址时不在构造期抛错（doctor 等只读命令仍要能启动），
    // 真正发请求时给出可行动提示，而不是让调用方在 .replace 上崩掉。
    const base = (cfg.baseUrl ?? '').trim();
    assertAllowedHost(base);
    this.base = base.replace(/\/+$/, '');
  }

  /** 只读 profile 判定：生产环境默认禁止写操作 */
  get readOnly(): boolean {
    return this.cfg.profile === 'prod' && process.env.RC_ALLOW_PROD_WRITE !== '1';
  }

  /** 供上传等特殊请求复用 */
  get baseUrl(): string {
    return this.base;
  }

  private reauthorizer?: () => Promise<void>;

  /** 注册 401 自动重授权（登录一次后重试） */
  setReauthorizer(fn: () => Promise<void>): void {
    this.reauthorizer = fn;
  }

  // ---------- 认证 ----------

  /** 账号密码登录，成功后持有 identitytoken Cookie */
  async loginByPassword(username: string, password: string): Promise<ApiResult> {
    return this.request('/rest/core/auth/login', {
      method: 'POST',
      body: { username, password },
      dryRun: false,
    });
  }

  /** token 直登（平台支持 GET 传入用户 token），适合服务账号与 CI */
  async loginByToken(token: string): Promise<ApiResult> {
    const res = await this.request('/rest/core/auth/login', {
      method: 'GET',
      query: { token },
      dryRun: false,
    });
    if (res.ok) this.cookies.set('identitytoken', token);
    return res;
  }

  async refreshToken(): Promise<ApiResult> {
    return this.request('/rest/core/auth/refreshToken', { method: 'POST', dryRun: false });
  }

  async session(): Promise<ApiResult> {
    return this.request('/rest/base/users/context', { method: 'GET', dryRun: false });
  }

  exportCookies(): Record<string, string> {
    return Object.fromEntries(this.cookies);
  }

  importCookies(c: Record<string, string>): void {
    for (const [k, v] of Object.entries(c)) this.cookies.set(k, v);
    const token = c['identitytoken'];
    // identitytoken 可能以 URL 编码形式存储，统一解码；非法编码（如 "100%"）不能抛 URIError。
    if (!token) return;
    let decoded: string;
    try {
      decoded = decodeURIComponent(token);
    } catch {
      return; // 保留原值，避免整个会话加载失败
    }
    if (decoded !== token) this.cookies.set('identitytoken', decoded);
  }

  // ---------- 请求 ----------

  async request<T = any>(path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
    if (!this.base) {
      throw new Error(
        '缺少目标地址：请设置 RC_BASE_URL（或 rc.targets.json / RC_TARGET），'
        + '例如 RC_BASE_URL=https://<host>/<context>。',
      );
    }
    const method = opts.method ?? 'GET';
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const isWrite = WRITE_METHODS.has(method);
    // 写操作默认 dry-run
    const dryRun = opts.dryRun ?? (isWrite && this.cfg.profile !== 'prod');

    if (isWrite && this.readOnly) {
      throw new Error(
        `[RC] profile=prod 为只读模式。如确需写入，请显式设置 RC_ALLOW_PROD_WRITE=1。`,
      );
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.cookies.size > 0) {
      headers['Cookie'] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.headers) Object.assign(headers, opts.headers);
    // 字符串 body 原样发送（平台部分接口要求裸文档/裸 JSON 字符串），其余走 JSON.stringify
    const bodyText =
      opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    if (isWrite) headers['X-Idempotency-Key'] = opts.idempotencyKey ?? fingerprint(method, path, opts.body);

    if (dryRun) {
      return {
        ok: true,
        httpStatus: 0,
        dryRun: true,
        msg: 'dry-run: 请求未发送',
        request: { method, url: url.toString(), body: opts.body },
      };
    }

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    let httpStatus = 0;
    let payload: any = null;
    let error: string | undefined;
    let headerTraceId: string | undefined;

    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: bodyText,
        signal: controller.signal,
        redirect: 'manual',
      });
      httpStatus = resp.status;
      headerTraceId = resp.headers.get('x-trace-id') ?? resp.headers.get('traceid') ?? undefined;
      this.captureCookies(resp);
      const text = await resp.text();
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = { raw: text.slice(0, 2000) };
      }
    } catch (e: any) {
      error = describeNetworkError(e, url.toString());
      // -1 = **网络层**失败（没拿到任何 HTTP 状态码）。刻意不用 0：
      // 0 是 dry-run 的取值，两者混在一起会让"请求根本没发出去"被当成"没打算发"。
      httpStatus = -1;
    } finally {
      clearTimeout(timer);
    }

    const platformMsg = error ?? payload?.msg;
    const result: ApiResult<T> = {
      ok: !error && httpStatus >= 200 && httpStatus < 300
        && payload?.state !== false && payload?.state !== 'false',
      httpStatus,
      errcode: payload?.errcode,
      // HTTP 5xx 时平台 msg 多为通用异常（如 "Service run exception"），对调用方不可行动 → 附归一化指引
      msg: httpStatus >= 500 && platformMsg
        ? `${platformMsg}${normalizeServerError(httpStatus, headerTraceId)}`
        : platformMsg ?? normalizeServerError(httpStatus, headerTraceId),
      traceId: payload?.traceId ?? headerTraceId,
      data: payload,
      request: { method, url: url.toString(), body: opts.body },
    };

    await this.audit(path, method, result, Date.now() - started, opts.body);

    // 401 自动重授权一次（会话过期/切换 target 场景）
    if (!result.ok && result.httpStatus === 401 && this.reauthorizer && !opts._retried) {
      try {
        await this.reauthorizer();
        return this.request<T>(path, { ...opts, _retried: true, dryRun: false });
      } catch {
        /* 重授权失败则返回原 401 */
      }
    }
    return result;
  }

  private captureCookies(resp: Response): void {
    const raw = resp.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const pair = line.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  // ---------- 审计 ----------

  private async audit(path: string, method: string, r: ApiResult, ms: number, body?: unknown): Promise<void> {
    try {
      const { appendFile, mkdir } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = this.cfg.auditDir ?? join(homedir(), '.rc', 'audit');
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${new Date().toISOString().slice(0, 7)}.jsonl`);
      const line = {
        ts: new Date().toISOString(),
        actor: process.env.RC_ACTOR ?? process.env.USER ?? 'unknown',
        profile: this.cfg.profile,
        method,
        path,
        status: r.httpStatus,
        ok: r.ok,
        errcode: r.errcode,
        traceId: r.traceId,
        ms,
        // 关键标识：回答"谁改了哪个流程"（不含请求体其它内容，避免落库敏感字段）
        ...(auditArgs(body) ? { args: auditArgs(body) } : {}),
      };
      await appendFile(file, JSON.stringify(line) + '\n', 'utf8');
    } catch (e) {
      // 非生产：审计失败不阻断主流程，但必须可见；
      // 生产：审计是合规前提，写不进去就说明这次写操作没有留痕 → 阻断。
      if (this.cfg.profile === 'prod') {
        throw new RcError('E_AUDIT', `审计写入失败，已阻断：${(e as Error).message}`, {
          detail: { path, method, status: r.httpStatus },
        });
      }
      console.error(`[RC] 审计写入失败（未阻断）：${(e as Error).message}`);
    }
  }
}

/** 便捷构造：从环境变量读取配置 */
export function createClient(partial?: Partial<RcConfig>): RestCloudClient {
  const baseUrl = partial?.baseUrl ?? process.env.RC_BASE_URL;
  if (!baseUrl) {
    throw new Error('缺少平台地址：请设置 RC_BASE_URL，或使用 rc.targets.json / --target 指定目标');
  }
  const profile = (partial?.profile ?? (process.env.RC_PROFILE as RcConfig['profile']) ?? 'uat') as RcConfig['profile'];
  return new RestCloudClient({ baseUrl, profile, auditDir: partial?.auditDir });
}
