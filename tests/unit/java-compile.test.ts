import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJavaClassPath, decodeCompilerMessage } from '../../packages/core/src/java-compile.ts';

test('parseJavaClassPath：package + public class → 全限定类名', () => {
  const code = `package cn.restcloud.esb;\n\npublic class ESB_abc123 implements IESBBaseEvent {\n}`;
  assert.equal(parseJavaClassPath(code), 'cn.restcloud.esb.ESB_abc123');
});

test('parseJavaClassPath：缺 package 或缺 class 时返回 undefined（不能瞎猜）', () => {
  assert.equal(parseJavaClassPath('public class A {}'), undefined);
  assert.equal(parseJavaClassPath('package a.b;'), undefined);
  assert.equal(parseJavaClassPath(''), undefined);
});

test('parseJavaClassPath：class 前有修饰符、extends 也能解析', () => {
  const code = `package p.q;\npublic final class Foo extends Bar implements Baz {}`;
  assert.equal(parseJavaClassPath(code), 'p.q.Foo');
});

test('decodeCompilerMessage：URL 编码的 javac 报错要能还原成人能读的样子', () => {
  // 平台把 javac 报错 URL 编码后塞进 msg，不解码的话全是 %E4%BB%A3 这种
  const raw = '%E4%BB%A3%E7%A0%81%3A%5Bcompiler.err.expected%5D<br>%E9%94%99%E8%AF%AF%E8%A1%8C%3A%5B1%5D';
  const out = decodeCompilerMessage(raw);
  assert.match(out, /代码/);
  assert.match(out, /错误行/);
  assert.equal(/%E4%BB/.test(out), false, '不该残留 URL 编码');
  assert.equal(/<br>/i.test(out), false, '不该残留 HTML 标签');
});

test('decodeCompilerMessage：不是合法百分号编码时按原文返回，不抛', () => {
  assert.equal(decodeCompilerMessage('100% 出错'), '100% 出错');
  assert.equal(decodeCompilerMessage(''), '');
  assert.equal(decodeCompilerMessage(undefined), '');
});

// ─────────────────────── compileJavaCode / compileJavaNodes ───────────────────────

import { compileJavaCode, compileJavaNodes, javaNodesWithCode } from '../../packages/core/src/java-compile.ts';
import { stub, ok, fail } from './helpers.ts';

const CODE = `package cn.restcloud.esb;\npublic class ESB_x implements IESBBaseEvent {}`;

test('compileJavaCode：顺序固定为「写源文件 → 编译」，两个端点都要调', async () => {
  const { client, calls } = stub(() => ok({}));
  const r = await compileJavaCode(client, { code: CODE });
  assert.equal(r.ok, true);
  assert.equal(r.classPath, 'cn.restcloud.esb.ESB_x');
  assert.equal(r.written, true);
  assert.equal(r.compiled, true);
  const paths = calls.map((c) => c.path);
  assert.deepEqual(paths, [
    '/rest/core/coderepository/srcfile/overcode/classpath',
    '/rest/esb/coderepository/compile/check',
  ], '必须先写源文件再编译（顺序反了会编译旧源码）');
});

test('compileJavaCode：写源文件失败就不该继续编译', async () => {
  const { client, calls } = stub((path) => (path.includes('overcode') ? fail('磁盘写不进去') : ok({})));
  const r = await compileJavaCode(client, { code: CODE });
  assert.equal(r.ok, false);
  assert.equal(r.written, false);
  assert.equal(r.compiled, false);
  assert.equal(calls.filter((c) => c.path.includes('compile')).length, 0, '没写成文件就不该编译');
});

test('compileJavaCode：编译失败要把 javac 报错解出来（不是 URL 编码串）', async () => {
  const encoded = '%E4%BB%A3%E7%A0%81%3A%5Bcompiler.err.expected%5D<br>%E9%94%99%E8%AF%AF%E8%A1%8C%3A%5B1%5D';
  const { client } = stub((path) => (path.includes('compile') ? fail(encoded) : ok({})));
  const r = await compileJavaCode(client, { code: CODE });
  assert.equal(r.ok, false);
  assert.equal(r.written, true);
  assert.equal(r.compiled, false);
  assert.match(r.compileError ?? '', /错误行/);
  assert.equal(/%E4%BB/.test(r.compileError ?? ''), false, '不该残留 URL 编码');
});

test('compileJavaCode：解析不出 classPath 时明确报错，不去瞎猜', async () => {
  const { client, calls } = stub(() => ok({}));
  await assert.rejects(
    () => compileJavaCode(client, { code: 'class Foo {}' }),
    (e: Error) => {
      assert.match(e.message, /classPath/);
      return true;
    },
  );
  assert.equal(calls.length, 0, '解析失败不该发请求');
});

test('compileJavaNodes：逐个编译，一个失败不影响其它节点', async () => {
  const { client } = stub((path) => (path.includes('compile') ? fail('编译不过') : ok({})));
  const r = await compileJavaNodes(client, {
    nodeProps: [
      { nodeId: 'T1', nodeType: 'javaCodeNode', props: { code: CODE } },
      { nodeId: 'T2', nodeType: 'javaCodeNode', props: { code: CODE } },
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(r.results.length, 2);
  assert.deepEqual(r.nodeIds, ['T1', 'T2']);
});

test('javaNodesWithCode：只挑出带 code 的 javaCodeNode', () => {
  const picked = javaNodesWithCode([
    { nodeId: 'T1', nodeType: 'javaCodeNode', props: { code: 'x' } },
    { nodeId: 'T2', nodeType: 'javaCodeNode', props: {} },
    { nodeId: 'T3', nodeType: 'apiNode', props: { code: 'x' } },
  ]);
  assert.deepEqual(picked.map((p) => p.nodeId), ['T1']);
});
