/**
 * SQL 骨架化与只读判定（`sql-text.ts`）。
 *
 * 这一层是**两个入口共用**的安全边界：dw 的查询闸门（`assertReadOnlyQuery`）
 * 与 rc 的 SQL 校验（`isReadOnlySql`）。所以这里既钉住"假阴性"（绕过），
 * 也钉住"假阳性"（正常查询被误拒）——后者同样是缺陷，会把用户逼去手工拼 SQL。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstKeyword,
  hasMultipleStatements,
  hasTopLevelLimit,
  isReadOnlyStatement,
  stripExplainPrefix,
  stripSqlLiterals,
  topLevelVerb,
} from '../../packages/core/src/sql-text.ts';
import { assertReadOnlyQuery, applyRowLimit } from '../../packages/core/src/dw/query.ts';
import { isReadOnlySql } from '../../packages/core/src/sql-check.ts';

// ─────────────────────── 骨架化 ───────────────────────

test('骨架化：字面量、引用标识符、注释都变空白；长度不变', () => {
  assert.equal(stripSqlLiterals("SELECT 'a;b'").includes(';'), false);
  assert.equal(stripSqlLiterals('SELECT "a;b"').includes(';'), false);
  assert.equal(stripSqlLiterals('SELECT `a;b`').includes(';'), false);
  assert.equal(stripSqlLiterals('SELECT 1 -- ; DROP\n').includes('DROP'), false);
  assert.equal(stripSqlLiterals('SELECT 1 # ; DROP\n').includes('DROP'), false);
  assert.equal(stripSqlLiterals('SELECT 1 /* ; DROP */').includes('DROP'), false);
  // 长度保留，便于把骨架上的命中位置映射回原文
  for (const sql of ["SELECT 'a;b'", 'SELECT 1 /* x */', 'SELECT 1 -- y']) {
    assert.equal(stripSqlLiterals(sql).length, sql.length, sql);
  }
});

test('骨架化：转义（反斜杠 / 双写引号）不能提前闭合字面量', () => {
  assert.equal(stripSqlLiterals("SELECT 'a\\'b;c'").includes(';'), false);
  assert.equal(stripSqlLiterals("SELECT 'a''b;c'").includes(';'), false);
  assert.equal(stripSqlLiterals('SELECT "a""b;c"').includes(';'), false);
});

test('骨架化：MySQL 可执行注释 /*! */ **不剥**——它里面的内容真会执行', () => {
  const skel = stripSqlLiterals('SELECT 1 /*! ; DROP TABLE x */');
  assert.equal(skel.includes(';'), true);
  assert.equal(skel.includes('DROP'), true);
});

// ─────────────────────── 分号 / 多语句 ───────────────────────

test('多语句判定跑在骨架上：字面量与普通注释里的分号不算数', () => {
  assert.equal(hasMultipleStatements(stripSqlLiterals("SELECT 'a;b'")), false);
  assert.equal(hasMultipleStatements(stripSqlLiterals('SELECT 1 -- a; b')), false);
  assert.equal(hasMultipleStatements(stripSqlLiterals('/* x;y */ SELECT 1')), false);
  assert.equal(hasMultipleStatements(stripSqlLiterals('SELECT 1;;;')), false); // 结尾分号允许
  assert.equal(hasMultipleStatements(stripSqlLiterals('a; b')), true);
});

test('绕过①：可执行注释里的分号必须判成多语句', () => {
  const v = isReadOnlyStatement('SELECT 1 /*! ; DROP TABLE x */');
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.kind, 'multi');
  assert.throws(() => assertReadOnlyQuery('SELECT 1 /*! ; DROP TABLE x */'), /多条语句/);
  assert.equal(isReadOnlySql('SELECT 1 /*! ; DROP TABLE x */'), false);
});

test('绕过②：WITH 前缀的 DML 必须挡（CTE 是任意 DML 的合法前缀）', () => {
  for (const [sql, verb] of [
    ['WITH c AS (SELECT 1 FROM t LIMIT 1) INSERT INTO t2 SELECT * FROM c', 'insert'],
    ['WITH c AS (SELECT 1) DELETE FROM t', 'delete'],
    ['WITH c AS (SELECT 1) UPDATE t SET x = 1', 'update'],
    ['WITH a AS (SELECT 1), b AS (SELECT 2) REPLACE INTO t2 SELECT * FROM a', 'replace'],
    ['WITH c AS (SELECT 1) CREATE TABLE t2 AS SELECT * FROM c', 'create'],
  ] as const) {
    const v = isReadOnlyStatement(sql);
    assert.equal(v.ok, false, sql);
    assert.equal(v.ok === false && v.kind, 'cte', sql);
    assert.equal(v.ok === false && v.detail, verb, sql);
    assert.throws(() => assertReadOnlyQuery(sql), /只接受只读语句/, sql);
    assert.equal(isReadOnlySql(sql), false, sql);
  }
});

test('绕过③：假阳性也要修——日常只读查询不能被误拒', () => {
  for (const sql of [
    "SELECT REPLACE(name, '-', '') FROM t",   // REPLACE 是字符串函数
    'SELECT * FROM t USE INDEX (idx)',        // 索引提示，不是 USE 语句
    'SELECT * FROM t IGNORE INDEX (idx)',
    'SELECT * FROM t FORCE INDEX (idx)',
    'SELECT COUNT(*) AS set_size FROM t',
    'SELECT * FROM t ORDER BY create_time DESC',
    'SELECT last_update, deleted_at FROM t',
    'SELECT * FROM t WHERE status = \'analyze\'',
    'EXPLAIN ANALYZE SELECT 1',
    'WITH c AS (SELECT REPLACE(a, \'x\', \'y\') FROM t) SELECT * FROM c',
  ]) {
    assert.equal(isReadOnlyStatement(sql).ok, true, sql);
    assert.doesNotThrow(() => assertReadOnlyQuery(sql), sql);
  }
});

// ─────────────────────── 首关键字 ───────────────────────

test('首关键字：剥掉 EXPLAIN / EXPLAIN ANALYZE 前缀看内层', () => {
  assert.equal(firstKeyword(stripSqlLiterals('EXPLAIN DROP TABLE t')), 'drop');
  assert.equal(firstKeyword(stripSqlLiterals('EXPLAIN ANALYZE SELECT 1')), 'select');
  assert.equal(firstKeyword(stripSqlLiterals('  select 1')), 'select');
  assert.equal(firstKeyword(stripSqlLiterals('')), undefined);
  assert.equal(stripExplainPrefix('EXPLAIN ANALYZE SELECT 1'), 'SELECT 1');
});

test('首关键字：EXPLAIN 后面的写语句照样拒', () => {
  assert.throws(() => assertReadOnlyQuery('EXPLAIN DROP TABLE t'), /只接受只读语句/);
  assert.throws(() => assertReadOnlyQuery('EXPLAIN ANALYZE DELETE FROM t'), /只接受只读语句/);
});

// ─────────────────────── 元数据语句 ───────────────────────

test('SHOW/DESC：正文里的 CREATE 是元数据文本，不是写语句', () => {
  for (const sql of [
    'SHOW CREATE MATERIALIZED VIEW mv',
    'SHOW CREATE TABLE t',
    'DESC t',
    'DESCRIBE SELECT 1', // 语法上无意义，但判定不该因正文关键字而误拒
    'SHOW TABLES',
  ]) {
    assert.equal(isReadOnlyStatement(sql).ok, true, sql);
  }
});

// ─────────────────────── 副作用子句 ───────────────────────

test('副作用/加锁子句：只读语句里也要挡', () => {
  for (const sql of [
    "SELECT 1 INTO OUTFILE '/tmp/x'",
    'SELECT 1 INTO DUMPFILE "/tmp/x"',
    'SELECT * FROM t FOR UPDATE',
    'SELECT * FROM t LOCK IN SHARE MODE',
  ]) {
    const v = isReadOnlyStatement(sql);
    assert.equal(v.ok === false && v.kind, 'unsafe', sql);
  }
  // 大小写不敏感
  assert.equal(isReadOnlyStatement('select * from t for update').ok, false);
});

// ─────────────────────── topLevelVerb ───────────────────────

test('topLevelVerb：走完 CTE 列表后取主动词', () => {
  assert.equal(topLevelVerb(stripSqlLiterals('WITH c AS (SELECT 1) SELECT * FROM c')), 'select');
  assert.equal(topLevelVerb(stripSqlLiterals('WITH c(n) AS (SELECT 1) SELECT * FROM c')), 'select');
  assert.equal(topLevelVerb(stripSqlLiterals('WITH RECURSIVE c AS (SELECT 1) SELECT * FROM c')), 'select');
  assert.equal(topLevelVerb(stripSqlLiterals('WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a, b')), 'select');
  assert.equal(topLevelVerb(stripSqlLiterals('WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a')), 'insert');
  // CTE 体里的函数名不能被当成动词
  assert.equal(topLevelVerb(stripSqlLiterals("WITH c AS (SELECT REPLACE(a,'x','y') FROM t) SELECT * FROM c")), 'select');
  // 嵌套括号
  assert.equal(topLevelVerb(stripSqlLiterals('WITH c AS (SELECT * FROM (SELECT 1) x WHERE a IN (1,2)) SELECT * FROM c')), 'select');
});

test('topLevelVerb：非 WITH 或语法畸形 → undefined（调用方按"无法证明只读"处理）', () => {
  assert.equal(topLevelVerb('SELECT 1'), undefined);
  assert.equal(topLevelVerb(''), undefined);
  assert.equal(topLevelVerb('WITH'), undefined);
  assert.equal(topLevelVerb('WITH c (SELECT 1) SELECT 1'), undefined);   // 缺 AS
  assert.equal(topLevelVerb('WITH c AS SELECT 1'), undefined);           // 缺括号
  // 畸形 WITH 保守拒掉，不给绕过留缝
  assert.equal(isReadOnlyStatement('WITH c (SELECT 1) SELECT 1').ok, false);
});

// ─────────────────────── LIMIT 注入 ───────────────────────

test('hasTopLevelLimit：只看顶层，子查询与字面量里的 LIMIT 不算', () => {
  assert.equal(hasTopLevelLimit(stripSqlLiterals('SELECT 1 LIMIT 5')), true);
  assert.equal(hasTopLevelLimit(stripSqlLiterals('SELECT 1 limit 5')), true);
  assert.equal(hasTopLevelLimit(stripSqlLiterals('SELECT * FROM (SELECT 1 LIMIT 1) x')), false);
  assert.equal(hasTopLevelLimit(stripSqlLiterals("SELECT * FROM t WHERE note LIKE '%limit 5%'")), false);
});

test('LIMIT 注入：字面量里的 limit 不能骗过注入（否则整表被拉回来）', () => {
  const r = applyRowLimit("SELECT * FROM t WHERE note LIKE '%limit 5%'", 500);
  assert.equal(r.injected, true);
  assert.match(r.sql, /LIMIT 500$/);
  // 子查询有 LIMIT、外层没有 → 仍要补
  const r2 = applyRowLimit('SELECT * FROM (SELECT 1 LIMIT 1) x', 500);
  assert.equal(r2.injected, true);
});

test('LIMIT 注入：EXPLAIN / DESC / SHOW 一律不补（Doris 会报语法错）', () => {
  assert.deepEqual(applyRowLimit('EXPLAIN SELECT 1', 500), { sql: 'EXPLAIN SELECT 1', injected: false });
  assert.deepEqual(applyRowLimit('DESC t', 500), { sql: 'DESC t', injected: false });
  assert.deepEqual(applyRowLimit('SHOW TABLES', 500), { sql: 'SHOW TABLES', injected: false });
});

// ─────────────────────── 两个入口的一致性 ───────────────────────

test('一致性：dw 闸门与 rc 校验对同一批 SQL 结论必须相同', () => {
  const corpus = [
    'SELECT 1',
    "SELECT 'a;b'",
    'SELECT 1; DROP TABLE t',
    'SELECT 1 /*! ; DROP TABLE x */',
    'WITH c AS (SELECT 1) SELECT * FROM c',
    'WITH c AS (SELECT 1) INSERT INTO t2 SELECT * FROM c',
    "SELECT REPLACE(name,'-','') FROM t",
    'SELECT * FROM t FOR UPDATE',
    'SHOW CREATE TABLE t',
    'EXPLAIN DROP TABLE t',
    'DROP TABLE t',
    'SET x = 1',
    '',
  ];
  for (const sql of corpus) {
    const dw = (() => {
      try {
        assertReadOnlyQuery(sql);
        return true;
      } catch {
        return false;
      }
    })();
    assert.equal(dw, isReadOnlySql(sql), `dw 与 rc 结论不一致：${JSON.stringify(sql)}`);
  }
});
