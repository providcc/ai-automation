---
name: ipaas-ops
description: RestCloud iPaaS 的 Agent 操作 SOP。用于排查平台问题、修改 API/数据源配置、生成或修改流程编排。只通过 rc CLI 操作，默认 dry-run，生产只读，ETL 写路径默认封禁。
---

# RestCloud iPaaS 操作 SOP

## 全局约束（先读）

1. **只通过机器接口操作**：`rc` CLI；不要建议用户打开控制台手工点。
2. **先读后写**：先 `list/get/validate/review/check`，写入后立即回读。
3. **默认 dry-run**：CLI 不带 `--apply` 不落库。
4. **生产只读**：`RC_PROFILE=prod` 写入需显式 `RC_ALLOW_PROD_WRITE=1`；执行前必须让用户确认目标环境。
5. **破坏性操作先快照**：删除 API/流程、回滚前先生成并展示快照。
   `flow export` 的文件带 `fingerprint`：平台已被他人修改时保存会被拒绝，先重新导出，别直接 `--force`。
6. **留痕**：报告里附 `traceId`，写操作有本地审计。
7. **ETL 写路径封禁**：ETL 试跑/补偿/发布默认关闭（`RC_ENABLE_ETL_WRITE` 未设置即报错），
   `rc etl list` 也不保证完整——ETL 相关问题请走 ESB 编排与只读排查手段。

## SOP-0 命令速查

```bash
rc apps
rc doctor --connect
rc error explain "<错误>"
rc api list --app <appId>
rc api get <id>
rc api save --file api.json [--apply]
rc api import --app <appId> --file spec.(json|yaml) [--apply]
rc flow build --file spec.json [--kind esb|etl] --out flow.json [--props-out props.json]
rc flow export <pid> [--kind esb|etl] --out flow.json
rc flow validate --file flow.json [--kind esb|etl]
rc flow save --file flow.json --process-id <pid> [--kind esb|etl] [--allow-missing-required] [--apply]
rc flow check --file flow.json --process-id <pid> [--kind esb|etl]
rc flow props list --process-id <pid> [--kind esb|etl]
rc flow props get --process-id <pid> --node-id <key>
rc flow props save --process-id <pid> --file props.json [--kind esb|etl] [--apply]
rc etl list            # 只读；列表不保证完整，仅供参考
rc etl compensate-plan # 只读生成补偿计划
# rc etl run / rc etl compensate --apply：ETL 写路径默认封禁（RC_ENABLE_ETL_WRITE）
rc monitor summary / rc ops summary
rc api diff --from a.json --to b.json --breaking
rc api impact --id <apiId> --deep
rc snapshot api <id> / rc restore <file> --apply
```

## SOP-1 排查问题

1. 先跑 `rc doctor --connect`：区分环境/认证/目录/目标问题。
2. 平台报错用 `rc error explain "<文案>"`：拿到分类与修复动作。
3. 运行态问题：
   - `rc monitor summary --hours 24`
   - `rc monitor logs <serviceId>`
   - `rc ops summary`
4. 影响面：
   - `rc lineage table <tableName>`
   - `rc lineage api --id <apiId> --deep`
   - `rc api impact --id <apiId> --kind esb --deep`
5. 编排问题：
   - `rc flow get <pid>` 看图和属性
   - `rc flow check --file model.json --process-id <pid>`
   - `rc review flow --file model.json --production`
6. 输出：**现象 → 证据/traceId → 根因 → 最小修复动作 → 回读验证**。

不要用“接口 200”当作修复成功；必须回读目标状态。

## SOP-2 修改 API / 数据源配置

```bash
rc api get <id> > api-before.json
rc snapshot api <id>
rc api save --file api.json            # dry-run
rc api save --file api.json --apply
rc api get <id>                        # 回读
```

数据源：

```bash
rc datasource get <id>
rc datasource test <id>
rc datasource save --file ds.json --apply
rc datasource test <id>
```

约束：

- 密码、token 不进仓库文件；用环境变量或平台引用。
- OpenAPI 批量导入先 `rc api analyze`，核对路径/方法/重名，再 `--apply`。
- 破坏性契约变更用 `rc api diff --breaking` 明确列出。

## SOP-3 修改流程编排

1. 读当前状态：`rc flow get <pid>`、`rc flow props get ...`。
2. 改图/属性：
   - 条件分支：普通节点出边 + `assertCondition=3/6`，**不要用 `gateWay`**；
   - 并行分支：并行网关 → 分支 → 聚合网关（`joinNodeId` 指回并行网关）；
   - 连线属性带 `assertionCondition`、`condition`、`sourceId`、`targetId`、`order`。
3. 校验：`rc flow validate --file model.json`、`rc review flow --file model.json --production`。
4. 保存：`rc flow save ...`（先 dry-run）。
5. 平台校验：`rc flow check --file model.json --process-id <pid>`。
6. 回读：节点数、连线数、属性齐全，缺一即失败。
7. 运行与调度：
   - 手工运行：`rc flow run <pid> --apply`（返回 `transactionId`，可用 `rc flow run-log <tid>` 看节点级记录）。
     平台两个运行端点版本差异大，CLI 会先走 `/process/run`、失败再回退 `/monitor/instance/run`；
     **不要**自己拼接 `monitor/instance/run`，未产生过实例的流程会直接 500。
   - 定时：`rc flow schedule save --process-ids <pid> --cron "0 0 * * * ?" --apply`。
     `/bpm` 规则服务不可达时 CLI 自动降级为"写流程记录 expression + `/process/start`"，建完即生效；
     回读看流程记录的 `expression` 与 `/rest/core/scheduler/current/run/jobs` 里的任务。

新建流程先用 `rc templates show <id> --out model.json` 或 `rc flow from-nl` 出草案，再校验/创建/保存。

## SOP-4 ETL（默认只读；写路径封禁）

> **ETL 写操作默认关闭**：未开通 ETL 能力的环境不要执行试跑/补偿/发布。
> `rc etl run`、`rc etl compensate --apply` 会直接报错（E_FORBIDDEN），不要重试、不要绕过；
> 排查请走 ESB 编排与只读手段。`rc etl list` **不保证完整**（ETL 是否开通由平台决定），不能当准确清单。

1. 只读：`rc etl list --keyword <k>` / `rc etl get <id>`（结果标注“仅供参考”）。
2. `rc etl compensate-plan --state FAIL`：只读生成补偿计划（不落库）。
3. 试跑 / 补偿 / 发布：**已封禁**，仅在确认平台已开通 ETL 能力且用户明确授权时，
   由管理员在环境变量里设置 `RC_ENABLE_ETL_WRITE=1` 后再执行。
4. 全量运行前必须确认目标环境、影响范围、回滚/补偿方案。

## SOP-5 发布前检查

- [ ] `rc api diff --breaking`：无未确认的破坏性变更；
- [ ] `rc review flow --production`：无 error；
- [ ] `rc flow check`：平台校验通过；
- [ ] `rc api impact --deep`：下游影响已列出；
- [ ] 已导出基线/快照，回滚路径明确；
- [ ] 回读验证通过。

## 输出规范

- 数字必须带口径（时间窗、样本量）。
- 结论先行，证据在后；不确定处标注“待核实”。
- 任何“已修复/已发布”的表述，必须附回读校验结果。
- 不输出平台域名、IP、密码、token、逻辑库名。
