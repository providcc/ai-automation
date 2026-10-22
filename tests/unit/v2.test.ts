import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePath, evaluatePath, renderTemplate, findTemplateExpressions, evaluateRules, validateRules,
  validateAssertScript, compileCondition, describeCondition, evaluateTemplateExpression,
} from '../../packages/core/src/expression.ts';
import {
  computeCatalogFingerprint, writeFingerprint, readFingerprint, diffFingerprints,
} from '../../packages/core/src/fingerprint.ts';
import { explainError, explainHttpError } from '../../packages/core/src/error-catalog.ts';
import { runBatch } from '../../packages/core/src/batch.ts';
import { reviewFlow, reviewApiBundle } from '../../packages/core/src/review.ts';
import { flowFromNl } from '../../packages/core/src/nl-flow.ts';
import { buildProcessModel } from '../../packages/core/src/flow-build.ts';
import { validateFlow } from '../../packages/core/src/flow-validate.ts';
import { buildEtlDependencies } from '../../packages/core/src/etl-compensate.ts';
import { maskConnector } from '../../packages/core/src/connector.ts';

const regressionFile = new URL('../../catalog/expression-regression.json', import.meta.url);
const repoCatalog = new URL('../../catalog/', import.meta.url).pathname;

test('表达式回归：50 条归一化样本全部通过', async () => {
  const doc = JSON.parse(await readFile(regressionFile, 'utf8')) as { count: number; cases: any[] };
  assert.equal(doc.count, 50);
  for (const c of doc.cases) {
    if (c.kind === 'path') {
      const parsed = parsePath(c.expr);
      assert.ok(parsed.segments.length >= 0);
      assert.deepEqual(evaluatePath(c.data, c.expr), c.expected, c.id);
      assert.deepEqual(evaluateTemplateExpression(c.expr, c.data), c.expected, c.id);
    } else if (c.kind === 'template') {
      assert.equal(renderTemplate(c.expr, c.data), c.expected, c.id);
    } else if (c.kind === 'rules') {
      assert.deepEqual(validateRules(c.rules), [], c.id);
      assert.equal(evaluateRules(c.rules, c.data), c.expected, c.id);
    } else if (c.kind === 'script') {
      assert.equal(validateAssertScript(c.expr).ok, c.expectedOk, c.id);
    } else {
      assert.fail(`未知样本类型：${c.kind}`);
    }
  }
});

test('表达式：非法路径与条件码', () => {
  assert.throws(() => parsePath('data.id'), /必须以 \$ 开头/);
  assert.throws(() => parsePath('$.a..b'), /空路径段/);
  assert.deepEqual(parsePath("$['a.b'][0]").segments, ['a.b', 0]);
  assert.equal(findTemplateExpressions('x=${$.a} y=${$.b.c}').length, 2);
  const always = compileCondition({ code: '0' });
  assert.equal(always.kind, 'always');
  assert.match(describeCondition(always), /始终/);
  const forbid = compileCondition({ code: '10' });
  assert.equal(forbid.kind, 'forbid');
  const script = compileCondition({ code: '3', raw: 'function assert(engine,nodeDoc,nodeId,indoc){return 1;}' });
  assert.equal(script.kind, 'script');
  assert.ok(script.script?.includes('function assert'));
  const rules = compileCondition({ code: '1', rules: [{ fieldId: '$.a', operator: '==', compareValue: 1 }] });
  assert.equal(rules.kind, 'rules');
});

test('目录指纹：生成、读取与漂移', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rc-fp-'));
  try {
    await writeFile(join(dir, 'endpoints.json'), JSON.stringify({ endpoints: [{ path: '/a' }] }));
    await writeFile(join(dir, 'components.json'), JSON.stringify({ nodes: [{ id: 'start' }] }));
    await writeFile(join(dir, 'etl-components.json'), JSON.stringify({ nodes: [] }));
    const fp1 = computeCatalogFingerprint(dir);
    assert.equal(fp1.files.length, 3);
    const file = join(dir, 'fingerprint.json');
    writeFingerprint(file, fp1);
    const loaded = readFingerprint(file);
    assert.equal(loaded.digest, fp1.digest);
    await writeFile(join(dir, 'endpoints.json'), JSON.stringify({ endpoints: [{ path: '/a' }, { path: '/b' }] }));
    const fp2 = computeCatalogFingerprint(dir);
    const diff = diffFingerprints(loaded, fp2);
    assert.equal(diff.digestChanged, true);
    assert.deepEqual(diff.changed, ['endpoints.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('错误目录：匹配平台文案与 HTTP 兜底', () => {
  const e = explainError('节点[T00001]没有设置属性');
  assert.equal(e.matched, true);
  assert.equal(e.category, '流程图');
  assert.match(e.action, /属性/);
  const unknown = explainError('zzz totally unknown error 42');
  assert.equal(unknown.matched, false);
  assert.equal(explainHttpError(401, '未授权').category, '认证');
  assert.equal(explainHttpError(500, '未知错误').category, '平台内部错误');
});

test('批处理：重试、失败汇总与断点续跑', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rc-batch-'));
  const progress = join(dir, 'progress.jsonl');
  try {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    let bTries = 0;
    const r1 = await runBatch(items, async (item) => {
      if (item.id === 'b') {
        bTries++;
        if (bTries === 1) return { ok: false, error: 'flaky' };
      }
      return { ok: true, result: item.id };
    }, { concurrency: 1, retry: 1, retryDelayMs: 1, progressFile: progress });
    assert.equal(r1.ok, true);
    assert.equal(r1.passed, 3);
    assert.equal(r1.failed, 0);
    const r2 = await runBatch(items, async () => ({ ok: true }), { concurrency: 2, progressFile: progress });
    assert.equal(r2.skipped, 3);
    assert.equal(r2.passed, 0);
    const r3 = await runBatch([{ id: 'x' }, { id: 'y' }], async (item) => item.id === 'y' ? { ok: false, error: 'boom' } : { ok: true }, { concurrency: 1 });
    assert.equal(r3.ok, false);
    assert.equal(r3.failed, 1);
    assert.equal(r3.items.find((x) => x.id === 'y')?.error, 'boom');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('评审：安全与生产门槛', () => {
  const { model } = buildProcessModel({
    nodes: [
      { nodeType: 'start' },
      { nodeType: 'apiNode', key: 'T00001' },
      { nodeType: 'end' },
    ],
    edges: [
      { from: 'E00001', to: 'T00001' },
      { from: 'T00001', to: 'E00002' },
    ],
  });
  const clean = reviewFlow(model, { knownTypes: new Set(['start', 'end', 'apiNode']), nodeProps: { T00001: { apiUrl: 'https://api.example.com/x', retryNum: '2', connectTimeout: '10' } } });
  assert.equal(clean.ok, true, JSON.stringify(clean.findings));
  const dirty = reviewFlow(model, {
    knownTypes: new Set(['start', 'end', 'apiNode']),
    nodeProps: { T00001: { apiUrl: 'http://localhost/x', password: 'plain' } },
  });
  assert.equal(dirty.ok, false);
  assert.ok(dirty.findings.some((f) => f.code === 'SECRET_FIELD'));
  assert.ok(dirty.findings.some((f) => f.code === 'LOCALHOST'));
  const mock = buildProcessModel({
    nodes: [{ nodeType: 'start' }, { nodeType: 'mockResponseNode' }, { nodeType: 'end' }],
    edges: [{ from: 'E00001', to: 'T00001' }, { from: 'T00001', to: 'E00002' }],
  }).model;
  const prod = reviewFlow(mock, { knownTypes: new Set(['start', 'end', 'mockResponseNode']), production: true });
  assert.equal(prod.ok, false);
  const api = reviewApiBundle({ services: [
    { id: '1', mapUrl: '/rest/a', methodType: 'GET', configName: 'A' },
    { id: '2', mapUrl: '/rest/a', methodType: 'GET', configName: 'B' },
  ] });
  assert.equal(api.ok, false);
  assert.ok(api.findings.some((f) => f.code === 'API_DUP'));
});

test('自然语言生成：离线规则可用且结构合法', async () => {
  const res = await flowFromNl('调用订单接口 https://api.example.com/orders GET 然后返回结果', { useLlm: false });
  assert.equal(res.ok, true, JSON.stringify(res.warnings));
  assert.equal(res.kind, 'esb');
  assert.equal(res.pattern, 'sync-api');
  const { model } = buildProcessModel(res.input);
  const issues = validateFlow(model, { knownTypes: new Set(['start', 'end', 'apiNode']) });
  assert.equal(issues.filter((i) => i.level === 'error').length, 0, JSON.stringify(issues));
});

test('ETL 依赖深度：父流程先执行', () => {
  const deps = buildEtlDependencies([
    { processId: 'a' },
    { processId: 'b', parentProcessId: 'a' },
    { processId: 'c', parentProcessId: 'b' },
  ]);
  const byId = Object.fromEntries(deps.map((d) => [d.processId, d]));
  assert.equal(byId.a.depth, 0);
  assert.equal(byId.b.depth, 1);
  assert.equal(byId.c.depth, 2);
  assert.deepEqual(byId.b.dependsOn, ['a']);
});

test('连接器脱敏：密码/密钥不落输出', () => {
  const masked = maskConnector({ id: '1', password: 'p', nested: { clientSecret: 's', name: 'n' } });
  assert.equal(masked.password, '***');
  assert.equal(masked.nested.clientSecret, '***');
  assert.equal(masked.nested.name, 'n');
});

test('真实目录关键文件存在且可解析', async () => {
  for (const f of ['endpoints.json', 'components.json', 'etl-components.json', 'node-driver-map.json', 'expression-grammar.json', 'flow-templates/index.json']) {
    const raw = await readFile(join(repoCatalog, f), 'utf8');
    assert.ok(JSON.parse(raw), f);
  }
});
