/**
 * 只读闸门、结果脱敏、查询执行。
 *
 * 与官方 CLI 的取舍差异（都是刻意的）：
 *   1. **只读闸门默认开启**：官方 `sql` 是通用执行器；这里只放行 SELECT/WITH/SHOW/EXPLAIN/DESC，
 *      且**拒绝多语句**——`SELECT 1; DROP TABLE t` 的前缀完全合法，是这类闸门最大的漏洞。
 *   2. **结果默认脱敏**：列名命中凭据/个人信息的列一律打码，`--raw` 才回原值。
 *   3. **没有 LIMIT 就补一个**：避免一条 SELECT 把整库拖回来；结果再截断到 maxRows。
 */
import type { WarehouseTransport, QueryResult } from './transport.ts';
import { stripSqlLiterals, hasMultipleStatements, hasTopLevelLimit, isReadOnlyStatement } from '../sql-text.ts';
import { RcError } from '../errors.ts';

// ─────────────────────────── 只读闸门 ───────────────────────────

/**
 * 判断是否只剩**一条**语句。
 *
 * 判定跑在**骨架**上（字面量与注释已抹掉），因为：
 *   - `SELECT 'a;b'` 里的分号不是分隔符 → 原文判定会假阳性拒掉正常查询；
 *   - `SELECT 1 /*! ; DROP … *​/` 里的分号**是真会执行的** → 剥注释后判定会漏。
 */
export function singleStatement(sql: string): { single: boolean; reason?: string } {
  if (hasMultipleStatements(stripSqlLiterals(sql))) {
    return { single: false, reason: '检测到多条语句（;）——本命令只接受单条只读语句' };
  }
  return { single: true };
}

export function assertReadOnlyQuery(sql: string): void {
  const s = String(sql ?? '').trim();
  if (!s) throw new RcError('E_VALIDATION', 'SQL 不能为空');

  // 判定全部跑在骨架（字面量/注释已抹）上；实现与 rc 的 `sql check` 共用 sql-text。
  const v = isReadOnlyStatement(s);
  if (v.ok) return;

  if (v.kind === 'unsafe') {
    throw new RcError('E_FORBIDDEN', 'SQL 含副作用/加锁子句（INTO OUTFILE / FOR UPDATE / LOCK IN SHARE MODE）');
  }
  // 多语句**先于**写操作判定：`SELECT 1; DROP TABLE t` 报"多条语句"更准确。
  if (v.kind === 'multi') {
    throw new RcError('E_FORBIDDEN', '检测到多条语句（;）——本命令只接受单条只读语句');
  }
  throw new RcError(
    'E_FORBIDDEN',
    '只接受只读语句（SELECT / WITH / SHOW / EXPLAIN / DESC）。' +
      '写操作请用结构化命令：dw mv refresh、dw mv schedule、dw mv swap。',
  );
}

/**
 * 没有 LIMIT 时补一个。已有**顶层** LIMIT 不重复加。
 *
 * **只给 SELECT / WITH 补**：Doris 的 `SHOW ...` 不接受 LIMIT
 * （`SHOW TABLES LIMIT 1` 报 `mismatched input 'LIMIT'`，实测），
 * `EXPLAIN` / `DESC` 同理。给它们补 LIMIT 会让本来能跑的查询直接失败。
 *
 * 判定"已有 LIMIT"必须看**顶层**：`SELECT * FROM t WHERE note LIKE '%limit 5%'`
 * 里的 `limit 5` 在字面量里，子查询里的 `LIMIT 1` 也只管子查询——
 * 只做 `/\blimit\s+\d+/` 匹配的话，这两种情况都会让整表被拉回来。
 */
export function applyRowLimit(sql: string, max: number): { sql: string; injected: boolean } {
  const s = String(sql ?? '');
  // 注意：**不剥** EXPLAIN 前缀。剥了会把 `EXPLAIN SELECT …` 当成 SELECT 去补 LIMIT，
  // 而 EXPLAIN 的正文被改写就解释的不是原语句了。
  if (!/^\s*(select|with)\b/i.test(stripSqlLiterals(s))) return { sql: s, injected: false };
  if (hasTopLevelLimit(stripSqlLiterals(s))) return { sql: s, injected: false };
  return { sql: `${s.replace(/;\s*$/, '')} LIMIT ${max}`, injected: true };
}

// ─────────────────────────── 脱敏 ───────────────────────────

/** 列名命中即打码：凭据类 + 常见个人信息列。 */
const SENSITIVE_COLUMN =
  /pass(word|wd)?|secret|token|authorization|cookie|credential|private_key|access_key|phone|mobile|email|id_card|idcard|身份证|手机|邮箱/i;

export interface MaskOptions {
  /** 额外要打码的列（不区分大小写），来自 DW_MASK_COLS */
  extraColumns?: string[];
  placeholder?: string;
}

export function isSensitiveColumn(name: string, opts: MaskOptions = {}): boolean {
  const n = String(name);
  if (SENSITIVE_COLUMN.test(n)) return true;
  return (opts.extraColumns ?? []).some((c) => c.toLowerCase() === n.toLowerCase());
}

/** 行级脱敏：只改命中列的值，列顺序与行数不变（便于对拍）。 */
export function maskRows(
  rows: Record<string, unknown>[],
  opts: MaskOptions = {},
): { rows: Record<string, unknown>[]; maskedColumns: string[] } {
  const ph = opts.placeholder ?? '***';
  const masked = new Set<string>();
  const out = rows.map((row) => {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v !== null && v !== undefined && isSensitiveColumn(k, opts)) {
        copy[k] = ph;
        masked.add(k);
      } else {
        copy[k] = v;
      }
    }
    return copy;
  });
  return { rows: out, maskedColumns: [...masked] };
}

/**
 * URL 形态的建连串：协议 + 可选凭据段 + 主机（形如 `jdbc:mysql://…@…`）。
 *
 * 只匹配**数据库类** scheme，避免把注释里的普通 http 链接也抹掉。
 * 主机名一并抹掉：`jdbc_url` 里的主机就是内网库地址，属于内部信息。
 */
const DB_URL =
  /\b((?:jdbc:(?:mysql|postgresql|oracle|sqlserver|hive2?|trino|clickhouse|doris)|mysql|postgres(?:ql)?|oracle|sqlserver|mongodb(?:\+srv)?|redis|clickhouse|trino):\/\/)(?:([^:@/\s"']+)(?::[^@/\s"']*)?@)?[^:/\s"'?]+/gi;

/**
 * DDL/属性文本脱敏：把 `"password" = "..."`、`password=...`、`jdbc_url` 里的
 * 凭据与主机这类字面量抹掉。用于 `dw mv show` 与漂移报告——DDL 里确实会出现建连属性。
 */
export function maskDdlText(text: string, placeholder = '***'): { text: string; hits: number } {
  let hits = 0;
  const out = String(text ?? '')
    .replace(
      /(["'`]?(?:password|passwd|pwd|secret|token|access_key|secret_key)["'`]?\s*[=:]\s*)(["'])([^"']*)\2/gi,
      (_m, pre: string, q: string) => {
        hits++;
        return `${pre}${q}${placeholder}${q}`;
      },
    )
    .replace(/(password=)[^;&\s]*/gi, (_m, pre: string) => {
      hits++;
      return `${pre}${placeholder}`;
    })
    // URL 形态的建连串：协议 + 可选凭据段 + 主机（形如 `jdbc:mysql://…@…:3306/db`）。
    // 只按 `password=` 抹是不够的——jdbc_url 里的凭据走的是 **userinfo** 段，
    // 而主机名同样是内部信息（DDL 的 PROPERTIES 里真会出现）。
    // 限定在数据库类 scheme 上，免得把注释里的普通 https 链接也改掉。
    .replace(DB_URL, (_m, scheme: string, userinfo: string | undefined) => {
      hits++;
      return `${scheme}${userinfo ? `${placeholder}@` : ''}${placeholder}`;
    });
  return { text: out, hits };
}

/** 从环境读额外脱敏列。 */
export function maskOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): MaskOptions {
  const extra = (env.DW_MASK_COLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { extraColumns: extra };
}

// ─────────────────────────── 查询 ───────────────────────────

export interface QueryOptions {
  /** 行数上限，默认 500（超出截断并标记） */
  maxRows?: number;
  /** 关掉脱敏（危险：仅排查时用） */
  raw?: boolean;
  timeoutMs?: number;
  dryRun?: boolean;
  /** 脱敏配置；省略则读环境变量 */
  mask?: MaskOptions;
}

export interface QueryOutcome {
  ok: boolean;
  columns: string[];
  rows: Record<string, unknown>[];
  /** 结果被截断到 maxRows */
  truncated: boolean;
  /** 被脱敏的列 */
  maskedColumns: string[];
  /** 是否注入了 LIMIT */
  limitInjected: boolean;
  execTimeMs?: number;
  msg?: string;
}

/**
 * 只读查询：闸门 → LIMIT → 执行 → 截断 → 脱敏。
 * 脱敏在截断之后做，保证"行数对得上"，便于与未脱敏结果对拍。
 */
export async function queryWarehouse(
  transport: WarehouseTransport,
  sql: string,
  opts: QueryOptions = {},
): Promise<QueryOutcome> {
  assertReadOnlyQuery(sql);
  const maxRows = opts.maxRows ?? 500;
  const { sql: limited, injected } = applyRowLimit(sql, maxRows + 1);

  const res: QueryResult = await transport.run(limited, {
    timeoutMs: opts.timeoutMs ?? 60_000,
    dryRun: opts.dryRun,
  });
  if (opts.dryRun) {
    return {
      ok: true,
      columns: [],
      rows: [],
      truncated: false,
      maskedColumns: [],
      limitInjected: injected,
      msg: res.msg,
    };
  }
  if (!res.ok) {
    throw new RcError('E_UPSTREAM', `查询失败：${res.msg ?? `FE 业务码 ${res.code}`}`, { detail: { code: res.code } });
  }

  const truncated = res.rows.length > maxRows;
  const head = truncated ? res.rows.slice(0, maxRows) : res.rows;
  const { rows, maskedColumns } = opts.raw
    ? { rows: head, maskedColumns: [] as string[] }
    : maskRows(head, opts.mask ?? maskOptionsFromEnv());

  return {
    ok: true,
    columns: res.columns,
    rows,
    truncated,
    maskedColumns,
    limitInjected: injected,
    execTimeMs: res.execTimeMs,
    msg: res.msg,
  };
}
