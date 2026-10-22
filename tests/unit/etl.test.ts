import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProcessModel } from '../../packages/core/src/flow-build.ts';
import { validateFlow, hasBlockingError } from '../../packages/core/src/flow-validate.ts';
import { Catalog } from '../../packages/core/src/catalog.ts';
import * as ETL from '../../packages/core/src/etl.ts';
import { executeCompensation } from '../../packages/core/src/etl-compensate.ts';
import { checkCatalogHealth } from '../../packages/core/src/fingerprint.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('ETL 模型：只有三键（实测契约）', () => {
  const { model } = buildProcessModel({
    kind: 'etl',
    nodes: [{ nodeType: 'start' }, { nodeType: 'sqlReadNode' }, { nodeType: 'jdbcWriteNode' }, { nodeType: 'end' }],
    edges: [{ from: 'E00001', to: 'T00001' }, { from: 'T00001', to: 'T00002' }, { from: 'T00002', to: 'E00002' }],
  });
  assert.deepEqual(Object.keys(model).sort(), ['linkDataArray', 'nodeDataArray', 'transform']);
});

test('ETL 组件目录：面板 78 项且含关键节点', () => {
  const cat = new Catalog();
  const c = cat.etlComponentCatalog();
  const panel = c.categories.reduce((s, x) => s + x.count, 0);
  assert.ok(panel >= 70, `面板节点数 ${panel} 偏少`);
  for (const t of ['sqlReadNode', 'jdbcWriteNode', 'fieldMappingNode', 'apiNode', 'subProcessNode', 'gateWay', 'start', 'end']) {
    assert.ok(cat.etlNodeTypes().has(t), `缺少节点 ${t}`);
  }
});

test('ETL 流程校验：用 ETL 白名单通过', () => {
  const cat = new Catalog();
  const { model } = buildProcessModel({
    kind: 'etl',
    nodes: [{ nodeType: 'start' }, { nodeType: 'sqlReadNode' }, { nodeType: 'end' }],
    edges: [{ from: 'E00001', to: 'T00001' }, { from: 'T00001', to: 'E00002' }],
  });
  const issues = validateFlow(model, { knownTypes: cat.etlNodeTypes() });
  assert.equal(hasBlockingError(issues), false, JSON.stringify(issues));
});

test('ETL 写路径默认封禁：未设置 RC_ENABLE_ETL_WRITE 时拒绝试跑/补偿', async () => {
  const prev = process.env.RC_ENABLE_ETL_WRITE;
  delete process.env.RC_ENABLE_ETL_WRITE;
  try {
    const client: any = { baseUrl: 'https://example.test/restcloud', request: async () => { throw new Error('不应触网'); } };
    await assert.rejects(() => ETL.runEtl(client, 'p1', { dryRun: false }), /ETL 写操作已封禁/);
    await assert.rejects(() => ETL.compensateEtl(client, 'p1'), /ETL 写操作已封禁/);
    await assert.rejects(() => ETL.publishEtl(client, 'p1'), /ETL 写操作已封禁/);
    await assert.rejects(
      () => executeCompensation(client, { ok: true, items: [{ transactionId: 't1' }], skipped: [], warnings: [] } as any, { apply: true }),
      /ETL 写操作已封禁/,
    );
    assert.equal(ETL.etlWriteEnabled({}), false);
    assert.equal(ETL.etlWriteEnabled({ RC_ENABLE_ETL_WRITE: '1' }), true);
  } finally {
    if (prev === undefined) delete process.env.RC_ENABLE_ETL_WRITE;
    else process.env.RC_ENABLE_ETL_WRITE = prev;
  }
});

test('ETL 写路径：显式打开后允许（请求照常发出）', async () => {
  const prev = process.env.RC_ENABLE_ETL_WRITE;
  process.env.RC_ENABLE_ETL_WRITE = '1';
  try {
    const seen: any[] = [];
    const client: any = {
      baseUrl: 'https://example.test/restcloud',
      request: async (path: string, opts: any) => { seen.push({ path, opts }); return { ok: true, httpStatus: 200, data: {}, request: opts }; },
    };
    const r = await ETL.runEtl(client, 'p1', { mode: 'test', limit: 10, dryRun: false });
    assert.equal(r.ok, true);
    assert.equal(seen[0].path, '/rest/etl/process/run');
  } finally {
    if (prev === undefined) delete process.env.RC_ENABLE_ETL_WRITE;
    else process.env.RC_ENABLE_ETL_WRITE = prev;
  }
});

test('ETL 组件目录是可选文件：缺失时 doctor 不失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-catalog-'));
  try {
    const pad = 'x'.repeat(200);
    writeFileSync(join(dir, 'endpoints.json'), JSON.stringify({ endpoints: [{ path: pad }] }));
    writeFileSync(join(dir, 'components.json'), JSON.stringify({ nodes: [{ id: pad }] }));
    writeFileSync(join(dir, 'fingerprint.json'), JSON.stringify({ version: 1, files: [] }));
    const health = checkCatalogHealth(dir);
    const etlCheck = health.checks.find((c) => c.name === 'etl-components.json');
    assert.ok(etlCheck, '应当报告可选文件状态');
    assert.equal(etlCheck?.ok, true);
    assert.equal(health.ok, true, 'ESB-only 目录不应让 doctor 失败');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
