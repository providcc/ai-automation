/**
 * SSH 隧道：把内网 FE 的 MySQL / HTTP 端口转发到本机 loopback。
 *
 * 为什么自己实现：Apache Doris 官方 CLI 只提供 SOCKS5（BYOC），不负责建跳板机连接；
 * 而到数仓网段的唯一通路往往是跳板机 + 本地转发，且笔记本合盖休眠会掐断它，
 * 所以"起隧道 / 探活 / 重建"必须是工具的一等能力，而不是让人手敲 ssh。
 *
 * 三条实测经验写进实现，不是注释摆设：
 *   1. **探活看端口，不看进程**：ssh 进程还在但转发已死的形态真实存在；
 *      反过来 `-f` 起完后进程会脱离父进程，也别指望拿得到句柄。
 *   2. **重建前先清干净**：同一组 -L 起两份会因本地端口占用而失败
 *      （ExitOnForwardFailure 下直接退出）；但盲目 pkill ssh 会误杀别人——
 *      所以按"转发表 + 跳板机"精确匹配再杀。
 *   3. **休眠即断**：本机 sleep/合盖会断开隧道；`dw doctor` 要把这件事报出来，
 *      而不是让人在查询返回空结果时猜半天。
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import type { TunnelForward, TunnelSpec } from './config.ts';
import { RcError } from '../errors.ts';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 进程/端口探测的可注入接口：单测里替换掉，避免真的起 ssh。 */
export interface TunnelRuntime {
  exec(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>;
  isPortListening(port: number): Promise<boolean>;
  /** 列出与 pattern 匹配的进程 pid（pattern 用于精确匹配隧道，不能是宽泛的 'ssh'） */
  findPids(pattern: string): Promise<number[]>;
}

/** 默认运行时：真起进程、真探端口。 */
export function defaultTunnelRuntime(): TunnelRuntime {
  const runtime: TunnelRuntime = {
    exec(cmd, args, opts = {}) {
      return new Promise<ExecResult>((resolve) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += String(d); });
        child.stderr.on('data', (d) => { stderr += String(d); });
        const timer = opts.timeoutMs ? setTimeout(() => { child.kill('SIGKILL'); }, opts.timeoutMs) : undefined;
        child.on('error', (e) => {
          if (timer) clearTimeout(timer);
          resolve({ code: -1, stdout, stderr: `${stderr}${(e as Error).message}` });
        });
        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    },
    isPortListening(port) {
      return new Promise<boolean>((resolve) => {
        const sock = connect({ host: '127.0.0.1', port });
        const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
        sock.setTimeout(1_500);
        sock.on('connect', () => done(true));
        sock.on('timeout', () => done(false));
        sock.on('error', () => done(false));
      });
    },
    async findPids(pattern) {
      const r = await runtime.exec('pgrep', ['-f', pattern], { timeoutMs: 5_000 });
      return r.stdout.split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    },
  };
  return runtime;
}

/**
 * 组装 ssh 命令行。
 * 认证二选一：passwordFile（走 `sshpass -f`，密码不进 argv）或 identityFile（-i）。
 * 两者都没配就交给 ssh 自己走 ~/.ssh/config 与 agent。
 */
export function buildSshInvocation(
  spec: TunnelSpec & { forwards: TunnelForward[] },
  opts: { sshpassPath?: string } = {},
): { cmd: string; args: string[] } {
  const sshArgs: string[] = [
    '-N',                                  // 不执行远端命令，只做转发
    '-f',                                  // 起完就进后台，不占住调用方
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',        // 半开连接探测，避免"看着活着其实已死"
    '-o', 'ExitOnForwardFailure=yes',      // 端口占不上就直接失败，不要留个半死进程
  ];
  if (spec.jumpPort) sshArgs.push('-p', String(spec.jumpPort));
  if (spec.identityFile) sshArgs.push('-i', spec.identityFile);
  for (const f of spec.forwards) sshArgs.push('-L', `${f.local}:${f.remoteHost}:${f.remotePort}`);
  for (const extra of spec.extraArgs ?? []) sshArgs.push(extra);
  const target = spec.jumpUser ? `${spec.jumpUser}@${spec.jumpHost}` : spec.jumpHost;
  sshArgs.push(target);

  if (spec.passwordFile) {
    return { cmd: opts.sshpassPath ?? 'sshpass', args: ['-f', spec.passwordFile, 'ssh', ...sshArgs] };
  }
  return { cmd: 'ssh', args: sshArgs };
}

/**
 * 用于精确匹配"是本工具起的这条隧道"的特征串。
 * 含跳板机与全部转发对，避免 pkill ssh 误伤别人的隧道。
 */
export function tunnelSignature(spec: TunnelSpec & { forwards: TunnelForward[] }): string {
  const fwd = spec.forwards.map((f) => `${f.local}:${f.remoteHost}:${f.remotePort}`).join('.*-L ');
  return `-L ${fwd}`;
}

// ─────────────────────────── ssh 报错归因 ───────────────────────────

/**
 * OpenSSH 的**噪声**：与"为什么没起来"无关，但会把真正的原因淹掉。
 *
 * 实测踩过：`dw tunnel up` 的真实原因是 `bind [::1]:19030: Address already in use`，
 * 而 stderr 里最先出现、最长的是 post-quantum 那一组 `** WARNING` 横幅——
 * 只看第一行的话，用户完全看不到端口占用，只能手工跑同一条 ssh 才发现。
 */
const SSH_NOISE: RegExp[] = [
  /^\*\*/, // `** WARNING: connection is not using a post-quantum key exchange algorithm.` 等三行横幅
  /post-quantum/i,
  /store now,?\s*decrypt later/i,
  /openssh\.com\/pq/i,
  /^Warning: Permanently added .*known hosts\.?$/i,
  /^debug\d*:/i,
];

/** 去噪：返回有信息量的行 + 被丢掉的行数（丢了多少要说出来，别让人以为输出完整）。 */
export function filterSshNoise(text: string): { lines: string[]; dropped: number } {
  const all = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const lines = all.filter((l) => !SSH_NOISE.some((re) => re.test(l)));
  return { lines, dropped: all.length - lines.length };
}

/**
 * 转发端口的默认推算约定。
 *
 * 写进错误信息里是有意的：撞端口时最需要的正是"我该把本地端口写成多少"，
 * 而这条约定原来只写在文档里，撞了端口的人根本看不到。
 */
export const FORWARD_CONVENTION =
  '本地端口默认按「远端端口 + 10000」推算（如 9030 → 19030）；' +
  '若本机已有隧道用了别的约定（常见的是把 HTTP 8030 直接转到本机 8030），' +
  '照它的约定在环境配置的 forwards 里**显式写本地端口**，不要靠推算。';

export type TunnelFailureReason =
  | 'port-in-use'
  | 'forward-refused'
  | 'auth'
  | 'host-key'
  | 'unreachable'
  | 'ssh-missing'
  | 'unknown';

export interface TunnelDiagnosis {
  reason: TunnelFailureReason;
  /** 一句话原因（放在最前） */
  summary: string;
  /** 关键行：已去噪，按"最能说明原因"排序 */
  keyLines: string[];
  /** 可行动的下一步 */
  action: string;
  /** 被过滤掉的 OpenSSH 噪声行数 */
  droppedNoise: number;
}

interface FailureRule {
  reason: TunnelFailureReason;
  re: RegExp;
  summary: string;
  action: string;
  /** 探到了具体端口时用这一版：把占位符换成真实端口号，直接可粘贴执行 */
  actionWithPorts?: (ports: number[]) => string;
}

/** 归因优先级：越靠前越具体，命中即停。 */
const FAILURE_RULES: FailureRule[] = [
  {
    reason: 'port-in-use',
    re: /address already in use|bind\b.*failed|cannot listen to port/i,
    summary: '本地端口已被占用，ssh 无法把转发挂上去',
    action:
      '下一步：\n' +
      '  1) 看是谁占着：`lsof -nP -iTCP:<本地端口> -sTCP:LISTEN`（macOS/Linux 通用）\n' +
      '  2) 是本工具起的重复副本 → `dw tunnel down` 后重试；是手工/别的工具起的 → 用上一步拿到的 pid kill 掉\n' +
      `  3) 不想动它就把本地端口换个号：${FORWARD_CONVENTION}`,
    actionWithPorts: (ports) =>
      '下一步：\n' +
      `  1) 看是谁占着：\`lsof -nP -iTCP:${ports[0]} -sTCP:LISTEN\`（macOS/Linux 通用）\n` +
      '  2) 是本工具起的重复副本 → `dw tunnel down` 后重试；是手工/别的工具起的 → 用上一步拿到的 pid kill 掉\n' +
      `  3) 不想动它就把本地端口换个号：${FORWARD_CONVENTION}`,
  },
  {
    reason: 'forward-refused',
    re: /could not request local forwarding/i,
    summary: '跳板机拒绝了本地转发请求（端口被占用，或跳板机策略不允许 -L）',
    action: `下一步：确认本地端口没被占用（lsof），并确认跳板机允许 -L 转发。${FORWARD_CONVENTION}`,
    actionWithPorts: (ports) =>
      `下一步：\n` +
      `  1) 看是谁占着：\`lsof -nP -iTCP:${ports[0]} -sTCP:LISTEN\`（macOS/Linux 通用）\n` +
      '  2) 确认跳板机允许 -L 转发\n' +
      `  3) 不想动它就把本地端口换个号：${FORWARD_CONVENTION}`,
  },
  {
    reason: 'auth',
    re: /permission denied|authentication failed|too many authentication failures|no supported authentication|sshpass/i,
    summary: '跳板机认证失败',
    action:
      '下一步：确认账号/密码文件或私钥可用。\n' +
      '  用 passwordFile 时检查文件内容与权限（建议 0600）；用私钥时确认 -i 路径与 agent 里的 key。\n' +
      '  手工复现：直接跑 `ssh -v <user>@<跳板机> -p <端口>` 看它接受了哪种认证方式。',
  },
  {
    reason: 'host-key',
    re: /host key verification failed|remote host identification has changed/i,
    summary: '跳板机主机指纹校验失败',
    action: '下一步：跳板机换过机器或证书时会这样；核对指纹后清理 ~/.ssh/known_hosts 里的旧条目再重试。',
  },
  {
    reason: 'unreachable',
    re: /connection refused|connection timed out|no route to host|host unreachable|network is unreachable|could not resolve hostname|operation timed out/i,
    summary: '跳板机不可达',
    action: '下一步：确认跳板机地址/端口正确、本机网络能到它（可能需先连 VPN）。先 `nc -vz <跳板机> <端口>` 探一下。',
  },
  {
    reason: 'ssh-missing',
    re: /enoent|command not found|not found in \$path/i,
    summary: '找不到 ssh 或 sshpass 可执行文件',
    action: '下一步：装好 openssh-client；用 passwordFile 认证时还需要 sshpass（或改用私钥 / ~/.ssh/config）。',
  },
];

/**
 * 把 ssh 的原始 stderr 变成"原因 + 关键行 + 下一步"。
 *
 * 为什么必须做：ssh 的 stderr 顺序与重要性无关，且常被 OpenSSH 自己的告警淹没。
 * 直接把原文丢给用户，等于让人从一屏噪声里自己找那一行——
 * 实测中用户最后是**手工跑了同一条 ssh** 才看到真正的原因。
 */
export function diagnoseTunnelFailure(
  stderr: string,
  spec: { forwards: TunnelForward[]; jumpHost: string; passwordFile?: string; identityFile?: string },
  opts: { listeningLocals?: number[]; exitCode?: number } = {},
): TunnelDiagnosis {
  const { lines, dropped } = filterSshNoise(stderr);
  const text = lines.join('\n');
  const rule = FAILURE_RULES.find((r) => r.re.test(text));

  // 端口占用常常只有一行 `bind [::1]:19030: Address already in use`，
  // 而 ssh 在 ExitOnForwardFailure 下不一定把 `Could not request local forwarding` 打出来；
  // 反过来，端口在监听而 ssh 又没报错时也能反推是占用。
  const listening = opts.listeningLocals ?? [];
  // `Could not request local forwarding` 单独出现时，原因既可能是端口被占、
  // 也可能是跳板机策略不允许 -L。**端口确实在监听是更强的证据** —— 那就归到占用，
  // 并给出具体端口的排查命令；跳板机策略问题通常不会有端口在监听。
  const effectiveRule = rule?.reason === 'forward-refused' && listening.length > 0
    ? FAILURE_RULES.find((r) => r.reason === 'port-in-use')
    : rule;
  const reason: TunnelFailureReason = effectiveRule?.reason
    ?? (listening.length > 0 ? 'port-in-use' : 'unknown');

  let summary = effectiveRule?.summary ?? 'ssh 未成功建立隧道';
  if (reason === 'port-in-use' && listening.length > 0) {
    summary = `本地端口 ${listening.join('、')} 已被占用，ssh 无法把转发挂上去`;
  } else if (reason === 'unknown') {
    // 归不到已知类别时，**原文第一行就是原因**——把它抬进摘要，别让用户再从下面找
    const first = lines[0];
    summary = first
      ? `ssh 以退出码 ${opts.exitCode ?? '非 0'} 退出：${first}`
      : `ssh 以退出码 ${opts.exitCode ?? '非 0'} 退出，且没有输出可供归因`;
  }

  const action = (effectiveRule?.actionWithPorts && listening.length > 0
    ? effectiveRule.actionWithPorts(listening)
    : effectiveRule?.action)
    ?? `下一步：手工跑一遍同一条命令看完整输出（ssh 的 -v 会给出更细的原因）。\n${FORWARD_CONVENTION}`;

  // 摘要里已经引用过的行不再重复列一遍（摘要+原文两处一样的句子只是噪声）
  const keyLines = lines.filter((l) => !summary.includes(l));
  return { reason, summary, keyLines, action, droppedNoise: dropped };
}

export interface TunnelStatus {
  enabled: boolean;
  up: boolean;
  forwards: { forward: TunnelForward; listening: boolean }[];
  /** 匹配到的本工具隧道进程数（>1 说明起了重复副本） */
  pids: number[];
  /**
   * 谁在提供这条隧道：
   *   - `tool`    本工具起的（pids 能匹配上）
   *   - `foreign` 转发端口在监听，但**不匹配**本工具的隧道进程——
   *               这条隧道不是 dw 起的（手工 ssh 或别的工具），`dw tunnel down` 关不掉它
   *   - `none`    没建立
   */
  owner: 'tool' | 'foreign' | 'none';
  hint?: string;
}

/** 探活：端口 + 进程双看。只要有一个转发端口不通就算 down。 */
export async function tunnelStatus(
  spec: TunnelSpec & { forwards: TunnelForward[] },
  runtime: TunnelRuntime = defaultTunnelRuntime(),
): Promise<TunnelStatus> {
  if (!spec.enabled) return { enabled: false, up: false, forwards: [], pids: [], owner: 'none' };
  const forwards: TunnelStatus['forwards'] = [];
  for (const f of spec.forwards) {
    forwards.push({ forward: f, listening: await runtime.isPortListening(f.local) });
  }
  const pids = await runtime.findPids(tunnelSignature(spec));
  const up = forwards.every((f) => f.listening);
  const anyListening = forwards.some((f) => f.listening);
  // owner 判的是"**谁**在提供这条隧道"，不是"通没通"：
  // 端口在监听、却匹配不到本工具的进程 → 这条隧道是手工/别的工具起的（foreign），
  // 这种形态在**隧道起不来**时最典型（端口被别人的隧道占着，dw 挂不上），
  // 所以不能只看 up —— 否则失败归因里就少了"dw tunnel down 关不掉它"这条关键信息。
  const owner: TunnelStatus['owner'] = anyListening ? (pids.length > 0 ? 'tool' : 'foreign') : 'none';
  let hint: string | undefined;
  if (!up && pids.length > 0) hint = '隧道进程在，但转发端口不通——通常是合盖休眠后进程残留，先 down 再 up。';
  else if (!up && owner === 'foreign') {
    hint =
      '转发端口在监听，但匹配不到本工具的隧道进程：这条隧道**不是 dw 起的**（手工 ssh 或别的工具），' +
      'dw tunnel down 关不掉它；要关请手工 kill。dw 会直接复用它，不影响查询。';
  }
  else if (!up) hint = '隧道未建立：执行 dw tunnel up。';
  else if (pids.length > 1) hint = `匹配到 ${pids.length} 个隧道进程，建议 down 后重建，避免重复副本。`;
  else if (owner === 'foreign') {
    hint =
      '转发端口在监听，但匹配不到本工具的隧道进程：这条隧道**不是 dw 起的**（手工 ssh 或别的工具），' +
      'dw tunnel down 关不掉它；要关请手工 kill。dw 会直接复用它，不影响查询。';
  }
  return { enabled: true, up, forwards, pids, owner, hint };
}

/**
 * 停隧道：按特征串精确杀，不做宽泛 pkill。
 *
 * 额外回报"杀完之后本地端口还在不在监听"——因为最常见的一种状态是
 * **端口被非本工具的进程占着**：此时 killed 为空而端口照旧通，
 * 只说"没有匹配的隧道进程"会让人以为端口空着、接着去 up，然后撞端口。
 */
export async function tunnelDown(
  spec: TunnelSpec & { forwards: TunnelForward[] },
  runtime: TunnelRuntime = defaultTunnelRuntime(),
): Promise<{ killed: number[]; stillListening: number[] }> {
  const pids = await runtime.findPids(tunnelSignature(spec));
  const killed: number[] = [];
  for (const pid of pids) {
    const r = await runtime.exec('kill', [String(pid)], { timeoutMs: 5_000 });
    if (r.code === 0) killed.push(pid);
  }
  const stillListening: number[] = [];
  for (const f of spec.forwards) {
    if (await runtime.isPortListening(f.local)) stillListening.push(f.local);
  }
  return { killed, stillListening };
}

/** 起隧道。已在且健康则直接返回；不健康则先清后起。 */
export async function tunnelUp(
  spec: TunnelSpec & { forwards: TunnelForward[] },
  runtime: TunnelRuntime = defaultTunnelRuntime(),
  opts: { force?: boolean; waitMs?: number } = {},
): Promise<{ ok: boolean; message: string; status: TunnelStatus }> {
  if (!spec.enabled) return { ok: false, message: '该环境未启用隧道', status: await tunnelStatus(spec, runtime) };

  const before = await tunnelStatus(spec, runtime);
  if (before.up && !opts.force) return { ok: true, message: '隧道已在且健康', status: before };
  if (before.pids.length > 0) await tunnelDown(spec, runtime);

  const { cmd, args } = buildSshInvocation(spec);
  const r = await runtime.exec(cmd, args, { timeoutMs: 30_000 });
  if (r.code !== 0) {
    // 报错前再探一次端口：ssh 的 stderr 经常**只有**一行 bind 失败，
    // 而"哪个本地端口被占"要自己探才知道。
    const after = await tunnelStatus(spec, runtime);
    const listeningLocals = after.forwards.filter((f) => f.listening).map((f) => f.forward.local);
    // stderr 与 stdout **都要看**：sshpass 把 ssh 的输出重定向到 stdout，
    // 真实原因（Address already in use）常在 stdout，而 stderr 只有噪声横幅。
    // 用 `stderr || stdout` 会把 stdout 整段丢掉 —— 归因就只剩噪声了。
    const combined = [r.stderr, r.stdout].filter((s) => s && s.trim()).join('\n');
    const d = diagnoseTunnelFailure(combined, spec, { listeningLocals, exitCode: r.code });
    const noise = d.droppedNoise > 0 ? `\n（已略过 ${d.droppedNoise} 行 OpenSSH 噪声告警）` : '';
    // 端口在监听但匹配不到本工具的进程 → 这条隧道不是 dw 起的（多半是手工 ssh）。
    // 这种情况 `dw tunnel down` **关不掉它**，必须说清楚，否则下一步是错的。
    const foreign = after.owner === 'foreign' && listeningLocals.length > 0;
    const ownerNote = foreign
      ? `\n注意：本地端口 ${listeningLocals.join('、')} 在监听，但匹配不到 dw 起的隧道进程——` +
        '这条隧道是手工/别的工具起的，`dw tunnel down` 关不掉它，要用 lsof 拿到 pid 手工 kill。'
      : '';
    throw new RcError('E_UPSTREAM', `建立隧道失败：${d.summary}\n${d.keyLines.join('\n')}${noise}${ownerNote}\n${d.action}`, {
      // 隧道问题的下一步与 Doris 报错的下一步完全无关，别让 dwErrorHint 的
      // "先看 detailMessage / 元数据读不到跑 dw doctor" 盖掉这里的归因。
      hint: '',
      detail: {
        reason: d.reason, keyLines: d.keyLines, droppedNoise: d.droppedNoise,
        exitCode: r.code, owner: after.owner, listeningLocals,
      },
    });
  }

  // -f 起完后进程已后台化，用端口探活确认（重试到 waitMs）
  const deadline = Date.now() + (opts.waitMs ?? 8_000);
  let status = await tunnelStatus(spec, runtime);
  while (!status.up && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 400));
    status = await tunnelStatus(spec, runtime);
  }
  if (!status.up) {
    const d = diagnoseTunnelFailure('', spec, {
      listeningLocals: status.forwards.filter((f) => f.listening).map((f) => f.forward.local),
    });
    throw new RcError('E_UPSTREAM', `隧道命令已执行但端口未就绪：${d.summary}\n${d.action}`, {
      hint: '',
      detail: { reason: d.reason },
    });
  }
  const desc = spec.forwards.map((f) => `${f.local}→${f.remoteHost}:${f.remotePort}`).join('、');
  return { ok: true, message: `隧道已建立（${desc}）`, status };
}

/** 需要时确保隧道可用（供查询前自动调用）。 */
export async function ensureTunnel(
  spec: (TunnelSpec & { forwards: TunnelForward[] }) | undefined,
  runtime: TunnelRuntime = defaultTunnelRuntime(),
): Promise<TunnelStatus | undefined> {
  if (!spec?.enabled) return undefined;
  const st = await tunnelStatus(spec, runtime);
  if (st.up) return st;
  const r = await tunnelUp(spec, runtime);
  return r.status;
}

/**
 * 隧道生效后的实际连接地址。
 * 启用隧道时 MySQL/HTTP 都改走本机转发端口——这正是"配置里写内网地址、运行时不直连"的关键。
 */
export function effectiveEndpoint(env: {
  host: string;
  mysqlPort: number;
  httpPort: number;
  tunnel?: { enabled: boolean; forwards: TunnelForward[] };
}): { mysqlHost: string; mysqlPort: number; httpHost: string; httpPort: number } {
  const tunnel = env.tunnel;
  if (!tunnel?.enabled) {
    return { mysqlHost: env.host, mysqlPort: env.mysqlPort, httpHost: env.host, httpPort: env.httpPort };
  }
  const pick = (remotePort: number, fallback: number) =>
    tunnel.forwards.find((f) => f.remotePort === remotePort)?.local ?? fallback;
  return {
    mysqlHost: '127.0.0.1',
    mysqlPort: pick(env.mysqlPort, env.mysqlPort),
    httpHost: '127.0.0.1',
    httpPort: pick(env.httpPort, env.httpPort),
  };
}
