# 命令参考（rc CLI）

> 本工具**没有 UI、没有交互式终端界面、没有 Web 服务、没有 MCP**。入口只有 CLI：
>
> - **`rc`**：RestCloud iPaaS 的命令面（本文档）
> - **`dw`**：Apache Doris 数仓的命令面（见 `DW-COMMAND-REFERENCE.md`）
>
> Agent 通过 shell 调 CLI 工作；`skills/` 下每个 CLI 配一份 SOP（`ipaas-ops` / `dw-ops`）。
> 所有写操作默认 dry-run；只有显式 `--apply` 才写平台。`prod` 默认只读，必须额外设置 `RC_ALLOW_PROD_WRITE=1`。

## 1. 安装与启动

```bash
npm install
npm run typecheck
npm test

# CLI（开发态）
npm run cli -- --help
npm run cli -- doctor
```

给 Agent 一个 shell 工具，让它执行 `rc` 命令即可；配套 `skills/ipaas-ops/SKILL.md` 说明了
"什么时候用哪条命令、失败先看什么、什么绝对不能做"。

## 2. 环境与认证

| 变量 / 文件 | 说明 |
|---|---|
| `RC_BASE_URL` | 平台上下文地址，例如 `https://<host>/<context>` |
| `RC_USER` / `RC_PASS` | 服务账号；仅从环境/密钥管理注入，不写入仓库 |
| `RC_TOKEN` | 已有 token，优先于账号密码 |
| `RC_PROFILE` | `dev` / `uat` / `prod`；`prod` 默认只读 |
| `RC_TARGET` | 多目标配置中的目标名 |
| `RC_ALLOW_PROD_WRITE=1` | 显式允许 prod 写操作 |
| `RC_ENABLE_ETL_WRITE=1` | 显式允许 ETL 写操作（试跑/补偿/发布）；**默认封禁** |
| `RC_ALLOW_WRITE_HOSTS` | 可选：允许执行写测试的目标主机白名单（验收脚本用，逗号分隔） |
| `RC_HOME` | 本地会话/审计目录，默认 `~/.rc` |
| `RC_SNAPSHOT_DIR` | 快照目录，默认 `~/.rc/snapshots` |
| `RC_AUDIT_DIR` | 审计 jsonl 目录 |
| `RC_TARGETS` | 目标配置 JSON；也可写 `rc.targets.json`（当前目录）或 `~/.rc/targets.json`（全局，推荐） |
| `RC_ALLOWED_HOSTS` | 可选：允许访问的目标 host 白名单，逗号分隔，支持 `*.example.com` |
| `RC_KEYCHAIN=1` | 可选：从系统钥匙串读取凭据（macOS `security` / Linux `secret-tool`） |
| `RC_KEYCHAIN_SERVICE` | 钥匙串 service，默认 `rc-ipaas` |
| `RC_KEYCHAIN_ACCOUNT` | 密码 account，默认 `RC_USER` 或 `user` |
| `RC_KEYCHAIN_TOKEN_ACCOUNT` | token account，默认 `token` |
| `RC_LLM_URL` | 可选：NL→流程使用的外部 LLM 兼容端点；失败自动回退离线规则 |

开源版本**不内置任何平台地址或凭据**。未配置 `RC_BASE_URL` 时 CLI 启动不崩，调用平台命令会返回明确错误。

**本工具不会自动加载 `.env`**（没有 dotenv 依赖）：环境变量只来自进程本身。
要用 `.env` 请显式 `node --env-file=.env …`（或 `NODE_OPTIONS="--env-file=.env"`）；
Docker 用的是 Docker 自己的 `--env-file`。仓库里只有 `.env.example` 模板。

**每次调用都可换目标**：`rc` 支持 `--target` / `RC_BASE_URL` / `RC_PROFILE` 逐次指定，不需要为多环境起多个进程。

生产建议同时设置 `RC_ALLOWED_HOSTS`，避免脚本/环境变量误把写请求发到非预期主机：

```bash
export RC_ALLOWED_HOSTS='ipaas-test.example.com,*.corp.example.com'
# 也接受完整 URL；比较时只取 host
```

需要避免在配置文件中保存密码时，可把凭据放进系统钥匙串：

```bash
# macOS
security add-generic-password -s rc-ipaas -a "$RC_USER" -w "$RC_PASS"
export RC_KEYCHAIN=1

# Linux（libsecret）
secret-tool store --label='rc-ipaas' service rc-ipaas account "$RC_USER"
export RC_KEYCHAIN=1
```

```bash
rc auth login --user "$RC_USER" --pass "$RC_PASS"
rc auth cookie                                # 打印可直接用的 Cookie 头（token 已解码）
rc auth keychain-setup --user <账号> --pass <密码>   # 写系统钥匙串（'user' 与 '<账号>' 两条）
rc auth status
rc auth refresh
rc auth save ./session.json
rc auth load ./session.json
rc apps
```

`rc apps` 输出 `appId` 与名称；`appId` 是 API、流程、数据源操作的上下文。

## 3. 通用参数

| 参数 | 作用 |
|---|---|
| `--target <name>` | 选择目标环境 |
| `--profile dev\|uat\|prod` | 选择环境角色；`prod` 默认只读 |
| `--json` | 输出机器可读 JSON |
| `--apply` | 真正写平台；缺省只预览 |
| `--file <path>` / `-o <path>` | 输入/输出文件 |
| `--kind esb\|etl` | 流程类型；影响端点、节点白名单和属性保存方式 |
| `--props <path>` / `--props-out <path>` | 输入/输出节点属性 |
| `--keyword <k>` | 列表过滤 |
| `--app <appId>` | 按业务应用过滤流程列表 |
| `--page <n>` / `--size <n>` | 客户端分页（平台列表默认只返回 20 条） |
| `--version-id <id>` | 恢复流程历史版本 |
| `--limit <n>` | 限制条数 |

写操作一律默认 dry-run，确认后追加 `--apply`。

## 4. API 资产（配置修改）

```bash
rc api list --app <appId> [--keyword k] [--page 1] [--size 30]
rc api inparams list --id <服务id>            # 读 services/{id} 的 paramsDocs（inparams/list 会回空）
rc api inparams save --id <服务id> --file params.json [--apply]
rc api inparams from-json --id <服务id> --file sample.json [--apply]   # 从 JSON 样本推导参数
rc api outparams list|save|from-json ...     # 出参同理
rc api get <apiId>
rc api save --file api.json [--apply]
rc api import --app <appId> --file openapi.json [--apply]
rc api analyze --app <appId> --file openapi.json
rc api export --app <appId> -o baseline.json
rc api diff --from before.json --to after.json [--breaking]
rc api impact --id <apiId> [--kind esb|etl] [--deep]
```

- `api save`：新增或修改 API service 配置；先 dry-run 看请求。
- `api import`：两阶段；先分析，确认后 `--apply`。
- `api diff --breaking`：只显示破坏性变更。
- `api impact --deep`：反查子流程与调用者，输出直接/间接影响面。

## 5. 流程编排（配置 + 修改）

### 5.1 从规格生成

```bash
rc flow build --file spec.json --kind esb --out flow.json [--props-out props.json]
rc flow validate --file flow.json [--kind esb|etl] [--allow-mock] [--allow-missing-required]
rc review flow --file flow.json [--production]
```

`spec.json` 的节点可带 `props`，连线可带 `props`（ESB router 属性）。`flow build` 输出**组合文件** `{kind, model, props}`，图与属性都不会在 build → save 之间丢失；`--props-out` 额外导出一份 `nodeId → 属性` 映射。

`flow validate` 接受三种输入：

- 纯 `processModel`；
- `{nodes, edges}` 规格；
- `{kind, model, props}` 组合文件（属性会参与网关/分支校验）。

没有 `gatewayType` 属性时，校验器只做结构检查，**不会把所有网关默认当成并行网关**；只有显式 `gatewayType=2/3` 才要求并行/聚合成对。

**必填属性（规则 13）**：组件目录里标记为 `required` 且**没有平台默认值**的字段会被本地强制
（如 `apiNode.apiUrl`、`dataMergeNode.mergeNodeList`、`msgNode.body`），另外还有一组**启发式规则**
覆盖目录里没有标记但缺了就跑不起来的字段（字段名取自真实平台流程）：

| nodeType | 必填字段 |
|---|---|
| `sqlExecuterNode` | `dbConnId` `sqlCode` |
| `jdbcWriteNode` / `tableReadNode` | `dbConnId` `tableName` |
| `dataSplitNode` | `dataFieldId` |
| `gateWay` | `gatewayType`（不声明就无法判断并行/排他） |

规则：

- 按**节点**遍历——整条属性缺失也会报，不会因为"删掉属性"绕过；
- 有默认值的字段（`connectTimeout`、`retryNum` 等）不强制；
- `apiUrl` 可以用 `apiId`（引用平台已配置的 API 服务）替代；
- **平台 `checkerror` 不校验这一项**，本地校验是唯一兜底 → 缺失时 `flow save` 直接阻断；
- 骨架模板（组合文件里 `skeleton: true`，由 `rc templates show` 产出）或显式
  `--allow-missing-required` 时降级为警告；
- **沿用平台现状**：带 `--process-id` 校验/保存时，如果平台上的这条流程**本来就没有**这个字段、
  本次也没补上，则只警告不阻断（导出 → 再保存是常见动作，不该被拦死）；
  新增节点缺必填属性仍然阻断。

本地校验覆盖起止、网关配对、默认分支、环、未知节点、mock、属性一致性、必填属性等 13 类问题。

### 5.2 自然语言生成

```bash
rc flow from-nl "调用订单接口 GET https://api.example.com/orders 然后返回" \
  --kind esb --name order_sync \
  --out model.json --props-out props.json
```

- 默认离线受约束模板；配置 `RC_LLM_URL` 时尝试外部 LLM，失败自动回退。
- 输出只是草案，**不会落库**；保存前必须 `flow validate` 和 `review flow`。
- 条件分支：普通节点出边 + `assertCondition=3/6`，不使用排他网关。
- 并行分支：并行网关 → 分支 → 聚合网关（`joinNodeId` 指回并行网关）。

### 5.3 创建、保存、修改

```bash
# 创建空流程，拿到 processId；ETL 用 --kind etl
rc flow create --application <appId> --name <name> [--config-id <id>] [--kind esb|etl] --apply

# 保存完整流程（快照 + 图 + 节点属性 + 平台校验 + 回读；失败自动回滚）
rc flow save --file flow.json --process-id <pid> [--kind esb|etl] [--allow-missing-required] --apply
rc flow save --file model.json --props props.json --process-id <pid> --apply

# 平台侧联合校验
rc flow check --file flow.json --process-id <pid> [--kind esb|etl] --json

# 节点/连线属性读取、批量读取、修改
rc flow props get --process-id <pid> --node-id <nodeKey> [--kind esb|etl]
rc flow props list --process-id <pid> [--kind esb|etl] [--only sql] [--fields a,b]
rc flow preview --process-id <pid> --node-id <nodeId> [--kind esb|etl] [--limit 20]
rc flow props save --process-id <pid> --file props.json [--kind esb|etl] --apply
```

`flow search --node-type <type>` 按节点类型扫描真实流程，列出命中节点的**业务属性**（去掉平台元数据），
是"这种节点到底该怎么配"最可靠的来源（组件目录里的 `initialValue` 可能是截断的）。
**样例多半不能照抄**，工具会逐条给出提示：主机与当前环境不一致、地址是占位符、只给了 apiId、
本环境存在多个网关主机；加 `--check-registry` 还会核对 apiId 在当前环境的接口注册表里是否存在。

`flow props list` 默认返回全部属性（含平台元数据，如 `createTime` / `expireAfterIndexTime`）。
排查 SQL 场景用 `--only sql`（只留 SQL/数据库类节点）配合 `--fields sqlCode,tableName,dbConnId`（只留指定字段）。

节点属性里怎么引用上游数据（`${$.global.x}` / `${$.T0000X}` / `${字段名}`）、`apiNode` 会替换当前数据流
该怎么绕（先 `variableRuleNode` 存全局变量、再调 API）见 [FLOW-JSON-SPEC.md](FLOW-JSON-SPEC.md) §5「ESB 变量引用与数据流」。

### 5.3.1 节点数据预览（只读）

平台**没有**"对数据源执行任意 SQL"的通用端点，只有**节点级预览**：
`ESB` 按 SQL 预览（`tablereadnode/previewdata`）/ 按表预览（`tablewritenode/preview`），
`ETL` 的 `sqlreadnode` / `metadatareadnode` / `mongodbreadnode` / `elasticsearch` 各自的 `previewdata`。

```bash
rc flow preview --process-id <pid> --node-id <nodeId> [--limit 20]
```

约束（有意为之）：
- 端点是**固定白名单**，不接受调用方传路径；
- **不接受命令行传入的裸 SQL**——SQL / 表名 / 连接只取流程里已保存的节点配置；
- `limit` 默认 20、最大 100，只取前 N 行；
- 平台若回「字段配置中的字段不能为空!」→ 说明该节点在平台上没有列配置，工具会直接给出下一步
  （去设计器配字段，或用 `flow props list --only sql` 看现状）；
- 注意：预览走的是 POST 端点，**prod profile 下会被写闸门拦住**（保守行为，需要的话再说）。

`flow save` 会：本地校验 → **保存前快照** → **指纹校验** → upsert 全部节点/连线属性（ESB 批量）→ 保存图 → 清理旧属性 → 平台 `checkerror` → 回读；属性、图、校验或回读失败会自动恢复快照并删除本次写入。

**乐观并发保护（指纹）**：`flow export` 会在文件里写 `fingerprint`（图 + 业务属性的摘要）。
用这个文件 `flow save` 时，工具会先比对平台当前状态：

- 指纹一致 → 正常保存；
- 指纹不一致（别人改过这条流程）→ **拒绝写入**，提示"请重新 `flow export` 后再保存"；
- 确实要覆盖 → 加 `--force`（或 `--expect-fingerprint` 指定期望值）。

**保存前语义 diff**：dry-run 与正式保存都会输出"相对平台当前状态"的变更清单
（节点/连线/属性各自的新增、删除、变更），人一眼能看出这次改了什么。

```text
变更预览：节点 +1/-0/~2，连线 +0/-1/~0，属性 +0/-3/~1
节点：
  + 新增 T00002
  ~ 变更 G00001
属性：
  - 删除 R00007
```

`flow props save` 只改属性：同样先快照再 upsert，任一节点失败会回滚到快照（删除本次写入、恢复原属性）。属性写入是幂等的——先读回既有记录并带 `id` 提交，历史遗留的重复记录会被按记录 id 清理。

属性文件支持两种等价格式，CLI 与模板共用同一个归一化函数：

```json
{
  "T00001": { "pNodeId": "T00001", "pNodeType": "apiNode", "apiUrl": "https://example.test/api" }
}
```

```json
[
  { "nodeId": "T00001", "nodeType": "apiNode", "props": { "apiUrl": "https://example.test/api" } }
]
```

ETL 与 ESB 都要求图上每个节点和 router 有属性记录；ETL 的 `node/select` 不返回 router，本工具从 `processModel.linkDataArray` 补齐后再读写/导出。

> `catalog/etl-components.json` 是**可选文件**：ESB-only 部署可以不装（doctor 不失败，漂移检测忽略缺失）。
> 这种部署里 `--kind etl` 会直接报"未安装 ETL 组件目录"，请改用 `--kind esb`。

### 5.4 生命周期

```bash
rc flow list [--keyword k] [--kind esb|etl] [--app 业务应用] [--module esb|etl] [--page 1] [--size 30]
rc flow apps [--kind esb|etl]                # 业务应用清单（applicationId + 流程数）
rc flow get <pid> [--kind esb|etl]
rc flow export <pid> [--kind esb|etl] [--out flow.json]
rc flow versions <pid> [--kind esb|etl]
rc flow restore-version <pid> --version-id <id> [--kind esb|etl] [--apply]
rc flow clone <pid> [--name n] [--kind esb|etl] [--apply]
rc flow publish <pid> [--kind esb|etl] [--apply]
rc flow publish <pid> --url <网关路径> --name <接口名> [--app-id <应用>] [--method POST] [--apply]  # 发布成接口（草稿→上线两步）
rc flow run <pid> [--kind esb|etl] --apply            # 真跑一次流程（会触发外部调用/写库）
rc flow run-log <transactionId> [--kind esb|etl]     # 节点级运行记录（入参/出参/断言）
rc flow schedule list | save --process-ids "id1,id2" [--cron "0 0 * * * ?"] [--apply] | delete <ruleId>
rc flow delete <pid> [--kind esb|etl] [--apply]
```

- 平台列表接口默认只回 20 条（`total` 可能更大）；`flow list` 会拉全量后按 `--keyword/--app` 过滤并在客户端分页。
- **两个"应用"字段含义不同，不要混用**：
  - `applicationId` = **业务应用**（形如 `<appId>`）→ `rc flow list --app <appId>`；
  - `appId` = **平台模块**（恒为 esb / etl）→ `rc flow list --module esb`。
  平台没有"业务应用"接口（`rc apps` 列的是平台模块），业务应用清单用 **`rc flow apps`**（从流程的 `applicationId` 聚合）。
- `flow list` 输出的行字段：`processId`、`configId`、`configName`（`processName` 是它的别名）、
  `applicationId`（业务应用）、`appId`（平台模块）、`state`、`categoryId`、`createTime`、`editTime`。
- `flow export` 输出 `{kind, processId, model, props, fingerprint}`，可直接作为 `flow save` 的 `--file`；
  若导出的流程本来就缺必填属性，会额外写 `skeleton: true` 与 `missingRequired`（校验/保存只提示不阻断）。
- 删除前强制快照，**不先清属性**；删除使用平台 Mongo id + processId 双 id，并轮询详情。列表索引有延迟，以 `flow get` 是否成功为准。
- 版本恢复前同样强制快照，避免恢复错版本后无法回退。

### 5.4.1 已知限制

- `flow list` 仍是**全量扫描**：平台的 `keyword` 参数不可用，只能拉全量后客户端过滤；
  命中够当前页时会提前停止翻页（省请求），但"总数"在提前停止时是已命中数（输出里会标注）。
  流程量到几千条以上时，建议先用 `--app` 缩小范围。
- 保存顺序是**先属性、后图**：平台的 `checkerror` 要求属性已存在，无法反过来；
  中途失败靠"快照 + 自动回滚"兜底（图恢复、删除本次写入、写回原属性）。

### 5.4.1 发布成接口 / 调度（平台有、工具补齐的两条尾巴）

**发布成接口**：`rc flow publish <pid> --url <网关路径> --name <接口名> [--app-id <应用>] [--method POST] --apply`。
平台没有"一键发布"端点，工具自动做两步（实测）：
① `POST /rest/core/services/save`（`state:'0'` 草稿态）→ ② 再存一次（`state:'1'` 上线态），
最后回读 `services/{id}` 确认 `state=1`。**只建草稿的话，接口存在但调用恒 500。**

**调度规则**：`rc flow schedule save --process-ids "id1,id2" --cron "0 0 * * * ?"`。
坑：`processIds` 必须是**逗号分隔的字符串**（传数组会被序列化成一个元素）。
平台的"启用"没有可用端点（`rule/start` 恒报"启动失败"），所以工具只负责建规则，并提示还需人工启用。

### 5.5 模板

```bash
rc templates list
rc templates show sync-api --out model.json --props-out props.json
rc templates validate
```

29 个标准模板全部通过本地静态校验，清单见 [TEMPLATES.md](TEMPLATES.md) §3；
其中 27 个已完成测试环境创建/保存/平台校验。

## 6. 数据源、ETL、监控（排查 + 配置）

```bash
rc datasource list
rc datasource get <id>
rc datasource test <id>
rc datasource save --file datasource.json [--apply]

# ETL：只读
rc etl list [--keyword k]
rc etl get <id>
rc etl compensate-plan [--process-id <pid>] [--transaction <tid>...] [--state FAIL]

# ETL：写路径默认封禁（需 RC_ENABLE_ETL_WRITE=1）
rc etl run <processId> [--mode test|full] [--limit 100] [--apply]
rc etl compensate [--process-id <pid>] [--transaction <tid>...] [--apply]

rc ops summary
rc monitor summary [--hours 24]
rc monitor logs <serviceId>
```

- **ETL 写路径默认封禁**：ETL 是否开通由平台决定。`etl run` / `etl compensate --apply` 在未设置
  `RC_ENABLE_ETL_WRITE=1` 时直接报 `E_FORBIDDEN`（退出码 6），不要重试、不要绕过；
  只有确认平台已开通 ETL 能力的环境才由管理员打开该开关。
- `etl list` **不保证完整**（平台未开通 ETL 时列表可能为空或残缺），只能当参考，不能作为排查清单。
- ETL 补偿单位是 **transactionId**，不是 processId；先 plan，确认后 apply。
- `etl run --mode full` 属于全量写操作，务必先确认目标环境。
- 数据源保存默认 dry-run；密码字段不要写入仓库文件。

## 7. 连接器配置

```bash
rc connector apps
rc connector configs --config-type <t>
rc connector get <id>
rc connector docs --config-type <t>
rc connector export --config-type <t> -o conn.json
rc connector import --file conn.json [--apply]
```

连接器配置用于平台集成对象的读取、备份和迁移；`import` 默认 dry-run。

## 8. 目录、错误、血缘（排查）

```bash
rc catalog sync --source <前端源码目录>
rc catalog search <keyword> [--module m] [--json]
rc catalog fingerprint [--write] [--out file]
rc catalog drift [--file baseline.json]
rc catalog controllers [keyword]
rc catalog nodes [--kind esb|etl] [keyword]
rc catalog expression
rc catalog errors [keyword]
rc error explain "<平台错误文案>"

rc lineage table <tableName> [--direction in|out]   # 空结果会给出原因（没人写这张表 / 血缘索引没建）
rc lineage datasource | apps | meta
rc lineage api --id <apiId> [--deep]
```

- `catalog drift` 与 `catalog/fingerprint.json` 对比；平台升级后先跑它。
- `catalog/components.json` 是**静态快照**（随仓库维护）：组件参数里的 `initialValue` 可能被截断，
  **不要**拿它当"正确写法"；用 `rc flow search --node-type <type>` 看真实流程里怎么配。
  `rc catalog sync` 需要前端源码侧的提取脚本，该脚本未随本版本发布（命令会明确提示）。
- `error explain` 按“精确文案 → 包含匹配 → 规则 → HTTP 兜底”返回原因与修复步骤。
- 错误目录当前 712 条精确映射、21 个分类、39 条兜底规则。

## 9. 安全与运维

```bash
rc doctor [--connect] [--datasources] [--json]

rc snapshot <api|esb|etl> <id> [--dir <dir>]     # 默认 ~/.rc/snapshots
rc restore <snapshot.json> [--apply]
rc audit list [--since 24h] [--path substr] [--actor a] [--writes] [--limit 50] [--json]
rc audit tail [--lines 20] [--json]
rc audit summary [--since 7d] [--json]
rc upload <path> --file <local> [--field file] [--apply]
rc call <path> [-X GET|POST] [-d json|@file] [--apply] [--json]
rc call form <path> --form k=v,k2=v2 [--content-type x] [--apply]   # 表单提交
```

- `doctor` 检查：目录完整性/漂移、目标与写闸门、审计目录；`--connect` 再检查登录态、应用、流程、数据源。
- **表级血缘（`rc lineage table`）依赖平台侧血缘索引**：索引没建/没同步时一律返回空。
  工具会说明"没人写这张表"和"索引没建"两种可能；想自己核对，用 `rc flow list --keyword <表名>`
  找到流程后 `rc flow export` 看流程里是否真的引用了它。
- 平台侧的已知限制（`checkerror` 偏松、属性索引延迟、删除异步、批量属性 body 形态…）见
  [PLATFORM-NOTES.md](PLATFORM-NOTES.md)。
- `snapshot` / `restore` 用于写前快照与回滚；`restore --apply` 是写操作。
- `call` 是受控逃生通道；默认 dry-run，路径必须明确。
- 流程类写操作（`flow save` / `flow props save` / `flow delete` / `flow restore-version`）都会**先快照**到 `~/.rc/snapshots`（可用 `RC_SNAPSHOT_DIR` 改目录），快照文件权限 `600`。
- 本地状态会一直涨（快照 / 审计 / 节点集合）：`rc local prune [--snapshot-days 30] [--audit-days 90] [--node-days 30] [--apply]`
  先预览再删（默认只统计，`--apply` 才真删）。
- 目标主机可用 `RC_ALLOWED_HOSTS` 限制；凭据可用 `RC_KEYCHAIN=1` 从系统钥匙串读取。
- **审计可查**：写操作会落 jsonl 审计（`RC_AUDIT_DIR` → `RC_HOME/audit` → `~/.rc/audit`），
  记录操作者、profile、方法、路径、状态、traceId，以及关键标识（`processId`/`ids`/`configId`…）。
  `rc audit list|tail|summary` 可查"谁在什么时候改了哪个流程"；`--since 24h|2d|2026-10-21` 支持相对与绝对时间。
  `rc audit list` 的 `--limit` **默认 50**（显示最后 N 条，JSON 输出里也带 `limit`/`shown`），要拿全加 `--json`。
- `catalog/etl-components.json` 是可选文件：ESB-only 部署可不装，`doctor` 与漂移检测都忽略它的缺失。

### 9.1 真实环境验收脚本

```bash
# 流程生命周期：创建 → 保存（对象/数组属性）→ 回读 → 导出 → 属性单独保存
# → 列表过滤 → 故意写坏并断言自动回滚 → ETL dry-run → 删除（带快照）→ 二次删除保护
RC_BASE_URL='https://<test-host>/restcloud' RC_USER=... RC_PASS=... \
  npm run flow:verify -- --allow-host <test-host>

# 稳定性门禁：连续跑 20 次，任何一次失败即失败（区分"索引延迟"与"真坏了"）
RC_BASE_URL='https://<test-host>/restcloud' RC_USER=... RC_PASS=... \
  npm run flow:verify:stability -- --allow-host <test-host> --runs 20

# API 域：分析 → 导入 → 列表/详情回读 → 下线 → 删除 → 确认消失（临时资源自动清理）
RC_BASE_URL='https://<test-host>/restcloud' RC_USER=... RC_PASS=... \
  npm run api:verify -- --allow-host <test-host>

# 模板全链路：创建 → 保存 → 平台校验 → 删除
RC_BASE_URL='https://<test-host>/restcloud' RC_USER=... RC_PASS=... \
  npm run templates:verify
```

写测试必须**显式放行目标主机**：`--allow-host <host>`（可重复）或 `RC_ALLOW_WRITE_HOSTS=host1,host2`；
`RC_PROFILE=prod` 一律拒绝。脚本不内置任何环境地址，报告写入 `reports/`（已 gitignore，内容不含目标地址与凭据）。

仓库还带一条手动触发的真实环境流水线：`.github/workflows/live-verify.yml`（凭据走仓库 Secrets）。

### 9.1.1 SQL 校验与取数

```bash
rc sql check --conn <dbConnId> --query "SELECT ..."   # 验表/列/语法（平台会真跑一次只读 SELECT）
rc sql query --conn <dbConnId> --query "SELECT ..."   # 真取数并渲染表格
```

- 只接受只读语句；`INTO OUTFILE/DUMPFILE`、`FOR UPDATE`、`LOCK IN SHARE MODE` 会被拒绝。
- 平台的解析端点**会执行**这条 SELECT；**结果集为空会被平台当成失败** → 工具单独归为 `no-data`（合法但没数据）。
- 流程里的 `${condition}` / `${offset}` / `${ids}` 是平台占位符，解析前会先归一（否则必然报语法错）。
- 取数端点的返回体是 `{rowsData, columns, total}`，`tableColumns` 必须是 **JSON 字符串**（传数组报 MalformedJ array）。
- `sql query` 的输出含**真实业务数据**，别贴进工单或仓库。

### 9.2 Docker 镜像

```bash
docker build -t ai-automation .

docker run --rm --env-file .env ai-automation rc --help     # CLI
docker run --rm --env-file .env ai-automation rc doctor --connect
```

- 入口脚本 `bin/docker-entrypoint.sh`：`rc` → iPaaS CLI、`dw` → 数仓 CLI，其它参数按
  `node --experimental-strip-types <路径>` 执行（例如 `scripts/verify-flow-lifecycle.mjs`）。
- 镜像只装生产依赖，并带上 `catalog/`、`docs/`、`skills/`、`scripts/`；不含任何平台地址与凭据。
- CI 会构建镜像并做冒烟（`rc --version` + `doctor`），Dockerfile 坏掉会立刻发现。

## 10. 配套 skills

CLI 是机器接口，skill 是**给 Agent 的操作手册**——两者一一对应，改 CLI 必须同步改 skill。

| skill | 服务对象 | 路径 |
|---|---|---|
| `ipaas-ops` | `rc` | `skills/ipaas-ops/SKILL.md` |
| `dw-ops` | `dw` | `skills/dw-ops/SKILL.md` |

skill 里写的是"什么时候用哪条命令、失败先看什么、什么绝对不能做"，不重复命令语法（语法看本文档）。

写操作一律默认 dry-run，确认后追加 `--apply`；先读后写、先校验后保存。
ETL 写路径（`rc etl run` / `rc etl compensate --apply`）在未设置 `RC_ENABLE_ETL_WRITE=1` 时直接报 `E_FORBIDDEN`。

## 11. 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 成功 |
| `3` | 认证或权限失败（`E_AUTH`） |
| `4` | 参数/用法或平台返回失败（`E_VALIDATION`） |
| `5` | 上游/快照/审计失败（`E_UPSTREAM` / `E_SNAPSHOT` / `E_AUDIT`） |
| `6` | 危险操作被拒绝（prod 只读、缺少 `--apply`、ETL 写路径封禁 `E_FORBIDDEN`） |

具体以 `RcError.code` 与 JSON 输出的 `error` 字段为准。

## 12. 测试与覆盖率

```bash
npm test           # 单测（含 CLI 行为测试，不触网）
npm run test:coverage   # 覆盖率 + 阈值门禁：行 ≥95% / 分支 ≥90% / 函数 ≥95%
```

- 阈值针对 `packages/core` 的逻辑层：每行代码都被单测直接调用；
- CLI 由行为冒烟覆盖（子进程跑真实入口），分支覆盖率不计入阈值。
- CLI 由行为冒烟覆盖（子进程跑真实入口）；它的分支覆盖率低但行为被断言，因此不计入阈值。
- `npm run typecheck` 现在也会类型检查 `tests/`（新增 `tests/tsconfig.json`）。
- CI 步骤：typecheck → 单测 → **覆盖率门禁** → 模板生成 → Docker 镜像构建 + 冒烟 → 敏感信息扫描。

## 12. 不在当前范围

- 任何图形界面、Web 控制台、交互式 TUI；
- 审批工单、许可分层、定价/销售、SSO 商业对接；
- 权限 IaC、团队协作、审计报表、支持包；
- 批量任务编排（ETL 补偿内部仍复用批量执行器，但不暴露 `batch` 命令）。

`approval-flow` 模板仍然保留，它表示**业务流程里的平台人工作业节点**，不是本工具的审批能力。
