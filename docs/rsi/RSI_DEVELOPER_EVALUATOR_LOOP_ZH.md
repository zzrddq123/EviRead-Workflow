# Developer–Evaluator RSI 主循环

本文是当前 codebase 的 RSI 主流程说明。它回答四个问题：

1. 「开发智能体」与「评测智能体」分别能看到什么；
2. 一版功能预测智能体从冻结、评测、反思到下一版的顺序是什么；
3. 每一版的评测分析和下一步计划保存在哪里；
4. 版本树如何支持继续、回退和从历史节点重新探索。

底层 tag、event、StateRoot 与失败恢复细节见
[`RSI_CODE_VERSION_GRAPH_ZH.md`](RSI_CODE_VERSION_GRAPH_ZH.md)。

## 1. 结论：当前采用的唯一主循环

```text
上一终态节点 + 完整 public history
        │
        ▼
开发智能体先固化反思和 pre-code plan
（root 之外必须先于下一版注册）
        │
        ▼
在唯一 primary checkout 中准备 plan 指定的 exact base
并创建短生命周期 working branch
        │
        ▼
修改、公开验证、commit
        │
        ▼
注册 immutable code version，并核验 remote refs
        │
        ▼
发布 remote evaluation opening
（固定版本、评测协议和指定蛋白 cohort；此时尚未读取 gold）
        │
        ▼
评测智能体在私有域运行
（可看冻结预测、标准答案、逐蛋白候选与错误归因）
        │
        ▼
公开 aggregate metrics + 脱敏 Teacher 分析
（overall / MF / BP / CC、诊断、建议；无 GO 答案和逐蛋白内容）
        │
        ▼
记录 continue / backtrack / retain
（gate 只改变 selected/champion 指针，不删除版本节点）
        │
        ▼
验证并耐久保存 StateRoot / receipts / remote refs
        │
        ▼
开发智能体再次读取完整历史树并反思
        ├── evaluation_analysis.md
        └── next_optimization_plan.md
                ├── stop：冻结终止原因，不再创建子版本
                │
                └── proceed
                        └──────────────────────────► 下一轮
```

这不是“每轮新建一个长期分支或永久 worktree”的模式。默认物理结构只有一个长期 codebase/primary
checkout；每轮在同一目录切到 plan 授权的 exact base，并使用短生命周期 working branch 施工。Git
branch/worktree 只是临时指针或可选隔离空间；真正的一版由 exact commit/tree、不可变
`rsi/version` tag、连续 event、plan/Developer context、evaluation records 和耐久 artifact 共同标识。

因此 `v0001`、`v0002`、`v0003`、`v0004` 可以同时永久保存在同一个 Git repository 中，而文件系统上只保留一份
可编辑 checkout。某一时刻 checkout 显示哪一版，不决定哪个版本是 champion；额外 worktree 仅在明确需要
并行/隔离时 opt-in 创建，不能作为默认的一版一目录版本管理。

初始 root 是唯一没有 parent plan 的例外。之后每个进入正式评测的 candidate 都必须先由上一终态节点
的完整历史产生 plan，再完成 commit/verification/registration/remote verification，并在读取任何
private label/gold 之前发布 opening。正式评测通常是带聚合蛋白指标和 Teacher 反馈的 adaptive 路径；
当前唯一允许形成终态的 `frozen_replay` 是精确绑定
`z55-prospective20-mf-consensus-v1`、固定 cohort/control/candidate/method/ontology、真实 live replay
与 selection/test gate 的详细 Z-55 receipt；任意 generic checks receipt 都不能形成终态。该路径没有
Teacher，不能伪装成 adaptive Teacher 评测。流程不完整的旧实验只能 retrospective 留档，不能获得
prospective selection 资格。

Z-55 的执行顺序也是协议的一部分，不能交换：

1. 先提交并验证完整代码，再注册、推送不可变 `v0002`；
2. 用 tracked `protocols/z55-prospective20-v0002.json` 发布并远端验证 evaluation opening；
3. `benchmark prepare --profile prospective20` 在读取 source/gold 前再次核对 clean HEAD、remote version
   和 opening，并要求八份 prior id-map（至少 122 个当前 source 身份及序列哈希）；
4. 用同一冻结 cohort 生成 control batch，随后 evaluator 在打开 private role shards 前完成 control
   pure replay、candidate live replay、DeepGOPlus raw output 和全部预测哈希冻结；
5. selection decision 固定后只打开一次 test，再把详细 public summary 原样用于
   `rsi-version-evaluation-complete`、publication 和 closed decision。

### 1.1 当前默认基线：current best v0004

当前 remote 中可验证的正式 code-version 节点是 `v0001`、`v0002`、`v0003`、`v0004`。root `v0001` 的
`retrospective_legacy` publication 仍只是 software/lineage/repository-integrity evidence；它没有当时
预提交的蛋白 cohort、蛋白指标或 Teacher 蛋白反馈。`v0002` 在 pre-gold contract failure 后回退；
`v0003` 完成 Z-55 frozen replay 后因 selection regression 回退。事件 20 以显式 epoch-resume 恢复
研究，事件 21 注册整合 prediction 与 autonomous framework 改进的 `v0004`。

`v0004` 的 Priority100 40/20/20/20 结果是在既有开发流程中产生的回顾证据，不能倒填成 prospective
evaluation。因此对下一轮 Plan 起作用的字段是 `currentBestVersionId=v0004`。旧的
`lastProspectivelySelectedVersionId=v0001` 仅用于说明上一次严格 prospective 合同当时选了谁；
兼容字段仍会输出 `selectedVersionId=v0001` 和 `operationalIncumbentVersionId=v0004`。v0004 仍标记为 prospective
unevaluated/protein-incomplete；retrospective incumbent event 只把它从“阻塞下一轮的 unresolved
version”中解开，并预注册唯一 `v0005` 计划。v0005 必须基于 v0004，并从 fresh prospective opening
开始新评测。

这些记录说明 code-version graph 已实际跑过多轮，也同时限制了可作出的结论：Z-55 frozen replay
固定为 `proteinEvaluation=false`、`teacher=null`，不能写成 adaptive Teacher 蛋白评测；旧 campaign
结果也不能倒填成 `v0001` 的蛋白证据。新的 v2 plan/retain 语义只用于后续 append；既有 v1 plan tag
与 v0002/v0003 backtrack decisions 必须继续兼容验证，不能重写 event 1–19。

### 1.2 stable controller 与 candidate plane 必须分开

primary checkout 切到 `v0001` 等历史 base 时，candidate 目录内的 `./pi-agent`、schema 和 outer RSI
实现也会回到该历史版本。它适合运行本版功能预测科学代码、公开测试和冻结 prediction，但不能成为当前
graph 的控制器；否则旧 candidate 可以用旧规则写入新 event，单目录反而会破坏 append-only 合同。

正式 graph 操作统一使用 content-addressed stable controller runner。runner 由 prepare 的结构化结果
返回，或在切换历史 base 前通过 `rsi-controller-install` 生成，安装在 Git common directory 内，而非
任何 worktree/candidate tree；因此它既不污染 candidate commit，也不会随 checkout 回退。调用者必须
原样使用结构化结果返回的 `nodeExecutablePath`/`runnerPath`（runner 会验证 Node executable
SHA-256）。installer 只接受一个绝对 `--repo`；每次 runner 调用都必须显式传入绝对 `--repo` 和
`--remote`。当前 controller generation 的普通 CLI 只可直接执行 installer，或 bootstrap
`rsi-version-prepare`（它会安装/验证 bundle 后，以 child process 调用 exact Node/runner）；其他
`rsi-version-*` 一律要求直接使用 stable runner。不可变历史版本无法被追溯修改，其 legacy route
可能仍可进入旧 controller，因此历史 checkout 的普通 CLI 是规范上禁止使用，而不是技术上已被删除。
本文下方的
`$RSI_NODE`/`$RSI_CONTROLLER` 即表示这对路径，调用形式是
`"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-... --repo /absolute/repository --remote origin`，不是
历史 checkout 中的 `./pi-agent benchmark rsi-version-...`。

controller plane 与 candidate plane 分离不赋予隐式恢复权限。既有 event 19 的 stop 已由 event 20
的 append-only epoch-resume 合法恢复并精确登记 v0004；后续也只能消费最新 retrospective-incumbent
event 中 hash-bound 的 v0005 计划，不能靠切 branch 或手写 tag 跳过。

这一边界解决的是受支持流程中的版本代际隔离和误用旧 controller，不会赋予系统追溯改写历史 CLI 的
能力，也不是针对同一 OS 用户的对抗性安全隔离。能写 Git common directory、控制进程或使用相同
credential 的操作者仍可能绕过正常入口；抵抗恶意操作者需要独立 identity、受保护 remote refs 和
部署层权限策略。

同理，协议前的 Z-46/Z-47 branch、pilot worktree 和已经打开过的 selection/test 结果可以作为
retrospective evidence 保存，并进入未来的完整历史反思，但不能事后伪装成 prospective `v0002`，也
不能参与新的 champion 选择。旧 Z-46 evaluator worktree 的设计决策、验证结果和 claim boundary 已整理
为 [`research/z46_pilot_evaluator_worktree_notes.v1.md`](../research/z46_pilot_evaluator_worktree_notes.v1.md)。

## 2. 双层 codebase

### 2.1 外层：RSI harness

外层负责：

- 冻结完整 codebase；
- 在读取 private/gold 前固定 evaluation opening；
- 调用功能预测智能体完成盲预测；
- 把预测与标准答案交给 Evaluator/Teacher；
- 保存私有完整评测、公开脱敏聚合结果和选择决策；
- 为 Developer 重建完整历史上下文；
- 固化本轮分析与下一轮 pre-code 计划；
- 约束 fork、注册、继续与回退；
- 导出论文可公开的版本树和探索记录。

### 2.2 内层：蛋白功能预测智能体

内层接收 FASTA 和可选 PDB，执行：

```text
输入匿名化
  → 序列/结构证据获取
  → query-like donor 隔离
  → GO 候选生成
  → 多来源证据融合与系统发育调整
  → ontology 安全闭包
  → aspect-aware 选择、阈值与 abstention
  → 功能叙述与独立审阅
  → JSON / TSV / Markdown / HTML 输出
```

内层不能从标准答案直接生成 GO 标签。标准答案只在外层 Evaluator 私有域中用于评测。

## 3. 两个角色的上下文不同

| 信息 | Developer 公共合同 | Evaluator/Teacher 私有合同 |
| --- | --- | --- |
| 完整 code-version 历史和分支结果 | 可见 | 可见当前评测 binding |
| 当前版本的冻结预测 | 仅通过公开聚合结果间接可见 | 可见 |
| 指定蛋白的身份与标准答案 | 不提供 | 可见 |
| 逐蛋白候选、遗漏和错误阶段 | 不提供 | 可见 |
| overall / MF / BP / CC 聚合指标 | 可见 | 可见 |
| closed Teacher diagnosis/action | 可见 | 可见 |
| evaluator-private 文件、路径和身份映射 | 不提供 | 可见 |
| 脱敏外部 research cards | 可见 | 不要求 |
| 下一版代码修改计划 | 创建并可见 | 不负责创建 |

当前“评测智能体”具体实现是受信的 deterministic scorer + structured Teacher role，不是一个可以读取
gold 后自由输出任意文字的无约束 LLM AgentSession。这样可以让每个公开诊断重新计算并通过 closed schema
检查；若未来替换为独立模型智能体，它也必须在相同私有边界内运行，并把输出收窄成同一个可验证公共合同。

普通 adaptive 路径会在读取 gold 前冻结 control 和 challenger 的全部预测。Evaluator 私有 bundle
现在还保留每个 case 的完整 `GOPredictionSet`，因此 detailed Teacher 可以检查候选生成、证据、
selector 和 aspect trade-off；只有量化、closed、通过泄漏检查的投影进入 Developer feedback。
grouped-OOF 路径没有一份可与普通 replay 等价的完整逐例 trace，因此当前不会声称它产生了同等级的
detailed Teacher；它仍保留 causal/aggregate 反馈。

这里的“不可见/不提供”是 harness 的角色输入与可序列化 artifact 合同：不同目录、读取顺序、closed
schema、hash binding 和 identifier/path 扫描会阻止正常命令把 private 字段复制给 Developer。它不是
同一机器所有者面前的强保密，也不是完备的内容 DLP、信息流证明或 differential privacy。拥有整个
filesystem、进程或 credential 权限的人仍可能越过角色命令直接读取 private 文件。正式实验应把
Developer 与 Evaluator 放到不同 OS user/container/remote worker，并让 Developer 的挂载和凭证根本
无法访问 gold、身份映射和 evaluator-private StateRoot。

## 4. 一轮 RSI 的严格顺序

正式评测的 admission 条件是一个合取门：非 root candidate 必须绑定完整 history head 和上一节点的
pre-code plan；候选必须 clean、已 commit、通过公开验证并注册；相关 semantic/event refs 必须已在
remote；opening 必须先于任何 private label/gold 读取。满足部分条件不等于获得 selection 资格。

### 4.1 冻结 code version

只有 clean、已 commit、通过公开软件验证的完整 codebase 才能注册。注册后得到
`refs/tags/rsi/version/<version-id>`；未注册的 WIP 不算一个 RSI 版本。

root 之外的版本必须同时绑定：

- v2 plan 显式授权的 `baseVersionId`；它必须是 bound history prefix 中已注册 version，但不必是
  selected/champion；
- Developer 当时看到的完整 public history head；
- 上一轮不可变 exploration manifest；
- `evaluation_analysis` hash；
- `next_optimization_plan` hash；
- 计划中的 exact `plannedVersionId`、hypothesis 和 change summary。

这里可证明的顺序是：immutable exploration event 必须先于 child **version registration event**，且
child 注册必须精确绑定该 plan。plan schema 也不允许写入未来 commit、implementation、prediction 或
test hash。它不能证明开发者在其他目录里从未提前写过草稿或创建过未注册 commit，也不能仅凭
`changeSummary` 证明实际 diff 的每一行都符合 `codeChangeTargets`。因此准确说法是“不能先把 child
登记为 RSI 版本，再事后补 plan”，而不是“密码学证明任何代码字节都晚于思考产生”。

注册完成后还必须用指定 remote 重新验证完整 RSI namespace。只有本地 tag、尚未推送的 commit 或
remote/local object ID 不一致时，都不得进入 formal opening。

### 4.2 opening 先于 gold

Evaluator 开始前先发布 opening，固定：

- 被评测的 version/commit；
- evaluation ID；
- 评测 protocol hash；
- 指定蛋白 cohort；
- control/challenger 与执行策略。

opening 发布后，才允许读取 private/gold。若进程中断，opening 仍留在事件链中并被报告为 incomplete，
不能删除后假装没有发生。

### 4.3 Evaluator 私有评测

Evaluator 可以同时看到：

- 每个指定蛋白的标准答案；
- control/challenger 的冻结预测；
- 完整 GO 候选与最终选择；
- 证据来源、selector blocker 和失败阶段。

它计算匹配的 CAFA 风格聚合指标、paired uncertainty、overall/MF/BP/CC trade-off，并产生结构化
Teacher diagnosis/action。原始 gold、GO ID、蛋白身份和逐蛋白错误只保存在 evaluator-private
StateRoot。

### 4.4 公开结果与决策

公开 publication 只包含：

- cohort role 和 case count；
- overall/MF/BP/CC 聚合指标；
- control/challenger delta 与 guardrail；
- closed hypothesis/mechanism verdict；
- closed diagnoses 和 prioritized actions；
- 方法假设、修改摘要和公开 hash bindings；
- claim boundary。

随后记录：

- `continue`：candidate 被选中；
- `backtrack`：candidate 被拒绝，selected version 改为 candidate 的一个严格祖先；目标必须历史上曾
  被 selected；
- `retain`：candidate 被拒绝，selected version 保持本次 evaluation 的 `selectionBefore`。这既适用于
  root，也适用于从旧 base 创建、而当前 champion 是其 sibling/非祖先的 candidate。

版本号表达“正式冻结并接受评测的节点”，不表达“比上一版更好”。gate 只改变 selected/champion
指针，不决定 candidate 是否编号，也不允许删除、覆盖或重命名节点。失败、打平、回退或未晋级版本仍须
保留 version、opening、result、publication、decision、archive 和后续 exploration，并成为下一轮
避免重复失败的历史证据。
这三项是 evaluation decision；`stop` 不是第四种 decision，而是 decision 之后
`next_optimization_plan` 的终止动作。相反，`proceed` 才授权创建下一 child。

### 4.5 Developer 反思并写入探索树

terminal evaluation + publication + decision 完成后，Developer 读取完整 public history，并提交一个
不含未来 commit/implementation/test/prediction hash 的结构化 plan spec。这里的 terminal evaluation
可以是 adaptive 蛋白评测，也可以是完成上述 Z-55 closed-receipt decision 的 prospective
`frozen_replay`；
通过的普通 `software_verification` 仍是非终态，不能触发反思。harness 从可信的结构化字段确定性生成
两份文本：

这里的“完整”是全树而不是 selected lineage：即使下一轮代码选择任意已注册历史 base，history head
仍必须覆盖已经公开的失败、打平、retain、回退、sibling 和 incomplete 分支。**代码基线可以选择历史
节点，知识基线不能回退。**

```text
exploration-tree/
├── tree.json
└── versions/
    └── <evaluated-version-id>/
        ├── evaluation_analysis.md
        ├── next_optimization_plan.md
        └── manifest.json
```

`evaluation_analysis.md` 属于被评测版本。adaptive 路径包含：

- 版本、评测协议和 public bindings；
- overall/MF/BP/CC 聚合结果；
- Evaluator/Teacher 的脱敏诊断和优先建议；
- continue/backtrack/retain 决策；
- 明确的信息 suppression 与 claim boundary。

若终态来自 prospective `frozen_replay`，该文件只呈现 public checks、decision 和 hash bindings，
并明确保存 `proteinEvaluation=false`、`teacher=null`；它没有 overall/MF/BP/CC 指标，也没有
Evaluator/Teacher 诊断，不能据此声称蛋白功能预测性能提升。

`next_optimization_plan.md` 也属于被评测版本，包含：

- Developer 凝练的问题判断；
- 本轮 Teacher diagnosis/action（仅 adaptive 蛋白评测存在；frozen replay 固定为空）；
- 读取的 exact history head；
- 下一轮显式 `baseVersionId`（bound history prefix 中的已注册 version，与 champion 独立）；
- 外部 research cards；
- hypothesis、修改目标、control、falsifier 和 rollback 条件；
- 对 overall/MF/BP/CC 分别预期 improve、hold 或 not-targeted；
- 下一版计划 ID。

Markdown 是给人阅读和论文展示的确定性视图。不可变 structured tag/event 才是机器权威；删除导出目录后，
fresh clone 仍能逐字重建相同文件和 hash。

### 4.6 外部知识如何进入

Developer 可以根据 Teacher 的公开诊断联网检索，但原始搜索结果不能直接进入评测历史。进入 plan 的必须是
脱敏、closed 的 research card：

- opaque `EXT-####` evidence ID；
- 简短 finding；
- limitations；
- 支持的组件枚举。

当前 harness 能验证、绑定和保存这些 cards，但不会自主打开浏览器完成检索。也就是说，“搜索什么、如何
清洗来源”仍由 Developer/外部 research stage 执行；“进入下一版计划的内容是否与历史和 code version
精确绑定”由 harness 强制。

### 4.7 根据计划开发下一版

若 plan 为 `proceed`：

1. harness 默认在唯一 primary checkout 中，从 plan 指定的 exact base 准备一个短生命周期 working
   branch；目标 branch 不得已存在，Developer context 必须 exclusive-create 到 repository 外；
2. Developer 在同一 codebase 目录修改并运行公开验证；
3. commit 后注册计划中的 child version；
4. 注册时必须逐项匹配 plan 的 version ID、hypothesis、change summary 和 parent/base；
5. 新版本冻结并完成 remote ref 核验后才可打开下一次评测。

默认入口是 `rsi-version-prepare`。latest `proceed` exploration/plan 是唯一 authority；
v2 plan 可把 bound history prefix 中任意已注册 version 写成 `baseVersionId`；`--from-version` 只作
expected-base assertion，不能覆盖 plan 或选择裸 commit。需要并行或隔离时仍可显式使用
`rsi-version-fork` 创建 detached linked worktree，但它只是 opt-in 施工副本，不是版本本体，也不应
永久保留。

若 v2 被拒绝并 backtrack 到 v1：

```text
v1
├── v2  ← 保存 v2 的分析与“从 v1 再试”的计划
└── v3  ← 由该计划产生的新 sibling
```

分析仍放在 `versions/v2/`，因为它解释的是 v2 的结果；plan 的 `baseVersionId` 则是 v1。这样既不抹掉
失败节点，也不会错误地把 v3 说成 v2 的后代。

若 plan 为 `stop`，它仍被记录为 terminal exploration，但不会允许 prepare/fork 下一版本。

若版本链为 `v1 → v2 → v3`，且三者都曾成为 selected version，v3 被拒绝时仍可使用兼容的 backtrack：

- 保持 v2 时可 backtrack 到 evaluation 的 `selectionBefore=v2`；
- 在 strict versioned round 传 `--backtrack-version v1`，显式回到 v1。

目标必须同时满足“v3 的严格 Git 祖先”和“历史上曾被 selected”；不能跳到 sibling、未选择过的实验节点
或任意 commit。decision 记录 v1 后，下一条 v2 plan 的 `baseVersionId` 仍可独立选择 history prefix
中的任意已注册 version；下一 child 成为该 plan base 的子节点，而 v2/v3 及其失败分析继续保留。

若 `v2` 是 current champion，但 Developer 从历史 `v1` 开出 sibling `v3`，则 `v3` 失败时不能
backtrack 到 sibling v2；默认 decision 是 `retain(v2)`，明确保存
`selectedVersionId == selectionBefore == v2`。旧 backtrack 历史仍不重写，新的 retain 也不会删除 v3。

### 4.8 历史实验与 worktree 生命周期

对 prospective 合同上线前或顺序不完整的实验，只做两件事：

1. 以 `retrospective experiment` 明确记录当时真实存在的 commit、假设、验证、聚合结论、限制和失败
   机制；禁止事后虚构 plan/opening/selection 资格；
2. 把这份限定知识纳入后续完整 history/plan，但已经打开过的 selection/test 不得再次用于调参或晋级。

回顾记录使用“先归档验证、再写图事件”的两层显式命令，不允许只留下本地 ignored 目录：

```bash
./pi-agent benchmark rsi-retrospective-archive-create \
  --source-root /producing/repository \
  --spec /durable/specs/retrospective-archive.json \
  --output-dir /durable/state-roots/retrospective-run

./pi-agent benchmark rsi-retrospective-archive-verify \
  --archive-dir /durable/state-roots/retrospective-run

"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-retrospective-record \
  --repo /clean/record-commit-worktree \
  --record-id historical-run-id \
  --receipt research/tracked-retrospective-receipt.json \
  --archive-seal-hash SHA256 \
  --archive-public-manifest-hash SHA256 \
  --remote origin
```

archive spec 是 closed、hash-bound 的 public/private artifact 清单；创建命令拒绝 symlink、路径逃逸、
源重叠、覆盖和复制期间变化，verify 不再依赖 source worktree。record 命令把 exact evaluated
commit/tree、tracked receipt blob/hash、当时 selected/event head 和 archive hashes 追加到
`rsi/retrospective/*` + event log；它不创建 `rsi/version`，也不改 decision/selected。

当最新唯一 unresolved version 已经存在，而且人类明确决定把它作为开发基线时，使用另一条更窄的合同：

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-incumbent-adopt \
  --repo /path/to/repository \
  --remote origin \
  --adoption-id adopt-v0004-priority100 \
  --spec /path/to/repository/protocols/rsi-v0004-retrospective-incumbent-v0005.json
```

它会绑定 tracked report、cohort/metric/artifact hashes，并冻结唯一下一 candidate 的计划。它只移动
operational incumbent，不移动 formal champion；下一版 register 必须消费 exact adoption ID，之后
仍须发布 fresh prospective opening。

primary checkout 是长期保留的唯一开发目录；短期 branch 和显式 opt-in 的额外 worktree 只是施工
指针/副本，不是版本身份，也不是耐久知识库。删除 branch 或移除额外 worktree 前必须全部满足：

- 非生成的 findings、plan、validation/error notes 已进入受 Git 管理的研究记录或其他耐久档案；
- StateRoot/receipt/result 的持久副本存在，且 archive verifier 通过；
- exact commit/tree 和所需 version/evaluation/publication/decision/exploration/event refs 已在 remote，
  object ID 与本地一致；
- fresh clone 能验证图并重建应有的公开探索文本。

任一项未满足都禁止清理。primary checkout 本身不删除；额外 linked worktree 满足门后使用
`git worktree remove`，不要用递归删除绕过 Git 元数据检查。清理 branch/worktree 不得伴随删除失败
version tag 或其 semantic/event records；清理的是施工指针/副本，不是探索历史。

## 5. 命令顺序

下面省略了各 benchmark 的具体 suite、StateRoot 和 predictor 参数，只展示版本闭环。它是未来存在合法
`proceed` plan 或 retrospective-incumbent plan 且 adaptive 集成已完成 controller/candidate 拆分时的目标示例；当前
`outer-adaptive-versioned-*` 仍把若干 graph side effects 与 candidate 执行耦合，不能从 historical
checkout 直接用于新正式轮次。当前 v0005 必须消费已注册的 v0004 incumbent plan：

```bash
# 0. 在切换历史 base 前，从 clean、可信的当前 checkout 安装 stable controller；
#    两个变量必须取 installer/prepare 返回的 nodeExecutablePath/runnerPath。
./pi-agent benchmark rsi-controller-install \
  --repo /path/to/repository
# 所有部署都必须复制本次结构化返回值，不能手工猜路径。
RSI_NODE=/exact/nodeExecutablePath/from/structured-output
RSI_CONTROLLER=/exact/runnerPath/from/structured-output

# 1. 已冻结版本先由 stable controller 做只含 label-free precommit 的 opening
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-verify \
  --repo /path/to/repository --remote origin --format json

"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-evaluation-open \
  --repo /path/to/repository \
  --remote origin \
  --version-id v3 \
  --evaluation-id eval-v3 \
  --protocol-id protocol-v3 \
  --protocol-file protocols/protocol-v3.json

# 1b. opening 已发布后，candidate plane 才运行科学代码/测试/冻结 prediction；
#     Evaluator 生成公开 result + 耐久 StateRoot，但不写 refs/tags/rsi/*。
#     现有 outer-adaptive-versioned-* 仍混合 graph side effects，集成拆分完成前不得
#     从 historical candidate checkout 用作新正式轮次入口。

# 1c. stable controller 根据冻结产物完成 graph result → publication → decision
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-evaluation-complete \
  --repo /path/to/repository \
  --remote origin \
  --evaluation-id eval-v3 \
  --result-kind adaptive_development \
  --result-file /durable/public-results/eval-v3.json \
  --state-root-dir /durable/state-roots/eval-v3 \
  --claim-boundary "adaptive-development evidence only"

"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-evaluation-publish \
  --repo /path/to/repository \
  --remote origin \
  --evaluation-id eval-v3 \
  --publication-mode prospective \
  --state-root-dir /durable/state-roots/eval-v3 \
  --claim-boundary "adaptive-development evidence only"

"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-decide \
  --repo /path/to/repository \
  --remote origin \
  --decision-id decide-v3 \
  --evaluation-id eval-v3 \
  --action backtrack \
  --selected-version v1 \
  --rationale "precommitted gate rejected the candidate"

# 2. Developer 基于完整历史提交 pre-code plan
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-exploration-record \
  --repo /path/to/repository \
  --exploration-id reflect-v2 \
  --plan-spec /durable/plans/next-plan-v3.json \
  --remote origin

# 3. 导出/更新给人阅读的探索树
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-exploration-export \
  --repo /path/to/repository \
  --output-dir /durable/exploration-tree \
  --remote origin

# 4. 默认在同一个 primary checkout 中准备 plan 授权的 exact base
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-prepare \
  --repo /path/to/repository \
  --from-version v1 \
  --developer-exploration reflect-v2 \
  --branch rsi/dev/v3 \
  --developer-context-output /durable/history/v3-context.json \
  --remote origin

# 5. 修改、公开验证、commit 后冻结下一版
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-register \
  --repo /path/to/repository \
  --version-id v3 \
  --parent-version v1 \
  --change-summary "与 plan 完全一致的修改摘要" \
  --hypothesis "与 plan 完全一致的假设" \
  --verification-receipt /durable/receipts/v3.json \
  --developer-context /durable/history/v3-context.json \
  --developer-exploration reflect-v2 \
  --remote origin
```

第 4 步不会创建新 repository/worktree；`--from-version` 仅断言调用者预期的 base 与 plan 相同。若明确
需要并行/隔离，可把这一条替换为 `rsi-version-fork ... --worktree /optional/path`，其余版本身份和
注册合同不变。

plan spec 使用 `pi-rsi-next-optimization-plan-spec.v2` closed schema；它显式保存
`baseVersionId`，该值必须引用 bound history prefix 中已注册 version，并在 `proceed` 时成为 planned
child 的 parent。spec 必须在写 tag 前带有对除
`canonicalHash` 外全部字段计算出的 canonical SHA-256；未知字段、未来 code hash、GO/蛋白标识、
序列、URL、绝对路径、当前探测器能识别的长编码 payload、控制字符或 evaluator-private 标记都会
fail closed。该扫描是误泄漏防线，不是对任意隐写或分段编码的完备信息流证明。

## 6. 如何用于文章公开

可以公开：

- 完整 `refs/tags/rsi/*`；
- `rsi-version-paper-export` 的 JSON/Markdown；
- `rsi-version-exploration-export` 的 tree 和每版本两份文本；
- public StateRoot artifacts；
- 软件验证 receipts；
- 外部 research-card catalog。

不能公开：

- evaluator-private StateRoot；
- 指定蛋白的身份映射；
- 逐蛋白 gold、预测和错误归因；
- private manifest/path；
- 任何会反推出保密 target 的材料。

论文可据此展示“每一版看到了哪些历史、Evaluator 发现了什么、Developer 如何计划、为什么继续或回退、
下一版代码与哪份计划绑定”。对于协议上线前没有做过蛋白评测的旧节点，只能如实公开
software/lineage-only 记录；不能追补虚构的蛋白指标或 Teacher 结论。

## 7. 当前限制

- 历史 event 19 的 `stop` 已由 event 20 的显式 append-only resume 合法恢复；v0004 当前只获得
  retrospective operational-incumbent 身份。Priority100 不能成为 formal promotion evidence，
  v0005 仍需 fresh prospective opening 和新的独立评测。
- 当前严格 adaptive evaluator 使用预封存的 30-protein development cohort；“任意数量、临时指定”的
  蛋白集合尚不是同一个严格入口。可先把指定蛋白制作成新的、预提交且隔离的 suite/protocol。
- adaptive-development 结果是开发集证据，不自动成为 independent holdout、leaderboard 或
  BioReason-Pro 对等结论。
- 外部联网研究尚需 Developer/外部 research stage 发起和清洗；harness 只接收并绑定脱敏 cards。
- plan spec 由 Developer/调用者提交；harness 验证其 closed schema、完整历史 binding、v2
  `baseVersionId` 已在 bound prefix 注册和事件顺序，但不会自主联网、自动生成完整反思，也不能证明
  提交者在认知上实际使用了所有历史。
- Developer/Evaluator 的公共/私有序列化合同是 fail-closed 的正常命令边界；强进程、账号、filesystem
  和 credential 隔离仍属于部署层。
- 当前 exploration 文本保存 public aggregate + causal closed Teacher 投影，不公开逐蛋白错误；
  evaluator-private detailed record 仍须作为受限审计材料单独保存。
- Git tag 当前未签名；正式发布应保护 `refs/tags/rsi/**`、禁止删除/force-update，并增加签名或外部
  transparency anchor。
- 公开聚合层是最小披露和 identifier DLP，不是 differential privacy；极小 cohort 的统计发布仍需
  单独的 suppression policy。
