/**
 * 流程状态指纹与语义 diff。
 *
 * 两件事：
 * 1) **指纹**：把"图 + 业务属性"归一化成稳定摘要，用来发现"别人已经改过这条流程"
 *    （乐观并发保护：读到的版本与保存时平台上的版本不一致 → 拒绝写入）。
 * 2) **语义 diff**：保存前告诉人/Agent 到底改了什么（新增/删除/变更的节点、连线、属性）。
 */
import { createHash } from 'node:crypto';

/** 平台自动维护/每次写都会变的字段：不算业务内容，也不参与指纹。 */
const VOLATILE_FIELDS = new Set([
  'id', 'createTime', 'editTime', 'creator', 'creatorName', 'editor', 'editorName',
  'appId', 'processId', 'applicationId', 'expireAfterIndexTime', 'pNodeRole', 'state', 'version',
]);

export interface FlowState {
  model?: { nodeDataArray?: any[]; linkDataArray?: any[]; [k: string]: unknown } | unknown;
  props?: Record<string, Record<string, unknown>>;
}

export interface FlowDiffEntry {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface FlowDiff {
  nodes: FlowDiffEntry;
  links: FlowDiffEntry;
  props: FlowDiffEntry;
  /** 一行摘要，方便直接打印 */
  summary: string;
  /** 是否没有任何变化 */
  empty: boolean;
}

/** 去掉平台易变字段后的属性副本（按 key 排序，保证可比较）。 */
export function businessProps(props: Record<string, Record<string, unknown>> | undefined): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, raw] of Object.entries(props ?? {})) {
    const p: Record<string, unknown> = {};
    for (const k of Object.keys(raw ?? {}).sort()) {
      if (VOLATILE_FIELDS.has(k)) continue;
      p[k] = raw[k];
    }
    out[id] = p;
  }
  return out;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`).join(',')}}`;
}

/** 节点的"身份 + 关键形态"：只看会不会影响运行。 */
function nodeShape(n: any): string {
  return stableStringify({
    nodeType: n?.nodeType ?? '',
    text: n?.text ?? '',
    nodeName: n?.nodeName ?? '',
    icon: n?.icon ?? '',
    flowType: n?.flowType ?? '',
  });
}

/** 连线的"身份 + 关键形态"。 */
function linkShape(l: any): string {
  return stableStringify({
    from: l?.from ?? '',
    to: l?.to ?? '',
    assertCondition: l?.assertCondition ?? '0',
    label: l?.label ?? '',
  });
}

/**
 * 流程状态指纹：图（节点/连线形态）+ 业务属性。
 * 同一条流程、同一份内容 → 同一指纹；任何业务改动都会改变指纹。
 */
export function flowFingerprint(state: FlowState): string {
  const model = (state.model ?? {}) as any;
  const nodes: [string, string][] = (model.nodeDataArray ?? []).map((n: any) => [String(n?.key ?? ''), nodeShape(n)]);
  const links: [string, string][] = (model.linkDataArray ?? []).map((l: any) => [String(l?.routerId ?? `${l?.from ?? ''}->${l?.to ?? ''}`), linkShape(l)]);
  nodes.sort((a, b) => a[0].localeCompare(b[0]));
  links.sort((a, b) => a[0].localeCompare(b[0]));
  const props = businessProps(state.props);
  const payload = stableStringify({ nodes, links, props });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function diffEntry(current: Map<string, string>, next: Map<string, string>): FlowDiffEntry {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [k, v] of next) {
    if (!current.has(k)) added.push(k);
    else if (current.get(k) !== v) changed.push(k);
  }
  for (const k of current.keys()) if (!next.has(k)) removed.push(k);
  const byId = (a: string[]) => a.sort((x, y) => x.localeCompare(y));
  return { added: byId(added), removed: byId(removed), changed: byId(changed) };
}

/**
 * 语义 diff：对比"平台当前"与"即将保存"两份状态。
 * 节点/连线按 key / routerId 对齐，属性按 pNodeId 对齐。
 */
export function diffFlow(current: FlowState, next: FlowState): FlowDiff {
  const curModel = (current.model ?? {}) as any;
  const nextModel = (next.model ?? {}) as any;

  const curNodes = new Map<string, string>();
  for (const n of curModel.nodeDataArray ?? []) curNodes.set(String(n?.key ?? ''), nodeShape(n));
  const nextNodes = new Map<string, string>();
  for (const n of nextModel.nodeDataArray ?? []) nextNodes.set(String(n?.key ?? ''), nodeShape(n));

  const curLinks = new Map<string, string>();
  for (const l of curModel.linkDataArray ?? []) curLinks.set(String(l?.routerId ?? `${l?.from ?? ''}->${l?.to ?? ''}`), linkShape(l));
  const nextLinks = new Map<string, string>();
  for (const l of nextModel.linkDataArray ?? []) nextLinks.set(String(l?.routerId ?? `${l?.from ?? ''}->${l?.to ?? ''}`), linkShape(l));

  const curProps = new Map<string, string>();
  for (const [id, p] of Object.entries(businessProps(current.props))) curProps.set(id, stableStringify(p));
  const nextProps = new Map<string, string>();
  for (const [id, p] of Object.entries(businessProps(next.props))) nextProps.set(id, stableStringify(p));

  const nodes = diffEntry(curNodes, nextNodes);
  const links = diffEntry(curLinks, nextLinks);
  const props = diffEntry(curProps, nextProps);
  const sum = (e: FlowDiffEntry) => `+${e.added.length}/-${e.removed.length}/~${e.changed.length}`;
  const empty = !nodes.added.length && !nodes.removed.length && !nodes.changed.length
    && !links.added.length && !links.removed.length && !links.changed.length
    && !props.added.length && !props.removed.length && !props.changed.length;
  return {
    nodes, links, props, empty,
    summary: empty
      ? '无变化'
      : `节点 ${sum(nodes)}，连线 ${sum(links)}，属性 ${sum(props)}`,
  };
}

/** 把 diff 渲染成人/Agent 能一眼看懂的多行文本。 */
export function formatFlowDiff(diff: FlowDiff): string {
  if (diff.empty) return '无变化';
  const lines: string[] = [];
  const section = (title: string, e: FlowDiffEntry) => {
    if (!e.added.length && !e.removed.length && !e.changed.length) return;
    lines.push(`${title}：`);
    if (e.added.length) lines.push(`  + 新增 ${e.added.join(', ')}`);
    if (e.removed.length) lines.push(`  - 删除 ${e.removed.join(', ')}`);
    if (e.changed.length) lines.push(`  ~ 变更 ${e.changed.join(', ')}`);
  };
  section('节点', diff.nodes);
  section('连线', diff.links);
  section('属性', diff.props);
  return lines.join('\n');
}
