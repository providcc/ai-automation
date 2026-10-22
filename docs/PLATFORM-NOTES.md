# 平台已知问题与契约事实

> 记录**平台侧**的既有行为与限制。只写事实与规避方式，不写环境地址、凭据、库名。
> 工具在这些地方做了兜底，写清楚比各自 workaround 更有价值。
> 标注 `[实测]` 的结论来自真实环境验证；标注 `[推断]` 的只是接口形状推导，尚未实测。

## 1. 校验层：平台 `checkerror` 偏松

- `[实测]` ESB/ETL 的 `model/checkerror` **不校验组件必填属性**：把 `apiNode` 的 `apiUrl`、
  `methodType`、`requestBodyFlag`、`responseData` 全部删掉，平台仍回「未发现错误!」并允许保存。
- `[实测]` 多个 `start` 节点、缺关键属性等"结构性问题"平台也放行。
- `[实测]` 平台**会**报的情况：并行/聚合网关没有成对（`并行网关和聚合网关没有成对!`）、
  节点没有链接路由（`节点(T00003)没有链接路由!`）、ETL 节点/router 没设属性
  （`节点(...)没有设置属性!` / `路由(...)没有设置属性!`）。
- 结论：**必填属性只能靠本地校验兜底**。本工具按组件目录 `required` + 启发式规则本地强制
  （见 [FLOW-JSON-SPEC.md](FLOW-JSON-SPEC.md) §4），并在 `flow save` 阻断。

## 2. 属性层

- `[实测]` 节点属性写入**必须带既有记录 `id`**，否则是插入而不是更新 → 同一节点出现多条属性
  → 平台随后报"网关没有成对"。本工具先读回 `id` 再提交，并清理历史重复记录。
- `[实测]` ESB 批量属性端点 `POST /rest/esb/process/node/batch/save` 的 body 必须是**裸 JSON 数组**；
  传 `{ nodes: [...] }` 会报 `This is not a JSON Array.`。
- `[实测]` **ETL 没有批量属性端点**，只能逐节点读写；ETL 的 `node/select` **不返回 router**，
  router 的 id 只能从 `processModel.linkDataArray` 取。
- `[实测]` 属性批量读存在**索引延迟**：刚写完立刻读，可能少几条（本工具对回读做 3 次重试，
  回滚后同样做回读校验 + 缺失补写）。
- `[实测]` 流程列表接口的 `keyword` 参数**不可用**（返回与关键词无关的结果），只能在客户端过滤。

## 3. 图与表达式

- `[实测]` 平台**没有独立的排他网关节点**（`gateWay` 的 `gatewayType=1` 是网关属性而非节点模板）：
  条件路由推荐由普通节点直接出多条边（`assertCondition=3/6`）。
- `[实测]` 网关的 `gatewayType` 必须显式声明，缺省时无法判断并行/排他 → 本地校验会提示
  `gateWay` 缺 `gatewayType`。
- `[推断]` 断言表达式的完整 BNF 尚未逐条确认；本工具只做明显错误的静态检查
  （括号配对、结尾操作符、缺取值），最终以平台 `checkerror` 为准。
- `[推断]` `processModel` 的长度上限、单流程节点数上限**未实测**；超限时的平台报错未收录。

## 4. 流程与版本

- `[实测]` 新建流程必须带**唯一 `configId`**，否则报「流程编码已存在」；响应体**不返回 `processId`**，
  需按 `configId`/`configName` 回查。
- `[实测]` 流程删除只认 **Mongo id**（`processId` 会被当成"删除成功但没删掉"），
  正确 body 是 `{ ids: "<mongoId>,<processId>", appId: "esb|etl" }`。
- `[实测]` 删除是**异步**的：请求返回成功不等于已删除，需要轮询详情确认。
- `[实测]` 重复调用删除会把队列里的删除重新置为待处理 → 正确做法是"发一次 + 轮询确认"。
- `[实测]` 平台 `checkerror` 要求属性**已存在**才能校验，所以保存顺序只能是"先属性后图"；
  中途失败靠快照 + 回滚兜底。
- `[实测]` 历史版本恢复端点 body 是 `{ id }`；恢复前应先快照（平台不提供"撤销恢复"）。

## 5. API（服务配置）域

- `[实测]` OpenAPI 导入是两阶段：`POST /rest/core/v2/openapi/analysis?appId=<appId>`（body = 文档原文）
  → `POST /rest/core/v2/openapi/import`（body = 条目数组的 JSON 字符串）。
- `[实测]` **删除服务前必须先"下线"**：`POST /rest/core/services/save`（带 `state:'0'`）后再
  `POST /rest/core/services/delete`（body `{ ids }`），否则报「删除失败，请下线后再执行此操作」。
- `[实测]` 服务列表的 `keyword` 参数**同样不可用**（返回该应用的第一页，与关键词无关），
  只能客户端按 `categoryId` / `configId` 前缀过滤。
- `[实测]` 删除后 `GET /rest/core/services/{id}` 返回 200 + `Can't found the data by <id>`（不是 404）。
- `[推断]` 导入返回体里的数字是"本次创建的服务条数"，不是 id 列表；清理时要靠 `categoryId` 找回自己的服务。

## 6. 其它

- `[实测]` 平台返回 `state: false` 表示失败；部分端点用字符串 `"false"`，两种都要判失败。
- `[实测]` `identitytoken` 可能以 URL 编码存储，解码要容错（非法 `%` 序列不能抛异常）。
- `[实测]` 数据源详情里的密码可能在 `jdbcUrl` 内嵌（`password=...`），脱敏要覆盖连接串内部。
- `[实测]` 上传附件若 multipart part 没有 MIME 类型，平台可能按错误类型解析（wsdl/xlsx/证书等）。
- `[推断]` prod profile 的写保护由调用方实现（本工具用 `RC_PROFILE=prod` + `RC_ALLOW_PROD_WRITE=1` 闸门），
  平台自身是否也拦截未经确认。

## 7. 复核方式

- 上面标 `[实测]` 的结论都能用 `npm run flow:verify`（流程域）、`npm run api:verify`（API 域）
  与 `npm run templates:verify`（模板域）在测试环境复现；写测试必须显式放行目标主机（`--allow-host`）。
- 新发现平台行为时，请同时更新本文与 `docs/COMMAND-REFERENCE.md`，避免两处口径不一致。
