/**
 * WP9.3 认证：密码（RSA PKCS1）/ token / cookie 持久化 / 刷新 / 双因子识别
 * 事实来源：core/login/Login.jsx（jse.encrypt + systemlogin:"1"）、PUBLIC.js: PublicKey
 */
import { createPublicKey, publicEncrypt, constants } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { RestCloudClient } from './client.ts';
import { RcError } from './errors.ts';

/** 平台前端内置公钥（core/constants/PUBLIC.js），可通过 RC_PUBLIC_KEY 覆盖 */
const DEFAULT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAhIcq1BLO0UYnQ2Z/w1oiW65K8ktIRit8BvkDdOwQQ3wG4FmNPa2rHCRkfHe+0/wllYrLeYHn4DLn3rjT/6Cds++9UlpE8BP+3pxmJ2OB472fHpPwO3GxdQUi5T1JIBSEJdPQOv71oTJI2/R2IuKPk3lFEcIUgiQXlQX91+ODtG5XRVO+mmgBxZIf26JYEUAEfJ7OV1Df/f8/daSF9UD+m6AxywJ9AKAEB+41PYMwnVd0/492ODtQGAxplER2HTyAFJd1HBDZOvU+uUh285dSNMayVGLpipO2/pGm1VrW9bdGw1yeRP7Z6ObJoNbrxJm+1zd1Du37wpQbu97A6qT/qQIDAQAB
-----END PUBLIC KEY-----`;

export function encryptPassword(plain: string, publicKeyPem = process.env.RC_PUBLIC_KEY ?? DEFAULT_PUBLIC_KEY): string {
  return publicEncrypt(
    { key: createPublicKey(publicKeyPem), padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(plain, 'utf8'),
  ).toString('base64');
}

export interface LoginResult {
  token: string;
  userId?: string;
  userName?: string;
  expiresSecond?: number;
  expiresTime?: string;
  /** 平台要求二次验证（dualLogin=1，短信/OTP） */
  dualLogin?: boolean;
}

export async function loginByPassword(client: RestCloudClient, user: string, pass: string): Promise<LoginResult> {
  if (!user || !pass) throw new RcError('E_AUTH', '缺少账号或密码（RC_USER / RC_PASS）');
  const r = await client.request('/rest/core/auth/login', {
    method: 'POST',
    body: { userName: user, password: encryptPassword(pass), systemlogin: '1' },
    dryRun: false,
  });
  if (!r.ok) throw new RcError('E_AUTH', `登录失败：${r.msg ?? '未知原因'}`, { traceId: r.traceId });
  const d = r.data ?? {};
  if (d.dualLogin === '1') {
    throw new RcError('E_AUTH', '账号启用了二次验证（dualLogin=1），当前 CLI 不支持短信/OTP，请改用 --token 或管理员关闭该策略');
  }
  const token = d.identitytoken;
  if (!token) throw new RcError('E_AUTH', '登录响应缺少 identitytoken');
  client.importCookies({ identitytoken: token });
  return {
    token,
    userId: d.userId,
    userName: d.userName,
    expiresSecond: d.expiresSecond,
    expiresTime: d.expiresTime,
    dualLogin: false,
  };
}

export async function loginByToken(client: RestCloudClient, token: string): Promise<LoginResult> {
  if (!token) throw new RcError('E_AUTH', '缺少 token');
  client.importCookies({ identitytoken: token });
  const ctx = await client.session();
  if (!ctx.ok) throw new RcError('E_AUTH', `token 无效或已过期：${ctx.msg ?? ''}`, { traceId: ctx.traceId });
  return { token, userId: ctx.data?.userId, userName: ctx.data?.userName };
}

export async function refresh(client: RestCloudClient): Promise<void> {
  const r = await client.request('/rest/core/auth/refreshToken', { method: 'POST', dryRun: false });
  if (!r.ok) throw new RcError('E_AUTH', `刷新失败：${r.msg ?? ''}`, { traceId: r.traceId });
  const token = r.data?.identitytoken;
  if (token) client.importCookies({ identitytoken: token });
}

/** cookie 落盘（0600），只存 identitytoken 与必要的分域标记 */
export async function saveSession(client: RestCloudClient, file: string): Promise<void> {
  await writeFile(file, JSON.stringify(client.exportCookies()), { mode: 0o600 });
}

export async function loadSession(client: RestCloudClient, file: string): Promise<boolean> {
  try {
    const jar = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    client.importCookies(jar);
    return true;
  } catch {
    return false;
  }
}

/** 会话文件路径（按 target 分域，避免三套系统互相覆盖） */
export function sessionFile(target: string): string {
  const dir = process.env.RC_HOME ?? join(homedir(), '.rc');
  return join(dir, `session-${target}.json`);
}

/** 同步加载（CLI 启动时立即恢复会话） */
export function loadSessionSync(client: RestCloudClient, file: string): boolean {
  try {
    const jar = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    client.importCookies(jar);
    return true;
  } catch {
    return false;
  }
}

/** 同步保存（登录后自动落盘，0600） */
export function saveSessionSync(client: RestCloudClient, file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(client.exportCookies()), { mode: 0o600 });
}
