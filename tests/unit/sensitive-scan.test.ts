/**
 * 敏感扫描器自身的单测。
 *
 * 这个扫描器是"内部信息不上 gh"的最后一道闸——**它自己必须被测**。
 * 三类用例：
 *   1. **该抓的必须抓到**（凭据形态、内网标识、外部词表、文件名）；
 *   2. **不该抓的不能误报**（占位符写法、RFC 5737 文档地址段、短词）；
 *   3. **自指安全**：扫描器自己的源码必须对自己 clean（特征串必须拆开拼）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FRAGMENTS,
  SKIP_PATHS,
  buildMatchers,
  escapeRe,
  listFiles,
  listFilesInDir,
  listHistoryBlobs,
  loadWords,
  main,
  parseArgs,
  runScan,
  scanFile,
  scanFiles,
  scanText,
} from '../../scripts/sensitive-scan.mjs';

const M = buildMatchers();
const hitsOf = (text: string) => scanText(text, 'f.txt', M);
const kindsOf = (text: string) => hitsOf(text).map((h) => h.kind);

/**
 * 当前目录是否在一个 git 仓库里。
 *
 * 用 git 的那几条用例要按这个跳过：**源码 tarball 解出来是没有 `.git` 的**
 * （`.git` 本来就不该被发布），那时 `npm test` 必须照样全绿。
 * 测试依赖 git = 下载源码的人跑不过测试，这是真问题。
 */
const HAS_GIT = (() => {
  try {
    listFiles('tracked');
    return true;
  } catch {
    return false;
  }
})();
const gitOnly = { skip: HAS_GIT ? false : '当前目录不在 git 仓库里（源码 tarball 场景），跳过' };

// ─────────────────────── 该抓的必须抓到 ───────────────────────

test('scanText：凭据形态（云 token / 私钥 / JWT / 连接串）都能抓到', () => {
  const cases: Array<[string, string]> = [
    ['aws access key', `AKIA${'A'.repeat(16)}`],
    ['aws session key', `ASIA${'B'.repeat(16)}`],
    ['github pat', `ghp_${'a'.repeat(36)}`],
    ['github server token', `ghs_${'b'.repeat(36)}`],
    ['slack token', 'xoxb-1234567890-abcdefghij'],
    ['openai key', `sk-${'c'.repeat(30)}`],
    ['anthropic key', `sk-ant-${'d'.repeat(30)}`],
    ['pem private key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['pem ec key', '-----BEGIN EC PRIVATE KEY-----'],
    ['jwt', `eyJ${'e'.repeat(20)}.eyJ${'f'.repeat(20)}.sig`],
    ['mysql dsn with creds', 'mysql://user:secret@db.internal/app'],
    ['mongodb srv dsn', 'mongodb+srv://u:p@cluster.example.net'],
    ['redis dsn', 'redis://default:hunter2@cache:6379'],
    ['sshpass with password in argv', 'sshpass -p hunter2 ssh jump'],
    ['mysql -p inline', 'mysql -h db -p secretpw'],
    ['basic auth header', `Authorization: Basic ${'Q'.repeat(24)}=`],
  ];
  for (const [label, text] of cases) {
    assert.ok(kindsOf(text).includes('通用特征'), `应当命中：${label}`);
  }
});

test('scanText：内网 IP 段与家目录真实用户名都能抓到', () => {
  const cases: Array<[string, string]> = [
    ['10 段内网 IP', 'host = 10.20.30.40'],
    ['172.16 段', 'host = 172.16.10.30'],
    ['172.31 段上界', 'host = 172.31.0.1'],
    ['192.168 段', 'host = 192.168.1.1'],
    ['真实家目录路径', '/Users/' + 'somebody/work/repo'],
    ['linux 家目录路径', '/home/' + 'deploy/.ssh/id_rsa'],
  ];
  for (const [label, text] of cases) {
    assert.ok(kindsOf(text).includes('通用特征'), `应当命中：${label}`);
  }
});

test('**具体域名/口令片段/内部库名不进公开源码**——它们必须走仓库外的词表', () => {
  // 这条是踩过的：早期版本把这些特征串内联在 CI 的 workflow 正则里，
  // 结果公开仓库的 workflow 文件等于把内部域名、口令片段、逻辑库名一起公布了。
  // 拆开拼（'foo' + 'bar'）只能骗过扫描器自己，人类读者一眼就能拼回来——所以干脆不放。
  const src = readFileSync('scripts/sensitive-scan.mjs', 'utf8');
  // 把拆开拼的片段还原成"人类会读到的东西"，确认里面没有任何具体值
  const joined = src.replace(/['"]\s*\+\s*['"]/g, '');
  for (const forbidden of ['amazon' + 'captain', 'JY_' + 'ESB', 'Rc!@' + '#', 'pass@20']) {
    assert.ok(!joined.includes(forbidden), `扫描器源码里不该出现具体敏感值：${forbidden}`);
  }
});

test('具体敏感值走词表时确实能被抓到（外部注入这条路是通的）', () => {
  const m = buildMatchers(['portal.' + 'example-corp.test', 'rc-secret-fragment']);
  assert.equal(scanText('curl https://portal.' + 'example-corp.test/api', 'f', m)[0]?.kind, '词表命中');
  assert.equal(scanText('pw = rc-secret-fragment', 'f', m)[0]?.kind, '词表命中');
});

test('scanText：sshpass 用 -f 读文件是正确做法，不报', () => {
  assert.deepEqual(hitsOf('sshpass -f ~/.ssh/jump_pass ssh jump'), []);
});

test('scanText：行号从 1 开始，且报出命中片段原文', () => {
  const hits = hitsOf('第一行干净\n第二行 host = 10.1.1.1\n');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].what, '10.1.1.1');
  assert.match(hits[0].text, /host = 10\.1\.1\.1/);
});

test('scanText：一行里既有通用特征又有词表命中时两条都报', () => {
  const m = buildMatchers(['internal_widget_table']);
  const hits = scanText('FROM internal_widget_table WHERE ip = 10.9.9.9', 'f.sql', m);
  assert.deepEqual(new Set(hits.map((h) => h.kind)), new Set(['通用特征', '词表命中']));
});

// ─────────────────────── 不该抓的不能误报 ───────────────────────

test('scanText：占位符写法一律放行（这是仓库规定的正确写法）', () => {
  const ok = [
    'RC_BASE_URL=https://<host>/<context>',
    'DW_HOST=<fe-host>',
    'passwordFile: "~/.ssh/jump_pass"',
    '"jumpHost": "<jump-host>"',
    'mysql -h <host> -P <port>',
    'sshpass -f <password-file> ssh <jump-host>',
    '/Users/<user>/data-warehouse',
    '/home/${USER}/.dw',
    'DW_HOST=10.x.x.x',
    'host: <private-range>（示例网段）',
  ];
  for (const line of ok) assert.deepEqual(hitsOf(line), [], `不该命中：${line}`);
});

test('scanText：**字面写出的内网网段会被判为命中**——这是有意的严格（文档里请写 <private-range>）', () => {
  // 文档里描述"我们封了哪个网段"时很容易顺手写出字面 CIDR，那也是一条真实的内网拓扑信息。
  for (const line of ['封禁 10.0.0.0/8', '放行 172.16.0.0/12', '排除 192.168.0.0/16']) {
    assert.equal(hitsOf(line).length, 1, `应当命中：${line}`);
  }
});

test('scanText：RFC 5737 文档地址段与公网地址不报（不是内网）', () => {
  for (const ip of ['192.0.2.10', '198.51.100.7', '203.0.113.5', '8.8.8.8', '172.15.1.1', '172.32.1.1', '11.1.1.1']) {
    assert.deepEqual(hitsOf(`host = ${ip}`), [], `不该命中：${ip}`);
  }
});

test('scanText：普通代码与中文文档不误报', () => {
  const ok = [
    'const host = maskHost(env.host);',
    '// 连接串里的密码不要写进代码',
    'CREATE MATERIALIZED VIEW `db`.`mv` PARTITION BY (`dt`) ()',
    'sk-' + '是前缀，但长度不够不算',
  ];
  for (const line of ok) assert.deepEqual(hitsOf(line), [], `不该命中：${line}`);
});

test('scanText：含 NUL 的二进制内容直接跳过', () => {
  assert.deepEqual(hitsOf('10.1.1.1\u0000rest'), []);
});

// ─────────────────────── 词表 ───────────────────────

test('buildMatchers：词表按字面匹配，正则元字符被转义', () => {
  const m = buildMatchers(['dws_sales_1m']);
  assert.equal(scanText('FROM dws_sales_1m', 'f', m)[0]?.kind, '词表命中');
  const meta = buildMatchers(['a+b(c)']);
  assert.equal(scanText('xx a+b(c) xx', 'f', meta)[0]?.what, 'a+b(c)');
});

test('buildMatchers：长度 <3 的词被丢掉（否则全仓库打成筛子）', () => {
  const m = buildMatchers(['id', 'db', 'ab', 'abc']);
  assert.equal(m.word?.test('the id and db'), false);
  assert.equal(m.word?.test('abc'), true);
});

test('buildMatchers：没有可用词时 word 为 undefined（不构造空正则）', () => {
  assert.equal(buildMatchers([]).word, undefined);
  assert.equal(buildMatchers(['a', 'b']).word, undefined);
});

test('escapeRe：转义全部正则元字符', () => {
  assert.equal(escapeRe('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o'), 'a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o');
});

test('loadWords：内联词表按逗号切分并去空白', () => {
  assert.deepEqual(loadWords({ DW_SENSITIVE_WORDS: ' a , b ,, c ' }), ['a', 'b', 'c']);
});

test('loadWords：文件词表跳过空行与 # 注释', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  const f = join(dir, 'words.txt');
  writeFileSync(f, '# 注释\nreal_table\n\n  another_table  \n');
  assert.deepEqual(loadWords({ DW_SENSITIVE_WORDS_FILE: f }), ['real_table', 'another_table']);
});

test('loadWords：文件不存在时抛 E_WORDS_FILE（不能静默降级成"没词表"）', () => {
  assert.throws(() => loadWords({ DW_SENSITIVE_WORDS_FILE: '/nonexistent/words.txt' }), /不存在/);
});

test('loadWords：内联与文件同时给时合并', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  const f = join(dir, 'words.txt');
  writeFileSync(f, 'from_file\n');
  assert.deepEqual(loadWords({ DW_SENSITIVE_WORDS: 'from_env', DW_SENSITIVE_WORDS_FILE: f }), ['from_env', 'from_file']);
});

// ─────────────────────── 文件维度 ───────────────────────

test('scanFile：**文件名本身也要扫**（内容干净但名字泄漏）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  const f = join(dir, 'deploy-10.20.30.40.sh');
  writeFileSync(f, 'echo ok\n');
  const hits = scanFile(f, M);
  assert.equal(hits[0].kind, '文件名命中');
  assert.equal(hits[0].line, 0);
});

test('scanFile：二进制后缀不读内容，但仍查文件名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  const f = join(dir, 'logo.png');
  writeFileSync(f, 'AKIA' + 'A'.repeat(16));
  assert.deepEqual(scanFile(f, M), []);
});

test('scanFile：不存在的文件不抛，返回空', () => {
  assert.deepEqual(scanFile('/nonexistent/nope.txt', M), []);
});

test('scanFiles：多文件汇总', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  const a = join(dir, 'a.txt');
  const b = join(dir, 'b.txt');
  writeFileSync(a, 'host = 10.1.1.1\n');
  writeFileSync(b, 'host = 192.168.0.1\n');
  assert.equal(scanFiles([a, b], M).length, 2);
});

// ─────────────────────── 范围（曾经漏掉整个新增子域的那个洞） ───────────────────────

test('listFiles：默认包含**未跟踪但未忽略**的文件（新写的文件也在扫描范围内）', gitOnly, () => {
  const files = listFiles('publishable');
  assert.ok(files.length > 0);
  // 扫描器自身永远跳过
  assert.equal(files.includes('scripts/sensitive-scan.mjs'), false);
  // workflow 不再被整体豁免（曾经是个洞：workflow 里塞 secret 永远扫不出来）
  assert.ok(files.some((f) => f.startsWith('.github/workflows/')), 'workflow 必须在扫描范围内');
});

test('listFiles：tracked 是子集，publishable ⊇ tracked', gitOnly, () => {
  const tracked = new Set(listFiles('tracked'));
  const pub = listFiles('publishable');
  assert.ok(pub.length >= tracked.size);
  for (const f of tracked) assert.ok(pub.includes(f), `publishable 应含已跟踪文件 ${f}`);
});

test('listFiles：三种模式都不含扫描器自身', gitOnly, () => {
  for (const mode of ['publishable', 'tracked', 'staged'] as const) {
    assert.equal(listFiles(mode).includes('scripts/sensitive-scan.mjs'), false);
  }
});

test('listFiles：不在 git 仓库里时给**可行动**的错误，而不是把 git 的 fatal 抛出来', () => {
  const cwd = process.cwd();
  const outside = mkdtempSync(join(tmpdir(), 'nogit-'));
  try {
    process.chdir(outside);
    assert.throws(() => listFiles('publishable'), (err: any) => {
      assert.equal(err.code, 'E_NO_GIT');
      assert.match(err.message, /不在 git 仓库里/);
      assert.match(err.message, /--dir/);
      return true;
    });
  } finally {
    process.chdir(cwd);
    rmSync(outside, { recursive: true, force: true });
  }
});

test('listFilesInDir：走目录树，跳过 .git / node_modules / dist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'walk-'));
  try {
    mkdirSync(join(dir, 'sub'));
    mkdirSync(join(dir, 'node_modules'));
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'a.txt'), 'ok\n');
    writeFileSync(join(dir, 'sub', 'b.txt'), 'ok\n');
    writeFileSync(join(dir, 'node_modules', 'dep.txt'), 'x\n');
    writeFileSync(join(dir, '.git', 'HEAD'), 'x\n');
    writeFileSync(join(dir, 'dist', 'out.js'), 'x\n');

    const files = listFilesInDir(dir).map((f) => f.slice(dir.length + 1));
    assert.deepEqual(files, ['a.txt', 'sub/b.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listFilesInDir：不存在的目录返回空，不抛', () => {
  assert.deepEqual(listFilesInDir('/nonexistent/nowhere'), []);
});

test('parseArgs：--dir 支持 `--dir X` 与 `--dir=X` 两种写法', () => {
  assert.equal(parseArgs(['--dir', '/tmp/x']).dir, '/tmp/x');
  assert.equal(parseArgs(['--dir=/tmp/x']).dir, '/tmp/x');
});

test('parseArgs：--dir 缺参数 / 与其它范围互斥时都报错', () => {
  assert.throws(() => parseArgs(['--dir']), /需要一个路径/);
  assert.throws(() => parseArgs(['--dir', '--staged']), /需要一个路径|只能选一个/);
  assert.throws(() => parseArgs(['--dir', '/tmp/x', '--staged']), /只能选一个/);
  assert.throws(() => parseArgs(['--dir', '/tmp/x', '--tracked']), /只能选一个/);
});

test('runScan --dir：扫目录树并报出目录名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-dir-'));
  try {
    writeFileSync(join(dir, 'leak.txt'), 'host = 10.5.5.5\n');
    const r = runScan({ dir });
    assert.equal(r.code, 1);
    assert.match(r.err[1], /leak\.txt:1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runScan --dir：干净目录 → 退出码 0，结论行写"目录 <path>"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-dir-'));
  try {
    writeFileSync(join(dir, 'ok.txt'), 'nothing here\n');
    const r = runScan({ dir });
    assert.equal(r.code, 0);
    assert.match(r.out[0], /✔ clean：目录 /);
    assert.match(r.out[0], /共 1 个文件/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────── 入口：参数 / 结论 / 退出码 ───────────────────────

test('parseArgs：默认扫全部可发布文件；--staged / --tracked 切换范围', () => {
  assert.deepEqual(parseArgs([]), { mode: 'publishable', quiet: false, dir: undefined, history: false });
  assert.deepEqual(parseArgs(['--staged']), { mode: 'staged', quiet: false, dir: undefined, history: false });
  assert.deepEqual(parseArgs(['--tracked']), { mode: 'tracked', quiet: false, dir: undefined, history: false });
  assert.deepEqual(parseArgs(['--tracked', '--quiet']), { mode: 'tracked', quiet: true, dir: undefined, history: false });
  assert.deepEqual(parseArgs(['--history']), { mode: 'publishable', quiet: false, dir: undefined, history: true });
});

test('parseArgs：**未知参数直接报错**（拼错 flag 静默降级成"扫了"最危险）', () => {
  assert.throws(() => parseArgs(['--stage']), /未知参数/);
  assert.throws(() => parseArgs(['--all']), /未知参数/);
});

test('parseArgs：扫描范围只能选一个（--staged / --tracked / --dir / --history 两两互斥）', () => {
  const combos = [
    ['--staged', '--tracked'],
    ['--staged', '--history'],
    ['--tracked', '--history'],
    ['--dir', '/tmp/x', '--history'],
  ];
  for (const c of combos) assert.throws(() => parseArgs(c), /只能选一个/, `应当互斥：${c.join(' ')}`);
});

test('runScan：无命中 → 退出码 0，结论行含范围与文件数', () => {
  const r = runScan({ files: ['a.txt'], hits: [] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.err, []);
  assert.match(r.out[0], /✔ clean：全部可发布文件 共 1 个文件/);
  assert.match(r.out[0], /未提供外部词表/);
});

test('runScan：无命中且给了词表时结论行点明词表条数', () => {
  const r = runScan({ files: ['a.txt'], hits: [], env: { DW_SENSITIVE_WORDS: 'aa,bb,cc' } });
  assert.match(r.out[0], /含外部词表 3 条/);
});

test('runScan：有命中 → 退出码 1，逐条打印文件:行 + 片段', () => {
  const r = runScan({
    files: ['a.txt'],
    hits: [{ file: 'a.txt', line: 7, kind: '通用特征', what: 'X', text: 'host = X' }],
  });
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, []);
  assert.match(r.err[0], /命中 1 处敏感信息/);
  assert.match(r.err[1], /a\.txt:7 {2}\[通用特征\] X/);
  assert.match(r.err[2], /host = X/);
  assert.match(r.err.at(-1) ?? '', /改写成 <host> \/ <db> \/ <mv>/);
});

test('runScan：文件名命中（line=0）不打印冒号行号', () => {
  const r = runScan({ files: ['x.txt'], hits: [{ file: 'deploy.sh', line: 0, kind: '文件名命中', what: 'Y', text: 'deploy.sh' }] });
  assert.match(r.err[1], /deploy\.sh {2}\[文件名命中\]/);
  assert.ok(!r.err[1].includes('deploy.sh:'));
});

test('runScan：--quiet 只给计数，不逐条列', () => {
  const r = runScan({
    quiet: true,
    files: ['a.txt'],
    hits: [{ file: 'a.txt', line: 1, kind: '通用特征', what: 'X', text: 'X' }],
  });
  assert.equal(r.code, 1);
  assert.match(r.err[0], /--quiet 只给计数/);
  assert.equal(r.err.length, 2);
});

test('runScan：词表文件缺失 → 退出码 2（不是 0，**绝不能静默降级成"没词表"**）', () => {
  const r = runScan({ files: ['a.txt'], env: { DW_SENSITIVE_WORDS_FILE: '/nonexistent/words.txt' } });
  assert.equal(r.code, 2);
  assert.match(r.err[0], /不存在/);
});

test('main：参数错误 → 退出码 2，且不跑扫描', () => {
  assert.equal(main(['--nope'], {}), 2);
});

test('main：真实跑一遍仓库 → 退出码 0（仓库当前必须 clean）', gitOnly, () => {
  assert.equal(main(['--quiet'], process.env), 0);
});

// ─────────────────────── 自指安全 ───────────────────────

test('豁免名单不许扩：只允许扫描器自身与它自己的单测', () => {
  assert.deepEqual(SKIP_PATHS, ['scripts/sensitive-scan.mjs', 'tests/unit/sensitive-scan.test.ts']);
  // 整目录豁免是最容易把洞开大的写法，明确禁掉
  for (const p of SKIP_PATHS) assert.equal(p.endsWith('/'), false, `不许用目录豁免：${p}`);
});

test('自指安全：扫描器源码必须对自己 clean（特征串必须拆开拼）', () => {
  const src = readFileSync('scripts/sensitive-scan.mjs', 'utf8');
  assert.deepEqual(scanText(src, 'self', M), [], '扫描器自己命中了敏感特征——说明某个特征串没拆开拼');
});

test('自指安全：FRAGMENTS 里每条都能编译成合法正则', () => {
  for (const frag of FRAGMENTS) assert.doesNotThrow(() => new RegExp(frag), `非法正则：${frag}`);
});

test('自指安全：被豁免的文件确实存在（防止改名后豁免失效、洞被悄悄打开）', () => {
  for (const p of SKIP_PATHS) assert.doesNotThrow(() => readFileSync(p, 'utf8'), `豁免文件不存在：${p}`);
});

// ─────────────────────── 硬编码口令赋值（新增特征） ───────────────────────

test('scanText：硬编码口令赋值会被抓到', () => {
  const bad = [
    `password = "hunter2real"`,
    `password: 'sekrit123'`,
    `api_key = "abcdef123456"`,
    `access_key: "AKIA-not-really"`,
    `token = "ghp_notarealtoken123"`,
  ];
  for (const line of bad) assert.equal(hitsOf(line).length, 1, `应当命中：${line}`);
});

test('scanText：**夹具要写成占位符**——`<...>` / `${...}` / `***` 一律放行', () => {
  const ok = [
    `password: '<secret>'`,
    `password = '<from-file>'`,
    `password: '\${DB_PASS}'`,
    `password = "***"`,
    `token: '<token>'`,
    `password: '\${env:DB_PASS}'`,
    `password = "{{vault:db_pass}}"`,
  ];
  for (const line of ok) assert.deepEqual(hitsOf(line), [], `不该命中：${line}`);
});

test('scanText：自述为假的词放行（placeholder / example / dummy / xxx / zzz）', () => {
  const ok = [
    `password: 'example-password'`,
    `password: 'placeholder-value'`,
    `password: 'dummy-secret-123'`,
    `token: 'xxxxxxxxxxxx'`,
    `password: 'zzzzzzzz'`,
  ];
  for (const line of ok) assert.deepEqual(hitsOf(line), [], `不该命中：${line}`);
});

test('scanText：**`identitytoken` 不能被子串 `token` 误伤**（平台字段名里到处是它）', () => {
  for (const line of [`identitytoken: 'tk-abcdef'`, `addIdentitytoken: 'tk-abcdef'`]) {
    assert.deepEqual(hitsOf(line), [], `不该命中：${line}`);
  }
  // 但真正的 token 赋值还是要抓
  assert.equal(hitsOf(`token: 'tk-abcdef'`).length, 1);
});

test('scanText：正则字面量里的转义星号（断言打码结果）不误报', () => {
  assert.deepEqual(hitsOf(`assert.match(ddl, /"password" = "\\*\\*\\*"/);`), []);
});

// ─────────────────────── 历史扫描 ───────────────────────

test('listHistoryBlobs：能列出历史里的 blob（含已被删除的文件）', gitOnly, () => {
  const cwd = process.cwd();
  const repo = mkdtempSync(join(tmpdir(), 'hist-'));
  try {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    git('config', 'user.email', 't@example.test');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, 'gone.txt'), 'host = 10.7.7.7\n');
    writeFileSync(join(repo, 'kept.txt'), 'clean\n');
    git('add', '-A');
    git('commit', '-qm', 'add');
    rmSync(join(repo, 'gone.txt'));
    git('add', '-A');
    git('commit', '-qm', 'remove');

    process.chdir(repo);
    const blobs = listHistoryBlobs();
    const paths = blobs.map((b) => b.path);
    assert.ok(paths.includes('gone.txt'), '已被删除的文件仍应在历史里被扫到');
    assert.ok(paths.includes('kept.txt'));

    // 整条链路：工作树干净，但历史命中
    assert.equal(runScan({ quiet: true }).code, 0);
    const hist = runScan({ history: true });
    assert.equal(hist.code, 1);
    assert.match(hist.err.join('\n'), /gone\.txt:1/);
    assert.match(hist.err.join('\n'), /旧版本仍在对象库里/);
  } finally {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('listHistoryBlobs：**豁免名单在历史模式里同样生效**（否则扫描器自己的单测会让它永远红）', gitOnly, () => {
  const cwd = process.cwd();
  const repo = mkdtempSync(join(tmpdir(), 'hist-skip-'));
  try {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    git('config', 'user.email', 't@example.test');
    git('config', 'user.name', 't');
    mkdirSync(join(repo, 'scripts'));
    mkdirSync(join(repo, 'tests', 'unit'), { recursive: true });
    // 豁免文件里塞一个必然命中的串，另外放一个非豁免文件对照
    writeFileSync(join(repo, 'scripts', 'sensitive-scan.mjs'), 'host = 10.4.4.4\n');
    writeFileSync(join(repo, 'tests', 'unit', 'sensitive-scan.test.ts'), 'host = 10.5.5.5\n');
    writeFileSync(join(repo, 'other.ts'), 'host = 10.6.6.6\n');
    git('add', '-A');
    git('commit', '-qm', 'add');

    process.chdir(repo);
    const paths = listHistoryBlobs().map((b) => b.path);
    assert.ok(!paths.includes('scripts/sensitive-scan.mjs'), '扫描器自身应被豁免');
    assert.ok(!paths.includes('tests/unit/sensitive-scan.test.ts'), '扫描器的单测应被豁免');
    assert.ok(paths.includes('other.ts'), '非豁免文件必须照扫');

    const r = runScan({ history: true });
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /other\.ts:1/);
    assert.ok(!r.err.join('\n').includes('10.4.4.4'), '豁免文件不应被报出来');
  } finally {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('listHistoryBlobs：不在 git 仓库里时给可行动错误', () => {
  const cwd = process.cwd();
  const outside = mkdtempSync(join(tmpdir(), 'nogit-h-'));
  try {
    process.chdir(outside);
    assert.throws(() => listHistoryBlobs(), (err: any) => {
      assert.equal(err.code, 'E_NO_GIT');
      assert.match(err.message, /不在 git 仓库里/);
      return true;
    });
  } finally {
    process.chdir(cwd);
    rmSync(outside, { recursive: true, force: true });
  }
});

test('runScan --history：结论行写明扫的是历史（用临时仓库，不依赖本仓库的状态）', gitOnly, () => {
  const cwd = process.cwd();
  const repo = mkdtempSync(join(tmpdir(), 'hist-ok-'));
  try {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    git('config', 'user.email', 't@example.test');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'nothing sensitive\n');
    git('add', '-A');
    git('commit', '-qm', 'add');

    process.chdir(repo);
    const r = runScan({ history: true });
    assert.equal(r.code, 0);
    assert.match(r.out[0], /✔ clean：git 历史（全部提交的 blob）/);
    assert.match(r.out[0], /个历史版本/);
  } finally {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  }
});
