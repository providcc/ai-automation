# 流程模板（29 个）

> 目录：`catalog/flow-templates/`，索引：`catalog/flow-templates/index.json`。
>
> 29 个模板均通过本地 `validateFlow`；其中 27 个在测试环境完成 **创建 → 保存 → 平台 checkerror → 删除** 全链路验证。

## 1. 使用方式

```bash
# 列出/查看
rc templates list
rc templates show sync-api

# 本地静态校验（全部模板）
rc templates validate

# 生成组合文件 {kind, model, props, skeleton:true}；--props-out 额外导出属性映射
rc templates show sync-api --out flow.json --props-out props.json

# 保存到平台（先创建空流程拿 processId）
rc flow create --application <appId> --name <name> --apply
rc flow save --file flow.json --process-id <pid> --apply
```

`templates show` 也支持 `--json`。保存前建议再跑：

```bash
rc flow validate --file flow.json
rc review flow --file flow.json --production
```

模板是**骨架**：URL、连接、表名、规则等要按项目替换。组合文件带 `skeleton: true`，
因此 `flow validate` / `flow save` 对"组件必填属性缺失"只提示不阻断（例如 `apiNode.apiUrl`）；
自己写的流程文件没有这个标记，缺必填属性会被直接拦下。

## 2. 模板结构约定

- 节点 key 由 `prefixFor/nextId` 自动分配，避免重复；
- 必须有一个 `start` 和一个 `end`；
- **排他分支不走 `gateWay`**：普通节点或 `variableRuleNode` 直接出边，`assertCondition: "3"` 表示条件，`"6"` 表示默认；
- **并行分支**结构为「并行网关 → 分支 → 聚合网关」，聚合网关 `joinNodeId` 指回并行网关；
- 条件分支的 router 属性必须带 `assertionCondition`（JSON）、`condition`（JS）、`sourceId`、`targetId`、`order`；
- 模板只生成骨架，URL/连接/表名/规则仍需按项目替换。

## 3. 模板清单

| ID | 名称 | 分类 | 说明 | 类型 |
|---|---|---|---|---|
| `sync-api` | 同步 API 编排 | API 集成 | 取数 → 字段映射 → 返回：最常见的同步接口编排 | esb |
| `async-callback` | 异步回调编排 | 异步 | 提交下游 → 等待回执 → 成功/超时转人工 | esb |
| `split-call-api` | 拆分循环调 API | 数据同步 | 按单据拆分 → 逐条调用网关注册的 API | esb |
| `split-call-api-writeback` | 拆分调用 API 回写 | 数据同步 | 按单据拆分 → 先存全局变量 → 调网关注册的 API → 回写结果 | esb |
| `batch-sync` | 批量同步 | 数据同步 | 增量读取 → 按单据拆分 → 子流程处理 → 批量落库 | esb |
| `event-driven` | 事件驱动 | 消息 | Kafka 消费 → 清洗 → 异步入账 | esb |
| `rule-routing` | 规则路由 | 规则 | 读规则 → 按规则分流到不同子流程 | esb |
| `api-to-db` | API 落库 | API 集成 | 调用 API → 字段映射 → 写入数据库 | esb |
| `db-to-api` | 数据库推送 API | API 集成 | SQL 查询 → 数据清洗 → 推送 API | esb |
| `file-to-db` | 文件入库 | 文件 | 读取 SFTP 文件 → 解析 → 写入数据库 | esb |
| `db-to-file` | 数据库导出文件 | 文件 | 查询数据库 → 生成文件 → 上传 SFTP | esb |
| `fanout-aggregate` | 并行扇出/聚合 | 并行 | 并行调用两个下游 → 聚合网关汇合 → 返回 | esb |
| `retry-compensate` | 重试与补偿 | 可靠性 | 外部调用重试 → 失败补偿标记 → 落库 | esb |
| `scheduled-sync` | 定时同步 | 调度 | 每天定时读取 → 写入目标表 | esb |
| `message-queue` | 消息队列消费 | 消息 | RocketMQ 消费 → 过滤 → 入库 | esb |
| `webhook-receiver` | Webhook 接收 | API 集成 | 接收外部 Webhook → 映射 → 落库 | esb |
| `subprocess-orchestration` | 子流程编排 | 编排 | 主流程串联两个子流程 | esb |
| `data-mapping` | 格式转换 | 数据处理 | XML → JSON → 字段映射 → XML | esb |
| `error-handler` | 错误分支处理 | 可靠性 | 主调用成功走结束，失败发消息告警 | esb |
| `idempotent-upsert` | 幂等 Upsert | 可靠性 | 外部调用 → 过滤重复 → 幂等写入 | esb |
| `multi-source-merge` | 多源合并 | 数据处理 | 并行读取两个数据源 → 聚合 → 合并落库 | esb |
| `approval-flow` | 人工审批 | 人工 | 提交审批 → 人工确认 → 通过/驳回分支 | esb |
| `cache-refresh` | 缓存刷新 | 调度 | 定时拉取配置 → 映射 → 刷新缓存 | esb |
| `audit-log` | 审计留痕 | 可观测 | 调用后写审计表（请求/响应摘要） | esb |
| `pagination-sync` | 分页同步 | 数据同步 | 分页读取大表 → 批量写入 | esb |
| `dead-letter` | 死信处理 | 消息 | 消费消息 → 成功入库 / 失败转死信队列 | esb |
| `sftp-to-api` | 文件转 API | 文件 | 读取 SFTP 文件 → 映射 → 调用 API | esb |
| `api-to-file` | API 转文件 | 文件 | 调用 API → 映射 → 上传 SFTP | esb |
| `compensate-notify` | 补偿通知 | 可靠性 | 读取待补偿记录 → 通知责任人 → 标记处理 | esb |

> `approval-flow` 是**业务流程模板**（人工确认节点），与已移除的 CLI 审批工单/许可能力无关。

## 4. 真实验证

```bash
# 需显式指定可写测试环境
RC_BASE_URL='https://<test-host>/restcloud' \
RC_USER=... RC_PASS=... \
node --experimental-strip-types scripts/verify-templates-live.mjs

# 只跑一个 / 保留失败现场
... --only fanout-aggregate
... --keep-fail
```

验证内容：创建空流程 → 保存模板图与属性 → 平台 `checkerror` → 删除（默认）。报告写入 `reports/templates-live-<runId>.json` 与 `.jsonl`。

最近一次结果：

- 创建：27/27
- 保存：27/27
- 平台校验：27/27
- 报告：`reports/templates-live-20261020144345.json`

> 该次运行早于 `split-call-api` 与 `split-call-api-writeback` 两个模板——这两个目前**只过了本地静态校验**，
> 还没跑过测试环境全链路；补跑：`node --experimental-strip-types scripts/verify-templates-live.mjs --only split-call-api-writeback`。

## 5. 新增模板

1. 在 `scripts/gen-templates.mjs` 增加生成器；
2. 运行 `npm run templates`，生成 `catalog/flow-templates/<id>.json` 与索引；
3. 运行 `rc templates validate`；
4. 在测试环境运行 `verify-templates-live.mjs --only <id>`；
5. 通过后更新本文档和 `catalog/fingerprint.json`。
