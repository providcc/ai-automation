/**
 * SQL 文本骨架化 + 只读判定。
 *
 * **所有关键字与分号判定都跑在"骨架"上**——字符串字面量、引用标识符、注释先被替换成空白。
 *
 * ## 为什么必须这样判
 *
 * 只读闸门全是关键字与分号判定，而这些字符会出现在字面量和注释里。
 * 在原文上判，两个方向都会错：
 *
 * | SQL | 在原文上判 | 实际后果 |
 * |---|---|---|
 * | `SELECT 'a;b'` | 见到 `;` → 判成多语句 | **假阳性**：正常查询被拒 |
 * | `SELECT 1 /*! ; DROP TABLE x *​/` | 注释被剥掉 → 看不出多语句 | **假阴性**：真能执行 |
 * | `WITH c AS (SELECT 1) INSERT INTO t2 …` | 首关键字是 `WITH` → 放行 | **假阴性**：CTE 是任意 DML 的合法前缀 |
 *
 * ## MySQL 可执行注释 `/*! … *​/`
 *
 * **刻意不当注释剥掉**：它的内容是真会执行的（mysqldump 就靠它）。
 * 留着它，里面的 `;` 和 DML 关键字才能被后续判定抓到。
 *
 * ## 为什么不用"写关键字黑名单"
 *
 * 早先的做法是"骨架里出现 insert/update/replace… 就拒"。它有两类假阳性，
 * 且都命中**日常查询**：`SELECT REPLACE(name,'-','') FROM t`（`REPLACE` 是字符串函数）、
 * `SELECT * FROM t USE INDEX(i)`。所以改成**只看主语句的动词**：
 * 首关键字是 `select` 时无需再扫（`SELECT` 本身不可能写库，`INTO OUTFILE` / `FOR UPDATE`
 * 由副作用子句单独挡）；首关键字是 `with` 时用 {@link topLevelVerb} 解析出 CTE 之后的主动词。
 */

/**
 * 骨架化。保留长度大体不变（便于定位），但内容只剩"代码"。
 */
export function stripSqlLiterals(sql: string): string {
  const s = String(sql ?? '');
  const out: string[] = [];
  const n = s.length;
  let i = 0;
  const push = (c: string) => out.push(c);
  while (i < n) {
    const ch = s[i];
    // 行注释：-- … 与 # …
    if ((ch === '-' && s[i + 1] === '-') || ch === '#') {
      while (i < n && s[i] !== '\n') {
        push(' ');
        i++;
      }
      continue;
    }
    // 块注释 /* … */，但 /*! 是可执行注释，**不剥**
    if (ch === '/' && s[i + 1] === '*') {
      if (s[i + 2] === '!') {
        push(ch);
        i++;
        continue;
      }
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) {
        push(' ');
        i++;
      }
      if (i < n) {
        push('  ');
        i += 2;
      }
      continue;
    }
    // 引号：' " `（标识符反引号也一并抹掉，免得列名里的关键字误伤）
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      push(' ');
      i++;
      while (i < n) {
        // 反斜杠转义（反引号标识符里不适用）
        if (s[i] === '\\' && quote !== '`') {
          push('  ');
          i += 2;
          continue;
        }
        // 双写转义：'' "" ``
        if (s[i] === quote && s[i + 1] === quote) {
          push('  ');
          i += 2;
          continue;
        }
        if (s[i] === quote) {
          push(' ');
          i++;
          break;
        }
        push(' ');
        i++;
      }
      continue;
    }
    push(ch);
    i++;
  }
  return out.join('');
}

/** 剥掉开头的 `EXPLAIN` / `EXPLAIN ANALYZE`，看它**真正在解释哪条语句**。 */
export function stripExplainPrefix(code: string): string {
  return String(code ?? '').replace(/^\s*explain\s+(?:analyze\s+)?/i, '');
}

/**
 * 取骨架里的**第一个关键字**。
 * 会先吃掉 `EXPLAIN` / `EXPLAIN ANALYZE` 前缀——那样 `EXPLAIN DROP TABLE t`
 * 判的是内层的 `DROP`，而不是被 `EXPLAIN` 这个"只读动词"蒙过去。
 */
export function firstKeyword(code: string): string | undefined {
  const stripped = stripExplainPrefix(code).replace(/^\s+/, '');
  return /^([a-z]+)/i.exec(stripped)?.[1]?.toLowerCase();
}

/**
 * 骨架里是否存在**顶层**（括号深度 0）的 `LIMIT`。
 *
 * 用来决定要不要补 LIMIT：子查询里的 `LIMIT 1` 不算数——
 * 外层没有 LIMIT 时整表照样会被拉回来。
 */
export function hasTopLevelLimit(code: string): boolean {
  let depth = 0;
  for (const m of String(code ?? '').matchAll(/[()]|\blimit\b/gi)) {
    const tok = m[0];
    if (tok === '(') depth++;
    else if (tok === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) return true;
  }
  return false;
}

/** 只读语句的合法首关键字。`EXPLAIN` 不在此列——它由 `firstKeyword` 剥掉后看内层。 */
export const READ_ONLY_HEADS = new Set(['select', 'with', 'show', 'desc', 'describe']);

/** 有副作用/加锁的写法：只读语句里也不允许出现（平台/引擎会真的执行）。 */
export const UNSAFE_CLAUSE = /\b(into\s+(outfile|dumpfile)|for\s+update|lock\s+in\s+share\s+mode)\b/i;

/**
 * 骨架里是否还剩**多条**语句。
 *
 * 判定跑在骨架上，因为：`SELECT 'a;b'` 里的分号不是分隔符（原文判定会假阳性），
 * 而 `SELECT 1 /*! ; DROP … *​/` 里的分号**是真会执行的**（可执行注释不被剥，才能抓到）。
 */
export function hasMultipleStatements(code: string): boolean {
  return /;/.test(String(code ?? '').trim().replace(/;+\s*$/, ''));
}

/**
 * 解析 `WITH …` 之后**主语句的动词**。
 *
 * `WITH` 是任意 DML 的合法前缀，所以 `WITH c AS (SELECT 1) INSERT INTO t2 …`
 * 的首关键字虽是 `with`，却是写操作。CTE 名与 CTE 主体都在括号/标识符里，
 * 所以只要按 `with [recursive] name [(cols)] as (body) [, …]` 的语法把 CTE 列表走完，
 * 剩下的第一个顶层词就是主动词——**不会**被 CTE 体内的函数名（如 `REPLACE(`）误伤。
 *
 * 解析不出来（语法畸形）返回 `undefined`：调用方按"无法证明只读"处理。
 */
export function topLevelVerb(code: string): string | undefined {
  // 逗号也必须进 token 流——它是"还有下一个 CTE"的唯一标志，漏了它就会把
  // 第二个 CTE 的名字当成主动词（`WITH a AS (…), b AS (…) INSERT …` → 误判成 select）。
  const toks: string[] = [];
  for (const m of String(code ?? '').matchAll(/[()]|,|[A-Za-z_][A-Za-z0-9_$]*/g)) toks.push(m[0]);
  let i = 0;
  const lc = (t?: string) => (t ?? '').toLowerCase();
  /** 从当前 `(` 起跳到配对的 `)`（不闭合就吃到结尾）。 */
  const skipGroup = (): void => {
    let depth = 0;
    while (i < toks.length) {
      const t = toks[i++];
      if (t === '(') depth++;
      else if (t === ')' && --depth === 0) return;
    }
  };

  if (lc(toks[i]) !== 'with') return undefined;
  i++;
  if (lc(toks[i]) === 'recursive') i++;
  // 严格按 `with [recursive] name [(cols)] as (body) [, …] verb …` 走；
  // 任何一步对不上就返回 undefined（调用方按"无法证明只读"处理，宁可拒也不放行）。
  for (;;) {
    if (toks[i] === undefined || toks[i] === '(' || toks[i] === ')' || toks[i] === ',') return undefined;
    i++; // CTE 名
    if (toks[i] === '(') skipGroup(); // 可选列清单 name(a, b)
    if (lc(toks[i]) !== 'as') return undefined; // 标准语法里 AS 不可省
    i++;
    if (toks[i] !== '(') return undefined;
    skipGroup(); // CTE 主体
    if (toks[i] === ',') {
      i++;
      continue; // 还有下一个 CTE
    }
    return lc(toks[i]) || undefined; // CTE 走完 → 下一个词是主动词
  }
}

/** 只读判定的结论。`kind` 决定调用方给哪条错误信息。 */
export type ReadOnlyVerdict =
  | { ok: true }
  | { ok: false; kind: 'head' | 'unsafe' | 'multi' | 'cte'; detail?: string };

/**
 * 一条语句是否**只读**。dw 的查询闸门与 rc 的 SQL 校验共用这一份判定。
 *
 * 顺序有意为之：**多语句先于** CTE/动词判定——
 * `SELECT 1; DROP TABLE t` 该报"多条语句"（更准确的原因），而不是"含写操作"。
 */
export function isReadOnlyStatement(sql: string): ReadOnlyVerdict {
  const code = stripSqlLiterals(sql);
  const head = firstKeyword(code);
  if (!head || !READ_ONLY_HEADS.has(head)) return { ok: false, kind: 'head' };
  if (UNSAFE_CLAUSE.test(code)) return { ok: false, kind: 'unsafe' };
  if (hasMultipleStatements(code)) return { ok: false, kind: 'multi' };
  // select / show / desc 到此为止：它们不可能写库（副作用写法上面已挡）。
  if (head === 'with') {
    const verb = topLevelVerb(stripExplainPrefix(code));
    if (verb !== 'select') return { ok: false, kind: 'cte', detail: verb };
  }
  return { ok: true };
}
