# AI Automation

给编程 Agent 用的自动化 CLI，两条路：

- **`rc`** —— RestCloud iPaaS：查问题、改配置、改编排
- **`dw`** —— Apache Doris 数仓：查状态、刷物化视图、灰度换名、DDL 漂移

本仓库只提供 **CLI**（没有 Web UI、控制台、交互式 TUI，也**不提供 MCP**），不包含审批、许可、计费、团队协作等企业功能。
入口统一为 Claude Code、OpenCode、WorkBuddy 等能执行 shell 的编程 Agent；每个 CLI 配一份 `skills/` 里的 SOP。

## 能做什么

| 场景 | 能力 |
|---|---|
| 问题排查 | `doctor` 环境自检、平台错误翻译、监控/日志、表级血缘、API 深度影响面、流程/API 评审 |
| 配置修改 | API 新增/修改、OpenAPI 批量导入、数据源保存/连通性测试、连接器配置导入导出 |
| 编排修改 | 流程生成/校验/创建/保存/克隆/发布/删除、节点属性读写、平台 checkerror、版本查看 |
| ETL 运维 | 任务查询、限量试跑、失败依赖分析、按 transactionId 补偿 |
| 契约与模板 | 2265 个端点、208 个节点驱动、29 个流程模板、712 条错误映射、目录指纹漂移告警 |

所有写操作默认 **dry-run**；`prod` 默认只读；每次写操作有本地审计记录。

## 安装

本仓库**只走 GitHub，不发布到 npm**。用源码跑：

```bash
git clone https://github.com/providcc/ai-automation.git
cd ai-automation
npm ci                    # 装开发依赖（只有 typescript + @types/node）

# 方式一：直接跑（不污染全局）
node --experimental-strip-types packages/cli/src/index.ts --help    # rc
node --experimental-strip-types packages/dw-cli/src/index.ts --help # dw
npm run cli -- --help     # 等价写法
npm run dw  -- --help

# 方式二：把 rc / dw 挂到 PATH（想当命令用就选这个）
npm link
rc --help
dw --help
```

需要 **Node.js 22.6+**（用内置 TypeScript strip-types 直接跑 `.ts`，无需构建步骤）。
运行时**零第三方依赖**。

也可以用 Docker（入口脚本把 `rc` / `dw` / 脚本路径映射到 node 运行）：

```bash
docker build -t ai-automation .
docker run --rm --env-file .env ai-automation rc --help               # iPaaS CLI
docker run --rm --env-file .env ai-automation dw doctor               # 数仓 CLI
docker run --rm --env-file .env ai-automation rc doctor --connect
# 真实环境生命周期验收（容器内同样可跑）
docker run --rm --env-file .env -v "$HOME/.rc:/root/.rc" \
  ai-automation scripts/verify-flow-lifecycle.mjs --allow-host <host>
```

镜像里只装生产依赖（含 `catalog/`、`docs/`、`skills/`、`scripts/`），不含任何平台地址与凭据；
凭据与目标地址一律从环境变量注入。

## 贡献

```bash
npm run typecheck      # 类型检查（四个 tsconfig，含测试）
npm test               # 单元测试
npm run test:coverage  # 覆盖率门禁：core ≥95% 行 / 90% 分支 / 95% 函数
npm run scan           # 敏感信息扫描（提交前必跑）
npm run scan:history   # 扫 git 历史（开源/推公开仓库前必跑）
```

`npm ci` 会自动把 git hooks 指到 `.githooks/`：pre-commit 扫暂存区，pre-push 扫**可发布文件 + git 历史**。

`scripts/sensitive-scan.mjs` 扫的是**全部会被发布的文件**（已跟踪 + 未跟踪未忽略），
因为新写的文件在 `git add` 之前正是"没进版本库也没被扫过"的窗口。
`--history` 再扫一遍 git 历史里出现过的每个 blob——**文件改掉之后旧版本仍在对象库里**，
push 上去照样能 `git log -p` 翻出来，"当前树 clean"不等于"仓库 clean"。

业务词表（内部域名、口令片段、逻辑库名、业务表名/MV 名）从仓库外读
（`DW_SENSITIVE_WORDS` / `DW_SENSITIVE_WORDS_FILE`），**不进仓库**——
这些值本身就是敏感面，把特征写进公开源码等于把秘密一起公开。
该填哪些类别见 [`sensitive-words.example.txt`](sensitive-words.example.txt)；
仓库里的扫描器**只放通用"形状"**（云 token 前缀、PEM 私钥头、JWT、带凭据的连接串、内网 IP 段）。

**写测试夹具时注意**：口令类夹具一律写成 `'<secret>'` 这类占位形式，别写 `'super-secret'`——
后者既可能被扫描器当成真值，也分不清是夹具还是泄漏。

新增/改动请一并更新对应的 `docs/*-COMMAND-REFERENCE.md` 与 `skills/*/SKILL.md`——
那是 Agent 唯一会读的操作说明。

## 入口

CLI 就是全部入口：给 Agent 当 shell 工具用，也便于人工复核。

```bash
npm run cli -- --help
npm run cli -- doctor
npm run cli -- apps
```

`rc` 全部命令都是非交互的，适合 Agent 直接执行。

## 快速开始 · rc（iPaaS）

```bash
export RC_BASE_URL='https://<host>/restcloud'
export RC_PROFILE=uat
export RC_USER='<service-account>'
export RC_PASS='<secret>'

npm run cli -- auth login
npm run cli -- apps
npm run cli -- api list --app <appId>
npm run cli -- doctor --connect
```

### 排查一个问题

```bash
npm run cli -- error explain "<平台错误文案>"
npm run cli -- monitor summary --hours 24
npm run cli -- monitor logs <serviceId>
npm run cli -- lineage api --id <apiId> --deep
npm run cli -- review flow --file model.json --production
```

### 改一个配置

```bash
npm run cli -- api get <apiId>
npm run cli -- api save --file api.json            # dry-run
npm run cli -- api save --file api.json --apply

npm run cli -- datasource test <id>
npm run cli -- datasource save --file ds.json --apply
```

### 改一条编排

```bash
npm run cli -- flow get <processId>
npm run cli -- flow export <processId> --kind esb --out flow.json
npm run cli -- flow props list --process-id <pid> --kind esb
npm run cli -- flow props get --process-id <pid> --node-id <nodeKey>
npm run cli -- flow props save --process-id <pid> --file props.json --apply

npm run cli -- flow validate --file flow.json --kind esb
npm run cli -- flow save --file flow.json --process-id <pid> --kind esb --apply
npm run cli -- flow check --file flow.json --process-id <pid> --kind esb
```

`flow save` 会先写快照，再写属性/图并调用平台校验；任何一步失败自动回滚。`flow props save` 同样先快照再幂等写入（带既有 id 更新，不会产生重复属性），失败也会回滚。ETL 用 `--kind etl`，属性与端点会自动切换。

组合文件 `{kind, model, props}` 是 `flow build` / `flow export` / `templates show` 的统一产物，可直接喂给 `flow validate` / `flow save` / `flow check`。

**必填属性本地兜底**：平台 `checkerror` 不校验组件必填属性（缺 `apiUrl` 也放行），本工具按组件目录 +
启发式规则强制 `apiNode.apiUrl`、`sqlExecuterNode.dbConnId/sqlCode`、`gateWay.gatewayType` 这类字段，
缺失时 `flow save` 直接阻断；骨架模板（`skeleton: true`）或 `--allow-missing-required` 时降级为警告；
`flow export` 出来的文件会自动带 `skeleton` 标记，平台本来就缺的字段按"沿用现状"处理。

### 新建一条编排

```bash
npm run cli -- flow from-nl "调用订单接口 GET https://api.example.com/orders 然后返回" --out model.json
npm run cli -- flow validate --file model.json
npm run cli -- flow create --application <appId> --name order_sync --apply
npm run cli -- flow save --file model.json --process-id <pid> --apply
npm run cli -- flow delete <pid> --apply   # 删除前强制快照，不先清属性
```

### 安全边界

- `RC_ALLOWED_HOSTS='ipaas-test.example.com,*.corp.example.com'` 可限制允许访问的目标主机；未配置时不拦截。
- `RC_KEYCHAIN=1` 可从 macOS Keychain / Linux secret-tool 读取 `RC_USER`、密码和 token，避免把密钥写进配置文件。

安全相关环境变量一览（**这些是唯一会影响安全判定的开关**）：

| 变量 | 作用 | 缺省行为 |
|---|---|---|
| `RC_ALLOWED_HOSTS` | 允许访问的目标主机白名单（逗号分隔，支持 `*.x.com`） | 未配置 = 不拦截 |
| `RC_ALLOW_PROD_WRITE` | `RC_PROFILE=prod` 时允许写操作；**必须显式设为 `1`** | 缺省 = prod 只读 |
| `RC_ENABLE_ETL_WRITE` | 放开 ETL 写路径（`etl run` / `etl compensate --apply`） | 缺省 = `E_FORBIDDEN` |
| `RC_KEYCHAIN` | 从系统钥匙串取凭据（macOS `security` / Linux `secret-tool`） | 缺省关闭 |
| `RC_KEYCHAIN_ACCOUNT` | 钥匙串条目的 account 名 | 缺省 `default` |
| `RC_KEYCHAIN_USER` | 钥匙串里没有 `user` 条目时兜底的用户名 | 缺省取 `RC_USER` |
| `RC_ACTOR` | 写进审计的操作者标识 | 缺省取 `USER` |
| `RC_AUDIT_DIR` | 审计目录 | 缺省 `~/.rc/audit` |
| `DW_MASK_COLS` | 结果脱敏的**追加**列名（逗号分隔） | 缺省只有内置的凭据/个人信息列 |
| `DW_PROFILE` / `DW_ALLOW_PROD_WRITE` | 数仓侧同 `RC_*`：prod 且未设 `DW_ALLOW_PROD_WRITE=1` 时只读 | 缺省按环境配置 |
| `DW_HOME` | 数仓配置/凭据/审计的根目录 | 缺省 `~/.dw` |

另有 `--readonly`（dw）可**逐次**显式打开只读，与上表共用同一个判断点。
- **ETL 写路径默认封禁**：`etl run` / `etl compensate --apply` 在未设置 `RC_ENABLE_ETL_WRITE=1` 时直接报
  `E_FORBIDDEN`；`etl list` 不保证完整（ETL 是否开通由平台决定），不能当排查清单。
- `catalog/etl-components.json` 是可选文件：ESB-only 部署可以不装（doctor 与漂移检测忽略其缺失）。
- 真实测试环境生命周期验收：`RC_BASE_URL=... RC_USER=... RC_PASS=... npm run flow:verify -- --allow-host <host>`；
  稳定性门禁（连跑 20 次）：`npm run flow:verify:stability -- --allow-host <host> --runs 20`；
  API 域验收（导入 → 回读 → 下线 → 删除 → 清理）：`npm run api:verify -- --allow-host <host>`。
- **并发写保护**：`flow export` 的文件带 `fingerprint`，保存时若平台已被他人修改会拒绝写入（先重新导出；
  确实要覆盖再加 `--force`）；dry-run 与保存都会输出"新增/删除/变更"的语义 diff。
- **审计可查**：写操作落 jsonl 审计（操作者/路径/traceId/关键标识），用
  `rc audit list|tail|summary --since 24h` 查"谁在什么时候改了哪个流程"（`--limit` 默认 50）。
- **节点数据预览**：`rc flow preview --process-id <pid> --node-id <nodeId>`（只读；平台只有节点级预览端点，
  没有"对数据源执行任意 SQL"的接口；SQL/表名只取节点已保存的配置，不接受命令行传入）。
- **业务应用要看 `rc flow apps`**：平台的 `rc apps` 列的是**平台模块**（esb/etl/gateway…），
  业务应用（形如 `<appId>`）是流程上的 `applicationId`，用 `rc flow list --app <业务应用>` 过滤。
- **`.env` 不会被自动加载**（没有 dotenv 依赖）：用 `node --env-file=.env …` 或 `export`；
  仓库只有 `.env.example`。多目标配置放全局 `~/.rc/targets.json`（不必塞进业务仓库）。
- **每次调用都能换目标**：`rc` 支持 `--target` / `RC_BASE_URL` / `RC_PROFILE` 逐次指定，不必为多环境起多个进程。

## 快速开始 · dw（数仓）

```bash
# 方式一：环境变量（最小可用）
export DW_HOST='<fe-host>' DW_USER='<user>' DW_PASS='<secret>' DW_DB='<db>'
# 方式二：配置文件（推荐；密码单独放 0600 文件）
#   ~/.dw/warehouse.json + ~/.dw/warehouse-credentials.json
# 走跳板机时在配置里声明隧道，dw 会自己建/探活/重建：
#   "tunnel": { "enabled": true, "jumpHost": "<jump-host>", "passwordFile": "~/.ssh/jump_pass" }

npm run dw -- doctor                      # 配置→隧道→连通→库→MV元数据→写闸门→DDL能力
npm run dw -- mv list --abnormal           # 异常的物化视图
npm run dw -- mv tasks --hours 6           # 真实刷新时刻与耗时（不是 RefreshInfo）
npm run dw -- mv phases                    # 相位错峰体检
npm run dw -- mv lineage <mv>              # 下游链路 + ON COMMIT 高危清单
npm run dw -- mv drift --dir mv_ddl --db <db>   # 仓库定义 ↔ 线上 SHOW CREATE
npm run dw -- mv refresh-mode              # 增量是否退化成了全量（读 tasks() 的 RefreshMode）
```

### 灰度换名（唯一不可逆的操作，按清单走）

```bash
npm run dw -- mv lint --file <替换源>.sql --target <mv>   # 静态检查
npm run dw -- mv swap-plan --target <mv> --source <mv_tmp> --db <db>   # 只打印清单
npm run dw -- mv swap-apply --target <mv> --source <mv_tmp> --db <db> --apply
npm run dw -- mv verify-phase <mv> --expect "<原相位时分秒>"
```

清单顺序是固定的：**全量刷替换源 → 原子换名 → 冻结旧定义 → DROP 旧副本 → 手动补 ON COMMIT 下游**。
反过来就会出现"副本还在空烧资源"或"下游卡死"。详见
[`skills/dw-ops/SKILL.md`](skills/dw-ops/SKILL.md) 的 SOP-3。

数仓侧的安全默认值与 iPaaS 一致：**写操作默认 dry-run**；`DW_PROFILE=prod` 时只读；
结果默认脱敏（`--raw` 才回原值）；写操作落审计到 `~/.dw/audit/`。

## 目录

```text
packages/core/src/           # 共享原语 + iPaaS 域：client / auth / api / flow / etl / datasource / 诊断
packages/core/src/dw/        # 数仓域：配置 / 隧道 / 传输 / 查询 / MV / 漂移 / 血缘
packages/cli/src/index.ts    # rc CLI（iPaaS，非交互）
packages/dw-cli/src/index.ts # dw CLI（数仓，非交互）
catalog/endpoints.json       # 2265 个端点目录
catalog/war/                 # 后端契约：控制器 / 驱动 / 模型
catalog/flow-templates/      # 29 个流程模板
catalog/error-map.json       # 712 条错误映射
skills/ipaas-ops/SKILL.md    # rc 的 Agent SOP
skills/dw-ops/SKILL.md       # dw 的 Agent SOP
docs/COMMAND-REFERENCE.md    # rc 命令参考
docs/DW-COMMAND-REFERENCE.md # dw 命令参考
docs/PLATFORM-NOTES.md       # 平台已知问题与契约事实（checkerror 偏松、索引延迟…）
docs/TEMPLATES.md            # 模板说明与真实环境验证
docs/FLOW-JSON-SPEC.md       # 流程 JSON 核心契约
AGENTS.md                    # 给编程 Agent 的操作约定
```

## 安全默认值

- `RC_PROFILE=prod` 客户端**只读**，写入需显式 `RC_ALLOW_PROD_WRITE=1`。
- 写操作默认 dry-run；删除类强制快照路径。
- 审计日志 `~/.rc/audit/YYYY-MM.jsonl`（含 traceId，凭据字段脱敏）。
- 凭据只从环境变量/密钥管理注入，不写入仓库、不写入采集结果。
- 开源仓库不含任何客户域名、IP、密码、逻辑库名；CI 有敏感信息扫描。

## 不在当前范围

- Web UI、控制台、交互式 TUI；
- 审批工单、许可分层、定价/销售、SSO 商业对接；
- 权限 IaC、团队协作、审计报表、支持包；
- 非 RestCloud 系 iPaaS 的通用适配。

`approval-flow` 模板仍然保留，表示平台流程里的**人工确认节点**，不是本工具的审批功能。

## 文档

- [架构与设计取舍](docs/ARCHITECTURE.md) —— 为什么是这个形状：分层、零依赖、安全模型
- [Agent 接入（Claude Code / OpenCode / WorkBuddy）](docs/AGENT-SETUP.md)
- [rc 命令参考](docs/COMMAND-REFERENCE.md)
- [dw 命令参考](docs/DW-COMMAND-REFERENCE.md)
- [rc 运维 SOP（skill）](skills/ipaas-ops/SKILL.md) —— **先读这个再动手**：什么时候用哪条命令、失败先看什么
- [dw 运维 SOP（skill）](skills/dw-ops/SKILL.md)
- [流程模板](docs/TEMPLATES.md)
- [流程 JSON 契约](docs/FLOW-JSON-SPEC.md)
- [组件上下文](docs/component-context.md)
- [平台已知问题](docs/PLATFORM-NOTES.md)
- [Agent 操作约定](AGENTS.md)
- [安全策略](SECURITY.md) —— 安全模型、已知取舍、如何报告漏洞

## License

MIT
