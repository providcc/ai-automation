/**
 * 流程图静态校验：docs/FLOW-JSON-SPEC.md §9（12 条规则）
 * 纯本地计算，不访问平台。
 */
import { prefixFor } from './flow-build.ts';

export type Level = 'error' | 'warn' | 'info';

export interface Issue {
  level: Level;
  code: string;
  msg: string;
  nodeId?: string;
  /** 规则 13：缺失的必填字段名 */
  field?: string;
}

export interface ValidateOptions {
  /** 允许的 nodeType（来自 catalog/components.json） */
  knownTypes?: Set<string>;
  /** 是否允许 mock 节点（生产应为 false） */
  allowMock?: boolean;
  /** 子流程存在性判定（外部注入，避免硬编码请求） */
  subProcessExists?: (subProcessId: string) => boolean;
  /** 节点属性（nodeId → props），用于规则 7/8/9/11 */
  nodeProps?: Record<string, Record<string, unknown>>;
  /** 聚合网关节点类型（默认 dataMergeNode） */
  mergeNodeType?: string;
  /** 必填字段表：nodeType → 必填字段名（来自组件目录） */
  requiredFields?: Record<string, string[]>;
  /**
   * 必填字段缺失的严重级别：
   * - error（默认）：阻断保存；
   * - warn：只提示（骨架模板、未采集必填项的 ETL 组件用这个）；
   * - off：跳过该规则。
   */
  requiredLevel?: Level | 'off';
}

interface NodeLike {
  key?: string;
  nodeType?: string;
  locLeft?: number;
  locTop?: number;
  [k: string]: unknown;
}
interface EdgeLike {
  routerId?: string;
  from?: string;
  to?: string;
  [k: string]: unknown;
}

// 平台用 "0"/"1" 表示开关的字段
const BOOLEAN_FIELDS = new Set([
  'asyncFlag', 'compensateFlag', 'endProcessFlag', 'addIdentitytoken', 'isEnabledCallback',
  'skipChecking', 'copyData', 'skipCompensateFlag', 'pageReadDataFlag', 'requestBodyFlag', 'syncFlag',
]);

// 平台用枚举（不是布尔）表示的字段：值的含义不是 "0"/"1"，不做布尔校验
// 例：assertionCodeType 1/2 = 成功/失败分支（RouterNode.jsx 的 params）
const ENUM_FIELDS = new Set([
  'assertionCodeType', 'responseData', 'methodType', 'executerType', 'mappingType', 'outputType',
  'writeType', 'registerFlag', 'logType', 'publishStatus', 'state', 'loadBalanceId',
]);
const JSON_STRING_FIELDS = new Set(['inParams', 'inHeaders', 'exportParams', 'tableColumns', 'mergeNodeList', 'globalParams']);

/**
 * 必填字段的替代写法：填了任一替代字段即视为已配置。
 * 例：apiNode 既可以直接写 apiUrl，也可以引用平台已配置的 API 服务（apiId）。
 */
const REQUIRED_FIELD_ALTERNATIVES: Record<string, Record<string, string[]>> = {
  apiNode: { apiUrl: ['apiId'] },
};

function hasValue(props: Record<string, unknown> | undefined, field: string): boolean {
  const v = props?.[field];
  if (v === undefined || v === null) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

/** 属性是否"有值"（空串/空数组视为缺失）——校验器与导出共用。 */
export const hasPropValue = hasValue;

/**
 * 判断文本里是否有"需要声明"的 $. 引用。
 * 平台惯用值（$.data 及其子路径、$.data.xxx）不算——它们是上游载荷的默认根。
 */
function hasCustomExprRef(text: string): boolean {
  const refs = String(text ?? '').match(/\$\.([A-Za-z_][A-Za-z0-9_]*)/g) ?? [];
  for (const r of refs) {
    const field = r.slice(2);
    if (field === 'data') continue;          // 平台惯用：上游载荷根
    if (field.startsWith('data.')) continue;  // 平台惯用：上游载荷的子路径
    return true;
  }
  return false;
}

export function validateFlow(model: unknown, opts: ValidateOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const g = model as { nodeDataArray?: NodeLike[]; linkDataArray?: EdgeLike[] } | null;
  if (!g || typeof g !== 'object') {
    return [{ level: 'error', code: 'SHAPE', msg: '不是对象：缺少 nodeDataArray/linkDataArray' }];
  }
  const nodes = Array.isArray(g.nodeDataArray) ? g.nodeDataArray : [];
  const edges = Array.isArray(g.linkDataArray) ? g.linkDataArray : [];
  if (nodes.length === 0) issues.push({ level: 'error', code: 'EMPTY', msg: '图为空' });

  // 规则 1：唯一 start、至少一个 end
  const startCount = nodes.filter((n) => n.nodeType === 'start').length;
  const endCount = nodes.filter((n) => n.nodeType === 'end').length;
  if (startCount === 0) issues.push({ level: 'error', code: 'NO_START', msg: '缺少 start 节点' });
  if (startCount > 1) issues.push({ level: 'error', code: 'MULTI_START', msg: `存在 ${startCount} 个 start 节点` });
  if (endCount === 0) issues.push({ level: 'error', code: 'NO_END', msg: '缺少 end 节点' });

  // 规则 2：ID 前缀与唯一性
  const ids = new Set<string>();
  for (const n of nodes) {
    const key = n.key;
    if (!key) {
      issues.push({ level: 'error', code: 'NO_KEY', msg: `节点缺少 key（nodeType=${n.nodeType}）` });
      continue;
    }
    if (ids.has(key)) issues.push({ level: 'error', code: 'DUP_ID', msg: `节点 ID 重复：${key}`, nodeId: key });
    ids.add(key);
    const expected = prefixFor(String(n.nodeType));
    if (!key.startsWith(expected)) {
      issues.push({ level: 'warn', code: 'ID_PREFIX', msg: `${key} 的 nodeType=${n.nodeType} 建议前缀 ${expected}`, nodeId: key });
    }
    // 规则 6：nodeType 白名单
    if (opts.knownTypes && !opts.knownTypes.has(String(n.nodeType))) {
      issues.push({ level: 'error', code: 'UNKNOWN_TYPE', msg: `未知 nodeType：${n.nodeType}`, nodeId: key });
    }
    // 规则 10：mock
    if (n.nodeType === 'mockResponseNode' && opts.allowMock === false) {
      issues.push({ level: 'error', code: 'MOCK', msg: `生产流程禁止模拟数据节点：${key}`, nodeId: key });
    }
  }

  // 规则 3：连线端点存在
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const from = String(e.from ?? '');
    const to = String(e.to ?? '');
    if (!ids.has(from)) issues.push({ level: 'error', code: 'EDGE_FROM', msg: `连线源节点不存在：${from}（routerId=${e.routerId}）` });
    if (!ids.has(to)) issues.push({ level: 'error', code: 'EDGE_TO', msg: `连线目标节点不存在：${to}（routerId=${e.routerId}）` });
    if (!e.routerId) issues.push({ level: 'error', code: 'EDGE_ID', msg: `连线缺少 routerId（${from}→${to}）` });
    adj.set(from, [...(adj.get(from) ?? []), to]);
  }

  // 规则 4：网关分支（每条非默认出口须有条件，且恰有一个默认）
  // 网关类型语义（平台原文）：1=排他网关 2=并行网关 3=包含网关
  // 没有属性时**不能假设所有网关都是并行网关**：只做结构检查（出口/连线），
  // 类型相关规则（缺省分支、聚合配对）必须由显式 gatewayType 驱动。
  const gatewayTypeOf = (nodeId: string): string | undefined => {
    const t = opts.nodeProps?.[nodeId]?.gatewayType;
    return t === undefined || t === null || t === '' ? undefined : String(t);
  };
  for (const n of nodes) {
    if (n.nodeType !== 'gateWay') continue;
    const outs = edges.filter((e) => e.from === n.key);
    if (outs.length === 0) issues.push({ level: 'error', code: 'GW_NO_OUT', msg: `网关 ${n.key} 没有出口`, nodeId: n.key });
    const defaults = outs.filter((e) => String(e.assertCondition ?? '0') === '0');
    const gType = gatewayTypeOf(String(n.key));
    const isParallelish = gType === '2' || gType === '3';
    if (outs.length > 0 && defaults.length === 0 && gType === '1') {
      issues.push({ level: 'error', code: 'GW_NO_DEFAULT', msg: `排他网关 ${n.key} 缺少缺省路由（assertCondition="0" 或 defaultRouterNodeId）`, nodeId: n.key });
    }
    // 并行/包含网关允许多条无条件分支（平台语义），排他网关只允许一条缺省
    if (defaults.length > 1 && gType === '1') {
      issues.push({ level: 'warn', code: 'GW_MULTI_DEFAULT', msg: `排他网关 ${n.key} 有 ${defaults.length} 条缺省路由`, nodeId: n.key });
    }
    const selfJoin = opts.nodeProps?.[String(n.key)]?.joinNodeId;
    const isAggregate = selfJoin !== undefined && selfJoin !== null && String(selfJoin) !== '';
    if (isParallelish && !isAggregate) {
      // 平台语义（实测 + 前端 help）：
      //   「并行网关和包含网关有多个并行分支时后续必须添加聚合网关节点」
      //   聚合节点的属性 joinNodeId = "聚合前继网关"（要聚合的前继网关节点 id）
      // → 每个并行分支必须能到达一个 dataMergeNode，且该节点的 joinNodeId === 本网关 key
      // 平台实测语义：
      //   并行网关（gatewayType=2/3）必须有一个**直接后继**是聚合网关，
      //   聚合网关本身是 gateWay 节点，且其属性 joinNodeId（"聚合前继网关"）= 该并行网关 key。
      //   （dataMergeNode 不算聚合网关；间接经过中间节点也不算数。）
      const gatewayKey = String(n.key); // 被聚合的并行网关
      // 实测（北森人员信息接口）：并行网关 → 各分支节点 → 聚合网关（joinNodeId=并行网关）。
      // 聚合网关通常不是并行网关的**直接后继**，因此按"每个分支都能到达同一个聚合网关"判断。
      const aggregates = nodes.filter((x) => String(x.nodeType) === 'gateWay'
        && String(opts.nodeProps?.[String(x.key)]?.joinNodeId ?? '') === gatewayKey);
      const canReach = (from: string, target: string): boolean => {
        const seen = new Set<string>([from]);
        const queue = [from];
        for (let guard = 0; guard < nodes.length + 2 && queue.length; guard++) {
          const u = queue.shift()!;
          if (u === target) return true;
          for (const e of edges) {
            const t = String(e.to);
            if (String(e.from) === u && !seen.has(t)) {
              seen.add(t);
              queue.push(t);
            }
          }
        }
        return false;
      };
      const paired = outs.length > 0 && aggregates.some((agg) => {
        const aggKey = String(agg.key);
        return outs.every((o) => canReach(String(o.to), aggKey));
      });
      if (!paired) {
        issues.push({
          level: 'error', code: 'GW_MERGE_MISSING',
          msg: `并行网关 ${n.key}（gatewayType=${gType}）缺少配对的聚合网关：需所有分支最终汇入一个 gateWay 且 joinNodeId=${n.key}`,
          nodeId: String(n.key),
        });
      }
    }
  }

  // 规则 4b：重复 routerId
  const routerIds = new Map<string, number>();
  for (const e of edges) {
    const rid = String(e.routerId ?? '');
    if (!rid) continue;
    routerIds.set(rid, (routerIds.get(rid) ?? 0) + 1);
  }
  for (const [rid, n] of routerIds) {
    if (n > 1) issues.push({ level: 'error', code: 'DUP_ROUTER_ID', msg: `routerId 重复 ${n} 次：${rid}` });
  }

  // 规则 4c：节点可达性（从 start 出发不可达）
  if (nodes.length) {
    const startNode = nodes.find((n) => n.nodeType === 'start');
    if (startNode?.key) {
      const reach = new Set<string>([String(startNode.key)]);
      let changed = true;
      for (let guard = 0; guard < nodes.length + 2 && changed; guard++) {
        changed = false;
        for (const e of edges) {
          const f = String(e.from); const t = String(e.to);
          if (reach.has(f) && !reach.has(t)) { reach.add(t); changed = true; }
        }
      }
      for (const n of nodes) {
        const key = String(n.key);
        if (!reach.has(key) && n.nodeType !== 'start') {
          issues.push({ level: 'warn', code: 'UNREACHABLE', msg: `节点 ${key}（${n.nodeType}）从 start 不可达`, nodeId: key });
        }
      }
    }
  }

  // 规则 4d：断言表达式基础语法（仅做明显错误的静态检查，完整 BNF 仍以平台 checkerror 为准）
  for (const e of edges) {
    const cond = String(e.assertCondition ?? '');
    if (!cond || cond === '0') continue;
    const open = (cond.match(/\(/g) ?? []).length;
    const close = (cond.match(/\)/g) ?? []).length;
    if (open !== close) {
      issues.push({ level: 'error', code: 'EXPR_PAREN', msg: `连线 ${e.routerId} 的条件表达式括号不配对：${cond}` });
    }
    if (/[=><!+\-*/&|]\s*$/.test(cond)) {
      issues.push({ level: 'error', code: 'EXPR_TRAILING_OP', msg: `连线 ${e.routerId} 的条件表达式以运算符结尾：${cond}` });
    }
    if (!/\$|\d|'|"/.test(cond)) {
      issues.push({ level: 'warn', code: 'EXPR_NO_VALUE', msg: `连线 ${e.routerId} 的条件表达式没有取值：${cond}` });
    }
  }

  // 规则 5：环检测（timeNode 自环豁免）
  const color = new Map<string, number>();
  const typeOf = new Map(nodes.map((n) => [String(n.key), String(n.nodeType)] as const));
  const dfs = (u: string): boolean => {
    color.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === 1) {
        if (!(u === v && typeOf.get(v) === 'timeNode')) return true;
        continue;
      }
      if (!color.get(v) && dfs(v)) return true;
    }
    color.set(u, 2);
    return false;
  };
  for (const id of ids) if (!color.get(id) && dfs(id)) {
    issues.push({ level: 'error', code: 'CYCLE', msg: '存在环（timeNode 自环除外）' });
    break;
  }

  // 规则 7/8/9/11/12：基于节点属性
  if (opts.nodeProps) {
    for (const [nodeId, props] of Object.entries(opts.nodeProps)) {
      const node = nodes.find((n) => n.key === nodeId);
      const router = edges.find((e) => String(e.routerId ?? '') === nodeId);
      if (!node && !router) {
        issues.push({ level: 'error', code: 'ORPHAN_PROPS', msg: `属性对应的节点/路由不存在：${nodeId}`, nodeId });
        continue;
      }
      if (node) {
        if (props.pNodeId !== undefined && props.pNodeId !== nodeId) {
          issues.push({ level: 'error', code: 'PROPS_ID', msg: `pNodeId(${props.pNodeId}) 与节点 key(${nodeId}) 不一致`, nodeId });
        }
        if (props.pNodeType !== undefined && props.pNodeType !== node.nodeType) {
          issues.push({ level: 'error', code: 'PROPS_TYPE', msg: `pNodeType(${props.pNodeType}) 与 nodeType(${node.nodeType}) 不一致`, nodeId });
        }
      } else if (router) {
        if (props.pNodeId !== undefined && props.pNodeId !== nodeId) {
          issues.push({ level: 'error', code: 'PROPS_ID', msg: `pNodeId(${props.pNodeId}) 与路由 routerId(${nodeId}) 不一致`, nodeId });
        }
        if (props.pNodeType !== undefined && props.pNodeType !== 'router') {
          issues.push({ level: 'error', code: 'PROPS_TYPE', msg: `路由属性 pNodeType 应为 router，实际为 ${props.pNodeType}`, nodeId });
        }
        const expect = String(router.assertCondition ?? '0');
        if (props.assertCondition !== undefined && String(props.assertCondition) !== expect) {
          issues.push({ level: 'warn', code: 'PROPS_ROUTER_COND', msg: `${nodeId}.assertCondition=${props.assertCondition} 与连线 ${expect} 不一致`, nodeId });
        }
      }
      for (const [k, v] of Object.entries(props)) {
        if (BOOLEAN_FIELDS.has(k) && !ENUM_FIELDS.has(k) && v !== undefined && v !== '' && v !== null
          && v !== '0' && v !== '1' && v !== 'true' && v !== 'false'
          && typeof v !== 'boolean' && typeof v !== 'number') {
          issues.push({ level: 'warn', code: 'BOOL_AS_STRING', msg: `${nodeId}.${k} 应为 "0"/"1" 字符串，实际为 ${JSON.stringify(v)}`, nodeId });
        }
        if (JSON_STRING_FIELDS.has(k) && typeof v === 'string' && v.trim().startsWith('[')) {
          try { JSON.parse(v); } catch {
            issues.push({ level: 'error', code: 'JSON_FIELD', msg: `${nodeId}.${k} 不是合法 JSON 字符串`, nodeId });
          }
        }
      }
      // 规则 13：必填字段（来自组件目录 required）——按节点遍历，见下方 REQUIRED_FIELD 检查
      if (node) {
        // 规则 12：子流程引用
        if (node.nodeType === 'subProcessNode' || node.nodeType === 'subProcess') {
          const subId = String(props.subProcessId ?? '');
          if (!subId) issues.push({ level: 'error', code: 'SUB_NO_REF', msg: `子流程节点 ${nodeId} 未指定 subProcessId`, nodeId });
          else if (opts.subProcessExists && !opts.subProcessExists(subId)) {
            issues.push({ level: 'error', code: 'SUB_NOT_FOUND', msg: `子流程不存在：${subId}`, nodeId });
          }
        }
      }
    }
  }

  // 规则 11：表达式引用（无任何 exportParams 声明却使用 $. 引用时告警）
  //
  // 注意：`$.data` 是平台的**惯用值**（dataSplitNode.dataFieldId、pageDataJsonPath 等
  // 到处都有），它指的是上游节点的默认载荷根，不是有歧义的引用。把它算进去会让
  // 几乎每条流程都报这条警告——纯噪声，会训练人忽略 warning。
  // 因此只对"非惯用"的 $.xxx 引用告警。
  if (opts.nodeProps) {
    const anyExport = Object.values(opts.nodeProps).some((p) => typeof p.exportParams === 'string' && p.exportParams.length > 2);
    const usesExpr = Object.values(opts.nodeProps).some((p) => hasCustomExprRef(JSON.stringify(p)));
    if (usesExpr && !anyExport) {
      issues.push({ level: 'info', code: 'EXPR_UNDECLARED', msg: '节点使用了 $. 表达式，但全流程没有 exportParams 声明——平台流程普遍不声明，属提示而非缺陷' });
    }
  }

  // 规则 13：必填字段（来自组件目录 required）
  // 按节点遍历：属性整条缺失的节点同样要报，否则"删掉整个属性"可以绕过校验。
  const requiredLevel = opts.requiredLevel ?? 'error';
  if (requiredLevel !== 'off' && opts.requiredFields) {
    for (const node of nodes) {
      const nodeType = String(node.nodeType ?? '');
      const req = opts.requiredFields[nodeType];
      if (!req?.length) continue;
      const nodeId = String(node.key ?? '');
      if (!nodeId) continue;
      const props = opts.nodeProps?.[nodeId];
      const alts = REQUIRED_FIELD_ALTERNATIVES[nodeType] ?? {};
      const missing: string[] = [];
      for (const f of req) {
        if (hasValue(props, f)) continue;
        const alt = (alts[f] ?? []).some((a) => hasValue(props, a));
        if (!alt) missing.push(f);
      }
      if (missing.length) {
        issues.push({
          level: requiredLevel,
          code: 'REQUIRED_FIELD',
          msg: `${nodeId}（${nodeType}）缺少必填属性 ${missing.join('、')}`
            + `（组件目录标记或启发式规则判定为必填；平台 checkerror 不校验此项，`
            + `骨架模板可用 --allow-missing-required 跳过）`,
          nodeId,
          field: missing[0],
        });
      }
    }
  }

  return issues;
}

export const hasBlockingError = (issues: Issue[]): boolean => issues.some((i) => i.level === 'error');
