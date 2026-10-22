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

const cleanup = () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
};
process.on('exit', cleanup);
