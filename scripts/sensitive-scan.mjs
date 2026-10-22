#!/usr/bin/env node
/**
 * 敏感信息扫描（双域）：iPaaS 侧 + 数仓侧。
 *
 * 为什么单独成脚本、而不是留在 workflow 的 shell 里：
 *   1. **双域特征要一起管**：iPaaS 有域名/口令/逻辑库名，数仓还有内网 IP、跳板机、
 *      业务表名与 MV 名——分散在两个地方迟早漏一个。
 *   2. **词表不能进仓库**：业务表名/MV 名/内部库名本身就是敏感面。
 *      所以通用特征写在代码里，**具体词表从仓库外读**（CI secret 或本地文件）。
 *   3. 本地能跑：提交前 `npm run scan` 就能自查，不用等 CI。
 *
 * 自指安全：下面的特征串**故意拆开拼**（`'gate' + 'way'`），
 * 这样本文件自己不会命中自己——否则扫描器第一个报的就是它自己。
 *
 * ## 扫描范围（这条曾经是漏洞）
 *
 * 默认扫的是**所有会被发布的文件** = `git ls-files --cached --others --exclude-standard`
 * （已跟踪 + 未跟踪但没被 ignore）。**只扫 `git ls-files` 是不够的**：
 * 新写的文件在 `git add` 之前全是"未跟踪"，正好是"还没进版本库、也还没被扫过"的窗口——
 * 这个窗口里夹带的东西会一路进到 push。曾经就是这样漏掉了整个新增子域。
 *
 * 用法：
 *   node scripts/sensitive-scan.mjs                 # 扫全部可发布文件（默认）
 *   node scripts/sensitive-scan.mjs --staged        # 只扫暂存区（pre-commit 用）
 *   node scripts/sensitive-scan.mjs --tracked       # 只扫已跟踪文件（旧行为）
 *   node scripts/sensitive-scan.mjs --dir <path>    # 扫一个目录树（不走 git，用于导出的副本）
 *   node scripts/sensitive-scan.mjs --history       # 扫 git 历史里出现过的全部 blob
 *   node scripts/sensitive-scan.mjs --quiet         # 只输出结论
 *   DW_SENSITIVE_WORDS_FILE=/path/words.txt ...     # 追加词表（一行一个，忽略 # 开头）
 *   DW_SENSITIVE_WORDS='foo,bar' ...                # 或直接给逗号分隔词
 * 退出码：0 = clean，1 = 命中，2 = 用法/环境错误
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 通用特征。**每一段都拆开拼**，避免本文件命中自己。
 *
 * 这里**只放"形状"**（凭据的形态、内网 IP 段、本机家目录路径），
 * 不放任何具体域名 / 口令片段 / 内部库名——那些是敏感面本身，
 * 走仓库外的词表（`DW_SENSITIVE_WORDS` / `DW_SENSITIVE_WORDS_FILE`）。
 * 判据见下面的长注释。
 */
export const FRAGMENTS = [
  // ── 凭据形态 ──
  // 各家云/平台的 token 前缀：认形状不认值，命中即真
  'AKIA' + '[0-9A-Z]{16}', // AWS access key id
  'ASIA' + '[0-9A-Z]{16}', // AWS 临时凭据
  'gh[pousr]' + '_[A-Za-z0-9]{36}', // GitHub PAT / app / oauth / refresh / server
  'xox[baprs]' + '-[A-Za-z0-9-]{10,}', // Slack
  'sk-' + '[A-Za-z0-9]{20,}', // OpenAI 风格
  'sk-ant-' + '[A-Za-z0-9_-]{20,}', // Anthropic
  '-{5}BEGIN[ A-Z]*' + 'PRIVATE KEY-{5}', // 私钥（PEM）
  // JWT：三段 base64url，前两段以 eyJ 开头
  'eyJ[A-Za-z0-9_-]{10,}' + '\\.eyJ[A-Za-z0-9_-]{10,}\\.',
  // 带凭据的连接串
  '(?:mongodb(?:\\+srv)?|mysql|postgres(?:ql)?|redis|amqp|clickhouse)://[^ :/@\\s]+:[^ @/\\s]+@',
  // 命令行里直接给密码（正确做法是 sshpass -f <file> / 环境变量，密码不进 argv）
  'sshpass\\s+-p\\s+\\S+',
  '(?:mysql|doriscli)\\s+[^\\n]*(?:-p|--password)[= ]\\S+',
  'Authorization:\\s*Basic\\s+[A-Za-z0-9+/=]{16,}',
  // 硬编码的口令赋值：`password = "真值"`。
  //   - 键名前要求非单词字符：否则 `identitytoken:` 会被 `token:` 这个子串命中
  //     （平台字段名里到处是 identitytoken，这条是纯噪声）。
  //   - 值排除占位与"已打码"写法：`<host>` / `${VAR}` / `***` / `{v}` / `\*\*\*`
  //     （最后一种是**正则字面量里**的转义星号，单测断言打码结果时到处都是）。
  //   - 值里带 placeholder/example/dummy/fake/xxx/zzz 这类自述为假的词也放过。
  // 夹具请一律写成 `'<secret>'`——写 `'super-secret'` 分不清是夹具还是真值。
  '(?:^|[^A-Za-z0-9_])(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[\'"]?\\s*[:=]\\s*[\'"](?!<|\\$|\\{|\\*|\\\\)(?![^\'"]*(?:placeholder|example|dummy|fake|redacted|changeme|xxx|zzz|todo))[^\'"]{6,}[\'"]',

  // ── 内部网络标识（通用形状，不含任何具体值） ──
  // 内网 IP 段（10/172.16-31/192.168）
  '\\b(?:10\\.[0-9]{1,3}|172\\.(?:1[6-9]|2[0-9]|3[01])|192\\.168)\\.[0-9]{1,3}\\.[0-9]{1,3}\\b',
  // 本机绝对家目录路径（真实用户名），排除 /Users/<user>/ 这类占位写法
  '/(?:Users|home)/(?!<|\\$|\\{|\\*)[A-Za-z0-9._-]+/',
];

/**
 * ## 哪些特征放代码里、哪些必须放仓库外
 *
 * **放代码里**：只有"形状"——各家云的 token 前缀、PEM 私钥头、JWT 三段式、
 * 连接串里的 `user:pass@`、内网 IP 段、本机家目录路径。
 * 这些是通用规律，写出来不泄露任何**具体**的东西。
 *
 * **必须放仓库外**（`DW_SENSITIVE_WORDS` / `DW_SENSITIVE_WORDS_FILE`）：
 * 具体域名、具体口令特征串、内部逻辑库名 / 服务名 / 表名 / MV 名。
 * **这些本身就是敏感面**——把特征写进公开源码等于把秘密一起公开，
 * 而且拆开拼（`'foo' + 'bar'`）只是骗过扫描器自己，人类读者一眼就能拼回来。
 *
 * 这条是踩过的：早期版本的 CI 把这类特征串**内联在 workflow 的正则里**，
 * 结果公开仓库的 workflow 文件等于把内部域名、口令片段、逻辑库名一并公布了出去。
 * 现在一律外部注入；仓库里只留 `sensitive-words.example.txt` 说明**该填哪些类别**。
 */

/** 该文件自身永远跳过（含拆开的特征串）。 */
const SELF = 'scripts/sensitive-scan.mjs';
/** 扫描器的单测：它的**全部内容就是**各类敏感特征的正例夹具，跳过。 */
const SELF_TEST = 'tests/unit/sensitive-scan.test.ts';

/**
 * 路径维度的跳过名单。**只有这两条，且都不许再扩**——
 * 曾经把整个 `.github/workflows/` 也跳了，那是个洞：workflow 里塞个 secret 永远扫不出来。
 * 现在 workflow 只含拆开拼的引用，本来就不会命中，不需要豁免。
 *
 * 豁免这两条是因为它们的职责就是"写出这些特征"：扫描器自己要把特征串拆开拼，
 * 单测则必须有正例。**其余任何文件都不豁免**，尤其不许出现 `tests/**` 这种整目录豁免。
 */
export const SKIP_PATHS = [SELF, SELF_TEST];


/** 这些后缀按二进制处理，不读内容。 */
const BINARY_EXT = /\.(?:png|jpe?g|gif|ico|webp|pdf|zip|gz|tgz|bz2|xz|7z|jar|war|so|dylib|dll|exe|bin|woff2?|ttf|eot|mp4|mov|sqlite|db)$/i;

/** 超过这个大小就不全文扫（避免误把大产物读进内存）；按大小截断头部。 */
const MAX_BYTES = 8 * 1024 * 1024;

/** 词表里的词按字面匹配（转义正则元字符），并跳过明显太短的词。 */
export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 列出候选文件。 */
export function listFiles(mode) {
  const args =
    mode === 'staged'
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
      : mode === 'tracked'
        ? ['ls-files']
        : ['ls-files', '--cached', '--others', '--exclude-standard'];
  let raw;
  try {
    // stderr 显式 pipe 掉：execFileSync 默认把子进程 stderr **继承**给父进程，
    // 不在 git 仓库里时用户会先看到一行原始 `fatal: not a git repository`，
    // 再看到我们的提示——既难看又容易被当成脚本坏了。
    raw = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = new Error(
      '不在 git 仓库里（或没装 git），无法确定"哪些文件会被发布"。\n' +
        '  请在仓库根目录运行；若只想扫某个目录，用 `--dir <path>`。',
    );
    e.code = 'E_NO_GIT';
    e.cause = err;
    throw e;
  }
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => !SKIP_PATHS.includes(f));
}

/** `--dir` 模式：不走 git，直接走目录树。用于扫导出的副本 / 构建产物。 */
export function listFilesInDir(dir) {
  const skipDir = new Set(['.git', 'node_modules', 'dist', 'coverage', '.cache']);
  const out = [];
  const walk = (rel) => {
    const abs = rel ? join(dir, rel) : dir;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (skipDir.has(e.name)) continue;
        walk(rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile()) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (!SKIP_PATHS.some((s) => p === s || p.endsWith(`/${s}`))) out.push(join(dir, p));
      }
    }
  };
  walk('');
  return out.sort();
}

/**
 * 列出**历史里出现过的**每个 blob（去重）。返回 `[{ path, text }]`。
 *
 * 为什么需要扫历史：文件被改掉之后，**旧版本仍然躺在 git 对象库里**，
 * push 上去照样能被 `git log -p` 翻出来。"当前树 clean"不等于"仓库 clean"。
 * 这一点在把仓库开源之前是必须过的关。
 *
 * 实现上按 blob 去重（同一个文件改 20 次只扫一次），并用 `git cat-file --batch`
 * 一次性读，避免"每个 commit 一次 `ls-tree`"的 O(n²) 调用。
 */
export function listHistoryBlobs({ maxBytes = MAX_BYTES } = {}) {
  let revList;
  try {
    revList = execFileSync('git', ['rev-list', '--objects', '--all'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    const e = new Error('不在 git 仓库里（或没装 git），无法扫历史。');
    e.code = 'E_NO_GIT';
    e.cause = err;
    throw e;
  }

  // sha → 首次出现的路径（同一 blob 多个路径只记第一个）
  const pathOf = new Map();
  for (const line of revList.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp <= 0) continue;
    const sha = line.slice(0, sp);
    const path = line.slice(sp + 1).trim();
    if (path && !pathOf.has(sha)) pathOf.set(sha, path);
  }
  if (!pathOf.size) return [];

  const shas = [...pathOf.keys()];
  const input = shas.join('\n') + '\n';
  let batch;
  try {
    // **不要传 `encoding: 'buffer'`**——那会抛 `Unknown encoding: buffer`。
    // 想拿 Buffer 就整个不传 `encoding`（默认即 Buffer）。
    batch = execFileSync('git', ['cat-file', '--batch'], {
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  if (!Buffer.isBuffer(batch)) batch = Buffer.from(String(batch), 'utf8');

  const out = [];
  let pos = 0;
  while (pos < batch.length) {
    const nl = batch.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = batch.slice(pos, nl).toString('utf8');
    pos = nl + 1;
    const parts = header.split(' ');
    if (parts.length < 3) break; // `<sha> missing` 之类
    const [, type, sizeStr] = parts;
    const size = Number(sizeStr);
    if (!Number.isFinite(size)) break;
    const body = batch.slice(pos, pos + size);
    pos += size + 1; // 内容后跟一个 \n
    if (type !== 'blob') continue;

    const path = pathOf.get(parts[0]) ?? '(unknown)';
    // 豁免名单在历史模式里同样生效——否则扫描器自己的单测（内容就是各类特征的正例夹具）
    // 会让 `--history` 永远红着，"这条永远红"的检查等于没有检查。
    if (SKIP_PATHS.includes(path)) continue;
    if (BINARY_EXT.test(path) || size > maxBytes) continue;
    const text = body.toString('utf8');
    if (text.includes('\u0000')) continue;
    out.push({ path, text, sha: parts[0] });
  }
  return out;
}

/** 读词表：环境变量内联 + 仓库外文件。 */
export function loadWords(env = process.env) {
  const out = [];
  const inline = env.DW_SENSITIVE_WORDS;
  if (inline) out.push(...inline.split(',').map((s) => s.trim()).filter(Boolean));
  const file = env.DW_SENSITIVE_WORDS_FILE;
  if (file) {
    if (!existsSync(file)) {
      const err = new Error(`DW_SENSITIVE_WORDS_FILE 不存在：${file}`);
      err.code = 'E_WORDS_FILE';
      throw err;
    }
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const w = line.trim();
      if (w && !w.startsWith('#')) out.push(w);
    }
  }
  return out;
}

/** 编译匹配器。词表要求长度 ≥3，避免 `id`、`db` 这类词把全仓库打成筛子。 */
export function buildMatchers(words = []) {
  const usable = words.filter((w) => w.length >= 3);
  return {
    generic: new RegExp(FRAGMENTS.join('|')),
    word: usable.length ? new RegExp(usable.map(escapeRe).join('|'), 'i') : undefined,
  };
}

/**
 * 扫一段文本，返回命中。**纯函数**，便于单测。
 * 逐行扫，行号从 1 开始。
 */
export function scanText(text, file, matchers) {
  const hits = [];
  if (text.includes('\u0000')) return hits;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const g = matchers.generic.exec(line);
    if (g) hits.push({ file, line: i + 1, kind: '通用特征', what: g[0], text: line.trim().slice(0, 160) });
    const w = matchers.word?.exec(line);
    if (w) hits.push({ file, line: i + 1, kind: '词表命中', what: w[0], text: line.trim().slice(0, 160) });
  }
  return hits;
}

/** 扫一个文件（含**文件名本身**——文件名也是发布面）。 */
export function scanFile(file, matchers) {
  const hits = [];
  // 文件名/路径也要扫：`deploy-<内网IP>.sh` 这种，内容干净但名字泄漏。
  const nameHit = matchers.generic.exec(file) ?? matchers.word?.exec(file);
  if (nameHit) hits.push({ file, line: 0, kind: '文件名命中', what: nameHit[0], text: file });

  if (BINARY_EXT.test(file)) return hits;
  let text;
  try {
    if (statSync(file).size > MAX_BYTES) return hits;
    text = readFileSync(file, 'utf8');
  } catch {
    return hits; // 二进制/不可读/符号链接断裂，跳过
  }
  return hits.concat(scanText(text, file, matchers));
}

/** 扫一批文件。 */
export function scanFiles(files, matchers) {
  return files.flatMap((f) => scanFile(f, matchers));
}

/** 各模式在结论行里的中文说法。 */
const SCOPE_LABEL = { publishable: '全部可发布文件', staged: '暂存区', tracked: 'git 跟踪文件' };
/** 解析命令行参数 → 模式与开关。未知参数直接报错（静默忽略拼错的 flag 很危险）。 */
export function parseArgs(argv) {
  const known = ['--staged', '--tracked', '--quiet', '--history'];
  const takesValue = ['--dir'];
  const unknown = argv.filter(
    (a) => a.startsWith('-') && !known.includes(a) && !takesValue.some((k) => a === k || a.startsWith(`${k}=`)),
  );
  if (unknown.length) {
    const err = new Error(`未知参数：${unknown.join(' ')}（可用：${[...known, '--dir <path>'].join(' / ')}）`);
    err.code = 'E_USAGE';
    throw err;
  }
  const dirEq = argv.find((a) => a.startsWith('--dir='))?.slice('--dir='.length);
  const dirIdx = argv.indexOf('--dir');
  const dir = dirEq ?? (dirIdx >= 0 ? argv[dirIdx + 1] : undefined);
  if (dirIdx >= 0 && !dirEq && (dir === undefined || dir.startsWith('-'))) {
    const err = new Error('--dir 需要一个路径参数');
    err.code = 'E_USAGE';
    throw err;
  }
  const history = argv.includes('--history');
  const scopeFlags = [
    dir ? '--dir' : '',
    argv.includes('--staged') ? '--staged' : '',
    argv.includes('--tracked') ? '--tracked' : '',
    history ? '--history' : '',
  ].filter(Boolean);
  if (scopeFlags.length > 1) {
    const err = new Error(`扫描范围只能选一个，收到：${scopeFlags.join(' + ')}`);
    err.code = 'E_USAGE';
    throw err;
  }
  const mode = argv.includes('--staged') ? 'staged' : argv.includes('--tracked') ? 'tracked' : 'publishable';
  return { mode, quiet: argv.includes('--quiet'), dir, history };
}

/**
 * 跑一次扫描并产出**结论文本**（不直接写 stdout，便于单测与复用）。
 * 返回 `{ code, out, err }`：`code` 即进程退出码。
 */
export function runScan({ mode = 'publishable', quiet = false, env = process.env, dir, history = false, files, hits } = {}) {
  let list;
  let words;
  let found;
  try {
    words = loadWords(env);
    if (history) {
      // 历史模式：每个去重后的 blob 当"一个文件"扫。
      const blobs = listHistoryBlobs();
      const m = buildMatchers(words);
      found = hits ?? blobs.flatMap((b) => scanText(b.text, b.path, m));
      list = blobs;
    } else {
      list = files ?? (dir ? listFilesInDir(dir) : listFiles(mode));
      found = hits ?? scanFiles(list, buildMatchers(words));
    }
  } catch (err) {
    return { code: 2, out: [], err: [`✖ ${err instanceof Error ? err.message : String(err)}`] };
  }

  const scope = history ? 'git 历史（全部提交的 blob）' : dir ? `目录 ${dir}` : SCOPE_LABEL[mode];
  const unit = history ? '个历史版本' : '个文件';

  if (!found.length) {
    const extra = words.length ? `（含外部词表 ${words.length} 条）` : '（未提供外部词表）';
    return { code: 0, out: [`✔ clean：${scope} 共 ${list.length} ${unit}，无敏感命中${extra}`], err: [] };
  }

  const err = [];
  if (quiet) {
    err.push(`✖ 命中 ${found.length} 处敏感信息（--quiet 只给计数）`);
  } else {
    err.push(`✖ 命中 ${found.length} 处敏感信息：\n`);
    for (const h of found) {
      err.push(`  ${h.file}${h.line ? `:${h.line}` : ''}  [${h.kind}] ${h.what}`);
      err.push(`      ${h.text}`);
    }
  }
  err.push(
    history
      ? '\n历史里的命中**改当前文件是没用的**——旧版本仍在对象库里，push 上去照样能翻出来。\n' +
          '处置：改写历史（`git filter-repo` / BFG）或**新起干净历史**，二选一，需明确授权后再做。'
      : '\n清理后再提交。若确认是占位符，请改写成 <host> / <db> / <mv> 这类形式。',
  );
  return { code: 1, out: [], err };
}

/** CLI 入口：解析参数 → 跑扫描 → 落 IO → 返回退出码。 */
export function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const { code, out, err } = runScan({ mode: opts.mode, quiet: opts.quiet, dir: opts.dir, history: opts.history, env });
  for (const line of out) console.log(line);
  for (const line of err) console.error(line);
  return code;
}

/**
 * 本文件是不是被**直接执行**的（而不是被 import）。
 *
 * 不能简单比 `import.meta.url === pathToFileURL(process.argv[1]).href`：
 * Node 会把模块路径解析成 **realpath**，而 `argv[1]` 是调用方写的那个路径。
 * 只要路径里有一层符号链接（macOS 上 `/tmp` 就是 `/private/tmp` 的软链，
 * 软链的 checkout、某些 CI 工作目录同理），两边就不相等 →
 * **`main()` 永远不跑，脚本静默退出 0**。安全闸静默放行是最坏的失败模式。
 * 所以两边都取 realpath 再比。
 */
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return entry === self;
  }
}

if (isDirectRun()) {
  process.exit(main());
}

export { fileURLToPath };
