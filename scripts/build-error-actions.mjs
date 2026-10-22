#!/usr/bin/env node
/**
 * 错误目录增强（v2 Phase 2.3）
 *
 * 输入：catalog/war/error-catalog.json（712 条平台文案）
 * 输出：
 *   catalog/error-map.json      每条文案 → 分类 + 处置建议（精确匹配）
 *   catalog/error-actions.json  分类/关键词规则（正则匹配，供未知文案兜底）
 *
 * 分类是启发式的，但每条都给出可执行下一步；人工复核后可覆盖。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { BUILTIN_ACTIONS } from '../packages/core/src/error-catalog.ts';

const src = JSON.parse(readFileSync('catalog/war/error-catalog.json', 'utf8'));
const items = src.items ?? [];

const CAP = /^(?:[A-Z]|[a-z]+)/;

function classify(msg) {
  const m = String(msg ?? '').trim();
  const has = (re) => re.test(m);
  if (has(/节点|网关|连线|路由|画布|流程图|开始节点|结束节点|子流程|分支|聚合/)) {
    if (has(/聚合|并行|成对|配对/)) return ['流程图', '检查并行网关是否所有分支都汇入同一个聚合网关，且聚合网关 joinNodeId 指向并行网关'];
    if (has(/没有设置属性|属性|未配置|缺少配置/)) return ['流程图', '先补齐节点属性（rc flow props save），再保存图模型；平台校验会拦截空属性'];
    if (has(/已被删除|不存在|未找到/)) return ['流程图', '节点属性引用了旧图节点：以图模型为准清理孤立属性（rc flow prune-props）'];
    if (has(/环|循环|死循环/)) return ['流程图', '检查回边；只有 timeNode 允许自环，其余环会被平台拒绝'];
    return ['流程图', '用 rc flow validate 做本地校验，再调用平台 checkerror 对比差异'];
  }
  if (has(/数据库|SQL|sql|表|字段|索引|连接池|jdbc|数据源|查询|插入|更新|主键|唯一|约束/)) {
    if (has(/连接|超时|拒绝|refused|timeout/)) return ['数据库', '先用 rc datasource test 验证连通性；检查端口/白名单/账号权限'];
    if (has(/SQL|sql|语法|syntax/)) return ['数据库', '检查 SQL 方言、库名、字段名与引号；用绑定参数替代字符串拼接'];
    if (has(/主键|唯一|重复|duplicate/)) return ['数据库', '确认写入模式（append/upsert）与主键；重复数据先过滤或改用覆盖写'];
    if (has(/表.*不存在|字段.*不存在|no such/)) return ['数据库', '核对源/目标表名与字段名；跨库时确认 schema 前缀'];
    return ['数据库', '用 rc datasource test 与最小 SQL 逐步定位；检查库表权限'];
  }
  if (has(/登录|token|Token|认证|授权|密码|账号|用户|角色|权限|未授权|401|403/)) {
    if (has(/权限|授权|角色/)) return ['权限', '联系平台管理员检查服务角色与权限项'];
    return ['认证', '重新登录或刷新 token；检查 RC_USER/RC_PASS、账号锁定与 token 过期'];
  }
  if (has(/上传|下载|文件|附件|excel|Excel|导入|导出|压缩|解压|sftp|ftp|FTP/)) {
    if (has(/不能为空|不存在|未选择/)) return ['文件', '确认文件存在且已选择；上传用 multipart，字段名通常为 file'];
    if (has(/大小|过大|超时|timeout/)) return ['文件', '检查平台文件大小/超时限制；大文件改用分片或 SFTP'];
    return ['文件', '检查文件路径、编码、表头与平台存储权限'];
  }
  if (has(/定时|cron|Cron|调度|任务|实例|补偿|重试|执行|排队|重复执行|重复产生/)) {
    if (has(/补偿/)) return ['任务调度', '补偿单位是 transactionId（实例 id），用 rc etl compensate-plan 生成计划后再 apply'];
    if (has(/重复|排队|还没有结束/)) return ['任务调度', '等待上一实例结束，或先 stop/查询运行中实例；不要并发触发同一流程'];
    if (has(/cron|定时|表达式/)) return ['调度', '检查 cron 段数与平台格式；先用 rc flow validate 本地校验'];
    return ['任务调度', '用 rc monitor summary / etl 实例列表定位失败实例，再决定重跑或补偿'];
  }
  if (has(/连接器|OAuth|oauth|回调|第三方|微信|钉钉|企业微信|飞书|sap|SAP/)) {
    return ['连接器', '用 rc connector apps / configs 检查配置；OAuth 需确认回调地址与授权码有效期'];
  }
  if (has(/API|接口|服务|路径|mapUrl|请求|响应|状态码|http|HTTP/)) {
    if (has(/重复|已存在/)) return ['API 资产', '同一方法+路径只能有一个服务；先 rc api list 查重，再决定覆盖或改名'];
    if (has(/未发布|下线/)) return ['API 资产', '先发布 API 再调用；检查应用状态与网关路由'];
    return ['API 资产', '用 rc api get 查看完整定义；核对 method/path/参数/认证与后端地址'];
  }
  if (has(/JSON|json|解析|格式|转换|编码|XML|xml|报文/)) {
    return ['数据格式', '检查 JSON/XML 是否合法；字符串字段需要二次 JSON 编码；用最小样例复现'];
  }
  if (has(/参数|不能为空|必填|长度|格式不正确|非法/)) {
    return ['参数校验', '检查必填 body/query 字段与类型；命令签名见 docs/COMMAND-REFERENCE.md'];
  }
  if (has(/审批/)) {
    return ['审批', '检查审批流配置、审批人是否有效；确认审批流配置、审批人与审批状态'];
  }
  if (has(/MQ|消息|队列|kafka|rabbit|rocket|jms/i)) {
    return ['消息', '检查 topic/group/ broker 连通性与消费位点；确认消息格式与重试策略'];
  }
  if (has(/缓存|Redis|redis/)) {
    return ['缓存', '检查缓存连接与 key 前缀；必要时清理缓存后重试'];
  }
  if (has(/编译|代码|脚本|class|Class|java|Java/)) {
    return ['代码/脚本', '检查脚本语法、依赖与沙箱限制；用最小脚本复现并查看平台日志'];
  }
  if (has(/元数据|主数据|数据模型|模型不存在/)) {
    return ['数据模型', '刷新元数据/模型缓存；确认模型已发布且字段映射存在'];
  }
  if (has(/不存在|未找到|已被删除|已删除|没有找到/)) {
    return ['资源不存在', '确认 id/名称是否正确；刷新列表；平台对不存在资源有时返回 500 而非 404'];
  }
  if (has(/已存在|重复|冲突/)) {
    return ['资源冲突', '先查询查重；改用唯一编码/名称，或复用既有对象'];
  }
  if (has(/不支持|未实现|not support|版本/)) {
    return ['平台能力', '查 catalog/war/endpoints.json 确认当前版本是否提供；必要时降级为手工步骤'];
  }
  if (has(/网络|连接|超时|timeout|Connection|refused|host|DNS/)) {
    return ['网络', '检查 VPN/防火墙/端口与目标地址；内网目标需在平台侧可达'];
  }
  return ['平台错误', '按 HTTP 状态与 traceId 排查；把该文案补充到 catalog/error-actions.json'];
}

function actionFor(msg, category) {
  // 更细的处置：按关键词覆盖分类默认值
  const m = String(msg);
  if (/不能与.*重复|编码重复|名称已存在|已存在/.test(m)) return '换一个唯一编码/名称，或先按名称查询并复用既有对象';
  if (/不能为空|必填/.test(m)) return '补齐必填字段后重试；CLI 参数缺失会直接报 E_VALIDATION';
  if (/超时|timeout/i.test(m)) return '检查目标可达性与超时配置；必要时增大 timeout 或改为异步';
  if (/不支持|未实现/.test(m)) return '确认平台版本与端点目录；该能力可能只在更高版本提供';
  if (/请先|必须先|需要先/.test(m)) return '按提示完成前置步骤（发布/授权/选择应用/上传文件）';
  if (category === '流程图') return '用 rc flow validate 定位节点/连线问题，修正后再保存';
  if (category === '数据库') return '用 rc datasource test 验证连接，再用最小 SQL 复现';
  if (category === '认证') return '重新登录或刷新 token；检查账号状态与目标环境';
  if (category === '权限') return '联系平台管理员检查服务角色与权限项';
  if (category === '文件') return '确认文件存在、大小与路径权限；必要时改用 SFTP';
  if (category === '任务调度') return '先查运行实例与补偿记录，再决定重跑/补偿';
  if (category === '连接器') return '检查连接器配置、OAuth 回调与网络可达性';
  if (category === 'API 资产') return '用 rc api list/get 核对服务定义与发布状态';
  if (category === '数据格式') return '用最小 JSON/XML 样例校验格式与编码';
  if (category === '参数校验') return '核对必填字段、类型与长度；参考命令帮助';
  if (category === '资源不存在') return '确认 id/名称并刷新列表；平台有时用 500 表示资源不存在';
  if (category === '资源冲突') return '先查询查重，改用唯一编码/名称';
  if (category === '审批') return '检查审批流与审批人；确认审批流配置与审批状态';
  if (category === '消息') return '检查 topic/group/broker 与消费位点';
  if (category === '缓存') return '检查缓存连接与 key，清理后重试';
  if (category === '代码/脚本') return '检查脚本语法与沙箱限制，用最小脚本复现';
  if (category === '数据模型') return '刷新元数据/模型缓存，确认模型已发布';
  return '按 traceId 查平台日志；补充该文案到错误目录';
}

const map = items.map((x) => {
  const [category] = classify(x.msg);
  return { msg: x.msg, category, action: actionFor(x.msg, category), classes: x.classes };
});

const grouped = new Map();
for (const x of map) {
  if (!grouped.has(x.category)) grouped.set(x.category, []);
  grouped.get(x.category).push(x);
}

const categoryActions = [
  { pattern: '节点.*(没有设置属性|属性.*(为空|缺失))|缺少.*节点.*属性', category: '流程图', action: '先补齐节点属性（rc flow props save），再保存图模型' },
  { pattern: '并行网关.*(聚合|成对|配对)|聚合网关.*(缺少|不存在)', category: '流程图', action: '所有并行分支必须汇入同一个聚合网关，且 joinNodeId 指向并行网关' },
  { pattern: '图形已被删除|节点.*已被删除|不存在.*节点', category: '流程图', action: '清理孤立节点属性（rc flow prune-props），以图模型为准' },
  { pattern: '流程编码已存在|流程名称已存在', category: '流程生命周期', action: '换唯一编码/名称，或复用既有流程' },
  { pattern: 'SQL|sql|数据库.*(连接|超时)|表.*不存在|字段.*不存在', category: '数据库', action: '用 rc datasource test 验证连接；核对表/字段与 SQL 方言' },
  { pattern: '登录|token|认证|未授权|401|403', category: '认证', action: '重新登录/刷新 token；检查账号与目标环境' },
  { pattern: '权限|没有.*访问|无权限', category: '权限', action: '联系平台管理员检查服务角色与权限项' },
  { pattern: '上传|下载|文件.*(为空|过大|超时)|sftp|ftp', category: '文件', action: '确认文件存在、大小与路径权限；大文件改用 SFTP' },
  { pattern: '重复执行|重复产生|还没有结束|排队', category: '任务调度', action: '等待上一实例结束或先停止；不要并发触发同一流程' },
  { pattern: '待补偿|补偿', category: '任务调度', action: '用 rc etl compensate-plan 按 transactionId 生成计划，再 apply' },
  { pattern: '定时|cron|调度.*(失败|错误)', category: '调度', action: '检查 cron 格式与平台时区；先用 rc flow validate' },
  { pattern: 'JSON|json|解析|格式|编码|XML|xml', category: '数据格式', action: '用最小样例校验 JSON/XML 格式与编码' },
  { pattern: '不能为空|必填|参数.*(错误|非法)|长度', category: '参数校验', action: '补齐必填字段并检查类型/长度' },
  { pattern: '连接器|OAuth|oauth|回调|第三方', category: '连接器', action: '检查连接器配置、OAuth 回调与网络可达性' },
  { pattern: '不存在|未找到|已被删除|没有找到', category: '资源不存在', action: '确认 id/名称并刷新列表；平台有时用 500 表示资源不存在' },
  { pattern: '已存在|重复|冲突', category: '资源冲突', action: '先查询查重，改用唯一编码/名称' },
  { pattern: '审批', category: '审批', action: '检查审批流与审批人；确认审批流配置与审批状态' },
  { pattern: 'MQ|消息|队列|kafka|rabbit|rocket|jms', category: '消息', action: '检查 topic/group/broker 与消费位点' },
  { pattern: '缓存|Redis|redis', category: '缓存', action: '检查缓存连接与 key，清理后重试' },
  { pattern: '编译|代码|脚本|class|java', category: '代码/脚本', action: '检查脚本语法与沙箱限制，用最小脚本复现' },
  { pattern: '元数据|主数据|数据模型|模型不存在', category: '数据模型', action: '刷新元数据/模型缓存，确认模型已发布' },
  { pattern: '不支持|未实现|not support', category: '平台能力', action: '查端点目录确认版本；必要时降级手工步骤' },
];

const actions = [...BUILTIN_ACTIONS, ...categoryActions].map((x) => ({
  pattern: x.pattern,
  category: x.category,
  action: x.action,
  ...(x.doc ? { doc: x.doc } : {}),
}));

writeFileSync('catalog/error-map.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  version: 1,
  source: 'catalog/war/error-catalog.json',
  total: map.length,
  categories: Object.fromEntries([...grouped.entries()].map(([k, v]) => [k, v.length])),
  items: map,
}, null, 1) + '\n');

writeFileSync('catalog/error-actions.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  version: 1,
  source: 'catalog/war/error-catalog.json + 人工规则',
  note: '精确匹配见 error-map.json；本文件是正则兜底规则',
  actions,
}, null, 1) + '\n');

console.log(`错误映射：${map.length} 条，分类 ${grouped.size} 个，规则 ${actions.length} 条`);
console.log(Object.entries(Object.fromEntries([...grouped.entries()].map(([k, v]) => [k, v.length]))).map(([k, v]) => `${k}=${v}`).join('，'));
