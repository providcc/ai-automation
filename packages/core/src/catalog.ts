/**
 * 目录层：接口目录与组件目录的加载、检索
 * 数据文件：catalog/endpoints.json、catalog/components.json
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EndpointEntry {
  module: string;
  name: string;
  path: string;
  file: string;
  hasPathParam: boolean;
}

export interface ComponentParam {
  key: string;
  label: string | null;
  widget: string | null;
  required: boolean;
  message?: string | null;
  initialValue?: string | null;
  enum?: { value: string; label: string }[] | null;
}

export interface ComponentEntry {
  id: string;
  label: string;
  category: string;
  tip?: string;
  icon?: string;
  systemFlag?: number;
  formFile?: string | null;
  params: ComponentParam[];
  paramSource: 'source-form' | 'unmapped';
}

export interface ComponentCatalog {
  generatedAt?: string;
  categories: { label: string; count: number; items: string[] }[];
  nodes: ComponentEntry[];
  stats?: Record<string, number>;
}

export interface EtlComponentCatalog extends ComponentCatalog {
  stats?: { panelNodes: number; formNodes: number; matched: number; total: number };
}

const here = dirname(fileURLToPath(import.meta.url));
/** 从 packages/core/src 或 dist 回到仓库 catalog/ */
const CATALOG_DIR = join(here, '..', '..', '..', 'catalog');

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(CATALOG_DIR, file), 'utf8')) as T;
}

/** 工具始终自动补齐的元字段，不算"用户必填"。 */
const META_PARAMS = new Set(['pNodeId', 'pNodeName', 'pNodeType', 'pNodeAlias', 'pNodeIcon']);

/**
 * 判断组件参数是否已有可用默认值。
 * - null / 纯表达式（this.nodeObj.*）/ 配置占位符（${...}）→ 没有默认值，必须由用户填；
 * - 字面量（30000 / 'GET'）或带兜底（formData.x || "30"）→ 平台/设计器会填默认值，不强制。
 */
export function hasUsableDefault(initialValue: string | null | undefined): boolean {
  if (initialValue === null || initialValue === undefined) return false;
  const s = String(initialValue).trim();
  if (!s) return false;
  if (s.includes('${')) return false;                    // 配置占位符，不是可用默认值
  if (/\|\|/.test(s)) return true;                       // formData.x || "30"
  if (/^(this|formData|props|node|state|config)\./.test(s)) return false; // 纯表达式，无字面量兜底
  return true;                                           // 其它按字面量默认值处理
}

/**
 * 启发式必填项：组件目录里**没有** required 标记，但缺了流程就跑不起来的字段。
 * 字段名取自真实平台流程的属性（ESB），不是猜的。
 */
const HEURISTIC_REQUIRED: Record<string, string[]> = {
  // SQL / 数据库类：连接与表/语句缺一不可
  sqlExecuterNode: ['dbConnId', 'sqlCode'],
  jdbcWriteNode: ['dbConnId', 'tableName'],
  tableReadNode: ['dbConnId', 'tableName'],
  // 数据拆分：至少要指明拆分字段
  dataSplitNode: ['dataFieldId'],
  // 网关必须声明类型，否则无法判断并行/排他
  gateWay: ['gatewayType'],
};

export class Catalog {
  private endpoints?: { endpoints: EndpointEntry[] };
  private components?: ComponentCatalog;
  private etlComponents?: EtlComponentCatalog;

  endpointsCatalog(): EndpointEntry[] {
    this.endpoints ??= loadJson<{ endpoints: EndpointEntry[] }>('endpoints.json');
    return this.endpoints.endpoints;
  }

  componentCatalog(): ComponentCatalog {
    this.components ??= loadJson<ComponentCatalog>('components.json');
    return this.components;
  }

  /** ETL 组件目录（独立命名空间；该文件是可选的，缺失时返回空目录而不是崩掉） */
  etlComponentCatalog(): EtlComponentCatalog {
    if (!this.etlComponents) {
      const file = join(CATALOG_DIR, 'etl-components.json');
      this.etlComponents = existsSync(file)
        ? loadJson<EtlComponentCatalog>('etl-components.json')
        : { nodes: [], categories: [] };
    }
    return this.etlComponents;
  }

  /** ETL 组件目录是否可用（ESB-only 部署未安装该文件时为 false） */
  hasEtlCatalog(): boolean {
    return this.etlComponentCatalog().nodes.length > 0;
  }

  etlComponentsByCategory(category?: string): ComponentEntry[] {
    const nodes = this.etlComponentCatalog().nodes;
    return category ? nodes.filter((n) => n.category === category) : nodes;
  }

  /** ETL nodeType 白名单（用于 ETL 流程图校验） */
  etlNodeTypes(): Set<string> {
    return new Set(this.etlComponentCatalog().nodes.map((n) => n.id));
  }

  /** 接口检索：路径/名称/模块，去重按 path */
  searchEndpoints(keyword: string, opts: { module?: string; limit?: number } = {}): EndpointEntry[] {
    const kw = keyword.toLowerCase();
    const seen = new Set<string>();
    const out: EndpointEntry[] = [];
    for (const e of this.endpointsCatalog()) {
      if (opts.module && e.module !== opts.module) continue;
      if (!e.path.toLowerCase().includes(kw) && !e.name.toLowerCase().includes(kw) && !e.module.toLowerCase().includes(kw)) continue;
      if (seen.has(e.path)) continue;
      seen.add(e.path);
      out.push(e);
      if (out.length >= (opts.limit ?? 200)) break;
    }
    return out;
  }

  component(id: string): ComponentEntry | undefined {
    return this.componentCatalog().nodes.find((n) => n.id === id);
  }

  /** 生成前的硬校验依据：nodeType 白名单 */
  nodeTypes(): Set<string> {
    return new Set(this.componentCatalog().nodes.map((n) => n.id));
  }

  /**
   * 必填属性表：nodeType → 必填字段名。
   *
   * 来源有两处：
   * 1. 组件目录 `required` 且**没有可用默认值**的字段（如 `apiNode.apiUrl`）；
   * 2. 启发式规则（SQL/DB 类节点、网关类型）——目录里没有 required 标记，但缺了流程跑不起来。
   *
   * 平台 checkerror 偏松（缺必填属性也放行），这一层是本地唯一的兜底。
   * ETL 组件目录目前没有采集参数（paramSource=unmapped），因此 ETL 只套用启发式规则。
   */
  requiredFields(kind: 'esb' | 'etl' = 'esb'): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    if (kind === 'esb') {
      for (const n of this.componentCatalog().nodes) {
        const req = (n.params ?? [])
          .filter((p) => p.required === true && !META_PARAMS.has(p.key) && !hasUsableDefault(p.initialValue))
          .map((p) => p.key);
        if (req.length) out[n.id] = req;
      }
    }
    for (const [nodeType, fields] of Object.entries(HEURISTIC_REQUIRED)) {
      out[nodeType] = [...new Set([...(out[nodeType] ?? []), ...fields])];
    }
    return out;
  }

  componentsByCategory(category?: string): ComponentEntry[] {
    const nodes = this.componentCatalog().nodes;
    return category ? nodes.filter((n) => n.category === category) : nodes;
  }
}
