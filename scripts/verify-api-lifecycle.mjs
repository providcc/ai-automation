#!/usr/bin/env node
/**
 * 真实环境 **API 域** 生命周期验收：
 *   生成 OpenAPI → 分析 → 导入（真实落库）→ 列表/详情回读 → 下线 → 删除 → 确认消失 → 清理兜底
 *
 * 与流程域验收（verify-flow-lifecycle.mjs）同样的安全约束：
 *   - 写测试必须显式放行目标主机：--allow-host <host>（可重复）或 RC_ALLOW_WRITE_HOSTS；
 *   - RC_PROFILE=prod 一律拒绝；
 *   - 报告不含目标地址与凭据。
 *
 * 用法：
 *   RC_BASE_URL='https://<test-host>/restcloud' RC_USER=... RC_PASS=... \
 *     node --experimental-strip-types scripts/verify-api-lifecycle.mjs --allow-host <test-host> [--app test]
 *
 * 临时资源识别：本次创建的服务用唯一 categoryId（RC_IT_<runId>）+ 唯一路径前缀标记，
 * 清理时只按这两个标记删，**不会碰其它 API**。
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RestCloudClient } from '../packages/core/src/client.ts';
import { resolveTarget } from '../packages/core/src/targets.ts';
import { loginByPassword, loginByToken, loadSession } from '../packages/core/src/auth.ts';
import * as API from '../packages/core/src/api.ts';

const args = process.argv.slice(2);
const has = (x) => args.includes(x);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const optAll = (name) => args.reduce((acc, cur, i) => (cur === `--${name}` ? [...acc, args[i + 1]] : acc), []);

const app = opt('app', 'test');
const baseUrl = process.env.RC_BASE_URL ?? resolveTarget(process.env.RC_TARGET).baseUrl;
if (!baseUrl) {
  console.error('缺少 RC_BASE_URL（或 rc.targets.json / RC_TARGET）');
  process.exit(2);
}
if (process.env.RC_PROFILE === 'prod') {
  console.error('拒绝在 prod profile 上执行写测试');
  process.exit(2);
}
const allowedHosts = [...optAll('allow-host'), ...(process.env.RC_ALLOW_WRITE_HOSTS ?? '').split(',')]
  .map((s) => String(s).trim()).filter(Boolean);
if (!allowedHosts.length) {
  console.error('写测试必须显式放行目标主机：--allow-host <host>（可重复）或 RC_ALLOW_WRITE_HOSTS=host1,host2');
  process.exit(2);
}
const targetHost = new URL(baseUrl).host;
const hostMatches = (host, pattern) => {
  const h = String(host).toLowerCase();
  const p = String(pattern).toLowerCase().trim();
  if (!p) return false;
  if (p === h) return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return false;
};
if (!allowedHosts.some((p) => hostMatches(targetHost, p))) {
  console.error(`目标主机 ${targetHost} 不在放行名单里（${allowedHosts.join(', ')}）`);
  process.exit(2);
}

const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const marker = `RC_IT_${runId}`;
const steps = [];
const record = (name, ok, detail = {}) => {
  steps.push({ name, ok, at: new Date().toISOString(), ...detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail.msg ? ` — ${detail.msg}` : ''}`);
  if (!ok) throw new Error(`${name}: ${detail.msg ?? 'failed'}`);
};

const c = new RestCloudClient({ baseUrl, profile: (process.env.RC_PROFILE ?? 'uat') });
if (process.env.RC_TOKEN) {
  await loginByToken(c, process.env.RC_TOKEN);
} else if (process.env.RC_USER && process.env.RC_PASS) {
  await loginByPassword(c, process.env.RC_USER, process.env.RC_PASS);
} else {
  const f = process.env.RC_SESSION_FILE ?? join(homedir(), '.rc', 'session-default.json');
  const okAuth = existsSync(f) ? await loadSession(c, f) : false;
  if (!okAuth) throw new Error('缺少认证：设置 RC_TOKEN / RC_USER+RC_PASS，或 RC_SESSION_FILE');
}

/** 拉取应用下的服务并按本次标记过滤（平台的 keyword 不可用，只能客户端过滤）。 */
async function listMine() {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = await API.listApis(c, { appId: app, page, size: 100 });
    if (!r.ok) return { ok: false, rows: out };
    const rows = Array.isArray(r.data?.data) ? r.data.data : (r.data?.data?.rows ?? r.data?.rows ?? []);
    if (!rows.length) break;
    for (const row of rows) {
      if (String(row.categoryId ?? '').includes(marker) || String(row.configId ?? '').includes(marker)) out.push(row);
    }
    if (rows.length < 100) break;
  }
  return { ok: true, rows: out };
}

/** 清理：把本次创建的服务下线并删除（只按 marker 匹配）。 */
async function cleanup() {
  const { rows } = await listMine();
  if (!rows.length) return { removed: 0 };
  let removed = 0;
  for (const row of rows) {
    try {
      const detail = await API.getApi(c, String(row.id));
      const d = detail.data?.data ?? detail.data;
      if (d) await API.saveApi(c, { ...d, state: '0' }, { dryRun: false }); // 先下线
      const del = await API.deleteApi(c, [String(row.id)]);
      if (del.ok) removed++;
    } catch { /* best effort */ }
  }
  return { removed };
}

let report;
try {
  // 1. 生成带唯一标记的 OpenAPI 文档
  const spec = {
    openapi: '3.0.0',
    info: { title: marker, version: '1.0.0' },
    paths: {
      [`/rc-it-${runId}/ping`]: { get: { summary: `ping-${runId}`, responses: { 200: { description: 'ok' } } } },
      [`/rc-it-${runId}/pong`]: { post: { summary: `pong-${runId}`, responses: { 200: { description: 'ok' } } } },
    },
  };
  const specText = JSON.stringify(spec);

  // 2. 分析（只读，不落库）
  const items = await API.analyzeOpenApi(c, app, specText);
  record('openapi analysis', Array.isArray(items) && items.length === 2, {
    items: items.length, sample: items.map((i) => `${i.methodType} ${i.mapUrl}`),
  });

  // 3. 导入（真实落库；显式 dryRun:false，importOpenApi 默认是预览）
  const imp = await API.importOpenApi(c, app, specText, { categoryId: marker, dryRun: false });
  record('openapi import', imp.ok === true, { msg: imp.msg, data: imp.data?.data ?? imp.data });

  // 4. 列表回读（按 marker 过滤）
  const listed = await listMine();
  const mine = listed.rows;
  record('list created apis', listed.ok && mine.length === 2, {
    found: mine.length, ids: mine.map((r) => r.id),
  });
  const ids = mine.map((r) => String(r.id));

  // 5. 详情回读
  const detail = await API.getApi(c, ids[0]);
  const d = detail.data?.data ?? detail.data;
  record('get api detail', detail.ok === true && String(d?.mapUrl ?? '').includes(`rc-it-${runId}`), {
    mapUrl: d?.mapUrl, methodType: d?.methodType, state: d?.state,
  });

  // 6. 下线（平台的删除前置条件）
  const off = await API.saveApi(c, { ...d, state: '0' }, { dryRun: false });
  const afterOff = await API.getApi(c, ids[0]);
  record('offline api', off.ok === true && String((afterOff.data?.data ?? afterOff.data)?.state) === '0', {
    state: (afterOff.data?.data ?? afterOff.data)?.state, msg: off.msg,
  });

  // 7. 删除
  const del = await API.deleteApi(c, ids);
  record('delete apis', del.ok === true, { data: del.data?.data ?? del.data, msg: del.msg });

  // 8. 确认消失
  const gone = await API.getApi(c, ids[0]);
  const left = await listMine();
  record('deleted apis are gone', gone.ok === false && left.rows.length === 0, {
    detailOk: gone.ok, detailMsg: (gone.msg ?? '').slice(0, 80), leftover: left.rows.length,
  });

  report = { runId, target: '(redacted)', profile: process.env.RC_PROFILE ?? 'uat', app, ok: true, steps };
} catch (e) {
  report = { runId, target: '(redacted)', profile: process.env.RC_PROFILE ?? 'uat', app, ok: false, error: e.message, steps };
  throw e;
} finally {
  const cleaned = await cleanup().catch(() => ({ removed: -1 }));
  if (cleaned.removed > 0) console.log(`  清理兜底：删除 ${cleaned.removed} 个临时服务`);
  mkdirSync('reports', { recursive: true });
  writeFileSync(`reports/api-lifecycle-${runId}.json`, JSON.stringify({ ...report, cleaned }, null, 2));
}
