# `dw` 命令参考（Apache Doris 数仓）

> 契约文档：这里描述的命令与 `packages/dw-cli/src/index.ts` 的 `HELP` 一一对应。
> Agent 操作手册见 [`skills/dw-ops/SKILL.md`](../skills/dw-ops/SKILL.md)。
> 本文件**不含任何真实主机、库名、表名或 MV 名**——开源副本里这些都是占位符。

---

## 0. 定位

`dw` 是 Apache Doris 数仓的运维 CLI，与 `rc`（RestCloud iPaaS）同工程、同 CI、共享通用层
（错误码、脱敏、审计、只读闸门），但**配置根、凭据文件、命令面完全隔离**。

设计参照官方 `@apache-doris/doriscli`，并补上它没有的能力：

| 能力 | 官方 CLI | `dw` |
|---|---|---|
| 多环境配置 + 凭据分文件 | ✅ | ✅（`~/.dw/warehouse.json` + `warehouse-credentials.json`） |
| FE HTTP / MySQL 传输 | ✅ | ✅（原生 `fetch`，零依赖） |
| **SSH 隧道（跳板机本地转发）** | ❌ 只有 SOCKS5 | ✅ `dw tunnel up/down/status` |
| **MV 生命周期（含灰度换名）** | ❌ | ✅ `dw mv …` |
| **DDL 漂移 / 依赖链路 / ON COMMIT 高危** | ❌ | ✅ `dw mv drift / lineage` |
| **相位错峰体检** | ❌ | ✅ `dw mv phases` |
| 只读闸门 + 结果脱敏 | ❌ | ✅ 默认开启 |
| 分区分桶体检 / 滚动清理 | 部分（`tablet`） | ✅ `dw tablet` / `dw partition rolloff` |

**代码里没有任何具体环境信息**：环境来自配置，清单一律运行时发现。这是开源副本能整份公开的前提。

---

## 1. 安装与运行

```bash
npm install -g .          # 提供 rc 与 dw 两个命令
# 或者不安装，直接跑：
node --experimental-strip-types packages/dw-cli/src/index.ts --help
npm run dw -- --help
```

要求 Node ≥ 22.6（用到 `--experimental-strip-types`）。**零运行时依赖。**

Docker：

```bash
docker build -t ai-automation .
docker run --rm ai-automation dw doctor
```

---

## 2. 配置

### 2.1 文件布局

```
~/.dw/warehouse.json              非敏感连接信息（0644，可共享）
~/.dw/warehouse-credentials.json  密码（0600，绝不进仓库）
~/.dw/audit/YYYY-MM.jsonl         写操作审计（自动创建）
```

根目录可用 `DW_HOME` 覆盖；两个文件可分别用 `DW_CONFIG` / `DW_CREDENTIALS` 指定。

```jsonc
// ~/.dw/warehouse.json
{
  "default_env": "uat",
  "environments": {
    "uat": {
      "host": "<fe-host>",          // 内网地址，只出现在本地配置里
      "mysqlPort": 9030,
      "httpPort": 8030,
      "user": "<user>",
      "catalog": "internal",
      "database": "<db>",
      "transport": "http",
      "tunnel": {
        "enabled": true,
        "jumpHost": "<jump-host>",
        "jumpUser": "<user>",
        "jumpPort": 22,
        "passwordFile": "~/.ssh/jump_pass",   // 0600；配合 sshpass -f 读，密码不进 argv
        // "identityFile": "~/.ssh/id_ed25519",
        // "forwards": [{ "local": 19030, "remoteHost": "<fe-host>", "remotePort": 9030 }],
        // "extraArgs": ["-o", "ProxyCommand=..."],
        "enabled": true
      },
      "readonly": false
    },
    "prod": { "host": "<fe-host>", "readonly": true }
  }
}
```

```jsonc
// ~/.dw/warehouse-credentials.json   chmod 600
{ "uat": { "password": "<secret>" }, "prod": { "password": "<secret>" } }
```

**隧道的 `forwards` 省略时**按 `本地端口 = 远端端口 + 10000` 生成两条（9030→19030、8030→18030）。
若所在网段的隧道约定不同（例如 HTTP 直接 8030→8030），**显式写 `forwards`**。

### 2.2 环境变量（优先级：命令行 > 环境变量 > 配置文件）

| 变量 | 含义 |
|---|---|
| `DW_HOST` / `DW_PORT` / `DW_HTTP_PORT` | FE 地址与端口 |
| `DW_USER` / `DW_PASS` | 账号与密码（`DW_PASS` 优先于凭据文件） |
| `DW_DB` / `DW_CATALOG` | 默认库 / catalog（默认 `internal`） |
| `DW_TRANSPORT` | `http`（默认）或 `cmd` |
| `DW_CMD` | `transport=cmd` 的命令模板，占位符 `{sql}` / `{env}` |
| `DW_ENV` | 选择配置里的哪个环境 |
| `DW_TARGETS` | 内联多环境配置（JSON 数组或 `{environments}`） |
| `DW_TUNNEL` | 内联隧道配置（JSON），**对所有来源的环境生效** |
| `DW_PROFILE` | 设为 `prod` 时开启只读闸门 |
| `DW_ALLOW_PROD_WRITE` | 设为 `1` 才允许在只读环境写入 |
| `DW_HOME` / `DW_CONFIG` / `DW_CREDENTIALS` | 覆盖配置路径 |
| `DW_MASK_COLS` | 追加要脱敏的结果列（逗号分隔） |

设置 `DW_HOST` 时**不会**继承配置文件的 `default_env` 名字——环境名会用 `DW_ENV` 或 `env`，
免得"用环境变量连的库"被标成文件里的另一个环境名。

### 2.3 只读闸门（**只有一个判断点**）

```
DW_PROFILE=prod 且 DW_ALLOW_PROD_WRITE≠1  →  readonly
```

这条对**所有来源的环境**生效（配置文件、`DW_TARGETS`、环境变量），
也允许命令行 `--readonly` 显式打开。只读时任何写操作抛 `E_PROD_READONLY`（退出码 6）。

---

## 3. 命令

### 3.1 环境与连接

```
dw env list                                     # 列出配置里的环境（host 打码）
dw env show [--env <name>] [--reveal-host]      # 当前生效环境
dw tunnel status|up|down [--env <name>] [--force]
dw doctor [--env <name>] [--fix] [--json]
```

`dw doctor` 按链式顺序检查，**前一项没过后面全部 skip**（不让用户在一堆噪音里找原因）：

1. **配置** — 环境名/传输/catalog/库；缺密码时警告。
2. **隧道** — 未启用记 skip；启用时**看端口不看进程**。失败提示"合盖休眠后残留进程，先 down 再 up"。
   `--fix` 会先按特征串精确清掉残留进程再重建（不做宽泛 `pkill ssh`）。
3. **连通性** — `SELECT VERSION()`。401 单独提示核对账号密码。
4. **库上下文** — `SHOW TABLES FROM <db>`（**不加 LIMIT**，Doris 的 SHOW 不接受）。
5. **MV 元数据** — 能否读 `mv_infos` 表函数。连通 ≠ 能读元数据，单独报。
6. **写闸门** — 只读时警告并给出放行方式。

另有一条**条件性**检查：凭据文件权限不合规时追加一条 warn（不计入上面的 6 步）。
7. **DDL 能力** — 探测语句是 `DROP TABLE IF EXISTS <__dw_doctor_probe__>`：
   真的过一遍 DDL 执行路径但零副作用，且**执行前先确认该名字不在表清单里**。不可用时指向 `transport=cmd`。

退出码：全通过 0，有阻断项 5。

### 3.2 查询与诊断

```
dw query "<sql>" [--max-rows N] [--raw] [--timeout ms] [--json]
dw explain "<sql>" [--json]
dw profile list [--min-ms N] [--failed] [--hours N] [--limit N]
dw profile get <queryId> [--raw]
dw profile diff <快qid> <慢qid>
dw profile history "<sql片段>" [--days N]
dw tablet <db.table> [--detail] [--partition <p>]
```

**`dw query` 的只读闸门**（安全边界，四道）：

1. 只放行 `SELECT` / `WITH` / `SHOW` / `EXPLAIN` / `DESC`。
2. **拒绝多语句**：`SELECT 1; DROP TABLE t` 的前缀完全合法，这是这类闸门最大的漏洞。
3. 拒绝 `INTO OUTFILE` / `INTO DUMPFILE` / `FOR UPDATE` / `LOCK IN SHARE MODE`。
4. 没有 `LIMIT` 时**只给 SELECT/WITH 补**一个；`SHOW`/`EXPLAIN`/`DESC` 补了会直接报
   `mismatched input 'LIMIT'`。

结果默认脱敏（列名命中凭据/个人信息即打码），`--raw` 回原值。脱敏在截断之后做，保证行数对得上、便于对拍。

**`dw explain`** 顺带给出 MV 改写诊断，三种结论对应三条不同的路：

| 结论 | 含义 | 下一步 |
|---|---|---|
| 命中 | `MaterializedViewRewriteSuccess` | 性能问题不在改写，去 profile 看算子 |
| 看到但没用 | 有 `MaterializedViewRewriteFail` + `FailSummary` | 对失败原因逐条比谓词（谓词不可推导 / 聚合无法上卷 / State 非 NORMAL） |
| 完全没提 | CBO 没看到候选 | 查 `mv_infos` 状态与 catalog/库是否一致 |

**`dw profile list`** 走 `__internal_schema.audit_log`（比 `SHOW QUERY PROFILE "/"` 好用：
后者只回一串文件路径）。老版本缺列时自动退到最小列集；两次都失败会提示
"该表需要开启审计插件（`audit_plugin_enabled=true`）"。

**`dw profile diff`** 抹掉时间戳与耗时数字后做行级对比，只比**结构**
（算子、落盘、改写）——慢查询多出来的算子才是可疑点。

**`dw tablet`** 判定口径是 **每个 tablet 目标 1–10 GB**（桶数是手段，桶大小才是目标）。
`DataSize` 在 Doris 里是**人读字符串**（`"4.108 GB"`），工具会解析成字节再算。
另外报副本在各 BE 的分布，明显不均即分桶键倾斜。

### 3.3 MV 自查（只读）

```
dw mv list [--abnormal] [--json]
dw mv tasks [--mv <name>] [--hours N] [--limit N] [--json]
dw mv show <mv> [--raw] [--json]
dw mv phases [--json]
dw mv lineage <mv> [--depth N] [--json]
dw mv drift [--dir <ddl目录>] [--db <db>] [--detail] [--json]
dw mv lint --file <ddl.sql> [--target <mv>] [--json]
dw mv refresh-mode [--mv <name>] [--hours N] [--all] [--json]
```

**`dw mv list`** 走 `mv_infos('database'=…)` 表函数——Doris 3.1.4 上 `SHOW MATERIALIZED VIEWS`
**不可用**，且列集合随版本变化（3.1.x 只有 `Name/State/RefreshState`），所以按**列名**取值、不按位置。
健康判定：`State=NORMAL` 且 `RefreshState=SUCCESS`。

**`dw mv tasks`** 是唯一可信的刷新时刻与耗时来源（`tasks('type'='mv')`）。
`RefreshInfo` 里没有 `STARTS` 并不等于"整点锚点"。

**`dw mv show`** 读 `SHOW CREATE`。注意它回**两列**（名字 + 定义），工具按列名挑定义列，
并校验拿到的确实像一段 DDL——挑错列会静默返回一个表名，比报错更难查。
DDL 里的连接属性字面量默认脱敏。

**`dw mv phases`** 相位分布与错峰体检。判定分两级，刻意分开：

- `W_CROWDED_MINUTE` / `W_SAME_MINUTE`：纯相位问题，同一分钟位起跑。
- `W_DURATION_OVERLAP`：**间隔 < 前一张的实测耗时**（耗时取自 `tasks()`）。
  这条才对应"前一张未落盘后一张就起 → 随机 FAILED、重试即过"。
  **没有耗时就按相位硬报会把"1 分钟错峰"这种正常排布报成满屏告警**——
  一个库里几十张小时级 MV 分布在 60 个分钟位上，2 分钟间隔在数学上就做不到。
- `E_DEPENDENCY_INVERSION`：下游相位早于上游。上游是**维表**（`dim_*`）时降级为 `warn`，
  因为维表虽然高频刷新但内容变化慢，差一个周期通常无害；上游是事实/汇总表才是真问题。

同一周期才互相比较（日级与小时级同分钟起跑并不冲突）。解析不出 STARTS 的
（`ON COMMIT` / `ON MANUAL`）单独列出原因，不混进相位表。

**`dw mv lineage <mv>`** 列出它读了谁、谁读它，并**单独标出 ON COMMIT 下游**：

> 换基表后 ON COMMIT 的下游不会自愈：SCHEMA_CHANGE 下基表提交触发器不点火，
> 而清 SCHEMA_CHANGE 又必须刷一次——死锁。必须手动 `REFRESH … COMPLETE`。

依赖图以**清单**为节点集合，不是以"读成功了几张 DDL"为准——否则某张 DDL 读失败会让它
从图里彻底消失，连"被别人读"这条边一起丢。

**`dw mv drift`** 比对仓库定义 ↔ 线上 `SHOW CREATE`。为了让输出只剩真差异，做了四件事：

1. 两边都剥注释（`SHOW CREATE` 会把 SELECT 体里的注释原样存下来，还常常压成行内形态）。
2. 抹平反引号、空白、**括号内侧空格**。
3. 抹平限定名（`db.tbl.col` / `tbl.col` / `col` 语义等价，仓库手写裸名、线上回限定名）。
4. `PROPERTIES` 按括号配对拆出来，**只比仓库声明过的键**——
   线上自动补的十几个属性（`storage_medium`、`is_being_synced`、`group_commit_interval_ms` …）
   不是契约的一部分。

输出分四类，处置不同：

| 状态 | 含义 |
|---|---|
| `语义漂移` | 列/键/分桶/调度/SELECT 体真的不一样 |
| `仅相位` | 只有 `STARTS` 时刻不同（相位被改过，定义未变） |
| `仅属性` | 只有仓库声明过的 PROPERTIES 键对不上 |
| `线上缺失` | 仓库有、线上没有 |

有语义漂移或线上缺失时退出码 4。`--detail` 打印每个漂移位置的两侧原文。

**`dw mv lint`** 把踩过的坑固化成可执行断言：

| 码 | 级别 | 内容 |
|---|---|---|
| `E_NO_CREATE` | error | 找不到 `CREATE MATERIALIZED VIEW <name>` |
| `E_QUALIFIED_NAME` | error | CREATE 里带了库名限定（`REPLACE WITH` 不接受） |
| `E_SAME_NAME` | error | 替换源与目标同名（`--target` 给出时检查） |
| `E_STARTS_PAST` | error | `STARTS` 已过期，建副本会被拒 |
| `W_NO_STARTS` | warn | `ON SCHEDULE` 但没有 `STARTS` |
| `W_DECIMAL_DIVISION` | warn | SELECT 体里有除法但没有 `CAST AS DECIMAL` |
| `W_REFRESH_COMPLETE_PINNED` | warn | CREATE 里写了 `REFRESH COMPLETE`，刷新方式被钉死 |
| `I_BUILD_IMMEDIATE` | info | BUILD 方式会被 swap 带到目标上 |
| `E_PARTITION_UNION` | error | 分区 MTMV 的 SELECT 体里有 `UNION` |
| `E_PARTITION_CTE_ANCHOR` | error | 分区 MTMV 里某个 CTE 被引用 ≥2 次 |
| `E_PARTITION_VIEW` | error | 分区 MTMV 引用了 VIEW |
| `W_PARTITION_SELF_JOIN` | warn | 分区 MTMV 里重复 JOIN 了同一张表 |
| `E_PARTITION_COMMENT_ORDER` | error | `PARTITION BY` 子句区间里混进了 MV 级 `COMMENT` |

`E_PARTITION_*` / `W_PARTITION_SELF_JOIN` **只在带 `PARTITION BY` 的 MTMV 上判**——
这几条限制来自"分区表达式必须穿透到基表分区列"，没有 `PARTITION BY` 的 MV 本来就没有
分区级增量，`UNION` 之类随便用（线上就有这样的 MV，误报会直接把一次换名挡掉）。

三条限制的实测口径（不是从文档抄的）：

- **`UNION` 无条件阻断** → `the invalid plan node is LogicalUnion`。
- **CTE 只在被引用 ≥2 次时阻断** → `LogicalCTEAnchor`；**只引用 1 次会被内联掉，正常放行**，
  别顺手把所有 CTE 都物化了。
- **self join 只在自连接的是分区表时才致命**（`self join doesn't support partition update`）。
  静态判不出分区与否，所以只给 `warn` 并提示去查 `information_schema.partitions`。
- VIEW 检测是**按命名猜**的（取限定名最后一段，命中 `view` / `*_view`）：`view_log`、`vw_order`
  这类不以 `view` 结尾的表名不会被误判——这是 error 级发现，误判会直接阻断换名，宁可漏也不要错杀。

有 error 时退出码 4。名字解析**同时吃下反引号与库名限定两种写法**——
只匹配到第一个反引号会把 `` `db`.`mv` `` 误读成 `db`，那条检查就永远不触发。

**`dw mv refresh-mode`** 判定"分区 MTMV 的增量退化成了全量"。这是
`tasks('type'='mv')` 里 `RefreshMode` / `NeedRefreshPartitions` 两列的直接用途，**不需要猜、也不需要读源码**：

| verdict | 含义 |
|---|---|
| `failing` | 时间窗内有失败轮次（优先报，先修失败） |
| `degraded` | 有 `COMPLETE`、**一次 `PARTIAL` 都没有** → 增量彻底退化 |
| `intermittent` | 全量与增量交替 → 间歇性降级 |
| `healthy` | 有 `PARTIAL`，无 `COMPLETE` |
| `unknown` | 只有 `NOT_REFRESH`（**这不是降级**，见下） |
| `not-applicable` | 范围外（别的库 / 非 `EXPR` 分区），或该 MV 只有 1 个分区 |

四条容易判错的：

1. **`NOT_REFRESH` 不是降级**。它的含义是"没有分区判脏，什么都没做"——**正常行为**。
   只看 `COMPLETE` 的条数会把一张安静的 MV 报成重度退化。
2. **只有一个分区时不算退化**：脏集必然等于全分区数，FE 只能全刷，这是定义使然。
3. **只在 `EXPR` 分区 MV 上判**。`MvPartitionInfo` 里的 `partitionType` 是 `SELF_MANAGE` /
   `FOLLOW_BASE_TABLE` 的本来就没有分区级增量，走全量是正常的，报出来全是噪音。
4. **范围判定优先于失败判定**：`tasks()` 是**全集群**的、`mv_infos` 是**按库**的，
   所以不在当前库清单里的 MV 一律 `not-applicable`——别的库的失败不该在这个命令里报出来。

判定为 `degraded` / `intermittent` 时会附带根因与处置：

> 分区 MTMV 的脏判定有两条腿——①驱动表对应**分区**的版本快照；②**非 excluded 的其他基表按整表版本**比对。
> 只要有一张高频写入的基表不在 `excluded_trigger_tables` 里，整表版本被 bump 就会让全部 MV 分区判脏。
>
> **反直觉、已实测证伪的一条**：把非驱动表也改成分区表**没有用**——非驱动表无论分不分区都走整表版本比对。
>
> 处置：① 查各基表分区的 `UPDATE_TIME` 找出每小时被 bump 的那张；
> ② `ALTER MATERIALIZED VIEW <mv> SET ("excluded_trigger_tables"=…)` 摘出去，
> **副作用必查**：摘掉的基表真变了（改名、改负责人）不会触发重刷，老分区的属性列会陈旧；
> ③ MV 属性变更会**清空脏账本**，改后首轮预期仍是 `COMPLETE`，别据此判定没生效。

默认只打"需要关注的"（`degraded` / `intermittent` / `failing`），`--all` 才连 `healthy` 一起列。

### 3.4 MV 写操作（全部默认 dry-run）

```
dw mv refresh <mv> [--complete] [--apply]
dw mv schedule <mv> --every N --unit <MINUTE|HOUR|DAY|WEEK|MONTH> --starts "YYYY-MM-DD HH:MM:SS" [--apply]
dw mv freeze <mv> [--apply]
dw mv swap-plan  --target <mv> --source <mv_tmp> [--db <db>]
dw mv swap-apply --target <mv> --source <mv_tmp> [--db <db>] [--apply]
dw mv verify-phase <mv> --expect "HH:MM:SS"
```

- `refresh`：**语句级**的 `REFRESH MATERIALIZED VIEW <mv> COMPLETE` 只是"现在强制刷一次全量"，
  **不改** MV 的刷新方式（读回 `RefreshInfo` 仍是原样），可放心用。
  与它同名但完全不同的一件事是**建表时**写 `REFRESH COMPLETE`——那会把刷新方式**钉死**，
  之后无论发多少次 `REFRESH … AUTO` 都永远走全量（`dw mv lint` 的 `W_REFRESH_COMPLETE_PINNED` 就管这个）。
- `freeze`：`REFRESH AUTO ON MANUAL`，数据停在当前时刻——这正是回退想要的快照。
- `schedule`：相位只认时分秒；改相位是运维决策，改前先 `dw mv phases` 看冲突。
- 每条写操作都落审计到 `~/.dw/audit/`（含是否 dry-run），审计写失败**不阻断**业务结果，只提醒。

**`dw mv swap-plan` / `swap-apply`** 是唯一不可逆的操作，清单顺序刻意固定：

```
1. REFRESH MATERIALIZED VIEW <source> COMPLETE        全量刷替换源
2. （人工确认）State=NORMAL / RefreshState=SUCCESS，量级与目标同阶
3. USE <db>; ALTER MATERIALIZED VIEW <target> REPLACE WITH MATERIALIZED VIEW <source> PROPERTIES ('swap'='true')
4. ALTER MATERIALIZED VIEW <source> REFRESH AUTO ON MANUAL    冻结旧定义
5. DROP MATERIALIZED VIEW <source>                    清理旧副本
6. REFRESH MATERIALIZED VIEW <on_commit_downstream> COMPLETE  逐个补 ON COMMIT 下游
7. （人工确认）回读校验
```

三条副作用必须记住（`swap-plan` 会把它们作为 warnings 打出来）：

1. **swap 会把调度一起换到替换源名下** → 第 4 步不做，旧定义会按原相位继续空刷。
2. **swap 会把 STARTS 重置为"当天 + 原相位"**：日期变了、时分秒没变。
   所以 `STARTS` 不能当"这张表多久没动过"的证据，核对时**只比时分秒**（`verify-phase` 就是干这个的）。
3. **BUILD 方式会被替换源带过去**，且 `ALTER … REFRESH …` 改不回 BUILD。

`swap-plan` 会自动跑一遍依赖图，把目标下游里的 ON COMMIT 找出来并插进第 6 步。
`swap-apply` 跳过人工确认点，只执行有 SQL 的步。

### 3.5 分区与分桶

```
dw partition list <db.table> [--json]
dw partition rolloff <db.table> --keep N [--max-drop N] [--apply]
```

`rolloff` 的两条安全约束：

- **默认不动手**：dry-run 是默认。
- **超过 `--max-drop`（默认 10）一律拒绝**（`E_CONFIRM_REQUIRED`）——
  一次删这么多说明 `--keep` 大概率写错了，得显式放大才放行。

计划里会标出每个待删分区**是否为空**：空分区删了省元数据，有数据的删了不可恢复，两者风险不同。
分区名里没有可解析日期段时按字典序参与排序，并**明确警告要人工复核**。

### 3.6 退出码

沿用 `RcError` 的约定：

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 2 | 未知命令 / 未捕获异常 |
| 3 | 认证失败（`E_AUTH`） |
| 4 | 参数错误（`E_VALIDATION`）、或体检/漂移发现阻断项 |
| 5 | 上游失败（`E_UPSTREAM`）、`dw doctor` 有阻断项 |
| 6 | 危险操作被拒（`E_PROD_READONLY` / `E_CONFIRM_REQUIRED` / `E_FORBIDDEN`） |

错误信息会带一条**数仓口径**的下一步提示（不复用 iPaaS 那套"用 traceId 查平台日志"——
Doris 的报错基本都是 SQL 本身的问题，重试没有意义，要看 `detailMessage`）。

---

## 4. 脱敏（开源副本的红线）

**硬红线**：域名、内网 IP、口令、逻辑库名、业务表名与 MV 名、跳板机信息，一律不进公开副本。

手段：

1. **能力通用、清单外部化**：`packages/core/src/dw/` 里只有 Doris 通用操作；
   环境、库、MV 清单一律来自配置或运行时发现，**代码零硬编码**。
2. **配置与凭据分文件**；密码永不进 argv（隧道用 `sshpass -f <file>`）。
3. **运行时输出默认脱敏**：结果列、DDL 连接属性、host 全部打码；`--raw` / `--reveal-host` 才回原值。
4. **审计**走 `redact()`。
5. **文档与测试**用 `<fe-host>` / `<db>` / `<mv>` 占位；单测用桩传输，不出现任何真实地址。
6. **扫描**：`npm run scan`（提交前 `npm run scan:staged`）。通用特征在
   `scripts/sensitive-scan.mjs` 里（特征串故意拆开拼，避免扫描器命中自己）；
   **业务词表从仓库外读**（`DW_SENSITIVE_WORDS` / `DW_SENSITIVE_WORDS_FILE`，CI 用 secret）。

---

## 5. 已知取舍

- **FE HTTP 端点的写能力取决于 FE 配置**。`dw doctor` 会探测并明确报出来；
  不可用时写路径要改用 `transport=cmd`（配置 `DW_CMD`），**不静默降级**。
- **`SHOW … LIMIT` 不合法**。Doris 的 `SHOW` 不接受 `LIMIT`，所以只读闸门只给
  `SELECT`/`WITH` 注入 LIMIT。
- **`dw mv drift` 的"仅属性"只比仓库声明过的键**。取舍是：反过来做会把十几个自动属性
  全报成差异，人就都不看了；代价是"仓库里删掉一个属性"不会被发现。
- **`analyzeStagger` 没有耗时数据时不做撞车判定**。宁可少报，也不要满屏噪声。
- **`dw partition rolloff` 不猜保留策略**。哪个表留多少期是运维决策，写死在工具里换个表就会删错。
