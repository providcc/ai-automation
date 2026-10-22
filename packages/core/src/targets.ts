/**
 * 多目标寻址：按名称选择平台地址
 * 配置来源优先级：RC_TARGETS(JSON) > ./rc.targets.json > ~/.rc/targets.json > 空
 * 开源版本不内置任何环境地址；必须通过配置显式提供。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface Target {
  name: string;
  baseUrl: string;
  role: string;
  network?: 'public' | 'intranet';
  default?: boolean;
}

const DEFAULTS: Target[] = [];

/** 全局目标配置文件位置：~/.rc/targets.json（可用 RC_HOME 覆盖）。 */
function globalTargetsFile(): string {
  const home = process.env.RC_HOME ?? join(homedir(), '.rc');
  return join(home, 'targets.json');
}

export function loadTargets(opts: { file?: string } = {}): Target[] {
  const fromEnv = process.env.RC_TARGETS;
  if (fromEnv) {
    try {
      const parsed = JSON.parse(fromEnv);
      const list = Array.isArray(parsed) ? parsed : parsed?.targets;
      // 配置形状不对时给明确错误，而不是让调用方在 .find 上炸掉
      if (!Array.isArray(list)) throw new Error('RC_TARGETS 需要是数组或 { targets: [...] }');
      return list;
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error('RC_TARGETS 不是合法 JSON');
      throw e;
    }
  }
  // 优先级：显式 file > 当前工作目录 ./rc.targets.json > 全局 ~/.rc/targets.json
  // （全局位置很重要：Agent 调 CLI 时的 cwd 常是业务仓库，不适合把平台配置放进去）
  const candidates = opts.file
    ? [opts.file]
    : [resolve(process.cwd(), 'rc.targets.json'), globalTargetsFile()];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed?.targets;
    if (!Array.isArray(list)) throw new Error(`${file} 需要是数组或 { targets: [...] }`);
    return list;
  }
  return DEFAULTS;
}

export function resolveTarget(name?: string, opts: { file?: string } = {}): Target {
  const targets = loadTargets(opts);
  if (!name) {
    const hit = targets.find((t) => t.default) ?? targets[0];
    if (hit) return hit;
    return { name: 'default', baseUrl: '', role: 'custom' };
  }
  const hit = targets.find((t) => t.name === name);
  if (!hit) throw new Error(`未知 target：${name}（可选：${targets.map((t) => t.name).join(', ') || '未配置'}）`);
  return hit;
}

/** 网络域不匹配的显式提示，避免脚本静默超时 */
export function networkHint(t: Target): string {
  return t.network === 'intranet' ? '内网目标：请确认已连接 VPN/办公网' : '公网目标：请确认域名可达';
}
