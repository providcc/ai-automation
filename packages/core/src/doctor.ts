/**
 * rc doctor（v2 Phase 2.1）
 *
 * 一条命令回答："现在能不能安全地干活？"
 * 覆盖：目录完整性 / 目录漂移 / 目标与生产闸门 / 登录态 / 应用与流程 / 数据源 / 审计目录。
 * 默认不联网；加 --connect 才探测平台。
 */
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RestCloudClient } from './client.ts';
import type { Target } from './targets.ts';
import { computeCatalogFingerprint, defaultFingerprintFile, readFingerprint, diffFingerprints, checkCatalogHealth, OPTIONAL_CATALOG_FILES, DEFAULT_CATALOG_DIR } from './fingerprint.ts';
import { unwrapRows } from './api.ts';
import * as DS from './datasource.ts';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  action?: string;
}

export interface DoctorReport {
  ok: boolean;
  generatedAt: string;
  target?: { name?: string; role?: string; profile?: string };
  checks: DoctorCheck[];
  summary: { pass: number; warn: number; fail: number; skip: number };
}

export interface DoctorOptions {
  client?: RestCloudClient;
  target?: Target;
  profile?: string;
  connect?: boolean;
  datasources?: boolean;
  catalogDir?: string;
  auditDir?: string;
  maxDatasourceTests?: number;
}

function add(checks: DoctorCheck[], name: string, status: CheckStatus, detail: string, action?: string): void {
  checks.push({ name, status, detail, action });
}

async function writableDir(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function doctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const catalogDir = opts.catalogDir ?? DEFAULT_CATALOG_DIR;
  const auditDir = opts.auditDir ?? process.env.RC_AUDIT_DIR ?? join(process.env.RC_HOME ?? join(homedir(), '.rc'), 'audit');

  // 1) 目录完整性
  const health = checkCatalogHealth(catalogDir);
  for (const c of health.checks) {
    const action = c.ok
      ? undefined
      : c.name === 'fingerprint.json'
        ? 'rc catalog fingerprint --write'
        : '目录文件缺失：用 rc catalog sync --source <前端源码目录> 重新生成，或参考 docs/COMMAND-REFERENCE.md 的"目录"一节';
    add(checks, `catalog:${c.name}`, c.ok ? 'pass' : 'fail', c.detail, action);
  }

  // 2) 目录漂移
  try {
    const fpFile = defaultFingerprintFile(catalogDir);
    const current = computeCatalogFingerprint(catalogDir);
    if (health.checks.some((c) => c.name === 'fingerprint.json' && !c.ok)) {
      add(checks, 'catalog:drift', 'warn', '尚无基线指纹，无法判断平台契约是否漂移', 'rc catalog fingerprint --write');
    } else {
      const before = readFingerprint(fpFile);
      const diff = diffFingerprints(before, current);
      // 可选目录文件（ESB-only 部署不装 ETL 组件目录）缺失不算漂移。
      diff.removed = diff.removed.filter((f) => !OPTIONAL_CATALOG_FILES.includes(f));
      const realChange = diff.changed.length + diff.added.length + diff.removed.length;
      if (!diff.digestChanged || !realChange) add(checks, 'catalog:drift', 'pass', `目录未漂移（${current.files.length} 个文件）`);
      else add(checks, 'catalog:drift', 'warn', `目录已漂移：变更 ${diff.changed.join(',') || '-'}；新增 ${diff.added.join(',') || '-'}；删除 ${diff.removed.join(',') || '-'}`, '复核后用 rc catalog fingerprint --write 重建基线');
    }
  } catch (e) {
    add(checks, 'catalog:drift', 'warn', `无法检测漂移：${(e as Error).message}`);
  }

  // 3) 目标与生产闸门
  if (opts.target) {
    add(checks, 'target', opts.target.baseUrl ? 'pass' : 'fail', `${opts.target.name}（${opts.target.role ?? '-'}）${opts.target.baseUrl || '缺少 baseUrl'}`, opts.target.baseUrl ? undefined : '检查 rc.targets.json / RC_BASE_URL');
  } else {
    add(checks, 'target', 'skip', '未提供目标（本地检查模式）');
  }
  if (opts.profile) {
    const prod = opts.profile === 'prod';
    const allowed = process.env.RC_ALLOW_PROD_WRITE === '1';
    add(checks, 'write-gate', prod && !allowed ? 'warn' : 'pass',
      prod ? (allowed ? 'prod 写操作已显式放行（RC_ALLOW_PROD_WRITE=1）' : 'prod 为只读模式（写操作会被拒绝）') : `profile=${opts.profile}，写入默认 dry-run`);
  }

  // 4) 审计目录
  const auditOk = await writableDir(auditDir);
  add(checks, 'audit-dir', auditOk ? 'pass' : 'fail', auditOk ? auditDir : `不可写：${auditDir}`, auditOk ? undefined : '设置 RC_AUDIT_DIR 到可写目录；生产环境审计失败会阻断写操作');

  // 5) 联网检查
  if (opts.connect) {
    if (!opts.client) {
      add(checks, 'auth', 'fail', '已请求联网检查但没有可用客户端', '检查 RC_BASE_URL/RC_USER/RC_PASS');
    } else {
      try {
        const s = await opts.client.session();
        add(checks, 'auth', s.ok ? 'pass' : 'fail', s.ok ? `已登录：${String((s.data?.data ?? s.data)?.userName ?? 'unknown')}` : `登录态无效：${s.msg || s.httpStatus}`, s.ok ? undefined : 'rc auth login，或检查 RC_TOKEN');
      } catch (e) {
        add(checks, 'auth', 'fail', `登录态检查失败：${(e as Error).message}`, '检查网络/VPN 与目标地址');
      }
      try {
        const apps = await opts.client.request('/rest/core/apps', { method: 'GET' });
        const rows = unwrapRows(apps.data?.data ?? apps.data);
        add(checks, 'apps', apps.ok ? 'pass' : 'warn', `应用数=${rows.length}`, apps.ok ? undefined : `读取失败：${apps.msg || apps.httpStatus}`);
      } catch (e) {
        add(checks, 'apps', 'warn', `应用列表不可用：${(e as Error).message}`);
      }
      try {
        const flows = await opts.client.request('/rest/esb/process/list', { method: 'GET', query: { pageNo: 1, pageSize: 1 } });
        const rows = unwrapRows(flows.data?.data ?? flows.data);
        const total = (flows.data as any)?.total ?? (flows.data?.data as any)?.total ?? rows.length;
        add(checks, 'flows', flows.ok ? 'pass' : 'warn', `ESB 流程总数≈${total}`, flows.ok ? undefined : `读取失败：${flows.msg || flows.httpStatus}`);
      } catch (e) {
        add(checks, 'flows', 'warn', `流程列表不可用：${(e as Error).message}`);
      }
      try {
        const all = await DS.listAllDataSources(opts.client);
        add(checks, 'datasources', 'pass', `数据源数=${all.length}`);
        if (opts.datasources) {
          const n = Math.min(all.length, opts.maxDatasourceTests ?? 5);
          let ok = 0;
          const bad: string[] = [];
          for (const ds of all.slice(0, n)) {
            const t = await DS.testDataSourceConnection(opts.client, ds.id);
            if (t.ok) ok++;
            else bad.push(`${ds.configName ?? ds.id}: ${t.msg || '失败'}`);
          }
          add(checks, 'datasource-connectivity', bad.length === 0 ? 'pass' : 'warn', `抽测 ${n} 个，成功 ${ok} 个${bad.length ? `；失败：${bad.join('；')}` : ''}`, bad.length ? '用 rc datasource test <id> 逐个排查' : undefined);
        }
      } catch (e) {
        add(checks, 'datasources', 'warn', `数据源检查失败：${(e as Error).message}`);
      }
    }
  } else {
    add(checks, 'connect', 'skip', '未联网（加 --connect 检查登录态/应用/流程/数据源）');
  }

  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;
  return {
    ok: summary.fail === 0,
    generatedAt: new Date().toISOString(),
    target: opts.target ? { name: opts.target.name, role: opts.target.role, profile: opts.profile } : { profile: opts.profile },
    checks,
    summary,
  };
}

export function formatDoctor(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { pass: '✔', warn: '!', fail: '✖', skip: '-' };
  const lines = [`rc doctor  ${report.generatedAt}`, `目标：${report.target?.name ?? '-'}（profile=${report.target?.profile ?? '-'}）`];
  for (const c of report.checks) {
    lines.push(`${icon[c.status]} ${c.name}: ${c.detail}`);
    if (c.action) lines.push(`    → ${c.action}`);
  }
  lines.push(`汇总：pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} skip=${report.summary.skip}`);
  return lines.join('\n');
}
