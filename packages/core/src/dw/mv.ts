/**
 * MV 自查与写操作：清单/状态、真实相位、定义读取、刷新与调度。
 *
 * 两条口径（都是线上核过的，不是从文档抄的）：
 *   1. Doris 3.1.4 上 `SHOW MATERIALIZED VIEWS` **不可用**，必须走表函数 `mv_infos('database'=...)`；
 *      而且列集合随版本变化（3.1.x 只有 Name/State/RefreshState），所以按列名取、不按位置取。
 *   2. **真实刷新相位与耗时只信 `tasks('type'='mv')`**：`RefreshInfo` 里没有 STARTS
 *      并不等于"整点锚点"；调度定义要看 DDL 头部或 `jobs()`。
 */
import type { WarehouseTransport } from './transport.ts';
import { maskDdlText } from './query.ts';
import { RcError } from '../errors.ts';

// ─────────────────────────── 标识符 ───────────────────────────

/** 标识符加反引号；反引号本身转义。 */
export function quoteIdent(name: string): string {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

/** 单引号字符串字面量转义（用于拼 mv_infos 的参数）。 */
export function quoteLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 从结果行里按列名取值（大小写不敏感），兼容不同版本的列集合。 */
function pick(row: Record<string, unknown>, key: string): unknown {
  const hit = Object.keys(row).find((k) => k.toLowerCase() === key.toLowerCase());
  return hit ? row[hit] : undefined;
}

// ─────────────────────────── 清单与状态 ───────────────────────────

export interface MvInfo {
  name: string;
  /** 所属库。跨库列出（`--all-db`）时用来说明这条来自哪个库 */
  database?: string;
  state?: string;
  refreshState?: string;
  /** 更高版本会多出这些列，缺省即 undefined */
  refreshMode?: string;
  syncWithBaseTables?: string | number;
  lastRefreshTime?: string;
  errorMsg?: string;
  /**
   * 分区类型：`SELF_MANAGE` / `EXPR` / `FOLLOW_BASE_TABLE`。
   * **只有 `EXPR`（分区级增量）才谈得上"增量退化"**——其余类型本来就没有分区级增量。
   */
  partitionType?: string;
  /** 分区追踪所依赖的那张基表（`EXPR` 时才有） */
  relatedTable?: string;
  relatedCol?: string;
  partitionCol?: string;
}

/**
 * 解析 `MvPartitionInfo` 字符串。实测形态：
 *   `MTMVPartitionInfo{partitionType=EXPR, relatedTable=<tbl>, relatedCol='<col>', partitionCol='<col>'}`
 *   `MTMVPartitionInfo{partitionType=SELF_MANAGE}`
 * 用 `MvPartitionInfo` 判分区类型比解析 DDL 可靠：DDL 里的 `PARTITION BY` 可能写成各种等价形式。
 */
export function parseMvPartitionInfo(raw: unknown): Pick<MvInfo, 'partitionType' | 'relatedTable' | 'relatedCol' | 'partitionCol'> {
  const s = String(raw ?? '');
  if (!s) return {};
  const type = /partitionType\s*=\s*([A-Z_]+)/i.exec(s)?.[1];
  const related = /relatedTable\s*=\s*([^,}]+)/i.exec(s)?.[1]?.trim();
  const relatedCol = /relatedCol\s*=\s*'?([^',}]+)'?/i.exec(s)?.[1]?.trim();
  const partitionCol = /partitionCol\s*=\s*'?([^',}]+)'?/i.exec(s)?.[1]?.trim();
  return {
    partitionType: type?.toUpperCase(),
    relatedTable: related,
    relatedCol,
    partitionCol,
  };
}

/**
 * MV 清单。走 `mv_infos` 表函数；按列名取值以兼容版本差异。
 */
export async function listMvInfos(
  transport: WarehouseTransport,
  database: string,
  opts: { timeoutMs?: number } = {},
): Promise<MvInfo[]> {
  const res = await transport.run(`SELECT * FROM mv_infos('database'=${quoteLiteral(database)})`, {
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  if (!res.ok) throw new RcError('E_UPSTREAM', `读取 mv_infos 失败：${res.msg ?? res.code}`);
  return res.rows
    .map((row) => ({
      name: String(pick(row, 'Name') ?? ''),
      database,
      state: pick(row, 'State') as string | undefined,
      refreshState: pick(row, 'RefreshState') as string | undefined,
      refreshMode: pick(row, 'RefreshMode') as string | undefined,
      syncWithBaseTables: pick(row, 'SyncWithBaseTables') as string | number | undefined,
      lastRefreshTime: pick(row, 'LastRefreshTime') as string | undefined,
      errorMsg: pick(row, 'ErrorMsg') as string | undefined,
      ...parseMvPartitionInfo(pick(row, 'MvPartitionInfo')),
    }))
    .filter((m) => m.name);
}

/** 健康判定：State=NORMAL 且 RefreshState=SUCCESS 才算正常。 */
export function isHealthy(m: Pick<MvInfo, 'state' | 'refreshState'>): boolean {
  return m.state === 'NORMAL' && m.refreshState === 'SUCCESS';
}

/** Doris 自带的库：跨库列举时跳过（里面不会有用户 MV）。 */
const SYSTEM_DBS = new Set([
  'information_schema',
  '__internal_schema',
  'mysql',
  'sys',
  'performance_schema',
  'doris_audit_db__',
]);

/**
 * 实例上有哪些库。
 *
 * 存在的理由很实际：库上下文没配时，工具原来只报"未指定 database"——
 * 而"这个数仓有哪些库"是**工具自己就能查到**的事，不该让人先猜再试。
 */
export async function listDatabases(
  transport: WarehouseTransport,
  opts: { timeoutMs?: number } = {},
): Promise<string[]> {
  const res = await transport.run('SHOW DATABASES', { timeoutMs: opts.timeoutMs ?? 30_000 });
  if (!res.ok) throw new RcError('E_UPSTREAM', `读取库清单失败：${res.msg ?? res.code}`);
  const names = res.rows
    .map((row) => pick(row, 'Database') ?? Object.values(row)[0])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  // 去重 + 系统库排后面 + 其余按名排序（稳定输出，便于 diff）
  return [...new Set(names)].sort((a, b) => {
    const sys = (n: string) => (SYSTEM_DBS.has(n.toLowerCase()) ? 1 : 0);
    return sys(a) - sys(b) || a.localeCompare(b);
  });
}

/**
 * 跨库列出 MV（`dw mv list --all-db`）。
 *
 * 单个库读失败**不**让整条命令失败（权限、系统库都可能读不到），
 * 但必须把失败的库回报出去——静默跳过会把"某库有异常 MV"漏报成"没有"。
 */
export async function listMvInfosAllDbs(
  transport: WarehouseTransport,
  opts: { timeoutMs?: number; includeSystem?: boolean } = {},
): Promise<{ infos: MvInfo[]; failed: { database: string; reason: string }[] }> {
  const all = await listDatabases(transport, opts);
  const dbs = opts.includeSystem ? all : all.filter((d) => !SYSTEM_DBS.has(d.toLowerCase()));
  const infos: MvInfo[] = [];
  const failed: { database: string; reason: string }[] = [];
  for (const database of dbs) {
    try {
      infos.push(...(await listMvInfos(transport, database, opts)));
    } catch (e) {
      failed.push({ database, reason: (e as Error).message });
    }
  }
  return { infos, failed };
}

export interface MvTask {
  mvName: string;
  createTime?: string;
  finishTime?: string;
  status?: string;
  errorMsg?: string;
  /** 耗时（秒）：优先取 `DurationMs`，没有才用两侧时间相减 */
  durationSec?: number;
  /** 精确毫秒耗时（`DurationMs`，比两侧时间相减可靠） */
  durationMs?: number;
  /**
   * 本次实际走的刷新方式：`COMPLETE` / `PARTIAL` / `NOT_REFRESH`。
   * **这是判定"增量退化成全量"的唯一直接证据**（见 `analyzeRefreshMode`）。
   * `NOT_REFRESH` = 没有分区判脏，什么都没做——不是失败。
   */
  refreshMode?: string;
  /** 本次判定为脏、需要刷新的分区名（`PARTIAL` 时通常只有几个） */
  needRefreshPartitions?: string[];
  /** 本次实际完成的分区名 */
  completedPartitions?: string[];
}

function diffSeconds(a?: string, b?: string): number | undefined {
  if (!a || !b) return undefined;
  const pa = Date.parse(String(a).replace(' ', 'T'));
  const pb = Date.parse(String(b).replace(' ', 'T'));
  if (Number.isNaN(pa) || Number.isNaN(pb)) return undefined;
  return Math.round((pb - pa) / 1000);
}

/** `NeedRefreshPartitions` 这类列回的是 JSON 数组字符串；解析不出来就原样当单元素。 */
export function parsePartitionList(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v)) return v.map(String);
  const s = String(v).trim();
  if (!s.startsWith('[')) return [s];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return [s];
  }
}

/** 最近任务：真实刷新时刻、耗时与**刷新方式**看这张表。 */
export async function listMvTasks(
  transport: WarehouseTransport,
  opts: { mvName?: string; hours?: number; limit?: number; timeoutMs?: number } = {},
): Promise<MvTask[]> {
  const hours = Number(opts.hours ?? 24);
  const limit = Number(opts.limit ?? 200);
  const where = [
    `CreateTime >= DATE_SUB(NOW(), INTERVAL ${hours} HOUR)`,
    opts.mvName ? `MvName = ${quoteLiteral(opts.mvName)}` : undefined,
  ]
    .filter(Boolean)
    .join(' AND ');
  const res = await transport.run(
    `SELECT MvName, CreateTime, FinishTime, Status, ErrorMsg, DurationMs, RefreshMode, ` +
      `NeedRefreshPartitions, CompletedPartitions FROM tasks('type'='mv') ` +
      `WHERE ${where} ORDER BY CreateTime DESC LIMIT ${limit}`,
    { timeoutMs: opts.timeoutMs ?? 60_000 },
  );
  if (!res.ok) throw new RcError('E_UPSTREAM', `读取 tasks 失败：${res.msg ?? res.code}`);
  return res.rows.map((row) => {
    const createTime = pick(row, 'CreateTime') as string | undefined;
    const finishTime = pick(row, 'FinishTime') as string | undefined;
    const durationMs = Number(pick(row, 'DurationMs'));
    const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined;
    return {
      mvName: String(pick(row, 'MvName') ?? ''),
      createTime,
      finishTime,
      status: pick(row, 'Status') as string | undefined,
      errorMsg: pick(row, 'ErrorMsg') as string | undefined,
      durationMs: ms,
      durationSec: ms === undefined ? diffSeconds(createTime, finishTime) : Math.round(ms / 1000),
      refreshMode: pick(row, 'RefreshMode') as string | undefined,
      needRefreshPartitions: parsePartitionList(pick(row, 'NeedRefreshPartitions')),
      completedPartitions: parsePartitionList(pick(row, 'CompletedPartitions')),
    };
  });
}

/**
 * 取线上定义（默认脱敏 DDL 里的连接属性字面量）。
 *
 * `SHOW CREATE` 回的是**两列**（`View` 名字 + `Create View` 定义），
 * 所以不能取 `rows[0]` 的第一个值——那会拿到名字。按列名优先、否则取最长值。
 */
export async function showMvDefinition(
  transport: WarehouseTransport,
  name: string,
  opts: { raw?: boolean; timeoutMs?: number } = {},
): Promise<{ name: string; ddl: string; masked: number }> {
  const res = await transport.run(`SHOW CREATE MATERIALIZED VIEW ${quoteIdent(name)}`, {
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  if (!res.ok) throw new RcError('E_UPSTREAM', `SHOW CREATE 失败：${res.msg ?? res.code}`);
  const ddl = pickCreateColumn(res.rows[0]);
  // 必须像一段 DDL：SHOW CREATE 回两列（名字 + 定义），挑错列会拿到名字，
  // 而一个"看起来成功但内容是个表名"的返回值比报错更难查。
  if (!ddl || !/^\s*CREATE\b/i.test(ddl)) {
    throw new RcError('E_UPSTREAM', `SHOW CREATE 没有返回定义（拿到的不是 DDL）：${name}`);
  }
  if (opts.raw) return { name, ddl, masked: 0 };
  const { text, hits } = maskDdlText(ddl);
  return { name, ddl: text, masked: hits };
}

/** 从 `SHOW CREATE` 的行里挑出定义列：优先列名含 create，否则取最长的那一列。 */
export function pickCreateColumn(row: Record<string, unknown> | undefined): string {
  if (!row) return '';
  const entries = Object.entries(row).filter(([, v]) => typeof v === 'string' && v);
  if (!entries.length) return '';
  const named = entries.find(([k]) => /create/i.test(k));
  if (named) return String(named[1]);
  return String(entries.reduce((a, b) => (String(b[1]).length > String(a[1]).length ? b : a))[1]);
}

// ─────────────────────────── 调度解析 ───────────────────────────

export interface MvSchedule {
  /** BUILD IMMEDIATE / BUILD DEFERRED */
  build?: string;
  /** REFRESH 子句：AUTO ON SCHEDULE EVERY n UNIT STARTS "..." / AUTO ON COMMIT / AUTO ON MANUAL … */
  refresh?: string;
  every?: number;
  unit?: string;
  starts?: string;
  onCommit?: boolean;
  onManual?: boolean;
}

/**
 * 从 DDL 头部解析调度。
 * 注意 STARTS 会被 swap 重置成"当天 + 原相位"，所以它只用于核对相位，
 * **不能当"这张表多久没动过"的证据**。
 */
export function parseMvSchedule(ddl: string): MvSchedule {
  const head = String(ddl ?? '').split(/\bAS\s+SELECT\b/i)[0];
  const build = /\bBUILD\s+(IMMEDIATE|DEFERRED)\b/i.exec(head)?.[1]?.toUpperCase();
  const refreshM = /\bREFRESH\s+([\s\S]*?)(?=\n\s*(?:DUPLICATE|DISTRIBUTED|PROPERTIES|PARTITION)\b|$)/i.exec(head);
  const refresh = refreshM ? refreshM[1].replace(/\s+/g, ' ').trim() : undefined;
  const every = /EVERY\s+(\d+)\s+(MINUTE|HOUR|DAY|WEEK|MONTH)/i.exec(refresh ?? '');
  const starts = /STARTS\s+"([^"]+)"/i.exec(refresh ?? '')?.[1];
  return {
    build,
    refresh,
    every: every ? Number(every[1]) : undefined,
    unit: every?.[2]?.toUpperCase(),
    starts,
    onCommit: /\bON\s+COMMIT\b/i.test(refresh ?? ''),
    onManual: /\bON\s+MANUAL\b/i.test(refresh ?? ''),
  };
}

// ─────────────────────────── 写操作（结构化） ───────────────────────────

export interface WriteOutcome {
  ok: boolean;
  sql: string;
  msg?: string;
  dryRun: boolean;
}

/**
 * 写操作统一入口：dry-run 默认、只读环境闸门。
 * 审计由调用方（CLI）负责；这里把闸门集中在一处便于审查。
 */
export async function runWrite(
  transport: WarehouseTransport,
  sql: string,
  opts: { apply?: boolean; timeoutMs?: number; readonly?: boolean } = {},
): Promise<WriteOutcome> {
  const dryRun = !opts.apply;
  if (!dryRun && opts.readonly) {
    throw new RcError('E_PROD_READONLY', '当前环境标记为只读（DW_PROFILE=prod）；如确需写入请显式设置 DW_ALLOW_PROD_WRITE=1');
  }
  const res = await transport.run(sql, { dryRun, timeoutMs: opts.timeoutMs ?? 600_000 });
  if (dryRun) return { ok: true, sql, dryRun: true, msg: 'dry-run：未执行' };
  if (!res.ok) throw new RcError('E_UPSTREAM', `执行失败：${res.msg ?? `FE 业务码 ${res.code}`}`);
  return { ok: true, sql, dryRun: false, msg: res.msg };
}

export function sqlRefreshMv(name: string, complete = false): string {
  return `REFRESH MATERIALIZED VIEW ${quoteIdent(name)}${complete ? ' COMPLETE' : ''}`;
}

/** 冻结副本：数据停在当前时刻，正是回退想要的快照。 */
export function sqlMvManual(name: string): string {
  return `ALTER MATERIALIZED VIEW ${quoteIdent(name)} REFRESH AUTO ON MANUAL`;
}

export function sqlMvSchedule(name: string, every: number, unit: string, starts: string): string {
  const u = String(unit).toUpperCase();
  if (!['MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH'].includes(u)) {
    throw new RcError('E_VALIDATION', `不支持的调度单位：${unit}（MINUTE/HOUR/DAY/WEEK/MONTH）`);
  }
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(starts)) {
    throw new RcError('E_VALIDATION', `STARTS 需要 "YYYY-MM-DD HH:MM:SS" 格式，收到：${starts}`);
  }
  return `ALTER MATERIALIZED VIEW ${quoteIdent(name)} REFRESH AUTO ON SCHEDULE EVERY ${Number(every)} ${u} STARTS "${starts}"`;
}
