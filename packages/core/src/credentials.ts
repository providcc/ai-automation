/**
 * 本地凭据解析：环境变量优先，可选系统钥匙串兜底。
 *
 * 不提供凭据管理/审批/共享能力，只把本机已有的密钥注入到 CLI 的非交互认证流程。
 *
 * macOS:
 *   RC_KEYCHAIN=1 RC_KEYCHAIN_SERVICE=rc-ipaas RC_USER=ci-bot
 *   security add-generic-password -s rc-ipaas -a ci-bot -w '***'
 * Linux:
 *   secret-tool store --label='rc-ipaas' service rc-ipaas account ci-bot
 */
import { execFileSync } from 'node:child_process';

export interface ResolvedCredentials {
  user?: string;
  pass?: string;
  token?: string;
  source: 'env' | 'keychain' | 'mixed' | 'none';
  warnings: string[];
}

export interface CredentialEnv {
  RC_USER?: string;
  RC_PASS?: string;
  RC_TOKEN?: string;
  RC_KEYCHAIN?: string;
  RC_KEYCHAIN_SERVICE?: string;
  RC_KEYCHAIN_ACCOUNT?: string;
  RC_KEYCHAIN_TOKEN_ACCOUNT?: string;
  /** 钥匙串里"用户名"条目的账号名（默认读 'user' 条目） */
  RC_KEYCHAIN_USER?: string;
}

export function keychainEnabled(env: CredentialEnv = process.env): boolean {
  return env.RC_KEYCHAIN === '1' || env.RC_KEYCHAIN === 'true';
}

/** 读取钥匙串；失败返回 undefined，并把原因放到 warnings（不打印密钥）。 */
export function readKeychainSecret(
  account: string,
  service = 'rc-ipaas',
  platform = process.platform,
): { value?: string; warning?: string } {
  try {
    if (platform === 'darwin') {
      const value = execFileSync(
        'security',
        ['find-generic-password', '-s', service, '-a', account, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 },
      ).trim();
      return value ? { value } : { warning: `钥匙串 ${service}/${account} 为空` };
    }
    if (platform === 'linux') {
      const value = execFileSync(
        'secret-tool',
        ['lookup', 'service', service, 'account', account],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 },
      ).trim();
      return value ? { value } : { warning: `secret-tool ${service}/${account} 为空` };
    }
    return { warning: `当前平台 ${platform} 不支持系统钥匙串` };
  } catch {
    return { warning: `未从系统钥匙串读取到 ${service}/${account}` };
  }
}

/**
 * 往系统钥匙串写凭据（macOS security / Linux secret-tool）。
 * 布局：用户名固定存成 'user' 条目，密码存成"账号名"条目（与读取端一致）。
 */
export function writeKeychainSecret(
  account: string,
  secret: string,
  opts: { service?: string; platform?: NodeJS.Platform } = {},
): { ok: boolean; msg?: string } {
  const service = opts.service ?? 'rc-ipaas';
  const platform = opts.platform ?? process.platform;
  try {
    if (platform === 'darwin') {
      execFileSync('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret], { stdio: 'ignore', timeout: 10_000 });
      return { ok: true };
    }
    if (platform === 'linux') {
      execFileSync('secret-tool', ['store', '--label', service, 'service', service, 'account', account], {
        input: secret, stdio: ['pipe', 'ignore', 'ignore'], timeout: 10_000,
      });
      return { ok: true };
    }
    return { ok: false, msg: `当前平台 ${platform} 不支持系统钥匙串` };
  } catch (e) {
    return { ok: false, msg: `写入钥匙串失败：${(e as Error).message}` };
  }
}

/**
 * 解析认证材料。环境变量永远优先；只有 RC_KEYCHAIN=1 时才访问系统钥匙串。
 * 不读仓库文件，不写任何密钥。
 */
export function resolveCredentials(
  env: CredentialEnv = process.env,
  opts: { platform?: NodeJS.Platform } = {},
): ResolvedCredentials {
  const warnings: string[] = [];
  let user = env.RC_USER;
  let pass = env.RC_PASS;
  let token = env.RC_TOKEN;
  const envUsed = Boolean(user || pass || token);
  let keychainUsed = false;

  if (keychainEnabled(env)) {
    const service = env.RC_KEYCHAIN_SERVICE ?? 'rc-ipaas';
    if (!user) {
      // 用户名条目固定叫 'user'；RC_KEYCHAIN_USER / RC_KEYCHAIN_ACCOUNT 都能兜底
      const r = readKeychainSecret('user', service, opts.platform);
      if (r.value) { user = r.value; keychainUsed = true; }
      else if (r.warning) warnings.push(r.warning);
      if (!user) {
        user = env.RC_KEYCHAIN_USER ?? env.RC_KEYCHAIN_ACCOUNT ?? undefined;
        if (user) warnings.push(`钥匙串里没有 'user' 条目，已用 ${user === env.RC_KEYCHAIN_ACCOUNT ? 'RC_KEYCHAIN_ACCOUNT' : 'RC_KEYCHAIN_USER'} 兜底`);
      }
    }
    if (!pass) {
      const account = env.RC_KEYCHAIN_ACCOUNT ?? user ?? 'default';
      const r = readKeychainSecret(account, service, opts.platform);
      if (r.value) { pass = r.value; keychainUsed = true; }
      else if (r.warning) warnings.push(r.warning);
    }
    if (!token) {
      const account = env.RC_KEYCHAIN_TOKEN_ACCOUNT ?? 'token';
      const r = readKeychainSecret(account, service, opts.platform);
      if (r.value) { token = r.value; keychainUsed = true; }
      // token 是可选的，缺省不产生噪声
    }
  }

  const hasAny = Boolean(user || pass || token);
  const source: ResolvedCredentials['source'] = !hasAny
    ? 'none'
    : keychainUsed
      ? (envUsed ? 'mixed' : 'keychain')
      : 'env';
  return { user, pass, token, source, warnings };
}
