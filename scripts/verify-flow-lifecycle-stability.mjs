#!/usr/bin/env node
/**
 * 真实环境验收的**稳定性门禁**：连续跑 N 次（默认 20）流程生命周期验收，
 * 任何一次失败即整体失败，并把逐次结果写进 reports/。
 *
 * 用途：
 *   - 把"平台索引延迟"和"回滚真的坏了"区分开（单次通过不算稳定）；
 *   - 复现"4 次里抖 1 次"这类间歇性问题；
 *   - 可在 CI（手动 / 定时）里跑，也可以在本地反复跑。
 *
 * 用法（凭据只放环境变量）：
 *   RC_BASE_URL='https://<test-host>/restcloud' RC_USER=... RC_PASS=... \
 *     node --experimental-strip-types scripts/verify-flow-lifecycle-stability.mjs \
 *       --allow-host <test-host> [--runs 20] [--keep-fail]
 *
 * 退出码：0 = 全部通过；1 = 有失败（逐次结果见 reports/flow-stability-<runId>.json）
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const has = (x) => args.includes(x);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const runs = Math.max(1, Number(opt('runs', 20)));
const keepFail = has('keep-fail');
const allowHosts = args.reduce((acc, cur, i) => (cur === '--allow-host' ? [...acc, args[i + 1]] : acc), []);
const baseUrl = process.env.RC_BASE_URL ?? '';
const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

if (!baseUrl) {
  console.error('缺少 RC_BASE_URL');
  process.exit(2);
}
if (!allowHosts.length) {
  console.error('写测试必须显式放行目标主机：--allow-host <host>（可重复）');
  process.exit(2);
}

const SCRIPT = fileURLToPath(new URL('./verify-flow-lifecycle.mjs', import.meta.url));

/** 跑一次验收，返回 {ok, code, stdout, stderr} */
function runOnce(i) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, ['--experimental-strip-types', SCRIPT, ...allowHosts.flatMap((h) => ['--allow-host', h])], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { out += d.toString(); });
    p.on('close', (code) => {
      const ok = code === 0;
      const lines = out.split('\n').filter((l) => l.trim());
      const failed = lines.filter((l) => l.startsWith('✖'));
      resolve({ ok, code, ms: Date.now() - started, failed, tail: lines.slice(-6) });
    });
  });
}

const results = [];
// 目标地址不打印（只留在环境变量里），报告也只写脱敏标记
console.log(`稳定性门禁：连续跑 ${runs} 次（profile=${process.env.RC_PROFILE ?? 'uat'}）`);
for (let i = 1; i <= runs; i++) {
  const r = await runOnce(i);
  results.push({ run: i, ...r, failed: r.failed, tail: undefined });
  const mark = r.ok ? '✔' : '✖';
  const extra = r.ok ? '' : ` → ${r.failed.join(' | ').slice(0, 160)}`;
  console.log(`${mark} 第 ${i}/${runs} 次（${r.ms}ms）${extra}`);
  if (!r.ok && !keepFail) {
    console.log('  ! 出现失败，停止后续运行（如需继续跑完请加 --keep-fail）');
    break;
  }
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
const report = {
  runId,
  target: '(redacted)',
  runs: results.length,
  requested: runs,
  passed,
  failed: failed.length,
  flaky: failed.length > 0 && passed > 0,
  results: results.map((r) => ({ run: r.run, ok: r.ok, ms: r.ms, failed: r.failed })),
};
mkdirSync('reports', { recursive: true });
const file = `reports/flow-stability-${runId}.json`;
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`\n汇总：通过 ${passed} / ${results.length}${failed.length ? `，失败 ${failed.length}` : ''}`);
console.log(`报告：${file}`);
if (failed.length) {
  console.log('失败明细：');
  for (const f of failed) console.log(`  第 ${f.run} 次：${f.failed.join(' | ')}`);
}
process.exit(failed.length ? 1 : 0);
