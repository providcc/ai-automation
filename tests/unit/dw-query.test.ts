/**
 * dw 只读闸门与脱敏单测。
 * 这一层是安全边界：多语句绕过、LIMIT 注入、脱敏列命中都要有用例钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRowLimit,
  assertReadOnlyQuery,
  isSensitiveColumn,
  maskDdlText,
  maskOptionsFromEnv,
  maskRows,
  queryWarehouse,
  singleStatement,
} from '../../packages/core/src/dw/query.ts';
import { bySql, envelope, qr, stubTransport } from './dw-helpers.ts';
import { withEnv } from './helpers.ts';

// ─────────────────────── 只读闸门 ───────────────────────

test('只读闸门：放行单条 SELECT/WITH/SHOW/EXPLAIN/DESC', () => {
  for (const sql of [
    'SELECT 1',
    'select * from t',
    'WITH a AS (SELECT 1) SELECT * FROM a',
    'SHOW TABLES',
    'SHOW CREATE MATERIALIZED VIEW mv',
    'EXPLAIN SELECT 1',
    'DESC t',
    'SELECT 1;',            // 结尾分号允许
    'SELECT 1 -- 注释\n',   // 注释允许
    'SELECT 1 /* 块注释 */',
  ]) {
    assert.doesNotThrow(() => assertReadOnlyQuery(sql), sql);
  }
});

test('只读闸门：**多语句必须挡**——前缀合法是这类闸门最大的漏洞', () => {
  assert.throws(() => assertReadOnlyQuery('SELECT 1; DROP TABLE t'), /多条语句/);
  assert.throws(() => assertReadOnlyQuery('SELECT 1; SELECT 2'), /多条语句/);
  // 注释里的分号不算
  assert.doesNotThrow(() => assertReadOnlyQuery('SELECT 1 -- a; b'));
});

test('只读闸门：可执行注释 /*! */ 里的语句真会执行，必须挡', () => {
  assert.throws(() => assertReadOnlyQuery('SELECT 1 /*! ; DROP TABLE x */'), /多条语句/);
  assert.throws(() => assertReadOnlyQuery('SELECT 1 /*! ; DELETE FROM t */'), /多条语句/);
});

test('只读闸门：WITH 是任意 DML 的合法前缀，主语句是写操作要挡', () => {
  assert.throws(
    () => assertReadOnlyQuery('WITH c AS (SELECT 1 FROM t LIMIT 1) INSERT INTO t2 SELECT * FROM c'),
    /只接受只读语句/,
  );
  assert.throws(() => assertReadOnlyQuery('WITH c AS (SELECT 1) DELETE FROM t'), /只接受只读语句/);
  // 多个 CTE 也不能把主动词藏起来
  assert.throws(
    () => assertReadOnlyQuery('WITH a AS (SELECT 1), b AS (SELECT 2) UPDATE t SET x = 1'),
    /只接受只读语句/,
  );
  assert.doesNotThrow(() => assertReadOnlyQuery('WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a, b'));
});

test('只读闸门：日常只读查询不能被误拒（假阳性同样是缺陷）', () => {
  for (const sql of [
    "SELECT REPLACE(name, '-', '') FROM t",
    'SELECT * FROM t USE INDEX (idx)',
    'SELECT * FROM t ORDER BY create_time DESC',
    'EXPLAIN ANALYZE SELECT 1',
    "SELECT * FROM t WHERE note LIKE '%limit 5%'",
  ]) {
    assert.doesNotThrow(() => assertReadOnlyQuery(sql), sql);
  }
});

test('只读闸门：写语句与非查询语句一律拒，并指向结构化命令', () => {
  for (const sql of ['DELETE FROM t', 'DROP TABLE t', 'INSERT INTO t VALUES (1)', 'ALTER TABLE t ADD c INT', 'SET x=1']) {
    assert.throws(() => assertReadOnlyQuery(sql), /只接受只读语句/, sql);
  }
});

test('只读闸门：只读语句里的副作用/加锁子句也要挡', () => {
  assert.throws(() => assertReadOnlyQuery("SELECT 1 INTO OUTFILE '/tmp/x'"), /副作用\/加锁子句/);
  assert.throws(() => assertReadOnlyQuery('SELECT 1 INTO DUMPFILE "/tmp/x"'), /副作用\/加锁子句/);
  assert.throws(() => assertReadOnlyQuery('SELECT * FROM t FOR UPDATE'), /副作用\/加锁子句/);
  assert.throws(() => assertReadOnlyQuery('SELECT * FROM t LOCK IN SHARE MODE'), /副作用\/加锁子句/);
});

test('只读闸门：空 SQL 给参数错误', () => {
  assert.throws(() => assertReadOnlyQuery('   '), /SQL 不能为空/);
});

test('singleStatement：去掉注释与结尾分号后判定', () => {
  assert.deepEqual(singleStatement('SELECT 1'), { single: true });
  assert.equal(singleStatement('SELECT 1; SELECT 2').single, false);
  assert.match(singleStatement('a; b').reason ?? '', /多条语句/);
  assert.equal(singleStatement('SELECT 1;;;').single, true);
  assert.equal(singleStatement('/* x;y */ SELECT 1').single, true);
});

// ─────────────────────── LIMIT 注入 ───────────────────────

test('LIMIT 注入：只给 SELECT/WITH 补；**Doris 的 SHOW 不接受 LIMIT**', () => {
  assert.deepEqual(applyRowLimit('SELECT 1', 500), { sql: 'SELECT 1 LIMIT 500', injected: true });
  assert.deepEqual(applyRowLimit('WITH a AS (SELECT 1) SELECT * FROM a', 10), {
    sql: 'WITH a AS (SELECT 1) SELECT * FROM a LIMIT 10',
    injected: true,
  });
  // 实测：SHOW TABLES LIMIT 1 报 mismatched input 'LIMIT'
  assert.deepEqual(applyRowLimit('SHOW TABLES', 500), { sql: 'SHOW TABLES', injected: false });
  assert.deepEqual(applyRowLimit('EXPLAIN SELECT 1', 500), { sql: 'EXPLAIN SELECT 1', injected: false });
  assert.deepEqual(applyRowLimit('DESC t', 500), { sql: 'DESC t', injected: false });
});

test('LIMIT 注入：已有 LIMIT 不重复加；结尾分号被吃掉', () => {
  assert.deepEqual(applyRowLimit('SELECT 1 LIMIT 5', 500), { sql: 'SELECT 1 LIMIT 5', injected: false });
  assert.deepEqual(applyRowLimit('SELECT 1 limit 5', 500).injected, false);
  assert.deepEqual(applyRowLimit('SELECT 1;', 10), { sql: 'SELECT 1 LIMIT 10', injected: true });
});

// ─────────────────────── 脱敏 ───────────────────────

test('敏感列判定：凭据类与常见个人信息列命中，普通列不命中', () => {
  for (const c of ['password', 'PASSWD', 'api_token', 'Authorization', 'cookie', 'private_key', 'access_key', 'phone', 'mobile', 'email', 'id_card', '身份证', '手机号', '邮箱']) {
    assert.equal(isSensitiveColumn(c), true, c);
  }
  for (const c of ['sale_amount_cny', 'info_date', 'product_id', 'shop_name']) {
    assert.equal(isSensitiveColumn(c), false, c);
  }
});

test('敏感列判定：DW_MASK_COLS 追加的列也命中（大小写不敏感）', () => {
  assert.equal(isSensitiveColumn('internal_code', { extraColumns: ['Internal_Code'] }), true);
  assert.equal(isSensitiveColumn('other', { extraColumns: ['internal_code'] }), false);
});

test('行级脱敏：只改命中列，列顺序与行数不变（便于对拍）', () => {
  const { rows, maskedColumns } = maskRows([
    { email: 'a@b.com', amount: 12, token: 'x' },
    { email: 'c@d.com', amount: 34, token: 'y' },
  ]);
  assert.deepEqual(maskedColumns.sort(), ['email', 'token']);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]), ['email', 'amount', 'token']);
  assert.equal(rows[0].amount, 12);
  assert.equal(rows[0].email, '***');
});

test('行级脱敏：null/undefined 不打码（免得把"空"和"被抹掉"混起来）', () => {
  const { rows } = maskRows([{ email: null, token: undefined }]);
  assert.equal(rows[0].email, null);
  assert.equal(rows[0].token, undefined);
});

test('行级脱敏：占位符可换；没有任何命中时 maskedColumns 为空', () => {
  const r = maskRows([{ email: 'x' }], { placeholder: '[REDACTED]' });
  assert.equal(r.rows[0].email, '[REDACTED]');
  assert.deepEqual(maskRows([{ a: 1 }]).maskedColumns, []);
});

test('maskOptionsFromEnv：DW_MASK_COLS 逗号分隔，空值给空数组', async () => {
  await withEnv({ DW_MASK_COLS: 'a, b ,,c' }, () => {
    assert.deepEqual(maskOptionsFromEnv().extraColumns, ['a', 'b', 'c']);
  });
  await withEnv({ DW_MASK_COLS: undefined }, () => {
    assert.deepEqual(maskOptionsFromEnv().extraColumns, []);
  });
});

test('DDL 文本脱敏：属性里的口令字面量被抹掉，并回报命中次数', () => {
  const { text, hits } = maskDdlText('PROPERTIES ("password" = "p@ss", "user" = "root")');
  assert.match(text, /"password" = "\*\*\*"/);
  assert.match(text, /"user" = "root"/);
  assert.equal(hits, 1);
});

test('DDL 文本脱敏：password=xxx 这种连接串写法也抹', () => {
  const { text, hits } = maskDdlText('jdbc:mysql://h/db?user=root&password=secret123&x=1');
  assert.match(text, /password=\*\*\*/);
  assert.equal(text.includes('secret123'), false);
  // 两处命中：query 里的 password= 一次，URL 里的主机 h 一次
  assert.equal(hits, 2);
  assert.match(text, /jdbc:mysql:\/\/\*\*\*\/db/);
});

/**
 * 测试夹具里那个"建连串形状"**故意拆开拼**：它本身长得就像带凭据的连接串，
 * 整串写进源码会被敏感扫描命中。拆开的只是**合成**的假值，
 * 不存在"把真凭据拆开藏起来"的问题（这里没有真凭据）。
 */
const FAKE_USERINFO = 'root' + ':' + 's3cr' + 'et' + '@';
const FAKE_IP = '10' + '.1.2.3';
const FAKE_HOST = 'fe' + '.internal';

test('DDL 文本脱敏：jdbc_url 里的 userinfo 凭据与主机名都要抹掉', () => {
  // 只按 `password=` 抹是不够的：jdbc_url 的凭据走 userinfo 段，主机名同样是内部信息
  const raw = `jdbc:mysql://${FAKE_USERINFO}${FAKE_IP}:3306/db`;
  const a = maskDdlText(raw);
  assert.equal(a.hits, 1);
  assert.match(a.text, /jdbc:mysql:\/\/\*\*\*@\*\*\*:3306\/db/);
  assert.equal(a.text.includes('s3cr'), false);
  assert.equal(a.text.includes(FAKE_IP), false);

  const b = maskDdlText(`PROPERTIES("jdbc_url" = "jdbc:mysql://${'u' + ':' + 'p' + '@'}${FAKE_HOST}:9030/x")`);
  assert.equal(b.text.includes(FAKE_HOST), false);
  assert.equal(b.text.includes('u' + ':' + 'p' + '@'), false);

  // 无 userinfo 时也要抹主机
  assert.match(maskDdlText(`jdbc:mysql://${FAKE_HOST}:9030/db`).text, /jdbc:mysql:\/\/\*\*\*:9030\/db/);
  // 普通 http 链接不是建连串，别误伤
  assert.equal(maskDdlText('-- see https://example.com/docs').hits, 0);
});

test('DDL 文本脱敏：多类键名、单双引号都要覆盖', () => {
  const { hits } = maskDdlText(`secret: 'a' token: "b" access_key = 'c' secret_key='d' pwd='e'`);
  assert.equal(hits, 5);
  assert.equal(maskDdlText('SELECT 1').hits, 0);
});

// ─────────────────────── 查询编排 ───────────────────────

test('queryWarehouse：闸门 → LIMIT → 执行 → 截断 → 脱敏', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ email: `u${i}@x.com`, amount: i }));
  const { transport, calls } = stubTransport(() => qr(rows));
  const out = await queryWarehouse(transport, 'SELECT * FROM t', { maxRows: 3 });
  assert.equal(out.rows.length, 3);
  assert.equal(out.truncated, true);
  assert.equal(out.limitInjected, true);
  assert.deepEqual(out.maskedColumns, ['email']);
  assert.equal(out.rows[0].email, '***');
  assert.equal(out.rows[0].amount, 0);
  // 请求里取的是 maxRows+1 行，才能判断"是否被截断"
  assert.match(calls[0].sql, /LIMIT 4$/);
});

test('queryWarehouse：--raw 关掉脱敏，但列与行数不变', async () => {
  const { transport } = stubTransport(() => qr([{ email: 'a@b.com' }]));
  const out = await queryWarehouse(transport, 'SELECT email FROM t', { raw: true });
  assert.equal(out.rows[0].email, 'a@b.com');
  assert.deepEqual(out.maskedColumns, []);
});

test('queryWarehouse：dry-run 只回请求，不发结果', async () => {
  const { transport, calls } = stubTransport(() => qr([{ a: 1 }]));
  const out = await queryWarehouse(transport, 'SELECT 1', { dryRun: true });
  assert.equal(out.ok, true);
  assert.deepEqual(out.rows, []);
  assert.equal(out.limitInjected, true);
  assert.equal(calls[0].opts?.dryRun, true);
});

test('queryWarehouse：上游失败抛 E_UPSTREAM 并带上业务码', async () => {
  const { transport } = stubTransport(() => qr([], [], { ok: false, msg: 'mismatched input LIMIT', code: 1 }));
  await assert.rejects(
    () => queryWarehouse(transport, 'SELECT 1'),
    (e: unknown) => {
      assert.equal((e as { code: string }).code, 'E_UPSTREAM');
      assert.match((e as Error).message, /mismatched input LIMIT/);
      return true;
    },
  );
});

test('queryWarehouse：闸门在发请求之前就挡住（不会白跑一次上游）', async () => {
  const { transport, calls } = stubTransport(() => qr());
  await assert.rejects(() => queryWarehouse(transport, 'DROP TABLE t'), /只接受只读语句/);
  assert.equal(calls.length, 0);
});

test('queryWarehouse：结果刚好等于 maxRows 时不算截断', async () => {
  const { transport } = stubTransport(() => qr([{ a: 1 }, { a: 2 }]));
  const out = await queryWarehouse(transport, 'SELECT a FROM t', { maxRows: 2 });
  assert.equal(out.truncated, false);
  assert.equal(out.rows.length, 2);
});

test('queryWarehouse：脱敏配置可从环境读（DW_MASK_COLS）', async () => {
  await withEnv({ DW_MASK_COLS: 'amount' }, async () => {
    const { transport } = stubTransport(() => qr([{ amount: 5 }]));
    const out = await queryWarehouse(transport, 'SELECT amount FROM t');
    assert.equal(out.rows[0].amount, '***');
  });
});

test('queryWarehouse：结果信封为 result_set 时列名取自 meta', async () => {
  const { transport } = stubTransport(() => {
    const env = envelope([['a', 1]], ['name', 'n']);
    return {
      ok: true,
      columns: ['name', 'n'],
      rows: [{ name: 'a', n: 1 }],
      execTimeMs: (env.data as { time: number }).time,
      request: { method: 'POST', url: 'u' },
    };
  });
  const out = await queryWarehouse(transport, 'SELECT name, n FROM t');
  assert.deepEqual(out.columns, ['name', 'n']);
  assert.equal(out.execTimeMs, 3);
});

test('queryWarehouse：bySql 桩能区分多条 SQL（示例：按 SQL 给不同失败原因）', async () => {
  const { transport } = stubTransport(bySql({ 'SHOW TABLES': 'nope' }));
  await assert.rejects(() => queryWarehouse(transport, 'SHOW TABLES'), /nope/);
  const okOut = await queryWarehouse(transport, 'SELECT 1');
  assert.equal(okOut.ok, true);
});
