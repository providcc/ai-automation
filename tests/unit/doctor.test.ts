/**
 * rc doctor 单测：目录完整性 / 目录漂移 / 目标与生产闸门 / 审计目录 / 联网检查。
 * 全部使用桩客户端与临时目录，不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { doctor, formatDoctor } from '../../packages/core/src/doctor.ts';
import { computeCatalogFingerprint } from '../../packages/core/src/fingerprint.ts';
import { stub, ok, fail, tmpDir, withEnv } from './helpers.ts';

/** 造一个"健康"的目录（必填文件齐全） */
function healthyCatalog(extra: Record<string, string> = {}) {
  const t = tmpDir('rc-catalog-');
  const pad = 'x'.repeat(200);
  t.write('endpoints.json', JSON.stringify({ endpoints: [{ path: pad }] }));
  t.write('components.json', JSON.stringify({ nodes: [{ id: pad }] }));
  for (const [k, v] of Object.entries(extra)) t.write(k, v);
  return t;
}

/** 空目录（必填文件全缺） */
function emptyCatalog() {
  return tmpDir('rc-catalog-empty-');
}

/** 桩客户端 + 可控 session */
function doctorClient(handler: (path: string) => any, session?: () => Promise<any>) {
  const { client, calls } = stub(handler);
  client.session = session ?? (async () => ok({ userName: 'tester' }));
  return { client, calls };
}

const find = (r: any, name: string) => r.checks.find((c: any) => c.name === name);

test('doctor：无目标时跳过目标检查，未联网时给出 connect 提示', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir });
    assert.equal(find(r, 'target')?.status, 'skip');
    assert.ok(find(r, 'target')?.detail.includes('未提供目标'));
    assert.equal(find(r, 'connect')?.status, 'skip');
    assert.equal(r.target?.profile, undefined);
    assert.equal(r.target?.name, undefined);
    assert.ok(typeof r.generatedAt === 'string' && r.generatedAt.length > 0);
    assert.equal(r.ok, r.summary.fail === 0);
    assert.equal(r.summary.pass + r.summary.warn + r.summary.fail + r.summary.skip, r.checks.length);
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：目录完整性检查（缺文件即 fail 并给出修复动作）', async () => {
  const cat = emptyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir });
    const ep = find(r, 'catalog:endpoints.json');
    const comp = find(r, 'catalog:components.json');
    assert.equal(ep?.status, 'fail');
    assert.equal(ep?.detail, '文件不存在');
    assert.ok(ep?.action?.includes('rc catalog sync'), ep?.action);
    assert.equal(comp?.status, 'fail');
    assert.ok(comp?.action);
    const fp = find(r, 'catalog:fingerprint.json');
    assert.equal(fp?.status, 'fail');
    assert.equal(fp?.action, 'rc catalog fingerprint --write');
    assert.equal(r.ok, false);
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：目录完整时必填项为 pass', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir });
    assert.equal(find(r, 'catalog:endpoints.json')?.status, 'pass');
    assert.equal(find(r, 'catalog:components.json')?.status, 'pass');
    assert.equal(find(r, 'catalog:etl-components.json')?.status, 'pass');
    assert.equal(find(r, 'catalog:etl-components.json')?.action, undefined);
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：没有基线指纹时无法判断漂移（warn）', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir });
    const drift = find(r, 'catalog:drift');
    assert.equal(drift?.status, 'warn');
    assert.ok(drift?.detail.includes('尚无基线指纹'));
    assert.equal(drift?.action, 'rc catalog fingerprint --write');
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：指纹与当前目录一致时目录未漂移（pass）', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const fp = computeCatalogFingerprint(cat.dir);
    cat.write('fingerprint.json', JSON.stringify(fp, null, 1));
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir });
    const drift = find(r, 'catalog:drift');
    assert.equal(drift?.status, 'pass');
    assert.ok(drift?.detail.includes('目录未漂移'));
    assert.equal(drift?.action, undefined);
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：目录内容变化时提示漂移（warn）并给出重建基线动作', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const fp = computeCatalogFingerprint(cat.dir);
    fp.files = fp.files.map((f) => (f.file === 'endpoints.json' ? { ...f, sha256: 'changed' } : f));
    fp.digest = 'changed-digest';
    cat.write('fingerprint.json', JSON.stringify(fp, null, 1));
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir });
    const drift = find(r, 'catalog:drift');
    assert.equal(drift?.status, 'warn');
    assert.ok(drift?.detail.includes('目录已漂移'));
    assert.ok(drift?.detail.includes('endpoints.json'));
    assert.ok(drift?.action?.includes('fingerprint --write'));
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：可选目录文件缺失不算漂移', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const fp = computeCatalogFingerprint(cat.dir);
    fp.files.push({ file: 'etl-components.json', bytes: 10, sha256: 'deadbeef' });
    fp.digest = 'digest-with-optional';
    cat.write('fingerprint.json', JSON.stringify(fp, null, 1));
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir });
    const drift = find(r, 'catalog:drift');
    assert.equal(drift?.status, 'pass', `可选文件缺失应被忽略：${drift?.detail}`);
    assert.ok(drift?.detail.includes('目录未漂移'));
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：指纹文件损坏时无法检测漂移（warn）', async () => {
  const cat = healthyCatalog({ 'fingerprint.json': 'not-json' });
  const aud = tmpDir('rc-audit-');
  try {
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir });
    const drift = find(r, 'catalog:drift');
    assert.equal(drift?.status, 'warn');
    assert.ok(drift?.detail.includes('无法检测漂移'));
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：基线为空时漂移提示里新增文件会被列出', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    cat.write('fingerprint.json', JSON.stringify({
      version: 1,
      algorithm: 'sha256',
      generatedAt: '2026-01-01T00:00:00.000Z',
      catalogDir: 'catalog',
      files: [],
      digest: 'empty-baseline',
    }, null, 1));
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir });
    const drift = find(r, 'catalog:drift');
    assert.equal(drift?.status, 'warn');
    assert.ok(drift?.detail.includes('变更 -'), drift?.detail);
    assert.ok(drift?.detail.includes('新增'), drift?.detail);
    assert.ok(drift?.detail.includes('删除 -'), drift?.detail);
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：不传 catalogDir 时使用默认目录', async () => {
  const aud = tmpDir('rc-audit-');
  const home = tmpDir('rc-home-');
  try {
    const r = await withEnv({ RC_AUDIT_DIR: aud.dir, RC_HOME: home.dir }, () => doctor());
    const ep = find(r, 'catalog:endpoints.json');
    assert.ok(ep, '默认目录也应当报告目录完整性检查');
    assert.ok(['pass', 'fail'].includes(ep?.status ?? ''));
  } finally {
    aud.cleanup();
    home.cleanup();
  }
});

test('doctor：目标检查（有 baseUrl 为 pass，缺失为 fail）', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const okTarget = await doctor({
      catalogDir: cat.dir,
      auditDir: aud.dir,
      target: { name: 'test', baseUrl: 'https://example.test', role: 'dev' },
      profile: 'uat',
    });
    assert.equal(find(okTarget, 'target')?.status, 'pass');
    assert.ok(find(okTarget, 'target')?.detail.includes('test'));
    assert.ok(find(okTarget, 'target')?.detail.includes('dev'));
    assert.equal(okTarget.target?.name, 'test');
    assert.equal(okTarget.target?.role, 'dev');
    assert.equal(okTarget.target?.profile, 'uat');

    const bad = await doctor({
      catalogDir: cat.dir,
      auditDir: aud.dir,
      target: { name: 'broken', baseUrl: '', role: 'dev' },
    });
    assert.equal(find(bad, 'target')?.status, 'fail');
    assert.ok(find(bad, 'target')?.detail.includes('缺少 baseUrl'));
    assert.ok(find(bad, 'target')?.action?.includes('RC_BASE_URL'));
    assert.equal(bad.target?.name, 'broken');

    const noRole = await doctor({
      catalogDir: cat.dir,
      auditDir: aud.dir,
      target: { name: 'x', baseUrl: 'https://example.test', role: undefined } as any,
    });
    assert.ok(find(noRole, 'target')?.detail.includes('（-）'));
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：prod 写闸门（默认只读告警，显式放行才 pass）', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const ro = await withEnv({ RC_ALLOW_PROD_WRITE: undefined }, () =>
      doctor({ catalogDir: cat.dir, auditDir: aud.dir, profile: 'prod' }),
    );
    assert.equal(find(ro, 'write-gate')?.status, 'warn');
    assert.ok(find(ro, 'write-gate')?.detail.includes('只读模式'));

    const allowed = await withEnv({ RC_ALLOW_PROD_WRITE: '1' }, () =>
      doctor({ catalogDir: cat.dir, auditDir: aud.dir, profile: 'prod' }),
    );
    assert.equal(find(allowed, 'write-gate')?.status, 'pass');
    assert.ok(find(allowed, 'write-gate')?.detail.includes('已显式放行'));

    const dev = await withEnv({ RC_ALLOW_PROD_WRITE: undefined }, () =>
      doctor({ catalogDir: cat.dir, auditDir: aud.dir, profile: 'uat' }),
    );
    assert.equal(find(dev, 'write-gate')?.status, 'pass');
    assert.ok(find(dev, 'write-gate')?.detail.includes('dry-run'));
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：审计目录可写为 pass', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir });
    assert.equal(find(r, 'audit-dir')?.status, 'pass');
    assert.equal(find(r, 'audit-dir')?.detail, aud.dir);
    assert.equal(find(r, 'audit-dir')?.action, undefined);
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：审计目录不可写为 fail 并给出修复建议', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    aud.write('blocker', 'x');
    const blocked = join(aud.dir, 'blocker', 'nested');
    const r = await doctor({ catalogDir: cat.dir, auditDir: blocked });
    assert.equal(find(r, 'audit-dir')?.status, 'fail');
    assert.ok(find(r, 'audit-dir')?.detail.includes('不可写'));
    assert.ok(find(r, 'audit-dir')?.action?.includes('RC_AUDIT_DIR'));
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：审计目录可由 RC_AUDIT_DIR / RC_HOME / HOME 依次决定', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  const home = tmpDir('rc-home-');
  try {
    const byEnv = await withEnv({ RC_AUDIT_DIR: aud.dir, RC_HOME: undefined }, () =>
      doctor({ catalogDir: cat.dir }),
    );
    assert.equal(find(byEnv, 'audit-dir')?.detail, aud.dir);

    const byHome = await withEnv({ RC_AUDIT_DIR: undefined, RC_HOME: home.dir }, () =>
      doctor({ catalogDir: cat.dir }),
    );
    assert.equal(find(byHome, 'audit-dir')?.detail, join(home.dir, 'audit'));

    const byOsHome = await withEnv({ RC_AUDIT_DIR: undefined, RC_HOME: undefined, HOME: home.dir }, () =>
      doctor({ catalogDir: cat.dir }),
    );
    assert.equal(find(byOsHome, 'audit-dir')?.detail, join(home.dir, '.rc', 'audit'));
  } finally {
    cat.cleanup();
    aud.cleanup();
    home.cleanup();
  }
});

test('doctor：请求联网但没有客户端时报 auth 失败', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true });
    assert.equal(find(r, 'auth')?.status, 'fail');
    assert.ok(find(r, 'auth')?.detail.includes('没有可用客户端'));
    assert.ok(find(r, 'auth')?.action);
    assert.equal(find(r, 'connect'), undefined);
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：联网检查通过（登录态 / 应用 / 流程 / 数据源）', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const { client } = doctorClient((path) => {
      if (path === '/rest/core/apps') return ok({ rows: [{ id: 'a1' }, { id: 'a2' }] });
      if (path === '/rest/esb/process/list') return ok({ total: 7, rows: [{ id: 'f1' }] });
      if (path === '/rest/core/datasource/listall') return ok({ rows: [{ id: 'ds-1', configName: '订单库' }] });
      return ok({});
    });
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, client });
    assert.equal(find(r, 'auth')?.status, 'pass');
    assert.ok(find(r, 'auth')?.detail.includes('tester'));
    assert.equal(find(r, 'apps')?.status, 'pass');
    assert.ok(find(r, 'apps')?.detail.includes('应用数=2'));
    assert.equal(find(r, 'flows')?.status, 'pass');
    assert.ok(find(r, 'flows')?.detail.includes('7'));
    assert.equal(find(r, 'datasources')?.status, 'pass');
    assert.ok(find(r, 'datasources')?.detail.includes('数据源数=1'));
    assert.equal(find(r, 'datasource-connectivity'), undefined);
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：登录态无效与登录态检查异常都是 fail', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const invalid = doctorClient(() => ok({}), async () => fail('登录态过期', 401));
    const r1 = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, client: invalid.client });
    assert.equal(find(r1, 'auth')?.status, 'fail');
    assert.ok(find(r1, 'auth')?.detail.includes('登录态无效'));
    assert.ok(find(r1, 'auth')?.action?.includes('rc auth login'));

    const broken = doctorClient(() => ok({}), async () => { throw new Error('网络不通'); });
    const r2 = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, client: broken.client });
    assert.equal(find(r2, 'auth')?.status, 'fail');
    assert.ok(find(r2, 'auth')?.detail.includes('登录态检查失败'));
    assert.ok(find(r2, 'auth')?.detail.includes('网络不通'));
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：登录态无用户名时显示 unknown，失败无 msg 时显示状态码', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const noUser = doctorClient(() => ok({}), async () => ok({}));
    const r1 = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, client: noUser.client });
    assert.equal(find(r1, 'auth')?.status, 'pass');
    assert.ok(find(r1, 'auth')?.detail.includes('unknown'), find(r1, 'auth')?.detail);

    const noMsg = doctorClient(() => ok({}), async () => ({ ok: false, httpStatus: 401, data: {}, request: { method: 'GET', url: '/x' } }));
    const r2 = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, client: noMsg.client });
    assert.equal(find(r2, 'auth')?.status, 'fail');
    assert.ok(find(r2, 'auth')?.detail.includes('401'), find(r2, 'auth')?.detail);
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：应用列表读取失败或异常都是 warn', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const failed = doctorClient((path) => (path === '/rest/core/apps' ? fail('应用服务不可用', 500) : ok({})));
    const r1 = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, client: failed.client });
    assert.equal(find(r1, 'apps')?.status, 'warn');
    assert.ok(find(r1, 'apps')?.action?.includes('应用服务不可用'));

    const noMsg = doctorClient((path) => (path === '/rest/core/apps'
      ? { ok: false, httpStatus: 500, data: {}, request: { method: 'GET', url: '/x' } }
      : ok({})));
    const r2 = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, client: noMsg.client });
    assert.equal(find(r2, 'apps')?.status, 'warn');
    assert.ok(find(r2, 'apps')?.action?.includes('500'), find(r2, 'apps')?.action);

    const thrown = doctorClient((path) => {
      if (path === '/rest/core/apps') throw new Error('连接被拒绝');
      return ok({});
    });
    const r3 = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, client: thrown.client });
    assert.equal(find(r3, 'apps')?.status, 'warn');
    assert.ok(find(r3, 'apps')?.detail.includes('应用列表不可用'));
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：流程列表读取失败或异常都是 warn，总数取多种来源', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const failed = doctorClient((path) => (path === '/rest/esb/process/list' ? fail('流程服务不可用', 500) : ok({})));
    const r1 = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, client: failed.client });
    assert.equal(find(r1, 'flows')?.status, 'warn');
    assert.ok(find(r1, 'flows')?.action?.includes('流程服务不可用'));

    const noMsg = doctorClient((path) => (path === '/rest/esb/process/list'
      ? { ok: false, httpStatus: 502, data: {}, request: { method: 'GET', url: '/x' } }
      : ok({})));
    const r2 = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, client: noMsg.client });
    assert.equal(find(r2, 'flows')?.status, 'warn');
    assert.ok(find(r2, 'flows')?.action?.includes('502'), find(r2, 'flows')?.action);

    const thrown = doctorClient((path) => {
      if (path === '/rest/esb/process/list') throw new Error('超时');
      return ok({});
    });
    const r3 = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, client: thrown.client });
    assert.equal(find(r3, 'flows')?.status, 'warn');
    assert.ok(find(r3, 'flows')?.detail.includes('流程列表不可用'));

    const nested = doctorClient((path) => (path === '/rest/esb/process/list' ? ok({ data: { total: 5 } }) : ok({})));
    const r4 = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, client: nested.client });
    assert.ok(find(r4, 'flows')?.detail.includes('5'));

    const rowsOnly = doctorClient((path) => (path === '/rest/esb/process/list' ? ok({ rows: [1, 2, 3] }) : ok({})));
    const r5 = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, client: rowsOnly.client });
    assert.ok(find(r5, 'flows')?.detail.includes('3'));
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：数据源列表异常为 warn', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const thrown = doctorClient((path) => {
      if (path === '/rest/core/datasource/listall') throw new Error('数据源服务不可用');
      return ok({});
    });
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, client: thrown.client });
    assert.equal(find(r, 'datasources')?.status, 'warn');
    assert.ok(find(r, 'datasources')?.detail.includes('数据源检查失败'));
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：数据源连接抽测（全部成功为 pass，有失败为 warn）', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const allGood = doctorClient((path) => {
      if (path === '/rest/core/datasource/listall') return ok({ rows: [{ id: 'ds-1', configName: '订单库' }, { id: 'ds-2', configName: '仓库库' }] });
      if (path === '/rest/core/datasource/test/connect') return ok({ connected: true });
      return ok({});
    });
    const r1 = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, datasources: true, client: allGood.client });
    assert.equal(find(r1, 'datasource-connectivity')?.status, 'pass');
    assert.ok(find(r1, 'datasource-connectivity')?.detail.includes('抽测 2 个，成功 2 个'));
    assert.equal(find(r1, 'datasource-connectivity')?.action, undefined);

    const oneBad = doctorClient((path) => {
      if (path === '/rest/core/datasource/listall') return ok({ rows: [{ id: 'ds-1', configName: '订单库' }, { id: 'ds-2', configName: '仓库库' }] });
      if (path === '/rest/core/datasource/test/connect') return fail('连接超时', 500);
      return ok({});
    });
    const r2 = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, datasources: true, client: oneBad.client });
    assert.equal(find(r2, 'datasource-connectivity')?.status, 'warn');
    assert.ok(find(r2, 'datasource-connectivity')?.detail.includes('失败：订单库: 连接超时'));
    assert.ok(find(r2, 'datasource-connectivity')?.action?.includes('rc datasource test'));
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：数据源抽测数量受 maxDatasourceTests 限制', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: `ds-${i}`, configName: `库${i}` }));
    const { client, calls } = doctorClient((path) => {
      if (path === '/rest/core/datasource/listall') return ok({ rows });
      if (path === '/rest/core/datasource/test/connect') return ok({ connected: true });
      return ok({});
    });
    const r = await doctor({
      catalogDir: cat.dir,
      auditDir: aud.dir,
      connect: true,
      datasources: true,
      maxDatasourceTests: 3,
      client,
    });
    assert.ok(find(r, 'datasource-connectivity')?.detail.includes('抽测 3 个'));
    const tests = calls.filter((c) => c.path === '/rest/core/datasource/test/connect');
    assert.equal(tests.length, 3);
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：数据源无名称时失败信息回退到 id，无 msg 时回退到"失败"', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const { client } = doctorClient((path) => {
      if (path === '/rest/core/datasource/listall') return ok({ rows: [{ id: 'ds-x' }] });
      if (path === '/rest/core/datasource/test/connect') {
        return { ok: false, httpStatus: 500, data: {}, request: { method: 'GET', url: '/x' } };
      }
      return ok({});
    });
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, connect: true, datasources: true, client });
    const detail = find(r, 'datasource-connectivity')?.detail ?? '';
    assert.ok(detail.includes('ds-x'), `失败信息应回退到 id：${detail}`);
    assert.ok(detail.includes('失败'), `失败原因应回退到默认文案：${detail}`);
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：格式化输出包含图标、动作与汇总', async () => {
  const cat = emptyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir, profile: 'prod' });
    const text = formatDoctor(r);
    assert.ok(text.startsWith('rc doctor  '));
    assert.ok(text.includes('目标：-'));
    assert.ok(text.includes('✖ catalog:endpoints.json'), text);
    assert.ok(text.includes('→ '), '修复动作应单独成行');
    assert.ok(text.includes('汇总：pass='));
    assert.ok(text.includes('fail='));
    assert.ok(text.includes('skip='));
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});

test('doctor：格式化输出覆盖 pass/warn/skip 图标', async () => {
  const cat = healthyCatalog();
  const aud = tmpDir('rc-audit-');
  try {
    const r = await doctor({ catalogDir: cat.dir, auditDir: aud.dir });
    const text = formatDoctor(r);
    assert.ok(text.includes('✔ catalog:endpoints.json'));
    assert.ok(text.includes('! catalog:drift'));
    assert.ok(text.includes('- target'));
  } finally {
    cat.cleanup();
    aud.cleanup();
  }
});
