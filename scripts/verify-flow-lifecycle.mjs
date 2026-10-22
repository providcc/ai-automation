#!/usr/bin/env node
/**
 * 真实环境流程生命周期验收：
 *   create → save（并行网关 + 对象/数组属性格式）→ props/export 回读 → list 过滤/分页
 *   → 故意写坏并断言自动回滚 → ETL dry-run（ETL 端点）→ delete（强制快照）→ 二次删除失败保护
 *
 * 用法（凭据只放环境变量，不写入文件）：
 *   RC_BASE_URL='https://<test-host>/restcloud' RC_USER=... RC_PASS=... \
 *     node --experimental-strip-types scripts/verify-flow-lifecycle.mjs \
 *       --allow-host <test-host> [--app test] [--keep]
 *
 * 写操作必须显式放行目标主机：--allow-host <host>（可重复）或 RC_ALLOW_WRITE_HOSTS。
 * 脚本不内置任何环境地址；RC_PROFILE=prod 一律拒绝。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RestCloudClient } from '../packages/core/src/client.ts';
import { resolveTarget } from '../packages/core/src/targets.ts';
import { loginByPassword, loginByToken, loadSession } from '../packages/core/src/auth.ts';
import * as FLOW from '../packages/core/src/flow-lifecycle.ts';

const args = process.argv.slice(2);
const has = (x) => args.includes(x);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const optAll = (name) => args.reduce((acc, cur, i) => (cur === `--${name}` ? [...acc, args[i + 1]] : acc), []);

/** 主机名匹配：精确或 *.example.com 通配 */
const hostMatches = (host, pattern) => {
  const h = String(host).toLowerCase();
  const p = String(pattern).toLowerCase().trim();
  if (!p) return false;
  if (p === h) return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return false;
};

const app = opt('app', 'test');
const keep = has('keep');
const baseUrl = process.env.RC_BASE_URL ?? resolveTarget(process.env.RC_TARGET).baseUrl;
if (!baseUrl) {
  console.error('缺少 RC_BASE_URL（或 rc.targets.json / RC_TARGET）');
  process.exit(2);
}
if (process.env.RC_PROFILE === 'prod') {
  console.error('拒绝在 prod profile 上执行写测试');
  process.exit(2);
}
const targetHost = new URL(baseUrl).host;
const allowedHosts = [...optAll('allow-host'), ...(process.env.RC_ALLOW_WRITE_HOSTS ?? '').split(',')]
  .map((s) => String(s).trim())
  .filter(Boolean);
if (allowedHosts.length === 0) {
  console.error('写测试必须显式放行目标主机：--allow-host <host>（可重复）或 RC_ALLOW_WRITE_HOSTS=host1,host2');
  process.exit(2);
}
if (!allowedHosts.some((p) => hostMatches(targetHost, p))) {
  console.error(`目标主机 ${targetHost} 不在放行名单里（${allowedHosts.join(', ')}）`);
  process.exit(2);
}

const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const steps = [];
/**
 * 轮询直到条件满足（平台属性索引有延迟，立刻读可能少几条）。
 * 把"索引延迟"和"真的坏了"区分开：超时才算失败。
 */
const pollUntil = async (fn, { attempts = 10, intervalMs = 700, label = '' } = {}) => {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = undefined;
    }
    if (i + 1 < attempts) await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (label) console.log(`  ! 轮询超时：${label}`);
  return last;
};
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
  const ok = existsSync(f) ? await loadSession(c, f) : false;
  if (!ok) throw new Error('缺少认证：设置 RC_TOKEN / RC_USER+RC_PASS，或 RC_SESSION_FILE');
}

const name = `rc-it-flow-${runId}`;
const esbConfigId = `RC_IT_${runId}`;
let esbId;
let report;

try {
  // 1. 新建 ESB 流程
  const created = await FLOW.createFlow(c, { applicationId: app, processName: name, configId: esbConfigId, kind: 'esb' }, { dryRun: false, kind: 'esb' });
  record('create esb', created.ok && Boolean(created.processId), { processId: created.processId, configId: created.configId, msg: created.msg });
  esbId = created.processId;
  if (!esbId) throw new Error('创建成功但未回查到 processId');

  // 2. 保存并行网关模板；属性用对象格式（templates show 的格式）
  const template = JSON.parse(readFileSync(new URL('../catalog/flow-templates/fanout-aggregate.json', import.meta.url), 'utf8'));
  const save1 = await FLOW.saveFlowComplete(c, {
    kind: 'esb', appId: 'esb', processId: esbId, model: template.model, nodeProps: template.props,
  });
  record('save esb (object props)', save1.ok, {
    msg: save1.msg, snapshot: save1.snapshotFile, check: save1.check?.msg,
    inserted: save1.props?.inserted.length, updated: save1.props?.updated.length,
    verified: save1.verified, rolledBack: save1.rolledBack,
  });
  record('esb platform check', save1.check?.ok === true, { msg: save1.check?.msg });
  record('esb readback props', save1.verified?.propsOk === true, { verified: save1.verified });

  // 3. props / export 回读（图 + 属性）——断言前先轮询，区分"索引延迟"与"真的坏了"
  const props = await pollUntil(
    async () => {
      const r = await FLOW.listFlowProps(c, esbId, { kind: 'esb' });
      return r.ok && r.props.G00001?.gatewayType === '2' ? r : undefined;
    },
    { label: 'props list 读到并行网关属性' },
  ) ?? { ok: false, props: {} };
  record('props list', props.ok && props.props.G00001?.gatewayType === '2' && props.props.G00002?.joinNodeId === 'G00001',
    { keys: Object.keys(props.props), gatewayType: props.props.G00001?.gatewayType, joinNodeId: props.props.G00002?.joinNodeId });

  const exported = await FLOW.exportFlow(c, esbId, { kind: 'esb' });
  record('flow export', exported.ok && Boolean(exported.doc?.model) && Object.keys(exported.doc?.props ?? {}).length >= 12,
    { nodes: exported.doc?.model?.nodeDataArray?.length, props: Object.keys(exported.doc?.props ?? {}).length });
  // 导出的流程缺必填属性时（模板里的 apiNode 没有 apiUrl）应标记 skeleton：
  // 导出 → 校验/保存 只提示不阻断。
  record('export marks skeleton when required props are missing',
    exported.doc?.skeleton === true && Array.isArray(exported.doc?.missingRequired),
    { skeleton: exported.doc?.skeleton, missingRequired: exported.doc?.missingRequired });

  // 3b. 并发写保护 + 保存前语义 diff：
  //     平台被"别人"改过 → 用旧指纹保存必须被拒绝；重新导出后再存必须通过。
  const bumped = JSON.parse(JSON.stringify(exported.doc.model));
  const bumpedNode = (bumped.nodeDataArray ?? []).find((n) => n.nodeType === 'apiNode');
  if (bumpedNode) bumpedNode.text = `${bumpedNode.text ?? ''}（并发修改）`;
  await FLOW.saveFlowComplete(c, {
    kind: 'esb', appId: 'esb', processId: esbId, model: bumped, nodeProps: exported.doc.props,
  });
  const stale = await FLOW.saveFlowComplete(c, {
    kind: 'esb', appId: 'esb', processId: esbId, model: exported.doc.model, nodeProps: exported.doc.props,
    expectedFingerprint: exported.doc.fingerprint, dryRun: true,
  });
  record('concurrent write protection', stale.ok === false && /已被修改/.test(stale.msg ?? ''), {
    msg: stale.msg, expected: exported.doc.fingerprint, actual: stale.fingerprint?.actual,
  });
  const reExported = await FLOW.exportFlow(c, esbId, { kind: 'esb' });
  const fresh = await FLOW.saveFlowComplete(c, {
    kind: 'esb', appId: 'esb', processId: esbId, model: reExported.doc.model, nodeProps: reExported.doc.props,
    expectedFingerprint: reExported.doc.fingerprint, dryRun: true,
  });
  record('re-export then save', fresh.ok === true && fresh.fingerprint?.matched === true && Boolean(fresh.diff), {
    msg: fresh.msg, diff: fresh.diff?.summary,
  });
  // 还原成最初的模型，后续步骤继续按原计划走
  await FLOW.saveFlowComplete(c, {
    kind: 'esb', appId: 'esb', processId: esbId, model: exported.doc.model, nodeProps: exported.doc.props,
  });

  // 4. 数组格式再次保存（同一份图/属性，验证 normalize 不产生重复）
  const arr = FLOW.normalizeNodeProps(exported.doc.props) ?? [];
  const save2 = await FLOW.saveFlowComplete(c, {
    kind: 'esb', appId: 'esb', processId: esbId, model: exported.doc.model, nodeProps: arr,
  });
  record('save esb (array props)', save2.ok && save2.props?.failed.length === 0, {
    msg: save2.msg, inserted: save2.props?.inserted.length, updated: save2.props?.updated.length, verified: save2.verified,
  });

  // 4b. 属性单独保存：强制快照 + 幂等 upsert（不产生重复）+ 回读
  const oneNode = arr.find((n) => n.nodeId === 'G00001') ?? arr[0];
  const propSave = await FLOW.saveNodePropsComplete(c, {
    kind: 'esb', appId: 'esb', processId: esbId, nodes: [oneNode],
  }, { dryRun: false });
  const afterPropSave = await pollUntil(
    async () => {
      const r = await FLOW.listFlowProps(c, esbId, { kind: 'esb' });
      return r.ok && r.props.G00001?.gatewayType === '2' ? r : undefined;
    },
    { label: 'props save 后回读' },
  ) ?? { ok: false, props: {} };
  record('props save (snapshot + upsert)', propSave.failed.length === 0 && Boolean(propSave.snapshotFile)
    && afterPropSave.props.G00001?.gatewayType === '2', {
    snapshot: propSave.snapshotFile, updated: propSave.updated.length, inserted: propSave.inserted.length,
    deduped: propSave.deduped?.length ?? 0,
  });

  // 5. 客户端过滤/分页
  const all = await FLOW.listFlows(c, { kind: 'esb', all: true, pageSize: 100 });
  const filtered = FLOW.filterFlows(FLOW.unwrapFlowRows(all.data?.data ?? all.data), { keyword: runId, appId: app });
  record('flow list filter', filtered.some((x) => x.processId === esbId), { total: filtered.length });

  // 5b. 回滚：故意写坏（删掉聚合网关 → 平台校验"网关没有成对"）→ 必须自动回滚并复原
  const goodModel = exported.doc.model;
  const brokenModel = {
    ...goodModel,
    nodeDataArray: (goodModel.nodeDataArray ?? []).filter((n) => n.key !== 'G00002'),
    linkDataArray: (goodModel.linkDataArray ?? []).filter((l) => l.from !== 'G00002' && l.to !== 'G00002'),
  };
  const bad = await FLOW.saveFlowComplete(c, {
    kind: 'esb', appId: 'esb', processId: esbId, model: brokenModel, nodeProps: arr,
  });
  record('rollback on platform check failure', bad.rolledBack === true && bad.check?.ok === false, {
    msg: bad.msg, check: bad.check?.msg, rolledBack: bad.rolledBack, rollbackMsg: bad.rollback?.msg,
  });
  const afterRollback = await pollUntil(
    async () => {
      const r = await FLOW.listFlowProps(c, esbId, { kind: 'esb' });
      return r.ok && r.props.G00002?.joinNodeId === 'G00001' ? r : undefined;
    },
    { label: '回滚后属性复原可见' },
  ) ?? { ok: false, props: {} };
  const afterExport = await FLOW.exportFlow(c, esbId, { kind: 'esb' });
  const restoredNodes = (afterExport.doc?.model?.nodeDataArray ?? []).map((n) => n.key);
  record('rollback restored model and props', afterRollback.props.G00002?.joinNodeId === 'G00001'
    && restoredNodes.includes('G00002')
    && Object.keys(afterRollback.props).length === Object.keys(props.props).length, {
    props: Object.keys(afterRollback.props).length, expected: Object.keys(props.props).length,
    gatewayRestored: Boolean(afterRollback.props.G00002),
  });

  // 6. ETL dry-run：只构造 ETL 端点的请求，不落库
  const etl = await FLOW.listFlows(c, { kind: 'etl', all: true, pageSize: 100 });
  const etlRows = FLOW.unwrapFlowRows(etl.data?.data ?? etl.data).filter((x) => x.processModel);
  let etlDry = null;
  let etlMsg = '测试环境没有可用的 ETL 流程';
  for (const row of etlRows.slice(0, 5)) {
    const detail = await FLOW.exportFlow(c, row.processId, { kind: 'etl' });
    if (!detail.ok) {
      etlMsg = detail.msg ?? 'ETL 详情读取失败';
      continue;
    }
    etlDry = await FLOW.saveFlowComplete(c, {
      kind: 'etl', appId: 'etl', processId: row.processId, model: detail.doc.model,
      nodeProps: detail.doc.props, dryRun: true, snapshot: true,
    });
    break;
  }
  record('etl dry-run', etlDry?.ok === true && !etlDry.check && !etlDry.snapshotFile,
    { msg: etlDry?.msg ?? etlMsg, inserted: etlDry?.props?.inserted.length });

  // 7. 删除：先快照；二次删除必须失败（快照失败即中止）
  const del = await FLOW.deleteFlow(c, esbId, { kind: 'esb', dryRun: false });
  record('delete with snapshot', del.ok && Boolean(del.snapshotFile), {
    snapshot: del.snapshotFile, msg: del.msg, data: del.data, body: del.request?.body,
  });
  esbId = undefined;
  await new Promise((r) => setTimeout(r, 2500));
  const gone = await FLOW.getFlow(c, created.processId, { kind: 'esb' });
  record('delete readback', gone.ok === false, { status: gone.httpStatus });

  let blocked = false;
  let blockedMsg = '';
  try {
    await FLOW.deleteFlow(c, created.processId, { kind: 'esb', dryRun: false });
  } catch (e) {
    blocked = true;
    blockedMsg = e.message;
  }
  record('delete failure guarded', blocked, { msg: blockedMsg });

  report = { runId, target: '(redacted)', profile: process.env.RC_PROFILE ?? 'uat', app, ok: true, steps };
} catch (e) {
  report = { runId, target: '(redacted)', profile: process.env.RC_PROFILE ?? 'uat', app, ok: false, error: e.message, steps };
  throw e;
} finally {
  if (esbId && !keep) {
    try { await FLOW.deleteFlow(c, esbId, { kind: 'esb', dryRun: false }); } catch { /* best effort */ }
  }
  mkdirSync('reports', { recursive: true });
  writeFileSync(`reports/flow-lifecycle-${runId}.json`, JSON.stringify(report ?? { runId, ok: false, steps }, null, 2));
}
