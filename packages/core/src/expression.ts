/**
 * 表达式与条件契约（v2 Phase 0）
 *
 * 平台里同时存在四类"表达式"：
 *   1) 取值表达式：`$.data.list` / `$.orders.0.id` / `$['custentity_x'].id` / `${$.global.url}`
 *   2) 规则条件（前端条件构建器）：JSON 数组 [{fieldId,operator,compareValue,relation,group}]
 *   3) 路由/断言脚本：`function assert(engine,nodeDoc,nodeId,indoc){ ... }`（后端 Nashorn/JS 引擎执行）
 *   4) 连线条件码：linkDataArray[].assertCondition（0=始终，10=禁止，其余为平台内置条件类型）
 *
 * 本模块只做**纯本地解析/求值/静态检查**，不执行平台脚本。
 * 语法来源：73 个真实流程的 1010 条属性 + 564 条路由（见 catalog/expression-grammar.json）。
 */

export type PathSegment = string | number;

export interface ParsedPath {
  raw: string;
  segments: PathSegment[];
}

export interface RuleCondition {
  fieldId?: string;
  operator?: string;
  compareValue?: unknown;
  relation?: '&&' | '||' | string;
  group?: boolean;
  [k: string]: unknown;
}

export type ConditionKind = 'always' | 'forbid' | 'script' | 'rules' | 'builtin' | 'unknown';

export interface ConditionSpec {
  code: string;
  kind: ConditionKind;
  raw?: string;
  script?: string;
  rules?: RuleCondition[];
  note?: string;
}

/** 条件构建器支持的运算符（从真实流程字段中归纳） */
export const RULE_OPERATORS = [
  'isNull', 'notNull', 'isEmpty', 'notEmpty',
  '==', '!=', '>', '>=', '<', '<=',
  'length=', 'length>', 'length<', 'length>=', 'length<=',
  'contains', 'notContains', 'startsWith', 'endsWith', 'matches',
  'in', 'notIn', 'isTrue', 'isFalse',
] as const;

/** 断言/路由条件码（实测：0 始终执行，10 禁止执行） */
export const CONDITION_CODES: Record<string, string> = {
  '0': '始终执行（always）',
  '10': '禁止执行（forbid）',
  '1': '平台内置条件类型 1（网关分支/条件构建器）',
  '2': '平台内置条件类型 2（网关分支/条件构建器）',
  '3': '自定义断言脚本（condition 字段）',
  '6': '自定义断言脚本（condition 字段）',
  '7': '平台内置条件类型 7（网关默认分支）',
};

const unwrapTemplate = (s: string): string => {
  const t = s.trim();
  return t.startsWith('${') && t.endsWith('}') ? t.slice(2, -1).trim() : t;
};

/**
 * 解析取值表达式。
 * 支持：`$`、`$.a.b`、`$.a.0.b`、`$['a']`、`$["a"].b`、`${$.a.b}`。
 */
export function parsePath(input: string): ParsedPath {
  const raw = input;
  let s = unwrapTemplate(input);
  if (!s.startsWith('$')) throw new Error(`取值表达式必须以 $ 开头：${input}`);
  s = s.slice(1);
  const segments: PathSegment[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '.') {
      i++;
      let j = i;
      while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
      const seg = s.slice(i, j);
      if (!seg) throw new Error(`取值表达式存在空路径段：${input}`);
      segments.push(/^\d+$/.test(seg) ? Number(seg) : seg);
      i = j;
      continue;
    }
    if (ch === '[') {
      const close = s.indexOf(']', i);
      if (close < 0) throw new Error(`取值表达式缺少 ]：${input}`);
      let inner = s.slice(i + 1, close).trim();
      if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
        inner = inner.slice(1, -1);
      }
      if (!inner) throw new Error(`取值表达式存在空下标：${input}`);
      segments.push(/^\d+$/.test(inner) ? Number(inner) : inner);
      i = close + 1;
      continue;
    }
    // $foo 形式：容忍但不推荐
    let j = i;
    while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
    const seg = s.slice(i, j);
    if (!seg) throw new Error(`无法解析取值表达式：${input}`);
    segments.push(/^\d+$/.test(seg) ? Number(seg) : seg);
    i = j;
  }
  return { raw, segments };
}

/** 按路径取值；路径不存在返回 undefined（不抛错） */
export function evaluatePath(data: unknown, path: string | ParsedPath): unknown {
  const segments = typeof path === 'string' ? parsePath(path).segments : path.segments;
  let cur: any = data;
  for (const seg of segments) {
    if (cur == null) return undefined;
    cur = cur[seg as any];
  }
  return cur;
}

/** 提取文本中的所有 `${...}` 表达式（不含 ${} 包裹） */
export function findTemplateExpressions(text: string): string[] {
  const out: string[] = [];
  const re = /\$\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * 渲染模板插值（仅本地预览，不执行脚本）：
 *   `https://x/${$.path}` → `https://x/orders`
 * undefined/null → 空串；对象/数组 → JSON.stringify；其余 String()。
 */
export function renderTemplate(text: string, data: unknown): string {
  return String(text).replace(/\$\{([^}]*)\}/g, (_m, expr: string) => {
    let v: unknown;
    try {
      v = evaluatePath(data, expr.trim());
    } catch {
      return '';
    }
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}

/** 单个 `${...}` 取原始值（无包裹时直接按路径取值） */
export function evaluateTemplateExpression(expr: string, data: unknown): unknown {
  const t = expr.trim();
  return evaluatePath(data, t.startsWith('${') && t.endsWith('}') ? t.slice(2, -1).trim() : t);
}

/** 把 `$.a.b` 形式的字段 id 归一为路径 */
export function normalizeFieldId(input: string): string {
  if (input.startsWith('$')) return input;
  return `$.${input}`;
}

export function parseRuleCondition(input: string | RuleCondition[]): RuleCondition[] {
  if (Array.isArray(input)) return input;
  const text = input.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`规则条件不是合法 JSON：${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('规则条件必须是数组');
  return parsed as RuleCondition[];
}

const asNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

const lengthOf = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === 'string' || Array.isArray(v)) return v.length;
  if (typeof v === 'object') return Object.keys(v as object).length;
  return String(v).length;
};

/** 单条规则求值 */
export function evaluateRule(rule: RuleCondition, data: unknown): boolean {
  const op = String(rule.operator ?? '').trim();
  const field = rule.fieldId ? normalizeFieldId(String(rule.fieldId)) : '';
  const actual = field ? evaluatePath(data, field) : undefined;
  const expected = rule.compareValue;
  const aNum = asNumber(actual);
  const eNum = asNumber(expected);
  switch (op) {
    case 'isNull': return actual === null || actual === undefined || actual === '';
    case 'notNull': return !(actual === null || actual === undefined || actual === '');
    case 'isEmpty': return lengthOf(actual) === 0;
    case 'notEmpty': return lengthOf(actual) > 0;
    case '==': return aNum !== undefined && eNum !== undefined ? aNum === eNum : str(actual) === str(expected);
    case '!=': return aNum !== undefined && eNum !== undefined ? aNum !== eNum : str(actual) !== str(expected);
    case '>': return aNum !== undefined && eNum !== undefined ? aNum > eNum : str(actual) > str(expected);
    case '>=': return aNum !== undefined && eNum !== undefined ? aNum >= eNum : str(actual) >= str(expected);
    case '<': return aNum !== undefined && eNum !== undefined ? aNum < eNum : str(actual) < str(expected);
    case '<=': return aNum !== undefined && eNum !== undefined ? aNum <= eNum : str(actual) <= str(expected);
    case 'length=': return lengthOf(actual) === (eNum ?? Number(expected));
    case 'length>': return lengthOf(actual) > (eNum ?? Number(expected));
    case 'length<': return lengthOf(actual) < (eNum ?? Number(expected));
    case 'length>=': return lengthOf(actual) >= (eNum ?? Number(expected));
    case 'length<=': return lengthOf(actual) <= (eNum ?? Number(expected));
    case 'contains': return str(actual).includes(str(expected));
    case 'notContains': return !str(actual).includes(str(expected));
    case 'startsWith': return str(actual).startsWith(str(expected));
    case 'endsWith': return str(actual).endsWith(str(expected));
    case 'matches': try { return new RegExp(str(expected)).test(str(actual)); } catch { return false; }
    case 'in': {
      const list = Array.isArray(expected) ? expected : str(expected).split(',').map((x) => x.trim());
      return list.map(str).includes(str(actual));
    }
    case 'notIn': {
      const list = Array.isArray(expected) ? expected : str(expected).split(',').map((x) => x.trim());
      return !list.map(str).includes(str(actual));
    }
    case 'isTrue': return actual === true || str(actual) === 'true' || str(actual) === '1';
    case 'isFalse': return actual === false || str(actual) === 'false' || str(actual) === '0';
    default:
      // 未知运算符不静默通过：交由调用方决定（这里返回 false 并可通过 validateRules 发现）
      return false;
  }
}

/** 规则集合求值：&& 优先于 ||，左结合 */
export function evaluateRules(rules: RuleCondition[], data: unknown): boolean {
  if (!rules.length) return true;
  // 先按 || 分组，组内 &&。
  const groups: RuleCondition[][] = [[]];
  for (const r of rules) {
    if (String(r.relation ?? '') === '||') groups.push([r]);
    else groups[groups.length - 1].push(r);
  }
  return groups.some((g) => g.every((r) => evaluateRule(r, data)));
}

/** 静态校验规则集合：未知运算符、缺字段、非法路径 */
export function validateRules(rules: RuleCondition[]): string[] {
  const issues: string[] = [];
  const known = new Set<string>(RULE_OPERATORS as unknown as string[]);
  rules.forEach((r, i) => {
    if (!r.fieldId) issues.push(`规则 #${i + 1} 缺少 fieldId`);
    else {
      try { parsePath(normalizeFieldId(String(r.fieldId))); } catch (e) { issues.push(`规则 #${i + 1} 路径非法：${(e as Error).message}`); }
    }
    if (!r.operator) issues.push(`规则 #${i + 1} 缺少 operator`);
    else if (!known.has(String(r.operator))) issues.push(`规则 #${i + 1} 未知运算符：${r.operator}`);
    if (r.relation !== undefined && !['&&', '||'].includes(String(r.relation))) {
      issues.push(`规则 #${i + 1} 非法连接符：${r.relation}`);
    }
  });
  return issues;
}

export interface ScriptValidation {
  ok: boolean;
  issues: string[];
  reads: { engine: string[]; indoc: string[] };
}

const BANNED_SCRIPT = [
  { re: /\brequire\s*\(/, msg: '禁止 require()' },
  { re: /\bimport\s+[A-Za-z_$]/, msg: '禁止 import' },
  { re: /\bprocess\s*\./, msg: '禁止访问 process' },
  { re: /\bchild_process\b/, msg: '禁止访问 child_process' },
  { re: /\b(?:fs|net|http|https|dns|tls)\s*\./, msg: '禁止访问系统/网络模块' },
  { re: /\beval\s*\(/, msg: '禁止 eval()' },
  { re: /\bnew\s+Function\s*\(/, msg: '禁止 new Function()' },
  { re: /while\s*\(\s*true\s*\)/, msg: '禁止 while(true) 死循环' },
  { re: /for\s*\(\s*;\s*;\s*\)/, msg: '禁止空 for 死循环' },
];

/** 静态检查断言脚本（不执行） */
export function validateAssertScript(script: string): ScriptValidation {
  const issues: string[] = [];
  const reads = { engine: [] as string[], indoc: [] as string[] };
  if (!/function\s+assert\s*\(/.test(script)) issues.push('脚本必须定义 function assert(engine,nodeDoc,nodeId,indoc)');
  for (const b of BANNED_SCRIPT) if (b.re.test(script)) issues.push(b.msg);
  if (!/\breturn\b/.test(script)) issues.push('脚本应返回 1（成立）或 0（不成立）');
  const re = /(engine|indoc)\s*\.\s*get\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const bag = m[1] === 'engine' ? reads.engine : reads.indoc;
    if (!bag.includes(m[2])) bag.push(m[2]);
  }
  return { ok: issues.length === 0, issues, reads };
}

/** 解析连线/网关条件 */
export function compileCondition(input: {
  assertCondition?: string | number;
  /** 便捷别名：只给条件码时使用 */
  code?: string | number;
  condition?: string;
  routerCondition?: string;
  /** 便捷别名：直接给规则数组 */
  rules?: RuleCondition[];
  /** 便捷别名：直接把断言脚本放在 raw */
  raw?: string;
}): ConditionSpec {
  const code = String(input.assertCondition ?? input.code ?? '0');
  const script = String(input.condition ?? input.raw ?? '').trim();
  const ruleText = String(input.routerCondition ?? '').trim();
  if (code === '0') return { code, kind: 'always' };
  if (code === '10') return { code, kind: 'forbid' };
  if (script) return { code, kind: 'script', script, note: CONDITION_CODES[code] };
  if (input.rules?.length) return { code, kind: 'rules', rules: input.rules };
  if (ruleText) {
    try {
      const rules = parseRuleCondition(ruleText);
      return { code, kind: 'rules', rules, raw: ruleText };
    } catch {
      return { code, kind: 'unknown', raw: ruleText, note: 'routerCondition 既不是合法 JSON 规则，也没有 condition 脚本' };
    }
  }
  return { code, kind: 'builtin', note: CONDITION_CODES[code] ?? `未记录的条件码 ${code}` };
}

/** 生成条件摘要（用于文档/报告） */
export function describeCondition(spec: ConditionSpec): string {
  if (spec.kind === 'always') return '始终执行';
  if (spec.kind === 'forbid') return '禁止执行';
  if (spec.kind === 'script') {
    const v = validateAssertScript(spec.script ?? '');
    return `断言脚本（读取 ${v.reads.engine.length} 个 engine 字段 / ${v.reads.indoc.length} 个 indoc 字段${v.ok ? '' : '，静态检查有问题'}）`;
  }
  if (spec.kind === 'rules') return `规则条件（${spec.rules?.length ?? 0} 条）`;
  return spec.note ?? `条件码 ${spec.code}`;
}
