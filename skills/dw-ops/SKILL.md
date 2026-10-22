---
name: dw-ops
description: Apache Doris 数仓的 Agent 操作 SOP。用于排查物化视图异常、灰度换名、DDL 漂移、刷新相位错峰、分区分桶体检与慢查询诊断。只通过 dw CLI 操作，只读默认，写操作需 --apply，输出默认脱敏。
---

# Apache Doris 数仓操作 SOP

## 全局约束（先读）

1. **只通过机器接口操作**：`dw` CLI；不要建议用户打开 FE 控制台或手敲 mysql。
2. **先读后写**：任何写操作前先 `dw mv list / show / phases / lineage`，写完立即回读核对。
3. **默认 dry-run**：不带 `--apply` 只打印 SQL，不落库。
4. **只读环境**：`DW_PROFILE=prod` 且未设 `DW_ALLOW_PROD_WRITE=1` 时，所有写操作被拒。
5. **脱敏是默认行为**：结果列命中凭据/个人信息、DDL 里的连接属性、host 一律打码。
   需要原值才用 `--raw` / `--reveal-host`，且**不要把原值写进报告、提交信息或工单**。
6. **换名（swap）是不可逆的**：必须先出清单、人工确认、再逐步执行；详见 SOP-3。
7. **报告口径**：结论里给命令与关键输出，不给凭据、内网地址、库名与业务表名。

## SOP-0 命令速查

```bash
# 环境与连接
dw env list                                  # 列出配置里的环境（host 打码）
dw env show [--env <name>] [--reveal-host]
dw tunnel status|up|down [--force]
dw doctor [--fix]                            # 配置→隧道→连通→库→MV元数据→写闸门→DDL能力

# 只读排查
dw query "<sql>" [--max-rows N] [--raw]
dw explain "<sql>"                           # 顺带诊断 MV 是否被 CBO 命中
dw mv list [--abnormal]
dw mv tasks [--mv <name>] [--hours N]        # 真实刷新时刻与耗时
dw mv show <mv>
dw mv phases                                 # 相位分布 + 同分钟/撞车/依赖倒置体检
dw mv lineage <mv>                           # 下游链路 + ON COMMIT 高危清单
dw mv drift [--dir <ddl目录>] [--db <db>] [--detail]
dw mv lint --file <ddl.sql> [--target <mv>]
dw mv refresh-mode [--mv <name>] [--hours N] [--all]  # 增量是否退化成全量
dw partition list <db.table>
dw tablet <db.table> [--detail]
dw profile list [--min-ms N] [--failed] [--hours N]
dw profile get <queryId>
dw profile diff <快qid> <慢qid>
dw profile history "<sql片段>" [--days N]

# 写操作（全部默认 dry-run）
dw mv refresh <mv> [--complete] [--apply]
dw mv schedule <mv> --every N --unit HOUR --starts "YYYY-MM-DD HH:MM:SS" [--apply]
dw mv freeze <mv> [--apply]
dw mv swap-plan  --target <mv> --source <mv_tmp> [--db <db>]
dw mv swap-apply --target <mv> --source <mv_tmp> [--apply]
dw mv verify-phase <mv> --expect "HH:MM:SS"
dw partition rolloff <db.table> --keep N [--max-drop N] [--apply]
```

## SOP-1 排查"MV 不刷新 / 一直 FAILED"

按顺序做，**不要跳步**——前一步的结论会决定后一步该看什么。

```bash
dw mv list --abnormal        # ① State≠NORMAL 或 RefreshState≠SUCCESS 的先捞出来
dw mv tasks --mv <mv> --hours 24   # ② 真实刷新时刻与耗时（不是 RefreshInfo）
dw mv show <mv>              # ③ 看调度子句：ON SCHEDULE / ON COMMIT / ON MANUAL
dw mv refresh-mode           # ④ 没失败但"刷得很慢/很久"时：判增量是否退化成了全量
```

判定表：

| 现象 | 含义 | 下一步 |
|---|---|---|
| `State=SCHEMA_CHANGE` | 基表结构变了，MV 结构待同步 | 换过基表就照 SOP-3 第 6 步手动 `COMPLETE` 下游 |
| `RefreshState=NOT_REFRESH` 但 `State=SUCCESS` | 看着成功其实没刷 | 用同周期上游做交叉验证，别信这个 SUCCESS |
| `tasks()` 里每周期都 FAILED、报 `column type not same` | DECIMAL 除法被提升成 DOUBLE，下游 UNION 兄弟分支类型不一致 | 最外层套 `CAST(... AS DECIMAL(38, 2))`（`dw mv lint` 会提前警告） |
| 报 `starts time must be greater than current time` | 建副本时 STARTS 是过去时刻 | 把日期改到未来，**时分秒相位原样保留** |
| 随机 FAILED、重试即过 | 与相邻任务撞车（前一张还没落盘） | `dw mv phases` 看 `W_DURATION_OVERLAP` |
| `ON COMMIT` 的 MV 在基表提交后不刷新 | SCHEMA_CHANGE 下基表提交触发器不点火 | 手动 `REFRESH MATERIALIZED VIEW <下游> COMPLETE` |
| **只有某一天**数据明显偏少/为 0，前后几天都正常 | 日级任务的**时序门**：它的上游小时级 MV 那天上午才落数，日任务已经跑完了 | 上游补回后当天手动 `REFRESH MATERIALIZED VIEW <日级 MV> COMPLETE`，不用改调度 |

时序门那条的通用形态：**日级 MV 的上游若也是小时级 MV，而那天上游的报数大头到 D+1 上午才进基表，
日任务在自己的时刻读到的就是不完整的快照**——任务本身 `SUCCESS`，数据却是缺的，
所以只能靠"某一天突然偏低"这个信号反查，不会在 `dw mv list --abnormal` 里露头。
查法：比对日级 MV 与上游小时级 MV 在那一周期的聚合值，差额就是漏掉的部分。

**刷新相位与耗时只信 `tasks('type'='mv')`**：`RefreshInfo` 里没有 STARTS 不等于"整点锚点"。

### ④ 没失败，但每轮都跑得很久 → 查增量是否退化成了全量

分区 MTMV 本该只刷脏分区，退化后会变成全量。**不用猜，也不用读源码**——
`tasks('type'='mv')` 的 `RefreshMode` 列就是答案：

```bash
dw mv refresh-mode                  # 只打需要关注的（degraded / intermittent / failing）
dw mv refresh-mode --mv <mv> --json # 单张表，看 byMode 计数与脏分区数
```

- `RefreshMode=PARTIAL` + `NeedRefreshPartitions` 只有几条 → 增量正常。
- `RefreshMode=COMPLETE` + `NeedRefreshPartitions` 条数 ≈ 全部分区数 → **脏集 == 全分区数**，FE 只能全刷。
- **`NOT_REFRESH` 不是降级**：它是"没有分区判脏、什么都没做"，是正常行为。

判定为 `degraded` 时，根因与处置（工具会一并打出来）：

> 分区 MTMV 的脏判定有两条腿——①驱动表对应**分区**的版本快照；
> ②**非 excluded 的其他基表按整表版本**比对。所以只要有一张高频写入的基表不在
> `excluded_trigger_tables` 里，整表版本被 bump 就会让全部 MV 分区判脏。
>
> **反直觉的一条（已实测证伪）**：把非驱动表也改成分区表**没有用**——
> 非驱动表无论分不分区都走整表版本比对。
>
> 处置：① 查各基表分区的 `UPDATE_TIME` 找出每小时被 bump 的那张；
> ② `ALTER MATERIALIZED VIEW <mv> SET ("excluded_trigger_tables"=…)` 把它摘出去；
> ③ 改完首轮预期仍是 `COMPLETE`——MV 属性变更会**清空脏账本**，别据此判定没生效。

**摘除的副作用必查**：摘掉的基表真变了（如改名、改负责人）不会触发重刷，老分区的属性列会陈旧。

## SOP-2 排查"查询慢 / MV 没被命中"

```bash
dw explain "<原查询>"        # 先看 CBO 是否用了 MV
dw profile list --min-ms 5000 --hours 6   # 再看谁在拖
dw profile diff <快qid> <慢qid>           # 结构差异（已抹掉耗时数字）
dw profile history "<sql片段>" --days 7
```

`dw explain` 的三种结论对应三条不同的路：

- **命中**（`MaterializedViewRewriteSuccess`）→ 性能问题不在改写，去 profile 看算子（落盘、shuffle、数据倾斜）。
- **看到但没用**（有 `MaterializedViewRewriteFail` 及其 `FailSummary`）→ 对失败原因逐条比谓词：
  日期函数包了列导致谓词不可推导、聚合无法上卷、MV 的 State 不是 NORMAL。
- **完全没提 MV** → CBO 根本没看到候选：查 `mv_infos` 的 State/RefreshState，
  并确认查询的表与 MV 基表在同一 catalog/库。

慢查询本身按这条路线走：`dw tablet <db.table> --detail` 看分桶数与副本倾斜，
再决定是调桶数、加索引还是改数据模型（本仓库不含 Doris 建表规范文档，按 Doris 官方最佳实践判断）。

## SOP-3 灰度换名（swap）——**唯一不可逆的操作，必须按清单走**

```bash
# ① 出清单（只打印，不执行）
dw mv swap-plan --target <mv> --source <mv_tmp> --db <db>

# ② 静态检查替换源（能静态判出来的坑不要等线上报错）
dw mv lint --file <替换源>.sql --target <mv>

# ③ 逐条执行（默认 dry-run；确认后才 --apply）
dw mv swap-apply --target <mv> --source <mv_tmp> --db <db> --apply

# ④ 回读核对
dw mv show <mv>
dw mv verify-phase <mv> --expect "<原相位时分秒>"
dw mv list --abnormal
```

清单为什么是那个顺序（**别调换**）：

1. 全量刷替换源 `COMPLETE`（不会把 AUTO 模式钉死）。
2. **人工确认**替换源 `State=NORMAL / RefreshState=SUCCESS`，且数据量级与目标同阶。
3. `USE <db>` 后原子换名：**替换源必须是裸名**，带库名限定会报 `mismatched input '.'`；
   `PROPERTIES ('swap'='true')` 不能省。
4. 冻结旧定义（此刻它挂在替换源名下）：`REFRESH AUTO ON MANUAL`。
   **不做这步，旧定义会按原相位继续空刷**，留一堆没人看的副本烧资源。
5. `DROP` 旧副本；不删会持续报 FAILED 任务污染告警。
6. 逐个手动 `COMPLETE` **ON COMMIT 下游**：它们在 SCHEMA_CHANGE 下不会自愈，
   而清 SCHEMA_CHANGE 又必须刷一次——死锁。`dw mv lineage <mv>` 会列出这些下游。

三条容易忘的副作用：

- **swap 会把调度一起换到替换源名下**。
- **swap 会把 STARTS 重置为"当天 + 原相位"**：日期变了、时分秒没变。
  所以 STARTS **不能当"这张表多久没动过"的证据**，核对时**只比时分秒**。
- **BUILD 方式会被替换源带过去**：替换源是 `DEFERRED` 就会把目标降级，
  且 `ALTER ... REFRESH ...` 改不回 BUILD——要保住就得让替换源的 `CREATE` 用相同关键字。

## SOP-4 DDL 漂移与定义治理

```bash
dw mv drift [--dir <仓库DDL目录>] [--db <db>] [--detail]
```

输出分四类，处置不同：

| 状态 | 含义 | 处置 |
|---|---|---|
| `语义漂移` | 列/键/分桶/调度/SELECT 体真的不一样 | 确认哪边是准的，把仓库或线上对齐 |
| `仅相位` | 只有 STARTS 时刻不同 | 相位被改过；定义没变，按需更新仓库里的 STARTS |
| `仅属性` | 只有**仓库声明过的** PROPERTIES 键对不上 | 线上自动补的属性不算漂移，只看列出来的键 |
| `线上缺失` | 仓库有、线上没有 | 是被删了还是没建过 |

`dw mv drift` 已经剥掉注释、抹平限定名与空白——**报出来的都是真差异**，
不要因为"看起来很多"就先怀疑工具。加 `--detail` 看每个漂移位置的两侧原文。

## SOP-5 分区滚动清理

```bash
dw partition list <db.table>
dw partition rolloff <db.table> --keep N [--max-drop N]      # 先看计划
dw partition rolloff <db.table> --keep N --apply             # 确认后执行
```

- 保留策略来自命令行，**不要写死**：哪个表留多少期是运维决策。
- 待删分区**有数据**时会被单独警告，删了不可恢复——逐条看过再 `--apply`。
- 一次删超过 `--max-drop`（默认 10）会被拒绝：大概率是 `--keep` 写错了。
  确认无误再显式放大，**不要为了通过而放大**。

## SOP-6 分区分桶体检

```bash
dw tablet <db.table>            # 分桶大小 + 副本分布
dw tablet <db.table> --detail   # 逐 tablet 明细
```

判定口径：**每个 tablet 目标 1–10 GB**（桶数是手段，桶大小才是目标）。

- 偏小 → 桶数偏多：元数据与 compaction 压力。
- 偏大 → 桶数偏少：并行度不够、单 tablet 修复慢。
- 副本在各 BE 明显不均 → 分桶键倾斜，考虑复合分桶键。

## 输出规范

- 给命令 + 关键输出片段；**不给**凭据、内网地址、库名、业务表名与 MV 名。
- 结论要带证据：哪条命令、哪个字段、什么值。
- 写操作报告里附上 dry-run 的 SQL 与 `--apply` 后的回读结果。
- 不确定就说不确定：`dw doctor` 的 `skip` 项要如实转达，不要当成通过。
