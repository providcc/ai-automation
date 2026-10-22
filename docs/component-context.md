# 流程组件上下文

让 Agent 在生成流程图之前先知道：平台有哪些节点、每个节点吃什么参数、怎么连才合法。

## 1. 注入层次

| 层 | 内容 | 载体 | 使用方式 |
|---|---|---|---|
| L1 组件目录 | 7 大类 / 60 个已著录节点 | `catalog/components.json` | 可全量注入上下文 |
| L2 节点参数 | 每个节点的真实表单字段、必填/类型/枚举 | `catalog/components.json` + `catalog/node-params.json` | 按需检索 |
| L3 图约束 | 起止、网关配对、环、默认分支、属性完整性 | 本文 + `rc flow validate` | 生成后必须校验 |

CLI 入口（**只有 CLI，没有 MCP**）：

```text
rc catalog nodes [--kind esb|etl] [keyword]   # 组件目录
rc flow search --node-type <type> --props k=v # 线上真实节点的参数写法（学正确用法）
rc flow validate --file model.json            # 落库前静态校验
rc flow preview --process-id <pid> --node-id <id>   # 只读预览节点数据
```

## 2. 图约束（必须遵守）

1. 有且只有一个开始节点、至少一个结束节点。
2. 所有节点从开始可达；除结束节点外必须有出边。
3. 不允许环（除平台明确支持的循环节点）。
4. **排他分支不使用 `gateWay`**：普通节点直接出边，`assertCondition=3` 条件、`6` 默认。
5. 并行分支必须是：并行网关 → 分支 → 聚合网关；聚合网关 `joinNodeId` 指回并行网关。
6. 节点属性必须与图节点一一对应；`pNodeId` 等于属性键，`pNodeType` 与 `nodeType` 一致。
7. 生产流程禁止 `mockResponse`；测试流程可保留但需显式 `--allow-mock`。
8. 调用外部 HTTP 必须设置超时；禁止在 URL/headers/body 中写明文密钥。

## 3. 常用组合模式

### A. 同步 API

```text
start → api → dataTransform → returnData → end
```

要点：下游只引用上游已声明的返回字段；错误分支至少记录错误码与 traceId。

### B. 批量同步

```text
start → dbInput/fileInput → dataSplit → dataMap → api/dbOutput → dataMerge → end
```

要点：拆分键保证同一条业务记录不被拆散；批量失败要能按批次重试。

### C. 事件驱动

```text
start → kafka/rabbitmq → dataTransform → asyncQueue → end
```

要点：分区键/消息键保证顺序；消费端幂等。

### D. 异步等待外部系统

```text
start → api(提交) → asyncCallback(等回执) → gateWay(成功/超时) → end
```

要点：回调必须幂等（同一 requestId 不重复处理）；超时要有补偿或人工节点。

### E. 规则路由

```text
start → variableRule(取规则) → [条件边 3 / 默认边 6] → subProcess/各实现
```

要点：规则表版本化，流程只做路由，不硬编码业务判断。

### F. 错误处理与补偿

```text
start → 业务节点 → [异常] errorHandler → compensate/notify → end
```

要点：补偿单位是 transactionId；失败节点要保留输入参数与 traceId。

## 4. 组件速查

### 流程基本组件（21）

| 节点 | nodeKey | 关键参数 |
|---|---|---|
| Restful API | `api` | `apiUrl` `apiId` `addIdentitytoken` `asyncFlag` `compensateFlag` |
| WebService | `webService` | `apiUrl` `connectTimeout` `assertionCondition` |
| Dubbo | `dubbo` | `applicationName` `methodName` `asyncFlag` |
| 网关 | `gateWay` | `gatewayType` `defaultRouterNodeId` `joinNodeId` `copyData` |
| 子流程 | `subProcess` | `inDataFlag` `outDataFlag` `exceptionAssert` |
| 数据拆分 | `dataSplit` | `dataFieldId` `outputQty` `outputType` `endProcessFlag` |
| 数据合并 | `dataMerge` | `mergeNodeList` `pNodeAlias` |
| 数据库输出 | `dbOutput` | `outputType` `logFilePath` |
| 人工确认 | `manualConfirm` | `approveUserIds` `completeType` |
| 异步队列 | `asyncQueue` | `threadPoolNum` `sleepTime` |
| 异步回调 | `asyncCallback` | `callbackTimeout` `responseData` |
| 变量设置 | `variable` | `gobalParams` `assertAction` `maxLoopCount` |
| 共享变量 | `sharedVariable` | `action` `globalParams` |
| TCP/IP | `tcp` | `body` `connectTimeout` `compensateFlag` |
| 模拟数据 | `mockResponse` | `mockResponseId` `responseCode` `toJson`（生产禁用） |
| HTML 页面 | `htmlPage` | `url` `pageCallBackFlag` `executerType` |
| 文件 | `ftpUpload` `ftpDownload` `fileUpload` `fileDownload` | 运行时补齐 |

### 数据转换（10）

`dataMap`（JSONPath 抽取重组）、`dataTransform`（类型/金额格式化）、`dataValueMap`（枚举/码表对照）、`mappingTemplate`（模板复用）、`json2xml`/`xml2json`（SOAP）、`responseCrop`（裁剪）、`returnData`（返回体）。

### 脚本执行（7）

`sqlExecuter`、`javaCode`、`jsCode`、`python`、`shell`、`velocity`、`javaBean`。

> `shell` 为高危节点，禁止拼接外部输入；金额运算优先 `javaCode`（BigDecimal）而非 `jsCode`。

### 消息队列（5）

`kafka`、`rabbitmq`、`rocketmq`、`mqtt`、`jms`。

### 流程事件（9）

`event`、`time`、`variableRule`、`msg` + 运行时补齐项。

### 应用连接器（8）

`ding`、`weixin`、`lark`、`appFlow` + 运行时补齐项。

## 5. 生成顺序

```text
选模板 / 自然语言
  → rc catalog nodes（组件目录）+ rc flow search（线上真实写法）
  → rc flow build --file spec.json     # 或 rc flow from-nl "<自然语言>"
  → rc flow validate --file model.json # 本地 33 条规则
  → rc review flow --file model.json   # 安全/生产评审
  → rc flow create … --apply + rc flow save … --apply   # dry-run → apply
  → rc flow check --file model.json --process-id <pid>  # 平台校验
  → rc flow get <pid> / rc flow props list               # 回读节点/连线/属性
```

每条命令的选项与坑见 `rc <命令> --help`。

任何一步失败都不要继续写入；先修图或属性，再重跑。
