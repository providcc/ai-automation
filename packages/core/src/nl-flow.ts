/**
 * 自然语言 → 流程草案（v2 Phase 4.1）
 *
 * 定位：不是"让大模型自由画图"，而是**受约束的生成器**：
 *   - 离线规则解析：从中文/英文描述中抽取 API、表、方法、调度、子流程
 *   - 选中受控模板（节点类型必须存在于 catalog）
 *   - 可选调用外部 LLM（RC_LLM_URL）做意图补全；失败自动回退离线规则
 *   - 输出 BuildInput + 节点属性建议，交给 flow-build / flow-validate 再校验
 *
 * 这样即使没有 LLM，`rc flow from-nl` 也可用、可测试、可审计。
 */
import { Catalog } from './catalog.ts';
import { nextId, prefixFor, type BuildInput, type FlowEdgeSpec, type FlowNodeSpec } from './flow-build.ts';

export interface NlPropsSuggestion {
  nodeId: string;
  nodeType: string;
  values: Record<string, unknown>;
}

export interface NlFlowResult {
  ok: boolean;
  pattern: string;
  kind: 'esb' | 'etl';
  name: string;
  input: BuildInput;
  props: NlPropsSuggestion[];
  warnings: string[];
  usedLlm: boolean;
  rawText: string;
}

export interface NlFlowOptions {
  kind?: 'esb' | 'etl';
  name?: string;
  /** 默认 true；只有配置了 RC_LLM_URL 才会真正调用 */
  useLlm?: boolean;
  catalog?: Catalog;
}

interface Entity {
  url?: string;
  method?: string;
  table?: string;
  sourceTable?: string;
  targetTable?: string;
  subProcessId?: string;
  cron?: string;
  methodName?: string;
}

function extractEntities(text: string): Entity {
  const e: Entity = {};
  const url = text.match(/https?:\/\/[^\s，。；;'"）)]+/i);
  if (url) e.url = url[0];
  else {
    const path = text.match(/(?:路径|path|接口)\s*[:：]?\s*(\/[A-Za-z0-9_./{}:-]+)/i) ?? text.match(/(\/rest\/[A-Za-z0-9_./{}:-]+)/);
    if (path) e.url = path[1];
  }
  const method = text.match(/\b(GET|POST|PUT|DELETE|PATCH)\b/i);
  e.method = method ? method[1].toUpperCase() : undefined;
  const tables = [...text.matchAll(/(?:表|table)\s*[:：]?\s*([A-Za-z_][\w.]*)/gi)].map((m) => m[1]);
  if (tables.length) e.table = tables[0];
  const fromTo = text.match(/(?:从|from)\s*([A-Za-z_][\w.]*)\s*(?:表)?\s*(?:到|写入|同步到|to)\s*([A-Za-z_][\w.]*)/i);
  if (fromTo) {
    e.sourceTable = fromTo[1];
    e.targetTable = fromTo[2];
  }
  const sub = text.match(/\b([a-f0-9]{24})\b/i);
  if (sub) e.subProcessId = sub[1];
  const day = text.match(/每天\s*(\d{1,2})\s*[:：点]\s*(\d{1,2})?/);
  if (day) e.cron = `0 ${Number(day[2] ?? 0)} ${Number(day[1])} * * ?`;
  else if (/每小时/.test(text)) e.cron = '0 0 * * * ?';
  else if (/每\s*(\d+)\s*分钟/.test(text)) {
    const n = Number(text.match(/每\s*(\d+)\s*分钟/)![1]);
    e.cron = `0 0/${n} * * * ?`;
  }
  const named = text.match(/(?:调用|执行)\s*([\w\u4e00-\u9fa5-]{2,30}?)(?:接口|API|服务)/);
  if (named) e.methodName = named[1];
  return e;
}

function detectPattern(text: string): string {
  const t = text.toLowerCase();
  if (/并行|fan.?out|同时调用|两个接口/.test(t)) return 'fanout';
  if (/子流程|subprocess|sub process/.test(t)) return 'subprocess';
  if (/定时|每天|每小时|每分钟|cron|schedule/.test(t)) return 'scheduled';
  if (/消息|队列|kafka|rocketmq|rabbit|mqtt|事件/.test(t)) return 'message';
  if (/文件|excel|csv|sftp|下载|上传/.test(t) && /写入|入库|导入|database|db/.test(t)) return 'file-to-db';
  if (/文件|excel|csv|sftp|导出/.test(t) && /查询|读取|从.*表/.test(t)) return 'db-to-file';
  if (/数据库|表|db|sql|etl|批量/.test(t) && /写入|同步|导入|insert|upsert/.test(t)) return 'batch-sync';
  if (/数据库|表|db|sql/.test(t)) return 'db-to-api';
  if (/如果|条件|分支|路由|判断|gateway/.test(t)) return 'router';
  if (/回调|异步|async|callback/.test(t)) return 'async';
  if (/幂等|idempotent|去重/.test(t)) return 'idempotent';
  return 'sync-api';
}

class Builder {
  readonly nodes: FlowNodeSpec[] = [];
  readonly edges: FlowEdgeSpec[] = [];
  readonly props: NlPropsSuggestion[] = [];
  readonly warnings: string[] = [];
  private used = new Set<string>();

  add(nodeType: string, name: string, values: Record<string, unknown> = {}, opts: { text?: string; flowType?: string } = {}): string {
    const id = nextId(prefixFor(nodeType), this.used);
    this.used.add(id);
    this.nodes.push({ key: id, nodeType, text: opts.text ?? name, nodeName: name, flowType: opts.flowType, props: values });
    if (Object.keys(values).length) this.props.push({ nodeId: id, nodeType, values });
    return id;
  }

  edge(from: string, to: string, assertCondition = '0', label?: string): void {
    this.edges.push({ from, to, assertCondition, label });
  }
}

function defaultName(pattern: string, date = new Date()): string {
  const stamp = date.toISOString().slice(2, 16).replace(/[-:T]/g, '');
  return `NL_${pattern.toUpperCase()}_${stamp}`;
}

function apiProps(e: Entity): Record<string, unknown> {
  return {
    apiUrl: e.url ?? '',
    methodType: e.method ?? 'POST',
    connectTimeout: 10,
    netConnectTimeout: 10,
    retryNum: 2,
    retrySleep: 2,
    responseData: '1',
    requestBodyFlag: '1',
    ...(e.methodName ? { pNodeName: e.methodName } : {}),
  };
}

function sqlProps(e: Entity, write: boolean): Record<string, unknown> {
  const table = write ? (e.targetTable ?? e.table ?? '') : (e.sourceTable ?? e.table ?? '');
  return {
    ...(table ? { tableName: table } : {}),
    ...(table ? { sqlCode: write ? `insert into ${table} (...) values (...)` : `select * from ${table}` } : {}),
    ...(write ? { appendFlag: '1', copyData: '0' } : { pageReadDataFlag: '0' }),
  };
}

interface PatternContext {
  /** 原始自然语言（判断 kafka/sftp 等关键词） */
  text?: string;
  /** 目标类型（ETL 与 ESB 的节点白名单不同） */
  kind?: 'esb' | 'etl';
}

function buildPattern(pattern: string, e: Entity, b: Builder, ctx: PatternContext = {}): string {
  switch (pattern) {
    case 'sync-api': {
      const s = b.add('start', '开始');
      const api = b.add('apiNode', e.methodName ? `${e.methodName}接口` : '调用 API', apiProps(e));
      const end = b.add('end', '结束');
      b.edge(s, api); b.edge(api, end);
      if (!e.url) b.warnings.push('未识别到接口地址：已生成空 apiUrl，请用 --set 或手工补齐');
      return 'start → apiNode → end';
    }
    case 'async': {
      const s = b.add('start', '开始');
      const api = b.add('apiNode', '调用异步 API', { ...apiProps(e), asyncFlag: '1' });
      const cb = b.add('asyncCallbackNode', '异步回调', { timeout: 3600 });
      const end = b.add('end', '结束');
      b.edge(s, api); b.edge(api, cb); b.edge(cb, end);
      b.warnings.push('异步流程需在调用方配置回调地址，并确认平台异步队列已启用');
      return 'start → apiNode(async) → asyncCallbackNode → end';
    }
    case 'router': {
      const s = b.add('start', '开始');
      const api = b.add('apiNode', '查询/判断数据', apiProps(e));
      const yes = b.add('returnDataNode', '命中分支', {});
      const no = b.add('returnDataNode', '未命中分支', {});
      const end = b.add('end', '结束');
      b.edge(s, api);
      // 平台没有排他网关：条件路由是普通节点的多条出边 + assertCondition 3/6
      b.edge(api, yes, '3', '条件成立');
      b.edge(api, no, '6', '条件不成立（默认）');
      b.edge(yes, end);
      b.edge(no, end);
      b.warnings.push('条件分支需在 router 属性中填写 assertionCondition/condition；模板只生成骨架');
      return 'start → apiNode → (assert 3/6) → returnDataNode → end';
    }
    case 'subprocess': {
      const s = b.add('start', '开始');
      const sub = b.add('subProcessNode', '调用子流程', { subProcessId: e.subProcessId ?? '', inDataFlag: '0', outDataFlag: '0', responseData: '1' });
      const end = b.add('end', '结束');
      b.edge(s, sub); b.edge(sub, end);
      if (!e.subProcessId) b.warnings.push('未识别到子流程 id（24 位 hex）：已留空，请在节点属性中填写 subProcessId');
      return 'start → subProcessNode → end';
    }
    case 'scheduled': {
      const s = b.add('start', '开始');
      const time = b.add('timeNode', '定时触发', { cron: e.cron ?? '0 0 2 * * ?' });
      const api = b.add('apiNode', '定时调用', apiProps(e));
      const end = b.add('end', '结束');
      b.edge(s, time); b.edge(time, api); b.edge(api, end);
      if (!e.cron) b.warnings.push('未识别到明确时间：默认每天 02:00（cron=0 0 2 * * ?），请复核');
      return 'start → timeNode → apiNode → end';
    }
    case 'message': {
      const s = b.add('start', '开始');
      const mq = /kafka/i.test(e.url ?? '') || /kafka/i.test(ctx.text ?? '')
        ? b.add('kafkaNode', 'Kafka 消息', { topic: e.table ?? '' })
        : b.add('msgNode', '消息节点', {});
      const api = b.add('apiNode', '消费后调用', apiProps(e));
      const end = b.add('end', '结束');
      b.edge(s, mq); b.edge(mq, api); b.edge(api, end);
      return 'start → 消息节点 → apiNode → end';
    }
    case 'file-to-db': {
      const s = b.add('start', '开始');
      const file = /sftp/i.test(ctx.text ?? '')
        ? b.add('sftpReadNode', '读取 SFTP 文件', {})
        : b.add('sftpReadNode', '读取文件', { filePath: '' });
      const write = b.add('jdbcWriteNode', '写入数据库', { ...sqlProps({ ...e, table: e.targetTable ?? e.table }, true), dbConnId: '' });
      const end = b.add('end', '结束');
      b.edge(s, file); b.edge(file, write); b.edge(write, end);
      b.warnings.push('文件节点需要 filePath、数据库节点需要 dbConnId；生成的是结构草案');
      return 'start → sftpReadNode → jdbcWriteNode → end';
    }
    case 'db-to-file': {
      const s = b.add('start', '开始');
      const read = b.add('sqlExecuterNode', '查询数据库', { sqlCode: e.sourceTable || e.table ? `select * from ${e.sourceTable ?? e.table}` : '', dbConnId: '', pageReadDataFlag: '1' });
      const file = b.add('sftpUploadNode', '上传文件', { filePath: '' });
      const end = b.add('end', '结束');
      b.edge(s, read); b.edge(read, file); b.edge(file, end);
      return 'start → sqlExecuterNode → sftpUploadNode → end';
    }
    case 'batch-sync': {
      const s = b.add('start', '开始');
      // ETL 组件目录里只有 sqlReadNode（没有 tableReadNode）→ 按 kind 选节点类型
      const read = b.add(ctx.kind === 'etl' ? 'sqlReadNode' : 'tableReadNode', '读取源表', { ...sqlProps(e, false), dbConnId: '' });
      const write = b.add('jdbcWriteNode', '写入目标表', { ...sqlProps(e, true), dbConnId: '' });
      const end = b.add('end', '结束');
      b.edge(s, read); b.edge(read, write); b.edge(write, end);
      if (!e.sourceTable && !e.table) b.warnings.push('未识别到源表名');
      if (!e.targetTable && !e.table) b.warnings.push('未识别到目标表名');
      return ctx.kind === 'etl'
        ? 'start → sqlReadNode → jdbcWriteNode → end'
        : 'start → tableReadNode → jdbcWriteNode → end';
    }
    case 'db-to-api': {
      const s = b.add('start', '开始');
      const read = b.add('sqlExecuterNode', '查询数据', { sqlCode: e.table ? `select * from ${e.table}` : '', dbConnId: '' });
      const api = b.add('apiNode', '推送 API', apiProps(e));
      const end = b.add('end', '结束');
      b.edge(s, read); b.edge(read, api); b.edge(api, end);
      return 'start → sqlExecuterNode → apiNode → end';
    }
    case 'fanout': {
      const s = b.add('start', '开始');
      const gw = b.add('gateWay', '并行网关', { gatewayType: '2' });
      const a1 = b.add('apiNode', '并行调用 A', apiProps(e));
      const a2 = b.add('apiNode', '并行调用 B', apiProps(e));
      // 平台结构：并行网关 → 分支 → 聚合网关（joinNodeId 指回并行网关）
      const merge = b.add('gateWay', '聚合网关', { gatewayType: '2', joinNodeId: gw });
      const end = b.add('end', '结束');
      b.edge(s, gw);
      b.edge(gw, a1); b.edge(gw, a2);
      b.edge(a1, merge); b.edge(a2, merge); b.edge(merge, end);
      return 'start → gateWay(parallel) → apiNode×2 → gateWay(join) → end';
    }
    case 'idempotent': {
      const s = b.add('start', '开始');
      const api = b.add('apiNode', '幂等写入', { ...apiProps(e), retryNum: 3, idempotencyKey: '${$.data.id}' });
      const end = b.add('end', '结束');
      b.edge(s, api); b.edge(api, end);
      b.warnings.push('幂等键需与目标系统约定；当前建议 ${$.data.id}');
      return 'start → apiNode(idempotent) → end';
    }
    default:
      return buildPattern('sync-api', e, b);
  }
}

function validateNodeTypes(input: BuildInput, catalog: Catalog): string[] {
  const esb = catalog.nodeTypes();
  const etl = catalog.etlNodeTypes();
  const issues: string[] = [];
  for (const n of input.nodes) {
    if (input.kind === 'etl' && !etl.has(n.nodeType)) issues.push(`ETL 未知节点类型：${n.nodeType}`);
    if (input.kind !== 'etl' && !esb.has(n.nodeType)) issues.push(`ESB 未知节点类型：${n.nodeType}`);
  }
  return issues;
}

async function tryLlm(text: string, opts: NlFlowOptions): Promise<{ pattern?: string; kind?: 'esb' | 'etl'; nodes?: FlowNodeSpec[]; edges?: FlowEdgeSpec[]; warnings: string[] } | undefined> {
  const url = process.env.RC_LLM_URL;
  if (!url || opts.useLlm === false) return undefined;
  const catalog = opts.catalog ?? new Catalog();
  const allowedEsb = [...catalog.nodeTypes()];
  const allowedEtl = [...catalog.etlNodeTypes()];
  const prompt = [
    '你是 iPaaS 流程结构生成器。只输出 JSON，不要解释。',
    `允许的 ESB nodeType: ${allowedEsb.join(',')}`,
    `允许的 ETL nodeType: ${allowedEtl.join(',')}`,
    '输出格式：{"pattern":"...","kind":"esb|etl","nodes":[{"key":"T00001","nodeType":"apiNode","nodeName":"...","props":{}}],"edges":[{"from":"T00001","to":"T00002","assertCondition":"0"}]}',
    '必须包含 start 和 end；只能使用允许的 nodeType；不要输出平台调用。',
    `需求：${text}`,
  ].join('\n');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.RC_LLM_KEY ? { Authorization: `Bearer ${process.env.RC_LLM_KEY}` } : {}),
      },
      body: JSON.stringify({ model: process.env.RC_LLM_MODEL ?? 'default', messages: [{ role: 'user', content: prompt }], temperature: 0 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { warnings: [`LLM HTTP ${res.status}，已回退离线规则`] };
    const data = (await res.json()) as any;
    const content = data?.choices?.[0]?.message?.content ?? data?.content ?? data?.text;
    if (typeof content !== 'string') return { warnings: ['LLM 响应缺少 content，已回退离线规则'] };
    const jsonText = content.match(/\{[\s\S]*\}/)?.[0] ?? content;
    const parsed = JSON.parse(jsonText) as any;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return { warnings: ['LLM 输出结构不合法，已回退离线规则'] };
    const nodes: FlowNodeSpec[] = parsed.nodes.map((n: any) => ({
      key: String(n.key ?? n.id),
      nodeType: String(n.nodeType),
      nodeName: n.nodeName ?? n.name,
      props: n.props ?? {},
    }));
    const edges: FlowEdgeSpec[] = parsed.edges.map((x: any) => ({ from: String(x.from), to: String(x.to), assertCondition: String(x.assertCondition ?? '0') }));
    return { pattern: parsed.pattern, kind: parsed.kind === 'etl' ? 'etl' : 'esb', nodes, edges, warnings: [] };
  } catch (e) {
    return { warnings: [`LLM 调用失败（${(e as Error).message}），已回退离线规则`] };
  }
}

/**
 * 生成流程草案。不会写平台。
 */
export async function flowFromNl(text: string, opts: NlFlowOptions = {}): Promise<NlFlowResult> {
  const catalog = opts.catalog ?? new Catalog();
  const e = extractEntities(text);
  const pattern = detectPattern(text);
  // 类型判定：不能只看"表"字（ESB 需求里也常出现"表"），
  // 需要 表/库 + 同步类动词，或直接出现 etl/批量。
  const kind0 = opts.kind ?? (
    /etl|批量/i.test(text) || (/表|库/.test(text) && /同步|导入|写入|抽取|迁移/.test(text)) ? 'etl' : 'esb'
  );
  const builder = new Builder();
  buildPattern(pattern, e, builder, { text, kind: kind0 });
  let kind = kind0;
  let input: BuildInput = { nodes: builder.nodes, edges: builder.edges, kind };
  let props = builder.props;
  let warnings = [...builder.warnings];
  let usedLlm = false;

  const llm = await tryLlm(text, { ...opts, catalog });
  if (llm?.nodes?.length && llm.edges?.length) {
    const candidate: BuildInput = { nodes: llm.nodes, edges: llm.edges, kind: llm.kind ?? kind };
    const issues = validateNodeTypes(candidate, catalog);
    if (issues.length === 0) {
      input = candidate;
      kind = candidate.kind ?? kind;
      props = candidate.nodes.flatMap((n) => (n.props && Object.keys(n.props).length ? [{ nodeId: String(n.key), nodeType: n.nodeType, values: n.props }] : []));
      warnings = [...warnings, ...(llm.warnings ?? [])];
      usedLlm = true;
    } else {
      warnings.push(...issues, 'LLM 输出包含未知节点类型，已回退离线规则');
    }
  } else if (llm?.warnings?.length) {
    warnings = [...warnings, ...llm.warnings];
  }

  const name = opts.name ?? defaultName(pattern);
  const typeIssues = validateNodeTypes(input, catalog);
  const ok = typeIssues.length === 0 && input.nodes.length >= 2 && input.edges.length >= 1;
  return {
    ok,
    pattern,
    kind,
    name,
    input,
    props,
    warnings: [...new Set([...warnings, ...typeIssues])],
    usedLlm,
    rawText: text,
  };
}

export function formatNlFlow(result: NlFlowResult): string {
  const nodes = result.input.nodes.map((n) => `${n.key}:${n.nodeType}(${n.nodeName ?? ''})`).join(' → ');
  return [
    `模式：${result.pattern}（${result.kind}，${result.usedLlm ? 'LLM 增强' : '离线规则'}）`,
    `建议名称：${result.name}`,
    `节点：${nodes}`,
    `连线：${result.input.edges.length} 条`,
    ...result.warnings.map((w) => `! ${w}`),
    result.ok ? '✔ 结构草案可用；保存前请 rc flow validate' : '✖ 结构草案存在问题，请补充描述或手工修正',
  ].join('\n');
}
