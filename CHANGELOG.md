# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。只提供非交互 CLI 入口（`rc` / `dw`），不提供 MCP。

## [Unreleased]

### 新增

- `rc flow run <pid> --params '<json>'`：把 JSON 字段作为顶层字段传给 `/process/run`，
  对应流程里的 `${$.http.xxx}`（之前只能 `rc call` 手拼 body）。
- `flow save` / `flow props save` 保存含 `javaCodeNode` 代码时会打印提醒：平台不会随保存自动编译，
  必须在节点编辑器点『编译』；多实例部署下编译类可能不一致（实测会交替命中旧类）。

### 修复

- **`rc flow run` 选错运行端点**：原实现只调 `monitor/instance/run`，部分平台版本对未产生过实例的流程
  直接返回 500 `Service run exception`（且不创建实例）。改为先走 `POST /rest/esb/process/run`
  （设计器/流程列表的"运行"，同步执行并返回 `transactionId`），404/网络失败/5xx 时回退监控端点；
  4xx 业务错误不回退，避免同一流程被执行两次。
- **运行结果被判成失败**：`/process/run` 成功时仍返回 `state:false`，真正结论在 `resultCode=1`
  或 `msg` 的"是否成功=是"里。新增归一化，避免 CLI 把成功运行打印成 `✖` 并以非 0 退出。
- **定时调度只有 BPM 一条路**：`/bpm/rules/*` 在部分环境整个不可达（平台自身返回
  `{"errcode":500,"msg":"connect timed out"}`）。`rc flow schedule save` 现在会自动降级为
  "写流程记录 `expression`/`runExpression`（`POST /rest/esb/process/save`）→ `POST /rest/esb/process/start`"，
  建完即生效；`rc flow schedule list` 同步降级为读流程记录。成功判据为"表达式回读正确 + Quartz 任务存在"，
  "已在运行中"视为已达成。
- **截断输出冒充完整 JSON**：`emit` 非 `--json` 分支把大对象截断到 6000 字符后会直接打印半截 JSON，
  重定向到文件无法解析。现在截断时明确提示"用 `--json` 取完整内容"。

## [0.5.0] - 2026-10-22

重构为**双域 CLI**：`rc`（RestCloud iPaaS）+ `dw`（Apache Doris 数仓）。

### 变更

- **下掉 MCP**：删除 `packages/mcp/`、`bin/mcp.mjs`、`rc-mcp` 入口、MCP 相关单测与文档章节。
- **运行时依赖归零**：`@modelcontextprotocol/sdk` 与 `zod` 仅为 MCP 使用，一并移除。
- 新增数仓域 `dw`：配置/隧道/传输/查询闸门/脱敏/MV 自查/刷新调度/灰度换名/DDL 漂移/血缘。
- 新增 `skills/dw-ops/SKILL.md`；`skills/ipaas-ops/SKILL.md` 同步改为"只通过 CLI"。
- 敏感扫描升级为 `scripts/sensitive-scan.mjs`（双域特征 + **外部词表**，词表本身不进仓库），
  新增 `npm run scan` / `npm run scan:staged` / `npm run scan:history`。

### 开源前加固（本轮）

**敏感扫描（"内部信息不上公开仓库"的那道闸）**

- **扫描范围原先只覆盖已跟踪文件**——新写的文件在 `git add` 之前既没进版本库也没被扫过，
  正好是"夹带东西一路 push 上去"的窗口（本次新增的整个 `dw` 子域就落在里面）。
  默认范围改为 **全部可发布文件**（已跟踪 + 未跟踪未忽略）。改动当天就抓出一处内网 IP 夹具。
- **新增 `--history`**：扫 git 历史里出现过的每个 blob。文件改掉之后旧版本仍在对象库里，
  push 上去照样能 `git log -p` 翻出来——**"当前树 clean"不等于"仓库 clean"**。
- **新增 `--dir <path>`**：走目录树、不走 git，用于扫导出的副本 / 构建产物。
- 新增凭据特征：各家云/平台 token 前缀、PEM 私钥、JWT、`Authorization` 头、
  带凭据的连接串（含 `postgres/redis/amqp/clickhouse`）、本机绝对家目录路径、
  以及**硬编码口令赋值**（`password="真值"`）。
  口令特征刻意排除占位写法（`<secret>` / `${VAR}` / `***` / 正则字面量里的 `\*\*\*`）
  与 `identitytoken` 这类子串误伤——**error 级发现误判会直接阻断换名，宁可漏也不错杀**。
- **不再整体豁免 `.github/workflows/`**（原先那是个洞：workflow 里塞个 secret 永远扫不出来）。
  豁免名单收窄到两条（扫描器自身 + 它的单测），并加断言禁止整目录豁免、禁止名单被扩。
- 不在 git 仓库里时给**可行动**的错误（而不是把 git 的 `fatal:` 抛给用户）。
- 新增 55 条单测（含"扫描器源码必须对自己 clean"的自指安全回归）。

**闸门与脱敏（写单测时发现的真缺陷）**

- **`dw query` / `dw explain` 的只读闸门排在"解析环境"之后**：没配环境时用户先看到
  "没有可用环境"而不是"这条 SQL 被拒"，安全判定还发生在连接建立之后。闸门提到最前。
- **`redact()` 原先只按键名打码**：`{ sql: 'CREATE CATALOG ... PROPERTIES("password"="…")' }`
  会**原样落盘**——键名是 `sql`，不敏感，但值里带着密码。新增值内赋值抹除（含带空格的引号值）。
- **审计的脱敏绑在 `FileAuditSink` 上**：换个 sink（内存/上报/第三方）明文就漏出去。
  改为在 `auditDwWrite()` 入口先 `redact()`——脱敏是入口的责任，sink 只负责搬运。
- 审计条目补记**打码后的 host**：只记环境名的话，纯环境变量启动时事后根本分不清写的是生产还是测试。

**工程与 CI**

- **`package-lock.json` 与新增的 `dw-cli` workspace 不同步 → `npm ci` 直接失败**。
  这会让每一次全新克隆和 CI 的镜像构建都挂掉（Docker 构建实测暴露）。
- CI：敏感扫描提到**最前**（最便宜、命中即止），新增历史扫描步骤，加 `concurrency` 与最小 `permissions`。
- 新增 `.githooks/`（pre-commit 扫暂存区；pre-push 扫可发布文件 + 历史），
  `npm ci` 通过 `prepare` 自动接上；零依赖，不引 husky。
- `bin/rc.mjs` / `bin/dw.mjs` 补 `error` 事件处理：spawn 失败时原先只发 `error` 不发 `exit`，
  进程会**静默挂住**（CI 里表现为卡死，比报错难查）。
- 新增 `.gitattributes`（统一 LF；没有它 Windows 上 checkout 会把 `.sh` 换成 CRLF，
  容器里 `/bin/sh` 直接 `not found`）。
- 新增 `SECURITY.md`（安全模型、已知取舍、如何报告漏洞）与 `docs/ARCHITECTURE.md`（设计取舍）。

**测试**

- 新增 `dw` CLI **子进程冒烟**（25 条）：帮助里列出的每条命令都真的接上了分支、
  参数错误与闸门拒绝的退出码与文档一致、写操作默认 dry-run 不谎报成功、
  `--reveal-host` 之外的输出不回显完整 host、**凭据文件里的密码不出现在任何输出**。
- 新增脱敏单测 14 条、审计凭据单测。
- 修掉 4 条**依赖 git 的测试**：源码 tarball 解出来没有 `.git`，那时 `npm test` 必须照样全绿
  （测试依赖 git = 下载源码的人跑不过测试）。
- 测试夹具里的口令统一改成 `'<secret>'` 这类占位形式——既避免被扫描器当成真值，
  也让"这是夹具"一眼可见。

### 数仓域（dw）· 新增能力

- **连接**：多环境配置 + 凭据分文件（`~/.dw`，与 `~/.rc` 隔离）；FE HTTP（原生 `fetch`）与
  外部命令两种传输；**SSH 隧道自研**（官方 CLI 只有 SOCKS5）——探活看端口不看进程、
  重建前按特征串精确清残留、休眠断线可重建。
- **只读闸门**：只放行单条 `SELECT/WITH/SHOW/EXPLAIN/DESC`，**拒多语句**，
  拒 `INTO OUTFILE`/`FOR UPDATE`/`LOCK IN SHARE MODE`；无 LIMIT 时只给 SELECT/WITH 注入。
- **脱敏**：结果列、DDL 连接属性、host 默认打码；`--raw` / `--reveal-host` 才回原值。
- **MV 运维**：清单/状态（`mv_infos` 表函数，3.1.4 无 `SHOW MATERIALIZED VIEWS`）、
  真实相位（只信 `tasks()`）、定义读取、刷新、调度、冻结、**灰度换名全流程**。
- **治理**：DDL 漂移（注释/限定名/空白/自动属性全部抹平后再比）、依赖链路 + **ON COMMIT 高危清单**、
  相位错峰体检（同分钟 / 实测耗时撞车 / 依赖倒置）、分区分桶体检、分区滚动清理、慢查询与 profile 诊断。
- **知识固化**：`dw mv lint` 把 13 类线上踩过的坑做成可执行断言（库名限定、STARTS 过期、
  DECIMAL 除法提升、BUILD 方式被带过去、分区 MTMV 的 UNION/CTE 锚点/VIEW/自连接限制…）。
- **增量退化诊断**：`dw mv refresh-mode` 直接读 `tasks()` 的 `RefreshMode` / `NeedRefreshPartitions`
  判"分区 MTMV 的增量退化成了全量"，附根因（非 excluded 基表按整表版本判脏）与
  `excluded_trigger_tables` 处置；**`NOT_REFRESH` 与"只有一个分区"都判为正常，不报降级**。
- 写操作统一 dry-run + 审计（`~/.dw/audit/`）；`DW_PROFILE=prod` 只读闸门对**所有来源的环境**生效。

### 数仓域 · 实测修正（对着线上 FE 核出来的，不是从文档抄的）

- **FE HTTP 的请求体必须是 JSON `{"stmt": …}`**：发裸 SQL 会被当 JSON 解析并回
  `Expected BEGIN_OBJECT but was STRING`（看着像 SQL 语法错误，实际是 body 形状）。
- **响应是位置式 `result_set`**（`meta` 给列名、`data` 是数组的数组），不是列式对象；
  按列式解析会得到 `type/meta/data/time` 四个假列。
- **失败时 `msg` 常常只有 `"Error"`，真原因在 `data` 里**——只看 `msg` 等于什么都没看到。
- **`SHOW … LIMIT` 不合法**（`mismatched input 'LIMIT'`）。
- **`DataSize` 是人读字符串**（`"4.108 GB"`）：直接 `Number()` 会静默变 `undefined`，
  整条分桶体检因此失效。
- **`SHOW CREATE` 回两列**（名字 + 定义），且会把 SELECT 体里的注释原样存下来（常压成行内形态）；
  漂移比对两边都要剥注释，否则 114 张里会报 39 张假漂移。
- **`table not found` 也是"线上缺失"**的一种措辞（原先只认 `not exist`）。
- **FE HTTP 端点可执行 DDL**（实测通过）；`dw doctor` 用零副作用的
  `DROP TABLE IF EXISTS <探测表>` 探测，且执行前先确认该名字不在表清单里。

### 数仓域 · 修掉的安全/正确性缺陷（写单测时发现的）

- `DW_PROFILE=prod` 原先只对**环境变量**来源的环境生效；配置文件 + `DW_PROFILE=prod` 会静默允许写入。
  现在只读闸门只有一个判断点，对所有来源生效。
- `environments` 写成数组时不报错（数组也是 `object`），会静默产出空环境。
- 依赖图的节点集合原先取自"读成功了几张 DDL"：某张 DDL 读失败会让它从图里消失，
  连"被别人读"这条边一起丢 → 换基表时漏下游。改为以清单为准。
- `extractTableRefs` 把三段式里的**库名**也当成一张被读的表，图里会出现幽灵节点。
- 分桶体检里"缺 DataSize"的判定顺序反了，导致"缺桶数"永远被报成"缺 DataSize"。
- `SHOW CREATE` 挑错列会把视图名当 DDL 返回（看起来成功、内容是个表名）；现在校验内容像 DDL。
- 依赖倒置原先一律报 `error`；上游是维表时降级为 `warn`（维表变化慢，滞后通常无害），
  否则一个库里几十处"维表滞后"会把真问题淹掉。

### 只读闸门与写操作真实性（本轮）

**只读闸门（rc 的 `sql check` / `sql query` 与 dw 的查询闸门共用一份判定）**

- 修掉两处绕过：`WITH c AS (…) INSERT INTO …`（CTE 是任意 DML 的合法前缀）、
  MySQL 可执行注释 `/*! ; DROP … */`（里面的分号真会执行，原来被当注释剥掉）。
- 同时修掉两处**假阳性**：`SELECT REPLACE(name,'-','')`（`REPLACE` 是字符串函数）、
  `SELECT * FROM t USE INDEX(i)`。判定从"写关键字黑名单"改为"只看主语句的动词"。
- `EXPLAIN` 不再被补 `LIMIT`（改了正文，解释的就不是原语句了）。

**写操作**

- **失败也要留审计**：`mv swap-apply` / `partition rolloff` 原来无条件记 `ok: true`，
  且失败时根本走不到审计那行——"换名改了一半"在审计里查不到。
- **换名生效自证**：第 3 步是 `USE db; ALTER … REPLACE WITH …` 多语句请求
  （拆不开：FE 的 REST 端点无会话），返回结果只反映最后一条。
  换名后比对目标定义是否真的变了，逐字未变即硬失败。
- **高危清单不许静默为空**：`mv phases` / `mv lineage` / `mv swap-plan` 在读不到
  DDL 或 tasks 时不再报"✔ 未发现"，改为列出缺口并让退出码非 0；
  `swap-apply` 在 ON COMMIT 清单未知时阻断 `--apply`（需显式 `--force`）。

**入口与参数**

- `--readonly` 接上（文档承诺过，`OPTIONS` 里没声明 → 照文档写命令的人拿到的是退出码 2）。
- 数值参数范围统一校验：`--hours=-1` / `--limit 0` / `--depth=-1` 原来会原样进 SQL。
- 两个 CLI 的 `parseArgs` 失败都包成参数错误口径（不再是 Node 原文 + 退出码 2）。
- `dw tunnel up` 失败时过滤 OpenSSH 噪声告警（post-quantum 横幅曾把真实原因
  `Address already in use` 淹掉），关键行置顶并给可执行下一步；
  `tunnel status` 明说"这条隧道不是 dw 起的"；`tunnel down` 回报端口是否仍在监听。
- `dw mv list --all-db`；缺库时报错顺带列出实例现有库。

**帮助**

- 新增命令目录（单一事实来源）：`rc <命令> --help` / `dw <命令> --help`
  给该命令的用法/选项/坑/示例，不再一律回落到顶层清单。
  rc 98 条、dw 29 条全覆盖；单测做 catalog ↔ dispatch 双向核对。

## [0.4.1] - 2026-10-21

清理：删死代码、收紧公共面、把审计裁剪接进产品。

### 清理

- 删掉未使用的导出：`SQL_PROP_FIELDS`（定义了从没被用）、`PreviewKind`（空类型）。
- 收紧公共面：只在模块内部使用的助手不再导出（`hasCustomExprRef`、`REQUIRED_FIELD_ALTERNATIVES`、
  `isSafeSql`、`normalizeSqlPlaceholders`、`globalTargetsFile`）。
- `ENUM_FIELDS` 之前定义了却没接上 → 现在真的参与 `BOOL_AS_STRING` 判定（枚举字段不再被当布尔校验）。
- `rc local prune --trim-audit-lines N`：把审计按月 jsonl 的裁剪接进产品（此前只有测试在用）。

### 检查

- 敏感项扫描：当前树 clean（CI 正则 + 私钥/连接串/口令 + JWT 形态 + 宽口径字段扫描）。
- 提交历史里仍有两处早期提交的内部主机名/逻辑库表名（当前树已无）；清洗历史需要改写全部 SHA，
  **需明确授权**后再做。

## [0.4.0] - 2026-10-21

评审回合：评审工具不再误杀、SQL 能真取数、流程的两条生命周期尾巴补齐。

### 修复

- **`rc review flow` 对任何含 apiNode 的流程都判"不通过"**：敏感字段只按字段名匹配 `token`，
  平台的 `addIdentitytoken`（是否透传身份令牌，真实流程 100% 都带）因此每条流程都出 blocker —— 评审工具直接作废。
  现在：① 平台开关类字段进白名单；② 只有"值像凭据"（非开关值/占位符/掩码）才报；
  ③ `SQL_INTERPOLATION`（`${...}` 是平台唯一写法）从 major 降为 info；
  ④ 错误分支检测同时看 `assertCondition` 与中文 label（原来只认英文 label，恒亮）；
  ⑤ `BOOL_AS_STRING` 放过空值与枚举字段（`assertionCodeType` 是 1/2 枚举，不是布尔）。
  实测：真实流程评审从"不通过"变为**通过**（blocker 0）。
- **`rc sql check` 的行为说明**：平台的解析端点**会真的执行**这条 SELECT，空结果被当成失败；
  现在空结果单独归为 `no-data`（合法但没数据），并拒绝 `INTO OUTFILE/DUMPFILE`、`FOR UPDATE`、
  `LOCK IN SHARE MODE`；流程里的 `${condition}` / `${offset}` / `${ids}` 占位符先归一再解析。
- **钥匙串凭据**：文档只给了一种条目写法，代码却先读名为 `user` 的条目 → 正式环境 CLI 一直 401
  （MCP 侧另有一份硬编码 RC_USER 把问题盖住了）。现在：`RC_KEYCHAIN_USER` / `RC_KEYCHAIN_ACCOUNT` 都能兜底用户名；
  `rc doctor` 检测不到用户名时**直接 fail** 并给修复命令（不再静默继续）；
  新增 `rc auth keychain-setup --user <账号> --pass <密码>` 一次写两条。
- **会话 token 给脚本用有坑**：文件里的 `identitytoken` 是 URL 编码的，直接当 Cookie 会 401。
  新增 `rc auth cookie` 打印**已解码**的 Cookie 头。

### 新增

- **`rc sql query --conn <dbConnId> --query "SELECT ..."`**：真取数并渲染表格。
  平台只有节点级取数端点，实测两处坑：返回体是 `{rowsData, columns, total}`（不是 data/rows），
  `tableColumns` 必须是 **JSON 字符串**（传数组报 MalformedJ array）；且**先调解析端点会污染取数状态**，
  所以先用本地推导的列名取数，列名以平台返回的为准。
- **`rc flow publish <pid> --url <网关路径> --name <接口名> [--app-id] [--method]`**：把流程发布成接口，
  自动完成"草稿态 → 上线态"第二步并回读确认（只建草稿的话接口恒 500）。
- **`rc api inparams/outparams list|save|from-json`**：参数管理。
  读 `services/{id}` 的 `paramsDocs` / `outputParamsDocs`（`inparams/list` 会回空）；
  `save` 用 `{id, paramsData: <JSON 字符串>}`；`from-json` 从 JSON 样本本地推导字段再保存。
- **`rc flow run <pid> --apply` / `rc flow run-log <transactionId>`**：ESB 侧跑流程与节点级运行记录
  （入参/出参/断言结果），不用再自己拼 `rc call`。
- **`rc flow schedule list|save|delete`**：调度规则（`processIds` 必须逗号分隔字符串）；平台的"启用"
  没有可用端点，工具会明确提示还需人工启用。
- **`rc call form <path> --form k=v`**：表单提交（`application/x-www-form-urlencoded`）。
- **`rc flow search --all/--size N/--props k=v`**：扫全量、按属性过滤（找稀有节点的写法不再要循环跑）。

### 其它

- 模板新增 `split-call-api-writeback`（拆分 → 存全局变量 → 调 API → 回写），并补「ESB 变量引用与数据流」一节。
- MCP 新增 `query_sql`（工具数 53 → 54）。

## [0.3.8] - 2026-10-21

本地状态可清理，单测不再污染真实 HOME。

### 修复

- **单测会往用户真实的 `~/.rc` 里写快照/审计/节点集合**（20 来个用例没隔离 HOME），
  跑一次测试就多一批"快照"。现在测试进程通过 `--import tests/unit/isolate-home.mjs` 把
  `RC_HOME` / `RC_SNAPSHOT_DIR` / `RC_AUDIT_DIR` 指到临时目录，跑完自动清理。
- `localStatePaths(home)` 显式给 home 时，子目录一律从它派生（之前被 `RC_SNAPSHOT_DIR` 抢走）。

### 新增

- **`rc local prune`**：清理本地状态（快照 / 审计 / 节点集合），默认**只预览**，
  `--apply` 才真删；`--snapshot-days` / `--audit-days` / `--node-days` 分别设置保留期。
  快照与审计是无上限增长的，之前没有清理入口。

## [0.3.7] - 2026-10-21

`flow search` 的样例加注解；`sql check` 的行为更正。

### 修复

- **`rc flow search` 的样例会误导人**：它是"正确写法"的来源，但样例里带着真实环境的东西
  （网关主机、`${...}` 占位符、**别的环境**的 `apiId`）。现在每条样例都带注解：
  - 样例 `apiUrl` 的主机与当前平台主机不同 → 「多半是网关地址，照抄前先确认该主机在当前环境可达」；
  - 样例 `apiUrl` 指向当前平台主机 → 「仍要按当前环境重新确认路径与凭据」；
  - `apiUrl` 是占位符写法 → 「由平台在运行时替换，照抄没有意义」；
  - 只给了 `apiId` → 「换环境时这个 id 会失效，要重新取」；
  - 本环境出现多个网关主机 → 「用哪个要看流程归属，别默认取第一个」。
- **`rc sql check` 的行为更正**（实测发现之前的说法不对）：平台的 `parsesql/columns` **会真的执行这条 SELECT**
  （返回真实结果集的列清单），而且**结果集为空会被平台当成失败**（「SQL语句执行时未发现数据」）。
  现在：① 文档与提示改口为"平台会真跑一次只读 SELECT"；② 空结果单独归为 `no-data`（合法但没数据），
  不再算 SQL 错误；③ 额外拒绝 `INTO OUTFILE/DUMPFILE`、`FOR UPDATE`、`LOCK IN SHARE MODE` 这类
  有副作用/加锁的写法；④ 流程里的 `${condition}` / `${offset}` / `${ids}` 占位符先归一再解析
  （平台占位符展开成一整串 `AND ...`，不是裸布尔——不归一必然报语法错）。

### 新增

- `rc flow search --check-registry`：顺带核对样例里的 `apiId` 在**当前环境**的接口注册表里是否存在，
  查不到就标注「多半是别的环境的 id」。

## [0.3.6] - 2026-10-21

排查体验的最后一档：dry-run 口径、SQL 校验、API 列表过滤、节点写法参考。

### 修复

- **dry-run 不再打印"成功"**（最重要的一条）：`flow create` / `flow save` / `flow props save` /
  `flow delete` / `flow clone` / `datasource save` 在**没有 `--apply`** 时以前照样打 "✔ 流程已创建 / 保存完成"，
  而实际什么都没写。现在统一打 **【dry-run】未写入（…）+ 将要发生的请求**，`--apply` 才是 "✔ 成功"；
  JSON 输出增加 `dryRun` 字段。
- **`api list --app/--keyword` 之前是失效的**：平台 `/rest/core/services` **忽略** appId/keyword
  （传什么都回同一批），而且认的是 `pageNo/pageSize`（我们之前传 `page/size`，等于永远拿第一页 20 条）。
  现在按 `pageNo/pageSize` 翻页拉全量后**客户端过滤 + 客户端分页**，并支持 `--page/--size`。
- **参数类型不对时报不透明的 500**：`rc datasource test <configId>` 之前直接打到平台回 500。
  现在本地先校验：认出这是 configId 就直接告诉你"对应的 id 是 xxx"。
- **EXPR_UNDECLARED 误报**：`$.data` 是平台惯用值（`dataSplitNode.dataFieldId`、`pageDataJsonPath` 等
  到处都有），却每次都触发"可能引用不到上游字段"的警告——纯噪声。现在只对非惯用的 `$.xxx` 告警。
- **指向不存在的命令**：doctor 的修复动作提示里写的 `npm run catalog:merge-war / catalog:components /
  catalog:etl` 三个脚本并不存在；`rc catalog sync` 依赖的提取脚本也没随版本发布。提示已改成真实可执行的动作，
  缺失时明确说明"目录文件是随仓库维护的静态快照"。

### 新增

- **`rc sql check --conn <dbConnId> --query "SELECT ..."`**：把 SQL 交给平台**按真实数据源连接**走一遍，
  能精确报出"列不存在 / 表不存在 / 语法错误"并返回列清单。MCP 对应 `check_sql`（工具数 52 → **53**）。
  只接受只读语句（SELECT/WITH/SHOW/EXPLAIN/DESCRIBE），并拒绝 `INTO OUTFILE/DUMPFILE`、`FOR UPDATE`、
  `LOCK IN SHARE MODE` 这类有副作用/加锁的写法。
  平台**没有**"执行任意 SQL"的通用端点；直接取数请用 `rc flow preview`（节点级预览）。
  > 实测更正：平台的 `parsesql/columns` **会真的执行这条 SELECT**（返回真实结果集的列清单），
  > 且**结果集为空会被平台当成失败**（"SQL语句执行时未发现数据"）——工具把这种情况单独归为
  > `no-data`（合法但没数据），不算 SQL 错误。
- **`rc flow search --node-type <type>`**：按节点类型扫描真实流程，把命中节点的**业务属性**（去掉平台元数据）
  列出来。组件目录里的 `initialValue` 是截断的（`apiUrl` 就是），真实流程才是"正确写法"的可靠来源。
- **模板 `split-call-api`**：拆分循环 → 调网关注册的 API → 结果映射（最常见的同步场景，之前 27 个模板都没覆盖）。
- 文档新增「怎么调网关注册的 API」：`apiUrl` = 网关地址 + `mapUrl`、`apiId` 与 `apiUrl` 必须同时给、
  `requestBodyAuto=0` + `requestBody` 用 `${字段名}` 取上游字段。

## [0.3.5] - 2026-10-21

节点数据预览（只读）。

### 新增

- **`rc flow preview --process-id <pid> --node-id <nodeId> [--limit 20]`**：预览流程里表/SQL 节点的数据。
  MCP 对应 `preview_flow_node`（工具数 51 → **52**）。
  平台没有"对数据源执行任意 SQL"的通用端点，只有节点级预览
  （ESB `tablereadnode/previewdata`、`tablewritenode/preview`；ETL `sqlreadnode` / `metadatareadnode` /
  `mongodbreadnode` / `elasticsearch` 的 `previewdata`），所以预览是**节点级**的。
- 安全约束：端点固定白名单（不接受调用方传路径）、**不接受命令行传入裸 SQL**（SQL/表名/连接只取节点已保存的配置）、
  `limit` 默认 20 最大 100、语义只读。
- 平台回「字段配置中的字段不能为空!」时（该节点在平台上没有列配置），工具直接给出下一步：
  去设计器给节点配字段，或用 `rc flow props list --only sql` 看现状。

## [0.3.4] - 2026-10-21

排查体验修正：MCP doctor 假 fail、应用语义、审计 --limit、业务应用入口、属性 SQL 视图、血缘空结果解释。

### 修复

- **MCP doctor 假 fail**：doctor 的目标解析只看 `RC_TARGET`，没回落到生效的 `RC_BASE_URL`，
  只配 `RC_BASE_URL` 时永远报 "target 缺少 baseUrl"（同进程其它检查却全 pass）。现在与 CLI 一致：
  `RC_BASE_URL` → 目标配置 → client 实际地址。
- **`--limit` 静默失效**：`rc audit list` 的文本分支写死只显示 50 条，`--limit 20000` 无效且不提示。
  现在按 `--limit` 截断（默认 50），并在 JSON 输出里给出 `limit`/`shown`。
- **血缘空结果不解释**：`rc lineage table` 返回空数组时无法区分"没人写这张表"和"血缘索引没建"。
  现在返回 `note`，写明两种可能和区分办法（`rc flow list --keyword` + `rc flow export`）。
- **应用语义混用**：`--app` 之前会回落到平台模块 `appId`，导致"业务应用"和"平台模块"两个含义混在一起。
  现在 `--app` 只按业务应用 `applicationId` 匹配，新增 `--module` 匹配平台模块。

### 新增

- **`rc flow apps`**：业务应用清单（`applicationId` + 流程数 + 所属模块）。平台没有"业务应用"接口
  （`rc apps` 列的是平台模块 esb/etl/gateway…），这是排查"某个业务应用下的流程"最直接的入口。
  MCP 对应新增 `list_flow_apps`（工具数 50 → **52**）。
- **`rc flow props list --only sql --fields a,b`**：只看 SQL/数据库类节点、只看指定字段，
  不用再自己写脚本过滤平台元数据（`createTime` / `expireAfterIndexTime` 之类）。
- **全局目标配置** `~/.rc/targets.json`：MCP 的 cwd 是宿主项目目录，把带平台地址的配置放进业务仓库不合适；
  优先级 `RC_TARGETS` > `./rc.targets.json` > `~/.rc/targets.json`。
- `flow list` 的行字段固定化（CLI/MCP 一致）：`processId`/`configId`/`configName`(+`processName` 别名)/
  `applicationId`/`appId`/`state`/`categoryId`/`createTime`/`editTime`，文档同步。

### 文档

- 明确写清：**工具不会自动加载 `.env`**；**MCP 单实例只绑定一个目标**（多环境要开多个 server）。

## [0.3.3] - 2026-10-21

API 域真实验收 + MCP 纳入行覆盖。

### 新增

- **API 域真实验收** `npm run api:verify -- --allow-host <host>`：
  生成 OpenAPI → 分析 → 导入（真实落库）→ 列表/详情回读 → 下线 → 删除 → 确认消失，
  并带清理兜底（只按本次 `categoryId`/路径前缀删，不碰其它 API）。实测 7/7 通过。
- **MCP 工具纳入行覆盖**：工具处理器从 `packages/mcp/src/server.ts` 抽到 `packages/mcp/src/app.ts`
  （`createMcpServer({client, catalog})`，依赖可注入），`server.ts` 只保留进程入口。
  新增进程内 MCP 测试：用 SDK 的 InMemoryTransport 起 client/server，按真实 JSON-RPC 调用 50 个工具，
  覆盖写路径分支（dry-run vs confirm、校验失败、平台缺属性时的"沿用现状"降级、ETL 写封禁、评审三种模型输入…）。
  `packages/mcp/src/app.ts` 行覆盖 **98.86%**、函数 99.15%（阈值现在覆盖 core + MCP）。
- 平台 API 域事实补进 `docs/PLATFORM-NOTES.md`：删除服务前必须先"下线"、服务列表的 `keyword` 不可用、
  删除后详情返回 200 + `Can't found the data by <id>`。

## [0.3.2] - 2026-10-21

回滚可靠性、并发写保护与保存前语义 diff。

### 修复

- **回滚补回读校验**：以前 `restoreFlowSnapshot` 写回后不校验，平台属性索引有延迟时
  "回滚成功"但只复原了一部分属性（实测 4 次里抖 1 次，只读到 6/14 条）。
  现在回滚后会**回读校验 + 缺失补写**（默认 3 轮），并把 `verified` 计数（复原条数/期望条数/缺失/轮数）
  写进报告；CLI 与 MCP 都会打印"回滚回读：属性 X/Y 条复原"。
- **验收脚本断言前轮询**：把"平台索引延迟"和"真的坏了"区分开——断言前轮询到条件满足，
  超时才判失败；不再出现"读早了 → 误判回滚失败"。

### 新增

- **并发写保护（乐观锁）**：`flow export` 写出 `fingerprint`（图 + 业务属性的摘要，易变字段不参与）；
  用导出文件保存时先比对平台当前指纹，不一致就**拒绝写入**并提示重新导出；
  确实要覆盖可加 `--force`（MCP 侧同样支持）。
- **保存前语义 diff**：dry-run 与正式保存都会输出相对平台当前状态的变更清单
  （节点/连线/属性各自的新增、删除、变更），CLI 打印多行明细，MCP 在 payload 里给 `diff`/`diffText`。
- **稳定性门禁脚本** `npm run flow:verify:stability`：连续跑 N 次（默认 20）流程生命周期验收，
  任何一次失败即失败，逐次结果写 `reports/flow-stability-<runId>.json`（地址脱敏）。
  实测 20/20 通过，回滚抖动消失。
- **审计可查**：新增 `rc audit list` / `rc audit tail` / `rc audit summary`
  （`--since 24h|2d|2026-10-21`、`--path`、`--actor`、`--writes`、`--limit`）；
  写操作审计里补记关键标识（`processId`/`ids`/`configId`…），可以回答"谁在什么时候改了哪个流程"。
- **平台已知问题清单** `docs/PLATFORM-NOTES.md`：把平台侧事实写清楚（`checkerror` 偏松、属性批量读索引延迟、
  批量属性 body 形态、删除异步且只认 Mongo id、ETL 无批量端点、`keyword` 参数不可用……），
  公开仓库只写事实与规避方式，不含环境信息。

## [0.3.1] - 2026-10-21

修复 CLI 侧 `flow from-nl` 的类型自动判定（0.3.0 段保持原样，不改写已发布内容）。

### 修复

- `rc flow from-nl` 不带 `--kind` 时**自动判定类型**（此前是死代码）：
  CLI 的 `--kind` 选项带全局默认值 `esb`，导致 `v.kind` 永远有值，自动判定分支永远走不到。
  去掉默认值后，"表/库 + 同步动词" 的自然语言会生成 **ETL** 草案（`sqlReadNode`），
  而不是 ESB 草案（`tableReadNode`）。显式 `--kind esb|etl` 行为不变，MCP 侧本来就没有这个问题。
- 行为变化：`rc catalog nodes` 不带 `--kind` 时不再默认只列 ESB（之前被同一个默认值影响），
  现在按文档语义返回全部（`--kind` 是可选过滤条件）。其它命令（`flow list/validate/save`、
  `lineage api`）不传 `--kind` 仍然是 ESB，行为不变。

### 其它

- 单测 657 → 658（新增 `flow from-nl` 类型自动判定的 CLI 回归用例）。
- 版本号 0.3.0 → 0.3.1（`package.json` 与 workspace lockfile 同步）。

## [0.3.0] - 2026-10-20

流程编排闭环重写：ESB/ETL 双端点族、属性格式统一、保存/删除安全、导出与列表、生产加固。

### 破坏性变更

- `rc flow save` 去掉 `--app`（业务应用只在 `flow create` 时需要），改用 `--process-id` + `--kind`。
- `rc flow build --out` 产物由**裸图模型**改为**组合文件** `{kind, model, props}`；需要裸模型时取 `组合文件.model`。
- `rc templates show --out` 同样输出组合文件，并带 `skeleton: true`（骨架模板的必填属性只提示不阻断）。
- 节点属性写入改为幂等 upsert（带既有记录 `id` 更新），并清理历史重复记录。
- `rc flow list` 拉全量后做客户端过滤/分页，输出结构变为 `{ok, kind, total, page, size, rows}`。
- 写操作默认 dry-run：core 层 `deleteFlow` / `publishFlow` / `restoreVersion` 不再默认落库，必须显式 `dryRun:false`。
- 流程快照目录由相对路径 `.rc/snapshots` 改为 `~/.rc/snapshots`（可用 `RC_SNAPSHOT_DIR` / `RC_HOME` 覆盖），文件权限 `600`。

### 新增

- **必填属性本地校验**：组件目录 `required` 标记接入 `validateFlow`（规则 13），按**节点**遍历（属性整条缺失也会报）。
  - 只强制"没有平台默认值"的字段（如 `apiNode.apiUrl`），有默认值的（`connectTimeout` 等）不强制。
  - `apiUrl` 可由 `apiId`（引用平台已配置的 API 服务）替代。
  - 额外一组**启发式必填**（字段名取自真实平台流程）：`sqlExecuterNode` → `dbConnId`+`sqlCode`，
    `jdbcWriteNode`/`tableReadNode` → `dbConnId`+`tableName`，`dataSplitNode` → `dataFieldId`，
    `gateWay` → `gatewayType`。
  - 平台 `checkerror` 偏松（缺必填属性也放行），本地是唯一兜底：缺失时 `flow save` 阻断。
  - 骨架模板（组合文件里 `skeleton: true`，由 `rc templates show` 产出）或 `--allow-missing-required` 时降级为警告；
    MCP 对应 `allowMissingRequired`。
- **`flow export` 标记骨架**：导出内容缺必填属性时自动写 `skeleton: true` 与 `missingRequired`，
  导出文件可直接作为 `flow save` 的输入（只提示不阻断）。
- **沿用平台现状**：带 `--process-id` 校验/保存时，平台本来就缺、本次也没补的必填项只警告不阻断
  （新增节点缺必填属性仍然阻断）。
- **ETL 写路径封禁**：`etl run` / `etl compensate --apply` / `etl publish` 默认报 `E_FORBIDDEN`（退出码 6）；
  只有确认平台已开通 ETL 能力的环境才设置 `RC_ENABLE_ETL_WRITE=1`。`etl list` 增加"列表不保证完整"提示。
- `rc flow export <pid>`：导出 `{kind, processId, model, props}`，可直接作为 `flow save --file`。
- `rc flow props list <pid>`：列出全部节点/连线属性（ESB 批量，ETL 逐节点降级）。
- `rc flow restore-version <pid> --version-id <id>`：恢复历史版本（恢复前强制快照）。
- `rc flow list --app/--page/--size`：按应用过滤 + 客户端分页；命中够当前页即提前停止翻页（大平台省请求）。
- MCP 新增 4 个工具（合计 52）：`export_flow`、`list_node_props`、`list_flow_versions`、`restore_flow_version`。
- 目标主机白名单 `RC_ALLOWED_HOSTS`（在 client 构造器强制，CLI/MCP 生效，支持 `*.example.com`）。
- 系统钥匙串取凭据 `RC_KEYCHAIN=1`（macOS `security` / Linux `secret-tool`），环境变量优先。
- `npm run flow:verify`：真实环境生命周期验收脚本，**需 `--allow-host <host>` 显式放行目标主机**；
  新增"故意写坏（删掉聚合网关）→ 断言平台校验失败 → 断言自动回滚且图/属性复原"的端到端用例。
- `.github/workflows/live-verify.yml`：真实环境验收流水线（手动触发 + 每天一次定时任务；凭据走仓库 Secrets）。
- `CHANGELOG.md`：从本次开始记录破坏性变更。
- Docker 镜像可用性：新增 `bin/docker-entrypoint.sh`（`rc` / `rc-mcp` / 脚本路径统一入口），
  镜像内带上 `scripts/`（容器内可直接跑验收脚本）；CI 增加镜像构建 + 冒烟步骤。

### 修复

- ETL 闭环：`kind` 贯穿 `saveFlowComplete` 与全部端点；ETL `node/select` 不返回 router，属性/快照/导出改以 `processModel.linkDataArray` 补齐。
- 并行网关误报：缺少 `gatewayType` 时不再默认"所有网关都是并行网关"；只有显式 `2/3` 才校验配对，显式 `1` 校验缺省分支。
- 属性格式统一：数组 / `nodeId` 映射 / 原始 `pNodeId` 记录 / 组合文件由同一个归一化函数处理（CLI、MCP、模板共用）。
- 保存安全：保存前强制快照，平台校验或回读失败时自动回滚（恢复图 + 删除本次写入 + 写回原属性）。
- 删除安全：删除前强制快照，**不再先清属性**；平台删除是异步的，改为"一次删除 + 轮询详情确认"，不谎报成功。
- 属性读回延迟导致的误判：回读加重试；dry-run 不再拿旧图去 `checkerror`。
- 属性重复：先读回既有记录再带 `id` 提交，ESB 走 `batch/save`，历史重复记录按记录 id 清理。
- 客户端构造器在 `baseUrl` 缺失时给出可行动提示，而不是抛 `TypeError`（`doctor` 等只读命令仍可正常启动）。
- `catalog/etl-components.json` 改为**可选文件**：ESB-only 部署可不装，`doctor` 与漂移检测忽略其缺失；
  用 `--kind etl` 时给出明确提示而不是一堆"未知节点类型"。
- 验收脚本不再按环境名硬编码：写测试必须显式 `--allow-host` / `RC_ALLOW_WRITE_HOSTS`；仓库内不再出现内部环境名。

### 校验与文档

- **测试与 CI 补齐**：单测 47 → **657**，新增 18 个测试文件（core 全模块按行/分支/函数覆盖）；
  core 覆盖率 **99.70% 行 / 96.39% 分支 / 99.09% 函数**，`npm run test:coverage` 带阈值门禁
  （≥95% 行 / ≥90% 分支 / ≥95% 函数），CI 增加覆盖率步骤；测试目录纳入 `npm run typecheck`。
- 另加 CLI / MCP 行为冒烟（子进程方式，跑真实入口，不触网）。
- 文档同步：README、AGENTS.md、docs/COMMAND-REFERENCE.md、docs/FLOW-JSON-SPEC.md、docs/TEMPLATES.md、skills/ipaas-ops。

### 顺带修掉的健壮性问题（评审/单测暴露）

- `client`：`importCookies` 遇非法 URL 编码的 token 不再抛 `URIError`（会话直接丢失）；prod 审计写失败
  **真正阻断**（`E_AUDIT`），不再只是打印"已阻断"；平台返回 `state:"false"` 字符串也判失败。
- `targets`：`RC_TARGETS` / `rc.targets.json` 形状不对时给明确错误，而不是 `undefined` 引发 `TypeError`。
- `api`：`importOpenApi` 不传 `dryRun` 时默认预览（此前同一调用在 uat 是预览、在 prod 却真写）；
  `deleteApi` 空 id 不发请求；错误信息用 `||` 兜底（空字符串消息不再显示成空）。
- `connector`：删除配置空 id 不发请求；脱敏只命中整段敏感字段名（不再误伤 `passenger`/`compass`）。
- `datasource`：`rows` 不是数组时不再崩。
- `monitor` / `operations`：单个子查询抛网络异常时降级为 `notes`，不让整个聚合失败。
- `doctor`：空字符串消息回落到 HTTP 状态码。
- `upload`：上传附件带 MIME 类型（此前 multipart part 的 Content-Type 为空）。
- `snapshot`：写完快照显式 `chmod 600`（`mode` 只在创建时生效）。
- `flow-lifecycle`：删除轮询/确认阶段的网络异常不再打断流程（按"无法确认已删除"处理，不谎报成功）；
  属性记录 `id` 不再混进业务属性。
- `nl-flow`：Kafka/SFTP 关键词判定原本是空串比较（永远 false）→ 改为按原文判定；
  ETL 批量同步改用 `sqlReadNode`（ETL 目录里没有 `tableReadNode`，此前生成的草案必然校验失败）；
  "表"字不再单独把 ESB 需求误判成 ETL。
- `etl-compensate`：分页 `total` 与 `rows` 按同一层级解析（此前嵌套形态下 total 恒为 0）。

## [0.2.0] - 2026-10-20

- 移除审批/license/授权/审计报表/支持包等对外能力，只保留 MCP + CLI 入口。
- MCP 工具收敛为 46 个，懒加载客户端修复，属性与上传鉴权走真实客户端。

## [0.1.0]

- 初始公开版本：目录检索、API/数据源配置、流程编排、ETL 补偿、血缘与排查。
