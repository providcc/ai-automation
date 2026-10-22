# 流程 JSON 契约（核心）

RestCloud 流程由两张表组成：

- **图模型**：`{ nodeDataArray, linkDataArray, transform }`，保存到流程 `processModel` 字段；
- **节点/连线属性**：按 `processId + nodeId` 存放，节点和连线（router）同一张属性表。

只保存图、不保存属性，平台校验会失败；只保存属性、不保存图，流程不会更新。本工具的 `flow save` 会一起处理。

推荐用**组合文件**传递完整流程，`flow build` / `flow export` / 模板都能直接产出：

```json
{
  "kind": "esb",
  "model": { "nodeDataArray": [], "linkDataArray": [], "transform": 1 },
  "props": {
    "T00001": { "pNodeId": "T00001", "pNodeType": "apiNode", "apiUrl": "https://example.test/api" }
  }
}
```

`props` 既可以是上面的 `nodeId → 属性` 对象，也可以是 `[{nodeId,nodeType,nodeName,props}]` 数组；CLI 共用同一个归一化函数。

`flow export` 还会额外写两个字段：

- `skeleton: true`——导出的流程本来就缺必填属性（平台现状），校验/保存时只提示不阻断；
- `missingRequired: ["T00001.apiUrl", ...]`——缺了哪些必填项，便于人工确认。

## 1. 图模型

```json
{
  "nodeDataArray": [
    { "key": "E00001", "nodeType": "start", "text": "开始", "nodeName": "开始" },
    { "key": "T00001", "nodeType": "apiNode", "text": "调用 API", "nodeName": "调用 API" },
    { "key": "E00002", "nodeType": "end", "text": "结束", "nodeName": "结束" }
  ],
  "linkDataArray": [
    { "from": "E00001", "to": "T00001", "assertCondition": "0" },
    { "from": "T00001", "to": "E00002", "assertCondition": "0" }
  ],
  "transform": 1
}
```

节点字段：

| 字段 | 说明 |
|---|---|
| `key` | 节点唯一 key，如 `E00001` / `T00001` / `G00001` |
| `nodeType` | 节点类型，必须在平台白名单内 |
| `text` / `nodeName` | 显示名 |
| `locLeft` / `locTop` | 画布坐标（可省略，工具会排布） |
| `flowType` / `icon` | 由工具按类型补齐 |
| `skipChecking` | 是否跳过平台检查，默认 `"0"` |

连线字段：

| 字段 | 说明 |
|---|---|
| `from` / `to` | 源/目标节点 key |
| `assertCondition` | `"0"` 普通；`"3"` 条件；`"6"` 默认；`"1"`/`"2"` 旧条件码 |
| `label` | 显示标签，可省略 |
| `routerId` | 连线属性 key，工具自动分配 |

## 2. 排他分支

条件路由优先由普通节点（或 `variableRuleNode`）直接出多条边；模板不依赖独立排他网关。若已有流程使用 `gateWay` 且 `gatewayType=1`，工具会按排他语义校验缺省分支：

- 条件边：`assertCondition: "3"`，并配置 router 属性；
- 默认边：`assertCondition: "6"`；
- 不要为排他分支创建 `gateWay`。`gateWay` 只用于并行/聚合。

router 属性示例：

```json
{
  "pNodeId": "R00001",
  "pNodeType": "router",
  "pNodeName": "条件成立",
  "sourceId": "T00001",
  "targetId": "T00002",
  "assertCondition": "3",
  "assertionCondition": "{\"rules\":[{\"field\":\"$.data.amount\",\"op\":\">\",\"value\":100}],\"logic\":\"and\"}",
  "condition": "return $.data.amount > 100;",
  "order": "1"
}
```

## 3. 并行分支

结构必须是：

```text
并行网关(gateWay, gatewayType=2)
  ├── 分支 A
  └── 分支 B
        ↓
聚合网关(gateWay, gatewayType=2, joinNodeId=并行网关 key)
```

- 并行网关到分支的边用 `assertCondition: "0"`；
- 聚合网关必须 `joinNodeId` 指回并行网关；
- 缺少聚合或 `joinNodeId` 不匹配，平台会报“并行网关和聚合网关没有成对”；
- 网关类型必须由属性 `gatewayType` 显式声明（`1` 排他 / `2` 并行 / `3` 包含）。没有属性时，本地校验只检查出口/连线结构，不会默认把网关当成并行网关。

## 4. 节点属性

属性对象以 `nodeId` 为键：

```json
{
  "T00001": {
    "pNodeId": "T00001",
    "pNodeType": "apiNode",
    "pNodeName": "调用 API",
    "apiUrl": "https://api.example.com/orders",
    "methodType": "GET",
    "connectTimeout": "10",
    "retryNum": "1"
  }
}
```

约束：

- `pNodeId` 必须等于属性键；
- `pNodeType` 必须与图里的 `nodeType` 一致；
- 图上每个节点和 router 都需要属性记录（包括 `start` / `end` / `router`）；工具保存时会补齐缺失项；
- **组件必填属性不能省**：组件目录里标记 `required` 且没有平台默认值的字段（如 `apiNode.apiUrl`、
  `dataMergeNode.mergeNodeList`、`msgNode.body`）会被本地校验强制——平台 `checkerror` 不查这一项，
  缺了也会放行，所以本地是唯一兜底；
- 另外还有一组**启发式必填**（目录里没有 required 标记，但缺了流程跑不起来，字段名取自真实平台流程）：
  `sqlExecuterNode` 需 `dbConnId`+`sqlCode`，`jdbcWriteNode`/`tableReadNode` 需 `dbConnId`+`tableName`，
  `dataSplitNode` 需 `dataFieldId`，`gateWay` 需 `gatewayType`；
- 有平台默认值的字段（`connectTimeout`、`retryNum` 等）不强制；`apiUrl` 可以用 `apiId` 替代
  （引用平台已配置的 API 服务）；
- 不要把密码/token 写进 `apiUrl`、`headers` 或 `body`；用连接/凭据引用；
- 工具保存时会保留既有属性的 `id` 做更新，避免重复记录；旧图上已删除的节点属性会被清理。

## 4.1 怎么调"网关注册的 API"（apiNode）

平台上的 API 分两类：**平台内置**（直接填 `apiUrl` 即可）和**网关注册的**（先在 API 管理门户注册，
再在流程里引用）。后者最容易配错，实测正确写法是三条同时满足：

| 字段 | 写什么 | 怎么拿 |
|---|---|---|
| `apiUrl` | **网关地址 + `mapUrl`**（例：`https://<网关>/restcloud/erp/api/xxx/batchSubmit`） | `rc api list --keyword <名称>` 的 `mapUrl` 列 + 网关根地址 |
| `apiId` | 网关注册那条 API 的 id（**与 `apiUrl` 必须同时给**） | `rc api list --keyword <名称>` 的 `id` 列 |
| `requestBodyAuto` / `requestBody` | `requestBodyAuto='0'` + `requestBody` 模板用 `${字段名}` 取上游字段 | 上游节点（如 `dataSplitNode`）拆出来的字段名 |

参考实现见模板 `split-call-api`（拆分循环 → 调网关注册 API → 结果映射）。

> **组件目录里的 `initialValue` 不可信**（例如 `apiUrl` 的默认值被截断成 `${#config.apiserver`）。
> 想知道"这种节点到底该怎么配"，用 **`rc flow search --node-type apiNode`**：它扫描真实流程的节点属性，
> 把去掉平台元数据后的业务属性列出来（这是最可靠的"正确写法"来源）。
>
> ⚠ **但样例多半不能照抄**：它们来自真实流程，也就带着真实环境的东西——网关主机、占位符、
> 别的环境的 `apiId`。`flow search` 会逐条标注（主机与当前环境不一致 / 占位符 / 只给 apiId /
> 本环境有多个网关主机），`--check-registry` 还会核对 apiId 在当前环境的接口注册表里是否存在。
> 照抄之前先看这些提示。

## 5. ESB 变量引用与数据流

平台支持的**上游数据引用只有三种路径写法**，节点属性（`requestBody`、`sqlCode`、字段映射等）里取值只能用它们：

| 写法 | 含义 |
|---|---|
| `${$.global.x}` | 全局变量 `x`（由 `variableRuleNode` 写入全局上下文） |
| `${$.T0000X}` | 节点 `T0000X` 的整个响应体 |
| `${字段名}` | 当前行的字段 |

这三种是平台支持的全部引用形式，本仓库此前没有其它地方说明，**本节是唯一的说明位置**。

### 5.1 apiNode 会替换当前数据流

`apiNode` 一执行，**当前数据流就被它的响应替换掉**——即使配了 `responseData: '0'`（不把 API 结果输出到流程结果）也一样。
拆分出来的那一行在 `apiNode` 之后就取不回来了。

正确顺序是：**先把当前行存进全局变量，再调 API**。

```text
dataSplitNode → variableRuleNode(gobalParams='1') → apiNode → jdbcWriteNode
```

- `variableRuleNode` 用 `gobalParams: '1'` 把当前行写进全局上下文；
- `apiNode` 用 `requestBodyAuto: '0'` + `requestBody` 模板里的 `${字段名}` 取当前行字段（此刻当前行还在）；
- `apiNode` 之后当前数据流已经是响应体，原始行只能再用 `${$.global.<name>}` 读回来。

参考模板：`split-call-api-writeback`（拆分 → 存全局变量 → 调 API → 回写）。

### 5.2 常见坑

- 平台属性名拼写就是 **`gobalParams`**（少一个 `l`），不是 `globalParams`；
- SQL 里的 `${...}` 由平台**运行时**替换：节点里存的 SQL 文本本身不是可执行 SQL，
  要校验可运行形态用 `rc sql check --conn <dbConnId> --query "<SQL>"`（工具先把占位符替换成等价字面量再送平台解析）。

## 6. 表达式

四类真实形态：

| 形态 | 示例 | 用途 |
|---|---|---|
| 路径 | `$.data.order.id` | 取值 |
| 模板 | `${$.data.order.id}` | 字符串插值 |
| 规则 JSON | `{"rules":[{"field":"$.amount","op":">","value":100}]}` | 条件路由 |
| JS 断言 | `assert($.data.amount > 100, "金额必须大于 100")` | 脚本校验 |

> 跨节点取值的**变量引用**只有 §5 那三种写法；上表是表达式形态。

自定义脚本能力很强，但评审会拦截明显危险写法（明文密钥、SQL 拼接、无超时 HTTP）。

## 7. 保存流程

```bash
rc flow build --file spec.json --out flow.json
rc flow validate --file flow.json
rc flow save --file flow.json --process-id <pid> --apply
rc flow check --file flow.json --process-id <pid>
```

`flow save` 的顺序：

1. 本地 12 条规则校验（组合文件里的 `props` 会参与）；
2. 保存前快照（图 + 全部节点/router 属性）；
3. upsert 节点/连线属性（ESB 自动批量，ETL 逐节点）；
4. 保存 `processModel`；
5. 清理不再存在的旧属性；
6. 调用平台 `checkerror`；
7. 回读节点数、连线数、属性完整性。

属性、图、校验或回读失败会自动回滚到快照：恢复图、删除本次写入的属性、重新写入原属性。任何一步失败都会输出可行动的错误与 traceId。

## 8. ETL 流程差异

ETL 图模型只保留三键：

```json
{ "nodeDataArray": [], "linkDataArray": [], "transform": 1 }
```

不要给 ETL 模型加 `translate` / `detailFlag`；ETL 的节点类型白名单与 ESB 不同，保存时用 `--kind etl`。

ETL 的端点与 ESB 不同（`/rest/etl/...`），工具会自动切换：

- 属性保存：`POST /rest/etl/process/node/save`，逐节点；
- 图保存：`POST /rest/etl/process/model/save`；
- 平台校验：`POST /rest/etl/process/model/checkerror`；
- 版本：`GET /rest/etl/process/version/list`、`POST /rest/etl/process/version/restore`。

ETL 的 `node/select` 只返回已配置节点、且不返回 router；`flow export` / `flow props list` / 删除快照会从 `processModel.linkDataArray` 补齐 router，确保属性不丢失。ETL 同样要求 start/end/router 有属性记录。
