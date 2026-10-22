/**
 * 错误目录（v2 Phase 2.3）
 *
 * 平台有 712 条中文错误文案，但只给出"是什么"，不给出"怎么办"。
 * 本模块把错误文案映射到：分类 + 可执行修复步骤。
 * 匹配顺序：精确映射（error-map.json）→ 包含映射 → 关键词规则（error-actions.json）→ HTTP 兜底。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = join(here, '..', '..', '..', 'catalog');

export interface ErrorItem {
  msg: string;
  classes?: string[];
}

export interface ErrorAction {
  pattern: string;
  category: string;
  action: string;
  /** 可选：相关文档 */
  doc?: string;
}

export interface ErrorExplain {
  matched: boolean;
  message: string;
  category: string;
  action: string;
  doc?: string;
  classes?: string[];
  /** 同族错误（包含关系） */
  related?: string[];
}

interface RawErrorCatalog {
  count?: number;
  items: ErrorItem[];
}

interface ActionCatalog {
  generatedAt?: string;
  actions: ErrorAction[];
}

export interface ErrorMapItem {
  msg: string;
  category: string;
  action: string;
  classes?: string[];
}

interface ErrorMapCatalog {
  generatedAt?: string;
  total?: number;
  items: ErrorMapItem[];
}

let _messages: ErrorItem[] | undefined;
let _actions: ErrorAction[] | undefined;
let _map: ErrorMapItem[] | undefined;

function loadJson<T>(file: string): T | undefined {
  const p = join(CATALOG_DIR, file);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** 内置兜底规则：即使没有生成 catalog/error-actions.json 也能工作 */
export const BUILTIN_ACTIONS: ErrorAction[] = [
  { pattern: '节点.*没有设置属性', category: '流程图', action: '先执行 rc flow props save 或 rc flow save 补齐节点属性；属性缺失会被平台校验拦截', doc: 'docs/FLOW-JSON-SPEC.md §16' },
  { pattern: '并行网关和聚合网关没有成对', category: '流程图', action: '并行分支必须有且仅有一个聚合网关（gateWay），且 joinNodeId 指向并行网关', doc: 'docs/FLOW-JSON-SPEC.md §9' },
  { pattern: '图形已被删除', category: '流程图', action: '节点属性引用了旧图节点：以图模型为准清理孤立属性（rc flow prune-props）' },
  { pattern: '流程编码已存在', category: '流程生命周期', action: 'createFlow 会自动生成唯一 configId；重试时不要复用上一次的 configId' },
  { pattern: '流程名称已存在', category: '流程生命周期', action: '换一个流程名称，或先按名称查询并复用既有流程' },
  { pattern: 'mapUrl.*已存在|接口路径.*已存在', category: 'API 资产', action: '先 GET /rest/core/services 查重；导入时用 import-mode=skip 或改名' },
  { pattern: '不能为空', category: '参数校验', action: '检查必填 body/query 字段；本工具的命令签名见 docs/COMMAND-REFERENCE.md' },
  { pattern: '上传文件不能为空|文件大小|文件过大', category: '文件', action: '确认文件存在且小于平台限制；上传用 multipart，字段名 file' },
  { pattern: '登录|token|未授权|认证|401|403', category: '认证', action: '重新登录或刷新 token；检查 RC_USER/RC_PASS 与账号锁定状态' },
  { pattern: '权限|没有.*访问|无权限', category: '权限', action: '联系平台管理员检查角色与权限项' },
  { pattern: '连接.*失败|Connection refused|timeout|超时', category: '网络/数据源', action: '先用 datasource test 验证连通性；内网目标需 VPN，检查端口/白名单' },
  { pattern: 'SQL|sql|语法', category: '数据库', action: '检查 SQL 方言、库名、字段名；用 datasource test 验证连接与权限' },
  { pattern: '重复执行|重复产生任务|还没有结束', category: '任务调度', action: '等待上一实例结束，或先 stop/查询运行中实例；不要并发触发同一流程' },
  { pattern: '待补偿|补偿', category: '任务调度', action: '用 etl compensate 按 transactionId 重跑；先 plan 再 apply' },
  { pattern: 'JSON|json|解析|格式', category: '数据格式', action: '检查请求体/节点属性是否为合法 JSON；字符串字段需要二次 JSON 编码' },
  { pattern: '不支持|未实现|not support', category: '平台能力', action: '查 catalog/war/endpoints.json 确认平台版本是否提供该能力；必要时降级为手工步骤' },
  { pattern: '定时|cron|表达式', category: '调度', action: 'cron 使用平台支持的 6/7 段格式；先用 flow validate 本地校验' },
];

function loadActions(): ErrorAction[] {
  if (_actions) return _actions;
  const raw = loadJson<ActionCatalog>('error-actions.json');
  _actions = [...BUILTIN_ACTIONS, ...(raw?.actions ?? [])];
  return _actions;
}

export function loadErrorMessages(): ErrorItem[] {
  if (_messages) return _messages;
  const raw = loadJson<RawErrorCatalog>('war/error-catalog.json');
  _messages = raw?.items ?? [];
  return _messages;
}

export function listErrorActions(): ErrorAction[] {
  return [...loadActions()];
}

/** 712 条平台文案的精确映射（catalog/error-map.json） */
export function loadErrorMap(): ErrorMapItem[] {
  if (_map) return _map;
  const raw = loadJson<ErrorMapCatalog>('error-map.json');
  _map = raw?.items ?? [];
  return _map;
}

export function listErrorMap(): ErrorMapItem[] {
  return [...loadErrorMap()];
}

const GENERIC_MESSAGES = new Set([
  '失败', '错误', '异常', '不存在', '不存在!', '不存在.', '不存在:', '保存失败', '创建失败',
  '删除失败', '修改失败', '查询失败', '加载失败', '初始化失败', '发布失败', '更新失败',
  '操作失败', '执行失败', '处理失败', '校验失败', '未知错误',
]);

/** 精确匹配平台错误文案 → 修复建议 */
export function explainError(message: string): ErrorExplain {
  const msg = String(message ?? '').trim();
  if (!msg) {
    return { matched: false, message: msg, category: '未知', action: '响应没有错误文案；用 --json 查看 traceId 并在平台日志中检索' };
  }
  const messages = loadErrorMessages();
  const exact = messages.find((m) => m.msg === msg);
  const map = loadErrorMap();

  // 1) 精确映射（712 条人工/生成映射优先于通用规则）
  const exactMap = map.find((m) => m.msg === msg);
  if (exactMap) {
    const related = messages
      .filter((m) => m.msg !== msg && m.msg.length >= 4 && (m.msg.includes(msg) || msg.includes(m.msg)))
      .slice(0, 5)
      .map((m) => m.msg);
    return {
      matched: true,
      message: msg,
      category: exactMap.category,
      action: exactMap.action,
      classes: exactMap.classes ?? exact?.classes,
      related,
    };
  }

  // 2) 包含映射（用最长、非通用文案做同族匹配，避免“失败”吞掉所有错误）
  const contains = map
    .filter((m) => m.msg.length >= 6 && !GENERIC_MESSAGES.has(m.msg) && (msg.includes(m.msg) || m.msg.includes(msg)))
    .sort((a, b) => b.msg.length - a.msg.length)[0];
  if (contains) {
    return {
      matched: true,
      message: msg,
      category: contains.category,
      action: contains.action,
      classes: contains.classes ?? exact?.classes,
      related: [contains.msg],
    };
  }

  // 3) 关键词规则
  const actions = loadActions();
  for (const a of actions) {
    let re: RegExp;
    try {
      re = new RegExp(a.pattern, 'i');
    } catch {
      continue;
    }
    if (re.test(msg)) {
      const related = exact ? messages.filter((m) => m.msg !== msg && (m.msg.includes(msg) || msg.includes(m.msg))).slice(0, 5).map((m) => m.msg) : [];
      return {
        matched: true,
        message: msg,
        category: a.category,
        action: a.action,
        doc: a.doc,
        classes: exact?.classes,
        related,
      };
    }
  }

  // 4) 未收录
  return {
    matched: false,
    message: msg,
    category: '未收录',
    action: '该文案不在错误目录中：先按 HTTP 状态与 traceId 排查；欢迎把它补充到 catalog/error-actions.json',
    classes: exact?.classes,
  };
}

/** HTTP 层兜底解释 */
export function explainHttpError(status: number, message?: string, traceId?: string): ErrorExplain {
  const base = explainError(message ?? '');
  const trace = traceId ? `；traceId=${traceId}（可提供给平台方定位）` : '';
  if (status === 401 || status === 403) {
    return { ...base, matched: true, category: '认证', action: `重新登录/刷新 token，检查账号权限${trace}` };
  }
  if (status === 404) return { ...base, matched: true, category: '资源不存在', action: `确认 id/路径；平台对不存在的资源常返回 500 而非 404${trace}` };
  if (status === 429) return { ...base, matched: true, category: '限流', action: `降低并发或稍后重试${trace}` };
  if (status >= 500) return { ...base, matched: true, category: base.category === '未收录' || base.category === '平台错误' ? '平台内部错误' : base.category, action: `${base.action}${trace}` };
  return base;
}

/** 供 CLI 输出：错误 + 建议的多行文本 */
export function formatExplain(e: ErrorExplain): string {
  const lines = [`错误：${e.message || '(无文案)'}`, `分类：${e.category}`];
  if (e.classes?.length) lines.push(`来源：${e.classes.join(', ')}`);
  lines.push(`建议：${e.action}`);
  if (e.doc) lines.push(`文档：${e.doc}`);
  if (e.related?.length) lines.push(`相关：${e.related.join(' / ')}`);
  return lines.join('\n');
}
