/**
 * SQL 校验（只解析不执行）：只读约束、平台报错归一、列清单解析。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSql, isReadOnlySql, extractDbError, classifySqlError, formatSqlCheck, querySql } from '../../packages/core/src/sql-check.ts';
import { stub, ok } from './helpers.ts';

test('只读约束：只接受 SELECT/WITH/SHOW/EXPLAIN/DESCRIBE', () => {
  assert.equal(isReadOnlySql('select 1'), true);
  assert.equal(isReadOnlySql('  WITH x AS (select 1) select * from x'), true);
  assert.equal(isReadOnlySql('EXPLAIN select 1'), true);
  assert.equal(isReadOnlySql('show tables'), true);
  assert.equal(isReadOnlySql('delete from t'), false);
  assert.equal(isReadOnlySql('update t set a=1'), false);
  assert.equal(isReadOnlySql('insert into t values (1)'), false);
  assert.equal(isReadOnlySql('drop table t'), false);
});

test('SQL 校验：缺参数 / 写语句在本地就被拦下（不发请求）', async () => {
  const { client, calls } = stub(() => ok({}));
  await assert.rejects(() => checkSql(client, { conn: '', sql: 'select 1' }), /--conn/);
  await assert.rejects(() => checkSql(client, { conn: 'c1', sql: '  ' }), /--query/);
  await assert.rejects(() => checkSql(client, { conn: 'c1', sql: 'delete from t' }), /只允许只读语句/);
  assert.equal(calls.length, 0);
});

/**
 * 平台会**真的执行**这条 SQL，所以四类拒绝都必须在本地、发请求之前发生，
 * 并且给出**各自**可行动的理由（都报"只允许只读语句"会让人查不出到底哪里不对）。
 */
test('SQL 校验：四类非法 SQL 各自给出准确理由，且都不发请求', async () => {
  const cases: [string, RegExp][] = [
    ['drop table t', /只允许只读语句/],                                   // head
    ["SELECT 1 INTO OUTFILE '/tmp/x'", /副作用或加锁/],                   // unsafe
    ['SELECT 1; DROP TABLE t', /多条语句/],                               // multi
    ['SELECT 1 /*! ; DROP TABLE x */', /多条语句/],                       // multi（可执行注释）
    ['WITH c AS (SELECT 1) INSERT INTO t2 SELECT * FROM c', /写操作（insert）/], // cte
  ];
  for (const [sql, re] of cases) {
    const { client, calls } = stub(() => ok({}));
    await assert.rejects(() => checkSql(client, { conn: 'c1', sql }), re, sql);
    await assert.rejects(() => querySql(client, { conn: 'c1', sql }), re, sql);
    assert.equal(calls.length, 0, `不该发请求：${sql}`);
  }
});

test('SQL 校验：按平台端点解析（只解析不执行）并返回列清单', async () => {
  const { client, calls } = stub((path) => {
    if (path.includes('/node/props')) return ok({});
    if (path.includes('parsesql/columns')) {
      return ok([{ colId: 1, colName: 'id', colType: 'String', colLength: '' }]);
    }
    return ok({});
  });
  const res = await checkSql(client, { conn: 'pm_mysql', sql: 'select id from t' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.columns, [{ name: 'id', type: 'String', length: '' }]);
  const call = calls.find((c) => c.path.includes('parsesql/columns'))!;
  assert.equal(call.path, '/rest/esb/process/tablereadnode/parsesql/columns');
  assert.equal(call.opts.method, 'POST');
  assert.deepEqual(call.opts.body, { dbConnId: 'pm_mysql', sql: 'select id from t' });
});

test('SQL 校验：平台报错原样透出，并归类成可行动原因', async () => {
  const cases: [string, string][] = [
    ["Unknown column 'a.ops_plan_finish_date' in 'field list'", 'column'],
    ["Table 'base.t_xxx' doesn't exist", 'table'],
    ['You have an error in your SQL syntax; check the manual', 'syntax'],
    ['Access denied for user', 'permission'],
    ["Communications link failure", 'connection'],
  ];
  for (const [msg, reason] of cases) {
    const { client } = stub((path) => {
      if (path.includes('parsesql/columns')) return { ok: false, httpStatus: 500, msg, data: {} };
      return ok({});
    });
    const res = await checkSql(client, { conn: 'c1', sql: 'select 1' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, reason, msg);
    assert.ok(res.hint && res.hint.length > 5, '应给出下一步提示');
  }
});

test('SQL 报错归一：剥掉平台通用 500 噪声，只留数据库原话', () => {
  const raw = "Unknown column 'x' in 'field list'平台内部错误（HTTP 500）。常见原因：请求的资源不存在";
  assert.equal(extractDbError(raw), "Unknown column 'x' in 'field list'");
  assert.equal(classifySqlError("Unknown column 'x'").reason, 'column');
  assert.equal(classifySqlError("Table 't' doesn't exist").reason, 'table');
  assert.equal(classifySqlError('syntax error').reason, 'syntax');
  assert.equal(classifySqlError('whatever').reason, 'other');
});

test('SQL 校验渲染：成功给列清单，失败给原因与提示', () => {
  const okText = formatSqlCheck({ ok: true, columns: [{ name: 'id', type: 'String' }] });
  assert.match(okText, /解析通过/);
  assert.match(okText, /id \(String\)/);
  const badText = formatSqlCheck({
    ok: false, columns: [],
    error: "Unknown column 'x' in 'field list'", reason: 'column', hint: '改字段名',
  });
  assert.match(badText, /✖ SQL 校验失败/);
  assert.match(badText, /Unknown column/);
  assert.match(badText, /改字段名/);
});
