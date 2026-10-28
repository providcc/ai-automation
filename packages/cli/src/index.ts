#!/usr/bin/env node
/**
 * L1 执行层：rc CLI（完整命令集）
 * 契约：docs/COMMAND-REFERENCE.md
 * 零外部依赖（node:util parseArgs），可直接以 --experimental-strip-types 运行
 */
import { parseArgs } from 'node:util';
import { findCommand, renderCommandHelp, renderTopHelp, renderGroupHelp, findGroupCommands } from '../../core/src/cli-help.ts';
import { RC_HELP } from './help.ts';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RestCloudClient, type ApiResult } from '../../core/src/client.ts';
import { RcError } from '../../core/src/errors.ts';
import { Catalog } from '../../core/src/catalog.ts';
import { resolveTarget } from '../../core/src/targets.ts';
import { resolveCredentials, writeKeychainSecret } from '../../core/src/credentials.ts';
import { loginByPassword, loginByToken, refresh, saveSession, loadSession, sessionFile, loadSessionSync, saveSessionSync } from '../../core/src/auth.ts';
import * as API from '../../core/src/api.ts';
import * as ETL from '../../core/src/etl.ts';
import * as DS from '../../core/src/datasource.ts';
import * as MON from '../../core/src/monitor.ts';
import * as OPS from '../../core/src/operations.ts';
import { snapshot, restore } from '../../core/src/snapshot.ts';
import { uploadFile } from '../../core/src/upload.ts';
import { buildProcessModel, type BuildInput } from '../../core/src/flow-build.ts';
import * as FLOW from '../../core/src/flow-lifecycle.ts';
import { validateFlow, hasBlockingError, type Issue } from '../../core/src/flow-validate.ts';
import { formatFlowDiff } from '../../core/src/flow-diff.ts';
import * as AUDITQ from '../../core/src/audit-query.ts';
import * as PREVIEW from '../../core/src/flow-preview.ts';
import * as JAVAC from '../../core/src/java-compile.ts';
import * as PUBAPI from '../../core/src/flow-publish.ts';
import * as APIPARAMS from '../../core/src/api-params.ts';
import * as SQLQ from '../../core/src/sql-check.ts';
import * as LOCAL from '../../core/src/local-state.ts';
import { computeCatalogFingerprint, writeFingerprint, readFingerprint, diffFingerprints, defaultFingerprintFile } from '../../core/src/fingerprint.ts';
import { doctor, formatDoctor } from '../../core/src/doctor.ts';
import { explainError, formatExplain, listErrorActions, listErrorMap } from '../../core/src/error-catalog.ts';
import * as CONN from '../../core/src/connector.ts';
import * as LIN from '../../core/src/lineage.ts';
import { reviewFlow, reviewApiBundle, formatReview } from '../../core/src/review.ts';
import { flowFromNl, formatNlFlow } from '../../core/src/nl-flow.ts';
import { planCompensation, executeCompensation, formatCompensationPlan } from '../../core/src/etl-compensate.ts';

const OPTIONS = {
  target: { type: 'string' },
  profile: { type: 'string' },
  json: { type: 'boolean', default: false },
  apply: { type: 'boolean', default: false },
  token: { type: 'string' },
  user: { type: 'string' },
  pass: { type: 'string' },
  save: { type: 'string' },
  load: { type: 'string' },
  module: { type: 'string' },
  file: { type: 'string' },
  out: { type: 'string' },
  o: { type: 'string' },
  app: { type: 'string' },
  'process-id': { type: 'string' },
  'allow-mock': { type: 'boolean', default: false },
  compile: { type: 'boolean', default: false },
  keyword: { type: 'string' },
  enrich: { type: 'string' },
  category: { type: 'string' },
  page: { type: 'string' },
  size: { type: 'string' },
  application: { type: 'string' },
  name: { type: 'string' },
  'config-id': { type: 'string' },
  'node-id': { type: 'string' },
  props: { type: 'string' },
  source: { type: 'string' },
  'auth-type': { type: 'string' },
  mode: { type: 'string', default: 'test' },
  limit: { type: 'string' },
  hours: { type: 'string', default: '24' },
  id: { type: 'string' },
  'service-id': { type: 'string' },
  // 不给默认值：不传 --kind 时保持 undefined，让各命令自己决定
  // （flow from-nl 靠它做"表/库 + 同步动词 → etl"的自动判定；其它命令都显式兜底 esb）
  kind: { type: 'string' },
  role: { type: 'string' },
  service: { type: 'string' },
  permission: { type: 'string' },
  'permission-id': { type: 'string' },
  dir: { type: 'string' },
  field: { type: 'string', default: 'file' },
  from: { type: 'string' },
  to: { type: 'string' },
  breaking: { type: 'boolean', default: false },
  X: { type: 'string', default: 'GET' },
  d: { type: 'string' },
  connect: { type: 'boolean', default: false },
  datasources: { type: 'boolean', default: false },
  write: { type: 'boolean', default: false },
  state: { type: 'string' },
  transaction: { type: 'string', multiple: true },
  deep: { type: 'boolean', default: false },
  show: { type: 'boolean', default: false },
  backend: { type: 'string' },
  value: { type: 'string' },
  'redact-host': { type: 'boolean', default: false },
  production: { type: 'boolean', default: false },
  'config-type': { type: 'string' },
  direction: { type: 'string' },
  method: { type: 'string' },
  text: { type: 'string' },
  action: { type: 'string' },
  concurrency: { type: 'string' },
  retry: { type: 'string' },
  resume: { type: 'boolean', default: false },
  'progress-file': { type: 'string' },
  'use-llm': { type: 'boolean', default: true },
  'no-llm': { type: 'boolean', default: false },
  'props-out': { type: 'string' },
  'version-id': { type: 'string' },
  'allow-missing-required': { type: 'boolean', default: false },
  only: { type: 'string' },
  'node-type': { type: 'string' },
  'check-registry': { type: 'boolean', default: false },
  'max-rows': { type: 'string' },
  'table-columns': { type: 'string' },
  params: { type: 'string' },
  'process-ids': { type: 'string' },
  'time-number': { type: 'string' },
  cron: { type: 'string' },
  'app-id': { type: 'string' },
  form: { type: 'string' },
  'content-type': { type: 'string' },
  'snapshot-days': { type: 'string' },
  'audit-days': { type: 'string' },
  'trim-audit-lines': { type: 'string' },
  'node-days': { type: 'string' },
  'max-flows': { type: 'string' },
  conn: { type: 'string' },
  query: { type: 'string' },
  fields: { type: 'string' },
  'expect-fingerprint': { type: 'string' },
  lines: { type: 'string' },
  writes: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  plan: { type: 'boolean', default: false },
  since: { type: 'string' },
  // ── 下面这些曾经**只被代码读、没在 OPTIONS 里声明** ──
  // `parseArgs` 是 strict 的，未声明的 flag 会让命令直接以 Node 原始报错 + 退出码 2 硬失败。
  // 后果不是"少个可选参数"，而是整条链路不可达：
  //   --url  → `rc flow publish --url …` 永远进不去（flow-publish 那 90 行是死代码）
  //   --all  → `rc flow search --all` 不可用
  //   --path → `rc audit list --path …` 不可用
  // 冒烟测试现在会逐条核对 HELP 里的命令能跑通，这类缺口会被拦住。
  url: { type: 'string' },
  all: { type: 'boolean', default: false },
  path: { type: 'string' },
  type: { type: 'string' },
  sql: { type: 'string' },
  'db-conn-id': { type: 'string' },
  'transaction-id': { type: 'string' },
  until: { type: 'string' },
  actor: { type: 'string' },
  filter: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const;

/**
 * 数值参数的合法范围（在 main 里统一校验，见那里的注释）。
 *
 * 原来这些值直接 `Number(v.limit)` 就送给了平台：`--limit abc` → `NaN`，
 * 请求带着 `pageSize=NaN` 发出去，平台回的东西和"参数错了"完全看不出关系。
 */
const NUM_RANGES: Record<string, { min: number; max?: number }> = {
  limit: { min: 1, max: 100_000 },
  page: { min: 1, max: 100_000 },
  size: { min: 1, max: 1000 },
  hours: { min: 1, max: 8760 },
  lines: { min: 1, max: 100_000 },
  'max-rows': { min: 1, max: 100_000 },
  'snapshot-days': { min: 0, max: 36_500 },
  'audit-days': { min: 0, max: 36_500 },
  'node-days': { min: 0, max: 36_500 },
  'trim-audit-lines': { min: 1, max: 10_000_000 },
  'max-flows': { min: 1, max: 100_000 },
  enrich: { min: 0, max: 100 },
  concurrency: { min: 1, max: 1000 },
  retry: { min: 0, max: 100 },
  'time-number': { min: 0, max: 1000 },
};

/**
 * 校验一个数值参数（缺省不校验）。
 * `name` 用命令行写法（如 `--limit`），报错里直接给可改的东西。
 */
function checkNum(raw: unknown, name: string, range: { min: number; max?: number }): void {
  const text = raw === undefined || raw === null || raw === '' ? undefined : String(raw);
  if (text === undefined) return;
  const n = Number(text);
  const bound = range.max === undefined ? `≥ ${range.min}` : `${range.min} ~ ${range.max}`;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < range.min || (range.max !== undefined && n > range.max)) {
    throw new RcError('E_VALIDATION', `${name} 需要 ${bound} 的整数，收到 ${text}`, {
      hint: 'rc <命令> --help 可看该命令支持的参数与取值范围',
    });
  }
}

const VERSION = '0.5.0';

/** 语义 diff 的文本渲染（CLI 用）。 */
const FLOW_FORMAT_DIFF = formatFlowDiff;

/**
 * 本地校验"数据源 id"参数：把 configId 当 id 传过去，平台只会回一个不透明的 500。
 * 这里先查一次列表，把 configId 翻译成真正的 id，给出可行动的错误。
 */
async function assertDatasourceId(c: RestCloudClient, value: string): Promise<void> {
  const v = String(value ?? '').trim();
  if (!v) throw new RcError('E_VALIDATION', '需要数据源 id');
  if (/^[0-9a-f]{24}$/i.test(v)) return;   // 平台 id（Mongo ObjectId）→ 直接用
  try {
    const list = await DS.listDataSources(c, { pageNo: 1, pageSize: 200 });
    const rows = API.unwrapRows(list.data?.data ?? list.data);
    const hit = rows.find((x: any) => String(x.configId ?? '') === v || String(x.configName ?? '') === v);
    if (hit) {
      throw new RcError(
        'E_VALIDATION',
        `参数是数据源的 configId（${v}），不是 id；对应的 id 是 ${hit.id}`
        + `（${hit.configName ?? ''}）。数据源命令一律用 id。`,
      );
    }
  } catch (e) {
    if (e instanceof RcError) throw e;   // 我们自己抛的（已翻译）
    // 列表取不到就继续，让平台报错
  }
  throw new RcError('E_VALIDATION', `参数看起来不是数据源 id（${v}）：数据源命令用 id（24 位十六进制），不是 configId；用 rc datasource list 看对照`);
}

/** ETL 列表的可信度提示：ETL 模块是否开通由平台决定，列表不保证完整。 */
const ETL_LIST_NOTE = 'ETL 模块是否开通由平台决定，列表不保证完整，不要作为排查依据；ETL 写操作默认封禁（RC_ENABLE_ETL_WRITE）。';

/** 凭据解析结果缓存：避免每次调用都访问系统钥匙串。 */
let credsCache: ReturnType<typeof resolveCredentials> | undefined;
function credentials(): ReturnType<typeof resolveCredentials> {
  credsCache ??= resolveCredentials();
  return credsCache;
}

function makeClient(v: Record<string, any>): RestCloudClient {
  // target 的取值顺序：命令行 --target > 环境变量 RC_TARGET > 配置文件里的 default。
  // 之前只有 `doctor` 读 RC_TARGET，其他命令只看 --target —— 同一套配置在两条命令上
  // 表现不一致（`RC_TARGET=prod rc flow list` 会连到 default 的 test 环境），
  // 而这类"以为连了 A 其实连了 B"的错最难查。
  const target = resolveTarget(v.target ?? process.env.RC_TARGET);
  const creds = credentials();
  for (const w of creds.warnings) console.error(`⚠ 凭据：${w}`);
  const c = new RestCloudClient({
    baseUrl: process.env.RC_BASE_URL ?? target.baseUrl,
    profile: (v.profile ?? process.env.RC_PROFILE ?? 'uat') as 'dev' | 'uat' | 'prod',
  });
  // 会话自动恢复（按 target 分域）
  loadSessionSync(c, sessionFile(target.name));
  // 401 自动重授权（命令行 > 环境变量 > 系统钥匙串）
  const user = v.user ?? creds.user;
  const pass = v.pass ?? creds.pass;
  if (user && pass) {
    c.setReauthorizer(async () => {
      await loginByPassword(c, user, pass);
      saveSessionSync(c, sessionFile(target.name));
    });
  }
  return c;
}

function emit(r: ApiResult, json: boolean): number {
  // dry-run 只认**显式标记**，不认 `httpStatus === 0`——网络层失败也没有状态码，
  // 两者混同会把"请求根本没发出去"打印成 `[dry-run]` 并以 0 退出（假成功）。
  const dryRun = r.dryRun === true;
  if (json) {
    console.log(JSON.stringify({
      ok: r.ok, status: r.httpStatus, errcode: r.errcode, msg: r.msg, traceId: r.traceId,
      dryRun, data: r.data?.data ?? r.data, request: r.request,
      ...((r as any).snapshotFile ? { snapshotFile: (r as any).snapshotFile } : {}),
    }, null, 2));
  } else if (dryRun) {
    console.log(`[dry-run] ${r.request.method} ${r.request.url}`);
    if (r.request.body) console.log(JSON.stringify(r.request.body, null, 2).slice(0, 4000));
  } else if (r.ok) {
    console.log(`✔ ${r.request.method} ${r.request.url} (${r.httpStatus}, ${r.traceId ?? '-'})`);
    // 大对象（flow get 的 processModel、api get 的参数）截断后仍是"半截 JSON"，
    // 直接重定向到文件会得到无法解析的内容 —— 截断时必须明确提示，别让人以为是完整输出。
    const text = JSON.stringify(r.data?.data ?? r.data, null, 2);
    console.log(text.length > 6000 ? `${text.slice(0, 6000)}\n…（输出已截断，完整内容用 --json）` : text);
  } else {
    // httpStatus = -1 是网络层失败；此时 msg 已自带"网络请求失败"措辞，不要重复加前缀
    const where = r.httpStatus > 0 ? `HTTP ${r.httpStatus} ` : '';
    console.error(`✖ ${where}${r.msg ?? ''} traceId=${r.traceId ?? '-'}`);
  }
  if (dryRun) return 0;
  if (r.httpStatus === 401 || r.httpStatus === 403) return 3;
  // <=0 = 网络层失败（连不上 / 超时 / DNS）→ 上游故障，不是参数错误
  if (r.httpStatus >= 500 || r.httpStatus <= 0) return 5;
  return r.ok ? 0 : 4;
}

/**
 * Java 节点保存后提醒：平台不会随保存自动编译，且多实例下编译类可能不一致。
 * 不提示的话，很容易出现"代码改了、库里也对，但运行还是旧逻辑"的假象。
 */
function warnJavaNodesNeedCompile(nodeProps: Array<{ nodeId: string; nodeType?: string; props?: Record<string, unknown> }>): void {
  const ids = FLOW.javaCodeNodeIds(nodeProps ?? []);
  if (!ids.length) return;
  console.error(`⚠ Java 节点代码已保存：${ids.join(', ')}`);
  console.error('  平台不会随保存自动编译——需在节点编辑器点『编译』；多实例部署还要确认所有实例都已刷新，');
  console.error('  否则同一流程连续运行可能交替命中旧类（实测）。验证：连跑 3 次，行为/返回应一致。');
}

const readJson = async (f: string) => JSON.parse(await readFile(f, 'utf8'));

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * 是否是 dry-run（请求没有真的发出去）。
 * 只认**显式标记** `dryRun`（客户端 dry-run 时置 true）。
 * 不能退回 `httpStatus === 0`：网络层失败也没有状态码，那样会把失败当 dry-run。
 * 保留 msg 兜底是为了兼容测试里手搓的结果对象。
 */
const isDryRun = (r: { dryRun?: boolean; msg?: string } | undefined): boolean =>
  r?.dryRun === true || String(r?.msg ?? '').startsWith('dry-run');

/** 统一的 dry-run 提示：明确"未写入"，并给出将要发生的请求。 */
const dryRunNotice = (r: any, what: string): string => {
  const method = r?.request?.method;
  const url = r?.request?.url;
  const where = method && url ? `：${method} ${url}` : '';
  return `【dry-run】未写入${what ? `（${what}）` : ''}${where}`;
};

const flowKind = (raw: any, explicit?: string): FLOW.FlowKind =>
  (explicit === 'etl' || raw?.kind === 'etl' ? 'etl' : 'esb');

/** 读取流程现有节点属性（供校验使用）；统一走批量端点/ETL 降级 */
async function loadProps(
  c: RestCloudClient,
  processId: string | undefined,
  propsFile: string | undefined,
  kind: FLOW.FlowKind = 'esb',
) {
  const out: Record<string, Record<string, unknown>> = {};
  if (propsFile) {
    const nodes = FLOW.normalizeNodeProps(await readJson(propsFile)) ?? [];
    for (const n of nodes) out[n.nodeId] = { pNodeId: n.nodeId, pNodeType: n.nodeType, ...(n.props ?? {}) };
    return out;
  }
  if (processId) {
    const nodes = await FLOW.listFlowNodes(c, processId, undefined, { kind });
    const routers = kind === 'esb' ? await FLOW.listFlowNodes(c, processId, 'router', { kind }) : [];
    const records = await FLOW.getNodePropsBatch(c, processId, [...nodes, ...routers].map((x) => x.nodeId), { kind });
    for (const p of records) {
      const id = String(p.pNodeId ?? '');
      if (id) out[id] = p;
    }
  }
  return out;
}

/** 解析流程文件：支持纯图、{model,props} 组合文件、{nodes,edges} 规格。 */
async function readFlowFile(file: string, kind: FLOW.FlowKind) {
  const raw = await readJson(file) as any;
  // 文件内的 kind 优先（组合文件自带类型），命令行 --kind 作为兜底。
  const effectiveKind = flowKind(raw, kind);
  const isSpec = !raw?.model && !raw?.nodeDataArray;
  const built = isSpec ? buildProcessModel({ ...(raw as BuildInput), kind: effectiveKind }) : undefined;
  const model = raw?.model ?? (raw?.nodeDataArray ? raw : built!.model);
  const props = FLOW.normalizeNodeProps(raw?.props ?? built?.props);
  return { raw, model, props, kind: effectiveKind, skeleton: raw?.skeleton === true };
}

/**
 * 必填属性缺失的严重级别。
 * 骨架模板（文件里标了 skeleton:true）只提示；其余默认阻断保存。
 */
const requiredLevel = (skeleton: boolean, allowMissing?: boolean): 'error' | 'warn' =>
  (skeleton || allowMissing) ? 'warn' : 'error';

/**
 * "沿用平台现状"降级：平台本来就没有这个必填项、本次也没补上时，
 * 不因为本地规则把保存/校验拦死（导出 → 再保存是常见动作）。
 */
async function relaxInheritedRequired(
  c: RestCloudClient,
  kind: FLOW.FlowKind,
  processId: string | undefined,
  model: unknown,
  nodeProps: Record<string, Record<string, unknown>> | undefined,
  issues: Issue[],
): Promise<Issue[]> {
  const blocking = issues.some((i) => i.code === 'REQUIRED_FIELD' && i.level === 'error');
  if (!processId || !blocking) return issues;
  let already: Set<string>;
  try {
    already = await FLOW.platformMissingRequired(c, kind, processId, model, nodeProps);
  } catch {
    return issues;
  }
  if (!already.size) return issues;
  return issues.map((i) => {
    if (i.code !== 'REQUIRED_FIELD' || i.level !== 'error' || !i.nodeId || !i.field) return i;
    if (!already.has(`${i.nodeId}|${i.field}`)) return i;
    return { ...i, level: 'warn' as const, msg: `${i.msg}（平台现状已如此，按沿用现状处理）` };
  });
}

/** ETL 组件目录是可选文件：ESB-only 部署没装它时给出明确提示，而不是报一堆"未知节点类型"。 */
function requireEtlCatalog(cat: Catalog, kind: FLOW.FlowKind): void {
  if (kind === 'etl' && !cat.hasEtlCatalog()) {
    throw new RcError(
      'E_VALIDATION',
      '未安装 ETL 组件目录（catalog/etl-components.json，可选文件）：当前部署仅支持 ESB 编排，请改用 --kind esb',
    );
  }
}

const CATALOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'catalog');
const catalogFile = (name: string) => join(CATALOG_DIR, name);

/** 读目录下的 JSON 文件（不存在返回空） */
async function readDirJson<T = any>(dir: string): Promise<{ file: string; data: T }[]> {
  const out: { file: string; data: T }[] = [];
  try {
    for (const name of (await readdir(dir)).sort()) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      out.push({ file: join(dir, name), data: JSON.parse(await readFile(join(dir, name), 'utf8')) as T });
    }
  } catch {
    /* 目录不存在 */
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  let values: Record<string, any>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS as any }) as any);
  } catch (e: any) {
    // parseArgs 是 strict 的：未声明的 flag / 缺参数都会抛。**不要把它抛给用户**——
    // Node 的原文（`Unknown option '--url'. To specify a positional argument…`）既不是我们的口径，
    // 退出码也落在"未捕获异常"的 2 上。统一成参数错误（4）并指路 --help。
    // 只取 Node 原文的第一句（后面那句 "To specify a positional argument…" 是通用噪音）
    const why = String(e?.message ?? e).split(/\s*\.\s+To specify/)[0].trim();
    throw new RcError('E_VALIDATION', `参数解析失败：${why}`, {
      // 消息里已指路 --help，不要再追加流程图规格那类默认提示
      hint: `运行 rc --help 看全部命令，或 rc <命令> --help 看该命令的用法`,
    });
  }
  const v = values;
  // 数值参数**在任何命令之前**统一校验（顺序反了的话，缺配置之类的报错会盖住真正的问题）
  for (const [name, range] of Object.entries(NUM_RANGES)) checkNum(v[name], `--${name}`, range);
  if (v.version) { console.log(VERSION); return 0; }
  // `--help` 分三级：`rc flow save --help` 给该命令的用法/选项/坑；
  // `rc flow --help` 给该前缀下的子命令清单；
  // 只写 `rc --help`（或什么都不写）才给顶层清单。
  if (v.help) {
    const c = findCommand(RC_HELP, positionals);
    if (c) { console.log(renderCommandHelp(RC_HELP, c)); return 0; }
    // 组级：前缀本身不是命令，但有子命令
    const group = findGroupCommands(RC_HELP, positionals);
    if (group.length) { console.log(renderGroupHelp(RC_HELP, positionals)); return 0; }
    // 什么都不匹配 → **不短路**，继续走 dispatch，让 default 分支报"未知命令"。
    // 之前这里直接返回顶层清单 + 退出码 0，导致 `rc 乱写的命令 --help` 静默成功。
  }
  if (positionals.length === 0) { console.log(renderTopHelp(RC_HELP)); return 0; }

  const [group, verb, ...tail] = positionals;
  const json = Boolean(v.json);
  const c = makeClient(v);
  // 单动词命令（call/snapshot/restore/upload）的第一个位置参数是业务参数，不参与命令名
  const SINGLE_VERBS = new Set(['call', 'snapshot', 'restore', 'upload', 'doctor']);
  // `call` 带子动作时要先拆出来：否则 `rc call form <path>` 会被当成 `call` + action='form'，
  // 而 case 'call' 把 action 当路径校验 → 报"路径必须以 / 开头"，`case 'call form'` 永远进不去。
  const CALL_SUBACTIONS = new Set(['form']);
  const THREE_WORD = new Set([
    'flow props get', 'flow props save', 'flow props list',
    'flow schedule list', 'flow schedule save', 'flow schedule delete',
    'api inparams list', 'api inparams save', 'api inparams from-json',
    'api outparams list', 'api outparams save', 'api outparams from-json',
  ]);
  let command: string;
  let action: string;
  let rest: string[];
  if (group === 'call' && verb && CALL_SUBACTIONS.has(verb)) {
    command = `call ${verb}`;
    action = tail[0] ?? '';
    rest = tail.slice(1);
  } else if (SINGLE_VERBS.has(group)) {
    command = group;
    action = verb ?? '';
    rest = tail;
  } else {
    const three = `${group} ${verb ?? ''} ${tail[0] ?? ''}`.trim();
    if (THREE_WORD.has(three)) {
      command = three;
      action = tail[1] ?? '';
      rest = tail.slice(1);
    } else {
      command = `${group} ${verb ?? ''}`.trim();
      action = tail[0] ?? '';
      rest = tail;
    }
  }

  switch (command) {
    // ---------- auth ----------
    case 'auth login': {
      const creds = resolveCredentials();
      const token = v.token ?? creds.token;
      const r = token
        ? await loginByToken(c, token)
        : await loginByPassword(c, v.user ?? creds.user ?? '', v.pass ?? creds.pass ?? '');
      const t = resolveTarget(v.target ?? process.env.RC_TARGET);
      saveSessionSync(c, sessionFile(t.name));
      if (v.save) await saveSession(c, v.save);
      const out = { ok: true, userId: r.userId, userName: r.userName, expiresSecond: r.expiresSecond, target: resolveTarget(v.target ?? process.env.RC_TARGET).name };
      if (json) console.log(JSON.stringify(out, null, 2));
      else console.log(`✔ 登录成功：${r.userName ?? r.userId ?? ''}（target=${out.target}，有效期 ${r.expiresSecond ?? '?'}s）`);
      return 0;
    }
    case 'auth keychain-setup': {
      // 往系统钥匙串写两条：'user'（用户名）与 "<用户名>"（密码）
      const user = v.user ?? process.env.RC_USER;
      const pass = v.pass ?? process.env.RC_PASS;
      const service = v.service ?? process.env.RC_KEYCHAIN_SERVICE ?? 'rc-ipaas';
      if (!user) throw new RcError('E_VALIDATION', '需要 --user <账号>（或设置 RC_USER）');
      if (!pass) throw new RcError('E_VALIDATION', '需要 --pass <密码>（或设置 RC_PASS）；本工具不做交互式输入');
      const a = writeKeychainSecret('user', user, { service });
      const b = writeKeychainSecret(user, pass, { service });
      if (!a.ok || !b.ok) {
        console.error(`✖ 写入钥匙串失败：${a.msg ?? b.msg ?? '未知原因'}`);
        return 4;
      }
      console.log(`✔ 已写入钥匙串（service=${service}）：条目 'user' 与 '${user}'`);
      console.log('  之后用 RC_KEYCHAIN=1 即可免密使用');
      return 0;
    }
    case 'auth cookie': {
      // 给脚本用：打印可直接用的 Cookie 头（会话里的 token 是 URL 编码的）
      const t = resolveTarget(v.target ?? process.env.RC_TARGET);
      const file = sessionFile(t.name);
      let raw = '';
      try { raw = readFileSync(file, 'utf8'); } catch { /* 没有会话 */ }
      let token = '';
      try { token = JSON.parse(raw).identitytoken ?? ''; } catch { /* 坏文件 */ }
      if (!token) throw new RcError('E_AUTH', `没有可用会话（${file}）；先 rc auth login`);
      let decoded = token;
      try { decoded = decodeURIComponent(token); } catch { /* 原样返回 */ }
      console.log(`Cookie: identitytoken=${decoded}`);
      return 0;
    }
    case 'auth status': {
      const r = await c.request('/rest/base/users/context', { method: 'GET', dryRun: false });
      return emit(r, json);
    }
    case 'auth refresh':
      await refresh(c);
      console.log('✔ token 已刷新');
      return 0;
    case 'auth save':
      await saveSession(c, action);
      console.log(`✔ 会话已保存到 ${action}（0600）`);
      return 0;
    case 'auth load': {
      const ok = await loadSession(c, action);
      console.log(ok ? `✔ 已加载 ${action}` : `✖ 读取失败：${action}`);
      return ok ? 0 : 4;
    }

    // ---------- 应用 ----------
    case 'apps': {
      const r = await API.listApps(c);
      if (json) return emit(r, json);
      const rows = API.unwrapRows(r.data?.data ?? r.data);
      console.log(`共 ${rows.length} 个应用`);
      rows.forEach((x: any) => console.log(`${String(x.appId ?? x.applicationId ?? '').padEnd(24)} ${x.appName ?? x.name ?? ''}`));
      return r.ok ? 0 : 4;
    }

    // ---------- catalog ----------
    case 'catalog sync': {
      const source = v.source ?? v.file;
      if (!source) throw new RcError('E_VALIDATION', '需要 --source <平台前端源码目录>');
      const script = new URL('../../../scripts/extract-catalog.mjs', import.meta.url).pathname;
      if (!existsSync(script)) {
        console.error('✖ 目录提取脚本未随本版本发布（scripts/extract-catalog.mjs 缺失）。');
        console.error('  当前目录文件（catalog/*.json）是随仓库维护的静态快照；');
        console.error('  需要重建时，请在前端源码环境里按 docs/COMMAND-REFERENCE.md 的"目录"一节生成后再拷回 catalog/。');
        return 4;
      }
      const res = spawnSync(process.execPath, [script, source], { encoding: 'utf8' });
      process.stdout.write(res.stdout ?? '');
      if (res.status !== 0) {
        console.error(res.stderr ?? '目录生成失败');
        return 4;
      }
      return 0;
    }
    case 'catalog search': {
      const rows = new Catalog().searchEndpoints(rest[0] ?? '', { module: v.module });
      if (json) console.log(JSON.stringify(rows, null, 2));
      else {
        rows.slice(0, 60).forEach((e) => console.log(`${e.path.padEnd(64)} ${e.module}.${e.name}`));
        console.log(`\n共 ${rows.length} 条（显示前 ${Math.min(rows.length, 60)}）`);
      }
      return rows.length ? 0 : 4;
    }
    case 'catalog fingerprint': {
      const fp = computeCatalogFingerprint();
      if (v.write || v.apply) {
        const out = v.out ?? defaultFingerprintFile();
        writeFingerprint(out, fp);
        if (!json) console.log(`✔ 目录指纹已写入 ${out}`);
      }
      if (json) console.log(JSON.stringify(fp, null, 2));
      else {
        console.log(`目录指纹：${fp.digest}`);
        for (const f of fp.files) console.log(`  ${f.file.padEnd(34)} ${String(f.count ?? f.bytes).padStart(6)}  ${f.sha256.slice(0, 12)}…`);
      }
      return 0;
    }
    case 'catalog drift': {
      const baseline = readFingerprint(v.file ?? defaultFingerprintFile());
      const current = computeCatalogFingerprint();
      const diff = diffFingerprints(baseline, current);
      if (json) console.log(JSON.stringify({ baseline: baseline.generatedAt, current: current.generatedAt, ...diff }, null, 2));
      else {
        if (!diff.digestChanged) console.log(`✔ 目录未漂移（基线 ${baseline.generatedAt}）`);
        else {
          console.log(`! 目录已漂移（基线 ${baseline.generatedAt}）`);
          if (diff.changed.length) console.log(`  变更：${diff.changed.join(', ')}`);
          if (diff.added.length) console.log(`  新增：${diff.added.join(', ')}`);
          if (diff.removed.length) console.log(`  删除：${diff.removed.join(', ')}`);
          console.log('  复核后运行 rc catalog fingerprint --write 重建基线');
        }
      }
      return diff.digestChanged ? 1 : 0;
    }
    case 'catalog controllers': {
      const doc = JSON.parse(await readFile(catalogFile('controllers.json'), 'utf8'));
      const kw = String(rest[0] ?? '').toLowerCase();
      const rows = (doc.controllers ?? []).filter((x: any) => !kw || String(x.controller).toLowerCase().includes(kw) || String(x.module).toLowerCase().includes(kw));
      if (json) console.log(JSON.stringify(rows, null, 2));
      else {
        console.log(`控制器 ${rows.length} 个（全量 ${doc.stats?.controllers ?? '?'}，端点 ${doc.stats?.endpoints ?? '?'}）`);
        rows.slice(0, 40).forEach((x: any) => console.log(`  ${String(x.count).padStart(3)} ${String(x.module).padEnd(10)} ${x.controller}`));
      }
      return rows.length ? 0 : 4;
    }
    case 'audit list':
    case 'audit tail':
    case 'audit summary': {
      const sub = command === 'audit list' ? 'list' : command === 'audit tail' ? 'tail' : 'summary';
      const dir = v.dir ? String(v.dir) : undefined;
      if (sub === 'tail') {
        const rows = await AUDITQ.tailAudit({ dir, lines: v.lines ? Number(v.lines) : 20 });
        if (json) console.log(JSON.stringify({ ok: true, count: rows.length, rows }, null, 2));
        else {
          if (!rows.length) console.log('审计目录没有记录（RC_AUDIT_DIR / RC_HOME / ~/.rc/audit）');
          rows.forEach((e) => console.log(AUDITQ.formatAuditRow(e)));
        }
        return 0;
      }
      const entries = await AUDITQ.readAuditEntries({
        dir, since: v.since, until: v.until, path: v.path, actor: v.actor,
        writesOnly: Boolean(v.writes), limit: v.limit ? Number(v.limit) : undefined,
      });
      if (sub === 'summary') {
        const sum = AUDITQ.summarizeAudit(entries);
        if (json) console.log(JSON.stringify({ ok: true, ...sum }, null, 2));
        else {
          console.log(`审计记录 ${sum.total} 条（写操作 ${sum.writes}，失败 ${sum.failures}）`);
          for (const [d, n] of Object.entries(sum.byDay)) console.log(`  ${d}  ${n} 条`);
          console.log('按操作者：');
          for (const [a, n] of Object.entries(sum.byActor)) console.log(`  ${a}  ${n} 条`);
          console.log('按接口：');
          for (const [p, n] of Object.entries(sum.byPath).slice(0, 15)) console.log(`  ${p}  ${n} 条`);
        }
        return 0;
      }
      const limit = v.limit ? Number(v.limit) : 50;
      const shown = entries.slice(-Math.max(1, limit));
      if (json) console.log(JSON.stringify({ ok: true, count: entries.length, shown: shown.length, limit, rows: shown }, null, 2));
      else {
        if (!entries.length) console.log('没有匹配的审计记录');
        shown.forEach((e) => console.log(AUDITQ.formatAuditRow(e)));
        if (shown.length < entries.length) {
          console.log(`（共 ${entries.length} 条，显示最后 ${shown.length} 条；--limit ${limit} 可调整）`);
        }
      }
      return 0;
    }
    case 'catalog nodes': {
      const doc = JSON.parse(await readFile(catalogFile('node-driver-map.json'), 'utf8'));
      const kw = String(rest[0] ?? '').toLowerCase();
      const kind = v.kind ? String(v.kind) : undefined;
      const rows = (doc.entries ?? []).filter((x: any) => (!kind || x.kind === kind)
        && (!kw || String(x.nodeType ?? '').toLowerCase().includes(kw) || String(x.beanName ?? '').toLowerCase().includes(kw) || String(x.shortName ?? '').toLowerCase().includes(kw)));
      if (json) console.log(JSON.stringify({ stats: doc.stats, entries: rows, panelOnly: doc.panelOnly }, null, 2));
      else {
        console.log(`驱动 ${doc.stats?.drivers} 个：真实节点 ${doc.stats?.actualDrivers}，已映射 ${doc.stats?.mapped}，面板内 ${doc.stats?.mappedInPanel}；面板节点 ${doc.stats?.panelNodes}，无驱动 ${doc.stats?.panelOnly}`);
        rows.slice(0, 80).forEach((x: any) => console.log(`  ${x.kind.padEnd(4)} ${String(x.nodeType ?? '(非节点)').padEnd(28)} ${x.inPanel ? '面板' : '隐藏'} ${x.confidence.padEnd(14)} ${x.beanName ?? x.shortName ?? ''}`));
      }
      return 0;
    }
    case 'catalog expression': {
      const doc = JSON.parse(await readFile(catalogFile('expression-grammar.json'), 'utf8'));
      if (json) console.log(JSON.stringify(doc, null, 2));
      else {
        console.log(`表达式契约 v${doc.version}（来源 ${doc.source.flows} 个流程 / ${doc.source.props} 条属性 / ${doc.source.routes} 条路由）`);
        for (const [k, v] of Object.entries(doc.bnf ?? {})) console.log(`  ${k}: ${v}`);
        console.log(`  运算符：${Object.keys(doc.operators ?? {}).join(', ')}`);
        console.log(`  条件码：${Object.keys(doc.conditionCodes ?? {}).join(', ')}`);
      }
      return 0;
    }
    case 'catalog errors': {
      const kw = String(rest[0] ?? '').toLowerCase();
      const map = listErrorMap().filter((x) => !kw || x.msg.toLowerCase().includes(kw) || x.category.toLowerCase().includes(kw) || x.action.toLowerCase().includes(kw));
      const rows = listErrorActions().filter((x) => !kw || x.pattern.toLowerCase().includes(kw) || x.category.toLowerCase().includes(kw) || x.action.toLowerCase().includes(kw));
      if (json) console.log(JSON.stringify({ total: listErrorMap().length, matched: map.length, categories: [...new Set(map.map((x) => x.category))], map, rules: rows }, null, 2));
      else {
        const cats = new Map<string, number>();
        for (const x of map) cats.set(x.category, (cats.get(x.category) ?? 0) + 1);
        console.log(`错误文案 ${listErrorMap().length} 条，匹配 ${map.length} 条；关键词规则 ${rows.length} 条`);
        console.log(`分类：${[...cats.entries()].map(([k, v]) => `${k}=${v}`).join('，')}`);
        for (const x of map.slice(0, 20)) console.log(`  [${x.category}] ${x.msg}\n    → ${x.action}`);
        for (const x of rows.slice(0, 10)) console.log(`  {规则} [${x.category}] ${x.pattern}\n    → ${x.action}`);
      }
      return 0;
    }
    case 'error explain': {
      const msg = v.text ?? rest.join(' ');
      if (!msg) throw new RcError('E_VALIDATION', '用法：rc error explain "<平台错误文案>"');
      const e = explainError(msg);
      if (json) console.log(JSON.stringify(e, null, 2));
      else console.log(formatExplain(e));
      return 0;
    }
    case 'doctor': {
      const targetName = v.target ?? process.env.RC_TARGET;
      const configuredTarget = targetName || process.env.RC_BASE_URL ? resolveTarget(targetName) : undefined;
      const target = configuredTarget
        ? { ...configuredTarget, baseUrl: process.env.RC_BASE_URL ?? configuredTarget.baseUrl }
        : undefined;
      const report = await doctor({
        client: v.connect ? c : undefined,
        target,
        profile: v.profile ?? process.env.RC_PROFILE,
        connect: Boolean(v.connect),
        datasources: Boolean(v.datasources),
        maxDatasourceTests: 5,
      });
      // 钥匙串配错是最容易"静默 401"的原因：用户名取不到就直接判 fail 并给修复命令
      const creds = credentials();
      if (String(process.env.RC_KEYCHAIN ?? '') === '1' && !creds.user) {
        report.checks.push({
          name: 'keychain',
          status: 'fail',
          detail: 'RC_KEYCHAIN=1，但钥匙串里没有找到用户名条目',
          action: "rc auth keychain-setup --user <账号> --pass <密码>（写入 'user' 与 '<账号>' 两条）；"
            + '或用 RC_KEYCHAIN_USER / RC_KEYCHAIN_ACCOUNT 指定用户名',
        });
        report.summary.fail++;
        report.ok = false;
      }
      if (json) console.log(JSON.stringify({ ...report, credentials: { source: creds.source, warnings: creds.warnings } }, null, 2));
      else {
        console.log(formatDoctor(report));
        console.log(`凭据来源：${creds.source}`);
        for (const w of creds.warnings) console.log(`  ! ${w}`);
      }
      return report.ok ? 0 : 5;
    }

    // ---------- api ----------
    case 'api list': {
      // 平台的 appId/keyword 参数无效 → 拉全量后客户端过滤 + 客户端分页
      const page = Math.max(1, Number(v.page ?? 1));
      const size = Math.max(1, Number(v.size ?? 30));
      const res = await API.listAllApis(c, { appId: v.app, keyword: v.keyword, limit: page * size });
      if (json) {
        const rows = res.rows.slice((page - 1) * size, page * size);
        console.log(JSON.stringify({
          ok: true, total: res.matched, page, size, truncated: res.truncated, platformTotal: res.total,
          rows: rows.map((x: any) => ({ id: x.id, configId: x.configId, configName: x.configName, mapUrl: x.mapUrl, methodType: x.methodType, appId: x.appId, state: x.state })),
        }, null, 2));
        return 0;
      }
      const rows = res.rows.slice((page - 1) * size, page * size);
      console.log(`共 ${res.matched} 个匹配的 API（第 ${page} 页，每页 ${size}）${res.truncated ? '（已提前停止翻页，命中数非全量）' : ''}`);
      rows.forEach((x: any) => console.log(
        `${String(x.id ?? '').padEnd(28)} ${String(x.methodType ?? '').padEnd(7)} ${String(x.appId ?? '').padEnd(10)} ${String(x.configName ?? x.configId ?? '')}`));
      return 0;
    }
    case 'api list old': {
      const r = await API.listApis(c, { appId: v.app, keyword: v.keyword });
      if (!r.ok) return emit(r, json);
      const rows = API.unwrapRows(r.data?.data ?? r.data);
      let outRows = rows.map((x: any) => ({ id: x.id, status: x.status ?? x.state }));
      // 列表接口只返回 id/status；需要名称/路径时用 --enrich 批量取详情
      const enrich = v.enrich ? Number(v.enrich) : 0;
      if (enrich > 0) {
        for (const row of outRows.slice(0, enrich)) {
          const d = await API.getApi(c, String(row.id));
          const det = (d.data?.data ?? d.data ?? {}) as any;
          Object.assign(row, {
            serviceName: det.configName ?? det.serviceName ?? det.name,
            servicePath: det.mapUrl ?? det.servicePath ?? det.path ?? det.url,
            method: det.methodType ?? det.method ?? det.requestMethod,
            configId: det.configId,
            appId: det.appId ?? det.categoryId,
            version: det.version,
          });
        }
      }
      if (json) console.log(JSON.stringify({ ok: true, total: rows.length, rows: outRows }, null, 2));
      else {
        console.log(`共 ${rows.length} 条${enrich ? `（已取前 ${Math.min(enrich, rows.length)} 条详情）` : '（仅 id/status，加 --enrich N 取详情）'}`);
        outRows.slice(0, 30).forEach((x: any) => console.log(
          `${String(x.id ?? '').padEnd(26)} ${String(x.method ?? '').padEnd(7)} ${String(x.servicePath ?? '').padEnd(34)} ${x.serviceName ?? ''}`,
        ));
      }
      return 0;
    }
    case 'api get': {
      if (!rest[0]) throw new RcError('E_VALIDATION', '需要 API id：rc api get <id>');
      return emit(await API.getApi(c, rest[0]), json);
    }
    case 'api save': {
      if (!v.file) throw new RcError('E_VALIDATION', '需要 --file（API service JSON）');
      const body = await readJson(v.file);
      return emit(await API.saveApi(c, body, { dryRun: !v.apply }), json);
    }
    case 'api inparams list':
    case 'api outparams list': {
      const kind = command === 'api outparams list' ? 'out' : 'in';
      const id = v.id ?? v['service-id'] ?? action;
      if (!id) throw new RcError('E_VALIDATION', '需要 --id <服务 id>');
      const res = await APIPARAMS.getApiParams(c, String(id), kind);
      if (json) console.log(JSON.stringify({ ok: res.ok, kind, id, source: res.source, count: res.params.length, params: res.params }, null, 2));
      else {
        console.log(`${kind === 'out' ? '出参' : '入参'} ${res.params.length} 条（来源 ${res.source ?? '-'}）`);
        for (const p of res.params) {
          console.log(`  ${String(p.fieldName ?? '').padEnd(20)} ${String(p.fieldId ?? '').padEnd(20)} ${p.fieldType ?? ''}${p.required ? '  必填' : ''}${p.sampleValue ? `  样例 ${p.sampleValue}` : ''}`);
        }
      }
      return res.ok ? 0 : 4;
    }
    case 'api inparams save':
    case 'api outparams save': {
      const kind = command === 'api outparams save' ? 'out' : 'in';
      const id = v.id ?? v['service-id'] ?? action;
      if (!id || !v.file) throw new RcError('E_VALIDATION', '需要 --id <服务 id> 与 --file <参数 JSON>');
      const body = await readJson(v.file);
      const params = Array.isArray(body) ? body : (body?.params ?? []);
      const r = await APIPARAMS.saveApiParams(c, String(id), params, kind);
      return emit(r, json);
    }
    case 'api inparams from-json':
    case 'api outparams from-json': {
      const kind = command === 'api outparams from-json' ? 'out' : 'in';
      const id = v.id ?? v['service-id'] ?? action;
      if (!id || !v.file) throw new RcError('E_VALIDATION', '需要 --id <服务 id> 与 --file <JSON 样本>');
      const sample = await readJson(v.file);
      const derived = APIPARAMS.deriveParamsFromJson(sample);
      if (!derived.length) throw new RcError('E_VALIDATION', '样本里没有可推导的字段（需要 JSON 对象或对象数组）');
      if (!v.apply) {
        console.log(`【dry-run】将把 ${derived.length} 个字段写入 ${kind}param：${derived.map((p) => p.fieldId).join(', ')}`);
        return 0;
      }
      const r = await APIPARAMS.saveApiParams(c, String(id), derived, kind);
      if (!r.ok) { console.error(`✖ 写入失败：${r.msg}`); return 4; }
      console.log(`✔ 已从 JSON 样本推导并写入 ${derived.length} 个${kind === 'out' ? '出参' : '入参'}`);
      return 0;
    }
    case 'api import': {
      if (!v.app || !v.file) throw new RcError('E_VALIDATION', '需要 --app 与 --file');
      const spec = await readFile(v.file, 'utf8');
      return emit(await API.importOpenApi(c, v.app, spec, {
        categoryId: v.category, authType: v['auth-type'] ? Number(v['auth-type']) : undefined,
        dryRun: !v.apply,
      }), json);
    }
    case 'api analyze': {
      if (!v.app || !v.file) throw new RcError('E_VALIDATION', '需要 --app 与 --file');
      const spec = await readFile(v.file, 'utf8');
      const items = await API.analyzeOpenApi(c, v.app, spec);
      if (json) console.log(JSON.stringify(items, null, 2));
      else {
        console.log(`解析出 ${items.length} 个待导入 API`);
        items.slice(0, 40).forEach((it) => console.log(`  ${String(it.methodType ?? '').padEnd(7)} ${it.mapUrl ?? ''}  ${it.configName ?? ''}`));
      }
      return 0;
    }
    case 'api export': {
      const out = v.o ?? v.out;
      if (v['service-id']) {
        const r = await API.exportOpenApi(c, v['service-id']);
        if (r.ok && out) { await writeFile(out, JSON.stringify(r.data?.data ?? r.data, null, 2)); console.log(`✔ 已导出 OpenAPI 到 ${out}`); return 0; }
        return emit(r, json);
      }
      if (!v.app) throw new RcError('E_VALIDATION', '需要 --app（导出应用服务基线）或 --service-id（导出 OpenAPI 3）');
      const r = await API.exportServiceBundle(c, v.app);
      if (r.ok && out) { await writeFile(out, JSON.stringify(r.data?.data ?? r.data, null, 2)); console.log(`✔ 已导出基线到 ${out}`); return 0; }
      return emit(r, json);
    }
    case 'api diff': {
      if (!v.from || !v.to) throw new RcError('E_VALIDATION', '需要 --from 与 --to');
      const a = await readJson(v.from);
      const b = await readJson(v.to);
      const d = API.diffBundles(a, b);
      const br = v.breaking ? API.breakingInBundles(a, b) : [];
      if (json) console.log(JSON.stringify({ ...d, breaking: br }, null, 2));
      else {
        console.log(`新增 ${d.added.length} / 删除 ${d.removed.length} / 变更 ${d.changed.length}`);
        d.added.slice(0, 20).forEach((p) => console.log(`  + ${p}`));
        d.removed.slice(0, 20).forEach((p) => console.log(`  - ${p}`));
        d.changed.slice(0, 20).forEach((p) => console.log(`  ~ ${p}`));
        br.forEach((x) => console.log(`  ! ${x}`));
      }
      return d.removed.length || br.length ? 4 : 0;
    }
    case 'api impact': {
      if (!v.id) throw new RcError('E_VALIDATION', '需要 --id（apiId）');
      if (v.deep) {
        const d = await API.getApi(c, v.id);
        if (!d.ok) return emit(d, json);
        const detail = (d.data?.data ?? d.data) as any;
        const res = await LIN.deepImpactOfApi(c, {
          id: v.id,
          name: detail?.serviceName ?? detail?.configName,
          path: detail?.servicePath ?? detail?.mapUrl,
        }, { kind: v.kind as 'esb' | 'etl' });
        if (json) console.log(JSON.stringify(res, null, 2));
        else {
          console.log(`扫描流程 ${res.scanned} 个；直接引用 ${res.direct.length} 个，间接调用者 ${res.indirect.length} 个`);
          for (const h of res.direct) console.log(`  直接 ${h.processId}  ${h.processName ?? ''}  命中 ${h.directHits}`);
          for (const h of res.indirect) console.log(`  间接 ${h.processId}  ${h.processName ?? ''}  经 ${h.viaSubProcess}`);
        }
        return 0;
      }
      const hits = await API.impactOfApi(c, v.id, { kind: v.kind as 'esb' | 'etl' });
      if (json) console.log(JSON.stringify(hits, null, 2));
      else if (hits.length === 0) console.log('未发现引用');
      else hits.forEach((h) => console.log(`${h.processId}  ${h.processName ?? ''}  命中 ${h.hits}`));
      return 0;
    }

    // ---------- connector ----------
    case 'connector apps': {
      const apps = await CONN.listConnectorApps(c);
      if (json) console.log(JSON.stringify(apps, null, 2));
      else {
        console.log(`连接器应用 ${apps.length} 个`);
        apps.forEach((a) => console.log(`  ${String(a.configType ?? a.id ?? '').padEnd(26)} ${a.configName ?? a.appName ?? a.name ?? ''}`));
      }
      return 0;
    }
    case 'connector configs': {
      const type = String(v['config-type'] ?? v.app ?? '');
      if (!type) throw new RcError('E_VALIDATION', '需要 --config-type（先 rc connector apps 查看）');
      const r = await CONN.listConnectorConfigs(c, type);
      return emit(r, json);
    }
    case 'connector get': {
      if (!action) throw new RcError('E_VALIDATION', '用法：rc connector get <id>');
      const r = await CONN.getConnectorConfig(c, action);
      if (json) console.log(JSON.stringify(r, null, 2));
      else console.log(JSON.stringify(r.data, null, 2));
      return r.ok ? 0 : 4;
    }
    case 'connector docs': {
      const type = String(v['config-type'] ?? v.app ?? '');
      if (!type) throw new RcError('E_VALIDATION', '需要 --config-type');
      return emit(await CONN.listConnectorDocs(c, type), json);
    }
    case 'connector export': {
      const type = String(v['config-type'] ?? v.app ?? '');
      if (!type) throw new RcError('E_VALIDATION', '需要 --config-type');
      const doc = await CONN.exportConnectorConfigs(c, type);
      const out = v.out ?? `connector-${type}.json`;
      await writeFile(out, JSON.stringify(doc, null, 2) + '\n');
      console.log(`✔ 已导出 ${doc.items.length} 条连接器配置到 ${out}（已脱敏）`);
      return 0;
    }
    case 'connector import': {
      if (!v.file) throw new RcError('E_VALIDATION', '需要 --file（connector export 产物）');
      const doc = await readJson(v.file) as { configType: string; items: Record<string, unknown>[] };
      if (!doc?.configType || !Array.isArray(doc.items)) throw new RcError('E_VALIDATION', '文件格式应为 {configType, items:[...]}');
      const r = await CONN.importConnectorConfigs(c, doc, { dryRun: !v.apply });
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`${r.ok ? '✔' : '✖'} 导入 ${r.total} 条（${v.apply ? '已应用' : 'dry-run'}）`);
        r.results.filter((x) => !x.ok).forEach((x) => console.log(`  ✖ #${x.index}: ${x.msg ?? ''}`));
      }
      return r.ok ? 0 : 4;
    }
    case 'connector delete': {
      if (!action) throw new RcError('E_VALIDATION', '用法：rc connector delete <id> [--apply]');
      return emit(await CONN.deleteConnectorConfig(c, action, { dryRun: !v.apply }), json);
    }

    // ---------- local ----------
    case 'local prune': {
      const res = await LOCAL.pruneLocalState({
        snapshotDays: v['snapshot-days'], auditDays: v['audit-days'], nodeDays: v['node-days'],
        apply: Boolean(v.apply),
      });
      // 审计是按月分文件的 jsonl：删除整月之外，还可以只保留每个文件最近 N 行
      let trimmed = 0;
      if (v['trim-audit-lines']) {
        const keep = Number(v['trim-audit-lines']);
        if (v.apply) {
          for (const f of await LOCAL.auditFileSummary(LOCAL.localStatePaths().audit)) {
            trimmed += await LOCAL.trimAuditFile(f.file, keep);
          }
        }
      }
      const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
      if (json) {
        console.log(JSON.stringify({ ok: true, applied: Boolean(v.apply), freedBytes: res.freedBytes, removedBytes: res.removedBytes,
          snapshots: res.snapshots.length, audit: res.audit.length, flowNodes: res.flowNodes.length, trimmedAuditLines: trimmed }, null, 2));
        return 0;
      }
      console.log(`可清理：快照 ${res.snapshots.length} 个 / 审计 ${res.audit.length} 个 / 节点集合 ${res.flowNodes.length} 个，共 ${mb(res.freedBytes)}`);
      if (v.apply) console.log(`✔ 已删除，释放 ${mb(res.removedBytes)}${trimmed ? `；审计裁掉 ${trimmed} 行` : ''}`);
      else console.log('  （预览模式；加 --apply 才会真的删除）');
      return 0;
    }

    // ---------- sql ----------
    case 'sql query': {
      const conn = v.conn ?? v['db-conn-id'];
      const query = v.query ?? v.sql;
      if (!conn || !query) throw new RcError('E_VALIDATION', '需要 --conn <dbConnId> 与 --query <SQL>');
      const res = await SQLQ.querySql(c, {
        conn: String(conn),
        sql: String(query),
        maxRows: v['max-rows'] ? Number(v['max-rows']) : undefined,
        tableColumns: v['table-columns'] ? String(v['table-columns']) : undefined,
      });
      if (json) console.log(JSON.stringify({ conn, ...res }, null, 2));
      else {
        console.log(SQLQ.formatSqlQuery(res));
        if (res.ok && res.rows.length) {
          console.log(`（${res.rows.length}/${res.total} 行；输出含真实业务数据，别贴进工单或仓库）`);
        }
      }
      return res.ok ? 0 : 4;
    }
    case 'sql check': {
      const conn = v.conn ?? v['db-conn-id'];
      const query = v.query ?? v.sql;
      if (!conn || !query) throw new RcError('E_VALIDATION', '需要 --conn <dbConnId> 与 --query <SQL>');
      const res = await SQLQ.checkSql(c, { conn: String(conn), sql: String(query) });
      if (json) console.log(JSON.stringify({ conn, ...res }, null, 2));
      else console.log(SQLQ.formatSqlCheck(res));
      return res.ok ? 0 : 4;
    }

    // ---------- lineage ----------
    case 'lineage table': {
      const table = rest.join(' ').trim();
      if (!table) throw new RcError('E_VALIDATION', '用法：rc lineage table <tableName> [--direction in|out]');
      const direction = v.direction === 'out' ? 'out' : 'in';
      const res = await LIN.tableLineage(c, table, { direction });
      if (json) console.log(JSON.stringify(res, null, 2));
      else {
        console.log(`共 ${res.rows.length} 条血缘`);
        res.rows.forEach((x) => console.log(`  ${x.direction} ${x.tableName}  ${x.processId ?? ''}  ${x.processName ?? ''}  ${x.datasourceName ?? ''}`));
        if (res.note) console.log(`  ! ${res.note}`);
      }
      return 0;
    }
    case 'lineage datasource': {
      const rows = await LIN.datasourceLineage(c);
      if (json) console.log(JSON.stringify(rows, null, 2));
      else rows.forEach((x) => console.log(`  ${x.datasourceId ?? ''}  ${x.datasourceName ?? ''}  tables=${x.tables.length}  processes=${x.processes.length}`));
      return 0;
    }
    case 'lineage apps': {
      const data = await LIN.appRelationship(c);
      console.log(JSON.stringify(data, null, 2));
      return 0;
    }
    case 'lineage api': {
      if (!v.id) throw new RcError('E_VALIDATION', '需要 --id（apiId）');
      const d = await API.getApi(c, v.id);
      if (!d.ok) return emit(d, json);
      const detail = (d.data?.data ?? d.data) as any;
      const res = await LIN.deepImpactOfApi(c, {
        id: v.id,
        name: detail?.serviceName ?? detail?.configName,
        path: detail?.servicePath ?? detail?.mapUrl,
      }, { kind: v.kind as 'esb' | 'etl' });
      if (json) console.log(JSON.stringify(res, null, 2));
      else {
        console.log(`扫描 ${res.scanned} 个流程；直接 ${res.direct.length}，间接 ${res.indirect.length}`);
        for (const h of res.direct) console.log(`  直接 ${h.processId}  ${h.processName ?? ''}  命中 ${h.directHits}`);
        for (const h of res.indirect) console.log(`  间接 ${h.processId}  ${h.processName ?? ''}  经 ${h.viaSubProcess}`);
      }
      return 0;
    }
    case 'lineage meta': {
      const data = await LIN.metaTableLineage(c, rest[0]);
      console.log(JSON.stringify(data, null, 2));
      return 0;
    }

    // ---------- flow ----------
    case 'flow build': {
      if (!v.file) throw new RcError('E_VALIDATION', '缺少 --file（流程规格 JSON）');
      const spec = await readJson(v.file) as BuildInput;
      const kind = flowKind(spec, v.kind);
      const cat0 = new Catalog();
      requireEtlCatalog(cat0, kind);
      const { model, warnings, props } = buildProcessModel({ ...spec, kind });
      const propsMap = FLOW.nodePropsMap(props) ?? {};
      const out = v.out ?? 'flow-model.json';
      // 组合文件：flow save / flow validate / flow check 都可直接复用，属性不会在 build → save 之间丢失。
      await writeFile(out, JSON.stringify({ kind, model, props: propsMap }, null, 1));
      if (v['props-out']) await writeFile(String(v['props-out']), JSON.stringify(propsMap, null, 1));
      const known = kind === 'etl' ? cat0.etlNodeTypes() : cat0.nodeTypes();
      // build 产物是草稿：必填属性缺失只提示，不阻断。
      const issues = validateFlow(model, {
        knownTypes: known, allowMock: v['allow-mock'], nodeProps: propsMap,
        requiredFields: cat0.requiredFields(kind), requiredLevel: 'warn',
      });
      if (json) console.log(JSON.stringify({ kind, model, props: propsMap, warnings, issues }, null, 2));
      else {
        console.log(`已生成 ${out}（${kind}）：节点 ${model.nodeDataArray.length}，连线 ${model.linkDataArray.length}，属性 ${props.length}`);
        if (v['props-out']) console.log(`✔ 属性已写入 ${v['props-out']}`);
        warnings.forEach((w) => console.log(`⚠ ${w}`));
        issues.forEach((i) => console.log(`${i.level === 'error' ? '✖' : '⚠'} [${i.code}] ${i.msg}`));
      }
      return hasBlockingError(issues) ? 4 : 0;
    }
    case 'flow validate': {
      if (!v.file) throw new RcError('E_VALIDATION', '缺少 --file');
      const explicitKind = v.kind === 'etl' ? 'etl' : 'esb';
      const parsed = await readFlowFile(v.file, explicitKind);
      const kind = parsed.kind;
      const cat = new Catalog();
      requireEtlCatalog(cat, kind);
      const known = kind === 'etl' ? cat.etlNodeTypes() : cat.nodeTypes();
      // 组合文件里的 raw.props 必须参与校验；--props 可显式覆盖。
      const nodeProps = v.props
        ? await loadProps(c, v['process-id'], v.props, kind)
        : (parsed.props ? FLOW.nodePropsMap(parsed.props) : undefined);
      let issues = validateFlow(parsed.model, {
        knownTypes: known,
        allowMock: v['allow-mock'],
        nodeProps,
        // 必填属性：平台 checkerror 偏松，本地是唯一兜底；骨架模板（skeleton）或显式开关时只提示。
        requiredFields: cat.requiredFields(kind),
        requiredLevel: requiredLevel(parsed.skeleton, v['allow-missing-required']),
      });
      // 给了 --process-id 时，平台本来就缺的必填项按"沿用现状"降级为警告。
      issues = await relaxInheritedRequired(c, kind, v['process-id'], parsed.model, nodeProps, issues);
      if (json) console.log(JSON.stringify(issues, null, 2));
      else if (issues.length === 0) console.log('✔ 校验通过');
      else issues.forEach((i) => console.log(`${i.level === 'error' ? '✖' : '⚠'} [${i.code}] ${i.msg}`));
      return hasBlockingError(issues) ? 4 : 0;
    }
    case 'flow from-nl': {
      const text = String(v.text ?? rest.join(' ')).trim();
      if (!text) throw new RcError('E_VALIDATION', '用法：rc flow from-nl \"<自然语言描述>\"');
      const res = await flowFromNl(text, {
        kind: v.kind === 'etl' ? 'etl' : v.kind === 'esb' ? 'esb' : undefined,
        name: v.name,
        useLlm: v['no-llm'] ? false : v['use-llm'],
      });
      const { model, warnings } = buildProcessModel(res.input);
      const cat = new Catalog();
      const known = res.kind === 'etl' ? cat.etlNodeTypes() : cat.nodeTypes();
      const nodeProps: Record<string, Record<string, unknown>> = {};
      for (const p of res.props) {
        const values = Object.fromEntries(Object.entries(p.values).filter(([, x]) => x !== '' && x !== null && x !== undefined));
        if (!Object.keys(values).length) continue;
        const n = res.input.nodes.find((x) => x.key === p.nodeId);
        nodeProps[p.nodeId] = { pNodeId: p.nodeId, pNodeType: p.nodeType, pNodeName: n?.nodeName ?? n?.text ?? '', ...values };
      }
      const issues = validateFlow(model, { knownTypes: known, allowMock: false, nodeProps });
      if (v.out) await writeFile(v.out, JSON.stringify({ id: res.pattern, name: res.name, kind: res.kind, model, props: nodeProps }, null, 1));
      if (v['props-out']) await writeFile(String(v['props-out']), JSON.stringify(nodeProps, null, 1));
      if (json) console.log(JSON.stringify({ ...res, model, validation: issues }, null, 2));
      else {
        console.log(formatNlFlow(res));
        warnings.forEach((w) => console.log(`⚠ ${w}`));
        if (v.out) console.log(`✔ 已写入 ${v.out}`);
        if (issues.length) console.log(issues.map((i) => `${i.level === 'error' ? '✖' : '⚠'} [${i.code}] ${i.msg}`).join('\n'));
      }
      return res.ok && !hasBlockingError(issues) ? 0 : 4;
    }
    case 'templates list': {
      const idx = JSON.parse(await readFile(catalogFile('flow-templates/index.json'), 'utf8'));
      if (json) console.log(JSON.stringify(idx, null, 2));
      else {
        console.log(`标准模板 ${idx.count} 个（${idx.generatedAt}）`);
        for (const t of idx.templates) console.log(`  ${String(t.id).padEnd(26)} ${String(t.category).padEnd(10)} ${t.name}  节点${t.nodes}/连线${t.edges} ${t.ok ? '✔' : '✖'}`);
      }
      return 0;
    }
    case 'templates show': {
      if (!action) throw new RcError('E_VALIDATION', '用法：rc templates show <id> [--out model.json] [--props-out props.json]');
      const doc = JSON.parse(await readFile(catalogFile(`flow-templates/${action}.json`), 'utf8'));
      if (v.out || v['props-out']) {
        // skeleton:true → 必填属性（URL/连接/表名…）只提示不阻断，等项目替换后再保存。
        if (v.out) await writeFile(String(v.out), JSON.stringify({ id: doc.id, name: doc.name, kind: doc.kind ?? 'esb', skeleton: true, model: doc.model, props: doc.props ?? {} }, null, 1));
        if (v['props-out']) await writeFile(String(v['props-out']), JSON.stringify(doc.props ?? {}, null, 1));
        console.log(`✔ 已写入 ${[v.out, v['props-out']].filter(Boolean).join(' / ')}`);
      } else {
        console.log(JSON.stringify(doc, null, 2));
      }
      return 0;
    }
    case 'templates validate': {
      const dir = catalogFile('flow-templates');
      const cat = new Catalog();
      const docs = await readDirJson<any>(dir);
      let bad = 0;
      for (const d of docs) {
        const known = d.data.kind === 'etl' ? cat.etlNodeTypes() : cat.nodeTypes();
        // 模板是骨架（URL/连接/表名待替换），必填属性缺失只提示。
        const issues = validateFlow(d.data.model, {
          knownTypes: known, allowMock: false, nodeProps: d.data.props,
          requiredFields: cat.requiredFields(d.data.kind === 'etl' ? 'etl' : 'esb'), requiredLevel: 'warn',
        });
        const blocking = issues.filter((i) => i.level === 'error');
        if (blocking.length) bad++;
        console.log(`${blocking.length ? '✖' : '✔'} ${String(d.data.id ?? d.file).padEnd(26)} ${blocking.map((i) => i.code).join(',') || 'ok'}`);
      }
      console.log(`\n${docs.length} 个模板，${bad} 个未通过`);
      return bad ? 4 : 0;
    }
    case 'review flow': {
      if (!v.file) throw new RcError('E_VALIDATION', '需要 --file（流程模型或 {model}）');
      const raw = await readJson(v.file) as any;
      const kind = flowKind(raw, v.kind);
      const model = raw?.model ?? (raw?.nodeDataArray ? raw : buildProcessModel({ ...(raw as BuildInput), kind }).model);
      const report = reviewFlow(model, {
        knownTypes: kind === 'etl' ? new Catalog().etlNodeTypes() : new Catalog().nodeTypes(),
        production: Boolean(v.production),
        nodeProps: FLOW.nodePropsMap(FLOW.normalizeNodeProps(raw?.props)),
        processName: raw?.name,
      });
      if (json) console.log(JSON.stringify(report, null, 2));
      else console.log(formatReview(report));
      return report.ok ? 0 : 4;
    }
    case 'review api': {
      if (!v.file) throw new RcError('E_VALIDATION', '需要 --file（API 导出包）');
      const raw = await readJson(v.file);
      const report = reviewApiBundle(raw, { production: Boolean(v.production) });
      if (json) console.log(JSON.stringify(report, null, 2));
      else console.log(formatReview(report));
      return report.ok ? 0 : 4;
    }
    case 'flow check': {
      // 平台侧校验（图 + 已有节点属性的联合校验）
      if (!v.file || !v['process-id']) throw new RcError('E_VALIDATION', '需要 --file 与 --process-id');
      const parsed = await readFlowFile(v.file, v.kind === 'etl' ? 'etl' : 'esb');
      const kind = parsed.kind;
      const chk = await FLOW.checkFlow(c, {
        appId: kind === 'etl' ? 'etl' : 'esb', processId: v['process-id'], processModel: JSON.stringify(parsed.model), kind,
      });
      if (json) console.log(JSON.stringify(chk, null, 2));
      else {
        console.log(chk.ok ? `✔ 平台校验通过：${chk.msg}` : `✖ 平台校验未通过：${chk.msg}`);
        chk.errorNodeList?.forEach((n: any) => console.log(`   · ${n.nodeId ?? n.id ?? ''} ${n.name ?? ''} ${n.msg ?? ''}`));
      }
      return chk.ok ? 0 : 4;
    }
    case 'flow create': {
      const applicationId = v.application ?? v.app;
      if (!applicationId || !v.name) throw new RcError('E_VALIDATION', '需要 --application（业务应用 id）与 --name（流程名）');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const r = await FLOW.createFlow(c, { applicationId, processName: v.name, configId: v['config-id'], kind }, { dryRun: !v.apply, kind });
      if (json) console.log(JSON.stringify({ ...r, kind, dryRun: isDryRun(r) }, null, 2));
      else if (isDryRun(r)) {
        console.log(dryRunNotice(r, `创建 ${kind} 流程`));
        console.log(`   将要创建：configId=${r.configId}（加 --apply 才会真正创建）`);
      } else if (r.ok && r.processId) console.log(`✔ 流程已创建（${kind}）：processId=${r.processId}  configId=${r.configId}`);
      else if (r.ok) console.log(`✔ 流程已创建（编码 ${r.configId}），但未能回查到 processId，请用 flow list --keyword ${v.name} 确认`);
      else console.error(`✖ 创建失败：${r.msg ?? '未知原因'}`);
      return r.ok ? 0 : 4;
    }
    case 'flow list': {
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const appId = v.application ?? v.app;         // 业务应用（applicationId）
      const module = v.module ? String(v.module) : undefined; // 平台模块（appId）
      const page = Math.max(1, Number(v.page ?? 1));
      const size = Math.max(1, Number(v.size ?? 30));
      // 平台 keyword 不可用 → 拉取时顺带做客户端过滤，命中够当前页就提前停止翻页。
      const r = await FLOW.listFlows(c, {
        keyword: v.keyword, appId, kind, all: true, pageSize: 100,
        filter: { keyword: v.keyword, appId, module }, limit: page * size,
      });
      if (!r.ok) return emit(r, json);
      const payload = r.data?.data ?? r.data;
      const allRows = FLOW.filterFlows(FLOW.unwrapFlowRows(payload), { keyword: v.keyword, appId, module });
      const rows = allRows.slice((page - 1) * size, page * size).map((x: any) => FLOW.normalizeFlowRow(x));
      const truncated = Boolean((payload as any)?.truncated);
      if (json) {
        console.log(JSON.stringify({ ok: true, kind, total: allRows.length, page, size, truncated, rows }, null, 2));
        return 0;
      }
      console.log(`共 ${allRows.length} 个${kind === 'etl' ? ' ETL ' : ' '}流程（第 ${page} 页，每页 ${size}）${truncated ? '（已提前停止翻页，命中数非全量）' : ''}`);
      console.log('  processId                     configId              st  业务应用   流程名');
      rows.forEach((x) => console.log(
        `${String(x.processId).padEnd(26)} ${String(x.configId).padEnd(20)} ${String(x.state ?? '').padEnd(3)} ${x.applicationId.padEnd(10)} ${x.configName}`));
      return 0;
    }
    case 'flow search': {
      // 按节点类型找真实流程，看"这种节点到底该怎么配"（组件目录里的 initialValue 可能是截断的）
      const nodeType = v['node-type'] ?? v.type;
      if (!nodeType) throw new RcError('E_VALIDATION', '需要 --node-type <节点类型>（如 dataSplitNode / apiNode）');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const propFilter: Record<string, string> = {};
      for (const kv of String(v.props ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
        const i = kv.indexOf('=');
        if (i > 0) propFilter[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      }
      const res = await FLOW.searchFlowsByNodeType(c, {
        kind, nodeType: String(nodeType), keyword: v.keyword,
        maxFlows: v['max-flows'] ?? v.size ? Number(v['max-flows'] ?? v.size) : undefined,
        limit: v.limit ? Number(v.limit) : undefined,
        all: Boolean(v.all),
        props: Object.keys(propFilter).length ? propFilter : undefined,
        checkRegistry: Boolean(v['check-registry']),
      });
      if (json) console.log(JSON.stringify({ ok: true, kind, nodeType, scanned: res.scanned, matched: res.matched, hosts: res.hosts, hits: res.hits }, null, 2));
      else {
        console.log(`扫描 ${res.scanned} 条${kind === 'etl' ? ' ETL ' : ' '}流程，命中 ${res.matched} 个 ${nodeType} 节点`);
        if (res.hosts.length) console.log(`本环境出现的网关主机：${res.hosts.join('、')}`);
        for (const h of res.hits) {
          console.log(`  ${h.processId}  ${h.configName}  节点 ${h.nodeId}（${h.nodeName}）`);
          for (const [k, v] of Object.entries(h.props)) {
            console.log(`      ${k} = ${typeof v === 'string' ? v.slice(0, 120) : JSON.stringify(v)}`);
          }
          // 样例多半来自别的环境/别的部署，先说清楚再让人抄
          for (const n of h.notes) console.log(`      ⚠ ${n}`);
        }
      }
      return 0;
    }
    case 'flow apps': {
      // 业务应用清单：平台 /rest/core/apps 列的是"平台模块"，业务应用要从流程的 applicationId 聚合
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const res = await FLOW.listBusinessApps(c, { kind });
      if (json) console.log(JSON.stringify({ ok: true, kind, apps: res.apps }, null, 2));
      else {
        console.log(`业务应用 ${res.apps.length} 个（${kind}）：`);
        for (const a of res.apps) console.log(`  ${a.applicationId.padEnd(14)} 流程 ${String(a.flows).padEnd(5)} 模块 ${a.modules.join(',')}`);
        console.log('提示：业务应用 = 流程的 applicationId；平台模块（esb/etl）用 rc apps 查看');
      }
      return 0;
    }
    case 'flow get': {
      if (!action) throw new RcError('E_VALIDATION', '需要 processId');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      return emit(await FLOW.getFlow(c, action, { kind }), json);
    }
    case 'flow export': {
      if (!action) throw new RcError('E_VALIDATION', '需要 processId');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const r = await FLOW.exportFlow(c, action, { kind });
      if (!r.ok || !r.doc) {
        console.error(`✖ 导出失败：${r.msg ?? '未知原因'}`);
        return 4;
      }
      if (v.out) await writeFile(String(v.out), JSON.stringify(r.doc, null, 1));
      if (json) console.log(JSON.stringify(r.doc, null, 2));
      else {
        console.log(`✔ 已导出 ${kind} 流程 ${action}：节点 ${(r.doc.model as any)?.nodeDataArray?.length ?? 0}，属性 ${Object.keys(r.doc.props).length}`);
        if (v.out) console.log(`  写入 ${v.out}`);
      }
      return 0;
    }
    case 'flow clone': {
      if (!action) throw new RcError('E_VALIDATION', '需要 processId');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const r = await FLOW.cloneFlow(c, { processId: action, processName: v.name, kind }, { dryRun: !v.apply, kind });
      if (json) console.log(JSON.stringify({ ...r, kind }, null, 2));
      else if (isDryRun(r)) console.log(dryRunNotice(r, '克隆流程'));
      else if (r.ok) console.log(`✔ 克隆完成：processId=${r.processId ?? '(待回查)'}`);
      else console.error(`✖ 克隆失败：${r.msg ?? ''}`);
      return r.ok ? 0 : 4;
    }
    case 'flow delete': {
      if (!action) throw new RcError('E_VALIDATION', '需要 processId');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const r = await FLOW.deleteFlow(c, action, { dryRun: !v.apply, kind });
      if (!json) {
        if (r.snapshotFile) console.log(`  保存前快照：${r.snapshotFile}`);
        if (isDryRun(r)) console.log(dryRunNotice(r, '删除流程'));
      }
      return emit(r, json);
    }
    case 'flow publish': {
      if (!action) throw new RcError('E_VALIDATION', '需要 processId');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      // 带 --url/--name → "发布成接口"（草稿态 → 上线态两步）；否则是原来的"发布流程"
      if (v.url || v.name) {
        if (!v.url || !v.name) throw new RcError('E_VALIDATION', '发布成接口需要 --url 与 --name（另可给 --app-id / --method）');
        if (!v.apply) {
          console.log(`【dry-run】未发布：将把 ${kind} 流程 ${action} 发布成接口 ${v.method ?? 'POST'} ${v.url}（先建草稿再置为上线态）；加 --apply 才会真的发布`);
          return 0;
        }
        const res = await PUBAPI.publishFlowAsApi(c, action, {
          url: String(v.url), name: String(v.name), method: v.method ? String(v.method) : undefined,
          appId: v['app-id'] ? String(v['app-id']) : undefined,
        });
        if (json) console.log(JSON.stringify({ ok: res.ok, serviceId: res.serviceId, mapUrl: res.mapUrl, state: res.state, msg: res.msg }, null, 2));
        else console.log(res.ok ? `✔ ${res.msg}` : `✖ ${res.msg}`);
        return res.ok ? 0 : 4;
      }
      return emit(await FLOW.publishFlow(c, action, { dryRun: !v.apply, kind }), json);
    }
    case 'flow java compile': {
      if (!v['process-id']) throw new RcError('E_VALIDATION', '需要 --process-id');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const pid = String(v['process-id']);
      // 取流程里的全部节点属性，挑出带 code 的 javaCodeNode
      const all = await FLOW.listFlowProps(c, pid, { kind });
      let nodes = all.props ?? {};
      if (v['node-id']) {
        const one = nodes[String(v['node-id'])];
        if (!one) throw new RcError('E_VALIDATION', `流程 ${pid} 里没有节点 ${v['node-id']}`);
        nodes = { [String(v['node-id'])]: one };
      }
      const nodeProps = Object.entries(nodes).map(([nodeId, props]) => ({
        nodeId,
        nodeType: String((props as any)?.pNodeType ?? ''),
        props: props as Record<string, unknown>,
      }));
      const report = await JAVAC.compileJavaNodes(c, { nodeProps, dryRun: !v.apply });
      if (json) {
        console.log(JSON.stringify({ processId: pid, ...report }, null, 2));
      } else {
        if (!report.nodeIds.length) {
          console.log('流程里没有带 code 的 Java 节点，无需编译。');
        }
        for (const r of report.results) {
          if (r.ok) {
            console.log(`✔ ${r.nodeId} 编译成功（${r.classPath}）`);
          } else {
            console.error(`✖ ${r.nodeId} 编译失败${r.classPath ? `（${r.classPath}）` : ''}`);
            if (!r.written) console.error(`  源文件未写入：${r.msg ?? '-'}`);
            if (r.compileError) console.error(r.compileError);
          }
        }
        if (report.nodeIds.length) {
          console.error('  多实例部署下各实例的编译产物可能不一致，需确认所有实例都已刷新；连跑 3 次看行为是否一致。');
        }
      }
      return report.ok ? 0 : 4;
    }
    case 'flow props get': {
      if (!v['process-id'] || !v['node-id']) throw new RcError('E_VALIDATION', '需要 --process-id 与 --node-id');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const p = await FLOW.getNodeProps(c, v['process-id'], v['node-id'], { kind });
      console.log(JSON.stringify(p, null, 2));
      return 0;
    }
    case 'flow preview': {
      if (!v['process-id'] || !v['node-id']) throw new RcError('E_VALIDATION', '需要 --process-id 与 --node-id');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const res = await PREVIEW.previewFlowNode(c, {
        processId: String(v['process-id']), nodeId: String(v['node-id']), kind,
        limit: v.limit ? Number(v.limit) : undefined,
      });
      if (json) console.log(JSON.stringify({ kind, processId: v['process-id'], nodeId: v['node-id'], ...res }, null, 2));
      else {
        console.log(PREVIEW.formatPreviewTable(res));
        if (res.ok) console.log(`节点类型 ${res.nodeType}；返回 ${res.rows.length} 行${res.truncated ? `（共 ${res.totalRows} 行）` : ''}`);
      }
      return res.ok ? 0 : 4;
    }
    case 'flow props list': {
      if (!v['process-id']) throw new RcError('E_VALIDATION', '需要 --process-id');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const r = await FLOW.listFlowProps(c, v['process-id'], { kind });
      const props = FLOW.filterNodeProps(r.props, {
        only: v.only ? String(v.only) : undefined,
        fields: v.fields ? String(v.fields).split(',') : undefined,
      });
      console.log(JSON.stringify({
        ok: r.ok, kind, processId: v['process-id'],
        only: v.only ?? null, fields: v.fields ?? null,
        total: Object.keys(r.props).length, count: Object.keys(props).length,
        props,
      }, null, 2));
      return r.ok ? 0 : 4;
    }
    case 'flow props save': {
      if (!v['process-id'] || !v.file) throw new RcError('E_VALIDATION', '需要 --process-id 与 --file（属性 JSON）');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const nodes = FLOW.normalizeNodeProps(await readJson(v.file)) ?? [];

      // --compile：先编译 Java 节点，编译不过就不保存（避免把坏代码写进属性）
      if (v.compile && nodes.length) {
        const javaNodes = nodes
          .filter((n) => (n.nodeType ?? '') === 'javaCodeNode' && String((n.props ?? {}).code ?? '').trim())
          .map((n) => ({ nodeId: n.nodeId, nodeType: n.nodeType, props: (n.props ?? {}) as Record<string, unknown> }));
        if (javaNodes.length) {
          const creport = await JAVAC.compileJavaNodes(c, { nodeProps: javaNodes, dryRun: !v.apply });
          for (const r of creport.results) {
            if (r.ok) console.error(`✔ Java 节点 ${r.nodeId} 编译成功（${r.classPath}）`);
            else {
              console.error(`✖ Java 节点 ${r.nodeId} 编译失败${r.classPath ? `（${r.classPath}）` : ''}`);
              if (!r.written) console.error(`  源文件未写入：${r.msg ?? '-'}`);
              if (r.compileError) console.error(r.compileError);
            }
          }
          if (!creport.ok) {
            console.error('  编译未通过，已中止保存：属性不落库，避免把编译不过的代码写进去。');
            return 4;
          }
        }
      }

      const rep = await FLOW.saveNodePropsComplete(c, {
        appId: kind === 'etl' ? 'etl' : 'esb', processId: v['process-id'], nodes, kind,
      }, { dryRun: !v.apply });
      if (json) console.log(JSON.stringify(rep, null, 2));
      else {
        if (rep.snapshotFile) console.log(`  保存前快照：${rep.snapshotFile}`);
        if (isDryRun(rep as any)) console.log(dryRunNotice((rep as any).request, `写入节点属性 processId=${v['process-id']}`));
        console.log(`新增 ${rep.inserted.length} / 更新 ${rep.updated.length} / 清理重复 ${rep.deduped?.length ?? 0} / 失败 ${rep.failed.length}`);
        if (rep.rolledBack) console.log('  ↩ 已自动回滚到保存前快照');
        if (rep.rollback?.verified) {
          const v = rep.rollback.verified;
          console.log(`  ↩ 回滚回读：属性 ${v.props}/${v.expected} 条复原（${v.rounds} 轮）${v.missing.length ? `，仍缺 ${v.missing.slice(0, 5).join(',')}` : ''}`);
        }
        rep.failed.forEach((f) => console.error(`  ✖ ${f.nodeId}: ${f.msg}`));
      }
      warnJavaNodesNeedCompile(nodes);
      return rep.failed.length ? 4 : 0;
    }
    case 'flow save': {
      if (!v.file || !v['process-id']) throw new RcError('E_VALIDATION', '需要 --file 与 --process-id');
      const explicitKind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const parsed = await readFlowFile(v.file, explicitKind);
      const kind = parsed.kind;
      const cat = new Catalog();
      requireEtlCatalog(cat, kind);
      const known = kind === 'etl' ? cat.etlNodeTypes() : cat.nodeTypes();
      const nodeProps = v.props
        ? (FLOW.normalizeNodeProps(await readJson(v.props)) ?? [])
        : (parsed.props ?? []);
      let issues = validateFlow(parsed.model, {
        knownTypes: known,
        allowMock: v['allow-mock'],
        nodeProps: FLOW.nodePropsMap(nodeProps),
        // 必填属性缺失默认阻断保存（平台 checkerror 不查这一项）。
        requiredFields: cat.requiredFields(kind),
        requiredLevel: requiredLevel(parsed.skeleton, v['allow-missing-required']),
      });
      // 平台本来就缺、本次也没补的必填项 → 沿用现状，只警告。
      issues = await relaxInheritedRequired(c, kind, v['process-id'], parsed.model, FLOW.nodePropsMap(nodeProps), issues);
      if (hasBlockingError(issues)) {
        issues.filter((i) => i.level === 'error').forEach((i) => console.error(`✖ [${i.code}] ${i.msg}`));
        return 4;
      }
      // 完整闭环：保存前快照 → 节点属性 upsert → 图保存 → 清理旧属性 → 平台校验 → 回读
      const report = await FLOW.saveFlowComplete(c, {
        appId: kind === 'etl' ? 'etl' : 'esb',
        processId: v['process-id'],
        // ETL 模型不接受 ESB 专有字段（translate / detailFlag）。
        model: kind === 'etl' ? { ...parsed.model, translate: undefined, detailFlag: undefined } : parsed.model,
        // 乐观并发保护：文件里带 fingerprint（来自 flow export）时，平台状态变了就拒绝写入。
        expectedFingerprint: v['expect-fingerprint'] ?? parsed.raw?.fingerprint,
        force: Boolean(v.force),
        nodeProps,
        kind,
        dryRun: !v.apply,
      });
      if (json) { console.log(JSON.stringify({ ...report, dryRun: isDryRun(report as any) }, null, 2)); return report.ok ? 0 : 4; }
      if (report.diff) console.log(`  变更预览：${report.diff.summary}`);
      if (report.diff && !report.diff.empty) console.log(FLOW_FORMAT_DIFF(report.diff));
      if (report.fingerprint?.expected && report.fingerprint.matched === false) {
        console.log(`  ✖ 指纹不匹配：期望 ${report.fingerprint.expected}，平台当前 ${report.fingerprint.actual}`);
      }
      if (report.snapshotFile) console.log(`  保存前快照：${report.snapshotFile}`);
      if (report.check) console.log(`${report.check.ok ? '✔' : '✖'} 平台校验：${report.check.msg}`);
      if (report.props) console.log(`  节点属性：新增 ${report.props.inserted.length} / 更新 ${report.props.updated.length} / 清理重复 ${report.props.deduped?.length ?? 0}`);
      if (report.pruned) console.log(`  清理旧属性：${report.pruned.removed.length}`);
      if (report.verified) console.log(`  回读：节点 ${report.verified.nodes} / 连线 ${report.verified.routers} / 属性齐全 ${report.verified.propsOk}`);
      if (report.rolledBack) console.log('  ↩ 已自动回滚到保存前快照');
      if (report.rollback?.verified) {
        const v = report.rollback.verified;
        console.log(`  ↩ 回滚回读：属性 ${v.props}/${v.expected} 条复原（${v.rounds} 轮）${v.missing.length ? `，仍缺 ${v.missing.slice(0, 5).join(',')}` : ''}`);
      }
      if (isDryRun(report as any)) {
        console.log(dryRunNotice((report as any).request, `保存流程 ${kind} processId=${v['process-id']}`));
        console.log(`   ${report.msg ?? ''}（加 --apply 才会真正写入）`);
      } else {
        console.log(report.ok ? '✔ 流程保存完成' : `✖ ${report.msg}`);
        if (report.ok) warnJavaNodesNeedCompile(nodeProps);
      }
      return report.ok ? 0 : 4;
    }
    case 'flow run': {
      // 真跑一次流程（会触发外部调用/写库）→ 必须 --apply
      if (!action) throw new RcError('E_VALIDATION', '需要 processId');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      if (!v.apply) {
        console.log(`【dry-run】未运行：会执行 ${kind} 流程 ${action}（POST ${kind === 'etl' ? '/rest/etl' : '/rest/esb'}/process/run；可用 --params '<json>' 传 ${'$'}.http 入参）；加 --apply 才会真的跑`);
        return 0;
      }
      let runParams: Record<string, unknown> | undefined;
      if (v.params) {
        try { runParams = JSON.parse(String(v.params)); }
        catch { throw new RcError('E_VALIDATION', '--params 需要合法 JSON，例如 \'{"shopName":"x","reportType":"y"}\''); }
      }
      const r = await FLOW.runFlow(c, action, { kind, params: runParams });
      const code = emit(r, json);
      const tid = (r.data?.data ?? r.data)?.transactionId;
      if (!json && tid) console.log(`  transactionId=${tid}（节点级记录：rc flow run-log ${tid}）`);
      return code;
    }
    case 'flow run-log': {
      // 一次运行的节点级记录：入参/出参/断言结果
      const tid = action ?? v['transaction-id'];
      if (!tid) throw new RcError('E_VALIDATION', '需要 transactionId（一次运行的 id）');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const res = await FLOW.runLog(c, String(tid), { kind });
      if (!res.ok) {
        if (json) console.log(JSON.stringify({ ok: false, msg: res.msg }, null, 2));
        else console.error(`✖ 读取运行记录失败：${res.msg ?? '未知原因'}`);
        return 4;
      }
      if (json) { console.log(JSON.stringify({ ok: true, transactionId: tid, nodes: res.nodes }, null, 2)); return 0; }
      if (!res.nodes.length) { console.log('这次运行没有节点记录'); return 0; }
      for (const n of res.nodes) {
        const cur = n?.currentStatus ?? n?.status ?? '';
        const indoc = n?.tmpIndoc?.indoc ?? n?.indoc;
        const out = n?.processResultDocs ?? n?.responseBody;
        console.log(`  ${String(n?.nodeId ?? n?.nodeName ?? '?').padEnd(10)} ${String(cur).padEnd(12)} ${truncate(String(indoc ?? ''), 60)}`);
        if (out) console.log(`      → ${truncate(JSON.stringify(out), 160)}`);
        if (n?.assertResult) console.log(`      断言：${truncate(JSON.stringify(n.assertResult), 120)}`);
      }
      return 0;
    }
    case 'flow schedule list': {
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const r = await FLOW.listScheduleRules(c, { pageNo: v.page ? Number(v.page) : 1, pageSize: v.size ? Number(v.size) : 50 });
      // /bpm 规则服务不可达（网关超时 / 平台内 connect timed out）时，从流程记录里读 expression
      const bpmDown = !r.ok && FLOW.isBpmServiceUnavailable(r);
      let rows: any[] = [];
      let via: 'bpm' | 'process' = 'bpm';
      if (bpmDown) {
        const alt = await FLOW.listScheduledFlows(c, { kind });
        if (!alt.ok) {
          console.error(`✖ BPM 规则服务不可用（${r.msg ?? r.httpStatus}），流程记录降级读取也失败：${alt.msg ?? ''}`);
          return 5;
        }
        rows = alt.rows;
        via = 'process';
      } else if (!r.ok) {
        return emit(r, json);
      } else {
        const d: any = r.data?.data ?? r.data;
        rows = Array.isArray(d) ? d : (d?.rows ?? []);
      }
      if (json) console.log(JSON.stringify({ ok: true, via, count: rows.length, rules: rows }, null, 2));
      else {
        console.log(`调度规则 ${rows.length} 条${via === 'process' ? '（BPM 规则服务不可用，读的是流程记录 expression）' : ''}`);
        rows.forEach((x: any) => console.log(`  ${String(x.id ?? '').padEnd(24)} ${String(x.name ?? '').padEnd(20)} ${x.processIds ?? ''} ${x.timeNumber ?? ''} ${x.cron ?? x.expression ?? ''}`));
        if (!rows.length) console.log('  （当前环境没有调度规则）');
      }
      return 0;
    }
    case 'flow schedule save': {
      const ids = v['process-ids'] ?? v['process-id'];
      if (!ids) throw new RcError('E_VALIDATION', '需要 --process-ids "id1,id2"（逗号分隔）');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const body = {
        processIds: String(ids),
        timeNumber: v['time-number'] ? Number(v['time-number']) : undefined,
        cron: v.cron ? String(v.cron) : undefined,
        name: v.name ? String(v.name) : undefined,
      };
      if (!v.apply) {
        console.log(`【dry-run】未创建调度规则：${JSON.stringify(body)}；加 --apply 才会真的建`);
        console.log('  BPM 规则路径建完还需要人工启用；若 BPM 服务不可用会自动降级为"写流程记录 + 启动调度"（建完即生效）');
        return 0;
      }
      const r = await FLOW.saveScheduleRule(c, body);
      if (r.ok) {
        console.log('✔ 调度规则已创建；平台的"启用"没有可用端点，请到平台上把它启用');
        return 0;
      }
      // BPM 规则服务不可达（网关超时 / 平台内 connect timed out / 5xx）→ 降级写流程记录的 expression
      const bpmDown = FLOW.isBpmServiceUnavailable(r);
      if (!bpmDown) { console.error(`✖ 创建失败：${r.msg ?? r.httpStatus}`); return 4; }
      if (!body.cron) {
        console.error(`✖ BPM 规则服务不可用（${r.msg ?? r.httpStatus}），降级路径需要 --cron 表达式`);
        return 4;
      }
      const alt = await FLOW.saveScheduleViaProcess(c, { processIds: body.processIds.split(','), cron: body.cron, kind });
      for (const x of alt.results) {
        if (x.ok) console.log(`✔ ${x.processId} 调度已写入流程记录并启动：cron=${body.cron}`);
        else console.error(`✖ ${x.processId} 降级失败：${x.msg ?? '未知原因'}`);
      }
      if (alt.ok) {
        console.log('  （BPM 规则服务不可用，已自动降级为流程记录表达式 + /process/start；无需人工启用）');
        return 0;
      }
      console.error(`✖ BPM 与流程记录两条路径都失败（BPM：${r.msg ?? r.httpStatus}）`);
      return 4;
    }
    case 'flow schedule delete': {
      if (!action) throw new RcError('E_VALIDATION', '需要规则 id');
      const r = await FLOW.deleteScheduleRule(c, action);
      return emit(r, json);
    }
    case 'flow versions': {
      if (!action) throw new RcError('E_VALIDATION', '需要 processId');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      return emit(await FLOW.listVersions(c, action, { kind }), json);
    }
    case 'flow restore-version': {
      if (!action) throw new RcError('E_VALIDATION', '需要 processId');
      const versionId = v['version-id'] ?? v.id;
      if (!versionId) throw new RcError('E_VALIDATION', '需要 --version-id');
      const kind: FLOW.FlowKind = v.kind === 'etl' ? 'etl' : 'esb';
      const r = await FLOW.restoreVersion(c, action, String(versionId), { dryRun: !v.apply, kind });
      if (!json && r.snapshotFile) console.log(`  恢复前快照：${r.snapshotFile}`);
      return emit(r, json);
    }

    // ---------- datasource ----------
    case 'datasource list': {
      const r = await DS.listDataSources(c, { pageNo: v.page ? Number(v.page) : 1, pageSize: v.size ? Number(v.size) : 50 });
      if (!r.ok) return emit(r, json);
      const rows = API.unwrapRows(r.data?.data ?? r.data);
      if (json) console.log(JSON.stringify({ ok: true, total: rows.length, rows: rows.map(DS.maskDataSource) }, null, 2));
      else {
        console.log(`共 ${rows.length} 个数据源`);
        rows.slice(0, 30).forEach((x: any) => console.log(
          `${String(x.id ?? '').padEnd(28)} ${String(x.configType ?? '').padEnd(10)} ${String(x.configName ?? '').padEnd(24)} ${x.state ?? ''}`));
      }
      return 0;
    }
    case 'datasource get': {
      if (!action) throw new RcError('E_VALIDATION', '需要数据源 id');
      await assertDatasourceId(c, action);
      const r = await DS.getDataSource(c, action);
      if (json) console.log(JSON.stringify(r, null, 2));
      else console.log(JSON.stringify(r.data, null, 2));
      return r.ok ? 0 : 4;
    }
    case 'datasource test': {
      if (!action) throw new RcError('E_VALIDATION', '需要数据源 id');
      await assertDatasourceId(c, action);
      const r = await DS.testDataSourceConnection(c, action);
      console.log(r.ok ? `✔ 连接成功（${r.latencyMs}ms）` : `✖ 连接失败：${r.msg}`);
      return r.ok ? 0 : 4;
    }
    case 'datasource save': {
      if (!v.file) throw new RcError('E_VALIDATION', '需要 --file（数据源配置 JSON）');
      const body = await readJson(v.file);
      const r = await DS.saveDataSource(c, body, { dryRun: !v.apply });
      if (r.ok && !v.apply) console.log('【dry-run】数据源配置已校验，加 --apply 落库');
      else if (isDryRun(r)) console.log(dryRunNotice(r, '保存数据源'));
      else if (r.ok) console.log('✔ 数据源已保存');
      else console.error(`✖ 保存失败：${r.msg}`);
      return r.ok ? 0 : 4;
    }

    // ---------- etl ----------
    case 'etl list': {
      const r = await ETL.listEtl(c, v.keyword);
      if (!r.ok) return emit(r, json);
      const rows = API.unwrapRows(r.data?.data ?? r.data);
      if (json) console.log(JSON.stringify({ ok: true, total: rows.length, note: ETL_LIST_NOTE, rows }, null, 2));
      else {
        console.log(`共 ${rows.length} 个 ETL 任务`);
        console.log(`⚠ ${ETL_LIST_NOTE}`);
        rows.slice(0, 30).forEach((x: any) => console.log(
          `${String(x.processId ?? x.id ?? '').padEnd(28)} ${String(x.processName ?? '').padEnd(28)} ${x.status ?? x.state ?? ''}`,
        ));
      }
      return 0;
    }
    case 'etl get': {
      if (!rest[0]) throw new RcError('E_VALIDATION', '需要 processId');
      return emit(await ETL.getEtl(c, rest[0]), json);
    }
    case 'etl run': {
      if (!rest[0]) throw new RcError('E_VALIDATION', '需要 processId');
      return emit(await ETL.runEtl(c, rest[0], {
        mode: v.mode === 'full' ? 'full' : 'test',
        limit: v.limit ? Number(v.limit) : undefined,
        dryRun: !v.apply,
      }), json);
    }
    case 'etl compensate-plan': {
      const plan = await planCompensation(c, {
        transactionIds: v.transaction,
        processId: v['process-id'] ?? rest[0],
        state: v.state,
      });
      if (json) console.log(JSON.stringify(plan, null, 2));
      else console.log(formatCompensationPlan(plan));
      return plan.ok ? 0 : 4;
    }
    case 'etl compensate': {
      const plan = await planCompensation(c, {
        transactionIds: v.transaction,
        processId: v['process-id'] ?? rest[0],
        state: v.state,
      });
      if (json && !v.apply) { console.log(JSON.stringify(plan, null, 2)); return plan.ok ? 0 : 4; }
      console.log(formatCompensationPlan(plan));
      if (!v.apply || v.plan) {
        console.log('\n[dry-run] 加 --apply 执行补偿；补偿单位是 transactionId（不是 processId）');
        return plan.ok ? 0 : 4;
      }
      const res = await executeCompensation(c, plan, { apply: true });
      if (res.report) {
        console.log(`\n补偿结果：成功 ${res.report.passed} / 失败 ${res.report.failed} / 停止=${res.report.stopped} / 回滚=${res.report.rolledBack}`);
        res.report.items.filter((x) => !x.ok).forEach((x) => console.log(`  ✖ ${x.id}: ${x.error ?? ''}`));
        return res.report.ok ? 0 : 4;
      }
      return 0;
    }

    // ---------- ops / monitor ----------
    case 'ops summary': {
      const s = await OPS.opsSummary(c);
      if (json) console.log(JSON.stringify(s, null, 2));
      else {
        console.log(`评估覆盖 API：${s.assessedApis}`);
        s.notes.forEach((n) => console.log(`⚠ ${n}`));
      }
      return 0;
    }
    case 'monitor summary': {
      const s = await MON.summary(c, Number(v.hours));
      if (json) console.log(JSON.stringify(s, null, 2));
      else {
        console.log(`近 ${s.hours}h：API ${s.apiCount ?? '?'} 个`);
        s.notes.forEach((n) => console.log(`⚠ ${n}`));
      }
      return 0;
    }
    case 'monitor logs': {
      if (!rest[0]) throw new RcError('E_VALIDATION', '需要 serviceId');
      return emit(await MON.serviceLogs(c, rest[0]), json);
    }

    // ---------- 工具型动词 ----------
    case 'snapshot': {
      const [kind, id] = [action, rest[0]];
      if (!kind || !id) throw new RcError('E_VALIDATION', '用法：rc snapshot <api|esb|etl> <id>');
      const r = await snapshot(c, kind as any, id, v.dir);
      console.log(`✔ 快照：${r.file}`);
      return 0;
    }
    case 'restore': {
      if (!action) throw new RcError('E_VALIDATION', '用法：rc restore <snapshot.json> [--apply]');
      if (!v.apply) {
        console.log(`[dry-run] 将回滚 ${action}`);
        return 0;
      }
      return emit(await restore(c, action), json);
    }
    case 'upload': {
      const [path, local] = [action, v.file];
      if (!path || !local) throw new RcError('E_VALIDATION', '用法：rc upload <path> --file <local>');
      const r = await uploadFile(c, path, local, { field: v.field, dryRun: !v.apply });
      console.log(r.dryRun ? `[dry-run] ${r.msg}` : `${r.ok ? '✔' : '✖'} ${r.status} ${r.msg ?? ''}`);
      return r.ok ? 0 : 4;
    }
    case 'call form': {
      if (!action?.startsWith('/')) throw new RcError('E_VALIDATION', '路径必须以 / 开头');
      const fields: Record<string, string> = {};
      for (const kv of String(v.form ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
        const i = kv.indexOf('=');
        if (i > 0) fields[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      }
      if (!Object.keys(fields).length) throw new RcError('E_VALIDATION', '需要 --form k=v,k2=v2');
      const body = new URLSearchParams(fields).toString();
      const r = await c.request(action, {
        method: 'POST',
        body,
        headers: { 'Content-Type': v['content-type'] ?? 'application/x-www-form-urlencoded' },
        dryRun: !v.apply,
      });
      return emit(r, json);
    }
    case 'call': {
      if (!action?.startsWith('/')) throw new RcError('E_VALIDATION', '路径必须以 / 开头');
      let body: unknown;
      if (v.d) body = JSON.parse(v.d.startsWith('@') ? await readFile(v.d.slice(1), 'utf8') : v.d);
      const method = String(v.X).toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE';
      return emit(await c.request(action, { method, body, dryRun: method !== 'GET' && !v.apply }), json);
    }

    default:
      console.error(`未知命令：${[group, action].filter(Boolean).join(' ')}\n`);
      console.log(renderTopHelp(RC_HELP));
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    if (e instanceof RcError) { console.error(e.toUserMessage()); process.exit(e.exitCode); }
    console.error(e?.message ?? e);
    process.exit(2);
  });
