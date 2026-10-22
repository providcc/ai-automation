/**
 * 审计日志：jsonl 追加写，含脱敏
 * 生产环境写入失败必须阻断（plan §5.5 E_AUDIT）
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redact } from './errors.ts';

export interface AuditEntry {
  actor: string;
  profile: string;
  method: string;
  path: string;
  status: number;
  ok: boolean;
  errcode?: number;
  traceId?: string;
  ms: number;
  dryRun?: boolean;
  args?: unknown;
}

export interface AuditSink {
  write(entry: AuditEntry): Promise<void>;
}

export class FileAuditSink implements AuditSink {
  private readonly dir: string;
  private readonly strict: boolean;

  constructor(opts: { dir?: string; strict?: boolean } = {}) {
    this.dir = opts.dir ?? join(homedir(), '.rc', 'audit');
    this.strict = opts.strict ?? false;
  }

  async write(entry: AuditEntry): Promise<void> {
    const safe = redact(entry) as Record<string, unknown>;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...safe });
    try {
      await mkdir(this.dir, { recursive: true });
      await appendFile(join(this.dir, `${new Date().toISOString().slice(0, 7)}.jsonl`), line + '\n', 'utf8');
    } catch (e) {
      if (this.strict) throw new Error(`审计写入失败：${(e as Error).message}`);
    }
  }
}

/** 内存 sink，用于测试 */
export class MemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  async write(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}
