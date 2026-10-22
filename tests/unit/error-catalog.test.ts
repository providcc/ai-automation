/**
 * error-catalog：错误文案 → 分类 + 可执行修复步骤
 * 匹配顺序：精确映射 → 包含映射 → 关键词规则 → HTTP 兜底
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  explainError,
  explainHttpError,
  formatExplain,
  listErrorActions,
  listErrorMap,
  loadErrorMap,
  loadErrorMessages,
  BUILTIN_ACTIONS,
} from '../../packages/core/src/error-catalog.ts';

test('error-catalog：空文案返回未匹配', () => {
  const r = explainError('');
  assert.equal(r.matched, false);
  assert.equal(r.category, '未知');
  assert.equal(r.message, '');
  assert.match(r.action, /traceId/);
});

test('error-catalog：null/undefined 文案按空串处理', () => {
  for (const v of [null, undefined]) {
    const r = explainError(v as any);
    assert.equal(r.matched, false);
    assert.equal(r.category, '未知');
    assert.equal(r.message, '');
  }
});

test('error-catalog：精确映射命中', () => {
  const r = explainError('上一任务还没有结束,本任务存在重复执行排队问题');
  assert.equal(r.matched, true);
  assert.equal(r.category, '任务调度');
  assert.ok(r.action.length > 0);
  assert.ok((r.classes ?? []).length > 0);
});

test('error-catalog：精确映射带同族错误（related）', () => {
  const r = explainError('不可重复');
  assert.equal(r.matched, true);
  assert.ok((r.related ?? []).includes('配置名称不可重复'), JSON.stringify(r.related));
});

test('error-catalog：包含映射（最长非通用文案优先）', () => {
  const r = explainError('上传文件不能为空，且文件太大');
  assert.equal(r.matched, true);
  assert.equal(r.category, '文件');
  assert.deepEqual(r.related, ['上传文件不能为空']);
});

test('error-catalog：关键词规则兜底', () => {
  const r = explainError('数据库连接失败');
  assert.equal(r.matched, true);
  assert.equal(r.category, '网络/数据源');
  assert.ok(r.action.length > 0);
});

test('error-catalog：未收录文案', () => {
  const r = explainError('这是一条从未收录过的奇怪错误');
  assert.equal(r.matched, false);
  assert.equal(r.category, '未收录');
  assert.match(r.action, /不在错误目录中/);
});

test('error-catalog：listErrorActions / listErrorMap 返回副本且包含内置规则', () => {
  const actions = listErrorActions();
  assert.ok(actions.length >= BUILTIN_ACTIONS.length);
  assert.ok(actions.some((a) => a.pattern === '节点.*没有设置属性'));
  assert.notEqual(actions, listErrorActions(), '应返回新数组');

  const map = listErrorMap();
  assert.ok(map.length > 0);
  assert.notEqual(map, listErrorMap());
  assert.equal(loadErrorMap().length, map.length);
  assert.ok(loadErrorMessages().length > 0);
});

test('error-catalog：explainHttpError 处理 401/403/404/429/5xx/其它', () => {
  const auth = explainHttpError(401, '登录失败', 'trace-1');
  assert.equal(auth.matched, true);
  assert.equal(auth.category, '认证');
  assert.match(auth.action, /traceId=trace-1/);

  const forbidden = explainHttpError(403);
  assert.equal(forbidden.category, '认证');

  const missing = explainHttpError(404, '资源不存在');
  assert.equal(missing.category, '资源不存在');
  assert.equal(missing.matched, true);

  const limited = explainHttpError(429);
  assert.equal(limited.category, '限流');

  const server = explainHttpError(500, '这是一条从未收录过的奇怪错误');
  assert.equal(server.category, '平台内部错误');
  assert.equal(server.matched, true);

  const platformErr = explainHttpError(500, '保存失败');
  assert.equal(platformErr.category, '平台内部错误');

  const classified = explainHttpError(500, '不可重复');
  assert.equal(classified.category, '资源冲突');
  assert.match(classified.action, /查重/);

  const okStatus = explainHttpError(200, '不可重复');
  assert.equal(okStatus.category, '资源冲突');
  assert.equal(okStatus.matched, true);

  const other = explainHttpError(400, '不可重复');
  assert.equal(other.category, '资源冲突');
  assert.equal(other.matched, true);
});

test('error-catalog：formatExplain 输出多行文本', () => {
  const e = explainError('不可重复');
  const text = formatExplain(e);
  assert.ok(text.includes('错误：不可重复'));
  assert.ok(text.includes('分类：'));
  assert.ok(text.includes('建议：'));
  assert.ok(text.includes('来源：'));
  assert.ok(text.includes('相关：'));

  const rule = explainError('节点 abc 没有设置属性');
  const ruleText = formatExplain(rule);
  assert.ok(ruleText.includes('文档：'), '关键词规则带文档链接');

  const empty = formatExplain(explainError(''));
  assert.ok(empty.includes('错误：(无文案)'));
});
