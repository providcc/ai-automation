/**
 * fingerprint：目录指纹、漂移 diff 与启动自检
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeCatalogFingerprint,
  writeFingerprint,
  readFingerprint,
  defaultFingerprintFile,
  diffFingerprints,
  checkCatalogHealth,
  listCatalogFiles,
  DEFAULT_CATALOG_DIR,
  REQUIRED_CATALOG_FILES,
  OPTIONAL_CATALOG_FILES,
} from '../../packages/core/src/fingerprint.ts';
import { tmpDir } from './helpers.ts';

/** 造一个假的 catalog 目录 */
function fakeCatalog(): ReturnType<typeof tmpDir> {
  const tmp = tmpDir('rc-fp-');
  const put = (rel: string, content: string) => {
    const full = join(tmp.dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  };
  put('endpoints.json', JSON.stringify({ endpoints: [1, 2, 3] }));
  put('components.json', JSON.stringify({ nodes: [1] }));
  put('etl-components.json', JSON.stringify({ panelOnly: [1, 2] }));
  put('war/endpoints.json', JSON.stringify({ count: 7 }));
  put('war/node-drivers.json', JSON.stringify({ drivers: [1, 2, 3, 4] }));
  put('war/error-catalog.json', JSON.stringify({ items: [1] }));
  put('war/models.json', JSON.stringify({ models: [1, 2] }));
  put('controllers.json', JSON.stringify({ controllers: [1] }));
  put('error-actions.json', JSON.stringify({ actions: [1, 2] }));
  put('error-map.json', JSON.stringify({ total: 42 }));
  put('expression-grammar.json', 'this is not json');
  put('expression-regression.json', JSON.stringify({ cases: [1] }));
  put('node-driver-map.json', JSON.stringify({ examples: [1] }));
  return tmp;
}

test('fingerprint：计算目录指纹（文件/字节/哈希/条目数/摘要）', () => {
  const tmp = fakeCatalog();
  try {
    const fp = computeCatalogFingerprint(tmp.dir);
    assert.equal(fp.version, 1);
    assert.equal(fp.algorithm, 'sha256');
    assert.equal(fp.catalogDir, 'catalog');
    assert.ok(fp.generatedAt);
    assert.ok(fp.files.length > 0);

    const byFile = new Map(fp.files.map((f) => [f.file, f]));
    assert.equal(byFile.get('endpoints.json')!.count, 3);
    assert.equal(byFile.get('components.json')!.count, 1);
    assert.equal(byFile.get('etl-components.json')!.count, 2);
    assert.equal(byFile.get('war/endpoints.json')!.count, 7);
    assert.equal(byFile.get('war/node-drivers.json')!.count, 4);
    assert.equal(byFile.get('war/error-catalog.json')!.count, 1);
    assert.equal(byFile.get('war/models.json')!.count, 2);
    assert.equal(byFile.get('controllers.json')!.count, 1);
    assert.equal(byFile.get('error-actions.json')!.count, 2);
    assert.equal(byFile.get('error-map.json')!.count, 42);
    assert.equal(byFile.get('expression-regression.json')!.count, 1);
    assert.equal(byFile.get('node-driver-map.json')!.count, 1);
    assert.equal(byFile.get('expression-grammar.json')!.count, undefined, '非 JSON 文件不计数');
    assert.ok(byFile.get('endpoints.json')!.bytes > 0);
    assert.match(byFile.get('endpoints.json')!.sha256, /^[0-9a-f]{64}$/);

    const names = fp.files.map((f) => f.file);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), '文件应按名称排序');
    assert.match(fp.digest, /^[0-9a-f]{64}$/);
  } finally {
    tmp.cleanup();
  }
});

test('fingerprint：缺失的文件被跳过', () => {
  const tmp = tmpDir('rc-fp-');
  try {
    const fp = computeCatalogFingerprint(tmp.dir);
    assert.deepEqual(fp.files, []);
    assert.match(fp.digest, /^[0-9a-f]{64}$/);
  } finally {
    tmp.cleanup();
  }
});

test('fingerprint：写入与读取指纹文件', () => {
  const tmp = fakeCatalog();
  try {
    const fp = computeCatalogFingerprint(tmp.dir);
    const file = tmp.file('fingerprint.json');
    assert.equal(writeFingerprint(file, fp), file);
    const back = readFingerprint(file);
    assert.equal(back.digest, fp.digest);
    assert.equal(back.files.length, fp.files.length);
    assert.equal(defaultFingerprintFile(tmp.dir), join(tmp.dir, 'fingerprint.json'));
  } finally {
    tmp.cleanup();
  }
});

test('fingerprint：默认目录的指纹可计算', () => {
  const fp = computeCatalogFingerprint();
  assert.equal(fp.catalogDir, 'catalog');
  assert.ok(fp.files.length > 0);
  assert.ok(fp.files.some((f) => f.file === 'endpoints.json'));
  assert.ok(DEFAULT_CATALOG_DIR.endsWith('catalog'));
});

test('fingerprint：diffFingerprints 检出新增/删除/变更', () => {
  const before = {
    version: 1 as const,
    algorithm: 'sha256' as const,
    generatedAt: '2026-01-01T00:00:00.000Z',
    catalogDir: 'catalog',
    files: [
      { file: 'a.json', bytes: 1, sha256: 'aaa' },
      { file: 'b.json', bytes: 1, sha256: 'bbb' },
      { file: 'c.json', bytes: 1, sha256: 'ccc' },
    ],
    digest: 'd1',
  };
  const after = {
    ...before,
    files: [
      { file: 'a.json', bytes: 2, sha256: 'aaa2' },
      { file: 'c.json', bytes: 1, sha256: 'ccc' },
      { file: 'd.json', bytes: 1, sha256: 'ddd' },
    ],
    digest: 'd2',
  };
  const diff = diffFingerprints(before as any, after as any);
  assert.deepEqual(diff.changed, ['a.json']);
  assert.deepEqual(diff.added, ['d.json']);
  assert.deepEqual(diff.removed, ['b.json']);
  assert.equal(diff.digestChanged, true);

  const same = diffFingerprints(before as any, before as any);
  assert.deepEqual(same.changed, []);
  assert.deepEqual(same.added, []);
  assert.deepEqual(same.removed, []);
  assert.equal(same.digestChanged, false);
});

test('fingerprint：checkCatalogHealth 必填文件缺失即失败', () => {
  const tmp = tmpDir('rc-fp-');
  try {
    const health = checkCatalogHealth(tmp.dir);
    assert.equal(health.ok, false);
    for (const rel of REQUIRED_CATALOG_FILES) {
      const c = health.checks.find((x) => x.name === rel);
      assert.ok(c, `缺少 ${rel} 的检查项`);
      assert.equal(c!.ok, false);
      assert.equal(c!.detail, '文件不存在');
    }
  } finally {
    tmp.cleanup();
  }
});

test('fingerprint：checkCatalogHealth 必填文件过小也判失败', () => {
  const tmp = tmpDir('rc-fp-');
  try {
    writeFileSync(join(tmp.dir, 'endpoints.json'), 'x'.repeat(10), 'utf8');
    writeFileSync(join(tmp.dir, 'components.json'), 'y'.repeat(200), 'utf8');
    const health = checkCatalogHealth(tmp.dir);
    assert.equal(health.ok, false);
    const ep = health.checks.find((x) => x.name === 'endpoints.json')!;
    assert.equal(ep.ok, false);
    assert.match(ep.detail, /10 bytes/);
    const comp = health.checks.find((x) => x.name === 'components.json')!;
    assert.equal(comp.ok, true);
    assert.match(comp.detail, /200 bytes/);
  } finally {
    tmp.cleanup();
  }
});

test('fingerprint：checkCatalogHealth 可选文件缺失不判失败', () => {
  const tmp = tmpDir('rc-fp-');
  try {
    writeFileSync(join(tmp.dir, 'endpoints.json'), 'x'.repeat(200), 'utf8');
    writeFileSync(join(tmp.dir, 'components.json'), 'y'.repeat(200), 'utf8');
    const health = checkCatalogHealth(tmp.dir);
    assert.equal(health.ok, false, 'fingerprint.json 未生成仍应失败');
    const fpCheck = health.checks.find((x) => x.name === 'fingerprint.json')!;
    assert.equal(fpCheck.ok, false);
    assert.match(fpCheck.detail, /未生成/);

    for (const rel of OPTIONAL_CATALOG_FILES) {
      const c = health.checks.find((x) => x.name === rel)!;
      assert.equal(c.ok, true);
      assert.match(c.detail, /未安装/);
    }

    writeFileSync(join(tmp.dir, 'fingerprint.json'), JSON.stringify({ version: 1 }), 'utf8');
    const ok = checkCatalogHealth(tmp.dir);
    assert.equal(ok.ok, true);
    const fpOk = ok.checks.find((x) => x.name === 'fingerprint.json')!;
    assert.equal(fpOk.ok, true);
    assert.equal(fpOk.detail, '存在');
  } finally {
    tmp.cleanup();
  }
});

test('fingerprint：checkCatalogHealth 可选文件存在时标注（可选）', () => {
  const tmp = tmpDir('rc-fp-');
  try {
    writeFileSync(join(tmp.dir, 'endpoints.json'), 'x'.repeat(200), 'utf8');
    writeFileSync(join(tmp.dir, 'components.json'), 'y'.repeat(200), 'utf8');
    writeFileSync(join(tmp.dir, 'etl-components.json'), 'z'.repeat(300), 'utf8');
    const health = checkCatalogHealth(tmp.dir);
    const c = health.checks.find((x) => x.name === 'etl-components.json')!;
    assert.equal(c.ok, true);
    assert.match(c.detail, /300 bytes（可选）/);
  } finally {
    tmp.cleanup();
  }
});

test('fingerprint：listCatalogFiles 递归列出 JSON 文件', () => {
  const tmp = fakeCatalog();
  try {
    mkdirSync(join(tmp.dir, 'war'), { recursive: true });
    writeFileSync(join(tmp.dir, 'readme.md'), 'x', 'utf8');
    writeFileSync(join(tmp.dir, 'war', 'note.txt'), 'x', 'utf8');
    const files = listCatalogFiles(tmp.dir);
    assert.ok(files.includes('endpoints.json'));
    assert.ok(files.includes('war/endpoints.json'));
    assert.ok(!files.includes('readme.md'));
    assert.ok(!files.includes('war/note.txt'));
    assert.deepEqual(files, [...files].sort(), '结果应有序');
  } finally {
    tmp.cleanup();
  }
});
