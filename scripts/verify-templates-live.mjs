#!/usr/bin/env node
/**
 * 27 个标准模板在真实测试环境的保存/校验/回读验证。
 *
 * 用法（凭据只放环境变量，不写入任何文件）：
 *   RC_BASE_URL='https://<test-host>/restcloud' RC_USER=... RC_PASS=... \
 *     node --experimental-strip-types scripts/verify-templates-live.mjs [--only sync-api] [--keep] [--app test]
 *
 * 行为：
 *   1. 在目标应用下创建 `rc-tpl-<id>-<runId>` 流程；
 *   2. saveFlowComplete：节点/路由属性 → 图保存 → 平台 checkerror → 回读；
 *   3. 默认删除验证流程（--keep 保留；失败时也删除，除非 --keep-fail）；
 *   4. 结果写 reports/templates-live-<runId>.jsonl 与 .json。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RestCloudClient } from '../packages/core/src/client.ts';
import { resolveTarget } from '../packages/core/src/targets.ts';
import { loginByPassword, loginByToken } from '../packages/core/src/auth.ts';
import { Catalog } from '../packages/core/src/catalog.ts';
import { createFlow, saveFlowComplete, deleteFlow } from '../packages/core/src/flow-lifecycle.ts';
import { validateFlow } from '../packages/core/src/flow-validate.ts';

const args = process.argv.slice(2);
const has = (x) => args.includes(x);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const only = opt('only');
const keep = has('--keep');
const keepFail = has('--keep-fail');
const app = opt('app', process.env.RC_APP ?? 'test');
const baseUrl = process.env.RC_BASE_URL;
if (!baseUrl) {
  console.error('缺少 RC_BASE_URL（例如 https://<test-host>/restcloud）');
  process.exit(2);
}
const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const catalogDir = new URL('../catalog/', import.meta.url).pathname;
const templatesDir = join(catalogDir, 'flow-templates');
const index = JSON.parse(readFileSync(join(templatesDir, 'index.json'), 'utf8'));
const rows = (index.templates ?? []).filter((t) => !only || t.id === only);
if (!rows.length) {
  console.error(`没有匹配的模板：${only ?? '(全部)'}`);
  process.exit(2);
}

const target = resolveTarget(process.env.RC_TARGET);
const c = new RestCloudClient({ baseUrl, profile: (process.env.RC_PROFILE ?? 'uat') });
if (process.env.RC_TOKEN) await loginByToken(c, process.env.RC_TOKEN);
else await loginByPassword(c, process.env.RC_USER ?? '', process.env.RC_PASS ?? '');
console.log(`目标 ${baseUrl}，应用 ${app}，模板 ${rows.length} 个，runId=${runId}`);

const catalog = new Catalog();
const known = catalog.nodeTypes();
const outDir = join(process.cwd(), 'reports');
mkdirSync(outDir, { recursive: true });
const jsonl = join(outDir, `templates-live-${runId}.jsonl`);
const outJson = join(outDir, `templates-live-${runId}.json`);

const results = [];
function record(x) {
  results.push(x);
  writeFileSync(jsonl, JSON.stringify(x) + '\n', { flag: 'a' });
  console.log(`${x.ok ? '✔' : '✖'} ${x.id.padEnd(26)} create=${x.createOk ? 'ok' : 'fail'} save=${x.saveOk ? 'ok' : 'fail'} check=${x.checkOk ? 'ok' : 'fail'} ${x.msg ?? ''}`);
}

for (const t of rows) {
  const doc = JSON.parse(readFileSync(join(templatesDir, `${t.id}.json`), 'utf8'));
  const localIssues = validateFlow(doc.model, { knownTypes: known, allowMock: false, nodeProps: doc.props });
  const localErrors = localIssues.filter((i) => i.level === 'error');
  const name = `rc-tpl-${t.id}-${runId}`;
  let processId;
  let createOk = false;
  let saveOk = false;
  let checkOk = false;
  let checkMsg;
  let msg = '';
  try {
    const cr = await createFlow(c, { applicationId: app, processName: name }, { dryRun: false });
    createOk = cr.ok && Boolean(cr.processId);
    processId = cr.processId;
    if (!createOk) {
      msg = `创建失败：${cr.msg ?? '未回查到 processId'}`;
      continue;
    }
    const props = doc.props
      ? Object.entries(doc.props).map(([nodeId, v]) => ({
        nodeId,
        nodeType: String(v.pNodeType ?? 'unknown'),
        nodeName: v.pNodeName,
        props: { ...v },
      }))
      : undefined;
    const rep = await saveFlowComplete(c, {
      appId: 'esb',
      processId,
      model: doc.model,
      nodeProps: props,
      dryRun: false,
    });
    saveOk = rep.ok;
    checkOk = rep.check?.ok ?? false;
    checkMsg = rep.check?.msg;
    msg = rep.msg ?? '';
    if (rep.props?.failed?.length) msg += ` propsFailed=${rep.props.failed.length}`;
    if (rep.verified && !rep.verified.propsOk) msg += ` missingProps=${rep.verified.missing.length}`;
  } catch (e) {
    msg = e?.message ?? String(e);
  } finally {
    const shouldDelete = processId && !keep && !(keepFail && !saveOk);
    if (shouldDelete) {
      try {
        const dr = await deleteFlow(c, processId, { dryRun: false, retries: 3 });
        if (!dr.ok) msg += ` deleteFailed=${dr.msg ?? ''}`;
      } catch (e) {
        msg += ` deleteError=${e?.message ?? e}`;
      }
    }
    record({
      ok: createOk && saveOk && checkOk && localErrors.length === 0,
      id: t.id,
      name,
      processId: keep || (keepFail && !saveOk) ? processId : undefined,
      createOk,
      saveOk,
      checkOk,
      checkMsg,
      localErrors: localErrors.length,
      msg,
      at: new Date().toISOString(),
    });
  }
}

const summary = {
  runId,
  target: baseUrl,
  app,
  total: results.length,
  createOk: results.filter((x) => x.createOk).length,
  saveOk: results.filter((x) => x.saveOk).length,
  checkOk: results.filter((x) => x.checkOk).length,
  localErrors: results.filter((x) => x.localErrors).length,
  failed: results.filter((x) => !x.ok).map((x) => ({ id: x.id, msg: x.msg })),
  kept: results.filter((x) => x.processId).map((x) => ({ id: x.id, processId: x.processId })),
  results,
};
writeFileSync(outJson, JSON.stringify(summary, null, 2) + '\n');
console.log(`\n汇总：创建 ${summary.createOk}/${summary.total}，保存 ${summary.saveOk}/${summary.total}，平台校验 ${summary.checkOk}/${summary.total}`);
console.log(`报告：${outJson}`);
if (summary.failed.length) {
  console.log('失败模板：');
  for (const f of summary.failed) console.log(`  ✖ ${f.id}: ${f.msg}`);
}
process.exit(summary.failed.length ? 4 : 0);
