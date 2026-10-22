/**
 * 单测公用工具：桩客户端、临时目录、环境变量隔离。
 * 约定：所有单测都不触网，用 stub client 替换 RestCloudClient。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Call {
  path: string;
  opts: any;
}

/** 标准返回值（成功）。 */
export const ok = (data: unknown = {}) => ({
  ok: true, httpStatus: 200, data, request: { method: 'GET', url: '/x' },
});

/** 失败返回值。 */
export const fail = (msg = 'boom', httpStatus = 500, data: unknown = {}) => ({
  ok: false, httpStatus, msg, data, request: { method: 'GET', url: '/x' },
});

export type Handler = (path: string, opts: any, calls: Call[]) => any;

/**
 * 桩客户端：只实现 core 用到的接口（request / baseUrl / readOnly / setReauthorizer）。
 * handler 可以按 path 分支返回不同结果。
 */
export function stub(handler: Handler) {
  const calls: Call[] = [];
  const client: any = {
    baseUrl: 'https://example.test/restcloud',
    readOnly: false,
    calls,
    setReauthorizer(fn: () => Promise<void>) { this.reauthorizer = fn; },
    reauthorizer: undefined as undefined | (() => Promise<void>),
    async request(path: string, opts: any = {}) {
      calls.push({ path, opts });
      const r = handler(path, opts, calls);
      return typeof r === 'function' ? r(opts, calls) : r;
    },
  };
  return { client, calls };
}

/** 只按 path 关键字匹配的简单 handler。 */
export function byPath(map: Record<string, any>, fallback: any = ok()) {
  return (path: string) => {
    for (const [k, v] of Object.entries(map)) {
      if (path.includes(k)) return v;
    }
    return fallback;
  };
}

/** 临时目录（自动清理）。 */
export function tmpDir(prefix = 'rc-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    file: (name: string) => join(dir, name),
    write: (name: string, content: string) => {
      mkdirSync(dir, { recursive: true });
      const f = join(dir, name);
      writeFileSync(f, content, 'utf8');
      return f;
    },
    read: (name: string) => readFileSync(join(dir, name), 'utf8'),
    has: (name: string) => existsSync(join(dir, name)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 临时改环境变量，结束后还原。 */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 捕获 console 输出（CLI 单测用）。 */
export function captureLog<T>(fn: () => Promise<T> | T): Promise<{ result: T; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: any[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: any[]) => { err.push(a.map(String).join(' ')); };
  return Promise.resolve()
    .then(fn)
    .then((result) => {
      console.log = log;
      console.error = error;
      return { result, out: out.join('\n'), err: err.join('\n') };
    })
    .catch((e) => {
      console.log = log;
      console.error = error;
      throw e;
    });
}
