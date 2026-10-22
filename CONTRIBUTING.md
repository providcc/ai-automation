# 贡献指南

## 0. 两条硬约束（先读这个，其余都可以慢慢看）

**① 不要把内部信息写进这个仓库。**
域名、IP、密码、token、连接串、逻辑库名/表名/MV 名、业务应用 id、跳板机账号——
一律不写进代码、文档、测试、夹具、提交信息。需要举例时用 `<fe-host>` / `<appId>` / `<db>` 这类占位符。

这不是靠自觉，`scripts/sensitive-scan.mjs` 会拦：

```bash
npm run scan            # 全部可发布文件（已跟踪 + 未跟踪未忽略）
npm run scan:staged     # 只扫暂存区（pre-commit 钩子跑的）
npm run scan:history    # git 历史里的每个 blob（pre-push 与 CI 跑的）
```

- **通用特征在仓库里**（凭据的形态、内网 IP 段、本机家目录路径），
  **具体值走仓库外的词表**——把具体域名/口令片段写进源码等于把秘密一起公开：
  ```bash
  DW_SENSITIVE_WORDS_FILE=/path/to/words.txt npm run scan   # 一行一个，忽略 # 开头
  ```
  模板见 `sensitive-words.example.txt`。
- 扫描范围包含**未跟踪未忽略**的文件：新写的文件在 `git add` 之前正是"还没进版本库也没被扫过"的窗口。
- "当前树 clean" **不等于** "仓库 clean"——文件改掉之后旧版本仍在对象库里。所以有 `--history`。
- 测试里需要"看起来像凭据"的输入（例如给脱敏函数写用例）时，**把字面量拆开拼**
  （`'root' + ':' + 'pw' + '@'`）。这里的拆是"避免合成夹具触发形状特征"，不是藏真凭据。

**② 写操作默认 dry-run，闸门在发请求之前。**
新增写命令必须：默认只打印请求 → `--apply` 才执行 → 走审计（**失败也要留痕**）→ 退出码按 `docs/COMMAND-REFERENCE.md` 的契约。
只读命令的 SQL 一律过只读闸门（`packages/core/src/sql-text.ts`），不要自己写正则判。

## 1. 环境

- **Node 22+**，零运行时依赖（只用 Node 内置模块）。
- 直接以 `--experimental-strip-types` 跑 `.ts`，**没有构建步骤**。
  因此不能用 TypeScript 里需要代码生成的语法：**enum / namespace / 构造函数参数属性**。
- `npm ci` 后 `prepare` 会把 git hooks 指到 `.githooks/`（pre-commit 扫暂存区、pre-push 扫历史）。

```bash
npm ci
npm run typecheck      # 四个 tsconfig：core / cli / dw-cli / tests
npm test               # 单测（node:test）
npm run test:coverage  # core ≥95% 行 / 90% 分支 / 95% 函数
```

`npm run cli -- <args>` 与 `npm run dw -- <args>` 分别跑两个 CLI。

## 2. 分层（改动落在哪一层）

```
L0  契约层   packages/core/src/{client,errors,security,credentials}.ts
L1  能力层   packages/core/src/<domain>.ts            ← 业务能力都在这里
L2  出口层   packages/{cli,dw-cli}/src/index.ts       ← parseArgs + HELP + switch
```

- **能力在 core，出口在 CLI**：core 里不 `console.log`、不 `process.exit`。
- core 抛 `RcError(code, message, { hint, detail })`；退出码由 CLI 统一映射。
- `hint` 用于**消息已经自带明确下一步**的场景（`hint: ''` = 不再追加默认提示）；
  默认提示是按错误码一刀切的，套错场景会把用户指向无关文档。

## 3. 加一条命令要动的地方

1. `packages/core/src/<domain>.ts` —— 能力实现（纯函数优先，便于单测）。
2. `packages/<cli>/src/help.ts` —— 加一条 `CommandSpec`（用法/一句话说明/选项/坑/示例）。
3. `packages/<cli>/src/index.ts` —— 加 `case '<name>':`；新 flag 必须同时进 `OPTIONS`
   （`parseArgs` 是 strict 的，**漏声明等于整条链路不可达**，不是"少个可选参数"）。
4. 单测。`tests/unit/cli-help.test.ts` 会做 catalog ↔ dispatch **双向**核对：
   "文档写了但用不了"和"能用但没文档"都会失败。

顶层帮助与单命令帮助都由 `help.ts` 渲染，**不要**另写帮助字符串——两份文案一定会漂移。

## 4. 测试怎么摆

| 位置 | 管什么 |
|---|---|
| `tests/unit/<domain>.test.ts` | core 的纯逻辑（大部分测试应在这里） |
| `tests/unit/<cli>-smoke.test.ts` | 子进程跑真实 CLI：入口、参数校验、退出码、闸门顺序（**不触网**） |
| `tests/unit/dw-write-contract.test.ts` | 写操作契约：对着 `dw-fake-fe.ts`（本地假 FE）跑真实命令 |

- 断言**契约**而不是实现细节：退出码、消息里的可行动信息、有没有发请求。
- 写测试时优先问"这个断言在哪种回归下会红"；只断言"没抛异常"的测试没有价值。
- 安全相关的东西必须有反向用例：闸门要同时钉住**假阴性**（绕过）与**假阳性**（正常输入被拒）。

## 5. 提交

- 一个提交一件事；提交信息写**为什么**，不写"改了哪些文件"。
- 提交前跑：`npm run typecheck && npm test && npm run scan`（pre-commit/pre-push 也会跑扫描）。
- 不要提交：`node_modules/`、`dist/`、`reports/`、`.rc/`、`catalog/live/`、`catalog/db/`、
  真实环境的配置文件（`.gitignore` 已覆盖，别用 `-f` 绕过）。

## 6. 文档

- 面向使用者的命令细节写在 `help.ts`（`--help` 是主入口）；`docs/COMMAND-REFERENCE.md` /
  `docs/DW-COMMAND-REFERENCE.md` 是命令之外的**契约与坑**。
- 改动行为时同步改文档，并检查文档里的**数字**（节点数、规则数、步数）——
  这类数字最容易漂移，改完用代码里的事实核对一遍。
