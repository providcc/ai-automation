/**
 * 灰度换名（REPLACE WITH swap）、仓库/线上 DDL 漂移、依赖链路。
 *
 * 本文件是整个数仓能力里最该被固化的部分——下面每一条都是线上踩出来的，不是从文档抄的：
 *
 *   1. `REPLACE WITH MATERIALIZED VIEW` **后面不能带库名限定**（`db.mv` 会报
 *      `mismatched input '.' expecting {<EOF>, ';'}`），必须 `USE <db>` 后用裸名。
 *   2. **swap 会把调度一起换过去**：换完后替换源（装着旧定义）仍在原相位继续自动刷新，
 *      必须 `REFRESH AUTO ON MANUAL` 冻结再 DROP，否则留一堆无人看的副本空烧资源。
 *   3. **swap 会把 STARTS 重置为"当天 + 原相位"**：错峰的时分秒保住了，日期被改写，
 *      所以 STARTS 不能当"这张表多久没动过"的证据。
 *   4. **DECIMAL 的除法会被提升成 DOUBLE**：MTMV 里写 `a * b / c` 这类金额列，
 *      下游 UNION 兄弟分支是 decimalv3 时报 `column type not same`，且每周期重试、次次 FAILED。
 *      最外层套 `CAST(... AS DECIMAL(38, 2))` 解决。
 *   5. **BUILD 方式会被替换源带过去**：替换源是 DEFERRED，换完就是 DEFERRED，
 *      且 `ALTER ... REFRESH ...` 改不回 BUILD（BUILD 不在可 ALTER 范围）。
 *   6. **`_tmp` 的 STARTS 必须是未来时刻**，否则 `starts time must be greater than current time` 直接拒建。
 *   7. **换基表后只有带调度器的下游会自愈**：`ON COMMIT` 的下游在 SCHEMA_CHANGE 下
 *      基表提交触发器不再点火，而清 SCHEMA_CHANGE 又必须刷一次——死锁，
 *      必须手动 `REFRESH MATERIALIZED VIEW <下游> COMPLETE`。
 */
import type { WarehouseTransport } from './transport.ts';
import type { MvInfo } from './mv.ts';
import { listMvInfos, parseMvSchedule, quoteIdent, runWrite, showMvDefinition, type WriteOutcome } from './mv.ts';
import { RcError } from '../errors.ts';

// ─────────────────────────── DDL 静态检查 ───────────────────────────

export interface DdlFinding {
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  hint?: string;
}

export interface LintOptions {
  /** 当前时刻（便于单测）；默认 now */
  now?: Date;
  /** 该 DDL 将被用作替换源时，目标 MV 名——用于检查重名 */
  targetName?: string;
}

/**
 * 取 CREATE 里的视图名。**必须同时吃下反引号与库名限定两种写法**——
 * 只匹配到第一个反引号会把 `` `db`.`mv` `` 误读成 `db`，于是"带库名限定"这条检查永远不触发。
 */
export function createViewName(ddl: string): string | undefined {
  const m = /CREATE\s+MATERIALIZED\s+VIEW\s+((?:`[^`]+`|[^\s(])+)/i.exec(String(ddl ?? ''));
  return m ? m[1].replace(/`/g, '') : undefined;
}

/** 建 `_tmp` 之前先过一遍：能静态判出来的坑不要等到线上报错。 */
export function lintMvDdl(ddl: string, opts: LintOptions = {}): DdlFinding[] {
  const out: DdlFinding[] = [];
  const text = String(ddl ?? '');
  const now = opts.now ?? new Date();
  const sched = parseMvSchedule(text);
  const createName = createViewName(text);

  if (!createName) {
    out.push({ level: 'error', code: 'E_NO_CREATE', message: 'DDL 里找不到 CREATE MATERIALIZED VIEW <name>' });
  } else {
    if (createName.includes('.')) {
      out.push({
        level: 'error',
        code: 'E_QUALIFIED_NAME',
        message: 'CREATE 里带了库名限定，后续 REPLACE WITH 不接受限定名',
        hint: '先 USE <db>，全程用裸名',
      });
    }
    if (opts.targetName && createName === opts.targetName) {
      out.push({
        level: 'error',
        code: 'E_SAME_NAME',
        message: `替换源与目标同名（${createName}）`,
        hint: '替换源要用独立名字（约定 <目标>_tmp），否则 swap 无意义',
      });
    }
  }

  if (sched.starts) {
    const t = Date.parse(sched.starts.replace(' ', 'T'));
    if (!Number.isNaN(t) && t <= now.getTime()) {
      out.push({
        level: 'error',
        code: 'E_STARTS_PAST',
        message: `STARTS "${sched.starts}" 已过期，建副本会被拒（starts time must be greater than current time）`,
        hint: '把日期改到未来（今晚/明天），**时分秒相位原样保留**，别动相位',
      });
    }
  } else if (/ON\s+SCHEDULE/i.test(sched.refresh ?? '')) {
    out.push({ level: 'warn', code: 'W_NO_STARTS', message: 'ON SCHEDULE 但没有 STARTS，建副本后相位不可控' });
  }

  if (sched.build === 'IMMEDIATE') {
    out.push({
      level: 'info',
      code: 'I_BUILD_IMMEDIATE',
      message: '替换源是 BUILD IMMEDIATE：BUILD 方式会被 swap 带到目标上（若替换源是 DEFERRED 就会把目标降级）',
      hint: '要保住目标的 BUILD 方式，替换源的 CREATE 就得用相同关键字——ALTER 改不回 BUILD',
    });
  }

  // DECIMAL 除法提升：SELECT 体里出现除法，且外层没有 CAST 兜住。
  // 先剥注释再判——注释里写个 `a/b` 就报警，这条检查很快就没人看了。
  const body = stripDdlComments(text.split(/\bAS\s+SELECT\b/i)[1] ?? '');
  const hasDivision = /(^|[^/*])\/(?!\/)/.test(body);
  const hasCast = /CAST\s*\([\s\S]{0,200}?AS\s+DECIMAL/i.test(body);
  if (hasDivision && !hasCast) {
    out.push({
      level: 'warn',
      code: 'W_DECIMAL_DIVISION',
      message: 'SELECT 体里有除法但没有 CAST AS DECIMAL：DECIMAL 相除会被提升成 DOUBLE',
      hint: '下游 UNION 兄弟分支若是 decimalv3，会报 column type not same 且每周期重试失败；最外层套 CAST(SUM(...) AS DECIMAL(38, 2))',
    });
  }

  // 建表时就写 REFRESH COMPLETE 会把刷新方式**钉死**：之后无论发多少次 REFRESH ... AUTO
  // 都永远走全量。想留增量余地必须在 CREATE 时写 REFRESH AUTO。
  // （注意与语句 `REFRESH MATERIALIZED VIEW <mv> COMPLETE` 区分——那个只是强制刷一次全量，
  //   不改 MV 的刷新方式，两者别混。）
  if (/\bREFRESH\s+COMPLETE\b/i.test(headOf(text))) {
    out.push({
      level: 'warn',
      code: 'W_REFRESH_COMPLETE_PINNED',
      message: 'CREATE 里写了 REFRESH COMPLETE：刷新方式会被钉死，之后 ALTER 回 AUTO 也永远走全量',
      hint: '想留增量余地就把 CREATE 的 REFRESH 子句写成 AUTO；只是"现在刷一次全量"请用语句 REFRESH MATERIALIZED VIEW <mv> COMPLETE',
    });
  }

  // ── 分区级增量的建表硬限制 ──
  // 只对**带 PARTITION BY 的 MTMV** 检查：这些限制来自"分区表达式必须穿透到基表分区列"，
  // 没有 PARTITION BY 的 MV 本来就没有分区级增量，UNION 之类随便用（线上就有这样的 MV）。
  if (/\bPARTITION\s+BY\b/i.test(headOf(text))) {
    out.push(...lintPartitionedBody(body));
    const commentTrap = partitionCommentTrap(headOf(text));
    if (commentTrap) {
      out.push({
        level: 'error',
        code: 'E_PARTITION_COMMENT_ORDER',
        message: 'PARTITION BY 之后紧跟 MV 级 COMMENT 会被拒（mismatched input \'COMMENT\'）',
        hint: 'PARTITION BY 要放在 KEY 之后、DISTRIBUTED BY 之前；最省事的做法是干脆不写 MV 级 COMMENT',
      });
    }
  }

  return out;
}

/** `AS SELECT` 之前的头部。 */
function headOf(ddl: string): string {
  return String(ddl ?? '').split(/\bAS\s+SELECT\b/i)[0];
}

/**
 * 分区 MTMV 的 SELECT 体硬限制（每一条都是实测报错，不是从文档抄的）：
 *   - `UNION` **无条件**阻断 → `the invalid plan node is LogicalUnion`
 *   - CTE **被引用 ≥2 次**才阻断 → `LogicalCTEAnchor`；只引用 1 次会被内联掉，正常放行
 *   - 引用 `VIEW` 一律拒绝 → `can not contain VIEW`
 *   - self join 只在自连接的是**分区候选表**时才致命（静态判不出来，只能提示去查）
 */
export function lintPartitionedBody(body: string): DdlFinding[] {
  const out: DdlFinding[] = [];

  if (/\bUNION(\s+ALL)?\b/i.test(body)) {
    out.push({
      level: 'error',
      code: 'E_PARTITION_UNION',
      message: '分区 MTMV 的 SELECT 体里有 UNION：分区表达式无法穿透，建表会被拒',
      hint: 'the invalid plan node is LogicalUnion。把含 UNION 的那一段先物化成物理表/独立 MV 当基表，再让分区 MV 单驱动读它',
    });
  }

  for (const name of cteNamesReferencedTwice(body)) {
    out.push({
      level: 'error',
      code: 'E_PARTITION_CTE_ANCHOR',
      message: `分区 MTMV 里 CTE \`${name}\` 被引用 ≥2 次：优化器会保留锚点，建表被拒`,
      hint: 'the invalid plan node is LogicalCTEAnchor。把该 CTE 物化成物理表当基表；**只引用 1 次的 CTE 不用改**（会被内联，实测正常放行）',
    });
  }

  if (/\bCREATE\s+VIEW\b/i.test(body) || namesLookLikeView(body)) {
    out.push({
      level: 'error',
      code: 'E_PARTITION_VIEW',
      message: '分区 MTMV 引用了 VIEW：分区追踪只走基表，会被拒（can not contain VIEW）',
      hint: '把 VIEW 换成物化的物理表',
    });
  }

  const repeated = tablesReferencedTwice(body);
  if (repeated.length) {
    out.push({
      level: 'warn',
      code: 'W_PARTITION_SELF_JOIN',
      message: `分区 MTMV 里重复 JOIN 了同一张表（${repeated.join('、')}）：若它是分区表会报 self join doesn't support partition update`,
      hint: '先查它是否分区（information_schema.partitions 只有 1 行 = 未分区）。自连接**未分区**表是允许的；确实踩雷就换非分区副本或物化一份',
    });
  }

  return out;
}

/** 找出被引用 ≥2 次的 CTE 名（定义处不算引用）。 */
export function cteNamesReferencedTwice(body: string): string[] {
  const text = String(body ?? '');
  const names = new Set<string>();
  const first = /\bWITH\s+([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/i.exec(text);
  if (!first) return [];
  names.add(first[1]);
  // 顶层逗号分隔的后续 CTE
  for (const m of text.matchAll(/,\s*([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/gi)) names.add(m[1]);

  const out: string[] = [];
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\b`, 'g');
    const total = (text.match(re) ?? []).length;
    const defs = (text.match(new RegExp(`\\b${name}\\s+AS\\s*\\(`, 'gi')) ?? []).length;
    if (total - defs >= 2) out.push(name);
  }
  return out;
}

/** 找出在 FROM/JOIN 里出现 ≥2 次的表名（self join 的静态信号）。 */
export function tablesReferencedTwice(body: string): string[] {
  const counts = new Map<string, number>();
  for (const m of String(body ?? '').matchAll(/\b(?:FROM|JOIN)\s+`([^`]+)`(?!\s*\.)/gi)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  for (const m of String(body ?? '').matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)(?!\s*\.)/gi)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([n]) => n);
}

/**
 * FROM/JOIN 引用的对象名是否"长得像 VIEW"。
 *
 * 纯静态判不出真实类型，只能按命名猜：取**限定名最后一段**，命中 `view` 或 `*_view` 才算。
 * 用最后一段而不是整串，是为了让 `` `db`.`my_view` `` 这种常见写法也能被抓到；
 * 而 `view_log` / `vw_order` 这类**不以 view 结尾**的表名不会被误判——
 * 这是 error 级发现，误判会直接阻断一次换名，宁可漏也不要错杀。
 */
export function namesLookLikeView(body: string): boolean {
  const re = /\b(?:FROM|JOIN)\s+((?:`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*(?:`[^`]+`|[A-Za-z_][A-Za-z0-9_]*))*)/gi;
  for (const m of String(body ?? '').matchAll(re)) {
    const last = m[1].split('.').pop()?.replace(/`/g, '').trim() ?? '';
    if (/^view$/i.test(last) || /_view$/i.test(last)) return true;
  }
  return false;
}

/**
 * `PARTITION BY` 子句区间里混进了 MV 级 `COMMENT` 的形态检测。
 *
 * 不能按"第一个平衡括号组之后"判：Doris 的分区写法是 `PARTITION BY (expr) ()`
 * ——**两个**括号组（分区表达式 + 分区列表），COMMENT 在两个之后。
 * 所以这里改成取 `PARTITION BY` 到下一个子句（DISTRIBUTED BY / PROPERTIES / AS）之间的文本，
 * 看里面有没有 COMMENT 字面量。
 */
export function partitionCommentTrap(head: string): boolean {
  const m = /\bPARTITION\s+BY\b/i.exec(head);
  if (!m) return false;
  const rest = String(head).slice(m.index + m[0].length);
  const end = rest.search(/\bDISTRIBUTED\s+BY\b|\bPROPERTIES\b|\bAS\b/i);
  const between = end === -1 ? rest : rest.slice(0, end);
  return /\bCOMMENT\s*'/i.test(between);
}

/** 是否有阻断级发现。 */
export function hasBlockingFinding(findings: DdlFinding[]): boolean {
  return findings.some((f) => f.level === 'error');
}

// ─────────────────────────── 灰度换名 ───────────────────────────

/** swap 语句：库限定只出现在**目标**上，替换源必须是裸名，PROPERTIES 不能省。 */
export function sqlReplaceWithSwap(target: string, source: string): string {
  if (source.includes('.')) {
    throw new RcError('E_VALIDATION', `替换源不能带库名限定（${source}）：先 USE <db>，用裸名`);
  }
  return (
    `ALTER MATERIALIZED VIEW ${quoteIdent(target)} ` +
    `REPLACE WITH MATERIALIZED VIEW ${quoteIdent(source)} PROPERTIES ('swap'='true')`
  );
}

export interface SwapPlanInput {
  /** 现役 MV（被替换的目标） */
  target: string;
  /** 替换源（约定 <target>_tmp，已建好并全量刷过） */
  source: string;
  /** 库名，用于 USE 与下游枚举 */
  database: string;
  /** 已知的 ON COMMIT 下游：换基表后必须手动 COMPLETE，否则死锁 */
  onCommitDownstream?: string[];
}

export interface SwapStep {
  order: number;
  title: string;
  sql?: string;
  /** 该步是人工确认点（不自动执行） */
  manual?: boolean;
  note?: string;
}

/**
 * 生成换名步骤清单。
 * 顺序刻意固定：**先冻结再删**、**最后补下游**——反过来就会出现"副本还在烧资源"或"下游卡死"。
 */
export function planMvSwap(input: SwapPlanInput): { steps: SwapStep[]; warnings: string[] } {
  const { target, source, database } = input;
  const warnings: string[] = [
    'swap 会把调度一起换到替换源名下：第 4 步不做，旧定义会继续按原相位空刷。',
    'swap 会把目标的 STARTS 重置为"当天 + 原相位"：日期变了、时分秒没变，审计时别拿它当活跃度证据。',
    '目标若有 ON COMMIT 下游，它们在 SCHEMA_CHANGE 下不会自愈，必须手动 COMPLETE（第 6 步起）。',
  ];
  const steps: SwapStep[] = [
    {
      order: 1,
      title: `全量刷替换源 ${source}`,
      sql: `REFRESH MATERIALIZED VIEW ${quoteIdent(source)} COMPLETE`,
      note: '语句级的 COMPLETE 只是强制刷一次全量，不改 MV 的刷新方式（读回 RefreshInfo 仍是原样）；'
        + '会钉死刷新方式的是 **CREATE 时**写的 REFRESH COMPLETE（见 dw mv lint 的 W_REFRESH_COMPLETE_PINNED），两者别混',
    },
    {
      order: 2,
      title: '校验替换源',
      manual: true,
      note: `确认 mv_infos 里 ${source} 为 State=NORMAL / RefreshState=SUCCESS，并抽查数据量级与目标同阶`,
    },
    {
      order: 3,
      title: `原子换名（USE ${database} 后执行，替换源必须裸名）`,
      sql: `USE ${quoteIdent(database)}; ${sqlReplaceWithSwap(target, source)}`,
    },
    {
      order: 4,
      title: `冻结旧定义（现在挂在 ${source} 名下）`,
      sql: `ALTER MATERIALIZED VIEW ${quoteIdent(source)} REFRESH AUTO ON MANUAL`,
      note: '数据停在 swap 时刻，这正是回退想要的快照；不冻结就会继续空刷',
    },
    {
      order: 5,
      title: `清理旧副本 ${source}`,
      sql: `DROP MATERIALIZED VIEW ${quoteIdent(source)}`,
      note: '不删的话它会以原相位持续报 FAILED 任务，污染告警',
    },
  ];
  const onCommit = input.onCommitDownstream ?? [];
  for (const [i, d] of onCommit.entries()) {
    steps.push({
      order: 6 + i,
      title: `手动全刷 ON COMMIT 下游 ${d}`,
      sql: `REFRESH MATERIALIZED VIEW ${quoteIdent(d)} COMPLETE`,
      note: '清 SCHEMA_CHANGE，解开"基表提交不点火 / 不刷又清不掉"的死锁',
    });
  }
  steps.push({
    order: 6 + onCommit.length,
    title: '回读校验',
    manual: true,
    note:
      'SHOW CREATE 确认目标定义已更新且相位时分秒未变；mv_infos 确认 State=NORMAL；' +
      '下游逐个确认回 NORMAL（带调度器的会自愈，ON COMMIT 的已在前面处理）',
  });
  return { steps, warnings };
}

/** 按清单逐步执行（dry-run 默认；人工确认点跳过并提示）。 */
export async function executeMvSwap(
  transport: WarehouseTransport,
  plan: { steps: SwapStep[] },
  opts: { apply?: boolean; timeoutMs?: number; readonly?: boolean } = {},
): Promise<WriteOutcome[]> {
  const results: WriteOutcome[] = [];
  for (const step of plan.steps) {
    if (!step.sql) continue;
    results.push(await runWrite(transport, step.sql, opts));
  }
  return results;
}

/**
 * 换名后核对相位：从 DDL 里取 STARTS，与期望的时分秒比对。
 * 日期会被 swap 改写成当天，所以**只比时分秒**。
 */
export async function verifySwapPhase(
  transport: WarehouseTransport,
  mv: string,
  expectedTimeOfDay: string,
): Promise<{ ok: boolean; actual?: string; message: string }> {
  const { ddl } = await showMvDefinition(transport, mv);
  const sched = parseMvSchedule(ddl);
  if (!sched.starts) return { ok: false, message: `${mv} 未解析到 STARTS` };
  const tod = sched.starts.slice(11);
  return {
    ok: tod === expectedTimeOfDay,
    actual: sched.starts,
    message:
      tod === expectedTimeOfDay
        ? `相位保持：${tod}`
        : `相位被改动：期望 ${expectedTimeOfDay}，实际 ${tod}（用 ALTER ... REFRESH AUTO ON SCHEDULE 还原）`,
  };
}

// ─────────────────────────── DDL 漂移 ───────────────────────────

/**
 * 归一化 DDL 以便比对。
 * SHOW CREATE 会做几件会污染 diff 的事：**把列引用补全限定名**、重排空白、统一反引号、
 * 在左括号后塞一个空格（`(sales_zone` ↔ `( sales_zone`）——
 * 比对前必须先抹平，否则每次都是"满屏假差异"。
 *
 * 限定名一律抹成裸名（三段与两段都抹）：`db.tbl.col` / `tbl.col` / `col` 在语义上等价，
 * 而仓库里手写的是裸名、`SHOW CREATE` 回的是限定名——不抹就等于"每张有 JOIN 的都漂移"。
 * 代价：字符串字面量里形如 `a.b` 的文本也会被抹（两侧同等处理，最坏情况是漏报一处差异）。
 */
export function normalizeDdl(ddl: string): string {
  return String(ddl ?? '')
    .replace(/`/g, '')
    .replace(/([A-Za-z_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_-]*)/g, '$3')
    .replace(/([A-Za-z_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_-]*)/g, '$2')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/,\s*/g, ', ')
    .trim();
}

/**
 * 去掉 SQL 注释（引号感知）。
 *
 * 两个必须做对的地方：
 *   1. **注释不只在行首**：`SHOW CREATE` 会把 SELECT 体里的注释原样存下来，
 *      而且常常被压成 `AS WITH -- 1. 计算最新财年\n latest_fiscal AS (...)` 这种**行内**形态。
 *      只删"整行注释"会漏掉它们，于是每张有注释的 MV 都报漂移——
 *      实测 114 张里报了 39 张，全是这个原因。
 *   2. **引号里的 `--` 不是注释**：值里出现 `'--'` 时按朴素正则会截断语句。
 *      所以要逐字符扫，跟踪单引号/双引号/反引号三种引号状态。
 */
export function stripDdlComments(ddl: string): string {
  const s = String(ddl ?? '');
  let out = '';
  let i = 0;
  let quote: string | undefined;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && quote !== '`') {
        // 反斜杠转义：把下一个字符一起吞掉
        if (i + 1 < s.length) out += s[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = undefined;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out.trim();
}

/**
 * 把 DDL 拆成"语义部分"与"属性表"。
 *
 * 为什么必须拆：`SHOW CREATE` 会**自动补一大堆 PROPERTIES**
 * （`replication_allocation`、`storage_medium`、`storage_format`、`light_schema_change`、
 * `group_commit_interval_ms`、`is_being_synced` …），而仓库里的 `.sql` 从来不会写这些。
 * 整段比对的结果就是"39/114 全漂移"——满屏假差异，等于没查。
 *
 * PROPERTIES 块按**括号配对**提取，不能用贪婪正则：属性值里出现括号就会切错。
 */
export function splitMvDdl(ddl: string): { semantic: string; props: Record<string, string> } {
  const text = String(ddl ?? '');
  const props: Record<string, string> = {};
  const m = /\bPROPERTIES\s*\(/i.exec(text);
  let semantic = text;
  if (m) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end > 0) {
      const inner = text.slice(open + 1, end);
      for (const pair of inner.matchAll(/"([^"]+)"\s*=\s*"([^"]*)"/g)) props[pair[1].toLowerCase()] = pair[2];
      semantic = text.slice(0, m.index) + text.slice(end + 1);
    }
  }
  return { semantic: normalizeDdl(semantic), props };
}

/**
 * 属性差异：**只比仓库声明过的键**。
 * - 仓库有、线上没有 → 漂移（被谁删了）
 * - 两边都有但值不同 → 漂移
 * - 线上多出来的键 → 忽略（那是 Doris 自动补的，不是契约的一部分）
 *
 * 取舍说明：这样"仓库里删掉一个属性"不会被发现。这是刻意的——
 * 反过来做会把十几个自动属性全报成差异，人就不看了。
 */
export function diffMvProps(
  local: Record<string, string>,
  live: Record<string, string>,
): { key: string; local?: string; live?: string }[] {
  const out: { key: string; local?: string; live?: string }[] = [];
  for (const [k, lv] of Object.entries(local)) {
    const rv = live[k];
    if (rv === undefined) out.push({ key: k, local: lv });
    else if (rv !== lv) out.push({ key: k, local: lv, live: rv });
  }
  return out;
}

export interface DdlDiff {
  /** 语义与属性都一致 */
  same: boolean;
  /** 语义（列/键/分桶/调度/SELECT 体）是否一致 */
  semanticSame: boolean;
  /** 唯一的语义差异就是 STARTS 时刻（相位被改过，定义本身没变） */
  phaseOnly: boolean;
  header: { local?: string; live?: string };
  /** 仓库声明过、但线上对不上的属性 */
  propsDiffering: { key: string; local?: string; live?: string }[];
  firstDivergence?: { index: number; local: string; live: string };
  localLen: number;
  liveLen: number;
}

function firstDiffIndex(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

/** 把 STARTS 的值换成占位符，用于判定"只有相位变了"。 */
export function maskStarts(ddl: string): string {
  return String(ddl ?? '').replace(/STARTS\s+"[^"]*"/gi, 'STARTS "<ts>"');
}

/** 比对本地（仓库）与线上定义。头部单列出来——调度差异比列差异更常见也更要紧。 */
export function diffMvDdl(local: string, live: string): DdlDiff {
  // 两边都要剥注释：SHOW CREATE 会把 SELECT 体里的注释一起存下来，
  // 只剥本地的话，每张带注释的 MV 都会报漂移。
  const L = splitMvDdl(stripDdlComments(local));
  const V = splitMvDdl(stripDdlComments(live));
  const nl = L.semantic;
  const nv = V.semantic;
  const headerOf = (s: string) => {
    const cut = s.search(/\bDUPLICATE KEY\b|\bDISTRIBUTED BY\b|\bAS SELECT\b/i);
    return cut > 0 ? s.slice(0, cut).trim() : '';
  };
  const propsDiffering = diffMvProps(L.props, V.props);
  const semanticSame = nl === nv;
  // 只有 STARTS 不同 = 相位被人改过（或 swap 重置过）。定义没变，
  // 但这是有用的信号，单独成一类，不要和"列变了"混在一起报。
  const phaseOnly = !semanticSame && maskStarts(nl) === maskStarts(nv);
  const diff: DdlDiff = {
    same: semanticSame && propsDiffering.length === 0,
    semanticSame,
    phaseOnly,
    header: { local: headerOf(nl), live: headerOf(nv) },
    propsDiffering,
    localLen: nl.length,
    liveLen: nv.length,
  };
  if (!semanticSame) {
    const i = firstDiffIndex(nl, nv);
    diff.firstDivergence = {
      index: i,
      local: nl.slice(Math.max(0, i - 80), i + 120),
      live: nv.slice(Math.max(0, i - 80), i + 120),
    };
  }
  return diff;
}

export interface DriftEntry {
  name: string;
  /** props-only = 只有仓库声明过的属性对不上；phase-only = 只有 STARTS 时刻不同 */
  status: 'same' | 'drift' | 'props-only' | 'phase-only' | 'missing-live' | 'error';
  detail?: string;
  headerDiffers?: boolean;
  propsDiffering?: { key: string; local?: string; live?: string }[];
  /** 漂移位置两侧的原文片段，便于直接看差异 */
  divergence?: { index: number; local: string; live: string };
}

/** Doris 报"表不存在"的措辞不止一种：`not exist` / `table not found` / `Unknown`。 */
export const MISSING_LIVE_PATTERN = /不存在|not\s+exist|not\s+found|Unknown/i;

/**
 * 扫描漂移：本地定义 vs 线上 SHOW CREATE。
 * 与 iPaaS 侧的 `catalog drift` 同构——契约要有单一事实源，漂移要能自动发现。
 */
export async function scanMvDrift(
  transport: WarehouseTransport,
  items: { name: string; ddl: string }[],
  opts: { timeoutMs?: number; onProgress?: (i: number, total: number, name: string) => void } = {},
): Promise<DriftEntry[]> {
  const out: DriftEntry[] = [];
  for (const [i, it] of items.entries()) {
    opts.onProgress?.(i + 1, items.length, it.name);
    try {
      const { ddl } = await showMvDefinition(transport, it.name, { timeoutMs: opts.timeoutMs ?? 60_000 });
      const d = diffMvDdl(it.ddl, ddl);
      out.push({
        name: it.name,
        status: d.same ? 'same' : d.semanticSame ? 'props-only' : d.phaseOnly ? 'phase-only' : 'drift',
        headerDiffers: d.header.local !== d.header.live,
        propsDiffering: d.propsDiffering.length ? d.propsDiffering : undefined,
        divergence: d.firstDivergence,
        detail: d.same
          ? undefined
          : d.semanticSame
            ? `仅属性差异：${d.propsDiffering.map((p) => p.key).join('、')}`
            : d.phaseOnly
              ? '仅 STARTS 时刻不同（相位被改过，定义未变）'
              : `首个差异@${d.firstDivergence?.index}；头部${d.header.local === d.header.live ? '一致' : '不同'}`,
      });
    } catch (e) {
      const msg = (e as Error).message;
      out.push({
        name: it.name,
        status: MISSING_LIVE_PATTERN.test(msg) ? 'missing-live' : 'error',
        detail: msg.slice(0, 160),
      });
    }
  }
  return out;
}

// ─────────────────────────── 依赖链路 ───────────────────────────

export interface MvDependency {
  name: string;
  /** 它读了谁（同库内的 MV 才算边） */
  reads: string[];
  /** 谁读它 */
  readBy: string[];
}

/**
 * 从 DDL 里抽出被引用的表名（含三段式与裸名）。
 *
 * 三段式要**先匹配完再让开**：`FROM `db`.`tbl`.`t`` 里的第一个反引号段是库名，
 * 如果不加负向断言，裸名那条规则会把 `db` 也当成一张被读的表——
 * 建出来的图里就会出现一个"和库同名"的幽灵节点。
 */
export function extractTableRefs(ddl: string): string[] {
  const refs = new Set<string>();
  const text = String(ddl ?? '');
  for (const m of text.matchAll(/`([^`]+)`\s*\.\s*`([^`]+)`\s*\.\s*`([^`]+)`/g)) refs.add(m[3]);
  for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+`([^`]+)`(?!\s*\.)/gi)) refs.add(m[1]);
  return [...refs];
}

/**
 * DDL 的"查询体"：抹掉名字与格式差异，只留定义内容。用于换名生效自证。
 */
export function viewBody(ddl: string): string {
  return normalizeDdl(stripDdlComments(ddl))
    .replace(/^CREATE\s+MATERIALIZED\s+VIEW\s+\S+\s*/i, '')
    .trim();
}

/**
 * 换名是否**真的生效**。
 *
 * 为什么必须自证：第 3 步是一条**多语句**请求（`USE <db>; ALTER … REPLACE WITH …`）。
 * 拆成两次请求是不行的——FE 的 REST 端点没有会话，单独的 `USE` 对下一次请求不生效，
 * 所以只能合并。合并的代价是：返回结果只反映最后一条语句，
 * 一旦 FE 只执行了前半段，命令会"成功"（退出 0、审计还记 `ok: true`）而线上其实没变——
 * 这正是最坏的假成功：审计、CI、Agent 全都判定成功。
 *
 * 判据只取"目标换前 ≠ 目标换后"：这是**单向**的确定性证据——
 * 完全相同说明**一定**没换（硬失败）；不同则至少换过了。
 * 刻意不去比对"target 换后 == source 换前"：那要求两个视图的 SHOW CREATE
 * 格式完全一致，会因为无关的格式差异误报。
 */
export function swapTookEffect(beforeTargetDdl: string, afterTargetDdl: string): boolean {
  const a = viewBody(beforeTargetDdl);
  const b = viewBody(afterTargetDdl);
  return a !== b;
}

/**
 * 用**已经拿到手的 DDL**建图。
 * 单独抽出来是因为 `dw mv phases` 为了读相位本来就把每张的 DDL 拉了一遍——
 * 再调一次 `buildMvGraph` 等于把同样的 SHOW CREATE 全量重跑一次。
 *
 * `allNames` 是**必须传的补丁**：只从 items 推节点集合的话，
 * 某张 DDL 读失败就会让它从图里彻底消失——连"被别人读"这条边也一起丢，
 * 于是换基表时漏掉一个下游。节点集合要以清单为准，不是以"读成功了几张"为准。
 */
export function buildGraphFromDdls(items: { name: string; ddl: string }[], allNames?: string[]): Map<string, MvDependency> {
  const names = new Set(allNames ?? items.map((i) => i.name));
  const graph = new Map<string, MvDependency>();
  for (const n of names) graph.set(n, { name: n, reads: [], readBy: [] });
  for (const it of items) {
    if (!names.has(it.name)) names.add(it.name);
    if (!graph.has(it.name)) graph.set(it.name, { name: it.name, reads: [], readBy: [] });
    const reads = extractTableRefs(it.ddl).filter((r) => names.has(r) && r !== it.name);
    const self = graph.get(it.name);
    if (!self) continue;
    self.reads = reads;
    for (const r of reads) graph.get(r)?.readBy.push(it.name);
  }
  return graph;
}

/**
 * 建依赖图。ON COMMIT 下游的判定靠 DDL 里的 REFRESH 子句——
 * 这是"换基表后谁需要手动 COMPLETE"的唯一可靠依据。
 */
export async function buildMvGraph(
  transport: WarehouseTransport,
  database: string,
  opts: { timeoutMs?: number; limit?: number; onProgress?: (i: number, total: number) => void } = {},
): Promise<{ graph: Map<string, MvDependency>; infos: MvInfo[]; unreadable: { name: string; reason: string }[] }> {
  const infos = await listMvInfos(transport, database, { timeoutMs: opts.timeoutMs ?? 60_000 });
  const targets = opts.limit ? infos.slice(0, opts.limit) : infos;
  const items: { name: string; ddl: string }[] = [];
  // 读不到 DDL 的那张 MV **不会出现在图里**，于是它的入边/出边全丢——
  // 依赖图缺边直接导致下游清单变短，而下游清单正是"换基表前必须手动 COMPLETE"的依据。
  // 所以不能静默跳过：回报 unreadable，让调用方把"清单可能不全"说出来。
  const unreadable: { name: string; reason: string }[] = [];
  for (const [i, m] of targets.entries()) {
    opts.onProgress?.(i + 1, targets.length);
    try {
      const { ddl } = await showMvDefinition(transport, m.name, { timeoutMs: opts.timeoutMs ?? 60_000 });
      items.push({ name: m.name, ddl });
    } catch (e) {
      unreadable.push({ name: m.name, reason: (e as Error).message });
    }
  }
  return { graph: buildGraphFromDdls(items, infos.map((m) => m.name)), infos, unreadable };
}

/** 递归取下游。 */
export function downstreamOf(mv: string, graph: Map<string, MvDependency>): string[] {
  const seen = new Set<string>();
  const queue = [...(graph.get(mv)?.readBy ?? [])];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    queue.push(...(graph.get(cur)?.readBy ?? []));
  }
  return [...seen];
}

/**
 * 换基表前的高危清单：下游里哪些是 ON COMMIT（不会自愈，必须手动 COMPLETE）。
 * 这是"第 7 条坑"的自动化版本。
 */
export async function onCommitRisk(
  transport: WarehouseTransport,
  mv: string,
  graph: Map<string, MvDependency>,
  opts: { timeoutMs?: number } = {},
): Promise<{ downstream: string[]; onCommit: string[]; unreadable: { name: string; reason: string }[] }> {
  const downstream = downstreamOf(mv, graph);
  const onCommit: string[] = [];
  // 下游的 DDL 读不到时**不能猜**（猜"不是 ON COMMIT"会把必须手动刷的下游漏掉），
  // 但也不能当作没这回事——回报 unreadable，让调用方说明"这份高危清单可能不全"。
  const unreadable: { name: string; reason: string }[] = [];
  for (const d of downstream) {
    try {
      const { ddl } = await showMvDefinition(transport, d, { timeoutMs: opts.timeoutMs ?? 60_000 });
      if (/REFRESH\s+AUTO\s+ON\s+COMMIT/i.test(ddl)) onCommit.push(d);
    } catch (e) {
      unreadable.push({ name: d, reason: (e as Error).message });
    }
  }
  return { downstream, onCommit, unreadable };
}
