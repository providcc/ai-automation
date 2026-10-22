/**
 * 脱敏原语单测：`redact()` / `scrubSecretsInText()`。
 *
 * 这一层是**审计与错误输出的最后一道**——凭据一旦落进 `~/.rc/audit` 或 `~/.dw/audit`
 * 就是长期留存的明文，事后清理成本极高。所以这里两侧都要钉住：
 *   1. **键名命中**（`{password: …}`）——原有行为；
 *   2. **值内赋值**（`PROPERTIES("password"="…")`）——键名是 `sql`，不敏感，但值里带密码。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, scrubSecretsInText } from '../../packages/core/src/errors.ts';

// ─────────────────────── 键名维度 ───────────────────────

test('redact：键名命中即整值打码，嵌套结构递归处理', () => {
  assert.deepEqual(redact({ password: 'x', nested: { token: 'y', keep: 1 } }), {
    password: '***',
    nested: { token: '***', keep: 1 },
  });
});

test('redact：各类凭据键名都认（大小写不敏感）', () => {
  const out = redact({
    Password: 'a',
    passwd: 'b',
    TOKEN: 'c',
    secret: 'd',
    authorization: 'e',
    cookie: 'f',
    pwd: 'g',
    api_key: 'h',
    apiKey: 'i',
    access_key: 'j',
  }) as Record<string, string>;
  for (const v of Object.values(out)) assert.equal(v, '***');
});

test('redact：非凭据键名不动', () => {
  assert.deepEqual(redact({ host: 'h', user: 'u', db: 'd' }), { host: 'h', user: 'u', db: 'd' });
});

test('redact：数组按元素递归', () => {
  assert.deepEqual(redact([{ password: 'x' }, 'plain']), [{ password: '***' }, 'plain']);
});

test('redact：基本类型原样返回', () => {
  assert.equal(redact(1), 1);
  assert.equal(redact(true), true);
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
});

// ─────────────────────── 值内赋值维度（新增） ───────────────────────

test('redact：**字符串值里的凭据赋值也要抹掉**（这是审计明文泄漏的真实路径）', () => {
  // 键名是 sql，不敏感；密码藏在 DDL 的 PROPERTIES 里
  assert.equal(
    redact('ALTER CATALOG c SET PROPERTIES("password"="<secret>")'),
    'ALTER CATALOG c SET PROPERTIES("password"="***")',
  );
  assert.equal(
    redact("CREATE CATALOG x PROPERTIES('user'='u','password'='p')"),
    "CREATE CATALOG x PROPERTIES('user'='u','password'='***')",
  );
});

test('redact：对象里的字符串值同样被扫（`{sql: …}` 这条最常见的路径）', () => {
  const out = redact({ sql: "SET ('password'='leak')", msg: 'token=abc' }) as Record<string, string>;
  assert.equal(out.sql, "SET ('password'='***')");
  assert.equal(out.msg, 'token=***');
});

test('scrubSecretsInText：无引号、有引号、冒号赋值都认', () => {
  assert.equal(scrubSecretsInText('password = abc'), 'password = ***');
  assert.equal(scrubSecretsInText('password=abc'), 'password=***');
  assert.equal(scrubSecretsInText('password: abc'), 'password: ***');
  assert.equal(scrubSecretsInText(`password='a b'`), `password='***'`);
});

test('scrubSecretsInText：保留键名便于排查（只抹值）', () => {
  assert.match(scrubSecretsInText('password=abc'), /^password=/);
});

test('scrubSecretsInText：Authorization 头抹掉方案与令牌', () => {
  assert.equal(scrubSecretsInText('Authorization: Bearer abc123'), 'Authorization: ***');
  assert.equal(scrubSecretsInText('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: ***');
});

test('scrubSecretsInText：**不能误伤正常 SQL**（这是最容易翻车的地方）', () => {
  const safe = [
    'REFRESH MATERIALIZED VIEW `mv`',
    'SELECT token FROM t',
    'SELECT * FROM dwd_order WHERE status = 1',
    'ALTER MATERIALIZED VIEW `mv` SET ("excluded_trigger_tables"="t1,t2")',
    "ALTER MATERIALIZED VIEW `mv` REFRESH AUTO ON SCHEDULE EVERY 1 HOUR STARTS '2026-10-23 04:15:00'",
    'SELECT password_hash FROM users',
  ];
  for (const s of safe) assert.equal(scrubSecretsInText(s), s, `不该改动：${s}`);
});

test('scrubSecretsInText：空值/非字符串不崩', () => {
  assert.equal(scrubSecretsInText(''), '');
  assert.equal(scrubSecretsInText(undefined as unknown as string), '');
  assert.equal(scrubSecretsInText(null as unknown as string), '');
});

test('scrubSecretsInText：一行里多处赋值全部抹掉', () => {
  assert.equal(
    scrubSecretsInText("'user'='u','password'='p','token'='t'"),
    "'user'='u','password'='***','token'='***'",
  );
});

// ─────────────────────── 组合 ───────────────────────

test('redact：键名与值内两条同时生效，且幂等（抹过的再抹不变）', () => {
  const entry = { password: 'outer', args: { sql: "SET ('password'='inner')" } };
  const once = redact(entry) as any;
  assert.equal(once.password, '***');
  assert.equal(once.args.sql, "SET ('password'='***')");
  assert.deepEqual(redact(once), once);
});
