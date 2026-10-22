/**
 * 节点属性 payload 组装：docs/FLOW-JSON-SPEC.md §3.2
 * 平台侧特征：业务参数一律字符串；数组 join(",")；嵌套结构 JSON.stringify；布尔 "1"/"0"
 */

export interface NodePropsInput {
  appId: string;
  processId: string;
  nodeId: string;
  nodeType: string;
  nodeName: string;
  values?: Record<string, unknown>;
  /** 服务端读回的既有属性（保留未编辑字段） */
  base?: Record<string, unknown>;
}

const JSON_FIELDS = new Set(['inParams', 'inHeaders', 'exportParams', 'tableColumns', 'mergeNodeList', 'globalParams']);

export type NodeProps = Record<string, string | number | boolean | null>;

function toPlatformValue(key: string, v: unknown): string | number | null {
  if (v === undefined) return null;
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (Array.isArray(v)) {
    if (JSON_FIELDS.has(key)) return JSON.stringify(v);
    return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(',');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return v as string | number;
}

export function buildNodeProps(input: NodePropsInput): NodeProps {
  const out: NodeProps = {};
  const merged = { ...(input.base ?? {}), ...(input.values ?? {}) };
  for (const [k, v] of Object.entries(merged)) {
    if (k === 'pNodeId' || k === 'pNodeType' || k === 'pNodeName') continue;
    const val = toPlatformValue(k, v);
    if (val !== null) out[k] = val;
  }
  // 上下文与标识必须最后写入，避免被 values 覆盖
  out.appId = input.appId;
  out.processId = input.processId;
  out.pNodeId = input.nodeId;
  out.pNodeType = input.nodeType;
  out.pNodeName = input.nodeName;
  return out;
}

/** 校验 payload 是否满足平台最小要求 */
export function assertNodeProps(p: NodeProps): string[] {
  const missing: string[] = [];
  for (const k of ['appId', 'processId', 'pNodeId', 'pNodeType', 'pNodeName']) {
    if (p[k] === undefined || p[k] === '') missing.push(k);
  }
  return missing;
}

/** 子流程节点的属性组装（spec §12.3） */
export function buildSubProcessProps(input: Omit<NodePropsInput, 'values'> & {
  subProcessId: string;
  inDataFlag?: '0' | '1';
  outDataFlag?: '0' | '1';
  responseData?: '0' | '1' | '2';
  exceptionAssert?: string;
  subProcessFailed?: string;
  assertAction?: string;
}): NodeProps {
  return buildNodeProps({
    ...input,
    values: {
      subProcessId: input.subProcessId,
      inDataFlag: input.inDataFlag ?? '0',
      outDataFlag: input.outDataFlag ?? '0',
      responseData: input.responseData ?? '1',
      ...(input.exceptionAssert ? { exceptionAssert: input.exceptionAssert } : {}),
      ...(input.subProcessFailed ? { subProcessFailed: input.subProcessFailed } : {}),
      ...(input.assertAction ? { assertAction: input.assertAction } : {}),
    },
  });
}
