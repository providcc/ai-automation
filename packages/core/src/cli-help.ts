/**
 * 命令帮助的**单一事实来源**。
 *
 * ## 为什么要有这个模块
 *
 * 原来每个 CLI 各写一个 `HELP` 大字符串，`--help` 一律打印它——
 * 于是 `rc flow save --help` 给的是**顶层**帮助：既不显示该命令自己的选项，
 * 也不显示它特有的坑，用户只能靠 `docs/COMMAND-REFERENCE.md` 或读源码。
 *
 * 现在：命令清单是一份**结构化数据**（{@link CommandSpec}），
 * 顶层帮助与单命令帮助都由它渲染，两边不可能再漂移。
 * 加一条命令时，`tests` 会强制要求它同时出现在 catalog 与 dispatch 里
 * （"文档写了但用不了"和"能用但没文档"都是缺陷）。
 *
 * ## 约定
 *
 * - `name` 是**规范命令路径**，与 CLI 里 `case '<path>':` 的写法逐字一致；
 *   子动作也算路径的一部分（`flow props save` 而不是 `flow`）。
 * - `usage` 自带 bin 前缀（`rc flow save …`），因为顶层帮助直接按行渲染它。
 * - 只读命令不写 `write: true`；写了就说明它默认 dry-run、需要 `--apply`。
 */

export interface HelpOption {
  /** 选项写法，如 `--apply`、`--kind esb|etl` */
  flag: string;
  desc: string;
}

export interface CommandSpec {
  /** 规范命令路径，空格分隔，与 CLI dispatch 逐字一致 */
  name: string;
  /** 顶层帮助里的分组标题 */
  group: string;
  /** 一行用法（含 bin 前缀） */
  usage: string;
  /** 一句话说明（顶层帮助里作为行尾注释） */
  summary: string;
  options?: HelpOption[];
  examples?: string[];
  /** 该命令特有的坑/约束。写在这里的东西是"用之前就该知道"的 */
  notes?: string[];
  /** 写操作：默认 dry-run，需 --apply */
  write?: boolean;
  /** 不在顶层帮助里列出（内部/兼容命令），但 `--help` 仍可查 */
  hidden?: boolean;
}

export interface HelpSpec {
  /** 可执行名，如 `rc` */
  bin: string;
  /** 顶层帮助首行 */
  title: string;
  commands: CommandSpec[];
  /** 顶层帮助尾部的通用说明（每行一段） */
  footer?: string[];
  /** 几乎每条命令都收的通用选项，附在单命令帮助末尾（免得每条 spec 都抄一遍） */
  common?: string;
}

// ─────────────────────────── 查找 ───────────────────────────

/**
 * 按位置参数找到最匹配的命令。
 *
 * 取**最长前缀**匹配：`rc flow props save --process-id p` 的位置参数是
 * `['flow','props','save']`，要命中 `flow props save` 而不是 `flow`。
 * 反过来，`rc flow get <pid>` 的位置参数是 `['flow','get','<pid>']`，
 * 多出来的参数是**该命令的实参**，所以必须逐级回退着找。
 */
export function findCommand(spec: HelpSpec, positionals: string[]): CommandSpec | undefined {
  for (let n = positionals.length; n > 0; n--) {
    const key = positionals.slice(0, n).join(' ');
    const hit = spec.commands.find((c) => c.name === key);
    if (hit) return hit;
  }
  return undefined;
}

// ─────────────────────────── 渲染 ───────────────────────────

/** 按 `group` 首次出现的顺序分组。 */
function grouped(commands: CommandSpec[]): [string, CommandSpec[]][] {
  const out: [string, CommandSpec[]][] = [];
  for (const c of commands) {
    if (c.hidden) continue;
    const bucket = out.find(([g]) => g === c.group);
    if (bucket) bucket[1].push(c);
    else out.push([c.group, [c]]);
  }
  return out;
}

/**
 * 顶层帮助：按分组列出每个命令的一行用法，行尾对齐补 `# 说明`。
 *
 * 对齐宽度按**分组内**最长用法算——按全局最长算会让短分组出现大片空白。
 */
export function renderTopHelp(spec: HelpSpec): string {
  const lines: string[] = [spec.title, ''];
  for (const [group, cmds] of grouped(spec.commands)) {
    lines.push(`${group}:`);
    const width = Math.max(...cmds.map((c) => c.usage.length));
    for (const c of cmds) {
      const pad = ' '.repeat(width - c.usage.length);
      lines.push(`  ${c.usage}${pad}   # ${c.summary}`);
    }
    lines.push('');
  }
  for (const para of spec.footer ?? []) lines.push(para);
  return lines.join('\n').replace(/\n+$/, '');
}

/** 单命令帮助：用法 / 说明 / 选项 / 注意 / 示例。 */
export function renderCommandHelp(spec: HelpSpec, c: CommandSpec): string {
  const out: string[] = [`${c.usage}`, '', c.summary];
  if (c.write) {
    out.push('', `写操作：默认 dry-run（只打印将要发送的请求）；追加 --apply 才真正执行。`);
  }
  if (c.options?.length) {
    out.push('', '选项:');
    const w = Math.max(...c.options.map((o) => o.flag.length));
    for (const o of c.options) out.push(`  ${o.flag.padEnd(w)}  ${o.desc}`);
  }
  if (c.notes?.length) {
    out.push('', '注意:');
    for (const n of c.notes) out.push(...wrapBullet(n));
  }
  if (c.examples?.length) {
    out.push('', '示例:');
    for (const e of c.examples) out.push(`  ${e}`);
  }
  out.push('', `通用: ${spec.common ?? `--json 机器可读输出（支持的命令上）`}`);
  out.push(`      ${spec.bin} --help 看全部命令；${spec.bin} <命令> --help 看该命令的用法。`);
  return out.join('\n');
}

/** 多行说明按缩进折行，避免一坨长句糊在终端上。 */
function wrapBullet(text: string, indent = 2, width = 96): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if (cur.length >= width && /[\s，。；、）]$/.test(ch)) {
      lines.push(cur);
      cur = '';
    }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => `${' '.repeat(indent)}· ${l.trimStart()}`);
}

/** 把命令清单里的 `name` 抽出来（给测试做 catalog ↔ dispatch 双向核对）。 */
export function commandNames(spec: HelpSpec): string[] {
  return spec.commands.map((c) => c.name);
}
