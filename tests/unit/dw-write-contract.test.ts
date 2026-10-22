/**
 * dw CLI 的**写操作契约**（对着假 FE 跑真实子进程）。
 *
 * 这里钉住的三条都是"工具自己承诺过、但只有真发一次请求才验得到"的行为：
 *   1. 写操作**失败也要留审计**——原来失败路径根本走不到审计那行，
 *      于是"换名改了一半"在审计里查不到；
 *   2. 高危清单（ON COMMIT 下游）**算不出来时不许直接 --apply**——
 *      漏一个下游就是它长期不刷新；
 *   3. 体检类命令在**数据不完整时不许报"✔ 未发现"**——漏报伪装成通过最危险。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startFakeFe } from './dw-fake-fe.ts';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'packages', 'dw-cli', 'src', 'index.ts');
const ROOT = join(here, '..', '..');

/** 跑一次 dw CLI（清掉所有 DW_*，只留本次显式给的，保证不碰真实环境）。 */
async function dw(args: string[], env: Record<string, string>) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('DW_') || k.startsWith('RC_ALLOWED')) continue;
    if (v !== undefined) base[k] = v;
  }
  try {
    const r = await run(process.execPath, ['--experimental-strip-types', CLI, ...args], {
      cwd: ROOT,
      env: { ...base, ...env },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e: any) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function tmpHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'dw-fe-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** 读审计 jsonl（dw 写在 <DW_HOME>/audit/YYYY-MM.jsonl）。 */
function auditLines(home: string): any[] {
  const dir = join(home, 'audit');
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f: string) => f.endsWith('.jsonl'))
    .flatMap((f: string) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

const MV_A = { Name: 'mv_a', State: 'NORMAL', RefreshState: 'SUCCESS' };
const MV_B = { Name: 'mv_b', State: 'NORMAL', RefreshState: 'SUCCESS' };
const DDL_A = 'CREATE MATERIALIZED VIEW mv_a BUILD DEFERRED REFRESH AUTO ON SCHEDULE EVERY 1 HOUR AS SELECT 1';
/** mv_b 读 mv_a，而且是 ON COMMIT —— 换 mv_a 基表后 mv_b 不会自愈，必须手动 COMPLETE。 */
// 真实 Doris 的 SHOW CREATE 正文里是**三段式带反引号**（catalog.db.table）——
// extractTableRefs 认的就是这个形状，写成 `demo_db.mv_a` 反而抽不出来。
const DDL_B = 'CREATE MATERIALIZED VIEW mv_b BUILD DEFERRED REFRESH AUTO ON COMMIT AS SELECT * FROM `internal`.`demo_db`.`mv_a`';

/**
 * 一个"正常"的假 FE：两张 MV（mv_b 依赖 mv_a 且是 ON COMMIT），tasks 空。
 * 有依赖关系才谈得上"高危清单"——只有一张 MV 时下游恒为空，测不出东西。
 */
function normalRoute(sql: string) {
  if (sql.includes("mv_infos(")) return { rows: [MV_A, MV_B] };
  if (sql.startsWith('SHOW CREATE MATERIALIZED VIEW')) {
    return sql.includes('mv_b') ? { rows: [{ 'Materialized View': 'mv_b', Create: DDL_B }] } : { rows: [{ 'Materialized View': 'mv_a', Create: DDL_A }] };
  }
  if (sql.includes("tasks(")) return { rows: [] };
  if (sql === 'SHOW DATABASES') return { rows: [{ Database: 'demo_db' }] };
  return { rows: [] };
}

// ─────────────────────── ① 写失败必须留审计 ───────────────────────

test('swap-apply 失败：审计里留下 ok=false（不是静默消失）', async () => {
  const fe = await startFakeFe((sql) => {
    // 换名语句失败——模拟"改到一半失败"
    if (/REPLACE WITH MATERIALIZED VIEW/i.test(sql)) return { ok: false, msg: 'errCode = 2, detailMessage = table not found' };
    return normalRoute(sql);
  });
  const { home, cleanup } = tmpHome();
  try {
    const r = await dw(['mv', 'swap-apply', '--target', 'mv_a', '--source', 'mv_tmp', '--apply'], {
      ...fe.env,
      DW_HOME: home,
    });
    assert.notEqual(r.code, 0, '失败必须以非零退出');

    const writes = auditLines(home).filter((e) => String(e.method).toUpperCase() === 'SWAP');
    assert.equal(writes.length, 1, `审计里应有 1 条 SWAP，实际 ${writes.length} 条`);
    assert.equal(writes[0].ok, false, '失败也必须留痕，且 ok 必须是 false');
    assert.match(String(writes[0].args?.msg ?? ''), /table not found/);
    assert.equal(writes[0].dryRun, false);
  } finally {
    await fe.close();
    cleanup();
  }
});

test('rolloff 失败：审计里同样留下 ok=false', async () => {
  const fe = await startFakeFe((sql) => {
    // 分区清单要**先成功**（否则失败发生在生成计划阶段，本来就还没写，谈不上留痕）
    if (sql.startsWith('SHOW PARTITIONS')) {
      return { rows: [
        { PartitionName: 'p20200101', RowCount: 10, DataSize: 1024 },
        { PartitionName: 'p20200102', RowCount: 10, DataSize: 1024 },
      ] };
    }
    if (sql.includes('DROP PARTITION')) return { ok: false, msg: 'errCode = 2, detailMessage = partition not exists' };
    return normalRoute(sql);
  });
  const { home, cleanup } = tmpHome();
  try {
    const r = await dw(['partition', 'rolloff', 'demo_db.t', '--keep', '1', '--apply'], { ...fe.env, DW_HOME: home });
    const writes = auditLines(home).filter((e) => String(e.method).toUpperCase() === 'ROLLOFF');
    if (r.code !== 0) {
      assert.equal(writes.length, 1, '失败也要留一条 ROLLOFF 审计');
      assert.equal(writes[0].ok, false);
    }
  } finally {
    await fe.close();
    cleanup();
  }
});

// ─────────────────────── ② 高危清单算不出来 → 不许直接 apply ───────────────────────

test('swap-apply：ON COMMIT 清单算不出来时阻断 --apply，并指向 --force', async () => {
  const fe = await startFakeFe((sql) => {
    // SHOW CREATE 读不到 → 依赖图建不起来 → 高危清单未知
    if (sql.startsWith('SHOW CREATE MATERIALIZED VIEW')) return { ok: false, msg: 'errCode = 2, detailMessage = no permission' };
    return normalRoute(sql);
  });
  const { home, cleanup } = tmpHome();
  try {
    const r = await dw(['mv', 'swap-apply', '--target', 'mv_a', '--source', 'mv_tmp', '--apply'], { ...fe.env, DW_HOME: home });
    assert.equal(r.code, 6, `应被闸门拦下（E_CONFIRM_REQUIRED → 6），实际 ${r.code}`);
    assert.match(r.stderr + r.stdout, /ON COMMIT/);
    assert.match(r.stderr + r.stdout, /--force/);
    assert.equal(fe.saw('REPLACE WITH MATERIALIZED VIEW'), false, '被拦下时不该发换名语句');
  } finally {
    await fe.close();
    cleanup();
  }
});

test('swap-plan --json：清单未知时显式标出，退出码非 0（不让消费者误读成"没有下游"）', async () => {
  const fe = await startFakeFe((sql) => {
    if (sql.startsWith('SHOW CREATE MATERIALIZED VIEW')) return { ok: false, msg: 'errCode = 2, detailMessage = no permission' };
    return normalRoute(sql);
  });
  const { home, cleanup } = tmpHome();
  try {
    const r = await dw(['mv', 'swap-plan', '--target', 'mv_a', '--source', 'mv_tmp', '--json'], { ...fe.env, DW_HOME: home });
    const out = JSON.parse(r.stdout);
    assert.equal(out.onCommitRiskKnown, false);
    assert.ok(out.onCommitRiskNote, '要给出未知的原因');
    assert.notEqual(r.code, 0, '清单未知时退出码不能是 0');
  } finally {
    await fe.close();
    cleanup();
  }
});

test('swap-plan：清单正常时 onCommitRiskKnown=true，退出码 0', async () => {
  const fe = await startFakeFe(normalRoute);
  const { home, cleanup } = tmpHome();
  try {
    const r = await dw(['mv', 'swap-plan', '--target', 'mv_a', '--source', 'mv_tmp', '--json'], { ...fe.env, DW_HOME: home });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.onCommitRiskKnown, true);
    assert.deepEqual(out.onCommitDownstream, ['mv_b']);
  } finally {
    await fe.close();
    cleanup();
  }
});

// ─────────────────────── ③ 数据不完整 → 不许说"未发现" ───────────────────────

test('mv phases：tasks 读不到时不说"✔ 未发现"，退出码 4 并列出缺口', async () => {
  const fe = await startFakeFe((sql) => {
    if (sql.includes("tasks(")) return { ok: false, msg: 'errCode = 2, detailMessage = tasks unavailable' };
    return normalRoute(sql);
  });
  const { home, cleanup } = tmpHome();
  try {
    const r = await dw(['mv', 'phases'], { ...fe.env, DW_HOME: home });
    assert.equal(r.code, 4, '体检没做完时不能以 0 退出');
    assert.equal(r.stdout.includes('✔ 未发现'), false, '数据不完整时不能报"未发现"');
    assert.match(r.stdout, /数据不完整/);
    assert.match(r.stdout, /tasks/);
  } finally {
    await fe.close();
    cleanup();
  }
});

test('mv phases：数据齐全时才给"✔ 未发现"', async () => {
  const fe = await startFakeFe(normalRoute);
  const { home, cleanup } = tmpHome();
  try {
    const r = await dw(['mv', 'phases'], { ...fe.env, DW_HOME: home });
    assert.match(r.stdout, /✔ 未发现/);
    assert.equal(r.code, 0);
  } finally {
    await fe.close();
    cleanup();
  }
});

test('mv lineage：DDL 读不到时把"没有 ON COMMIT 下游"降级、列出盲区，且退出码 4', async () => {
  const fe = await startFakeFe((sql) => {
    if (sql.startsWith('SHOW CREATE MATERIALIZED VIEW')) return { ok: false, msg: 'errCode = 2, detailMessage = no permission' };
    return normalRoute(sql);
  });
  const { home, cleanup } = tmpHome();
  try {
    const r = await dw(['mv', 'lineage', 'mv_a'], { ...fe.env, DW_HOME: home });
    assert.equal(r.code, 4, '血缘没查全时不能以 0 退出（CI 会当成"已确认无风险"）');
    // 不能下"✔ 下游中没有 ON COMMIT 的"这种结论
    assert.equal(r.stdout.includes('✔ 下游中没有 ON COMMIT 的'), false);
    assert.match(r.stdout, /盲区/);
    assert.match(r.stdout, /mv_a|mv_b/);
  } finally {
    await fe.close();
    cleanup();
  }
});

// ─────────────────────── ④ mv list --all-db ───────────────────────

test('mv list --all-db：跨库列出，且读不到的库显式报出（不静默跳过）', async () => {
  // 注意：传输层的 URL 里带的库来自**环境**，不是 listMvInfos 的入参——
  // 所以按 SQL 里的 database 字面量路由，不能按 URL 段路由。
  const fe = await startFakeFe((sql) => {
    if (sql === 'SHOW DATABASES') return { rows: [{ Database: 'db_ok' }, { Database: 'db_bad' }, { Database: 'information_schema' }] };
    if (sql.includes("mv_infos(")) {
      if (sql.includes("'db_bad'")) return { ok: false, msg: 'errCode = 2, detailMessage = access denied' };
      return { rows: [{ Name: 'mv_in_db_ok', State: 'NORMAL', RefreshState: 'SUCCESS' }] };
    }
    return { rows: [] };
  });
  const { home, cleanup } = tmpHome();
  try {
    const r = await dw(['mv', 'list', '--all-db', '--json'], { ...fe.env, DW_HOME: home });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.views.map((v: any) => v.database), ['db_ok']);
    assert.deepEqual(out.failedDbs.map((f: any) => f.database), ['db_bad']);
    // 系统库不该被扫（省一次无谓请求，也不混进结果）
    assert.equal(fe.saw("'information_schema'"), false);
  } finally {
    await fe.close();
    cleanup();
  }
});

test('mv list：缺库上下文时列出实例现有库，而不是只说"未指定 database"', async () => {
  const fe = await startFakeFe((sql) => {
    if (sql === 'SHOW DATABASES') return { rows: [{ Database: 'warehouse_a' }, { Database: 'warehouse_b' }] };
    return normalRoute(sql);
  });
  const { home, cleanup } = tmpHome();
  try {
    const env = { ...fe.env };
    delete (env as Record<string, string>).DW_DB;
    const r = await dw(['mv', 'list'], { ...env, DW_HOME: home });
    assert.equal(r.code, 4);
    assert.match(r.stderr + r.stdout, /warehouse_a/);
    assert.match(r.stderr + r.stdout, /warehouse_b/);
    assert.match(r.stderr + r.stdout, /--all-db/);
  } finally {
    await fe.close();
    cleanup();
  }
});

// ─────────────────────── ⑤ --readonly 显式只读 ───────────────────────

/**
 * 文档承诺过 `--readonly`（docs/DW-COMMAND-REFERENCE.md §2.3），但 OPTIONS 里没声明，
 * 于是照文档写命令的人拿到的是"未知参数 + 退出码 2"——一个参数拼错的样子，
 * 而不是"这次写被拒"。这里钉住它真的接上了，并且**一个请求都不发**。
 */
test('--readonly：写操作被拒（E_PROD_READONLY → 6），且不发请求', async () => {
  const fe = await startFakeFe(normalRoute);
  const { home, cleanup } = tmpHome();
  try {
    const r = await dw(['mv', 'refresh', 'mv_a', '--apply', '--readonly'], { ...fe.env, DW_HOME: home });
    assert.equal(r.code, 6, `应被只读闸门拦下，实际 ${r.code}`);
    assert.match(r.stderr + r.stdout, /只读|E_PROD_READONLY/);
    assert.equal(fe.saw('REFRESH MATERIALIZED VIEW'), false, '被拒时不该发写语句');
  } finally {
    await fe.close();
    cleanup();
  }
});

test('--readonly：dry-run 也照常放行（只读只拦"真的写"）', async () => {
  const fe = await startFakeFe(normalRoute);
  const { home, cleanup } = tmpHome();
  try {
    const r = await dw(['mv', 'refresh', 'mv_a', '--readonly'], { ...fe.env, DW_HOME: home });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /dry-run/);
    assert.equal(fe.saw('REFRESH MATERIALIZED VIEW'), false);
  } finally {
    await fe.close();
    cleanup();
  }
});
