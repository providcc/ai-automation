/**
 * dw CLI 行为冒烟：以**子进程**方式跑真实的 dw 命令，验证入口、参数校验、退出码与安全闸门。
 *
 * 为什么不只做单测：单测直接调 `packages/core/src/dw/*` 的函数，
 * 但"命令名拼错没报错"、"退出码和文档对不上"、"只读闸门没接进命令分支"
 * 这类问题**只在 CLI 这一层**出现。这个文件就是补这一层。
 *
 * 全程不触网：只跑本地命令（--help / --version / env / lint / 参数校验），
 * 以及**必须被本地拦下**的危险输入（多语句、DROP）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'packages', 'dw-cli', 'src', 'index.ts');
const ROOT = join(here, '..', '..');

/**
 * 跑一次 dw CLI。
 * **刻意不给任何 DW_* 环境变量**，并把 DW_HOME 指到空目录——
 * 这样"没配置环境"时的报错口径也在被测试范围内，且不会误连到开发机上的真实配置。
 */
async function dw(args: string[], env: Record<string, string> = {}) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // 清掉所有可能指向真实数仓的变量，保证测试不触网
    if (k.startsWith('DW_')) continue;
    if (v !== undefined) base[k] = v;
  }
  try {
    const r = await run(process.execPath, ['--experimental-strip-types', CLI, ...args], {
      cwd: ROOT,
      env: { ...base, DW_HOME: env.DW_HOME ?? join(tmpdir(), 'dw-smoke-empty-home'), ...env },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e: any) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** 临时 DW_HOME（用完删）。 */
function tmpHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'dw-smoke-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// ─────────────────────── 入口 ───────────────────────

test('dw：--version 输出版本号', async () => {
  const r = await dw(['--version']);
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('dw：--help 覆盖全部命令分组', async () => {
  const r = await dw(['--help']);
  assert.equal(r.code, 0);
  for (const section of ['环境与连接', '查询与诊断', 'MV 自查', 'MV 写操作', '分区与分桶', '安全模型', '配置']) {
    assert.ok(r.stdout.includes(section), `帮助里缺少分组 ${section}`);
  }
});

test('dw：未知命令 → 退出码 2，并提示 --help', async () => {
  const r = await dw(['nope']);
  assert.equal(r.code, 2);
  assert.match(r.stderr + r.stdout, /--help/);
});

test('dw：未知子命令也报错（不是静默成功）', async () => {
  const r = await dw(['mv', 'nope']);
  assert.notEqual(r.code, 0);
});

// ─────────────────────── 帮助里列出的命令都真的接上了 ───────────────────────

test('dw：HELP 里每个二级命令都有对应的分支（漏接一条就是"文档写了但用不了"）', async () => {
  const help = (await dw(['--help'])).stdout;
  // 从帮助正文里抽出 `dw <一级> <二级>` 形式的命令
  const cmds = new Set<string>();
  for (const m of help.matchAll(/^\s*dw\s+([a-z-]+)\s+([a-z-]+)/gm)) cmds.add(`${m[1]} ${m[2]}`);
  assert.ok(cmds.size >= 20, `从帮助里只解析出 ${cmds.size} 条命令，解析规则可能失效了`);

  // 逐条用 `--help` 探活：接了分支的命令不会落到"未知命令"（退出码 2 + 提示 --help）
  for (const c of cmds) {
    const r = await dw([...c.split(' '), '--help']);
    assert.ok(
      !(r.code === 2 && /未知命令/.test(r.stderr + r.stdout)),
      `帮助里列了 \`dw ${c}\`，但 CLI 没有对应分支`,
    );
  }
});

// ─────────────────────── 参数校验 ───────────────────────

test('dw：缺必填参数 → 退出码 4（参数错误），不是 2', async () => {
  for (const args of [['query'], ['mv', 'show'], ['mv', 'lineage'], ['mv', 'lint'], ['partition', 'list'], ['tablet']]) {
    const r = await dw(args);
    assert.equal(r.code, 4, `\`dw ${args.join(' ')}\` 应当以参数错误退出，实际 ${r.code}`);
  }
});

test('dw：数值参数给了非数字 → 参数错误，不是静默当 0', async () => {
  const r = await dw(['mv', 'tasks', '--hours', 'abc']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /hours|数字|参数/i);
});

test('dw：lint 的 --target 与源同名 → 退出码 4（阻断）', async () => {
  const t = tmpHome();
  try {
    const f = join(t.home, 'mv.sql');
    writeFileSync(
      f,
      'CREATE MATERIALIZED VIEW `mv_a` BUILD DEFERRED REFRESH AUTO ON SCHEDULE EVERY 1 HOUR\n' +
        'DISTRIBUTED BY HASH(`dt`) BUCKETS 3\nPROPERTIES ("replication_num" = "1")\nAS SELECT 1',
    );
    const r = await dw(['mv', 'lint', '--file', f, '--target', 'mv_a']);
    assert.equal(r.code, 4);
  } finally {
    t.cleanup();
  }
});

test('dw：lint 报出阻断项时退出码 4；干净时 0', async () => {
  const t = tmpHome();
  try {
    const bad = join(t.home, 'bad.sql');
    writeFileSync(bad, 'CREATE MATERIALIZED VIEW `db`.`mv` BUILD DEFERRED REFRESH AUTO ON SCHEDULE EVERY 1 HOUR\nAS SELECT 1');
    const r = await dw(['mv', 'lint', '--file', bad, '--json']);
    assert.equal(r.code, 4);
    const report = JSON.parse(r.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.findings.some((f: any) => f.code === 'E_QUALIFIED_NAME'), '应当报出库名限定');

    const good = join(t.home, 'good.sql');
    writeFileSync(
      good,
      'CREATE MATERIALIZED VIEW `mv_ok` BUILD DEFERRED REFRESH AUTO ON SCHEDULE EVERY 1 HOUR\n' +
        'DISTRIBUTED BY HASH(`dt`) BUCKETS 3\nPROPERTIES ("replication_num" = "1")\nAS SELECT 1',
    );
    assert.equal((await dw(['mv', 'lint', '--file', good])).code, 0);
  } finally {
    t.cleanup();
  }
});

// ─────────────────────── 安全闸门（必须本地拦下，绝不能发到服务端） ───────────────────────
//
// 退出码契约（docs/DW-COMMAND-REFERENCE.md §3.6）：闸门拒绝抛的是 `E_FORBIDDEN` → **6**
// （"危险操作被拒"），不是 4（4 是 E_VALIDATION，参数写错）。这两者别混：
// 参数错是"你写错了"，闸门拒是"这条被策略挡了"。

test('dw：只读闸门拒多语句（分号拼接的写操作）→ 退出码 6', async () => {
  const r = await dw(['query', 'SELECT 1; DROP TABLE t']);
  assert.equal(r.code, 6);
  assert.match(r.stderr + r.stdout, /单条|多语句|一条/i);
});

test('dw：只读闸门拒 DDL / DML → 退出码 6', async () => {
  for (const sql of ['DROP TABLE t', 'DELETE FROM t', 'INSERT INTO t VALUES (1)', 'ALTER TABLE t ADD COLUMN c INT']) {
    const r = await dw(['query', sql]);
    assert.equal(r.code, 6, `\`${sql}\` 应当被拒（E_FORBIDDEN → 6），实际 ${r.code}`);
  }
});

test('dw：注释伪装绕不过只读闸门', async () => {
  // 用注释把关键字藏起来是最常见的绕过尝试
  const r = await dw(['query', '/* SELECT */ DROP TABLE t']);
  assert.equal(r.code, 6);
});

test('dw：闸门拒绝发生在**解析环境之前**（没配环境时也该先报"SQL 被拒"）', async () => {
  const r = await dw(['query', 'DROP TABLE t']);
  assert.equal(r.code, 6);
  assert.match(r.stderr + r.stdout, /只读|写操作/);
  assert.ok(!/没有可用的数仓环境/.test(r.stderr + r.stdout), '不该先报环境缺失——闸门必须在连接之前');
});

test('dw：explain 也过闸门（内层语句是写操作时拒掉）', async () => {
  const r = await dw(['explain', 'DROP TABLE t']);
  assert.equal(r.code, 6);
});

test('dw：写操作默认 dry-run——没有 --apply 时不发请求', async () => {
  const r = await dw(['mv', 'refresh', 'some_mv']);
  // 没配环境 → 根本连不上；关键是**不能说"已刷新"**
  assert.ok(!/已刷新|✔ 已/.test(r.stdout), 'dry-run 不能打印已完成');
});

test('dw：危险写操作在无环境时给出可行动的配置提示，而不是崩栈', async () => {
  const r = await dw(['mv', 'refresh', 'some_mv', '--apply']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /DW_HOST|warehouse\.json|--db/);
  assert.ok(!/\bat .*\.ts:\d+/.test(r.stderr), '不应把调用栈直接抛给用户');
});

// ─────────────────────── 环境与配置（本地，不触网） ───────────────────────

test('dw：env list 无配置时是**成功**的（列出 0 个环境并给配置方式）', async () => {
  const r = await dw(['env', 'list']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /没有配置任何环境/);
  assert.match(r.stdout, /warehouse\.json|DW_HOST/);
});

test('dw：env show 无配置时以参数错误退出（它必须给出一个"当前环境"，给不出就是错）', async () => {
  const r = await dw(['env', 'show']);
  assert.equal(r.code, 4);
  assert.match(r.stderr + r.stdout, /没有可用的数仓环境/);
  assert.match(r.stderr + r.stdout, /warehouse\.json|DW_HOST/);
});

test('dw：env list 只打印打码后的 host（配置文件里的真实 host 不许出现）', async () => {
  const t = tmpHome();
  try {
    writeFileSync(
      join(t.home, 'warehouse.json'),
      JSON.stringify({
        default: 'staging',
        environments: {
          staging: { host: 'db-replica-01.example.test', mysqlPort: 9030, httpPort: 8030, user: 'reader', database: 'demo' },
        },
      }),
    );
    const r = await dw(['env', 'list'], { DW_HOME: t.home });
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes('db-replica-01'), 'env list 不应回显完整 host');
    assert.match(r.stdout, /staging/);
  } finally {
    t.cleanup();
  }
});

test('dw：env list --json 也是打码的', async () => {
  const t = tmpHome();
  try {
    writeFileSync(
      join(t.home, 'warehouse.json'),
      JSON.stringify({
        environments: { staging: { host: 'db-replica-01.example.test', mysqlPort: 9030, httpPort: 8030, user: 'reader' } },
      }),
    );
    const r = await dw(['env', 'list', '--json'], { DW_HOME: t.home });
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes('db-replica-01'), '--json 也不许回显完整 host');
  } finally {
    t.cleanup();
  }
});

test('dw：env show 默认打码 host，--reveal-host 才回原值', async () => {
  const t = tmpHome();
  try {
    writeFileSync(
      join(t.home, 'warehouse.json'),
      JSON.stringify({
        environments: { staging: { host: 'db-replica-01.example.test', mysqlPort: 9030, httpPort: 8030, user: 'reader' } },
      }),
    );
    const masked = await dw(['env', 'show'], { DW_HOME: t.home });
    assert.equal(masked.code, 0);
    assert.ok(!masked.stdout.includes('db-replica-01'), '默认必须打码');

    const revealed = await dw(['env', 'show', '--reveal-host'], { DW_HOME: t.home });
    assert.match(revealed.stdout, /db-replica-01/);
  } finally {
    t.cleanup();
  }
});

test('dw：配置文件损坏时报清晰错误，不是崩栈', async () => {
  const t = tmpHome();
  try {
    writeFileSync(join(t.home, 'warehouse.json'), '{ not json');
    const r = await dw(['env', 'list'], { DW_HOME: t.home });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr + r.stdout, /JSON|解析|格式/);
    assert.ok(!/\bat .*\.ts:\d+/.test(r.stderr), '不应把调用栈直接抛给用户');
  } finally {
    t.cleanup();
  }
});

test('dw：凭据文件里的密码绝不出现在任何输出里', async () => {
  const t = tmpHome();
  const SECRET = 'zzz-not-a-real-password-zzz';
  try {
    writeFileSync(
      join(t.home, 'warehouse.json'),
      JSON.stringify({
        environments: { staging: { host: 'db-replica-01.example.test', mysqlPort: 9030, httpPort: 8030, user: 'reader' } },
      }),
    );
    writeFileSync(join(t.home, 'warehouse-credentials.json'), JSON.stringify({ staging: { password: SECRET } }));

    for (const args of [['env', 'list'], ['env', 'show'], ['env', 'show', '--reveal-host'], ['env', 'list', '--json'], ['doctor']]) {
      const r = await dw(args, { DW_HOME: t.home });
      assert.ok(!r.stdout.includes(SECRET), `\`dw ${args.join(' ')}\` 的 stdout 泄漏了密码`);
      assert.ok(!r.stderr.includes(SECRET), `\`dw ${args.join(' ')}\` 的 stderr 泄漏了密码`);
    }
  } finally {
    t.cleanup();
  }
});

// ─────────────────────── 从仓库根直接调（不依赖安装） ───────────────────────

test('dw：bin/dw.mjs 与直接跑 index.ts 行为一致（版本号相同）', async () => {
  const direct = await dw(['--version']);
  const viaBin = await new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(
      process.execPath,
      [join(ROOT, 'bin', 'dw.mjs'), '--version'],
      { cwd: ROOT, env: process.env },
      (err: any, stdout) => resolve({ code: err?.code ?? 0, stdout: stdout ?? '' }),
    );
  });
  assert.equal(viaBin.code, 0);
  assert.equal(viaBin.stdout.trim(), direct.stdout.trim());
});

test('dw：bin/dw.mjs 的退出码原样透传（0 与 4 各验一次）', async () => {
  const call = (args: string[]) =>
    new Promise<number>((resolve) => {
      execFile(process.execPath, [join(ROOT, 'bin', 'dw.mjs'), ...args], { cwd: ROOT, env: process.env }, (err: any) =>
        resolve(err?.code ?? 0),
      );
    });
  assert.equal(await call(['--version']), 0);
  assert.equal(await call(['mv', 'show']), 4);
});

// ─────────────────────── 数值参数的范围 ───────────────────────

/**
 * 只校验"是不是数字"是不够的：`--hours -1` / `--limit 0` 会被原样送进 SQL，
 * 拿到的是语义完全不同的查询（负数区间 / `LIMIT 0`），而输出看起来只是"没有数据"。
 */
test('dw：数值参数超范围 → 参数错误（不是静默当成 0 或负数送进 SQL）', async () => {
  const cases: string[][] = [
    ['mv', 'tasks', '--hours=-1'],
    ['mv', 'tasks', '--limit', '0'],
    ['mv', 'lineage', 'mv_x', '--depth=-1'],
    ['mv', 'tasks', '--hours', '1.5'],
    ['profile', 'list', '--limit', '0'],
    ['profile', 'history', 'x', '--days', '0'],
  ];
  for (const args of cases) {
    const r = await dw(args);
    assert.equal(r.code, 4, `\`dw ${args.join(' ')}\` 应当以参数错误退出，实际 ${r.code}`);
    assert.match(r.stderr + r.stdout, /需要|整数/, args.join(' '));
  }
});

test('dw：`--flag -1` 这种写法 → 参数错误 4（不是未捕获异常 2）', async () => {
  // parseArgs 会把 `-1` 当成选项名，Node 会抛原文；dw 现在把它包成我们的参数错误口径
  const r = await dw(['mv', 'tasks', '--hours', '-1']);
  assert.equal(r.code, 4, `应当是参数错误，实际 ${r.code}`);
  assert.match(r.stderr + r.stdout, /参数解析失败|--hours/);
});

test('dw：mv lint 文件不存在 → 可行动的参数错误（不是裸 ENOENT）', async () => {
  const r = await dw(['mv', 'lint', '--file', '/nonexistent/nope.sql']);
  assert.equal(r.code, 4);
  assert.match(r.stderr + r.stdout, /读不到 --file/);
  assert.equal(/^ENOENT/.test(r.stderr.trim()), false, '不该把 Node 的 ENOENT 原文抛出去');
});
