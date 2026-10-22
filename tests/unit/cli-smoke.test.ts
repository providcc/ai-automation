/**
 * CLI 行为冒烟：以子进程方式跑真实的 rc 命令，验证入口、参数校验与退出码。
 * 不触网：只用本地命令（--help / --version / doctor / templates / flow validate）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpDir } from './helpers.ts';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'packages', 'cli', 'src', 'index.ts');
const ROOT = join(here, '..', '..');

/** 跑一次 CLI，返回 {code, stdout, stderr}（不因非 0 退出码抛错）。 */
async function rc(args: string[], env: Record<string, string> = {}) {
  try {
    const r = await run(process.execPath, ['--experimental-strip-types', CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env, RC_PROFILE: 'uat', RC_BASE_URL: env.RC_BASE_URL ?? '' },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e: any) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('CLI：--version 输出版本号', async () => {
  const r = await rc(['--version']);
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('CLI：--help 列出编排与安全相关命令', async () => {
  const r = await rc(['--help']);
  assert.equal(r.code, 0);
  for (const cmd of ['rc flow build', 'rc flow list', 'rc flow props list', 'rc flow restore-version', 'export <pid>']) {
    assert.ok(r.stdout.includes(cmd), `帮助里缺少 ${cmd}`);
  }
});

test('CLI：缺参数时报用法错误（退出码 4）', async () => {
  const r = await rc(['flow', 'save']);
  assert.equal(r.code, 4);
  assert.match(r.stderr + r.stdout, /--file|--process-id/);
});

test('CLI：doctor 在无目标地址时仍能本地运行', async () => {
  const r = await rc(['doctor']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /catalog/);
  assert.match(r.stdout, /凭据来源/);
});

test('CLI：templates validate 校验全部模板', async () => {
  const r = await rc(['templates', 'validate']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\d+ 个模板，0 个未通过/);
});

test('CLI：flow validate 能校验组合文件（缺必填属性 → 错误）', async () => {
  const dir = tmpDir('rc-cli-');
  try {
    const file = dir.write('flow.json', JSON.stringify({
      kind: 'esb',
      model: {
        nodeDataArray: [
          { key: 'E00001', nodeType: 'start' },
          { key: 'T00001', nodeType: 'apiNode' },
          { key: 'E00002', nodeType: 'end' },
        ],
        linkDataArray: [
          { from: 'E00001', to: 'T00001', routerId: 'R00001' },
          { from: 'T00001', to: 'E00002', routerId: 'R00002' },
        ],
        transform: 1,
      },
      props: { T00001: { pNodeId: 'T00001', pNodeType: 'apiNode' } },
    }));
    const bad = await rc(['flow', 'validate', '--file', file, '--json']);
    assert.equal(bad.code, 4);
    const issues = JSON.parse(bad.stdout);
    assert.ok(issues.some((i: any) => i.code === 'REQUIRED_FIELD' && /apiUrl/.test(i.msg)));

    // 骨架标记 → 只警告
    const skeleton = dir.write('skeleton.json', JSON.stringify({
      kind: 'esb', skeleton: true,
      model: JSON.parse(dir.read('flow.json')).model,
      props: { T00001: { pNodeId: 'T00001', pNodeType: 'apiNode' } },
    }));
    const soft = await rc(['flow', 'validate', '--file', skeleton, '--json']);
    assert.equal(soft.code, 0);
    const softIssues = JSON.parse(soft.stdout);
    assert.ok(softIssues.some((i: any) => i.code === 'REQUIRED_FIELD' && i.level === 'warn'));

    // 显式放行
    const allowed = await rc(['flow', 'validate', '--file', file, '--allow-missing-required', '--json']);
    assert.equal(allowed.code, 0);
  } finally {
    dir.cleanup();
  }
});

test('CLI：ETL 写路径默认封禁（E_FORBIDDEN，退出码 6）', async () => {
  const r = await rc(['etl', 'run', 'p1', '--apply']);
  assert.equal(r.code, 6);
  assert.match(r.stderr + r.stdout, /ETL 写操作已封禁/);
});

test('CLI：需要联网的命令在缺目标地址时给出可行动提示', async () => {
  const r = await rc(['api', 'list', '--app', 'test']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /缺少目标地址/);
});

test('CLI：flow from-nl 未指定 --kind 时自动判定类型（表/库 + 同步动词 → etl）', async () => {
  const auto = await rc(['flow', 'from-nl', '批量同步数据库表 orders 到数据库', '--json']);
  assert.equal(auto.code, 0);
  const autoDoc = JSON.parse(auto.stdout);
  assert.equal(autoDoc.kind, 'etl');
  assert.ok(autoDoc.input.nodes.some((n: any) => n.nodeType === 'sqlReadNode'));

  const forced = await rc(['flow', 'from-nl', '批量同步数据库表 orders 到数据库', '--kind', 'esb', '--json']);
  assert.equal(forced.code, 0);
  const forcedDoc = JSON.parse(forced.stdout);
  assert.equal(forcedDoc.kind, 'esb');
  assert.ok(forcedDoc.input.nodes.some((n: any) => n.nodeType === 'tableReadNode'));
});

test('CLI：flow preview 缺参数时报用法错误', async () => {
  const r = await rc(['flow', 'preview', '--process-id', 'p1']);
  assert.equal(r.code, 4);
  assert.match(r.stderr + r.stdout, /--node-id/);
});

test('CLI：dry-run 明确说"未写入"，不会打印"已创建/保存完成"', async () => {
  // dry-run 不会真的发请求，所以给一个假地址即可（验证的是提示口径）
  const r = await rc(['flow', 'create', '--application', 'test', '--name', 'dryrun-probe', '--config-id', 'RC_DRYRUN_PROBE'],
    { RC_BASE_URL: 'https://example.test/restcloud' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /【dry-run】未写入/);
  assert.ok(!/✔ 流程已创建/.test(r.stdout), 'dry-run 不能打印"已创建"');
  assert.match(r.stdout, /--apply/);
});

// ─────────────────────── 帮助里列出的命令都真的接上了 ───────────────────────

test('CLI：--help 里每条二级命令都有对应分支（漏接一条就是"文档写了但用不了"）', async () => {
  const help = (await rc(['--help'])).stdout;
  const cmds = new Set<string>();
  for (const m of help.matchAll(/^\s+(?:rc\s+)?([a-z][a-z-]+)\s+([a-z][a-z-]+)/gm)) cmds.add(`${m[1]} ${m[2]}`);
  assert.ok(cmds.size >= 60, `从帮助里只解析出 ${cmds.size} 条命令，解析规则可能失效了`);

  const missing: string[] = [];
  for (const c of [...cmds].sort()) {
    const r = await rc([...c.split(' '), '--help']);
    if (/未知命令|unknown command/i.test(r.stderr + r.stdout)) missing.push(c);
  }
  assert.deepEqual(missing, [], `帮助里列了但 CLI 没有分支：${missing.join(', ')}`);
});

// ─────────────────────── 网络失败不许伪装成 dry-run ───────────────────────

test('CLI：**网络不通时写命令必须报失败**，不许打印 [dry-run] 并退出 0', async () => {
  // 曾经的 bug：dry-run 用 `httpStatus === 0` 当哨兵，而网络层失败同样拿不到状态码，
  // 于是"请求根本没发出去"被打印成 `[dry-run]` 并以 0 退出——
  // CI/Agent/脚本只看退出码就会判定成功；超时的情况下请求还可能已经到达平台。
  const unreachable = 'https://127.0.0.1:1/restcloud';
  const dir = tmpDir('rc-netfail-');
  try {
    const file = dir.write('svc.json', JSON.stringify({ configName: 'probe' }));
    for (const args of [
      ['flow', 'list'],
      ['api', 'save', '--file', file, '--apply'],
    ]) {
      const r = await rc(args, { RC_BASE_URL: unreachable, RC_HOME: dir.dir });
      assert.notEqual(r.code, 0, `\`rc ${args.join(' ')}\` 网络不通时必须非 0 退出`);
      const out = r.stdout + r.stderr;
      assert.ok(!out.includes('[dry-run]'), `网络失败不能打印 [dry-run]：${out}`);
      assert.match(out, /网络请求失败/, '应当明确说网络失败');
    }
  } finally {
    dir.cleanup();
  }
});

test('CLI：真 dry-run（不带 --apply）仍然退出 0，并打印 [dry-run]', async () => {
  const dir = tmpDir('rc-dry-');
  try {
    const file = dir.write('svc.json', JSON.stringify({ configName: 'probe' }));
    const r = await rc(['api', 'save', '--file', file], {
      RC_BASE_URL: 'https://127.0.0.1:1/restcloud',
      RC_HOME: dir.dir,
    });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\[dry-run\]/);
  } finally {
    dir.cleanup();
  }
});
