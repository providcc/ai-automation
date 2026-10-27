/**
 * 单测隔离：把 RC_HOME / RC_SNAPSHOT_DIR / DW_HOME 指到临时目录，
 * 避免测试往用户真实的 ~/.rc、~/.dw 里写快照、审计与节点集合。
 *
 * 通过 `node --import ./tests/unit/isolate-home.mjs --test ...` 预加载。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'rc-test-home-'));
process.env.RC_HOME = dir;
process.env.RC_SNAPSHOT_DIR = join(dir, 'snapshots');
process.env.RC_AUDIT_DIR = join(dir, 'audit');
process.env.DW_HOME = join(dir, 'dw');

/**
 * 同时**抹掉会话里真实环境的开关**：`RC_ALLOWED_HOSTS` / `RC_ACTOR` 这类变量
 * 一旦从 shell 泄漏进来，安全测试会拿真实白名单去卡假域名，50 个用例一起红——
 * 而真相是"测试本身没问题，是环境脏了"。单测必须与宿主环境完全解耦，
 * 只由自己的 `withEnv(...)` 设定上下文；真实的值留给真连平台的那几条验收脚本。
 */
for (const k of [
  'RC_ALLOWED_HOSTS',
  'RC_ACTOR',
  'RC_BASE_URL',
  'RC_PROFILE',
  'RC_ALLOW_PROD_WRITE',
  'RC_ENABLE_ETL_WRITE',
  'RC_KEYCHAIN',
  'RC_KEYCHAIN_USER',
  'RC_KEYCHAIN_ACCOUNT',
  'RC_TARGET',
  'DW_HOST',
  'DW_PORT',
  'DW_HTTP_PORT',
  'DW_USER',
  'DW_PASS',
  'DW_DB',
  'DW_CATALOG',
  'DW_ENV',
  'DW_PROFILE',
  'DW_ALLOW_PROD_WRITE',
  'DW_NETWORK',
  'DW_TRANSPORT',
  'DW_CMD',
  'DW_SENSITIVE_WORDS',
  'DW_SENSITIVE_WORDS_FILE',
]) {
  delete process.env[k];
}

const cleanup = () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
};
process.on('exit', cleanup);
