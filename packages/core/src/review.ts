/**
 * 流程/API 评审（v2 Phase 4.3）
 *
 * 在"能跑"之外检查"敢不敢上线"：
 *   - 平台校验规则（复用 flow-validate）
 *   - 外部调用韧性（超时/重试/错误分支）
 *   - 安全（明文密钥、SQL 拼接、http://、mock 节点）
 *   - 可运维性（命名、补偿、默认分支）
 *
 * 输出 blocker / major / minor / info 四级，CI 可在 blocker/major 时失败。
 */
import type { Issue } from './flow-validate.ts';
import { validateFlow } from './flow-validate.ts';

export type Severity = 'blocker' | 'major' | 'minor' | 'info';

export interface ReviewFinding {
  severity: Severity;
  code: string;
  message: string;
  nodeId?: string;
  action?: string;
}

export interface ReviewReport {
  ok: boolean;
  target: 'flow' | 'api';
  findings: ReviewFinding[];
  summary: Record<Severity, number>;
}

export interface ReviewFlowOptions {
  knownTypes?: Set<string>;
  allowMock?: boolean;
  /** 节点属性（processModel 不含属性，需从平台/生成器注入） */
  nodeProps?: Record<string, Record<string, unknown>>;
  processName?: string;
  /** 生产评审：更严格 */
  production?: boolean;
}

const API_NODE_TYPES = new Set(['apiNode', 'webService', 'dubbo', 'tcpNode', 'beisen', 'restfulNode']);
const SQL_NODE_TYPES = new Set(['sqlExecuterNode', 'tableReadNode', 'jdbcWriteNode', 'sqlWriteNode']);
const SECRET_KEY = /pass(word)?|secret|token|privateKey|accessKey|clientSecret|apiKey/i;
const SECRET_VALUE = /(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*["']?[^\s"',;]{3,}/i;

/**
 * 看着像密钥、其实不是的字段名（平台的开关/标识类）。
 * 之前只按字段名匹配 `token`，`addIdentitytoken`（是否透传身份令牌，平台真实流程 100% 都带）
 * 每条流程都被判 blocker —— 评审工具直接作废。
 */
const SECRET_FIELD_WHITELIST = new Set([
  'addidentitytoken', 'identitytoken', 'assertidentitytoken', 'idempotencykey',
  'tokentype', 'tokenname', 'tokenid', 'secretid', 'secretname', 'keyname', 'keyid',
]);

/**
 * 值不构成"明文凭据"：开关值、占位符、掩码、空值。
 * 平台真实流程里的敏感字段名多数是这类开关（例如 addIdentitytoken='1'）。
 */
function isInnocentValue(v: string): boolean {
  const s = String(v).trim();
  if (!s) return true;
  if (/^(true|false|0|1|yes|no|null|undefined)$/i.test(s)) return true;
  if (/^\*+$/.test(s)) return true;                       // 掩码
  if (/^\$\{?\$?\./.test(s)) return true;                // 变量引用
  if (/^\$\{.*\}$/.test(s)) return true;                  // 模板占位符
  return false;
}

function add(list: ReviewFinding[], severity: Severity, code: string, message: string, nodeId?: string, action?: string): void {
  list.push({ severity, code, message, nodeId, action });
}

function propsOf(model: any, nodeId: string, injected?: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const fromModel = model?.props?.[nodeId] ?? model?.nodeProps?.[nodeId];
  return { ...(injected?.[nodeId] ?? {}), ...(fromModel && typeof fromModel === 'object' ? fromModel : {}) };
}

function scanSecrets(value: unknown, path: string, list: ReviewFinding[], nodeId: string): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value) && !/^\$\{?\$?\./.test(value) && !/^\*+$/.test(value)) {
      add(list, 'blocker', 'SECRET_LITERAL', `疑似明文凭据：${path}`, nodeId, '改用连接/凭据引用或平台密钥管理，不要把密码写进节点属性');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanSecrets(v, `${path}[${i}]`, list, nodeId));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) && typeof v === 'string'
        && !SECRET_FIELD_WHITELIST.has(k.toLowerCase())
        && !isInnocentValue(v)) {
        add(list, 'blocker', 'SECRET_FIELD', `敏感字段 ${path}.${k} 含疑似凭据字面值`, nodeId, '清除明文，改用平台凭据/变量');
      }
      scanSecrets(v, `${path}.${k}`, list, nodeId);
    }
  }
}

export function reviewFlow(model: unknown, opts: ReviewFlowOptions = {}): ReviewReport {
  const findings: ReviewFinding[] = [];
  const m = (model ?? {}) as any;
  const nodes: any[] = Array.isArray(m.nodeDataArray) ? m.nodeDataArray : [];
  const edges: any[] = Array.isArray(m.linkDataArray) ? m.linkDataArray : [];

  // 1) 平台静态校验
  const issues: Issue[] = validateFlow(model, {
    knownTypes: opts.knownTypes,
    allowMock: opts.allowMock ?? !opts.production,
    nodeProps: opts.nodeProps,
  });
  for (const i of issues) {
    const severity = i.level === 'error' ? 'blocker' : i.level === 'warn' ? 'minor' : 'info';
    add(findings, severity, `VALIDATE_${i.code}`, i.msg, i.nodeId, i.level === 'error' ? '先修复再保存/发布' : undefined);
  }

  // 2) 起止节点
  const starts = nodes.filter((n) => n.nodeType === 'start');
  const ends = nodes.filter((n) => n.nodeType === 'end');
  if (starts.length !== 1) add(findings, 'blocker', 'START_COUNT', `开始节点应恰有 1 个，实际 ${starts.length} 个`, undefined, '保留一个开始节点');
  if (ends.length === 0) add(findings, 'major', 'END_MISSING', '流程没有结束节点', undefined, '补充结束节点');

  // 3) 节点级检查
  for (const n of nodes) {
    const id = String(n.key ?? n.nodeId ?? '');
    const type = String(n.nodeType ?? '');
    const p = propsOf(m, id, opts.nodeProps);
    if (type === 'gateWay') {
      const outs = edges.filter((e) => e.from === id);
      if (!outs.some((e) => String(e.assertCondition ?? '0') === '0')) {
        add(findings, 'major', 'GW_NO_DEFAULT', `网关 ${id} 没有默认分支，条件全不匹配时会挂起`, id, '加一条 assertCondition="0" 的默认连线');
      }
      if (outs.length < 2) add(findings, 'minor', 'GW_SINGLE_OUT', `网关 ${id} 只有 ${outs.length} 个出口`, id);
    }
    if (API_NODE_TYPES.has(type)) {
      const url = String(p.apiUrl ?? p.url ?? '');
      if (/^http:\/\//i.test(url)) add(findings, 'major', 'HTTP_PLAIN', `API 节点 ${id} 使用明文 HTTP：${url}`, id, '改用 HTTPS，或确认处于受控内网');
      if (/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(url)) add(findings, 'major', 'LOCALHOST', `API 节点 ${id} 指向本机/回环地址`, id, '改为可被平台访问的服务地址');
      if (!p.retryNum && !p.retry) add(findings, 'minor', 'NO_RETRY', `API 节点 ${id} 未配置重试`, id, '对幂等接口设置 retryNum（如 2）');
      if (!p.connectTimeout && !p.netConnectTimeout) add(findings, 'minor', 'NO_TIMEOUT', `API 节点 ${id} 未配置连接超时`, id, '设置 connectTimeout，避免线程长期占用');
      if (String(p.asyncFlag ?? '0') === '1' && !p.exceptionAssert && !p.responseData) {
        add(findings, 'minor', 'ASYNC_NO_CALLBACK', `异步节点 ${id} 未见异常/回调处理`, id, '确认异步回调或异常分支已配置');
      }
    }
    if (SQL_NODE_TYPES.has(type)) {
      const sql = String(p.sqlCode ?? p.sql ?? '');
      // 平台里 ${字段} 模板拼接是**唯一**可用的写法（真实写库节点都这么写），只当提示，不算问题
      if (sql && /\$\{[^}]*\}/.test(sql)) add(findings, 'info', 'SQL_INTERPOLATION', `SQL 节点 ${id} 用了 \${...} 变量插值（平台的常规写法；注意占位符在运行前不是可执行 SQL）`, id, '确认插值来源可控，必要时用 rc sql check 验证');
      if (sql && /\b(drop|truncate)\s+table\b/i.test(sql) && opts.production) add(findings, 'blocker', 'SQL_DESTRUCTIVE', `SQL 节点 ${id} 含 DROP/TRUNCATE`, id, '生产流程禁止破坏性 SQL；改为可回滚方案');
    }
    if (type === 'mockResponseNode' && opts.production) add(findings, 'blocker', 'MOCK_IN_PROD', `生产流程包含模拟数据节点 ${id}`, id, '删除或替换为真实节点');
    scanSecrets(p, `node[${id}].props`, findings, id);
  }

  // 4) 可运维性
  if (opts.processName && !/^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5_.-]{2,80}$/.test(opts.processName)) {
    add(findings, 'minor', 'NAME', `流程名称不规范：${opts.processName}`, undefined, '使用 3-80 位中文/字母/数字/下划线，体现业务域与动作');
  }
  // 错误分支：只看英文 label 会永远亮着（中文流程标"成功/失败"）。这里同时看
  // ① 连线 label（中英文）② assertCondition（1/2/3 这类"条件分支"说明有分支设计）。
  const apiCount = nodes.filter((n) => API_NODE_TYPES.has(String(n.nodeType))).length;
  if (apiCount > 0) {
    const errorBranch = edges.some((e) => {
      const label = String(e.label ?? '');
      if (/error|fail|compensat|异常|失败|错误|补偿|回滚/i.test(label)) return true;
      const cond = String(e.assertCondition ?? '0');
      return cond !== '0' && cond !== '';   // 条件分支（1/2/3…）
    });
    if (!errorBranch) {
      add(findings, 'info', 'NO_ERROR_BRANCH', `存在 ${apiCount} 个外部调用节点，但未见显式错误/条件分支`, undefined, '确认平台异常策略（exceptionAssert）已覆盖，或补一条失败分支');
    }
  }

  const summary: Record<Severity, number> = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const f of findings) summary[f.severity]++;
  return { ok: summary.blocker === 0 && summary.major === 0, target: 'flow', findings, summary };
}

export interface ReviewApiOptions {
  production?: boolean;
}

/**
 * API 资产评审：输入可以是服务数组、导出包 {services:[]}、或 {data:{rows:[]}}。
 */
export function reviewApiBundle(bundle: unknown, opts: ReviewApiOptions = {}): ReviewReport {
  const findings: ReviewFinding[] = [];
  const b = (bundle ?? {}) as any;
  const list: any[] = Array.isArray(b) ? b : (b.services ?? b.rows ?? b.data?.rows ?? b.data?.services ?? (Array.isArray(b.data) ? b.data : []));
  if (!Array.isArray(list) || list.length === 0) {
    add(findings, 'major', 'API_EMPTY', '没有可评审的 API 条目（期望数组或 {services:[...]}）');
  }
  const seen = new Map<string, string>();
  for (const s of list) {
    const id = String(s.id ?? s.serviceId ?? s.mapUrl ?? 'unknown');
    const path = String(s.mapUrl ?? s.path ?? s.servicePath ?? '');
    const method = String(s.methodType ?? s.method ?? '').toUpperCase();
    const name = String(s.configName ?? s.serviceName ?? s.summary ?? '');
    if (!path) add(findings, 'major', 'API_NO_PATH', `服务 ${id} 缺 mapUrl/path`, id);
    if (!name) add(findings, 'minor', 'API_NO_NAME', `服务 ${id} 缺名称/摘要`, id, '补充 configName，便于检索');
    if (!method) add(findings, 'major', 'API_NO_METHOD', `服务 ${id} 缺 methodType`, id);
    if (path) {
      const key = `${method} ${path}`;
      if (seen.has(key)) add(findings, 'blocker', 'API_DUP', `重复路由：${key}（与 ${seen.get(key)} 冲突）`, id, '同一方法+路径只能保留一个服务');
      else seen.set(key, id);
      const vars = [...path.matchAll(/\{([^}]+)\}/g)].map((x) => x[1]);
      const paramsText = JSON.stringify(s.inParams ?? s.params ?? []);
      for (const v of vars) {
        if (!paramsText.includes(v)) add(findings, 'minor', 'API_PATH_PARAM', `${method} ${path} 的路径参数 {${v}} 未在参数表中声明`, id, '补 inParams 定义，否则调用方无法生成正确请求');
      }
      if (/\/\//.test(path.replace(/^https?:\/\//, ''))) add(findings, 'minor', 'API_PATH_SLASH', `路径含重复斜杠：${path}`, id);
    }
    if (String(s.authType ?? '') === '0' && opts.production) add(findings, 'major', 'API_NO_AUTH', `生产 API 未配置认证：${method} ${path}`, id, '确认是否允许匿名；否则设置 authType');
    if (/password|secret|token/i.test(JSON.stringify(s))) {
      const text = JSON.stringify(s);
      if (SECRET_VALUE.test(text)) add(findings, 'blocker', 'API_SECRET', `服务 ${id} 的配置中疑似含明文凭据`, id, '改用认证配置/密钥引用');
    }
  }
  const summary: Record<Severity, number> = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const f of findings) summary[f.severity]++;
  return { ok: summary.blocker === 0 && summary.major === 0, target: 'api', findings, summary };
}

export function formatReview(report: ReviewReport): string {
  const icon: Record<Severity, string> = { blocker: '✖', major: '!', minor: '·', info: 'i' };
  const lines = [`评审对象：${report.target}，结论：${report.ok ? '通过' : '不通过'}`];
  for (const f of report.findings) {
    lines.push(`${icon[f.severity]} [${f.severity}] ${f.code}${f.nodeId ? ` (${f.nodeId})` : ''}: ${f.message}`);
    if (f.action) lines.push(`    → ${f.action}`);
  }
  lines.push(`汇总：blocker=${report.summary.blocker} major=${report.summary.major} minor=${report.summary.minor} info=${report.summary.info}`);
  return lines.join('\n');
}
