#!/usr/bin/env node
/**
 * 生成表达式契约与 50 条回归样本（v2 Phase 0.1）
 *
 * 数据来源：../ipaas-testcases/fixtures/flows/index.json（73 个真实流程）
 * 只提取**形态与统计**（运算符、路径形状、条件码），不落客户字段名/脚本原文；
 * 回归样本使用归一化后的通用字段，保证开源仓库可脱敏。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePath, parseRuleCondition, validateRules, validateAssertScript } from '../packages/core/src/expression.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIXTURES = process.env.RC_FLOW_FIXTURES ?? join(REPO, '..', 'ipaas-testcases', 'fixtures', 'flows', 'index.json');

const stats = {
  flows: 0,
  props: 0,
  routes: 0,
  pathSamples: 0,
  templateSamples: 0,
  ruleArrays: 0,
  scripts: 0,
  operators: {},
  conditionCodes: {},
};

const paths = new Set();
const templates = new Set();
const ruleArrays = new Set();
const scripts = new Set();
const codes = new Set();

const walk = (v) => {
  if (v === null || v === undefined) return;
  if (typeof v === 'string') {
    for (const m of v.matchAll(/\$\{[^}]*\}/g)) templates.add(m[0]);
    if (v.trim().startsWith('$') && v.length < 200) paths.add(v.trim());
    if (v.trim().startsWith('[') && v.includes('"operator"') && v.length < 2000) ruleArrays.add(v.trim());
    if (/function\s+assert\s*\(/.test(v) && v.length < 5000) scripts.add(v);
    return;
  }
  if (Array.isArray(v)) { v.forEach(walk); return; }
  if (typeof v === 'object') {
    if (typeof v.assertCondition !== 'undefined') codes.add(String(v.assertCondition));
    for (const [k, x] of Object.entries(v)) {
      if (k === 'operator' && typeof x === 'string') stats.operators[x] = (stats.operators[x] ?? 0) + 1;
      walk(x);
    }
  }
};

if (existsSync(FIXTURES)) {
  const j = JSON.parse(readFileSync(FIXTURES, 'utf8'));
  stats.flows = j.items?.length ?? 0;
  for (const it of j.items ?? []) {
    stats.props += Object.keys(it.props ?? {}).length;
    if (it.detail?.processModel) {
      try {
        const pm = JSON.parse(it.detail.processModel);
        stats.routes += pm.linkDataArray?.length ?? 0;
      } catch { /* ignore */ }
    }
    walk(it.props);
    walk(it.detail);
  }
}
stats.pathSamples = paths.size;
stats.templateSamples = templates.size;
stats.ruleArrays = ruleArrays.size;
stats.scripts = scripts.size;
for (const c of codes) stats.conditionCodes[c] = (stats.conditionCodes[c] ?? 0) + 1;

function expectParse(expr) {
  const p = parsePath(expr);
  return p.segments;
}

// ---------- 50 条归一化回归样本 ----------
const cases = [];
const add = (c) => cases.push(c);

// 20 条取值路径
const pathCases = [
  ['$.data', { data: { id: 1 } }, { id: 1 }],
  ['$.data.id', { data: { id: 7 } }, 7],
  ['$.data.list.0.id', { data: { list: [{ id: 'A' }] } }, 'A'],
  ['$.data.list[0].id', { data: { list: [{ id: 'B' }] } }, 'B'],
  ["$['data']['id']", { data: { id: 8 } }, 8],
  ['$["data"].name', { data: { name: 'n' } }, 'n'],
  ['${$.global.token}', { global: { token: 't' } }, 't'],
  ['$.a.b.c', { a: { b: { c: 3 } } }, 3],
  ['$.a.0', { a: ['x'] }, 'x'],
  ['$.a[1].b', { a: [{}, { b: 2 }] }, 2],
  ['$', { any: true }, { any: true }],
  ['$.items[2]', { items: [1, 2, 3] }, 3],
  ["$.map['key.with.dot']", { map: { 'key.with.dot': 'v' } }, 'v'],
  ['$.data.recordInfoList.oIdDepartment', { data: { recordInfoList: { oIdDepartment: 'D1' } } }, 'D1'],
  ['$.user.0.username', { user: [{ username: 'u1' }] }, 'u1'],
  ['$.engine.last2Friday', { engine: { last2Friday: '2026-10-16' } }, '2026-10-16'],
  ['$.result.token', { result: { token: 'tk' } }, 'tk'],
  ['$.global.pageNo', { global: { pageNo: 3 } }, 3],
  ['$.response.data[0].code', { response: { data: [{ code: 'OK' }] } }, 'OK'],
  ['$.indoc.oIds', { indoc: { oIds: ['1', '2'] } }, ['1', '2']],
];
for (const [expr, data, expected] of pathCases) {
  add({ id: `path-${cases.length + 1}`, kind: 'path', expr, data, expected, segments: expectParse(expr) });
}

// 15 条模板插值
const templateCases = [
  ['https://api.example.com/${$.path}', { path: 'orders' }, 'https://api.example.com/orders'],
  ['/rest/${$.module}/${$.id}', { module: 'core', id: '42' }, '/rest/core/42'],
  ['${$.user.0.username}', { user: [{ username: 'alice' }] }, 'alice'],
  ["select * from t where id='${$.id}'", { id: 'A1' }, "select * from t where id='A1'"],
  ['{"name":"${$.name}"}', { name: 'n' }, '{"name":"n"}'],
  ['${$.a}-${$.b}', { a: 1, b: 2 }, '1-2'],
  ['token=${$.global.token}', { global: { token: 't' } }, 'token=t'],
  ['pageNo=${$.page.no}&pageSize=${$.page.size}', { page: { no: 1, size: 20 } }, 'pageNo=1&pageSize=20'],
  ['prefix-${$.code}-suffix', { code: 'X' }, 'prefix-X-suffix'],
  ['${$.missing}', {}, ''],
  ['${$.a.0.name}', { a: [{ name: 'n0' }] }, 'n0'],
  ['${$.obj}', { obj: { k: 1 } }, '{"k":1}'],
  ['${$.bool}', { bool: true }, 'true'],
  ['${$.num}', { num: 0 }, '0'],
  ['${$.nested.deep.value}', { nested: { deep: { value: 'v' } } }, 'v'],
];
for (const [tpl, data, expected] of templateCases) {
  add({ id: `template-${cases.length + 1}`, kind: 'template', expr: tpl, data, expected });
}

// 10 条规则条件
const ruleCases = [
  [[{ fieldId: '$.data.id', operator: 'isNull' }], { data: { id: null } }, true],
  [[{ fieldId: '$.data.id', operator: 'notNull' }], { data: { id: 1 } }, true],
  [[{ fieldId: '$.data.amount', operator: '>', compareValue: '1000' }], { data: { amount: 1200 } }, true],
  [[{ fieldId: '$.data.amount', operator: '<=', compareValue: '1000' }], { data: { amount: 1000 } }, true],
  [[{ fieldId: '$.data.name', operator: 'contains', compareValue: 'abc' }], { data: { name: 'xabcx' } }, true],
  [[{ fieldId: '$.data.status', operator: 'in', compareValue: 'A,B' }], { data: { status: 'B' } }, true],
  [[{ fieldId: '$.data.code', operator: 'startsWith', compareValue: 'RC' }], { data: { code: 'RC-1' } }, true],
  [[{ fieldId: '$.data.list', operator: 'length=', compareValue: '2' }], { data: { list: [1, 2] } }, true],
  [[{ fieldId: '$.data.enabled', operator: 'isTrue' }], { data: { enabled: true } }, true],
  [[{ fieldId: '$.a', operator: '==', compareValue: '1' }, { fieldId: '$.b', operator: '==', compareValue: '2', relation: '||' }], { a: 0, b: 2 }, true],
];
for (const [rules, data, expected] of ruleCases) {
  add({ id: `rules-${cases.length + 1}`, kind: 'rules', expr: JSON.stringify(rules), data, expected, rules: parseRuleCondition(JSON.stringify(rules)) });
}

// 5 条断言脚本（归一化）
const scriptCases = [
  'function assert(engine,nodeDoc,nodeId,indoc){ if(indoc.get("id")==null){return 1;} return 0; }',
  'function assert(engine,nodeDoc,nodeId,indoc){ if(indoc.get("amount")>1000){return 1;} return 0; }',
  'function assert(engine,nodeDoc,nodeId,indoc){ var ok=indoc.get("status")=="A"; return ok?1:0; }',
  'function assert(engine,nodeDoc,nodeId,indoc){ if(engine.get("global").get("token")!=null){return 1;} return 0; }',
  'function assert(engine,nodeDoc,nodeId,indoc){ if(indoc.get("list").size()>0){return 1;} return 0; }',
];
for (const s of scriptCases) {
  const v = validateAssertScript(s);
  add({ id: `script-${cases.length + 1}`, kind: 'script', expr: s, expectedOk: v.ok, reads: v.reads, issues: v.issues });
}

if (cases.length !== 50) throw new Error(`回归样本应为 50 条，实际 ${cases.length}`);

const grammar = {
  generatedAt: new Date().toISOString(),
  version: 1,
  source: {
    fixtures: 'ipaas-testcases/fixtures/flows/index.json',
    flows: stats.flows,
    props: stats.props,
    routes: stats.routes,
    note: '仅提取形态与统计；样本字段已归一化，不含客户业务数据',
  },
  bnf: {
    value: 'value := "$" path?',
    path: 'path := ( "." segment | "[" (index | quoted) "]" )*',
    template: 'template := text ("${" value "}" text)*',
    ruleSet: 'rule-set := "[" rule ("," rule)* "]"',
    rule: 'rule := "{" "fieldId" ":" value "," "operator" ":" operator ("," "compareValue" ":" json)? ("," "relation" ":" ("&&"|"||"))? "}"',
    assertion: 'assertion := "function assert(engine,nodeDoc,nodeId,indoc) {" statement* "return" ("0"|"1") ";" "}"',
    edgeCondition: 'edge-condition := "0" | "10" | condition-code',
  },
  operators: Object.keys(stats.operators).length ? stats.operators : {
    isNull: 1, notNull: 1, '==': 1, '!=': 1, '>': 1, '>=': 1, '<': 1, '<=': 1, 'length=': 1, contains: 1,
  },
  conditionCodes: Object.keys(stats.conditionCodes).length ? stats.conditionCodes : { '0': 1 },
  rules: {
    pathMustStartWithDollar: true,
    emptySegmentForbidden: true,
    ruleUnknownOperatorIsError: true,
    assertionMustReturn01: true,
    assertionBannedApis: ['require', 'import', 'process', 'child_process', 'fs', 'net', 'eval', 'new Function', 'while(true)'],
  },
  examples: {
    path: ['$.data.id', '$.data.list[0].id', "$['data']['id']", '${$.global.token}'],
    template: ['https://api.example.com/${$.path}', "select * from t where id='${$.id}'"],
    rules: '[{"fieldId":"$.data.amount","operator":">","compareValue":"1000"}]',
    assertion: 'function assert(engine,nodeDoc,nodeId,indoc){ if(indoc.get("id")==null){return 1;} return 0; }',
  },
};

mkdirSync(join(REPO, 'catalog'), { recursive: true });
writeFileSync(join(REPO, 'catalog', 'expression-grammar.json'), JSON.stringify(grammar, null, 1) + '\n');
writeFileSync(join(REPO, 'catalog', 'expression-regression.json'), JSON.stringify({ generatedAt: new Date().toISOString(), count: cases.length, cases }, null, 1) + '\n');

// 自检：50 条全部可解析
let failed = 0;
for (const c of cases) {
  try {
    if (c.kind === 'path') parsePath(c.expr);
    if (c.kind === 'rules') {
      const issues = validateRules(c.rules);
      if (issues.length) throw new Error(issues.join('; '));
    }
    if (c.kind === 'script' && !c.expectedOk) throw new Error('脚本静态检查未通过');
  } catch (e) {
    failed++;
    console.error('✖', c.id, e.message);
  }
}
console.log(`表达式契约：flows=${stats.flows} props=${stats.props} routes=${stats.routes} path=${stats.pathSamples} template=${stats.templateSamples} rules=${stats.ruleArrays} scripts=${stats.scripts}`);
console.log(`回归样本 ${cases.length} 条，失败 ${failed} 条`);
process.exit(failed === 0 ? 0 : 1);
