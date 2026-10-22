/**
 * 流程图构造器：规格见 docs/FLOW-JSON-SPEC.md §2/§4/§8
 * 输出可直接提交 /rest/esb/process/model/save 的 processModel
 */

/** ID 前缀分组（spec §4，源码 core/components/LogicFlow/utile/index.js） */
const E_TYPES = new Set(['start', 'end', 'timeNode', 'eventNode', 'sqlWriteNode', 'msgNode', 'weixinNode', 'dingNode', 'feishuNode', 'textNode']);
const G_TYPES = new Set(['gateWay']);
const S_TYPES = new Set(['subProcess', 'subProcessNode']);

export type IdPrefix = 'E' | 'G' | 'S' | 'T' | 'R';

export function prefixFor(nodeType: string): Exclude<IdPrefix, 'R'> {
  if (E_TYPES.has(nodeType)) return 'E';
  if (G_TYPES.has(nodeType)) return 'G';
  if (S_TYPES.has(nodeType)) return 'S';
  return 'T';
}

const pad = (n: number) => String(n).padStart(5, '0');

/** 取同前缀的最小空缺序号（与平台一致：填洞，而非最大 +1） */
export function nextId(prefix: IdPrefix, used: Iterable<string>): string {
  const nums = new Set<number>();
  for (const id of used) {
    if (id.startsWith(prefix)) {
      const n = Number(id.slice(1));
      if (Number.isFinite(n)) nums.add(n);
    }
  }
  let i = 1;
  while (nums.has(i)) i++;
  return prefix + pad(i);
}

export interface FlowNodeSpec {
  key?: string;
  nodeType: string;
  text?: string;
  nodeName?: string;
  x?: number;
  y?: number;
  flowType?: string;
  props?: Record<string, unknown>;
}

export interface FlowEdgeSpec {
  from: string;
  to: string;
  label?: string;
  assertCondition?: string;
  lineType?: 'Curved' | 'Straight' | 'Flowchart';
  /** 连线属性（ESB 的 router 属性；ETL 不使用） */
  props?: Record<string, unknown>;
}

export interface BuildInput {
  nodes: FlowNodeSpec[];
  edges: FlowEdgeSpec[];
  layout?: { startX?: number; startY?: number; dx?: number; dy?: number };
  /** esb/apiflow（默认）或 etl；ETL 模型只有 nodeDataArray/linkDataArray/transform 三个键（实测） */
  kind?: 'esb' | 'etl';
}

export interface ProcessModel {
  nodeDataArray: Record<string, unknown>[];
  linkDataArray: Record<string, unknown>[];
  transform: number;
  translate: { x: number; y: number };
  detailFlag: boolean;
}

export interface BuiltNodeProps {
  nodeId: string;
  nodeType: string;
  nodeName?: string;
  props: Record<string, unknown>;
}

export interface BuildResult {
  model: ProcessModel;
  /** 生成过程中的非阻断提示（例如自动补默认分支） */
  warnings: string[];
  /** 规格中的节点/连线属性；flow save/validate 应一并传递，不能只落图 */
  props: BuiltNodeProps[];
}

const isStartEnd = (t: string) => t === 'start' || t === 'end';

/** 按拓扑深度分层布局（仅在前端未给坐标时使用） */
function autoLayout(nodes: FlowNodeSpec[], edges: FlowEdgeSpec[], layout: BuildInput['layout'] = {}) {
  const { startX = 260, startY = 265, dx = 250, dy = 130 } = layout;
  const depth = new Map<string, number>();
  for (const n of nodes) if (isStartEnd(n.nodeType)) depth.set(n.key ?? '', 0);
  const adj = new Map<string, string[]>();
  for (const e of edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  let changed = true;
  for (let guard = 0; changed && guard < nodes.length + 2; guard++) {
    changed = false;
    for (const e of edges) {
      const d = depth.get(e.from);
      if (d === undefined) continue;
      if ((depth.get(e.to) ?? -1) < d + 1) {
        depth.set(e.to, d + 1);
        changed = true;
      }
    }
  }
  const rows = new Map<number, number>();
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const d = depth.get(n.key ?? '') ?? 0;
    const r = rows.get(d) ?? 0;
    rows.set(d, r + 1);
    pos.set(n.key ?? '', { x: startX + d * dx, y: startY + r * dy });
  }
  return pos;
}

export function buildProcessModel(input: BuildInput): BuildResult {
  const warnings: string[] = [];
  const used = new Set<string>();

  // 1) 分配节点 ID
  const nodes = input.nodes.map((n) => {
    const key = n.key ?? nextId(prefixFor(n.nodeType), used);
    if (used.has(key)) throw new Error(`节点 ID 重复：${key}`);
    used.add(key);
    return { ...n, key };
  });

  const pos = autoLayout(nodes, input.edges, input.layout);

  const nodeDataArray = nodes.map((n) => {
    const p = pos.get(n.key!)!;
    const showType = isStartEnd(n.nodeType) ? 'NewStartNode' : (n.flowType ?? 'BoxNode');
    return {
      key: n.key,
      nodeType: n.nodeType,
      text: n.text ?? n.nodeName ?? n.nodeType,
      nodeName: n.nodeName ?? n.text ?? n.nodeType,
      name: n.key,
      locLeft: n.x ?? p.x,
      locTop: n.y ?? p.y,
      flowType: showType,
      showNodeType: 'Old',
      titleType: 'text',
      icon: `${n.nodeType}-${input.kind ?? 'esb'}`,
      systemFlag: 1,
      err: false,
      skipChecking: '0',
      ...(input.kind === 'etl' ? { type: 'etl' } : {}),
    };
  });

  // 2) 连线 ID（R 前缀，与节点共用编号空间）
  const routerProps: BuiltNodeProps[] = [];
  const linkDataArray = input.edges.map((e) => {
    const id = nextId('R', used);
    used.add(id);
    if (e.props && Object.keys(e.props).length) {
      routerProps.push({ nodeId: id, nodeType: 'router', props: { ...e.props } });
    }
    return {
      routerId: id,
      from: e.from,
      to: e.to,
      label: e.label ?? 'NO_SHOW',
      lineType: e.lineType ?? 'Curved',
      assertCondition: e.assertCondition ?? '0',
    };
  });

  // 3) 网关默认分支自检（不自动补边，仅提示）
  const specOf = new Map(nodes.map((n) => [n.key!, n]));
  for (const n of nodeDataArray) {
    if (n.nodeType !== 'gateWay') continue;
    const outs = linkDataArray.filter((l) => l.from === n.key);
    if (outs.length === 0) {
      warnings.push(`网关 ${n.key} 没有出口连线`);
      continue;
    }
    const gatewayType = String(specOf.get(String(n.key))?.props?.gatewayType ?? '');
    // 并行/聚合网关没有"默认分支"概念；只有排他网关（1）或未知类型才提示。
    if (gatewayType === '1' || gatewayType === '') {
      if (!outs.some((l) => l.assertCondition === '0')) {
        warnings.push(`网关 ${n.key} 缺少默认分支（assertCondition="0"），无匹配时会挂起`);
      }
    }
  }

  const model: ProcessModel = {
    nodeDataArray,
    linkDataArray,
    transform: 1,
    translate: { x: 0, y: 0 },
    detailFlag: false,
  };
  // ETL 模型实测只有三键：nodeDataArray / linkDataArray / transform
  if (input.kind === 'etl') {
    const m = model as unknown as Record<string, unknown>;
    delete m.translate;
    delete m.detailFlag;
  }

  const nodeProps: BuiltNodeProps[] = nodes
    .filter((n) => n.props && Object.keys(n.props).length)
    .map((n) => ({
      nodeId: n.key!,
      nodeType: n.nodeType,
      nodeName: n.nodeName ?? n.text,
      props: { ...(n.props ?? {}) },
    }));

  return { model, warnings, props: [...nodeProps, ...routerProps] };
}

/** 序列化为接口所需的字符串（/rest/esb/process/model/save 的 processModel） */
export function serializeProcessModel(model: ProcessModel): string {
  return JSON.stringify(model);
}

/** 保存请求体 */
export function buildSaveRequest(appId: string, processId: string, model: ProcessModel) {
  return { appId, processId, processModel: serializeProcessModel(model) };
}
