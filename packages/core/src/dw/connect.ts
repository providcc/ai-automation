/**
 * 连接装配：把「解析后的环境」变成可用的传输层，并在需要时先把隧道拉起来。
 *
 * 单独一个文件的原因：隧道与传输层的耦合只发生在这里——
 * **配置里写内网地址，运行时经隧道改走本机 loopback**，
 * 这个改写点只允许有一处，否则迟早出现"某条命令忘了走隧道、直连超时"。
 */
import type { ResolvedWarehouseEnv } from './config.ts';
import {
  CmdWarehouseTransport,
  HttpWarehouseTransport,
  defaultCmdRunner,
  type CmdRunner,
  type WarehouseTransport,
} from './transport.ts';
import { effectiveEndpoint, ensureTunnel, type TunnelRuntime, type TunnelStatus } from './tunnel.ts';

export interface ConnectOptions {
  /** cmd 传输的运行器（单测注入） */
  runner?: CmdRunner;
  /** 不自动建隧道（doctor 想自己报状态时用） */
  noTunnel?: boolean;
  /** 隧道运行时（单测注入；生产用默认实现） */
  tunnelRuntime?: TunnelRuntime;
}

export interface Connection {
  env: ResolvedWarehouseEnv;
  transport: WarehouseTransport;
  /** 隧道生效后的实际连接地址 */
  endpoint: { mysqlHost: string; mysqlPort: number; httpHost: string; httpPort: number };
  /** 隧道状态；未启用隧道时为 undefined */
  tunnel?: TunnelStatus;
}

/** 只装配传输层，不碰隧道。 */
export function createTransport(env: ResolvedWarehouseEnv, opts: ConnectOptions = {}): WarehouseTransport {
  const endpoint = effectiveEndpoint(env);
  if (env.transport === 'cmd') {
    return new CmdWarehouseTransport(env, opts.runner ?? defaultCmdRunner);
  }
  return new HttpWarehouseTransport(env, { host: endpoint.httpHost, port: endpoint.httpPort });
}

/**
 * 装配连接：先确保隧道可用（启用时），再按生效地址建传输层。
 * 隧道拉不起来就直接失败——半死的连接会让后续每条查询都超时，比早失败更难排查。
 */
export async function connect(env: ResolvedWarehouseEnv, opts: ConnectOptions = {}): Promise<Connection> {
  let tunnel: TunnelStatus | undefined;
  if (env.tunnel?.enabled && !opts.noTunnel) {
    tunnel = await ensureTunnel(env.tunnel, opts.tunnelRuntime);
  }
  const endpoint = effectiveEndpoint(env);
  const transport = createTransport(env, opts);
  return { env, transport, endpoint, tunnel };
}
