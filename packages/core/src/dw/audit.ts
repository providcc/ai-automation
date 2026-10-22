/**
 * 数仓侧审计：写操作留痕（谁、在哪个环境、对哪张表做了什么、是否真的执行）。
 *
 * 复用 iPaaS 侧的 `FileAuditSink`（jsonl 追加 + `redact()` 脱敏），只是换目录到 `~/.dw/audit`。
 * 与 `~/.rc/audit` 分开的原因很实际：数仓的 DDL/刷新是**低频但不可逆**的操作，
 * 混在 iPaaS 的高频调用里根本翻不出来。
 *
 * 写失败**不阻断**（strict=false）：审计盘写不进去不应该拦住一次已经获批的 DROP PARTITION；
 * 但会在 stderr 提醒。
 */
import { join } from 'node:path';
import { FileAuditSink, type AuditEntry, type AuditSink } from '../audit.ts';
import { redact } from '../errors.ts';
import { warehouseHome } from './config.ts';

export interface DwAuditInput {
  /** 环境名 */
  env: string;
  /**
   * 目标 host，**必须已打码**（调用方传 `maskHost(env.host)`）。
   *
   * 为什么审计要记这个：环境名只在用命名配置时才有意义，
   * 纯环境变量启动时名字就是 `env`——事后翻审计根本分不清这条写的是生产还是测试。
   */
  host?: string;
  /** 动作：refresh / schedule / freeze / swap / drop-partition … */
  action: string;
  /** 作用对象：MV 名 / 表名 */
  target: string;
  ok: boolean;
  dryRun: boolean;
  sql?: string;
  msg?: string;
  /** 附加信息（不含凭据） */
  extra?: Record<string, unknown>;
}

export function dwAuditSink(opts: { dir?: string; strict?: boolean } = {}): AuditSink {
  return new FileAuditSink({ dir: opts.dir ?? join(warehouseHome(), 'audit'), strict: opts.strict ?? false });
}

/**
 * 把数仓动作映射成审计条目并落盘。
 *
 * **在进 sink 之前先 `redact()`**：`FileAuditSink` 自己也会脱敏，但把脱敏绑在某一个 sink 上
 * 是错的——换个 sink（内存、上报、第三方）明文就漏出去了。
 * 脱敏是**入口的责任**，sink 只是搬运。`redact()` 幂等，重复抹不会出问题。
 */
export async function auditDwWrite(input: DwAuditInput, sink?: AuditSink): Promise<void> {
  const entry: AuditEntry = redact({
    actor: process.env.USER ?? process.env.LOGNAME ?? 'unknown',
    profile: input.env,
    method: input.action.toUpperCase(),
    path: input.target,
    status: input.ok ? 0 : 1,
    ok: input.ok,
    ms: 0,
    dryRun: input.dryRun,
    args: { host: input.host, sql: input.sql, msg: input.msg, ...input.extra },
  }) as AuditEntry;
  try {
    await (sink ?? dwAuditSink()).write(entry);
  } catch (e) {
    process.stderr.write(`⚠ 审计写入失败（不影响本次结果）：${(e as Error).message}\n`);
  }
}
