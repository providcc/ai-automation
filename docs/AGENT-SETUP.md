# 编程 Agent 接入

本工具不提供自己的 UI，也**不提供 MCP**。Agent 只通过 CLI 调用：`rc`（RestCloud iPaaS）与 `dw`（Apache Doris 数仓）；
Claude Code、OpenCode、WorkBuddy 都只是宿主，给它们一个能执行 shell 的工具即可。

## 1. 共同前提

```bash
git clone https://github.com/providcc/ai-automation.git
cd ai-automation
npm ci
node --experimental-strip-types packages/cli/src/index.ts doctor     # rc
node --experimental-strip-types packages/dw-cli/src/index.ts doctor  # dw
```

需要 Node.js 22.6+（用内置 TypeScript strip-types 运行）。**运行时零依赖**，`npm ci` 只装开发依赖。

地址与凭据一律从环境变量或宿主的 secret 注入，不写进仓库：

```bash
# rc（iPaaS）
RC_BASE_URL=https://<host>/<context>
RC_PROFILE=uat
RC_USER=<service-account>
RC_PASS=<secret>

# dw（数仓）—— 详见 docs/DW-COMMAND-REFERENCE.md 与 skills/dw-ops/SKILL.md
DW_HOST=<fe-host>
DW_USER=<user>
DW_PASS=<secret>
DW_DB=<database>
```

## 2. 接入方式：给它一个 shell

各宿主都只需要"能执行命令"这一项能力：

| 宿主 | 做法 |
|---|---|
| Claude Code | 直接用 Bash 工具执行 `bin/rc.mjs …` / `bin/dw.mjs …`（或 `npm run cli -- …`） |
| OpenCode | 同上；把命令写进它的 shell/工具配置 |
| WorkBuddy | 同上 |
| 其他 | 任何能跑 shell 的 Agent 都行 |

```bash
bin/rc.mjs doctor --connect
bin/rc.mjs api list --app <appId>
bin/dw.mjs doctor
bin/dw.mjs mv list
```

## 3. 配套 skill（关键）

CLI 是机器接口，`skills/` 是**给 Agent 的操作手册**——写明"什么时候用哪条命令、失败先看什么、什么绝对不能做"。
接入时把对应 skill 交给 Agent，它会比只读 `--help` 少走很多弯路。

| skill | 服务对象 |
|---|---|
| `skills/ipaas-ops/SKILL.md` | `rc` |
| `skills/dw-ops/SKILL.md` | `dw` |

## 4. 硬约定（Agent 必须遵守）

1. **只通过 CLI 操作**：不要让用户打开控制台手工点。
2. **先读后写**：先 `list/get/validate/review/check`，再 `save/create/delete`。
3. **默认 dry-run**：不带 `--apply` 只预览；写之前把目标、请求摘要、回滚方式展示给用户。
4. **生产只读**：`RC_PROFILE=prod`（数仓侧 `DW_PROFILE=prod`）写入被拒，需显式放开开关。
5. **破坏性操作先快照**。
6. **不泄露凭据**：不要把域名、IP、密码、token、连接串、逻辑库名写进代码/文档/测试/报告/提交信息。

## 5. 推荐的首轮对话

```text
1. 先跑 rc doctor --connect（数仓用 dw doctor），告诉我环境/认证/隧道是否有问题。
2. 列出 <appId> 下的 API 和流程，不要修改。
3. 如果我要改，先给我 dry-run 请求和回滚方案。
```
