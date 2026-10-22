/**
 * 数仓（dw）单测公用工具。
 * 铁律：**全部不触网**——用 stub transport 替换真实传输层，
 * 测试里不出现任何真实主机、库名、MV 名（开源仓库的敏感面就在这里）。
 */
import type { QueryResult, TransportOptions, WarehouseTransport } from '../../packages/core/src/dw/transport.ts';
import type { ResolvedWarehouseEnv, TunnelForward, TunnelSpec } from '../../packages/core/src/dw/config.ts';
import type { ExecResult, TunnelRuntime } from '../../packages/core/src/dw/tunnel.ts';

export interface RunCall {
  sql: string;
  opts?: TransportOptions;
}

/** 一个成功的 Doris 结果集信封（`result_set` 形态，位置式 data）。 */
export function envelope(rows: unknown[][], columns: string[], extra: Record<string, unknown> = {}) {
  return {
    code: 0,
    msg: 'success',
    data: {
      type: 'result_set',
      meta: columns.map((name) => ({ name, type: 'VARCHAR' })),
      data: rows,
      time: 3,
      ...extra,
    },
  };
}

/** 一个失败信封：`msg` 常常只有 "Error"，真原因在 `data` 里。 */
export function errorEnvelope(detail: string, code = 1) {
  return { code, msg: 'Error', data: detail };
}

export const qr = (
  rows: Record<string, unknown>[] = [],
  columns: string[] = rows.length ? Object.keys(rows[0]) : [],
  over: Partial<QueryResult> = {},
): QueryResult => ({
  ok: true,
  columns,
  rows,
  execTimeMs: 1,
  request: { method: 'POST', url: 'http://stub/api/query/internal/<db>' },
  ...over,
});

/**
 * 桩传输层。handler 按 SQL 关键字分支返回结果；返回字符串视为"失败并以此为题"。
 * 记录全部调用（calls），便于断言"发了什么 SQL"。
 */
export function stubTransport(
  handler: (sql: string, opts: TransportOptions | undefined, calls: RunCall[]) => QueryResult | string,
): { transport: WarehouseTransport; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const transport: WarehouseTransport = {
    kind: 'http',
    async run(sql, opts) {
      calls.push({ sql, opts });
      const r = handler(sql, opts, calls);
      if (typeof r === 'string') return qr([], [], { ok: false, msg: r, code: 1 });
      return r;
    },
    async probe(opts) {
      return this.run('SELECT VERSION() AS version', opts);
    },
    describe() {
      return { transport: 'stub' };
    },
  };
  return { transport, calls };
}

/** 按 SQL 里的关键字匹配返回；未命中走 fallback。 */
export function bySql(map: Record<string, QueryResult | string>, fallback: QueryResult | string = qr()): (
  sql: string,
) => QueryResult | string {
  return (sql: string) => {
    for (const [k, v] of Object.entries(map)) {
      if (sql.includes(k)) return v;
    }
    return fallback;
  };
}

/** 解析后的环境桩。默认值全部是占位符，不含任何真实信息。 */
export function envFixture(over: Partial<ResolvedWarehouseEnv> = {}): ResolvedWarehouseEnv {
  return {
    name: 'test',
    host: 'dw-host',
    mysqlPort: 9030,
    httpPort: 8030,
    user: 'tester',
    catalog: 'internal',
    database: 'demo_db',
    transport: 'http',
    password: 'pw',
    ...over,
  };
}

export function tunnelFixture(
  over: Partial<TunnelSpec & { forwards: TunnelForward[] }> = {},
): TunnelSpec & { forwards: TunnelForward[] } {
  return {
    enabled: true,
    jumpHost: 'jump-host',
    jumpUser: 'jumpuser',
    jumpPort: 22,
    forwards: [
      { local: 19030, remoteHost: 'dw-host', remotePort: 9030 },
      { local: 18030, remoteHost: 'dw-host', remotePort: 8030 },
    ],
    ...over,
  };
}

/** 桩隧道运行时：可注入端口是否在听、进程列表、命令结果。 */
export function stubTunnelRuntime(opts: {
  listening?: number[];
  pids?: number[];
  execResult?: (cmd: string, args: string[]) => ExecResult;
  /** 起隧道后再探活时返回的端口（模拟"起来了"） */
  listenAfterExec?: number[];
}): { runtime: TunnelRuntime; execs: { cmd: string; args: string[] }[] } {
  const execs: { cmd: string; args: string[] }[] = [];
  let started = false;
  const runtime: TunnelRuntime = {
    async exec(cmd, args) {
      execs.push({ cmd, args });
      if (opts.execResult) return opts.execResult(cmd, args);
      if (cmd === 'pgrep') return { code: 0, stdout: (opts.pids ?? []).join('\n'), stderr: '' };
      if (cmd === 'kill') return { code: 0, stdout: '', stderr: '' };
      started = true;
      return { code: 0, stdout: '', stderr: '' };
    },
    async isPortListening(port) {
      if (started && opts.listenAfterExec) return opts.listenAfterExec.includes(port);
      return (opts.listening ?? []).includes(port);
    },
    async findPids() {
      return opts.pids ?? [];
    },
  };
  return { runtime, execs };
}

/** 一份合法的最小替换源 DDL（STARTS 在未来，避免时间相关的抖动）。 */
export const goodTmpDdl = (name = 'mv_tmp', starts = '2099-01-01 03:20:00') => `
CREATE MATERIALIZED VIEW \`${name}\`
BUILD DEFERRED REFRESH AUTO ON SCHEDULE EVERY 1 HOUR STARTS "${starts}"
DUPLICATE KEY(k1)
DISTRIBUTED BY HASH(k1) BUCKETS 4
PROPERTIES ("replication_num" = "1")
AS SELECT k1, CAST(SUM(a) AS DECIMAL(38, 2)) AS v FROM base_tbl GROUP BY k1;
`;

/** 带库名限定的坏替换源（触发 E_QUALIFIED_NAME）。 */
export const qualifiedTmpDdl = (name = 'mv_tmp', db = 'demo_db') => `
CREATE MATERIALIZED VIEW \`${db}\`.\`${name}\`
BUILD IMMEDIATE REFRESH AUTO ON SCHEDULE EVERY 1 HOUR STARTS "2000-01-01 03:20:00"
DUPLICATE KEY(k1)
DISTRIBUTED BY HASH(k1) BUCKETS 4
AS SELECT k1, SUM(a) / COUNT(*) AS v FROM base_tbl GROUP BY k1;
`;
