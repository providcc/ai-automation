/**
 * expression：取值表达式 / 规则条件 / 断言脚本 / 连线条件码（纯本地静态检查）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePath,
  evaluatePath,
  findTemplateExpressions,
  renderTemplate,
  evaluateTemplateExpression,
  normalizeFieldId,
  parseRuleCondition,
  evaluateRule,
  evaluateRules,
  validateRules,
  validateAssertScript,
  compileCondition,
  describeCondition,
  RULE_OPERATORS,
  CONDITION_CODES,
} from '../../packages/core/src/expression.ts';

const DATA = { data: { list: [{ id: 1, name: 'a' }], total: 3 }, 'custentity_x': { id: 'c1' }, empty: '' };

test('expression：parsePath 支持多种取值写法', () => {
  assert.deepEqual(parsePath('$').segments, []);
  assert.deepEqual(parsePath('$.a.b').segments, ['a', 'b']);
  assert.deepEqual(parsePath('$.a.0.b').segments, ['a', 0, 'b']);
  assert.deepEqual(parsePath("$['a']").segments, ['a']);
  assert.deepEqual(parsePath('$["a"].b').segments, ['a', 'b']);
  assert.deepEqual(parsePath('${$.a.b}').segments, ['a', 'b']);
  assert.deepEqual(parsePath('$0').segments, [0]);
  assert.deepEqual(parsePath('$foo').segments, ['foo']);
  assert.equal(parsePath('${$.a.b}').raw, '${$.a.b}');
});

test('expression：parsePath 非法输入抛错', () => {
  assert.throws(() => parsePath('abc'), /必须以 \$ 开头/);
  assert.throws(() => parsePath('$.'), /空路径段/);
  assert.throws(() => parsePath('$.a.'), /空路径段/);
  assert.throws(() => parsePath('$[a'), /缺少 \]/);
  assert.throws(() => parsePath('$[]'), /空下标/);
  assert.throws(() => parsePath("$['a"), /缺少 \]/);
});

test('expression：evaluatePath 取值与缺失', () => {
  assert.equal(evaluatePath(DATA, '$.data.total'), 3);
  assert.equal(evaluatePath(DATA, '$.data.list.0.id'), 1);
  assert.equal(evaluatePath(DATA, "$['custentity_x'].id"), 'c1');
  assert.equal(evaluatePath(DATA, '$.nope'), undefined);
  assert.equal(evaluatePath(DATA, '$.data.list.9.id'), undefined);
  assert.equal(evaluatePath({ a: null }, '$.a.b'), undefined);
  assert.equal(evaluatePath(DATA, parsePath('$.data.total')), 3);
});

test('expression：findTemplateExpressions 提取占位符', () => {
  assert.deepEqual(findTemplateExpressions('a ${x} b ${y.z}'), ['x', 'y.z']);
  assert.deepEqual(findTemplateExpressions('没有占位符'), []);
});

test('expression：renderTemplate 渲染取值', () => {
  assert.equal(renderTemplate('https://x/${$.data.list.0.name}', DATA), 'https://x/a');
  assert.equal(renderTemplate('${$.data.total}', DATA), '3');
  assert.equal(renderTemplate('${$.empty}', DATA), '');
  assert.equal(renderTemplate('${$.nope}', DATA), '');
  assert.equal(renderTemplate('${$.data}', DATA), '{"list":[{"id":1,"name":"a"}],"total":3}');
  assert.equal(renderTemplate('非法 ${abc} 表达式', DATA), '非法  表达式');
  assert.equal(renderTemplate('空 ${} 表达式', DATA), '空  表达式');
});

test('expression：evaluateTemplateExpression 支持带包裹与不带包裹', () => {
  assert.equal(evaluateTemplateExpression('${$.data.total}', DATA), 3);
  assert.equal(evaluateTemplateExpression('$.data.total', DATA), 3);
  assert.equal(evaluateTemplateExpression('  ${$.data.total}  ', DATA), 3);
});

test('expression：normalizeFieldId 归一字段 id', () => {
  assert.equal(normalizeFieldId('$.a'), '$.a');
  assert.equal(normalizeFieldId('a.b'), '$.a.b');
});

test('expression：parseRuleCondition 解析规则数组', () => {
  const arr = [{ fieldId: '$.a', operator: '==', compareValue: 1 }];
  assert.deepEqual(parseRuleCondition(arr), arr);
  assert.deepEqual(parseRuleCondition(''), []);
  assert.deepEqual(parseRuleCondition('   '), []);
  assert.deepEqual(parseRuleCondition('[{"fieldId":"$.a"}]'), [{ fieldId: '$.a' }]);
  assert.throws(() => parseRuleCondition('not json'), /不是合法 JSON/);
  assert.throws(() => parseRuleCondition('{"a":1}'), /必须是数组/);
});

test('expression：evaluateRule 空值类运算符', () => {
  const d = { a: null, b: undefined, c: '', e: 'x' };
  assert.equal(evaluateRule({ operator: 'isNull', fieldId: '$.a' }, d), true);
  assert.equal(evaluateRule({ operator: 'isNull', fieldId: '$.b' }, d), true);
  assert.equal(evaluateRule({ operator: 'isNull', fieldId: '$.c' }, d), true);
  assert.equal(evaluateRule({ operator: 'isNull', fieldId: '$.e' }, d), false);
  assert.equal(evaluateRule({ operator: 'notNull', fieldId: '$.e' }, d), true);
  assert.equal(evaluateRule({ operator: 'notNull', fieldId: '$.a' }, d), false);
});

test('expression：evaluateRule 长度类运算符', () => {
  const d = { s: 'abc', arr: [1, 2], obj: { k: 1 }, emptyObj: {}, emptyArr: [], nil: null, num: 42 };
  assert.equal(evaluateRule({ operator: 'isEmpty', fieldId: '$.emptyObj' }, d), true);
  assert.equal(evaluateRule({ operator: 'isEmpty', fieldId: '$.emptyArr' }, d), true);
  assert.equal(evaluateRule({ operator: 'isEmpty', fieldId: '$.nil' }, d), true);
  assert.equal(evaluateRule({ operator: 'isEmpty', fieldId: '$.obj' }, d), false);
  assert.equal(evaluateRule({ operator: 'notEmpty', fieldId: '$.s' }, d), true);
  assert.equal(evaluateRule({ operator: 'notEmpty', fieldId: '$.emptyObj' }, d), false);
  assert.equal(evaluateRule({ operator: 'length=', fieldId: '$.s', compareValue: 3 }, d), true);
  assert.equal(evaluateRule({ operator: 'length>', fieldId: '$.s', compareValue: 2 }, d), true);
  assert.equal(evaluateRule({ operator: 'length<', fieldId: '$.s', compareValue: 3 }, d), false);
  assert.equal(evaluateRule({ operator: 'length>=', fieldId: '$.s', compareValue: 3 }, d), true);
  assert.equal(evaluateRule({ operator: 'length<=', fieldId: '$.s', compareValue: 3 }, d), true);
  assert.equal(evaluateRule({ operator: 'length=', fieldId: '$.arr', compareValue: 2 }, d), true);
  assert.equal(evaluateRule({ operator: 'length=', fieldId: '$.num', compareValue: 2 }, d), true);
});

test('expression：evaluateRule 比较类运算符（数字与字符串）', () => {
  const d = { n: 10, s: 'abc', ns: '10' };
  assert.equal(evaluateRule({ operator: '==', fieldId: '$.n', compareValue: 10 }, d), true);
  assert.equal(evaluateRule({ operator: '==', fieldId: '$.ns', compareValue: 10 }, d), true);
  assert.equal(evaluateRule({ operator: '==', fieldId: '$.s', compareValue: 'abc' }, d), true);
  assert.equal(evaluateRule({ operator: '!=', fieldId: '$.s', compareValue: 'x' }, d), true);
  assert.equal(evaluateRule({ operator: '>', fieldId: '$.n', compareValue: 9 }, d), true);
  assert.equal(evaluateRule({ operator: '>', fieldId: '$.s', compareValue: 'abb' }, d), true);
  assert.equal(evaluateRule({ operator: '>=', fieldId: '$.n', compareValue: 10 }, d), true);
  assert.equal(evaluateRule({ operator: '<', fieldId: '$.n', compareValue: 11 }, d), true);
  assert.equal(evaluateRule({ operator: '<=', fieldId: '$.n', compareValue: 10 }, d), true);
});

test('expression：evaluateRule 字符串/集合/布尔运算符', () => {
  const d = { s: 'hello world', t: true, f: false, one: '1', zero: '0' };
  assert.equal(evaluateRule({ operator: 'contains', fieldId: '$.s', compareValue: 'world' }, d), true);
  assert.equal(evaluateRule({ operator: 'notContains', fieldId: '$.s', compareValue: 'zzz' }, d), true);
  assert.equal(evaluateRule({ operator: 'startsWith', fieldId: '$.s', compareValue: 'hello' }, d), true);
  assert.equal(evaluateRule({ operator: 'endsWith', fieldId: '$.s', compareValue: 'world' }, d), true);
  assert.equal(evaluateRule({ operator: 'matches', fieldId: '$.s', compareValue: '^hello' }, d), true);
  assert.equal(evaluateRule({ operator: 'matches', fieldId: '$.s', compareValue: '([' }, d), false);
  assert.equal(evaluateRule({ operator: 'in', fieldId: '$.s', compareValue: ['hello world', 'x'] }, d), true);
  assert.equal(evaluateRule({ operator: 'in', fieldId: '$.s', compareValue: 'a, hello world' }, d), true);
  assert.equal(evaluateRule({ operator: 'notIn', fieldId: '$.s', compareValue: ['x'] }, d), true);
  assert.equal(evaluateRule({ operator: 'notIn', fieldId: '$.s', compareValue: 'x,y' }, d), true);
  assert.equal(evaluateRule({ operator: 'isTrue', fieldId: '$.t' }, d), true);
  assert.equal(evaluateRule({ operator: 'isTrue', fieldId: '$.one' }, d), true);
  assert.equal(evaluateRule({ operator: 'isFalse', fieldId: '$.f' }, d), true);
  assert.equal(evaluateRule({ operator: 'isFalse', fieldId: '$.zero' }, d), true);
});

test('expression：evaluateRule 未知运算符返回 false', () => {
  assert.equal(evaluateRule({ operator: 'wat', fieldId: '$.s' }, { s: 'x' }), false);
  assert.equal(evaluateRule({}, { s: 'x' }), false);
});

test('expression：evaluateRules 处理 && 与 || 分组', () => {
  assert.equal(evaluateRules([], {}), true);
  const data = { a: 1, b: 2 };
  assert.equal(
    evaluateRules([
      { fieldId: '$.a', operator: '==', compareValue: 1 },
      { fieldId: '$.b', operator: '==', compareValue: 2 },
    ], data),
    true,
  );
  assert.equal(
    evaluateRules([
      { fieldId: '$.a', operator: '==', compareValue: 9 },
      { fieldId: '$.b', operator: '==', compareValue: 2 },
    ], data),
    false,
  );
  assert.equal(
    evaluateRules([
      { fieldId: '$.a', operator: '==', compareValue: 9 },
      { fieldId: '$.b', operator: '==', compareValue: 2, relation: '||' },
    ], data),
    true,
  );
});

test('expression：validateRules 检查缺字段/非法路径/未知运算符/非法连接符', () => {
  assert.deepEqual(validateRules([{ fieldId: '$.a', operator: '==' }]), []);
  assert.match(validateRules([{ operator: '==' }])[0], /缺少 fieldId/);
  assert.match(validateRules([{ fieldId: '$.a[' }])[0], /路径非法/);
  assert.match(validateRules([{ fieldId: '$.a' }])[0], /缺少 operator/);
  assert.match(validateRules([{ fieldId: '$.a', operator: 'wat' }])[0], /未知运算符/);
  assert.match(validateRules([{ fieldId: '$.a', operator: '==', relation: 'xor' }])[0], /非法连接符/);
  assert.ok(RULE_OPERATORS.includes('=='));
  assert.ok('0' in CONDITION_CODES);
});

test('expression：validateAssertScript 检查危险脚本', () => {
  const good = validateAssertScript("function assert(engine,nodeDoc,nodeId,indoc){ return engine.get('x') === 1 ? 1 : 0; }");
  assert.equal(good.ok, true);
  assert.deepEqual(good.reads.engine, ['x']);
  assert.deepEqual(good.reads.indoc, []);

  const dup = validateAssertScript("function assert(engine,nodeDoc,nodeId,indoc){ return engine.get('x') + indoc.get('x') + indoc.get('y'); }");
  assert.deepEqual(dup.reads.engine, ['x']);
  assert.deepEqual(dup.reads.indoc, ['x', 'y']);

  assert.ok(validateAssertScript('var a = 1;').issues.some((i) => i.includes('function assert')));
  assert.ok(validateAssertScript('function assert(engine,nodeDoc,nodeId,indoc){ var a = 1; }').issues.some((i) => i.includes('应返回')));
});

test('expression：validateAssertScript 拦截危险调用', () => {
  const cases: [string, string][] = [
    ['require("fs")', 'require()'],
    ['import x from "y"', 'import'],
    ['process.exit(1)', 'process'],
    ['child_process.exec("x")', 'child_process'],
    ['fs.readFileSync("x")', '系统/网络模块'],
    ['eval("1")', 'eval()'],
    ['new Function("x")', 'new Function()'],
    ['while (true) {}', 'while(true)'],
    ['for (;;) {}', '空 for'],
  ];
  for (const [code, msg] of cases) {
    const r = validateAssertScript(`function assert(engine,nodeDoc,nodeId,indoc){ ${code}; return 1; }`);
    assert.ok(r.ok === false, `${code} 应当被拦截`);
    assert.ok(r.issues.some((i) => i.includes(msg)), `${code} 期望提示 ${msg}，实际 ${JSON.stringify(r.issues)}`);
  }
});

test('expression：compileCondition 解析条件码', () => {
  assert.deepEqual(compileCondition({ assertCondition: '0' }), { code: '0', kind: 'always' });
  assert.deepEqual(compileCondition({ code: '10' }), { code: '10', kind: 'forbid' });
  assert.deepEqual(compileCondition({ code: 0 }), { code: '0', kind: 'always' });
});

test('expression：compileCondition 脚本/规则/未知条件', () => {
  const script = compileCondition({ assertCondition: '3', condition: 'function assert(){return 1;}' });
  assert.equal(script.kind, 'script');
  assert.equal(script.script, 'function assert(){return 1;}');
  assert.ok(script.note);

  const rawScript = compileCondition({ assertCondition: '3', raw: 'function assert(){return 1;}' });
  assert.equal(rawScript.kind, 'script');

  const rules = compileCondition({ assertCondition: '1', rules: [{ fieldId: '$.a', operator: '==' }] });
  assert.equal(rules.kind, 'rules');
  assert.equal(rules.rules?.length, 1);

  const routerRules = compileCondition({ assertCondition: '1', routerCondition: '[{"fieldId":"$.a"}]' });
  assert.equal(routerRules.kind, 'rules');
  assert.equal(routerRules.raw, '[{"fieldId":"$.a"}]');

  const badRouter = compileCondition({ assertCondition: '1', routerCondition: 'not json' });
  assert.equal(badRouter.kind, 'unknown');
  assert.ok(badRouter.note?.includes('routerCondition'));

  const builtin = compileCondition({ assertCondition: '7' });
  assert.equal(builtin.kind, 'builtin');
  assert.equal(builtin.note, CONDITION_CODES['7']);

  const unknown = compileCondition({ assertCondition: '99' });
  assert.equal(unknown.kind, 'builtin');
  assert.equal(unknown.note, '未记录的条件码 99');
});

test('expression：describeCondition 输出摘要', () => {
  assert.equal(describeCondition({ code: '0', kind: 'always' }), '始终执行');
  assert.equal(describeCondition({ code: '10', kind: 'forbid' }), '禁止执行');
  assert.match(describeCondition({ code: '3', kind: 'script', script: 'function assert(e,n,i,d){ return e.get("a"); }' }), /断言脚本/);
  assert.match(describeCondition({ code: '1', kind: 'script', script: 'bad' }), /静态检查有问题/);
  assert.equal(describeCondition({ code: '1', kind: 'rules', rules: [{ fieldId: '$.a' }] }), '规则条件（1 条）');
  assert.equal(describeCondition({ code: '1', kind: 'rules' }), '规则条件（0 条）');
  assert.equal(describeCondition({ code: '7', kind: 'builtin', note: '网关默认分支' }), '网关默认分支');
  assert.equal(describeCondition({ code: '9', kind: 'builtin' }), '条件码 9');
});
