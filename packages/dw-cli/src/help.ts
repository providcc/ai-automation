/**
 * `dw` 的命令目录：顶层帮助与单命令帮助都由它渲染（见 core/cli-help.ts）。
 *
 * 加命令时的规矩：这里加一条 `CommandSpec`，`packages/dw-cli/src/index.ts` 里加一个
 * `case '<name>':`——两边不一致会被单测拦下（"文档写了但用不了"和"能用但没文档"都是缺陷）。
 *
 * 写 `notes` 的取舍：只写**用之前就该知道**的坑（Doris 的硬限制、字段口径、
 * 会改变结果的默认行为）。能从 `--help` 一眼看懂的东西不重复写。
 */
import type { HelpSpec } from '../../core/src/cli-help.ts';

const G_ENV = '环境与连接';
const G_DIAG = '查询与诊断';
const G_MV_RO = 'MV 自查（只读）';
const G_MV_RW = 'MV 写操作';
const G_PART = '分区与分桶';

export const DW_HELP: HelpSpec = {
  bin: 'dw',
  title: 'dw — Apache Doris 数仓自动化 CLI',
  common: '--env <name> 选环境；--db <db> 覆盖库上下文；--readonly 显式只读（任何写操作直接拒）；--json 机器可读输出',
  commands: [
    // ── 环境与连接 ──
    {
      group: G_ENV,
      name: 'env list',
      usage: 'dw env list',
      summary: '列出配置里的环境（host 打码）',
      options: [{ flag: '--json', desc: '机器可读输出' }],
      notes: ['配置来自 ~/.dw/warehouse.json（可用 DW_HOME 覆盖根目录）。'],
    },
    {
      group: G_ENV,
      name: 'env show',
      usage: 'dw env show [--env <name>] [--reveal-host]',
      summary: '当前生效环境（优先级：命令行 > 环境变量 > 文件）',
      options: [
        { flag: '--env <name>', desc: '指定环境；不传则按优先级解析' },
        { flag: '--reveal-host', desc: '回显真实 host（默认打码）' },
        { flag: '--json', desc: '机器可读输出' },
      ],
      notes: ['这是排查"到底连的哪个环境"的第一条命令：优先级高的来源会覆盖低的。'],
    },
    {
      group: G_ENV,
      name: 'tunnel status',
      usage: 'dw tunnel status [--env <name>]',
      summary: '隧道探活：端口 + 进程双看',
      options: [
        { flag: '--env <name>', desc: '指定环境' },
        { flag: '--json', desc: '机器可读输出' },
      ],
      notes: [
        '探活**看端口不看进程**：ssh 进程还在但转发已死的形态真实存在，端口通才算通。',
        '输出会标明这条隧道是谁起的：`dw` 起的（tunnel down 能关）还是手工/别的工具起的（关不掉，但可直接复用）。',
      ],
    },
    {
      group: G_ENV,
      name: 'tunnel up',
      usage: 'dw tunnel up [--env <name>] [--force]',
      summary: '建隧道（先清本工具的残留副本，再起）',
      options: [
        { flag: '--env <name>', desc: '指定环境' },
        { flag: '--force', desc: '即使已在且健康也重建' },
      ],
      notes: [
        '失败时会去噪 OpenSSH 告警，把真实原因（如 Address already in use / Permission denied）置顶，并给出可执行的下一步。',
        '本地端口默认按「远端端口 + 10000」推算；若既有隧道用的是别的约定（如 HTTP 8030 直接转到本机 8030），在环境配置的 forwards 里显式写本地端口。',
      ],
      examples: ['dw tunnel up', 'dw tunnel up --force'],
    },
    {
      group: G_ENV,
      name: 'tunnel down',
      usage: 'dw tunnel down [--env <name>]',
      summary: '停隧道（按特征串精确杀，不做宽泛 pkill）',
      options: [
        { flag: '--env <name>', desc: '指定环境' },
        { flag: '--json', desc: '机器可读输出（含 stillListening）' },
      ],
      notes: [
        '只杀**本工具起的**那条隧道（按转发表 + 跳板机精确匹配），不会误伤别人的 ssh。',
        '若端口仍在监听而不归本工具管，会明确报出来——否则容易误以为端口空着，接着 up 撞端口。',
      ],
    },
    {
      group: G_ENV,
      name: 'doctor',
      usage: 'dw doctor [--env <name>] [--fix] [--json]',
      summary: '体检：配置 → 隧道 → 连通 → 库 → MV 元数据 → 写闸门',
      options: [
        { flag: '--env <name>', desc: '指定环境' },
        { flag: '--fix', desc: '能自愈的项自动修（如重建隧道）' },
        { flag: '--json', desc: '机器可读输出' },
      ],
      notes: ['连通性失败时后面的项会**跳过**（不是失败），只留一个明确的失败原因。'],
    },

    // ── 查询与诊断 ──
    {
      group: G_DIAG,
      name: 'query',
      usage: 'dw query "<sql>" [--max-rows N] [--raw] [--timeout ms] [--json]',
      summary: '只读查询（走只读闸门 + 自动补 LIMIT + 默认脱敏）',
      options: [
        { flag: '--max-rows N', desc: '行数上限，默认 500（超出截断并标记）' },
        { flag: '--raw', desc: '关掉列脱敏（仅排查时用）' },
        { flag: '--timeout ms', desc: '超时，默认 60000' },
        { flag: '--json', desc: '机器可读输出' },
      ],
      notes: [
        '只放行单条 SELECT/WITH/SHOW/EXPLAIN/DESC；多语句、WITH 后的 DML、可执行注释里的语句一律拒。',
        '没有顶层 LIMIT 时自动补一个（子查询里的 LIMIT 不算），避免一条 SELECT 把整库拖回来。',
        '列名命中凭据/个人信息（password/token/email/phone/身份证…）的值默认打码；DW_MASK_COLS 可追加列。',
      ],
      examples: ['dw query "SELECT count(*) FROM t"', 'dw query "SHOW TABLES" --json'],
    },
    {
      group: G_DIAG,
      name: 'explain',
      usage: 'dw explain "<sql>" [--json]',
      summary: '看查询计划，顺带诊断 MV 是否被 CBO 命中',
      options: [{ flag: '--json', desc: '机器可读输出' }],
      notes: ['同样走只读闸门；EXPLAIN 不会被补 LIMIT（改了正文就解释的不是原语句了）。'],
    },
    {
      group: G_DIAG,
      name: 'profile list',
      usage: 'dw profile list [--min-ms N] [--failed] [--hours N] [--limit N]',
      summary: '最近的查询 profile 清单',
      options: [
        { flag: '--min-ms N', desc: '只看耗时超过该值的查询' },
        { flag: '--failed', desc: '只看失败的查询' },
        { flag: '--hours N', desc: '时间窗口（小时）' },
        { flag: '--limit N', desc: '最多返回条数' },
        { flag: '--json', desc: '机器可读输出' },
      ],
    },
    {
      group: G_DIAG,
      name: 'profile get',
      usage: 'dw profile get <queryId> [--raw]',
      summary: '取一条 profile 的完整内容',
      options: [
        { flag: '--raw', desc: '不做截断/脱敏' },
        { flag: '--json', desc: '机器可读输出' },
      ],
      notes: ['先 profile list 拿 queryId，**别重跑 SQL**——已有 profile 比重跑一次更接近现场。'],
    },
    {
      group: G_DIAG,
      name: 'profile diff',
      usage: 'dw profile diff <qidA> <qidB>',
      summary: '两次 profile 的结构差异（快 vs 慢）',
      options: [{ flag: '--json', desc: '机器可读输出' }],
    },
    {
      group: G_DIAG,
      name: 'profile history',
      usage: 'dw profile history "<sql片段>" [--days N]',
      summary: '同一类 SQL 的耗时趋势',
      options: [
        { flag: '--days N', desc: '回看天数' },
        { flag: '--json', desc: '机器可读输出' },
      ],
    },
    {
      group: G_DIAG,
      name: 'tablet',
      usage: 'dw tablet <db.table> [--detail] [--partition <p>]',
      summary: 'tablet/分桶健康：行数、大小、倾斜',
      options: [
        { flag: '--detail', desc: '逐 tablet 明细（默认只给概览）' },
        { flag: '--partition <p>', desc: '只看某个分区' },
        { flag: '--json', desc: '机器可读输出' },
      ],
    },

    // ── MV 自查 ──
    {
      group: G_MV_RO,
      name: 'mv list',
      usage: 'dw mv list [--all-db] [--abnormal] [--json]',
      summary: '物化视图清单与健康状态',
      options: [
        { flag: '--all-db', desc: '跨库列出（不需要先定库上下文）' },
        { flag: '--abnormal', desc: '只列异常的（State≠NORMAL 或 RefreshState≠SUCCESS）' },
        { flag: '--json', desc: '机器可读输出' },
      ],
      notes: [
        '3.1.4 上 `SHOW MATERIALIZED VIEWS` 不可用，这里走 `mv_infos()` 表函数。',
        '`--all-db` 下某个库读不到不会让整条命令失败，但会列出来——静默跳过会把"某库有异常"漏报成"没有"。',
      ],
      examples: ['dw mv list --all-db --abnormal', 'dw mv list --json'],
    },
    {
      group: G_MV_RO,
      name: 'mv tasks',
      usage: 'dw mv tasks [--mv <name>] [--hours N] [--limit N] [--json]',
      summary: '刷新任务记录（真实刷新时刻/耗时只信这里）',
      options: [
        { flag: '--mv <name>', desc: '只看某张 MV' },
        { flag: '--hours N', desc: '时间窗口（小时）' },
        { flag: '--limit N', desc: '最多返回条数' },
        { flag: '--json', desc: '机器可读输出' },
      ],
      notes: ['RefreshInfo 里的时间不是整点锚点，**真实相位与耗时看 tasks()**。'],
    },
    {
      group: G_MV_RO,
      name: 'mv show',
      usage: 'dw mv show <mv> [--raw] [--json]',
      summary: 'MV 的 DDL 与属性（连接属性默认脱敏）',
      options: [
        { flag: '--raw', desc: '不脱敏（仅排查时用）' },
        { flag: '--json', desc: '机器可读输出' },
      ],
      notes: ['DDL 里会出现建连属性，默认把 password=… 这类字面量抹掉。'],
    },
    {
      group: G_MV_RO,
      name: 'mv phases',
      usage: 'dw mv phases [--json]',
      summary: '刷新相位分布 + 同分钟/撞车/依赖倒置体检',
      options: [{ flag: '--json', desc: '机器可读输出' }],
      notes: [
        '相位取自 tasks()，不是 RefreshInfo。',
        '「零间隔」比重叠更致命：上一张刚结束下一张就开始，前者的抖动会直接顶到后者。',
      ],
    },
    {
      group: G_MV_RO,
      name: 'mv refresh-mode',
      usage: 'dw mv refresh-mode [--mv <name>] [--hours N] [--all]',
      summary: '增量是否退化成全量（看 RefreshMode）',
      options: [
        { flag: '--mv <name>', desc: '只看某张 MV' },
        { flag: '--hours N', desc: '时间窗口（小时）' },
        { flag: '--all', desc: '含没有分区级增量的 MV（默认只看 EXPR 类型）' },
        { flag: '--json', desc: '机器可读输出' },
      ],
      notes: [
        '只有 partitionType=EXPR 才谈得上"增量退化"；其余类型本来就没有分区级增量。',
        '退化成全量的常见根因是非 excluded 基表按整表版本判脏——一张小时级 join 基表就能否决增量。',
      ],
    },
    {
      group: G_MV_RO,
      name: 'mv lineage',
      usage: 'dw mv lineage <mv> [--depth N] [--json]',
      summary: '下游链路 + ON COMMIT 高危清单',
      options: [
        { flag: '--depth N', desc: '下游追溯深度' },
        { flag: '--json', desc: '机器可读输出' },
      ],
      notes: ['ON COMMIT 的 MV 会被上游基表导入直接触发，换名/改定义前必须先看这里。'],
    },
    {
      group: G_MV_RO,
      name: 'mv drift',
      usage: 'dw mv drift [--dir mv_ddl] [--db <db>] [--json]',
      summary: '仓库里的定义 ↔ 线上 SHOW CREATE 的差异',
      options: [
        { flag: '--dir <dir>', desc: '仓库定义目录，默认 mv_ddl' },
        { flag: '--db <db>', desc: '库上下文' },
        { flag: '--json', desc: '机器可读输出' },
      ],
      notes: ['线上被人手工改过、或改完忘了回写仓库，都会在这里露出来。'],
    },
    {
      group: G_MV_RO,
      name: 'mv lint',
      usage: 'dw mv lint --file <ddl.sql> [--target <mv>] [--json]',
      summary: '对 DDL 做静态体检（不连库也能跑的那部分）',
      options: [
        { flag: '--file <ddl.sql>', desc: '要体检的 DDL 文件' },
        { flag: '--target <mv>', desc: '线上目标 MV；给出后会比对线上定义' },
        { flag: '--json', desc: '机器可读输出' },
      ],
    },

    // ── MV 写操作 ──
    {
      group: G_MV_RW,
      name: 'mv refresh',
      usage: 'dw mv refresh <mv> [--complete] [--apply]',
      summary: '手动刷新一张异步物化视图',
      write: true,
      options: [
        { flag: '--complete', desc: '全量刷新（REFRESH COMPLETE），默认按 MV 自身的刷新方式' },
        { flag: '--apply', desc: '真正执行' },
      ],
      notes: ['`CREATE ... REFRESH COMPLETE` 会把刷新方式**钉死**成全量，改回增量要重建定义。'],
      examples: ['dw mv refresh dws_x_1d', 'dw mv refresh dws_x_1d --apply'],
    },
    {
      group: G_MV_RW,
      name: 'mv schedule',
      usage: 'dw mv schedule <mv> --every N --unit HOUR --starts "YYYY-MM-DD HH:MM:SS" [--apply]',
      summary: '设置 MV 的刷新调度（周期 + 锚点）',
      write: true,
      options: [
        { flag: '--every N', desc: '周期数值' },
        { flag: '--unit HOUR|MINUTE|DAY', desc: '周期单位' },
        { flag: '--starts "..."', desc: '相位锚点（决定它落在整点的第几分钟）' },
        { flag: '--apply', desc: '真正执行' },
      ],
      notes: ['错峰就靠 --starts：改完用 dw mv phases 复核，避免和重活带撞车。'],
    },
    {
      group: G_MV_RW,
      name: 'mv freeze',
      usage: 'dw mv freeze <mv> [--apply]',
      summary: '冻结 MV 的自动刷新（排查/换名前用）',
      write: true,
      options: [{ flag: '--apply', desc: '真正执行' }],
    },
    {
      group: G_MV_RW,
      name: 'mv swap-plan',
      usage: 'dw mv swap-plan --target <mv> --source <mv_tmp> [--db <db>]',
      summary: '灰度替换的**清单**（只打印，不执行）',
      options: [
        { flag: '--target <mv>', desc: '线上正在服务的 MV' },
        { flag: '--source <mv_tmp>', desc: '新定义所在的临时 MV' },
        { flag: '--db <db>', desc: '库上下文' },
      ],
      notes: [
        '替换会**把调度一起换过去**：回退副本转 MANUAL，且 STARTS 被重置为当天。',
        'REPLACE WITH MATERIALIZED VIEW 后不能带库名限定；_tmp 锚点必须指向未来。',
        'DECIMAL 除法会被提升成 double，顶翻下游 UNION 的 column type not same——列类型要先对齐。',
      ],
      examples: ['dw mv swap-plan --target dws_x_1d --source dws_x_1d_tmp'],
    },
    {
      group: G_MV_RW,
      name: 'mv swap-apply',
      usage: 'dw mv swap-apply --target <mv> --source <mv_tmp> [--db <db>] [--apply]',
      summary: '执行灰度替换（默认 dry-run）',
      write: true,
      options: [
        { flag: '--target <mv>', desc: '线上正在服务的 MV' },
        { flag: '--source <mv_tmp>', desc: '新定义所在的临时 MV' },
        { flag: '--db <db>', desc: '库上下文' },
        { flag: '--apply', desc: '真正执行' },
      ],
      notes: ['先跑 swap-plan 复核清单；替换后立刻用 mv list / mv verify-phase 复核状态与相位。'],
    },
    {
      group: G_MV_RW,
      name: 'mv verify-phase',
      usage: 'dw mv verify-phase <mv> --expect "HH:MM:SS"',
      summary: '复核某张 MV 的实际刷新相位是否落在预期锚点',
      options: [
        { flag: '--expect "HH:MM:SS"', desc: '预期的锚点时刻' },
        { flag: '--json', desc: '机器可读输出' },
      ],
      notes: ['相位取 tasks() 的真实开始时刻，不是 RefreshInfo。'],
    },

    // ── 分区 ──
    {
      group: G_PART,
      name: 'partition list',
      usage: 'dw partition list <db.table> [--json]',
      summary: '分区清单（含行数/大小）',
      options: [{ flag: '--json', desc: '机器可读输出' }],
    },
    {
      group: G_PART,
      name: 'partition rolloff',
      usage: 'dw partition rolloff <db.table> --keep N [--max-drop N] [--apply]',
      summary: '按保留数量回收旧分区（TTL）',
      write: true,
      options: [
        { flag: '--keep N', desc: '保留最近 N 个分区' },
        { flag: '--max-drop N', desc: '单次最多删几个（防手抖删多）' },
        { flag: '--apply', desc: '真正执行' },
      ],
      notes: ['先看 dry-run 打印的 DROP 清单，确认后再 --apply。'],
    },
  ],
  footer: [
    `通用: [--env <name>] [--db <db>] [--readonly] [--json] [--version] [--help]`,
    '',
    '安全模型:',
    '  只读闸门默认开启（仅 SELECT/WITH/SHOW/EXPLAIN/DESC，拒多语句）；写操作一律 dry-run；',
    '  环境标 readonly 时写操作被拒（DW_PROFILE=prod 且未设 DW_ALLOW_PROD_WRITE=1）；',
    '  `--readonly` 可显式打开只读（与上面同一个判断点，不产生第二个开关）。',
    '  输出默认脱敏：结果列、DDL 连接属性、host；--raw / --reveal-host 才回原值。',
    '',
    '配置:',
    '  ~/.dw/warehouse.json              非敏感连接信息（0644）',
    '  ~/.dw/warehouse-credentials.json  密码（0600）',
    '  根目录可用 DW_HOME 覆盖；详见 docs/DW-COMMAND-REFERENCE.md',
    '',
    '提示: dw <命令> --help 看该命令的选项与坑（含 Doris 侧的硬限制）。',
  ],
};
