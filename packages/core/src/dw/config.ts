/**
 * 数仓连接配置：多环境寻址 + 凭据分离 + 隧道声明。
 *
 * 设计参照 Apache Doris 官方 CLI（`@apache-doris/doriscli`）的做法并补上它没有的能力：
 *   - **配置与凭据分文件**：config 可共享（0644），credentials 只放密码（0600）；
 *   - **按环境名寻址** + `default_env`，命令行 `--env` 切换；
 *   - **优先级：命令行 > 环境变量 > 配置文件**（环境变量前缀 `DW`）；
 *   - **SSH 隧道**：官方 CLI 只到 SOCKS5（BYOC），跳板机要自己搭；这里把跳板机转发写进配置。
 *   - **只读闸门只有一个判断点**（`readonlyFromEnv`）：`DW_PROFILE=prod` 且未设
 *     `DW_ALLOW_PROD_WRITE=1` 即只读，**对所有来源的环境生效**。安全开关不能有第二处判断。
 *
 * 开源副本不内置任何主机、库名、账号或凭据；未配置时一律报错并给出配置指引，
 * **绝不回落到某个"默认地址"**——误连到非预期集群比报错更贵。
 *
 * 文件布局（根目录可用 DW_HOME 覆盖）：
 *   ~/.dw/warehouse.json              非敏感连接信息
 *   ~/.dw/warehouse-credentials.json  密码（0600）
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RcError } from '../errors.ts';

/** 一条本地端口转发：把本机 local 端口转到（跳板机视角可达的）remote。 */
export interface TunnelForward {
  local: number;
  remoteHost: string;
  remotePort: number;
}

/**
 * SSH 隧道声明。字段全部来自配置，代码里不出现任何具体主机。
 * 认证二选一：identityFile（私钥）或 passwordFile（配合 `sshpass -f` 读取，密码不进 argv）。
 */
export interface TunnelSpec {
  enabled: boolean;
  /** 跳板机：host 或 ~/.ssh/config 里的别名 */
  jumpHost: string;
  jumpPort?: number;
  jumpUser?: string;
  identityFile?: string;
  /** 存密码的文件路径（0600）；配置里不写密码本身 */
  passwordFile?: string;
  /**
   * 显式转发列表。省略时按环境的 host/端口自动生成两条
   * （本地端口 = 远端端口 + 10000，既避开常见占用又与原端口一眼对应）。
   */
  forwards?: TunnelForward[];
  /** 额外的 ssh 参数（如 -o ProxyCommand=...） */
  extraArgs?: string[];
}

export interface WarehouseEnv {
  name: string;
  /** FE 主机（内网地址，只出现在本地配置里） */
  host: string;
  /** MySQL 协议端口 */
  mysqlPort?: number;
  /** FE HTTP 端口 */
  httpPort?: number;
  user?: string;
  /** 三段式命名里的 catalog，默认 internal */
  catalog?: string;
  /** 默认库；留空则 SQL 必须写全限定名（落到 information_schema 上下文） */
  database?: string;
  /** 传输方式：http = FE REST（零依赖）；cmd = 交给外部命令 */
  transport?: 'http' | 'cmd';
  /** transport=cmd 时的命令模板，占位符 {sql} / {env} */
  cmd?: string;
  tunnel?: TunnelSpec;
  network?: 'public' | 'intranet';
  /** 只读环境标记：为真时任何写操作被拒（对应 iPaaS 侧的 RC_PROFILE=prod） */
  readonly?: boolean;
}

export interface WarehouseConfigFile {
  default_env?: string;
  environments?: Record<string, Omit<WarehouseEnv, 'name'>>;
}

export interface WarehouseCredentialsFile {
  [env: string]: { password?: string } | undefined;
}

/** 解析后的环境：默认值已补齐，凭据已注入（调用方**不得回显 password**）。 */
export interface ResolvedWarehouseEnv extends Omit<WarehouseEnv, 'tunnel'> {
  mysqlPort: number;
  httpPort: number;
  catalog: string;
  transport: 'http' | 'cmd';
  password?: string;
  tunnel?: TunnelSpec & { forwards: TunnelForward[] };
  /** 非致命提示（如凭据文件权限过宽），调用方应转达给用户 */
  warnings?: string[];
}

export const DEFAULT_MYSQL_PORT = 9030;
export const DEFAULT_HTTP_PORT = 8030;

export function warehouseHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DW_HOME ?? join(homedir(), '.dw');
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DW_CONFIG ?? join(warehouseHome(env), 'warehouse.json');
}

export function credentialsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DW_CREDENTIALS ?? join(warehouseHome(env), 'warehouse-credentials.json');
}

function readJsonFile(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RcError('E_VALIDATION', `配置文件不是合法 JSON：${file}（${(e as Error).message}）`);
  }
}

function toEnvMap(list: unknown[]): Record<string, Omit<WarehouseEnv, 'name'>> {
  const out: Record<string, Omit<WarehouseEnv, 'name'>> = {};
  for (const item of list) {
    const e = item as WarehouseEnv;
    if (!e || typeof e !== 'object' || !e.name) continue;
    const { name, ...rest } = e;
    out[name] = rest;
  }
  return out;
}

/** DW_TARGETS（JSON）：数组或 { environments }，形状错误给明确错误而不是让调用方在 .find 上炸。 */
function envFromTargetsVar(raw: string | undefined): WarehouseConfigFile | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RcError('E_VALIDATION', 'DW_TARGETS 不是合法 JSON');
  }
  if (Array.isArray(parsed)) return { environments: toEnvMap(parsed) };
  const obj = parsed as WarehouseConfigFile;
  if (!obj || typeof obj !== 'object' || !obj.environments) {
    throw new RcError('E_VALIDATION', 'DW_TARGETS 需要是数组或 { environments: {...} }');
  }
  return obj;
}

export interface LoadConfigOptions {
  file?: string;
  credentialsFile?: string;
  env?: NodeJS.ProcessEnv;
}

/** 读配置（不含凭据）。优先级：DW_TARGETS > 显式 file > 默认配置文件。 */
export function loadWarehouseConfig(opts: LoadConfigOptions = {}): WarehouseConfigFile {
  const env = opts.env ?? process.env;
  const fromVar = envFromTargetsVar(env.DW_TARGETS);
  if (fromVar) return fromVar;
  const file = opts.file ?? configFilePath(env);
  const parsed = readJsonFile(file);
  if (parsed === undefined) return {};
  const obj = parsed as WarehouseConfigFile;
  // 数组也算 typeof 'object'，但它不是 environments——不挡下来会静默产出空环境
  if (obj.environments !== undefined && (typeof obj.environments !== 'object' || Array.isArray(obj.environments))) {
    throw new RcError('E_VALIDATION', `${file} 的 environments 需要是对象（不是数组）`);
  }
  return obj;
}

/** 读凭据文件（0600）。权限过宽只警告不阻断——本机常见 0644，交给人处理。 */
export function loadWarehouseCredentials(
  opts: LoadConfigOptions = {},
): { data: WarehouseCredentialsFile; warning?: string } {
  const env = opts.env ?? process.env;
  const file = opts.credentialsFile ?? credentialsFilePath(env);
  if (!existsSync(file)) return { data: {} };
  let warning: string | undefined;
  try {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) warning = `凭据文件权限过宽（${mode.toString(8)}）：建议 chmod 600 ${file}`;
  } catch {
    /* 拿不到权限就不提醒 */
  }
  const parsed = readJsonFile(file);
  return { data: (parsed as WarehouseCredentialsFile) ?? {}, warning };
}

/** 环境变量里的单环境定义（DW_HOST/DW_PORT/...）；未设置 DW_HOST 时返回 undefined。 */
function envFromVars(env: NodeJS.ProcessEnv): Omit<WarehouseEnv, 'name'> | undefined {
  if (!env.DW_HOST) return undefined;
  return {
    host: env.DW_HOST,
    mysqlPort: env.DW_PORT ? Number(env.DW_PORT) : undefined,
    httpPort: env.DW_HTTP_PORT ? Number(env.DW_HTTP_PORT) : undefined,
    user: env.DW_USER,
    catalog: env.DW_CATALOG,
    database: env.DW_DB,
    transport: env.DW_TRANSPORT as WarehouseEnv['transport'],
    cmd: env.DW_CMD,
    network: env.DW_NETWORK as WarehouseEnv['network'],
  };
}

/**
 * 只读闸门：`DW_PROFILE=prod` 且未显式放行时为真。
 *
 * **必须对所有来源的环境生效**，不能只作用于环境变量那条路——
 * 否则"配置文件 + DW_PROFILE=prod"会静默允许写入，而文档承诺的是只读。
 * 这是安全开关，不能有第二个判断点。
 */
export function readonlyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  if (env.DW_PROFILE === undefined) return undefined;
  return env.DW_PROFILE === 'prod' && env.DW_ALLOW_PROD_WRITE !== '1';
}

/** 把隧道的转发列表补全：省略 forwards 时按 host/mysqlPort/httpPort 生成两条。 */
export function expandForwards(
  spec: TunnelSpec,
  target: { host: string; mysqlPort: number; httpPort: number },
): TunnelForward[] {
  if (spec.forwards?.length) return spec.forwards;
  return [
    { local: target.mysqlPort + 10000, remoteHost: target.host, remotePort: target.mysqlPort },
    { local: target.httpPort + 10000, remoteHost: target.host, remotePort: target.httpPort },
  ];
}

export interface ResolveWarehouseOptions extends LoadConfigOptions {
  /** 环境名；省略则取 DW_ENV > default_env > 唯一环境 */
  name?: string;
  /** 命令行显式指定的只读覆盖（--readonly） */
  readonly?: boolean;
}

/** 解析出一个可用环境（含凭据）。找不到时抛 E_VALIDATION 并给出配置指引。 */
export function resolveWarehouseEnv(opts: ResolveWarehouseOptions = {}): ResolvedWarehouseEnv {
  const env = opts.env ?? process.env;
  const config = loadWarehouseConfig(opts);
  const envs = { ...(config.environments ?? {}) };
  const inline = envFromVars(env);

  let chosenName: string;
  let chosen: Omit<WarehouseEnv, 'name'>;

  if (inline) {
    // 环境变量直给时**不继承配置文件的 default_env**：那是文件里的名字，
    // 拿来标注一个完全由环境变量定义的环境只会让人误解"我到底连的是哪个"。
    chosenName = opts.name ?? env.DW_ENV ?? 'env';
    chosen = inline;
  } else {
    const name = opts.name ?? env.DW_ENV ?? config.default_env;
    if (name) {
      if (!envs[name]) {
        throw new RcError(
          'E_VALIDATION',
          `未知数仓环境：${name}（可选：${Object.keys(envs).join(', ') || '未配置'}）。` +
            `用 'dw env list' 查看，或设置 DW_HOST 直接指定。`,
        );
      }
      chosenName = name;
      chosen = envs[name];
    } else {
      const names = Object.keys(envs);
      if (names.length === 1) {
        chosenName = names[0];
        chosen = envs[names[0]];
      } else if (names.length === 0) {
        throw new RcError(
          'E_VALIDATION',
          `没有可用的数仓环境。任选其一：设置 DW_HOST/DW_USER/DW_PASS；` +
            `或写 ${configFilePath(env)}（格式见 docs/DW-COMMAND-REFERENCE.md）。`,
        );
      } else {
        throw new RcError(
          'E_VALIDATION',
          `配置了多个数仓环境（${names.join(', ')}）但没有默认值：请用 --env 指定，或在配置里设 default_env。`,
        );
      }
    }
  }

  const { data: creds, warning } = loadWarehouseCredentials(opts);
  const password = env.DW_PASS ?? creds[chosenName]?.password;

  // 逐字段构造：tunnel 的类型在下面按需收窄，不能靠展开 chosen 蒙混过去。
  const resolved: ResolvedWarehouseEnv = {
    name: chosenName,
    host: chosen.host,
    mysqlPort: chosen.mysqlPort ?? DEFAULT_MYSQL_PORT,
    httpPort: chosen.httpPort ?? DEFAULT_HTTP_PORT,
    user: chosen.user,
    catalog: chosen.catalog ?? 'internal',
    database: chosen.database,
    transport: chosen.transport ?? (chosen.cmd ? 'cmd' : 'http'),
    cmd: chosen.cmd,
    network: chosen.network,
    // 只读闸门只有一个判断点：命令行 > DW_PROFILE > 环境自身标记
    readonly: opts.readonly ?? readonlyFromEnv(env) ?? chosen.readonly,
    password,
  };

  if (warning) resolved.warnings = [warning];

  // DW_TUNNEL 是全局覆盖：不管环境来自变量还是文件，都按它走隧道。
  const tunnelSpec = env.DW_TUNNEL ? parseTunnelVar(env.DW_TUNNEL) : chosen.tunnel;
  if (tunnelSpec?.enabled) {
    if (!tunnelSpec.jumpHost) {
      throw new RcError('E_VALIDATION', `环境 ${resolved.name} 的隧道缺少 jumpHost`);
    }
    resolved.tunnel = {
      ...tunnelSpec,
      forwards: expandForwards(tunnelSpec, {
        host: resolved.host,
        mysqlPort: resolved.mysqlPort,
        httpPort: resolved.httpPort,
      }),
    };
  }
  return resolved;
}

function parseTunnelVar(raw: string): TunnelSpec {
  try {
    return JSON.parse(raw) as TunnelSpec;
  } catch {
    throw new RcError('E_VALIDATION', 'DW_TUNNEL 不是合法 JSON');
  }
}

/** 主机打码：保留可辨识的前后缀，中间抹掉（内网 IP / 域名都不至于完整外泄）。 */
export function maskHost(host: string | undefined): string {
  if (!host) return '';
  const h = String(host);
  if (h.length <= 3) return '***';
  const keep = h.length > 10 ? 3 : 1;
  return `${h.slice(0, keep)}***${h.slice(-keep)}`;
}

/** 面向输出的描述：**永不包含密码**；host 默认打码（避免写进报告/日志/提交信息）。 */
export function describeWarehouseEnv(
  e: ResolvedWarehouseEnv,
  opts: { revealHost?: boolean } = {},
): Record<string, unknown> {
  const host = opts.revealHost ? e.host : maskHost(e.host);
  return {
    name: e.name,
    host,
    mysqlPort: e.mysqlPort,
    httpPort: e.httpPort,
    user: e.user,
    catalog: e.catalog,
    database: e.database,
    transport: e.transport,
    network: e.network,
    readonly: Boolean(e.readonly),
    hasPassword: Boolean(e.password),
    tunnel: e.tunnel
      ? { enabled: true, jumpHost: maskHost(e.tunnel.jumpHost), forwards: e.tunnel.forwards }
      : undefined,
    warnings: e.warnings,
  };
}
