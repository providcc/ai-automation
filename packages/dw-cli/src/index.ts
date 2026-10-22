#!/usr/bin/env node
/**
 * L1 执行层：dw CLI（Apache Doris 数仓运维）
 * 契约：docs/DW-COMMAND-REFERENCE.md；Agent SOP：skills/dw-ops/SKILL.md
 * 零外部依赖（node:util parseArgs），可直接以 --experimental-strip-types 运行。
 *
 * 三条纪律（贯穿全部命令）：
 *   1. **只读默认**：查询走只读闸门；写操作一律 dry-run，需显式 `--apply`。
 *   2. **输出默认脱敏**：结果列、DDL 字面量、host 全部打码，`--raw` / `--reveal-host` 才回原值。
 *   3. **代码里没有具体主机/库/MV 名**：一律来自配置或运行时发现。
 */
import { parseArgs } from 'node:util';
import { findCommand, renderCommandHelp, renderTopHelp } from '../../core/src/cli-help.ts';
import { DW_HELP } from './help.ts';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RcError } from '../../core/src/errors.ts';
import {
  configFilePath,
  credentialsFilePath,
  describeWarehouseEnv,
  loadWarehouseConfig,
  maskHost,
  resolveWarehouseEnv,
  warehouseHome,
  type ResolvedWarehouseEnv,
} from '../../core/src/dw/config.ts';
import { connect, createTransport } from '../../core/src/dw/connect.ts';
import { tunnelDown, tunnelStatus, tunnelUp } from '../../core/src/dw/tunnel.ts';
import { assertReadOnlyQuery, queryWarehouse } from '../../core/src/dw/query.ts';
import {
  isHealthy,
  listDatabases,
  listMvInfos,
  listMvInfosAllDbs,
  listMvTasks,
  quoteIdent,
  showMvDefinition,
  sqlMvManual,
  sqlMvSchedule,
  sqlRefreshMv,
  runWrite,
} from '../../core/src/dw/mv.ts';
import type { MvInfo } from '../../core/src/dw/mv.ts';
import {
  analyzeStagger,
  collectPhases,
  durationsFromTasks,
  suggestStagger,
} from '../../core/src/dw/stagger.ts';
import { analyzeRefreshMode } from '../../core/src/dw/refresh-mode.ts';
import {
  buildGraphFromDdls,
  buildMvGraph,
  downstreamOf,
  executeMvSwap,
  hasBlockingFinding,
  lintMvDdl,
  onCommitRisk,
  planMvSwap,
  scanMvDrift,
  sqlReplaceWithSwap,
  swapTookEffect,
  verifySwapPhase,
} from '../../core/src/dw/swap.ts';
import { executeRolloff, listPartitions, planRolloff } from '../../core/src/dw/partition.ts';
import { analyzeBuckets, analyzeReplicaSkew, listTablets, replicaDistribution } from '../../core/src/dw/tablet.ts';
import {
  diagnoseMvRewrite,
  diffProfiles,
  getProfileText,
  listQueryStats,
  queryHistory,
} from '../../core/src/dw/profile.ts';
import { runWarehouseDoctor } from '../../core/src/dw/doctor.ts';
import { auditDwWrite } from '../../core/src/dw/audit.ts';

const VERSION = '0.5.0';

const OPTIONS = {
  env: { type: 'string' },
  db: { type: 'string' },
  json: { type: 'boolean', default: false },
  apply: { type: 'boolean', default: false },
  raw: { type: 'boolean', default: false },
  'reveal-host': { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  fix: { type: 'boolean', default: false },
  'max-rows': { type: 'string' },
  timeout: { type: 'string' },
  hours: { type: 'string' },
  limit: { type: 'string' },
  'min-ms': { type: 'string' },
  failed: { type: 'boolean', default: false },
  days: { type: 'string' },
  mv: { type: 'string' },
  complete: { type: 'boolean', default: false },
  every: { type: 'string' },
  unit: { type: 'string' },
  starts: { type: 'string' },
  expect: { type: 'string' },
  file: { type: 'string' },
  target: { type: 'string' },
  source: { type: 'string' },
  dir: { type: 'string' },
  depth: { type: 'string' },
  keep: { type: 'string' },
  'max-drop': { type: 'string' },
  partition: { type: 'string' },
  detail: { type: 'boolean', default: false },
  abnormal: { type: 'boolean', default: false },
  all: { type: 'boolean', default: false },
  'all-db': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
  readonly: { type: 'boolean', default: false },
} as const;

// ─────────────────────────── 小工具 ───────────────────────────

type Vals = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return v === undefined || v === null || v === '' ? undefined : String(v);
}
function int(v: unknown, fallback?: number): number | undefined {
  const s = str(v);
  if (s === undefined) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new RcError('E_VALIDATION', `需要数字，收到 ${s}`);
  return n;
}

/**
 * 带范围校验的整数参数。
 *
 * 原来只有"是不是数字"这一层，于是 `--hours -1`、`--limit 0`、`--depth -1`
 * 会被原样送进 SQL：拿到的是**语义完全不同**的查询（负数区间 / `LIMIT 0`），
 * 而输出看起来只是"没有数据"——比报错难查得多。范围检查在参数入口做，一次做完。
 */
function intRange(
  v: unknown,
  name: string,
  opts: { min: number; max?: number; fallback?: number },
): number | undefined {
  const n = int(v, opts.fallback);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < opts.min || (opts.max !== undefined && n > opts.max)) {
    const range = opts.max === undefined ? `≥ ${opts.min}` : `${opts.min} ~ ${opts.max}`;
    throw new RcError('E_VALIDATION', `--${name} 需要 ${range} 的整数，收到 ${n}`);
  }
  return n;
}

/** 数值参数的合法范围（在 main 里统一校验，见那里的注释）。 */
const NUM_RANGES: Record<string, { min: number; max?: number }> = {
  timeout: { min: 1, max: 3_600_000 },
  hours: { min: 1, max: 8760 },
  limit: { min: 1, max: 100_000 },
  'max-rows': { min: 1, max: 1_000_000 },
  'min-ms': { min: 0, max: 86_400_000 },
  days: { min: 1, max: 3650 },
  depth: { min: 0, max: 1000 },
  every: { min: 1, max: 10_000 },
  keep: { min: 1, max: 10_000 },
  'max-drop': { min: 1, max: 100_000 },
};

function bool(v: unknown): boolean {
  return Boolean(v);
}

/**
 * 解析生效环境。`--db` 覆盖库上下文（不改配置文件）。
 *
 * `--readonly` 是**显式只读**：把它喂给 `resolveWarehouseEnv` 而不是在这里另判一次，
 * 保证"只读"仍然只有一个判断点（`env.readonly`）。文档承诺过这个 flag，之前没接上——
 * 结果是照文档写命令的人拿到的是退出码 2（未知参数），而不是一个被拒的写操作。
 */
function resolveEnv(v: Vals): ResolvedWarehouseEnv {
  const env = resolveWarehouseEnv({ name: str(v.env), readonly: bool(v.readonly) ? true : undefined });
  const db = str(v.db);
  if (db) env.database = db;
  return env;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

/** 环境摘要行，给每个连接类命令做前置输出。 */
function envLine(env: ResolvedWarehouseEnv): string {
  const t = env.tunnel?.enabled ? `，隧道 ${env.tunnel.forwards.map((f) => f.local).join('/')}` : '，直连';
  return `环境 ${env.name}（${maskHost(env.host)}:${env.httpPort}，库 ${env.database ?? '-'}${t}）`;
}

/** 写操作统一收口：dry-run 提示 + 审计 + 退出码。 */
async function writeAndReport(  env: ResolvedWarehouseEnv,
  action: string,
  target: string,
  sql: string,
  opts: { apply?: boolean; readonly?: boolean; timeoutMs?: number; json?: boolean; note?: string },
): Promise<number> {
  const dryRun = !opts.apply;
  if (!opts.json) {
    console.log(`${dryRun ? '【dry-run】' : '执行'} ${action} ${target}`);
    console.log(`  SQL: ${sql}`);
    if (opts.note) console.log(`  ${opts.note}`);
  }
  let ok = true;
  let msg: string | undefined;
  try {
    const out = await runWrite(createTransport(env), sql, {
      apply: opts.apply,
      readonly: opts.readonly,
      timeoutMs: opts.timeoutMs,
    });
    msg = out.msg;
  } catch (e) {
    ok = false;
    msg = (e as Error).message;
    await auditDwWrite({ env: env.name, host: maskHost(env.host), action, target, ok: false, dryRun, sql, msg });
    throw e;
  }
  await auditDwWrite({ env: env.name, host: maskHost(env.host), action, target, ok, dryRun, sql, msg });
  if (opts.json) printJson({ ok, action, target, dryRun, sql, msg });
  else console.log(dryRun ? '  （加 --apply 才会真正执行）' : `✔ ${action} 已提交${msg ? `：${msg}` : ''}`);
  return 0;
}

/**
 * 多步写操作（换名 / 回收分区）+ 审计：**失败也必须留痕**。
 *
 * 原来的写法是 `await execute…()` 之后无条件 `ok: true`——异常直接抛出，
 * 根本走不到审计那行。于是"换名失败（而且可能已经改了一半）"在审计里完全查不到，
 * 事后既不知道谁动过、也不知道动到哪一步。审计是合规前提，**失败留痕比成功留痕更重要**。
 *
 * 错误信息里可能带出 FE 地址，所以落审计前先把 host 换成打码形态。
 */
async function auditedWrite<T>(
  env: ResolvedWarehouseEnv,
  base: { action: string; target: string; dryRun: boolean; msg?: string; extra?: Record<string, unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  const scrubHost = (s: string) => (env.host ? s.split(env.host).join(maskHost(env.host)) : s);
  try {
    const out = await fn();
    await auditDwWrite({ env: env.name, host: maskHost(env.host), ...base, ok: true });
    return out;
  } catch (e) {
    await auditDwWrite({
      env: env.name,
      host: maskHost(env.host),
      ...base,
      ok: false,
      msg: `失败：${scrubHost((e as Error).message ?? String(e))}`,
    });
    throw e;
  }
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main(argv: string[]): Promise<number> {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS as never }));
  } catch (e: any) {
    // parseArgs 是 strict 的：未声明的 flag / 缺参数都会抛。**不要把它抛给用户**——
    // Node 的原文既不是我们的口径，退出码也落在"未捕获异常"的 2 上。
    // 统一成参数错误（4）并指路 --help（rc 侧早已这么做，dw 这里原来漏了）。
    const why = String(e?.message ?? e).split(/\s*\.\s+To specify/)[0].trim();
    throw new RcError('E_VALIDATION', `参数解析失败：${why}`, {
      hint: `运行 dw --help 看全部命令，或 dw <命令> --help 看该命令的用法`,
    });
  }
  const v = values as Vals;
  // 数值参数**在任何命令之前**统一校验。
  // 顺序很要紧：写在各命令里的话，没配环境时用户先看到"没有可用的数仓环境"，
  // 而真正的问题是 `--hours=-1`——报错指错方向比不报还费时间。
  for (const [name, range] of Object.entries(NUM_RANGES)) {
    if (str(v[name]) !== undefined) intRange(v[name], name, range);
  }
  if (bool(v.version)) {
    console.log(VERSION);
    return 0;
  }
  // `--help` 分两级：`dw mv refresh --help` 给该命令的用法/选项/坑；
  // 只写 `dw --help`（或什么都不写）才给顶层清单。
  if (bool(v.help)) {
    const c = findCommand(DW_HELP, positionals);
    console.log(c ? renderCommandHelp(DW_HELP, c) : renderTopHelp(DW_HELP));
    return 0;
  }
  if (positionals.length === 0) {
    console.log(renderTopHelp(DW_HELP));
    return 0;
  }
  const json = bool(v.json);
  const raw = bool(v.raw);
  const apply = bool(v.apply);
  const timeoutMs = intRange(v.timeout, 'timeout', { min: 1, max: 3_600_000 });

  const SINGLE_VERBS = new Set(['query', 'explain', 'doctor', 'tablet']);
  const [group, verb, ...tail] = positionals;
  let command: string;
  let action: string | undefined;
  if (SINGLE_VERBS.has(group)) {
    command = group;
    action = verb;
  } else {
    command = `${group} ${verb ?? ''}`.trim();
    action = tail[0];
  }

  switch (command) {
    // ---------- env ----------
    case 'env list': {
      const cfg = loadWarehouseConfig();
      const names = Object.keys(cfg.environments ?? {});
      const rows = names.map((n) => {
        const e = cfg.environments![n];
        return {
          name: n,
          host: maskHost(e.host),
          httpPort: e.httpPort ?? 8030,
          database: e.database,
          transport: e.transport ?? (e.cmd ? 'cmd' : 'http'),
          tunnel: Boolean(e.tunnel?.enabled),
          readonly: Boolean(e.readonly),
          default: cfg.default_env === n,
        };
      });
      const fromVar = Boolean(process.env.DW_TARGETS);
      if (json) {
        printJson({ ok: true, configFile: configFilePath(), credentialsFile: credentialsFilePath(), fromEnvVar: fromVar, default_env: cfg.default_env, environments: rows });
        return 0;
      }
      console.log(`配置：${configFilePath()}${fromVar ? '（DW_TARGETS 覆盖中）' : ''}`);
      console.log(`凭据：${credentialsFilePath()}`);
      if (!rows.length) {
        console.log('\n没有配置任何环境。任选其一：');
        console.log('  1) 设 DW_HOST / DW_USER / DW_PASS 环境变量');
        console.log(`  2) 写 ${configFilePath()}，格式见 docs/DW-COMMAND-REFERENCE.md`);
        return 0;
      }
      console.log(`\n默认环境：${cfg.default_env ?? '(未设，需 --env 指定)'}`);
      for (const r of rows) {
        console.log(
          `  ${r.default ? '*' : ' '} ${r.name.padEnd(14)} ${r.host.padEnd(18)} :${r.httpPort}  库=${r.database ?? '-'}  ` +
            `${r.transport}${r.tunnel ? ' +隧道' : ''}${r.readonly ? ' [只读]' : ''}`,
        );
      }
      return 0;
    }
    case 'env show': {
      const env = resolveEnv(v);
      const desc = describeWarehouseEnv(env, { revealHost: bool(v['reveal-host']) });
      if (json) {
        printJson({ ok: true, ...desc });
        return 0;
      }
      console.log(envLine(env));
      for (const [k, val] of Object.entries(desc)) {
        if (k === 'name') continue;
        if (val === undefined) continue;
        console.log(`  ${k}: ${typeof val === 'object' ? JSON.stringify(val) : String(val)}`);
      }
      if (!env.password) console.log('  ⚠ 未配置密码（FE 通常要求 Basic 认证）');
      return 0;
    }

    // ---------- tunnel ----------
    case 'tunnel status':
    case 'tunnel up':
    case 'tunnel down': {
      const env = resolveEnv(v);
      if (!env.tunnel?.enabled) {
        console.log(`环境 ${env.name} 未启用隧道（直连 ${maskHost(env.host)}）`);
        return 0;
      }
      if (command === 'tunnel up') {
        const r = await tunnelUp(env.tunnel, undefined, { force: bool(v.force) });
        if (json) printJson({ ok: r.ok, message: r.message, status: r.status });
        else console.log(`✔ ${r.message}`);
        return 0;
      }
      if (command === 'tunnel down') {
        const r = await tunnelDown(env.tunnel);
        if (json) {
          printJson({ ok: true, killed: r.killed, stillListening: r.stillListening });
          return 0;
        }
        if (r.killed.length) console.log(`✔ 已停隧道（pid ${r.killed.join(', ')}）`);
        else console.log('没有匹配的隧道进程（这条隧道不是 dw 起的）');
        // 关键：端口还通却"没杀到进程"= 被别的进程占着。不说清楚的话，
        // 用户会以为端口空着、接着去 up，然后撞端口。
        if (r.stillListening.length) {
          console.log(
            `  ⚠ 本地端口 ${r.stillListening.join('、')} 仍在监听，但不归本工具管——` +
              '有别的进程（手工 ssh / 其它工具）占着它。',
          );
          console.log(`    看是谁：lsof -nP -iTCP:${r.stillListening[0]} -sTCP:LISTEN`);
        }
        return 0;
      }
      const st = await tunnelStatus(env.tunnel);
      if (json) {
        printJson({ ok: true, ...st });
        return 0;
      }
      // "进程 0 个"本身没有意义，要翻译成"谁在提供这条隧道"
      const ownerText =
        st.owner === 'tool' ? `进程 ${st.pids.length} 个（dw 起的）`
          : st.owner === 'foreign' ? '不是 dw 起的（dw tunnel down 关不掉它）'
            : '未建立';
      console.log(`隧道：${st.up ? '✔ 通' : '✖ 不通'}（${ownerText}）`);
      for (const f of st.forwards) {
        console.log(`  ${f.listening ? '✔' : '✖'} ${f.forward.local} → ${f.forward.remoteHost}:${f.forward.remotePort}`);
      }
      if (st.hint) console.log(`  ⚠ ${st.hint}`);
      return st.up ? 0 : 5;
    }

    // ---------- doctor ----------
    case 'doctor': {
      const env = resolveEnv(v);
      const report = await runWarehouseDoctor(env, { fix: bool(v.fix) });
      if (json) {
        printJson(report);
        return report.ok ? 0 : 5;
      }
      console.log(`数仓体检：${env.name}\n`);
      const icon = { ok: '✔', warn: '⚠', fail: '✖', skip: '·' } as const;
      for (const c of report.checks) {
        console.log(`${icon[c.status]} ${c.name.padEnd(12)} ${c.detail ?? ''}`);
        if (c.hint) console.log(`  ${' '.repeat(13)}↳ ${c.hint}`);
      }
      console.log(`\n${report.ok ? '✔ 全部通过' : '✖ 有阻断项，见上面的 ✖'}`);
      return report.ok ? 0 : 5;
    }

    // ---------- query / explain ----------
    case 'query': {
      if (!action) throw new RcError('E_VALIDATION', '用法：dw query "<sql>"');
      // **闸门放在解析环境之前**：顺序反了的话，没配环境时用户先看到"没有可用环境"，
      // 而不是"这条 SQL 被拒"——既误导，又让安全判定发生在连接建立之后。
      assertReadOnlyQuery(action);
      const env = resolveEnv(v);
      const out = await queryWarehouse(createTransport(env), action, {
        maxRows: intRange(v['max-rows'], 'max-rows', { min: 1, max: 1_000_000, fallback: 500 }),
        raw,
        timeoutMs,
      });
      if (json) {
        printJson({ ok: out.ok, columns: out.columns, rows: out.rows, truncated: out.truncated, maskedColumns: out.maskedColumns, limitInjected: out.limitInjected, execTimeMs: out.execTimeMs });
        return 0;
      }
      if (!out.rows.length) {
        console.log('(0 行)');
        return 0;
      }
      console.log(out.columns.join('\t'));
      for (const r of out.rows) console.log(out.columns.map((c) => fmtCell(r[c])).join('\t'));
      const notes = [
        `${out.rows.length} 行`,
        out.truncated ? '已截断' : '',
        out.limitInjected ? '已自动补 LIMIT' : '',
        out.maskedColumns.length ? `脱敏列：${out.maskedColumns.join(',')}` : '',
        out.execTimeMs ? `${out.execTimeMs}ms` : '',
      ].filter(Boolean);
      console.log(`\n(${notes.join('；')})`);
      return 0;
    }
    case 'explain': {
      if (!action) throw new RcError('E_VALIDATION', '用法：dw explain "<sql>"');
      // 同样先过闸门：EXPLAIN 包的是**内层语句**，所以判的是 action 本身。
      assertReadOnlyQuery(action);
      const env = resolveEnv(v);
      const out = await queryWarehouse(createTransport(env), `EXPLAIN ${action}`, { maxRows: 2000, raw: true, timeoutMs });
      const text = out.rows.map((r) => String(Object.values(r)[0] ?? '')).join('\n');
      const diag = diagnoseMvRewrite(text);
      if (json) {
        printJson({ ok: true, ...diag, explain: text });
        return 0;
      }
      console.log(text);
      console.log(`\nMV 改写：${diag.rewritten ? '✔ 命中' : diag.mentioned ? '✖ 未命中（CBO 看到了但没用）' : '· 未提及物化视图'}`);
      if (diag.reasons.length) diag.reasons.forEach((r) => console.log(`  ✖ ${r}`));
      if (diag.hint) console.log(`  ↳ ${diag.hint}`);
      return 0;
    }

    // ---------- mv（只读） ----------
    case 'mv list': {
      const env = resolveEnv(v);
      const transport = createTransport(env);
      // `--all-db`：库上下文没配时也能用，而且一次看全（异常 MV 常在别的库）
      let infos: MvInfo[];
      let failed: { database: string; reason: string }[] = [];
      if (bool(v['all-db'])) {
        const r = await listMvInfosAllDbs(transport, { timeoutMs });
        infos = r.infos;
        failed = r.failed;
      } else {
        infos = await listMvInfos(transport, await requireDb(env, timeoutMs), { timeoutMs });
      }
      const rows = bool(v.abnormal) ? infos.filter((m) => !isHealthy(m)) : infos;
      if (json) {
        printJson({ ok: true, count: rows.length, views: rows, failedDbs: failed });
        return 0;
      }
      if (!rows.length) {
        console.log(bool(v.abnormal) ? '✔ 没有异常物化视图' : '该库没有物化视图');
        for (const f of failed) console.log(`  ⚠ 库 ${f.database} 读不到：${f.reason}`);
        return 0;
      }
      const showDb = bool(v['all-db']);
      const head = showDb ? `${'库'.padEnd(22)} ` : '';
      console.log(`${head}${'名称'.padEnd(46)} ${'State'.padEnd(16)} RefreshState`);
      for (const m of rows) {
        const flag = isHealthy(m) ? ' ' : '✖';
        const dbCol = showDb ? `${String(m.database ?? '-').padEnd(22)} ` : '';
        console.log(`${flag}${dbCol}${m.name.padEnd(45)} ${String(m.state ?? '-').padEnd(16)} ${m.refreshState ?? '-'}`);
        if (m.errorMsg) console.log(`    ↳ ${String(m.errorMsg).slice(0, 160)}`);
      }
      const bad = infos.filter((m) => !isHealthy(m)).length;
      console.log(`\n共 ${infos.length} 张，异常 ${bad} 张（State≠NORMAL 或 RefreshState≠SUCCESS）`);
      // 读不到的库要显式列出：静默跳过会把"某库有异常 MV"漏报成"没有"
      for (const f of failed) console.log(`  ⚠ 库 ${f.database} 读不到，未纳入统计：${f.reason}`);
      return 0;
    }
    case 'mv tasks': {
      const env = resolveEnv(v);
      const tasks = await listMvTasks(createTransport(env), {
        mvName: str(v.mv),
        hours: intRange(v.hours, 'hours', { min: 1, max: 8760, fallback: 24 }),
        limit: intRange(v.limit, 'limit', { min: 1, max: 100_000, fallback: 200 }),
        timeoutMs,
      });
      if (json) {
        printJson({ ok: true, count: tasks.length, tasks });
        return 0;
      }
      if (!tasks.length) {
        console.log(`近 ${intRange(v.hours, 'hours', { min: 1, max: 8760, fallback: 24 })}h 没有 MV 任务记录`);
        return 0;
      }
      console.log(`${'MV'.padEnd(46)} ${'创建时刻'.padEnd(20)} ${'状态'.padEnd(9)} ${'方式'.padEnd(12)} 耗时`);
      for (const t of tasks) {
        const mode = t.refreshMode ?? '-';
        const need = t.needRefreshPartitions?.length;
        console.log(
          `${t.mvName.padEnd(45)} ${String(t.createTime ?? '-').padEnd(20)} ${String(t.status ?? '-').padEnd(9)} ` +
            `${(need === undefined ? mode : `${mode}(${need})`).padEnd(12)} ` +
            `${t.durationSec === undefined ? '-' : `${t.durationSec}s`}`,
        );
        if (t.errorMsg) console.log(`    ↳ ${String(t.errorMsg).slice(0, 160)}`);
      }
      console.log(
        '\n注：真实刷新相位与耗时只信 tasks()——RefreshInfo 里没有 STARTS 不等于整点锚点。\n' +
          '    方式列括号里是本次判脏的分区数：PARTIAL 通常几条；COMPLETE 且条数≈全分区数即"脏集==全分区"→ 只能全刷（dw mv refresh-mode 细看）。',
      );
      return 0;
    }
    case 'mv show': {
      if (!action) throw new RcError('E_VALIDATION', '用法：dw mv show <mv> [--raw]');
      const env = resolveEnv(v);
      const r = await showMvDefinition(createTransport(env), action, { raw, timeoutMs });
      if (json) {
        printJson({ ok: true, name: r.name, masked: r.masked, ddl: r.ddl });
        return 0;
      }
      console.log(r.ddl);
      if (r.masked) console.log(`\n(已脱敏 ${r.masked} 处连接属性；--raw 回原值)`);
      return 0;
    }
    case 'mv phases': {
      const env = resolveEnv(v);
      const db = await requireDb(env, timeoutMs);
      const transport = createTransport(env);
      const infos = await listMvInfos(transport, db, { timeoutMs });
      const items: { name: string; ddl: string }[] = [];
      // 单张 DDL 读不到不影响其它 MV 的分析，但**必须记下来**：
      // 缺了 DDL 的那张既进不了相位表，也进不了依赖图——而依赖图正是判"依赖倒置"的唯一依据。
      // 静默跳过会让漏报伪装成"✔ 未发现"。
      const skipped: { name: string; reason: string }[] = [];
      for (const m of infos) {
        try {
          items.push({ name: m.name, ddl: (await showMvDefinition(transport, m.name, { timeoutMs })).ddl });
        } catch (e) {
          skipped.push({ name: m.name, reason: (e as Error).message });
        }
      }
      const { slots, unphased } = collectPhases(items);
      // 相位体检要用两条真实证据：依赖图（判倒置）与实测耗时（判撞车）
      const graph = buildGraphFromDdls(items);
      // tasks() 读不到时 durations 为空 → 撞车/零间隔这类**基于耗时的判定整个失效**。
      // 记下原因，别让"没检出问题"被当成"没有问题"。
      let tasksError: string | undefined;
      const tasks = await listMvTasks(transport, { hours: intRange(v.hours, 'hours', { min: 1, max: 8760, fallback: 24 }), limit: 1000, timeoutMs }).catch((e) => {
        tasksError = (e as Error).message;
        return [];
      });
      const durations = durationsFromTasks(tasks);
      const findings = analyzeStagger(slots, { graph, durations });
      const suggestions = suggestStagger(slots);
      const incomplete = skipped.length > 0 || tasksError !== undefined;
      if (json) {
        printJson({
          ok: true,
          slots,
          unphased,
          findings,
          suggestions,
          durations: Object.fromEntries(durations),
          incomplete: { skippedMvs: skipped, tasksError: tasksError ?? null },
        });
        return incomplete || findings.some((f) => f.level === 'error') ? 4 : 0;
      }
      console.log(`相位分布（${slots.length} 张有固定相位，${unphased.length} 张无）\n`);
      for (const s of [...slots].sort((a, b) => a.hour - b.hour || a.minute - b.minute)) {
        console.log(`  ${s.timeOfDay}  ${(s.name + (s.unit ? `  [${s.every ?? ''}${s.unit}]` : '')).padEnd(56)} ${s.build ?? ''}`);
      }
      if (unphased.length) {
        console.log('\n无固定相位：');
        unphased.forEach((u) => console.log(`  · ${u.name.padEnd(56)} ${u.reason}`));
      }
      if (findings.length) {
        console.log('\n体检：');
        for (const f of findings) {
          console.log(`  ${f.level === 'error' ? '✖' : f.level === 'warn' ? '⚠' : '·'} [${f.code}] ${f.message}`);
          if (f.hint) console.log(`      ↳ ${f.hint}`);
        }
      }
      // "未发现问题"这句话只有在**数据完整**时才敢说
      if (!findings.length) {
        console.log(incomplete ? '\n· 在数据不完整的前提下未发现问题（见下方缺口）' : '\n✔ 未发现零间隔、分钟位拥挤或依赖倒置');
      }
      if (incomplete) {
        console.log('\n⚠ 本次体检数据不完整，上面的"未发现"可能漏报：');
        for (const s of skipped) console.log(`  · 读不到 ${s.name} 的 DDL：${s.reason}`);
        if (tasksError) console.log(`  · 读不到刷新任务（tasks），基于耗时的撞车/零间隔判定已失效：${tasksError}`);
      }
      if (suggestions.length) {
        console.log('\n重排建议（仅建议，需人工确认后再改）：');
        for (const s of suggestions) console.log(`  ${s.name}：${s.from} → ${s.to}（${s.reason}）`);
      }
      return incomplete || findings.some((f) => f.level === 'error') ? 4 : 0;
    }
    case 'mv lineage': {
      if (!action) throw new RcError('E_VALIDATION', '用法：dw mv lineage <mv> [--depth N]');
      const env = resolveEnv(v);
      const db = await requireDb(env, timeoutMs);
      const transport = createTransport(env);
      const { graph, unreadable } = await buildMvGraph(transport, db, { timeoutMs: timeoutMs ?? 60_000 });
      if (!graph.has(action)) {
        throw new RcError('E_VALIDATION', `${action} 不在 ${db} 的物化视图清单里（dw mv list 可查）`);
      }
      const downstream = downstreamOf(action, graph);
      const risk = await onCommitRisk(transport, action, graph, { timeoutMs });
      // 读不到 DDL 的 MV 不在图里 → 下游清单可能变短 → 高危清单可能不全。
      // 两处缺口合并汇报（按名字去重）。
      const blind = [...new Map([...unreadable, ...risk.unreadable].map((u) => [u.name, u])).values()];
      const reads = graph.get(action)?.reads ?? [];
      const depth = intRange(v.depth, 'depth', { min: 0, max: 1000 });
      const shown = depth === undefined ? downstream : downstream.slice(0, depth);
      if (json) {
        printJson({
          ok: true,
          mv: action,
          reads,
          downstream: shown,
          downstreamTotal: downstream.length,
          onCommit: risk.onCommit,
          blindSpots: blind,
        });
        return 0;
      }
      console.log(`${action}（库 ${db}）`);
      console.log(`\n读：${reads.length ? reads.join('、') : '(无同库 MV 依赖)'}`);
      console.log(`\n被读（下游 ${downstream.length} 张）：${shown.length ? shown.join('、') : '(无)'}`);
      if (depth !== undefined && downstream.length > shown.length) console.log(`  （--depth ${depth} 截断）`);
      if (risk.onCommit.length) {
        console.log(`\n⚠ ON COMMIT 下游（${risk.onCommit.length} 张）：${risk.onCommit.join('、')}`);
        console.log('  换基表后它们**不会自愈**：SCHEMA_CHANGE 下基表提交触发器不点火，');
        console.log('  而清 SCHEMA_CHANGE 又必须刷一次——死锁。必须手动 REFRESH ... COMPLETE。');
      } else {
        // "没有 ON COMMIT 下游"只有在**全部读到**时才敢下结论
        console.log(
          blind.length
            ? '\n· 已读到的下游里没有 ON COMMIT 的（但有 DDL 读不到，见下方盲区）'
            : '\n✔ 下游中没有 ON COMMIT 的（换基表后都会自愈）',
        );
      }
      if (blind.length) {
        console.log(`\n⚠ 盲区（${blind.length} 张 DDL 读不到，下游与 ON COMMIT 清单可能不全）：`);
        for (const b of blind) console.log(`  · ${b.name}：${b.reason}`);
      }
      // 有盲区就是"这份血缘没查全"——退出 0 会让 CI 把它当成"已确认无风险"
      return blind.length ? 4 : 0;
    }
    case 'mv drift': {
      const env = resolveEnv(v);
      const db = await requireDb(env, timeoutMs);
      const dir = str(v.dir) ?? join('mv_ddl', db);
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
      } catch (e) {
        throw new RcError('E_VALIDATION', `读不到目录 ${dir}：${(e as Error).message}。用 --dir 指定仓库 DDL 目录。`);
      }
      if (!files.length) throw new RcError('E_VALIDATION', `${dir} 下没有 .sql 文件`);
      const items = await Promise.all(
        files.map(async (f) => ({ name: f.replace(/\.sql$/, ''), ddl: await readFile(join(dir, f), 'utf8') })),
      );
      const entries = await scanMvDrift(createTransport(env), items, {
        timeoutMs,
        onProgress: (i, total, name) => {
          if (!json && process.stderr.isTTY) process.stderr.write(`\r扫描 ${i}/${total} ${name}          `);
        },
      });
      if (!json && process.stderr.isTTY) process.stderr.write('\r');
      const drift = entries.filter((e) => e.status === 'drift');
      const propsOnly = entries.filter((e) => e.status === 'props-only');
      const phaseOnly = entries.filter((e) => e.status === 'phase-only');
      const missing = entries.filter((e) => e.status === 'missing-live');
      const errors = entries.filter((e) => e.status === 'error');
      if (json) {
        printJson({
          ok: true,
          dir,
          total: entries.length,
          drift: drift.length,
          phaseOnly: phaseOnly.length,
          propsOnly: propsOnly.length,
          missingLive: missing.length,
          error: errors.length,
          entries,
        });
        return drift.length || missing.length ? 4 : 0;
      }
      console.log(`比对 ${dir} ↔ ${db} 线上定义：共 ${entries.length} 张`);
      for (const e of drift) {
        console.log(`  ✖ ${e.name.padEnd(46)} 漂移（${e.detail}）`);
        if (e.divergence && bool(v.detail)) {
          console.log(`      仓库: …${e.divergence.local}…`);
          console.log(`      线上: …${e.divergence.live}…`);
        }
      }
      for (const e of missing) console.log(`  ⚠ ${e.name.padEnd(46)} 线上不存在（仓库里有、线上没有）`);
      for (const e of errors) console.log(`  ✖ ${e.name.padEnd(46)} 读取失败：${e.detail}`);
      for (const e of phaseOnly) console.log(`  ~ ${e.name.padEnd(46)} ${e.detail}`);
      for (const e of propsOnly) console.log(`  · ${e.name.padEnd(46)} ${e.detail}`);
      const clean = entries.filter((e) => e.status === 'same').length;
      if (!drift.length && !missing.length && !errors.length && !phaseOnly.length && !propsOnly.length) {
        console.log('  ✔ 全部一致');
      } else {
        console.log(
          `\n语义漂移 ${drift.length} / 仅相位 ${phaseOnly.length} / 仅属性 ${propsOnly.length} / ` +
            `线上缺失 ${missing.length} / 读取失败 ${errors.length} / 一致 ${clean}`,
        );
        if (drift.length) console.log('加 --detail 可看每个漂移位置的两侧原文。');
        if (phaseOnly.length || propsOnly.length) {
          console.log('注：「仅相位」是 STARTS 时刻不同（相位被改过，定义未变）；「仅属性」只比仓库声明过的 PROPERTIES 键。');
        }
      }
      return drift.length || missing.length ? 4 : 0;
    }
    case 'mv lint': {
      const file = str(v.file);
      if (!file) throw new RcError('E_VALIDATION', '用法：dw mv lint --file <ddl.sql> [--target <mv>]');
      // 文件不存在时给可行动的错误，而不是把 Node 的 ENOENT 原文抛出去
      // （`ENOENT: no such file or directory, open 'x'` 对使用者等于没说清"哪个参数错了"）
      const ddl = await readFile(file, 'utf8').catch((e) => {
        throw new RcError('E_VALIDATION', `读不到 --file ${file}：${(e as Error).message}`, {
          hint: '确认路径正确；相对路径按当前工作目录解析',
        });
      });
      const findings = lintMvDdl(ddl, { targetName: str(v.target) });
      if (json) {
        printJson({ ok: !hasBlockingFinding(findings), file, findings });
        return hasBlockingFinding(findings) ? 4 : 0;
      }
      console.log(`静态检查 ${file}`);
      if (!findings.length) {
        console.log('  ✔ 未发现问题');
        return 0;
      }
      const icon = { error: '✖', warn: '⚠', info: '·' } as const;
      for (const f of findings) {
        console.log(`  ${icon[f.level]} [${f.code}] ${f.message}`);
        if (f.hint) console.log(`      ↳ ${f.hint}`);
      }
      return hasBlockingFinding(findings) ? 4 : 0;
    }

    case 'mv refresh-mode': {
      const env = resolveEnv(v);
      const db = await requireDb(env, timeoutMs);
      const transport = createTransport(env);
      const infos = await listMvInfos(transport, db, { timeoutMs });
      const tasks = await listMvTasks(transport, {
        mvName: str(v.mv),
        hours: intRange(v.hours, 'hours', { min: 1, max: 8760, fallback: 24 }),
        limit: intRange(v.limit, 'limit', { min: 1, max: 100_000, fallback: 2000 }),
        timeoutMs,
      });
      // tasks() 是**全集群**的，mv_infos 是**按库**的：不给 --mv 就按库里的分区类型收敛，
      // 只判 EXPR —— 只有分区级增量的 MV 才谈得上"退化"。
      const partitionType = new Map(infos.map((m) => [m.name, m.partitionType]));
      const summaries = analyzeRefreshMode(tasks, str(v.mv) ? {} : { partitionType });
      const problems = summaries.filter(
        (s) => s.verdict === 'degraded' || s.verdict === 'intermittent' || s.verdict === 'failing',
      );
      const shown = bool(v.all) ? summaries : problems;
      if (json) {
        printJson({
          ok: true,
          hours: intRange(v.hours, 'hours', { min: 1, max: 8760, fallback: 24 }),
          scanned: summaries.length,
          problems: problems.length,
          summaries: shown,
        });
        return 0;
      }
      const expr = infos.filter((m) => m.partitionType === 'EXPR');
      console.log(
        `刷新方式诊断（近 ${intRange(v.hours, 'hours', { min: 1, max: 8760, fallback: 24 })}h，${tasks.length} 条任务 / ${summaries.length} 张 MV）\n` +
          `本库 EXPR 分区 MV ${expr.length} 张：${expr.map((m) => m.name).join('、') || '(无)'}\n` +
          '只有 EXPR 分区才谈得上"增量退化"；SELF_MANAGE / 单分区走全量是正常的，默认不列。\n',
      );
      if (!shown.length) {
        console.log('  ✔ 没有需要关注的（没有 COMPLETE/PARTIAL 记录，或全部为增量）');
        return 0;
      }
      const icon = { failing: '✖', degraded: '✖', intermittent: '⚠', unknown: '·', healthy: '✔', 'not-applicable': '·' } as const;
      for (const s of shown) {
        const modes = Object.entries(s.byMode)
          .map(([k, n]) => `${k}×${n}`)
          .join(' ');
        console.log(`  ${icon[s.verdict]} ${s.mvName.padEnd(46)} ${modes}`);
        console.log(`      ${s.message}${s.maxDurationSec !== undefined ? `；最长 ${s.maxDurationSec}s` : ''}`);
        if (s.hint) console.log(`      ↳ ${s.hint}`);
      }
      console.log(
        `\n降级 ${summaries.filter((s) => s.verdict === 'degraded').length} / 间歇 ${summaries.filter((s) => s.verdict === 'intermittent').length} / ` +
          `失败 ${summaries.filter((s) => s.verdict === 'failing').length}；--all 看全部（含正常项），--mv <name> 单看一张`,
      );
      return 0;
    }

    // ---------- mv（写） ----------
    case 'mv refresh': {
      if (!action) throw new RcError('E_VALIDATION', '用法：dw mv refresh <mv> [--complete] [--apply]');
      const env = resolveEnv(v);
      return writeAndReport(env, bool(v.complete) ? 'REFRESH COMPLETE' : 'REFRESH', action, sqlRefreshMv(action, bool(v.complete)), {
        apply,
        readonly: env.readonly,
        timeoutMs: timeoutMs ?? 600_000,
        json,
        note:
          '语句级 COMPLETE 只强制刷一次全量，不改 MV 的刷新方式；'
          + '会钉死刷新方式的是 CREATE 时写的 REFRESH COMPLETE（dw mv lint 会警告）',
      });
    }
    case 'mv freeze': {
      if (!action) throw new RcError('E_VALIDATION', '用法：dw mv freeze <mv> [--apply]');
      const env = resolveEnv(v);
      return writeAndReport(env, 'FREEZE(ON MANUAL)', action, sqlMvManual(action), {
        apply,
        readonly: env.readonly,
        json,
        note: '冻结后数据停在当前时刻——这正是回退想要的快照',
      });
    }
    case 'mv schedule': {
      if (!action) throw new RcError('E_VALIDATION', '用法：dw mv schedule <mv> --every N --unit HOUR --starts "YYYY-MM-DD HH:MM:SS"');
      const every = intRange(v.every, 'every', { min: 1, max: 10_000 });
      const unit = str(v.unit);
      const starts = str(v.starts);
      if (!every || !unit || !starts) throw new RcError('E_VALIDATION', '需要 --every N --unit <MINUTE|HOUR|DAY|WEEK|MONTH> --starts "YYYY-MM-DD HH:MM:SS"');
      const env = resolveEnv(v);
      const sql = sqlMvSchedule(action, every, unit, starts);
      return writeAndReport(env, 'SCHEDULE', action, sql, {
        apply,
        readonly: env.readonly,
        json,
        note: '相位只认时分秒；改相位属于运维决策，改前先用 dw mv phases 看冲突',
      });
    }
    case 'mv swap-plan':
    case 'mv swap-apply': {
      const target = str(v.target);
      const source = str(v.source);
      if (!target || !source) throw new RcError('E_VALIDATION', '需要 --target <mv> 与 --source <mv_tmp>');
      const env = resolveEnv(v);
      const db = await requireDb(env, timeoutMs);
      const transport = createTransport(env);
      // 换基表后必须手动 COMPLETE 的 ON COMMIT 下游——先算出来，别等人想起来。
      // 算不出来时**不能当成"没有"**：这份清单是换名的安全前提（漏一个就是下游长期不刷新）。
      let onCommit: string[] = [];
      let riskBlind: { name: string; reason: string }[] = [];
      let riskError: string | undefined;
      try {
        const { graph, unreadable } = await buildMvGraph(transport, db, { timeoutMs: timeoutMs ?? 60_000 });
        const risk = await onCommitRisk(transport, target, graph, { timeoutMs });
        onCommit = risk.onCommit;
        riskBlind = [...new Map([...unreadable, ...risk.unreadable].map((u) => [u.name, u])).values()];
      } catch (e) {
        riskError = (e as Error).message;
      }
      const riskKnown = riskError === undefined && riskBlind.length === 0;
      const riskNote = riskError
        ? `依赖图未建成（${riskError}）`
        : riskBlind.length
          ? `${riskBlind.length} 张 MV 的 DDL 读不到（${riskBlind.map((b) => b.name).join('、')}）`
          : undefined;
      const plan = planMvSwap({ target, source, database: db, onCommitDownstream: onCommit });
      if (command === 'mv swap-plan') {
        if (json) {
          printJson({
            ok: true,
            ...plan,
            // 高危清单**显式给出来**：它原来只藏在 steps/warnings 的文案里，
            // 机器读不到就只能靠人眼从清单里挑。
            onCommitDownstream: onCommit,
            // 让 --json 的消费者能区分"确实没有 ON COMMIT 下游"和"这份清单没算出来"
            onCommitRiskKnown: riskKnown,
            onCommitRiskNote: riskNote ?? null,
          });
          return riskKnown ? 0 : 4;
        }
        console.log(`灰度换名清单：${target} ← ${source}（库 ${db}）\n`);
        for (const s of plan.steps) {
          console.log(`${String(s.order).padStart(2)}. ${s.title}${s.manual ? '   [人工确认]' : ''}`);
          if (s.sql) console.log(`    ${s.sql}`);
          if (s.note) console.log(`    ↳ ${s.note}`);
        }
        console.log('\n务必注意：');
        plan.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
        if (riskNote) console.log(`  ⚠ ON COMMIT 高危清单不完整：${riskNote}——换名前请自行核对下游`);
        console.log('\n先用 dw mv lint --file <替换源DDL> --target <目标> 过一遍静态检查，再执行 swap-apply。');
        return riskKnown ? 0 : 4;
      }
      // swap-apply：先做静态检查闸门，再执行
      const dryRun = !apply;
      // 高危清单算不出来时**阻断** --apply：漏掉一个 ON COMMIT 下游就是长期不刷新，
      // 而且要人工去发现。确实要执行就显式加 --force（与 tunnel up 的 force 语义一致）。
      if (!dryRun && !riskKnown && !bool(v.force)) {
        throw new RcError(
          'E_CONFIRM_REQUIRED',
          `ON COMMIT 高危清单未算全（${riskNote}），无法确认换名后需要手动刷新哪些下游。\n` +
            '确认已人工核对过下游，再追加 --force 继续。',
        );
      }
      if (!json && riskNote) console.log(`⚠ ON COMMIT 高危清单不完整：${riskNote}`);
      if (!json) {
        console.log(`${dryRun ? '【dry-run】' : '执行'}换名 ${target} ← ${source}（库 ${db}，${plan.steps.length} 步）\n`);
        plan.steps.forEach((s) => {
          console.log(`${String(s.order).padStart(2)}. ${s.title}${s.manual ? '   [人工确认，跳过]' : ''}`);
          if (s.sql) console.log(`    ${s.sql}`);
        });
      }
      const results = await auditedWrite(
        env,
        {
          action: 'SWAP',
          target,
          dryRun,
          msg: `${plan.steps.length} 步`,
          extra: { source, database: db, onCommitDownstream: onCommit, steps: plan.steps.filter((s) => s.sql).map((s) => s.sql) },
        },
        async () => {
          // 换名前先留一份目标定义，用于事后自证"真的换了"（见 swapTookEffect）
          const beforeDdl = apply ? (await showMvDefinition(transport, target, { raw: true, timeoutMs })).ddl : '';
          const out = await executeMvSwap(transport, plan, { apply, readonly: env.readonly, timeoutMs: timeoutMs ?? 600_000 });
          if (apply) {
            const afterDdl = (await showMvDefinition(transport, target, { raw: true, timeoutMs })).ddl;
            if (!swapTookEffect(beforeDdl, afterDdl)) {
              throw new RcError(
                'E_UPSTREAM',
                `换名似乎未生效：${target} 的定义在 ALTER 之后**逐字未变**。\n` +
                  '  第 3 步是多语句请求（USE <db>; ALTER … REPLACE WITH …），FE 可能只执行了前半段。\n' +
                  '  请手工核对 `dw mv show ' + target + '`，并确认 FE 允许该端点执行 DDL。',
              );
            }
          }
          return out;
        },
      );
      if (json) {
        printJson({
          ok: true,
          dryRun,
          target,
          source,
          database: db,
          onCommitDownstream: onCommit,
          onCommitRiskKnown: riskKnown,
          onCommitRiskNote: riskNote ?? null,
          results,
          warnings: plan.warnings,
        });
        return 0;
      }
      console.log(`\n${dryRun ? '（加 --apply 才会真正执行）' : `✔ 已执行 ${results.length} 条语句`}`);
      if (!dryRun) {
        console.log('\n收尾核对：');
        console.log(`  · dw mv show ${target}      # 确认定义已更新`);
        console.log(`  · dw mv verify-phase ${target} --expect "<原相位时分秒>"`);
        if (onCommit.length) console.log(`  · 逐个确认 ON COMMIT 下游已回 NORMAL：${onCommit.join('、')}`);
      }
      return 0;
    }
    case 'mv verify-phase': {
      if (!action) throw new RcError('E_VALIDATION', '用法：dw mv verify-phase <mv> --expect "HH:MM:SS"');
      const expect = str(v.expect);
      if (!expect) throw new RcError('E_VALIDATION', '需要 --expect "HH:MM:SS"（swap 只改日期，时分秒应原样保留）');
      const env = resolveEnv(v);
      const r = await verifySwapPhase(createTransport(env), action, expect);
      if (json) {
        printJson({ ok: r.ok, mv: action, expected: expect, actual: r.actual, message: r.message });
        return r.ok ? 0 : 4;
      }
      console.log(`${r.ok ? '✔' : '✖'} ${r.message}`);
      return r.ok ? 0 : 4;
    }

    // ---------- partition ----------
    case 'partition list': {
      if (!action) throw new RcError('E_VALIDATION', '用法：dw partition list <db.table>');
      const env = resolveEnv(v);
      const parts = await listPartitions(createTransport(env), action, { timeoutMs });
      if (json) {
        printJson({ ok: true, table: action, count: parts.length, partitions: parts });
        return 0;
      }
      console.log(`${action}：${parts.length} 个分区`);
      for (const p of parts) {
        const gb = p.dataSize === undefined ? '-' : `${(p.dataSize / 1024 ** 3).toFixed(3)}GB`;
        console.log(`  ${p.name.padEnd(24)} 桶=${String(p.buckets ?? '-').padEnd(5)} 副本=${String(p.replicationNum ?? '-').padEnd(3)} 大小=${gb.padEnd(10)} 行数=${p.rowCount ?? '-'}`);
      }
      return 0;
    }
    case 'partition rolloff': {
      if (!action) throw new RcError('E_VALIDATION', '用法：dw partition rolloff <db.table> --keep N [--max-drop N] [--apply]');
      const keep = intRange(v.keep, 'keep', { min: 1, max: 10_000 });
      if (keep === undefined) throw new RcError('E_VALIDATION', '需要 --keep N（保留最新 N 个分区）');
      const maxDrop = intRange(v['max-drop'], 'max-drop', { min: 1, max: 100_000, fallback: 10 })!;
      const env = resolveEnv(v);
      const transport = createTransport(env);
      const parts = await listPartitions(transport, action, { timeoutMs });
      const plan = planRolloff(action, parts, { keep, maxDrop });
      if (json && !apply) {
        printJson({ ok: true, ...plan });
        return 0;
      }
      if (!json) {
        console.log(`${action}：共 ${plan.total} 个分区，保留最新 ${plan.keep} 个，计划删除 ${plan.drop.length} 个\n`);
        if (plan.drop.length) {
          console.log('待删（最旧在前）：');
          for (const d of plan.drop) {
            const gb = d.dataSize === undefined ? '-' : `${(d.dataSize / 1024 ** 3).toFixed(3)}GB`;
            console.log(`  ${d.name.padEnd(24)} ${d.empty ? '空' : `有数据 ${gb} / ${d.rowCount ?? '-'} 行`}`);
          }
        } else console.log('没有需要删除的分区');
        plan.warnings.forEach((w) => console.log(`\n⚠ ${w}`));
      }
      const results = await auditedWrite(
        env,
        {
          action: 'ROLLOFF',
          target: action,
          dryRun: !apply,
          msg: `keep=${keep} drop=${plan.drop.length}`,
          extra: { statements: plan.statements },
        },
        () => executeRolloff(transport, plan, { apply, maxDrop, readonly: env.readonly, timeoutMs: timeoutMs ?? 600_000 }),
      );
      if (json) {
        printJson({ ok: true, dryRun: !apply, ...plan, results });
        return 0;
      }
      console.log(`\n${apply ? `✔ 已执行 ${results.length} 条 DROP PARTITION` : '（加 --apply 才会真正执行）'}`);
      return 0;
    }

    // ---------- tablet ----------
    case 'tablet': {
      if (!action) throw new RcError('E_VALIDATION', '用法：dw tablet <db.table> [--detail] [--partition <p>]');
      const env = resolveEnv(v);
      const transport = createTransport(env);
      const { advice, partitions } = await analyzeBuckets(transport, action, { timeoutMs });
      const dist = await replicaDistribution(transport, action, { timeoutMs }).catch(() => []);
      const skew = analyzeReplicaSkew(dist);
      let tablets: Awaited<ReturnType<typeof listTablets>> = [];
      if (bool(v.detail) || str(v.partition)) {
        tablets = await listTablets(transport, action, { partition: str(v.partition), timeoutMs });
      }
      if (json) {
        printJson({ ok: true, advice, replicaDistribution: dist, replicaSkew: skew, partitions, tablets });
        return 0;
      }
      console.log(`${action} 分桶体检\n`);
      console.log(`  分区 ${advice.partitions} 个，总大小 ${advice.totalSizeGb}GB，每分区桶数 ${advice.bucketsPerPartition ?? '-'}`);
      console.log(`  最大分区 ${advice.largestPartitionGb ?? '-'}GB，每 tablet 约 ${advice.avgTabletGb ?? '-'}GB`);
      console.log(`  ${advice.verdict === 'ok' ? '✔' : '⚠'} ${advice.message}`);
      if (advice.hint) console.log(`      ↳ ${advice.hint}`);
      for (const n of advice.notes ?? []) console.log(`  · ${n}`);
      console.log(`  ${skew.balanced ? '✔' : '⚠'} ${skew.message}`);
      if (tablets.length) {
        console.log(`\n  tablet 明细（${tablets.length} 行）：`);
        for (const t of tablets.slice(0, 100)) {
          console.log(`    ${String(t.tabletId ?? '-').padEnd(22)} ${String(t.partitionName ?? '-').padEnd(20)} BE ${String(t.backendId ?? '-').padEnd(8)} ${t.state ?? ''}`);
        }
        if (tablets.length > 100) console.log(`    … 其余 ${tablets.length - 100} 行省略`);
      }
      return advice.verdict === 'ok' ? 0 : 0;
    }

    // ---------- profile ----------
    case 'profile list': {
      const env = resolveEnv(v);
      const stats = await listQueryStats(createTransport(env), {
        limit: intRange(v.limit, 'limit', { min: 1, max: 100_000, fallback: 30 }),
        hours: intRange(v.hours, 'hours', { min: 1, max: 8760, fallback: 24 }),
        minMs: intRange(v['min-ms'], 'min-ms', { min: 0, max: 86_400_000 }),
        failedOnly: bool(v.failed),
        db: str(v.db),
        raw,
        timeoutMs,
      });
      if (json) {
        printJson({ ok: true, count: stats.length, queries: stats });
        return 0;
      }
      if (!stats.length) {
        console.log('没有符合条件的查询');
        return 0;
      }
      console.log(`${'query_id'.padEnd(38)} ${'耗时'.padEnd(10)} ${'扫描行'.padEnd(12)} ${'状态'.padEnd(6)} SQL`);
      for (const s of stats) {
        console.log(
          `${s.queryId.padEnd(37)} ${`${s.queryTimeMs ?? '-'}ms`.padEnd(10)} ${String(s.scanRows ?? '-').padEnd(12)} ` +
            `${String(s.state ?? '-').padEnd(6)} ${truncate(String(s.stmt ?? s.sqlDigest ?? ''), 70)}`,
        );
      }
      console.log('\n取完整 profile：dw profile get <query_id>');
      return 0;
    }
    case 'profile get': {
      if (!action) throw new RcError('E_VALIDATION', '用法：dw profile get <queryId> [--raw]');
      const env = resolveEnv(v);
      const r = await getProfileText(createTransport(env), action, { raw, timeoutMs });
      if (json) {
        printJson({ ok: true, ...r });
        return 0;
      }
      console.log(r.text);
      if (r.masked) console.log(`\n(已脱敏 ${r.masked} 处；--raw 回原值)`);
      return 0;
    }
    case 'profile diff': {
      const a = action;
      const b = tail[1];
      if (!a || !b) throw new RcError('E_VALIDATION', '用法：dw profile diff <qidA> <qidB>（A 为快、B 为慢）');
      const env = resolveEnv(v);
      const transport = createTransport(env);
      const pa = await getProfileText(transport, a, { raw, timeoutMs });
      const pb = await getProfileText(transport, b, { raw, timeoutMs });
      const lines = diffProfiles(pa.text, pb.text);
      const onlyB = lines.filter((l) => l.kind === 'only-b');
      const onlyA = lines.filter((l) => l.kind === 'only-a');
      if (json) {
        printJson({ ok: true, a, b, onlyA, onlyB: onlyB, lines });
        return 0;
      }
      console.log(`profile 结构差异：${a}（快） vs ${b}（慢）\n`);
      console.log(`只有慢查询有的行（${onlyB.length}）——最可疑：`);
      onlyB.slice(0, 60).forEach((l) => console.log(`  + ${l.text}`));
      console.log(`\n只有快查询有的行（${onlyA.length}）：`);
      onlyA.slice(0, 40).forEach((l) => console.log(`  - ${l.text}`));
      console.log('\n注：已抹掉时间戳与耗时数字，只比结构（算子、落盘、改写）。');
      return 0;
    }
    case 'profile history': {
      if (!action) throw new RcError('E_VALIDATION', '用法：dw profile history "<sql片段>" [--days N]');
      const env = resolveEnv(v);
      const rows = await queryHistory(createTransport(env), action, {
        days: intRange(v.days, 'days', { min: 1, max: 3650, fallback: 7 }),
        limit: intRange(v.limit, 'limit', { min: 1, max: 100_000, fallback: 20 }),
        timeoutMs,
      });
      if (json) {
        printJson({ ok: true, count: rows.length, history: rows });
        return 0;
      }
      if (!rows.length) {
        console.log('没有匹配的历史查询');
        return 0;
      }
      console.log(`${'次数'.padEnd(7)} ${'均值'.padEnd(11)} ${'最大'.padEnd(11)} ${'最近一次'.padEnd(21)} 样本`);
      for (const r of rows) {
        console.log(
          `${String(r.runs).padEnd(7)} ${`${r.avgMs}ms`.padEnd(11)} ${`${r.maxMs}ms`.padEnd(11)} ` +
            `${String(r.lastTime ?? '-').padEnd(21)} ${truncate(String(r.sample ?? ''), 60)}`,
        );
      }
      return 0;
    }

    default:
      console.error(`未知命令：${[group, verb].filter(Boolean).join(' ')}\n`);
      console.log(renderTopHelp(DW_HELP));
      return 2;
  }
}

/**
 * 错误码 → 下一步。
 * 刻意不复用 `RcError.toUserMessage()` 的默认提示：那套是给 iPaaS 写的
 * （"用 traceId 查平台日志"在 Doris 上是错的——Doris 报错基本都是 SQL 本身的问题，
 * 重试没有意义，要看 detailMessage）。
 */
function dwErrorHint(code: string): string {
  switch (code) {
    case 'E_AUTH':
      return '核对 DW_USER/DW_PASS 或 ~/.dw/warehouse-credentials.json（0600）；也可能是 FE 未开认证却传了凭据';
    case 'E_UPSTREAM':
      return 'Doris 的报错通常不是瞬时故障，先看上面的 detailMessage；走隧道时先 dw tunnel status 确认转发，元数据读不到跑 dw doctor';
    case 'E_VALIDATION':
      return '对照 docs/DW-COMMAND-REFERENCE.md 修正参数；库上下文用 --db 指定或写进配置';
    case 'E_FORBIDDEN':
      return '只读闸门只放行单条 SELECT/WITH/SHOW/EXPLAIN/DESC；写操作请用 dw mv refresh|schedule|freeze|swap、dw partition rolloff';
    case 'E_PROD_READONLY':
      return '当前环境标记为只读；确需写入请显式设置 DW_ALLOW_PROD_WRITE=1';
    case 'E_CONFIRM_REQUIRED':
      return '复核 dry-run 计划后追加 --apply（只读环境还需 DW_ALLOW_PROD_WRITE=1）';
    default:
      return '详见 docs/DW-COMMAND-REFERENCE.md';
  }
}

/**
 * 取库上下文；没配就报错。
 *
 * 报错时**顺带列出实例上现有的库**：`SHOW DATABASES` 是只读的、工具本来就能查，
 * 而"这个数仓有哪些库"正是缺库的人当下最需要的信息——
 * 原来只报"未指定 database"，等于让人先猜一个库名再试。
 */
async function requireDb(env: ResolvedWarehouseEnv, timeoutMs?: number): Promise<string> {
  if (env.database) return env.database;
  let choices: string[] = [];
  try {
    choices = await listDatabases(createTransport(env), { timeoutMs });
  } catch {
    // 读不到库清单不该把"缺库"变成另一个错误——原样报缺库即可
  }
  const list = choices.length
    ? `\n该实例现有库（${choices.length} 个）：${choices.slice(0, 40).join('、')}${choices.length > 40 ? ' …' : ''}`
    : '';
  throw new RcError(
    'E_VALIDATION',
    `环境 ${env.name} 未指定 database：用 --db <库> 或写进配置文件（dw env show 可查）${list}`,
    { hint: 'dw mv list --all-db 可跨库一次列全（不需要先定库）' },
  );
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.replace(/[\t\n\r]/g, ' ');
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    if (e instanceof RcError) {
      // `hint` 是抛错方给的**更准确**的下一步（如隧道归因）；没给才落到按错误码的默认提示。
      // `hint: ''` 表示"消息已经说完了"，不再追加。
      const next = e.hint ?? dwErrorHint(e.code);
      console.error(next ? `${e.message}（${e.code}）→ ${next}` : `${e.message}（${e.code}）`);
      process.exit(e.exitCode);
    }
    console.error(e?.message ?? e);
    process.exit(2);
  });
