# Agent 操作约定

本仓库是给 **Claude Code / OpenCode / WorkBuddy** 等编程 Agent 用的自动化工具，两条路：`rc`（RestCloud iPaaS）与 `dw`（Apache Doris 数仓）。你通过 CLI 工作，不要给项目增加任何面向人的操作入口。

## 1. 硬性规则

1. **只保留机器接口**：不要新增 Web UI、控制台、TUI、交互式 prompt、登录页、团队协作、审批、许可、计费、SSO 商业对接。
2. **先读后写**：先 `list/get/validate/review/check`，再 `save/create/delete`。
3. **默认 dry-run**：CLI 不带 `--apply` 只预览。
4. **prod 只读**：`RC_PROFILE=prod` 时写入会被拒绝；除非用户明确要求且设置 `RC_ALLOW_PROD_WRITE=1`。
5. **破坏性操作先快照**：删除 API/流程、回滚前，先生成并展示快照/目标。
6. **不泄露凭据与内部信息**：不要把域名、IP、密码、token、连接串、逻辑库名、业务表名/MV 名
   写入代码、文档、测试、报告或提交信息。落笔前用 `npm run scan` 自查；推公开仓库前还要
   `npm run scan:history`（**改掉文件是没用的**——旧版本仍在 git 对象库里，照样能翻出来）。
   口令类测试夹具一律写 `'<secret>'`，不要写 `'super-secret'`（分不清是夹具还是泄漏）。
   内部域名/口令片段/库名/表名这类**具体值**从仓库外注入（`DW_SENSITIVE_WORDS`），**不进仓库**——
   扫描器源码里只放通用"形状"（token 前缀、私钥头、JWT、内网 IP 段），
   把具体值写进公开源码（哪怕拆开拼）等于把秘密一起公开。该填哪些类别见 `sensitive-words.example.txt`。
7. **不绕过语义**：不要用 `rc call` 替代已有结构化命令；`call` 只用于明确缺失的端点，并先 dry-run。
8. **不改平台契约**：遇到平台报错先 `rc error explain` / `rc review` / `rc doctor`，不要猜测字段。
9. **ETL 写路径封禁**：`etl run` / `etl compensate --apply` 默认报 `E_FORBIDDEN`（需 `RC_ENABLE_ETL_WRITE=1`）；
   `etl list` 不保证完整，不能当排查清单——ETL 问题走 ESB 编排与只读手段。
10. **必填属性本地兜底**：平台 `checkerror` 不校验组件必填属性，缺 `apiUrl` 之类必须在本地拦住
    （`flow validate` / `flow save` 已接入组件目录 required 规则）。
11. **数仓侧同样 dry-run + 只读**：`DW_PROFILE=prod` 且未设 `DW_ALLOW_PROD_WRITE=1` 时所有写操作被拒；
    输出默认脱敏，`--raw` / `--reveal-host` 才回原值。
12. **换名（swap）不可逆**：必须先 `dw mv swap-plan` 出清单、人工确认，再 `swap-apply`；
    清单顺序固定（刷替换源 → 换名 → **冻结旧定义** → DROP 旧副本 → **手动补 ON COMMIT 下游**），不许调换。
13. **数仓报错不要重试**：Doris 的报错基本都是 SQL 本身的问题，看 `detailMessage`，不要当瞬时故障重试。

## 2. 标准工作流

### 排查

```bash
rc doctor --connect
rc error explain "<错误文案>"
rc monitor summary --hours 24
rc monitor logs <serviceId>
rc lineage api --id <apiId> --deep
rc review flow --file model.json --production
```

先定位“环境/认证/契约/配置/编排”中的哪一层，再给最小修复动作。不要一上来改数据。

### 改配置

```bash
rc api get <apiId>
rc api save --file api.json            # dry-run，展示 request body
rc api save --file api.json --apply

rc datasource get <id>
rc datasource test <id>
rc datasource save --file ds.json --apply
```

修改前保存 `api export` 或 `snapshot`；修改后重新 `get` 校验。

### 改编排

```bash
rc flow get <pid>
rc flow export <pid> [--kind esb|etl] --out flow.json
rc flow versions <pid> [--kind esb|etl]
rc flow props list --process-id <pid> [--kind esb|etl]
rc flow props get --process-id <pid> --node-id <nodeKey>
rc flow validate --file flow.json [--kind esb|etl] [--allow-missing-required]
rc flow save --file flow.json --process-id <pid> [--kind esb|etl] [--allow-missing-required] --apply
rc flow check --file flow.json --process-id <pid> [--kind esb|etl]
```

新增节点/连线时遵守：

- 条件分支：普通节点出边 + `assertCondition=3/6`，**不要用 `gateWay`**；
- 并行分支：并行网关 → 分支 → 聚合网关（`joinNodeId` 指回并行网关）；
- 连线属性必须带 `assertionCondition`、`condition`、`sourceId`、`targetId`、`order`；
- 组件必填属性（如 `apiNode.apiUrl`）不能省——平台不查，本地会阻断；骨架模板才用 `--allow-missing-required`；
- `flow export` 的文件带 `fingerprint`：保存时平台状态变了会被拒绝（并发写保护），先重新导出，别直接 `--force`；
- 保存后必须回读，确认节点/连线/属性齐全；`flow save` 失败会自动回滚到保存前快照。
- ETL 用 `--kind etl`；删除前强制快照，且不会先清属性。

### 新建编排

```bash
rc templates list
rc templates show sync-api --out flow.json --props-out props.json
rc flow validate --file flow.json
rc flow create --application <appId> --name <name> --apply
rc flow save --file flow.json --process-id <pid> --apply
```

自然语言生成只产出草案，不能直接落库。

### 数仓（dw）

```bash
dw doctor                                     # 配置→隧道→连通→库→MV元数据→写闸门→DDL能力
dw mv list --abnormal                         # 先捞出异常的
dw mv tasks --mv <mv> --hours 24              # 真实刷新时刻与耗时（只信 tasks()）
dw mv show <mv>                               # 看调度子句：ON SCHEDULE / ON COMMIT / ON MANUAL
dw mv phases                                  # 相位错峰体检（同分钟/撞车/依赖倒置）
dw mv lineage <mv>                            # 下游链路 + ON COMMIT 高危清单
dw mv drift --dir <ddl目录> --db <db>         # 仓库定义 ↔ 线上 SHOW CREATE
dw mv refresh-mode                            # 增量是否退化成全量（看 RefreshMode 列）
dw query "<sql>"                              # 只读闸门：单条 SELECT/WITH/SHOW/EXPLAIN/DESC
dw explain "<sql>"                            # 顺带诊断 MV 是否被 CBO 命中
```

写路径（全部默认 dry-run）：

```bash
dw mv lint --file <ddl>.sql --target <mv>     # 建副本前先静态检查
dw mv refresh <mv> [--complete] [--apply]
dw mv schedule <mv> --every N --unit HOUR --starts "<未来时刻>" [--apply]
dw mv freeze <mv> [--apply]
dw mv swap-plan  --target <mv> --source <mv_tmp> [--db <db>]
dw mv swap-apply --target <mv> --source <mv_tmp> [--db <db>] [--apply]
dw mv verify-phase <mv> --expect "HH:MM:SS"   # swap 只改日期，时分秒应原样保留
dw partition rolloff <db.table> --keep N [--max-drop N] [--apply]
```

数仓侧六条容易搞反的口径：

- **刷新相位与耗时只信 `tasks('type'='mv')`**；`RefreshInfo` 里没有 `STARTS` 不等于"整点锚点"。
- **`SHOW … LIMIT` 不合法**（`mismatched input 'LIMIT'`）；只读闸门只给 SELECT/WITH 注入 LIMIT。
- **换基表后只有带调度器的下游会自愈**；`ON COMMIT` 的必须手动 `REFRESH … COMPLETE`，否则死锁。
- **`dw mv drift` 报出来的都是真差异**：注释、限定名、空白、括号内侧空格、线上自动补的 PROPERTIES
  都已抹平；加 `--detail` 看两侧原文。
- **`RefreshMode=NOT_REFRESH` 不是降级**：它是"没有分区判脏、什么都没做"，是正常行为；
  只有 `COMPLETE` 且一次 `PARTIAL` 都没有才是真退化。
- **语句级 `REFRESH … COMPLETE` 与建表时的 `REFRESH COMPLETE` 是两件事**：前者只刷一次全量，
  后者把刷新方式**钉死**（之后 `ALTER … AUTO` 也永远走全量）。`dw mv lint` 的
  `W_REFRESH_COMPLETE_PINNED` 专管后者。

## 3. 与 CLI 协作

- 本仓库只提供 CLI（`rc` / `dw`），**不提供 MCP**；你用 shell 调命令即可。
- 先读 `skills/<域>-ops/SKILL.md` 再动手：那里写了"什么时候用哪条命令、失败先看什么"。
- 先跑发现类命令：`rc apps`、`rc api list --app <id>`、`rc flow components`、`rc catalog search <kw>`。
- 写操作默认 dry-run；加 `--apply` 前必须把目标、请求摘要、回滚方式展示给用户。
- 错误统一用 `rc error explain` 翻译；环境问题用 `rc doctor --connect`；
  数仓环境问题用 `dw doctor`（隧道断了它会告诉你是"进程残留"还是"没起"）。

## 4. 代码修改

- 修改核心逻辑后跑 `npm run typecheck && npm test`（覆盖率门禁在 `npm run test:coverage`）。
- 提交前跑 `npm run scan`（可发布文件全量，比 `scan:staged` 更全）；
  **推公开仓库前必须跑 `npm run scan:history`**。`npm ci` 已把 `.githooks/` 接上，
  pre-commit 与 pre-push 会自动跑，但别依赖它兜底。
- 修改模板后跑 `rc templates validate`；有条件时跑 `scripts/verify-templates-live.mjs`（只对可写测试环境）。
- 新增命令必须同时更新：
  - `packages/cli/src/index.ts`（或 `packages/dw-cli/src/index.ts`）的 HELP 与 switch；
  - `docs/COMMAND-REFERENCE.md`（或 `docs/DW-COMMAND-REFERENCE.md`）；
  - 对应的 `skills/<域>-ops/SKILL.md`；
  - 相关单测。
  冒烟测试会**逐条核对 HELP 里列出的命令都真的有分支**，漏接一条就红。
- 不引入新的运行时依赖，除非确有必要并说明理由（当前运行时依赖为零）。
- **测试不要依赖 git 或开发机本地状态**：源码 tarball 解出来没有 `.git`，
  那时 `npm test` 必须照样全绿。需要 git 的用例用 `{ skip: ... }` 跳过。

## 5. 范围红线

不要新增或恢复：

- 审批工单 / `--ticket` / 双人复核；
- license / 版本分层 / 功能开关；
- 权限 IaC、团队协作、审计报表、支持包；
- Web UI / 控制台 / 交互式 TUI；
- 任何硬编码环境地址或凭据。

`approval-flow` 模板是平台业务流程中的人工确认节点，不是本工具的审批功能。
