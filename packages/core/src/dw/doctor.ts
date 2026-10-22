/**
 * 环境自检：一条命令回答"为什么连不上 / 为什么查不动"。
 *
 * 顺序刻意固定，因为排障是链式的，前一项没过后面全是噪音：
 *   配置 → 隧道 → 连通性 → 上下文（catalog/库） → 元数据可读性 → 写闸门。
 *
 * 三条线上经验：
 *   1. **隧道看端口，不看进程**：`ssh` 进程活着但转发已死的形态真实存在，
 *      合盖休眠后尤其常见——所以隧道检查失败时给出的建议是"先 down 再 up"。
 *   2. **元数据可读性要单独验**：连通（能 SELECT 1）不等于能读 `mv_infos`
 *      表函数——Doris 3.1.4 上 `SHOW MATERIALIZED VIEWS` 不可用，读不到就等于瞎。
 *   3. **写闸门要显式报出来**：只读环境里所有写操作都会被拒，
 *      不提前说清楚，用户会以为是权限或语法问题。
 */
import type { ResolvedWarehouseEnv } from './config.ts';
import { describeWarehouseEnv } from './config.ts';
import { createTransport, type ConnectOptions } from './connect.ts';
import type { WarehouseTransport } from './transport.ts';
import { tunnelStatus, tunnelUp, type TunnelRuntime } from './tunnel.ts';
import { quoteIdent, quoteLiteral } from './mv.ts';

export interface DwDoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail?: string;
  hint?: string;
}

export interface DwDoctorReport {
  ok: boolean;
  checks: DwDoctorCheck[];
  /** 已打码的环境描述（**不含密码**） */
  env: Record<string, unknown>;
}

export interface DwDoctorOptions extends ConnectOptions {
  /** 隧道不通时尝试重建 */
  fix?: boolean;
  timeoutMs?: number;
  /** 隧道运行时（单测注入；生产用默认实现真探端口/真起 ssh） */
  tunnelRuntime?: TunnelRuntime;
}

/**
 * DDL 能力探测用的表名。刻意带 `__` 前缀且明确写着 probe：
 * 万一它真的出现在表清单里，人一眼就知道是本工具留下的，而不是业务表。
 */
export const WRITE_PROBE_TABLE = '__dw_doctor_probe__';

const ok = (name: string, detail?: string): DwDoctorCheck => ({ name, status: 'ok', detail });
const warn = (name: string, detail: string, hint?: string): DwDoctorCheck => ({ name, status: 'warn', detail, hint });
const fail = (name: string, detail: string, hint?: string): DwDoctorCheck => ({ name, status: 'fail', detail, hint });
const skip = (name: string, detail: string): DwDoctorCheck => ({ name, status: 'skip', detail });

export async function runWarehouseDoctor(
  env: ResolvedWarehouseEnv,
  opts: DwDoctorOptions = {},
): Promise<DwDoctorReport> {
  const checks: DwDoctorCheck[] = [];
  const timeoutMs = opts.timeoutMs ?? 15_000;

  // ① 配置
  checks.push(
    ok(
      '配置',
      `环境 ${env.name}；传输 ${env.transport}；catalog ${env.catalog}；库 ${env.database ?? '(未设，SQL 需全限定名)'}`,
    ),
  );
  if (!env.password && env.transport === 'http') {
    checks.push(
      warn('凭据', '未配置密码', 'FE 通常要求 Basic 认证：写 ~/.dw/warehouse-credentials.json（0600），或设 DW_PASS'),
    );
  }
  for (const w of env.warnings ?? []) checks.push(warn('凭据文件权限', w));

  // ② 隧道
  if (!env.tunnel?.enabled) {
    checks.push(skip('隧道', '该环境未启用隧道（直连）'));
  } else {
    let st = await tunnelStatus(env.tunnel, opts.tunnelRuntime);
    let rebuildError: string | undefined;
    if (!st.up && opts.fix) {
      // tunnelUp 内部会先按特征串精确清掉残留进程，再重建
      try {
        await tunnelUp(env.tunnel, opts.tunnelRuntime, { force: true });
        st = await tunnelStatus(env.tunnel, opts.tunnelRuntime);
      } catch (e) {
        rebuildError = (e as Error).message;
      }
    }
    if (st.up) {
      const ports = st.forwards.map((f) => `${f.forward.local}→${f.forward.remoteHost}:${f.forward.remotePort}`);
      const dup = st.pids.length > 1 ? `（${st.pids.length} 个隧道进程，建议 down 后重建）` : '';
      checks.push(ok('隧道', `转发端口就绪：${ports.join('、')}${dup}`));
    } else {
      checks.push(
        fail(
          '隧道',
          rebuildError ? `重建失败：${rebuildError}` : (st.hint ?? '转发端口不通'),
          'dw tunnel up 重建；合盖休眠后残留进程需先 dw tunnel down',
        ),
      );
    }
  }

  // ③ 连通性
  // 装配本身也可能失败（如 transport=cmd 却没配命令模板）——那正是 doctor 该报出来的事，
  // 不能让它把整个体检炸掉。
  let transport: WarehouseTransport | undefined;
  let version: string | undefined;
  try {
    transport = createTransport(env, opts);
  } catch (e) {
    checks.push(
      fail('传输装配', (e as Error).message, 'transport=cmd 需要配置命令模板（DW_CMD 或配置里的 cmd）'),
    );
  }
  if (!transport) {
    checks.push(skip('连通性', '传输层未装配成功'));
  } else {
    try {
      const res = await transport.probe({ timeoutMs });
      if (!res.ok) {
        checks.push(
          fail(
            '连通性',
            `FE 返回业务错误：${res.msg ?? `code ${res.code}`}`,
            res.code === 401 ? '认证失败：核对用户名/密码' : '确认 FE 可达、catalog 名称正确',
          ),
        );
      } else {
        version = res.rows.length ? String(Object.values(res.rows[0])[0] ?? '') : undefined;
        checks.push(ok('连通性', version ? `SELECT VERSION() = ${version}` : '查询成功'));
      }
    } catch (e) {
      checks.push(fail('连通性', (e as Error).message, '若走隧道，先 dw tunnel up；否则确认 FE 地址与端口'));
    }
  }

  const connected = checks.some((c) => c.name === '连通性' && c.status === 'ok');

  // ④ 上下文：库是否可达
  const t = transport;
  let tables: string[] | undefined;
  if (!t || !connected) {
    checks.push(skip('库上下文', '连通性未通过，跳过'));
  } else if (!env.database) {
    checks.push(skip('库上下文', '未指定 database；SQL 请用三段式全限定名'));
  } else {
    try {
      // 不加 LIMIT：Doris 的 SHOW 不接受 LIMIT（mismatched input 'LIMIT'，实测）
      const res = await t.run(`SHOW TABLES FROM ${quoteIdent(env.database)}`, { timeoutMs });
      if (res.ok) {
        tables = res.rows.map((r) => String(Object.values(r)[0] ?? ''));
        checks.push(ok('库上下文', `库 ${env.database} 可达（${tables.length} 张表）`));
      } else {
        checks.push(fail('库上下文', `库 ${env.database} 不可达：${res.msg ?? res.code}`));
      }
    } catch (e) {
      checks.push(fail('库上下文', (e as Error).message));
    }
  }

  // ⑤ 元数据可读性：MV 自查全靠 mv_infos 表函数，读不到就什么都查不了
  if (!t || !connected || !env.database) {
    checks.push(skip('MV 元数据', '缺少连通性或 database，跳过'));
  } else {
    try {
      const res = await t.run(
        `SELECT COUNT(*) AS n FROM mv_infos('database'=${quoteLiteral(env.database)})`,
        { timeoutMs },
      );
      if (res.ok) {
        const n = res.rows.length ? Object.values(res.rows[0])[0] : undefined;
        checks.push(ok('MV 元数据', `mv_infos 可读，${env.database} 下 ${n ?? '?'} 张物化视图`));
      } else {
        checks.push(
          fail('MV 元数据', `mv_infos 不可读：${res.msg ?? res.code}`, '确认版本支持表函数（Doris 3.x）且账号有该库权限'),
        );
      }
    } catch (e) {
      checks.push(fail('MV 元数据', (e as Error).message));
    }
  }

  // ⑥ 写闸门
  checks.push(
    env.readonly
      ? warn('写闸门', '当前环境标记为只读：refresh/schedule/swap 一律被拒', '确需写入时设 DW_ALLOW_PROD_WRITE=1')
      : ok('写闸门', '允许写操作（默认 dry-run，需显式 --apply 才真正执行）'),
  );

  // ⑦ DDL 能力：refresh / schedule / swap 全走 DDL，FE HTTP 端点能不能写必须先知道
  // 探测语句刻意选 `DROP TABLE IF EXISTS <不存在的表>`：真的过了一遍 DDL 执行路径，
  // 但零副作用——且执行前先确认这个名字不在表清单里，杜绝误删。
  if (!t || !connected || !env.database) {
    checks.push(skip('DDL 能力', '缺少连通性或 database，跳过'));
  } else if (env.readonly) {
    checks.push(skip('DDL 能力', '只读环境，不探测写'));
  } else if (tables?.includes(WRITE_PROBE_TABLE)) {
    checks.push(
      warn('DDL 能力', `探测表名 ${WRITE_PROBE_TABLE} 已存在，跳过探测以免误删`, '手工清理该表后重跑，或换环境'),
    );
  } else {
    try {
      const res = await t.run(`DROP TABLE IF EXISTS ${quoteIdent(WRITE_PROBE_TABLE)}`, { timeoutMs });
      checks.push(
        res.ok
          ? ok('DDL 能力', `FE ${env.transport} 端点可执行 DDL（探测语句无副作用）`)
          : warn(
              'DDL 能力',
              `端点不可执行 DDL：${res.msg ?? res.code}`,
              'refresh/schedule/freeze/swap 需要写能力：改用 transport=cmd（配置 DW_CMD 命令模板）',
            ),
      );
    } catch (e) {
      checks.push(
        warn('DDL 能力', `DDL 探测失败：${(e as Error).message}`, 'refresh/schedule/swap 需改用 transport=cmd'),
      );
    }
  }

  return {
    ok: !checks.some((c) => c.status === 'fail'),
    checks,
    env: describeWarehouseEnv(env),
  };
}
