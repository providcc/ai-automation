/**
 * 目标地址白名单。
 *
 * 开源版本不内置任何平台地址；生产环境建议显式设置 RC_ALLOWED_HOSTS，
 * 防止误用环境变量/脚本把写操作发到非预期主机。
 *
 * 格式：逗号分隔的 host 或通配符，例如
 *   RC_ALLOWED_HOSTS='ipaas-test.example.com,*.corp.example.com'
 * 也接受完整 URL（只取 host 比较）。
 */

function normalizePattern(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (!s) return '';
  try {
    return new URL(s.includes('://') ? s : `https://${s}`).host;
  } catch {
    return s;
  }
}

export function parseAllowedHosts(raw = process.env.RC_ALLOWED_HOSTS): string[] {
  if (!raw) return [];
  return raw.split(',').map(normalizePattern).filter(Boolean);
}

export function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  const hostname = h.replace(/:\d+$/, '');
  return allowlist.some((pattern) => {
    if (pattern === h || pattern === hostname) return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // .example.com
      return (h.endsWith(suffix) && h.length > suffix.length)
        || (hostname.endsWith(suffix) && hostname.length > suffix.length);
    }
    return false;
  });
}

/**
 * 校验目标地址；未配置白名单时不拦截（保持开源版本可配置）。
 * 空白地址不校验（允许先启动、后设置 RC_BASE_URL）。
 */
export function assertAllowedHost(
  baseUrl: string | undefined,
  allowlist = parseAllowedHosts(),
): void {
  if (!baseUrl || allowlist.length === 0) return;
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    throw new Error(`目标地址不是合法 URL：${baseUrl}`);
  }
  if (!hostAllowed(host, allowlist)) {
    throw new Error(
      `目标主机 ${host} 不在 RC_ALLOWED_HOSTS 白名单内。` +
      `当前白名单：${allowlist.join(', ')}。如确需访问，请显式更新环境变量。`,
    );
  }
}
