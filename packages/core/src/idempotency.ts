/**
 * 幂等键：method + path + 规范化 body 的稳定哈希
 * 目的：重试不产生重复对象（见 plan §5.5）
 */
import { createHash } from 'node:crypto';

/** 递归按键名排序，消除字段顺序差异 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t === 'number' || t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

export function fingerprint(method: string, path: string, body?: unknown): string {
  const h = createHash('sha256');
  h.update(`${method.toUpperCase()}:${path}:${canonicalize(body ?? null)}`);
  return h.digest('hex').slice(0, 32);
}

/** 同一逻辑请求在多次重试中必须命中同一键 */
export function idempotencyKey(method: string, path: string, body?: unknown, explicit?: string): string {
  return explicit ?? fingerprint(method, path, body);
}
