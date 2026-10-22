/**
 * dw 环境自检单测。
 * 顺序是链式的：配置 → 隧道 → 连通性 → 库上下文 → MV 元数据 → 写闸门 → DDL 能力。
 * 前一项没过，后面全部 skip——不让用户在一堆噪音里找原因。
 *
 * 手法：桩掉 `globalThis.fetch`（走真实 HTTP 传输层，断言真实信封），
 * 隧道运行时用注入的桩，**不真的起 ssh、也不真的连端口**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WRITE_PROBE_TABLE, runWarehouseDoctor } from '../../packages/core/src/dw/doctor.ts';
import { envFixture, stubTunnelRuntime, tunnelFixture } from './dw-helpers.ts';
import type { TunnelRuntime } from '../../packages/core/src/dw/tunnel.ts';

/** 成功的 result_set 信封。 */
const okEnv = (rows: unknown[][], columns: string[]) => ({
  code: 0,
  msg: 'success',
  data: { type: 'result_set', meta: columns.map((name) => ({ name, type: 'VARCHAR' })), data: rows, time: 1 },
});
/** 失败信封：真原因在 data 里。 */
const errEnv = (detail: string, code = 1) => ({ code, msg: 'Error', data: detail });

type Route = [string, unknown];

/** 按 SQL 里的关键字路由；未命中给空结果集。 */
function routeFor(sql: string, routes: Route[]): unknown {
  for (const [key, body] of routes) if (sql.includes(key)) return body;
  return okEnv([], []);
}

async function doctorWith(
  routes: Route[],
  envOver: Parameters<typeof envFixture>[0] = {},
  opts: { tunnelRuntime?: TunnelRuntime; fix?: boolean } = {},
) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init: RequestInit) => {
    const stmt = String(JSON.parse(String(init.body)).stmt);
    calls.push(stmt);
    return new Response(JSON.stringify(routeFor(stmt, routes)), { status: 200 });
  }) as typeof fetch;
  try {
    const report = await runWarehouseDoctor(envFixture({ transport: 'http', ...envOver }), {
      timeoutMs: 5,
      tunnelRuntime: opts.tunnelRuntime,
      fix: opts.fix,
    });
    return { report, calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** 一份"一切都好"的路由表。 */
const healthyRoutes: Route[] = [
  ['VERSION', okEnv([['5.7.99']], ['version'])],
  ['SHOW TABLES', okEnv([['tbl_a']], ['Tables_in_demo_db'])],
  ['mv_infos', okEnv([['115']], ['n'])],
  ['DROP TABLE IF EXISTS', okEnv([], [])],
];

test('doctor：全绿路径——六项检查都过，隧道未启用记 skip', async () => {
  const { report } = await doctorWith(healthyRoutes);
  assert.equal(report.ok, true);
  const byName = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
  assert.deepEqual(byName, {
    配置: 'ok',
    隧道: 'skip',
    连通性: 'ok',
    库上下文: 'ok',
    'MV 元数据': 'ok',
    写闸门: 'ok',
    'DDL 能力': 'ok',
  });
  assert.match(report.checks.find((c) => c.name === '连通性')?.detail ?? '', /SELECT VERSION\(\) = 5\.7\.99/);
  assert.match(report.checks.find((c) => c.name === '库上下文')?.detail ?? '', /库 demo_db 可达（1 张表）/);
});

test('doctor：**DDL 能力探测零副作用**——先确认探测表名不在清单里才执行', async () => {
  const { report, calls } = await doctorWith(healthyRoutes);
  assert.equal(report.ok, true);
  const probe = calls.find((c) => c.includes('DROP TABLE'));
  assert.match(probe ?? '', new RegExp(`^DROP TABLE IF EXISTS \`${WRITE_PROBE_TABLE}\`$`));
  // 探测必须在 SHOW TABLES 之后（先确认名字没被占用）
  assert.ok(calls.findIndex((c) => c.includes('SHOW TABLES')) < calls.findIndex((c) => c.includes('DROP TABLE')));
});

test('doctor：探测表名**已存在**时拒绝探测，绝不误删', async () => {
  const { report, calls } = await doctorWith([
    ['VERSION', okEnv([['x']], ['version'])],
    ['SHOW TABLES', okEnv([[WRITE_PROBE_TABLE]], ['Tables_in_demo_db'])],
    ['mv_infos', okEnv([['1']], ['n'])],
  ]);
  const c = report.checks.find((x) => x.name === 'DDL 能力');
  assert.equal(c?.status, 'warn');
  assert.match(c?.detail ?? '', /已存在，跳过探测以免误删/);
  assert.equal(calls.some((x) => x.includes('DROP TABLE')), false);
});

test('doctor：端点不允许 DDL → warn 并指向 transport=cmd（不静默降级）', async () => {
  const { report } = await doctorWith([
    ['VERSION', okEnv([['x']], ['version'])],
    ['SHOW TABLES', okEnv([['tbl_a']], ['t'])],
    ['mv_infos', okEnv([['1']], ['n'])],
    ['DROP TABLE IF EXISTS', errEnv('DDL not allowed')],
  ]);
  const c = report.checks.find((x) => x.name === 'DDL 能力');
  assert.equal(c?.status, 'warn');
  assert.match(c?.detail ?? '', /DDL not allowed/);
  assert.match(c?.hint ?? '', /transport=cmd/);
  assert.equal(report.ok, true); // 只警告，不阻断
});

test('doctor：连通性失败 → 后面全部 skip，只留一个明确的 fail', async () => {
  const { report } = await doctorWith([['VERSION', errEnv('connection refused')]]);
  assert.equal(report.ok, false);
  const byName = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
  assert.equal(byName['连通性'], 'fail');
  assert.equal(byName['库上下文'], 'skip');
  assert.equal(byName['MV 元数据'], 'skip');
  assert.equal(byName['DDL 能力'], 'skip');
});

test('doctor：401 → 提示核对账号密码', async () => {
  const { report } = await doctorWith([['VERSION', { msg: 'Unauthorized', code: 401, data: '' }]]);
  const c = report.checks.find((x) => x.name === '连通性');
  assert.equal(c?.status, 'fail');
  assert.match(c?.detail ?? '', /Unauthorized/);
  assert.match(c?.hint ?? '', /认证失败：核对用户名\/密码/);
});

test('doctor：未配库时明确 skip（不是失败）；库不可达时报 fail', async () => {
  const noDb = await doctorWith(healthyRoutes, { database: undefined });
  const c1 = noDb.report.checks.find((c) => c.name === '库上下文');
  assert.equal(c1?.status, 'skip');
  assert.match(c1?.detail ?? '', /三段式全限定名/);

  const badDb = await doctorWith([
    ['VERSION', okEnv([['x']], ['version'])],
    ['SHOW TABLES', errEnv('Unknown database demo_db')],
  ]);
  assert.equal(badDb.report.checks.find((c) => c.name === '库上下文')?.status, 'fail');
});

test('doctor：SHOW TABLES **不能带 LIMIT**（Doris 会报 mismatched input）', async () => {
  const { calls } = await doctorWith(healthyRoutes);
  const showTables = calls.find((c) => c.includes('SHOW TABLES'));
  assert.equal(/\bLIMIT\b/i.test(showTables ?? ''), false);
});

test('doctor：MV 元数据不可读单独报出来（连通 ≠ 能读 mv_infos）', async () => {
  const { report } = await doctorWith([
    ['VERSION', okEnv([['x']], ['version'])],
    ['SHOW TABLES', okEnv([['a']], ['t'])],
    ['mv_infos', errEnv('SHOW MATERIALIZED VIEWS is not supported')],
    ['DROP TABLE IF EXISTS', okEnv([], [])],
  ]);
  const c = report.checks.find((x) => x.name === 'MV 元数据');
  assert.equal(c?.status, 'fail');
  assert.match(c?.hint ?? '', /Doris 3\.x/);
  assert.equal(report.ok, false);
});

test('doctor：只读环境下不探测写，写闸门报 warn 并给出放行方式', async () => {
  const { report, calls } = await doctorWith(healthyRoutes, { readonly: true });
  assert.equal(report.checks.find((x) => x.name === '写闸门')?.status, 'warn');
  assert.match(report.checks.find((x) => x.name === '写闸门')?.hint ?? '', /DW_ALLOW_PROD_WRITE=1/);
  assert.equal(report.checks.find((x) => x.name === 'DDL 能力')?.status, 'skip');
  assert.equal(calls.some((c) => c.includes('DROP TABLE')), false);
  assert.equal(report.ok, true);
});

test('doctor：未配密码时警告（FE 通常要求 Basic 认证）', async () => {
  const { report } = await doctorWith(healthyRoutes, { password: undefined });
  const c = report.checks.find((x) => x.name === '凭据');
  assert.equal(c?.status, 'warn');
  assert.match(c?.hint ?? '', /warehouse-credentials\.json/);
});

test('doctor：cmd 传输下不检查密码（凭据由外部命令负责）', async () => {
  const { report } = await doctorWith(healthyRoutes, { password: undefined, transport: 'cmd', cmd: 'stub {sql}' });
  assert.equal(report.checks.some((x) => x.name === '凭据'), false);
});

test('doctor：传输层装配失败（cmd 没配模板）单独报出来，不炸掉整个体检', async () => {
  const { report } = await doctorWith(healthyRoutes, { transport: 'cmd', cmd: undefined });
  const c = report.checks.find((x) => x.name === '传输装配');
  assert.equal(c?.status, 'fail');
  assert.match(c?.hint ?? '', /DW_CMD/);
  assert.equal(report.checks.find((x) => x.name === '连通性')?.status, 'skip');
  assert.equal(report.ok, false);
});

test('doctor：凭据文件权限警告作为独立检查项转达', async () => {
  const { report } = await doctorWith(healthyRoutes, { warnings: ['凭据文件权限过宽（644）：建议 chmod 600 /tmp/x'] });
  assert.equal(report.checks.find((x) => x.name === '凭据文件权限')?.status, 'warn');
});

test('doctor：隧道未启用记 skip 并说明是直连', async () => {
  const { report } = await doctorWith(healthyRoutes);
  const c = report.checks.find((x) => x.name === '隧道');
  assert.equal(c?.status, 'skip');
  assert.match(c?.detail ?? '', /未启用隧道（直连）/);
});

test('doctor：隧道启用且端口就绪 → ok 并列出转发对；多进程时提示重建', async () => {
  const rt = stubTunnelRuntime({ listening: [19030, 18030], pids: [1, 2] });
  const { report } = await doctorWith(healthyRoutes, { tunnel: tunnelFixture() }, { tunnelRuntime: rt.runtime });
  const c = report.checks.find((x) => x.name === '隧道');
  assert.equal(c?.status, 'ok');
  assert.match(c?.detail ?? '', /19030→dw-host:9030/);
  assert.match(c?.detail ?? '', /2 个隧道进程/);
});

test('doctor：隧道端口不通 → fail 并给重建指引（不自动修）', async () => {
  const rt = stubTunnelRuntime({ listening: [], pids: [7] });
  const { report } = await doctorWith(healthyRoutes, { tunnel: tunnelFixture() }, { tunnelRuntime: rt.runtime });
  const c = report.checks.find((x) => x.name === '隧道');
  assert.equal(c?.status, 'fail');
  assert.match(c?.detail ?? '', /合盖休眠后进程残留/);
  assert.match(c?.hint ?? '', /dw tunnel up/);
});

test('doctor：--fix 时尝试重建，成功后报 ok', async () => {
  const rt = stubTunnelRuntime({ listening: [], pids: [7], listenAfterExec: [19030, 18030] });
  const { report } = await doctorWith(healthyRoutes, { tunnel: tunnelFixture() }, { tunnelRuntime: rt.runtime, fix: true });
  const c = report.checks.find((x) => x.name === '隧道');
  assert.equal(c?.status, 'ok');
  assert.equal(rt.execs.some((e) => e.cmd === 'ssh'), true);
});

test('doctor：--fix 重建失败时报 fail 并带上原因', async () => {
  const rt = stubTunnelRuntime({
    listening: [],
    pids: [7],
    execResult: (cmd) =>
      cmd === 'ssh' ? { code: 255, stdout: '', stderr: 'Permission denied' } : { code: 0, stdout: '', stderr: '' },
  });
  const { report } = await doctorWith(healthyRoutes, { tunnel: tunnelFixture() }, { tunnelRuntime: rt.runtime, fix: true });
  const c = report.checks.find((x) => x.name === '隧道');
  assert.equal(c?.status, 'fail');
  assert.match(c?.detail ?? '', /重建失败：.*Permission denied/s);
});

test('doctor：报告里的环境描述**不含密码**', async () => {
  const { report } = await doctorWith(healthyRoutes, { password: '<secret>' });
  assert.equal(JSON.stringify(report).includes('<secret>'), false);
  assert.equal(report.env.hasPassword, true);
});

test('doctor：配置项回显带环境名/传输/catalog/库', async () => {
  const { report } = await doctorWith(healthyRoutes);
  assert.match(report.checks.find((c) => c.name === '配置')?.detail ?? '', /环境 test；传输 http；catalog internal；库 demo_db/);
});

test('doctor：未配库时配置项回显"需全限定名"', async () => {
  const { report } = await doctorWith(healthyRoutes, { database: undefined });
  assert.match(report.checks.find((c) => c.name === '配置')?.detail ?? '', /未设，SQL 需全限定名/);
});
