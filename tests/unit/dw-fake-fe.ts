/**
 * 假 FE：一个只认 `POST /api/query/{catalog}/{db}` 的本地 HTTP 服务，按 SQL 回结果。
 *
 * 为什么需要它：`dw-cli-smoke.test.ts` 刻意不触网，所以**只能**验参数校验与本地闸门；
 * 而"写操作失败有没有留审计""高危清单算不出来时会不会放行 --apply"
 * 这类契约只在"真的发一次请求、真的拿到失败"时才成立。
 * 有了假 FE 就能在子进程里跑真实命令，同时把上游行为钉死在测试里。
 *
 * 它**只在 127.0.0.1 上监听、随机端口、用完即关**，不会碰到任何真实环境。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeQueryResult {
  ok?: boolean;
  /** 行式结果；列名取第一行的键 */
  rows?: Record<string, unknown>[];
  msg?: string;
  code?: number;
  /** 强制 HTTP 状态码（默认 200；ok=false 时用 500 模拟平台内部错误） */
  httpStatus?: number;
}

export interface FakeFe {
  /** 环境变量：把它传给 dw 子进程即可连到这里 */
  env: Record<string, string>;
  /** 收到的全部 SQL（按顺序） */
  statements: string[];
  /** 按 SQL 片段查收到的语句（断言"发过/没发过某条语句"） */
  saw: (substr: string) => boolean;
  close: () => Promise<void>;
}

/**
 * @param route 按 SQL 决定回什么；抛异常视为服务端故障（回 500）
 */
export async function startFakeFe(
  route: (sql: string, database: string) => FakeQueryResult,
): Promise<FakeFe> {
  const statements: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += String(d); });
    req.on('end', () => {
      let stmt = '';
      try {
        stmt = String(JSON.parse(body || '{}').stmt ?? '');
      } catch {
        stmt = '';
      }
      statements.push(stmt);
      const db = decodeURIComponent((req.url ?? '').split('/')[4] ?? '');
      let out: FakeQueryResult;
      try {
        out = route(stmt, db);
      } catch (e) {
        out = { ok: false, msg: `fake-fe 抛错：${(e as Error).message}`, code: 1 };
      }
      const ok = out.ok !== false;
      const rows = out.rows ?? [];
      const columns = rows.length ? Object.keys(rows[0]).map((name) => ({ name, type: 'VARCHAR' })) : [];
      const payload = ok
        ? {
          code: 0,
          msg: 'success',
          data: {
            type: 'result_set',
            meta: columns,
            data: rows.map((r) => columns.map((c) => r[c.name])),
            time: 1,
          },
        }
        : { code: out.code ?? 1, msg: out.msg ?? 'fake-fe failure', data: null };
      const status = out.httpStatus ?? (ok ? 200 : 500);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    env: {
      DW_HOST: '127.0.0.1',
      DW_HTTP_PORT: String(port),
      DW_USER: 'fake',
      DW_PASS: 'fake',
      DW_DB: 'demo_db',
      DW_PROFILE: 'dev',
      // 假 FE 在 loopback 上；清空白名单（未配置 = 不做主机限制）
      RC_ALLOWED_HOSTS: '',
    },
    statements,
    saw: (substr: string) => statements.some((s) => s.includes(substr)),
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}
