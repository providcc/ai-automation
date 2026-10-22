/**
 * 目录指纹与漂移检测（v2 Phase 2）
 *
 * 平台升级会悄悄改变接口/组件/错误码。工具在每次启动时不应假设目录仍然正确：
 *   - `catalog fingerprint --write` 生成 catalog/fingerprint.json
 *   - `catalog drift` 对比当前文件与指纹，输出新增/删除/变更
 *   - CI nightly 用同一机制检测平台漂移并告警
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CATALOG_DIR = join(here, '..', '..', '..', 'catalog');

export interface FileFingerprint {
  file: string;
  bytes: number;
  sha256: string;
  count?: number;
}

export interface CatalogFingerprint {
  version: 1;
  algorithm: 'sha256';
  generatedAt: string;
  catalogDir: string;
  files: FileFingerprint[];
  digest: string;
}

export interface FingerprintDiff {
  changed: string[];
  added: string[];
  removed: string[];
  digestChanged: boolean;
}

/**
 * 目录中需要纳入指纹的稳定文件（新增 catalog 文件需同步这里）。
 * etl-components.json 是可选文件：ESB-only 部署可以不装，不影响 doctor 与漂移检测。
 */
const TRACKED = [
  'endpoints.json',
  'components.json',
  'etl-components.json',
  'war/endpoints.json',
  'war/node-drivers.json',
  'war/error-catalog.json',
  'war/models.json',
  'controllers.json',
  'error-actions.json',
  'error-map.json',
  'expression-grammar.json',
  'expression-regression.json',
  'node-driver-map.json',
];

/** 必须存在的目录文件（缺失即 doctor 失败） */
export const REQUIRED_CATALOG_FILES = ['endpoints.json', 'components.json'];
/** 可选目录文件：缺失只提示，不影响 doctor 结果 */
export const OPTIONAL_CATALOG_FILES = ['etl-components.json'];

function countOf(raw: string): number | undefined {
  try {
    const j = JSON.parse(raw) as any;
    const candidates = [j?.endpoints, j?.items, j?.nodes, j?.drivers, j?.controllers, j?.models, j?.messages, j?.samples, j?.actions, j?.templates, j?.cases, j?.rules, j?.examples, j?.entries, j?.best, j?.panelOnly];
    for (const c of candidates) if (Array.isArray(c)) return c.length;
    if (typeof j?.count === 'number') return j.count;
    if (typeof j?.total === 'number') return j.total;
  } catch {
    /* 非 JSON 文件不计数 */
  }
  return undefined;
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function computeCatalogFingerprint(catalogDir = DEFAULT_CATALOG_DIR): CatalogFingerprint {
  const files: FileFingerprint[] = [];
  for (const rel of TRACKED) {
    const file = join(catalogDir, rel);
    if (!existsSync(file)) continue;
    const buf = readFileSync(file);
    const item: FileFingerprint = { file: rel, bytes: buf.byteLength, sha256: sha256(buf) };
    const count = countOf(buf.toString('utf8'));
    if (count !== undefined) item.count = count;
    files.push(item);
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  const digest = sha256(files.map((f) => `${f.file}:${f.sha256}`).join('\n'));
  return {
    version: 1,
    algorithm: 'sha256',
    generatedAt: new Date().toISOString(),
    catalogDir: 'catalog',
    files,
    digest,
  };
}

export function writeFingerprint(file: string, fp = computeCatalogFingerprint()): string {
  writeFileSync(file, JSON.stringify(fp, null, 1) + '\n', 'utf8');
  return file;
}

export function readFingerprint(file: string): CatalogFingerprint {
  return JSON.parse(readFileSync(file, 'utf8')) as CatalogFingerprint;
}

export function defaultFingerprintFile(catalogDir = DEFAULT_CATALOG_DIR): string {
  return join(catalogDir, 'fingerprint.json');
}

export function diffFingerprints(before: CatalogFingerprint, after: CatalogFingerprint): FingerprintDiff {
  const b = new Map(before.files.map((f) => [f.file, f.sha256]));
  const a = new Map(after.files.map((f) => [f.file, f.sha256]));
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [file, hash] of a) {
    if (!b.has(file)) added.push(file);
    else if (b.get(file) !== hash) changed.push(file);
  }
  for (const file of b.keys()) if (!a.has(file)) removed.push(file);
  return {
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
    digestChanged: before.digest !== after.digest,
  };
}

export interface CatalogHealth {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

/** 启动期快速自检：关键文件存在且非空（可选文件缺失不算失败） */
export function checkCatalogHealth(catalogDir = DEFAULT_CATALOG_DIR): CatalogHealth {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  for (const rel of REQUIRED_CATALOG_FILES) {
    const file = join(catalogDir, rel);
    if (!existsSync(file)) {
      checks.push({ name: rel, ok: false, detail: '文件不存在' });
      continue;
    }
    const st = statSync(file);
    checks.push({ name: rel, ok: st.size > 100, detail: `${st.size} bytes` });
  }
  for (const rel of OPTIONAL_CATALOG_FILES) {
    const file = join(catalogDir, rel);
    if (!existsSync(file)) {
      checks.push({ name: rel, ok: true, detail: '未安装（可选文件；ESB-only 部署可忽略，ETL 组件目录不可用）' });
      continue;
    }
    const st = statSync(file);
    checks.push({ name: rel, ok: true, detail: `${st.size} bytes（可选）` });
  }
  const fpFile = defaultFingerprintFile(catalogDir);
  checks.push({
    name: 'fingerprint.json',
    ok: existsSync(fpFile),
    detail: existsSync(fpFile) ? '存在' : '未生成（运行 rc catalog fingerprint --write）',
  });
  return { ok: checks.every((c) => c.ok), checks };
}

/** 列出 catalog 目录中的 JSON 文件（用于人工排查） */
export function listCatalogFiles(catalogDir = DEFAULT_CATALOG_DIR): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix = '') => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, rel);
      else if (name.endsWith('.json')) out.push(rel);
    }
  };
  walk(catalogDir);
  return out.sort();
}
