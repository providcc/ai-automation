#!/usr/bin/env node
/**
 * 标准编排模板库（v2 Phase 1.5）：29 个模式，全部通过 validateFlow
 * 输出：
 *   catalog/flow-templates/<id>.json  processModel + 属性建议
 *   catalog/flow-templates/index.json 模板索引
 *
 * 节点 key 由 prefixFor/nextId 统一分配，避免手工编号错位。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { buildProcessModel, nextId, prefixFor } from '../packages/core/src/flow-build.ts';
import { validateFlow, hasBlockingError } from '../packages/core/src/flow-validate.ts';

const catalog = JSON.parse(readFileSync('catalog/components.json', 'utf8'));
const knownTypes = new Set(catalog.nodes.map((n) => n.id));

/**
 * 模板定义：
 *   nodes: [{ type, text, props? }]
 *   edges: [[fromIndex, toIndex, assertCondition?, label?]]
 * 索引从 0 开始，生成时转成真实 key。
 */
const templates = [
  {
    id: 'sync-api', name: '同步 API 编排', category: 'API 集成',
    desc: '取数 → 字段映射 → 返回：最常见的同步接口编排',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'apiNode', text: '调用上游', props: { methodType: 'POST', connectTimeout: '10', retryNum: '2' } },
      { type: 'dataMapNode', text: '字段映射', props: { mappingType: '1' } },
      { type: 'returnDataNode', text: '返回结果' },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'async-callback', name: '异步回调编排', category: '异步',
    desc: '提交下游 → 等待回执 → 成功/超时转人工',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'apiNode', text: '提交入账', props: { methodType: 'POST', asyncFlag: '1', connectTimeout: '10' } },
      { type: 'asyncCallbackNode', text: '等待回执', props: { timeout: '3600' } },
      { type: 'manualConfirmNode', text: '人工核实' },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 4, '$.result==1', '成功'], [2, 3, '6', '超时/失败'], [3, 4]],
  },
  {
    id: 'split-call-api', name: '拆分循环调 API', category: '数据同步',
    desc: '按单据拆分 → 逐条调用网关注册的 API（最常见的同步场景；apiUrl/apiId/requestBody 写法见 docs/FLOW-JSON-SPEC.md）',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'dataSplitNode', text: '按单据拆分', props: { dataFieldId: '$.data', second: '1' } },
      { type: 'apiNode', text: '调用网关注册 API', props: {
        // apiUrl = 网关地址 + mapUrl；apiId 指向网关注册的 API（两者都要给）
        apiUrl: '${#config.apiserver}/your/mapUrl',
        apiId: 'REPLACE_WITH_REGISTERED_API_ID',
        methodType: 'POST',
        requestBodyAuto: '0',
        requestBody: '{"id":"${id}","name":"${name}"}',
        connectTimeout: '10', retryNum: '1',
      } },
      { type: 'dataMapNode', text: '结果映射', props: { mappingType: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'split-call-api-writeback', name: '拆分调用 API 回写', category: '数据同步',
    desc: '按单据拆分 → 先把当前行存进全局变量 → 调网关注册的 API → 回写结果（apiNode 会替换当前数据流，变量引用写法见 docs/FLOW-JSON-SPEC.md）',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'dataSplitNode', text: '按单据拆分', props: { dataFieldId: '$.data', second: '1' } },
      // 必须放在 apiNode 之前：apiNode 会替换当前数据流，不先存住就取不回原始行了。
      { type: 'variableRuleNode', text: '保存当前行到全局变量', props: {
        gobalParams: '1',
        condition: 'function(indoc){\n  // TODO: 按业务改写；返回值写入全局变量 currentRow\n  return indoc;\n}',
        tableColumns: '[{"name":"currentRow"}]',
      } },
      { type: 'apiNode', text: '调用网关注册 API', props: {
        // apiUrl = 网关地址 + mapUrl；apiId 指向网关注册的 API（两者都要给）
        apiUrl: '${#config.apiserver}/your/mapUrl',
        apiId: 'REPLACE_WITH_REGISTERED_API_ID',
        methodType: 'POST',
        requestBodyAuto: '0',
        requestBody: '{"id":"${id}","name":"${name}"}',
        connectTimeout: '10', retryNum: '1',
      } },
      { type: 'jdbcWriteNode', text: '回写结果', props: {
        dbConnId: 'REPLACE_WITH_DB_CONN_ID',
        tableName: 'REPLACE_WITH_TARGET_TABLE',
        appendFlag: '1',
        copyData: '1',
      } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]],
  },
  {
    id: 'batch-sync', name: '批量同步', category: '数据同步',
    desc: '增量读取 → 按单据拆分 → 子流程处理 → 批量落库',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'tableReadNode', text: '增量读取', props: { pageReadDataFlag: '1' } },
      { type: 'dataSplitNode', text: '按单据拆分' },
      { type: 'subProcessNode', text: '单组处理', props: { subProcessId: 'SUB_PLACEHOLDER', inDataFlag: '1', outDataFlag: '1', responseData: '1' } },
      { type: 'jdbcWriteNode', text: '批量落库', props: { appendFlag: '1', copyData: '0' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]],
  },
  {
    id: 'event-driven', name: '事件驱动', category: '消息',
    desc: 'Kafka 消费 → 清洗 → 异步入账',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'kafkaNode', text: '消费事件', props: { groupId: 'rc-consumer', topic: 'rc-events' } },
      { type: 'dataTransformNode', text: '数据清洗' },
      { type: 'asyncQueueNode', text: '异步入账', props: { queueName: 'rc-accounting' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'rule-routing', name: '规则路由', category: '规则',
    desc: '读规则 → 按规则分流到不同子流程',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'variableRuleNode', text: '读取记账规则', props: { ruleId: 'RULE_PLACEHOLDER' } },
      { type: 'subProcessNode', text: '规则 A 实现', props: { subProcessId: 'SUB_RULE_A', inDataFlag: '0', outDataFlag: '0', responseData: '1' } },
      { type: 'subProcessNode', text: '规则 B 实现', props: { subProcessId: 'SUB_RULE_B', inDataFlag: '0', outDataFlag: '0', responseData: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2, '$.rule==A', '规则A'], [1, 3, '6', '默认/规则B'], [2, 4], [3, 4]],
  },
  {
    id: 'api-to-db', name: 'API 落库', category: 'API 集成',
    desc: '调用 API → 字段映射 → 写入数据库',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'apiNode', text: '调用 API', props: { methodType: 'GET', connectTimeout: '10', retryNum: '2' } },
      { type: 'dataMapNode', text: '字段映射' },
      { type: 'jdbcWriteNode', text: '写入数据库', props: { appendFlag: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'db-to-api', name: '数据库推送 API', category: 'API 集成',
    desc: 'SQL 查询 → 数据清洗 → 推送 API',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'sqlExecuterNode', text: '查询数据', props: { pageReadDataFlag: '1' } },
      { type: 'dataTransformNode', text: '数据清洗' },
      { type: 'apiNode', text: '推送 API', props: { methodType: 'POST', connectTimeout: '10', retryNum: '2' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'file-to-db', name: '文件入库', category: '文件',
    desc: '读取 SFTP 文件 → 解析 → 写入数据库',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'sftpReadNode', text: '读取 SFTP 文件', props: { filePath: '/data/in/*.csv' } },
      { type: 'dataTransformNode', text: '解析/清洗' },
      { type: 'jdbcWriteNode', text: '写入数据库', props: { appendFlag: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'db-to-file', name: '数据库导出文件', category: '文件',
    desc: '查询数据库 → 生成文件 → 上传 SFTP',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'sqlExecuterNode', text: '查询数据', props: { pageReadDataFlag: '1' } },
      { type: 'dataTransformNode', text: '格式转换' },
      { type: 'sftpUploadNode', text: '上传文件', props: { filePath: '/data/out/export.csv' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'fanout-aggregate', name: '并行扇出/聚合', category: '并行',
    desc: '并行调用两个下游 → 聚合网关汇合 → 返回',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'gateWay', text: '并行网关', props: { gatewayType: '2' } },
      { type: 'apiNode', text: '并行调用 A', props: { methodType: 'GET', connectTimeout: '10', retryNum: '1' } },
      { type: 'apiNode', text: '并行调用 B', props: { methodType: 'GET', connectTimeout: '10', retryNum: '1' } },
      { type: 'gateWay', text: '聚合网关', props: { gatewayType: '2' } },
      { type: 'returnDataNode', text: '返回结果' },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [1, 3], [2, 4], [3, 4], [4, 5], [5, 6]],
  },
  {
    id: 'retry-compensate', name: '重试与补偿', category: '可靠性',
    desc: '外部调用重试 → 失败补偿标记 → 落库',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'apiNode', text: '调用外部系统', props: { methodType: 'POST', connectTimeout: '10', retryNum: '3', retrySleep: '2', exceptionAssert: '1' } },
      { type: 'dataFilterNode', text: '过滤失败数据' },
      { type: 'jdbcWriteNode', text: '写入补偿表', props: { appendFlag: '1', compensateFlag: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'scheduled-sync', name: '定时同步', category: '调度',
    desc: '每天定时读取 → 写入目标表',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'timeNode', text: '每天 02:00', props: { cron: '0 0 2 * * ?' } },
      { type: 'tableReadNode', text: '读取源表', props: { pageReadDataFlag: '1' } },
      { type: 'jdbcWriteNode', text: '写入目标表', props: { appendFlag: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'message-queue', name: '消息队列消费', category: '消息',
    desc: 'RocketMQ 消费 → 过滤 → 入库',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'rocketMQNode', text: '消费 RocketMQ', props: { topic: 'rc-topic', groupId: 'rc-group' } },
      { type: 'dataFilterNode', text: '过滤无效消息' },
      { type: 'jdbcWriteNode', text: '消息入库', props: { appendFlag: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'webhook-receiver', name: 'Webhook 接收', category: 'API 集成',
    desc: '接收外部 Webhook → 映射 → 落库',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'apiNode', text: '接收 Webhook', props: { methodType: 'POST', responseData: '1' } },
      { type: 'dataMapNode', text: '字段映射' },
      { type: 'jdbcWriteNode', text: '写入数据库', props: { appendFlag: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'subprocess-orchestration', name: '子流程编排', category: '编排',
    desc: '主流程串联两个子流程',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'subProcessNode', text: '子流程 A', props: { subProcessId: 'SUB_A', inDataFlag: '1', outDataFlag: '1', responseData: '1' } },
      { type: 'subProcessNode', text: '子流程 B', props: { subProcessId: 'SUB_B', inDataFlag: '1', outDataFlag: '1', responseData: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3]],
  },
  {
    id: 'data-mapping', name: '格式转换', category: '数据处理',
    desc: 'XML → JSON → 字段映射 → XML',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'apiNode', text: '获取 XML', props: { methodType: 'GET', connectTimeout: '10' } },
      { type: 'xml2jsonNode', text: 'XML 转 JSON' },
      { type: 'dataMapNode', text: '字段映射' },
      { type: 'json2xmlNode', text: 'JSON 转 XML' },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]],
  },
  {
    id: 'error-handler', name: '错误分支处理', category: '可靠性',
    desc: '主调用成功走结束，失败发消息告警',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'apiNode', text: '调用外部系统', props: { methodType: 'POST', connectTimeout: '10', retryNum: '2' } },
      { type: 'msgNode', text: '发送告警', props: { msgType: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2, '$.code!=200', '失败'], [1, 3, '6', '成功/默认'], [2, 3]],
  },
  {
    id: 'idempotent-upsert', name: '幂等 Upsert', category: '可靠性',
    desc: '外部调用 → 过滤重复 → 幂等写入',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'apiNode', text: '获取数据', props: { methodType: 'GET', connectTimeout: '10' } },
      { type: 'dataFilterNode', text: '过滤已存在数据' },
      { type: 'jdbcWriteNode', text: 'Upsert 写入', props: { appendFlag: '0', copyData: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'multi-source-merge', name: '多源合并', category: '数据处理',
    desc: '并行读取两个数据源 → 聚合 → 合并落库',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'gateWay', text: '并行读取', props: { gatewayType: '2' } },
      { type: 'tableReadNode', text: '读取源 A', props: { pageReadDataFlag: '1' } },
      { type: 'tableReadNode', text: '读取源 B', props: { pageReadDataFlag: '1' } },
      { type: 'gateWay', text: '聚合', props: { gatewayType: '2' } },
      { type: 'dataMergeNode', text: '合并数据' },
      { type: 'jdbcWriteNode', text: '写入目标', props: { appendFlag: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [1, 3], [2, 4], [3, 4], [4, 5], [5, 6], [6, 7]],
  },
  {
    id: 'approval-flow', name: '人工审批', category: '人工',
    desc: '提交审批 → 人工确认 → 通过/驳回分支',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'apiNode', text: '提交审批', props: { methodType: 'POST', connectTimeout: '10' } },
      { type: 'manualConfirmNode', text: '人工审批' },
      { type: 'msgNode', text: '通知驳回', props: { msgType: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3, '$.approved==false', '驳回'], [2, 4, '6', '通过/默认'], [3, 4]],
  },
  {
    id: 'cache-refresh', name: '缓存刷新', category: '调度',
    desc: '定时拉取配置 → 映射 → 刷新缓存',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'timeNode', text: '每小时刷新', props: { cron: '0 0 * * * ?' } },
      { type: 'apiNode', text: '拉取最新配置', props: { methodType: 'GET', connectTimeout: '10', retryNum: '1' } },
      { type: 'dataMapNode', text: '整理缓存结构' },
      { type: 'variableRuleNode', text: '刷新共享变量', props: { action: 'set' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]],
  },
  {
    id: 'audit-log', name: '审计留痕', category: '可观测',
    desc: '调用后写审计表（请求/响应摘要）',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'apiNode', text: '业务调用', props: { methodType: 'POST', connectTimeout: '10', retryNum: '2' } },
      { type: 'dataTransformNode', text: '整理审计字段' },
      { type: 'jdbcWriteNode', text: '写审计表', props: { appendFlag: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'pagination-sync', name: '分页同步', category: '数据同步',
    desc: '分页读取大表 → 批量写入',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'tableReadNode', text: '分页读取', props: { pageReadDataFlag: '1', pageSize: '500' } },
      { type: 'jdbcWriteNode', text: '批量写入', props: { appendFlag: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3]],
  },
  {
    id: 'dead-letter', name: '死信处理', category: '消息',
    desc: '消费消息 → 成功入库 / 失败转死信队列',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'kafkaNode', text: '消费消息', props: { topic: 'rc-events', groupId: 'rc-group' } },
      { type: 'jdbcWriteNode', text: '业务入库', props: { appendFlag: '1' } },
      { type: 'msgNode', text: '发送死信', props: { msgType: '1' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 3, '$.success==false', '失败'], [1, 2, '6', '成功/默认'], [2, 4], [3, 4]],
  },
  {
    id: 'sftp-to-api', name: '文件转 API', category: '文件',
    desc: '读取 SFTP 文件 → 映射 → 调用 API',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'sftpReadNode', text: '读取文件', props: { filePath: '/data/in/*.csv' } },
      { type: 'dataMapNode', text: '字段映射' },
      { type: 'apiNode', text: '推送 API', props: { methodType: 'POST', connectTimeout: '10', retryNum: '2' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'api-to-file', name: 'API 转文件', category: '文件',
    desc: '调用 API → 映射 → 上传 SFTP',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'apiNode', text: '调用 API', props: { methodType: 'GET', connectTimeout: '10', retryNum: '2' } },
      { type: 'dataTransformNode', text: '整理文件数据' },
      { type: 'sftpUploadNode', text: '上传文件', props: { filePath: '/data/out/export.csv' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    id: 'compensate-notify', name: '补偿通知', category: '可靠性',
    desc: '读取待补偿记录 → 通知责任人 → 标记处理',
    nodes: [
      { type: 'start', text: '开始' },
      { type: 'tableReadNode', text: '读取待补偿记录' },
      { type: 'msgNode', text: '通知责任人', props: { msgType: '1' } },
      { type: 'jdbcWriteNode', text: '标记已通知', props: { appendFlag: '0' } },
      { type: 'end', text: '结束' },
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
];

const CONDITION_CODES = new Set(['0', '1', '2', '3', '6', '7', '10']);

/** 把模板里的简化表达式（$.x==1 / $.x!=null / $.x==A）变成平台 router 属性 */
function routerConditionProps(expr) {
  const text = String(expr ?? '').trim();
  if (!text) return {};
  if (CONDITION_CODES.has(text)) {
    return { assertCondition: text, assertionCodeType: '', assertionCondition: '', condition: '', routerCondition: '' };
  }
  const m = text.match(/^\$\.([A-Za-z_][\w.]*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!m) {
    return {
      assertCondition: '3', assertionCodeType: '0', assertionCondition: '', routerCondition: '',
      condition: 'function assert(engine,nodeDoc,nodeId,indoc){\n  return 0;// TODO: 模板占位条件，请按业务字段改写\n}',
    };
  }
  const field = m[1];
  const op = m[2];
  let raw = m[3].trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1);
  const value = raw === 'null' ? null : raw;
  const fieldId = `$.indoc.${field}`;
  const rule = { id: `rc_${field.replace(/\W/g, '_')}_${op.replace(/\W/g, '')}`, group: false, fieldId, operator: op, ...(value === null ? {} : { compareValue: value }) };
  const rhs = value === null ? 'null' : op === '==' || op === '!=' ? (String(value) === 'true' || String(value) === 'false' || /^-?\d+(\.\d+)?$/.test(String(value)) ? String(value) : JSON.stringify(String(value))) : JSON.stringify(String(value));
  const condition = `function assert(engine,nodeDoc,nodeId,indoc){\n  if( indoc.get("${field}") ${op} ${rhs} ){\n    return 1;// 断言成立\n  }\n  return 0;// 断言失败\n}`;
  return {
    assertCondition: '3',
    assertionCodeType: '0',
    assertionCondition: JSON.stringify([rule]),
    condition,
    routerCondition: '',
  };
}

await mkdir('catalog/flow-templates', { recursive: true });
let failed = 0;
const index = [];
for (const t of templates) {
  const used = new Set();
  const nodes = t.nodes.map((n) => {
    const key = nextId(prefixFor(n.type), used);
    used.add(key);
    return { key, nodeType: n.type, text: n.text, nodeName: n.text, props: n.props };
  });
  const edgeExprs = t.edges.map(([, , cond]) => cond);
  const edges = t.edges.map(([from, to, cond, label]) => ({
    from: nodes[from].key,
    to: nodes[to].key,
    assertCondition: cond === undefined ? '0' : CONDITION_CODES.has(String(cond)) ? String(cond) : '3',
    ...(label ? { label } : {}),
  }));
  // 并行网关：给聚合网关补 joinNodeId
  const parallel = nodes.filter((n) => n.nodeType === 'gateWay' && String(n.props?.gatewayType ?? '2') === '2');
  const aggregates = nodes.filter((n) => n.nodeType === 'gateWay' && String(n.props?.gatewayType ?? '2') === '2' && n !== parallel[0]);
  if (parallel.length && aggregates.length && !aggregates[0].props?.joinNodeId) {
    aggregates[0].props = { ...(aggregates[0].props ?? {}), joinNodeId: parallel[0].key };
  }
  const { model, warnings } = buildProcessModel({ nodes, edges });
  const nodeProps = {};
  for (const n of nodes) {
    if (n.props && Object.keys(n.props).length) {
      nodeProps[n.key] = { pNodeId: n.key, pNodeType: n.nodeType, pNodeName: n.nodeName, ...n.props };
    }
  }
  for (let i = 0; i < model.linkDataArray.length; i++) {
    const l = model.linkDataArray[i];
    const cond = routerConditionProps(edgeExprs[i]);
    nodeProps[l.routerId] = {
      pNodeId: l.routerId,
      pNodeType: 'router',
      pNodeName: l.routerId,
      sourceId: l.from,
      targetId: l.to,
      order: String(i + 1),
      async: 'false',
      asyncFlag: '0',
      clearProcessMainData: '0',
      serialLock: '0',
      ...cond,
    };
  }
  const issues = validateFlow(model, { knownTypes, allowMock: false, nodeProps });
  const blocking = issues.filter((i) => i.level === 'error');
  const out = {
    id: t.id,
    name: t.name,
    category: t.category,
    desc: t.desc,
    model,
    props: nodeProps,
    warnings: [...warnings, ...issues.filter((i) => i.level === 'warn').map((i) => `${i.code}: ${i.msg}`)],
    issues,
  };
  await writeFile(`catalog/flow-templates/${t.id}.json`, JSON.stringify(out, null, 1) + '\n');
  index.push({ id: t.id, name: t.name, category: t.category, desc: t.desc, nodes: model.nodeDataArray.length, edges: model.linkDataArray.length, ok: blocking.length === 0 });
  console.log(`${blocking.length === 0 ? '✔' : '✖'} ${t.id.padEnd(24)} 节点 ${String(model.nodeDataArray.length).padStart(2)} 连线 ${String(model.linkDataArray.length).padStart(2)} ${blocking.map((b) => b.code).join(',')}`);
  if (hasBlockingError(issues)) failed++;
}
await writeFile('catalog/flow-templates/index.json', JSON.stringify({ generatedAt: new Date().toISOString(), count: index.length, templates: index }, null, 1) + '\n');
console.log(failed === 0 ? `\n全部 ${index.length} 个模板通过校验` : `\n${failed} 个模板未通过`);
process.exit(failed === 0 ? 0 : 1);
