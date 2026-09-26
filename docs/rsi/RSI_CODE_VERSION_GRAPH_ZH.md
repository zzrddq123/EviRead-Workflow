# RSI 整体 codebase 版本图

## 1. 先澄清：旧的 method tree 不是 code tree

仓库原有的 `outer-adaptive-*` exploration tree 记录的是一次 campaign 内的
proposal、Teacher feedback、outcome、retained generation 和 source commit。它适合回答“某个方法
为什么被提出、评测结果怎样、下一轮学到了什么”，但不等于“每一轮都先冻结了一份完整 codebase”：

- 多个 generation 可以引用同一个 source commit；
- campaign 目录通常被 `.gitignore` 排除，删除 worktree 前若没有创建 StateRoot，文件不会仅靠 Git
  保留下来；
- 普通开发分支、merge commit 和早期 `rsi-z*` tag 没有表达统一的版本父节点、评测开启事件和选择决策；
- `main` 指向哪个 commit，也不能说明 RSI 当前选择了哪个历史版本。

因此旧记录仍然是有价值的 method/evaluation lineage，但不能把它倒推成完整的 code-version lineage。
第一版版本图解决了 code version、opening、result 和 decision 的追溯，但仍有一个关键缺口：result tag
只保存 artifact/StateRoot hash，Developer 只看到当前 campaign 的简化历史，单靠 fresh clone 不能得到
逐版本的公开指标、Teacher 诊断和下一步建议，也不能直接导出论文所需的完整迭代表。

当前协议已经补上这一缺口：每个完成的 result 还必须有一条 immutable publication；每个 terminal
evaluation/decision 之后还可追加一条 immutable Developer exploration，把确定性评测分析和
Developer-authored 下一步计划绑定到同一个历史 prefix。新 candidate 必须绑定这条 exploration 以及由
完整公开版本图生成的 Developer context；公共历史和每版本两份探索文本都可确定性导出。旧 tag 仍按当时
事实保留，不能移动、覆盖或重写。对协议启用前已经做完 decision 的版本，只允许追加明确标记为
`retrospective_legacy` 的公开摘要，且只能陈述当时已有证据，不能事后伪造 opening、蛋白评测或 Teacher
结论。

## 2. 新模型：版本树 + 线性决策日志

新机制把以下对象分开：

| 对象 | 不可变身份 | 表达的事实 |
| --- | --- | --- |
| code version | `refs/tags/rsi/version/<version-id>` | 一份已提交、已公开验证的完整 codebase |
| evaluation opening | `refs/tags/rsi/evaluation/<evaluation-id>/opening` | 在读取 private/gold 前，固定评测版本和协议 |
| evaluation result | `refs/tags/rsi/evaluation/<evaluation-id>/result` | 追加结果 artifact hash、公开摘要 hash 和 claim boundary；adaptive 结果必须绑定 StateRoot |
| evaluation publication | `refs/tags/rsi/evaluation/<evaluation-id>/publication` | 将公开聚合指标、Teacher 诊断/建议和证据边界嵌入 Git，并绑定精确 opening/result |
| selection decision | `refs/tags/rsi/decision/<decision-id>` | 根据已完成评测选择继续、回退或保留当前节点 |
| Developer exploration | `refs/tags/rsi/exploration/<exploration-id>` | 绑定本轮公开评测分析、完整历史 prefix 和下一 child 的 pre-registration 计划，或记录 stop |
| retrospective incumbent | `refs/tags/rsi/retrospective-incumbent/<adoption-id>` | 用 hash-bound 回顾证据改变开发/运行基线并预注册唯一下一 candidate；不改变 formal selected |
| serialized event | `refs/tags/rsi/event/<8-digit-sequence>` | 将每次图变更放入唯一、连续的原子写槽 |
| campaign StateRoot | Git 外的受限归档目录 | 保存被忽略的 Developer/evaluator 状态和预测产物 |

每个 tag 都是指向精确 commit 的 annotated Git tag，其 canonical JSON payload 绑定 tag ref、commit、
父版本或上一个事件以及自身 hash。每个语义 tag 和它的下一个 event tag 使用一次 atomic push 共同发布；
两个 stale client 争用同一 event sequence 时只能一个成功。验证会比较本地与 remote 的整个
`refs/tags/rsi/*` 集合，不只检查本地已知 tag。一个 Git commit 最多对应一个 code version。

版本节点只有一个父版本，但一个父版本可以有多个子版本，所以 code-version topology 是树。选择状态不靠
移动 branch 保存，而是从 append-only decision tags 推导：

```text
v1 *selected*
└─ v2 --评测拒绝--> decision: backtrack(v1)

v1
├─ v2
└─ v3 *selected* --从已重新选中的 v1 开始开发
```

decision log 自身是一条单链。`continue` 必须选择本次被评测的 candidate；`backtrack` 只能选择 candidate
的严格祖先，而且目标必须曾经被选择过；`retain` 则在 candidate 被拒绝时保持评测前的
`selectionBefore`，不再要求 candidate 自己就是该 selected version。三者是 evaluation decision。
因此，从旧 base 开发的 side-branch candidate 若被拒绝，而当前 champion 不是 candidate 的祖先，默认用
`retain` 保持原 champion；它不能伪造成一次回退。旧 schema 下已经合法发布的 backtrack decision 仍是
不可变历史并继续通过验证。

随后 exploration plan 另有 `proceed`/`stop`：v2 `proceed` plan 用显式 `baseVersionId` 授权一个精确
child；该 base 可以是 bound public-history prefix 中任意已注册 version，与 current selected/champion
正交。`stop` 则封闭图并禁止后续 mutation。adaptive publication 还会强制结果到 action 的映射，见
4.4。被拒绝的 v2、它的评测、负结果和 Teacher 反馈都不会删除，所以从旧节点另开 v3 时，Developer
context 仍会包含 v2 这条失败分支的脱敏经验。

### 2.1 版本记录与 champion 选择是两个正交平面

`v0002` 的含义是“第二个按正式合同冻结并进入评测的完整 codebase”，不是“比 `v0001` 更好”。版本号只
表达不可变身份和事件顺序，不表达性能排序。正式 gate 只允许改变从 decision log 推导出的
`selectedVersionId`，不能决定候选是否拥有版本号，也不能改写版本树：

```text
v0001  [selected/champion]
├── v0002  [已评测、未晋级、永久保留]
└── v0003  [代码从 v0001 开始；知识上下文同时读取 v0001 和 v0002]
```

v2 plan 进一步把“代码 parent”和“champion”拆开。例如 `v0002` 已成为 champion 后，Developer 仍可基于
完整历史明确选择 `v0001` 为新 candidate `v0003` 的 base：

```text
v0001
├── v0002  [selectionBefore；selected/champion]
└── v0003  [base=v0001；评测拒绝]
             └─ decision: retain(v0002)
```

因为 `v0002` 是 `v0003` 的 sibling 而非祖先，这个拒绝不能表示成“backtrack 到 v0002”；`retain`
精确表达 champion 在评测前后都没有改变。若 v0003 通过，`continue(v0003)` 才会移动 champion。

因此必须同时遵守：

- **记录平面单调增加**：每个正式评测候选都先注册 immutable version；opening、result、publication、
  decision 和 exploration 只能追加。失败、打平、回退、流程中断都不能成为删除、重编号、覆盖或隐藏节点
  的理由。
- **选择平面可以回退**：gate 可以 `continue` 当前 candidate，也可以 `backtrack`/`retain` 旧
  selected version；这只改变下一轮的代码起点。被拒绝 candidate 的 commit、评测和知识记录仍留在树上。
- **代码基线可选择历史节点，知识基线不能回退**：v2 plan 的 `baseVersionId` 可以指向其 bound history
  prefix 中任意已注册版本，并成为下一 child 的 parent；它不改变 champion。下一份 plan 和 Developer
  context 仍必须绑定当时完整的
  public history head，包含所有已发布的成功、失败、打平、回退和 sibling 分支。不能只读取 selected
  lineage 或最近一轮。
- **先有合同，后有 selection 资格**：formal evaluation 的非 root candidate 必须先有上一终态节点的
  exploration/pre-code plan，再完成 commit、公开验证、version registration 和 remote ref 核验，最后
  在任何 gold/private label 读取前发布 remote opening。顺序缺一项的实验不能进入 prospective
  champion 选择。
- **旧实验只允许如实回顾**：协议上线前、已经打开 selection/test、或没有遵守上述 plan/register/open
  顺序的实验，只能保存为明确的 retrospective experiment。它可以向后续计划贡献失败机制、工程结论和
  限定证据，但不能事后补造成 prospective `rsi/version` 节点、不能获得 selection 资格，也不能把已打开
  的 selection/test 再当作新一轮调参数据。

回顾实验的机器记录位于 `refs/tags/rsi/retrospective/<id>`，并占用一条连续 event。它绑定记录时
commit/tree、真正被评测的祖先 commit/tree、Git 中 tracked receipt 的 blob/file/canonical hash、
当时 formal selected/event head，以及外部 archive seal/public-manifest hash。对应命令是
`rsi-retrospective-archive-create`、`rsi-retrospective-archive-verify` 和
`rsi-version-retrospective-record`。该 event 的固定策略是 knowledge-only、selection-ineligible、
promotion-ineligible；verifier 会拒绝未知 ref、重放、篡改或任何 selection/decision 数量变化。

### 2.2 current best 与历史 prospective selection

当前对后续迭代真正有用的是一个主指针，另保留一个审计字段：

- `currentBestVersionId`：下一轮默认从哪一版出发；当前为 `v0004`；
- `lastProspectivelySelectedVersionId`：最近一次严格 prospective decision 当时选了谁，只用于回放和审计。

旧字段 `selectedVersionId` 和 `operationalIncumbentVersionId` 为兼容已有 artifact 继续保留，分别对应上述
审计值和 current-best 值。Plan 中的 `baseVersionId` 才是本轮实际父版本；未显式改选时应取
`currentBestVersionId`，也允许有理由地选择任意已注册历史版本。

`rsi-version-incumbent-adopt` 只允许处理“最新、唯一、尚未完成 prospective evaluation”的 version。
输入必须绑定 Git 中 tracked report 的 blob/SHA-256、100 蛋白的 40/20/20/20 分组、固定指标和 artifact
canonical hashes，并同时给出唯一下一版的 pre-code plan。事件追加后：

```text
v0001  *last-prospective-selection*
...
v0004  *current-best* *retrospective-evidence*
```

这表示当前实际开发基线就是 v0004；v0001 只记录旧合同当时的选择结果。v0004 仍保留在 `unevaluatedVersionIds` 和
`proteinEvaluationIncompleteVersionIds`，但从 `unresolvedVersionIds` 中移出，因此系统可以严格按该
adoption 计划施工下一版。下一 candidate 必须以 v0004 为 parent、消费 exact plan，并在任何新 private
scoring 前发布 fresh prospective opening；Priority100 旧证据不会被伪装成新 opening。

### 2.3 物理上一个 codebase，逻辑上多版不可变 codebase

默认部署只保留一个长期 primary checkout。当前工作站的实例是
`/path/to/EviRead`；这个绝对路径只是本机实例，不是可移植协议的一部分。
在其他机器上，同一合同可以落在任意一个 Git repository 顶层。`RSI_STATE`、`VERSION_ARCHIVE` 等外部
目录保存 StateRoot、receipts、bundle 和恢复材料，不是第二、第三份可直接开发的 codebase。

每轮不需要复制一个永久目录。`v0001`、`v0002`、`v0003` 等完整代码都已经作为 Git object 保存在同一
repository 的 object database 中，并由不可移动的 version tag 指向：

```text
EviRead/                 ← 唯一长期开发 checkout
└── .git/
    ├── objects                          ← commit/tree/blob 保存每版完整 tracked code
    └── refs/tags/rsi/（也可能 packed）
        ├── version/v0001
        ├── version/v0002
        ├── version/v0003
        ├── evaluation/...
        ├── decision/...
        ├── exploration/...
        └── event/...

EviRead_RSI_STATE/       ← Git 外耐久评测/运行状态，不是 codebase
EviRead_VERSION_ARCHIVE/ ← Git bundle/checksum 恢复副本，不是 codebase
```

某一时刻 primary checkout 只能把其中一个 commit 展开成可编辑文件；这不表示其他版本消失。可以用
version tag 查看、比较或恢复任意已注册版本，例如 `git show rsi/version/v0002^{commit}` 和
`git diff rsi/version/v0001^{commit}..rsi/version/v0002^{commit}`。正式开发则不能任意 checkout 后绕过
RSI 合同：必须由最新 `proceed` plan 授权 exact base，再在同一 primary checkout 中准备短生命周期
working branch。branch 只表示当前施工位置；commit + immutable tag + event/plan/context/evaluation
records 才共同表示一个已冻结 RSI version。

v2 plan schema 用显式 `baseVersionId` 区分开发 base 与 selected/champion。它可以选择 bound
public-history prefix 中任意已注册 version；register 必须把下一 child 的 parent 精确绑定到这个 base，
但不会仅因准备或注册 candidate 就移动 champion。操作者仍不能手工 checkout 任意裸 commit：
`rsi-version-prepare` 只执行 plan，`--from-version` 只做预期值相等性断言。

额外 worktree 仍可作为显式的并行/隔离选项，但不是默认，也不应永久保留“一版一个 worktree”。它的删除
不影响已经由 Git refs 和外部耐久 artifact 保存的版本；反过来，仅保留 worktree 目录也不构成版本管理。

### 2.4 stable controller plane 与 candidate plane 分离

primary checkout 切到历史 base 时，目录内的 `./pi-agent`、schema 和 outer-controller 代码也会一起回到
历史实现。因此，“同一个 checkout”不能解释成“用 candidate 自带的旧 controller 修改当前 graph”。
两层职责必须分开：

- **stable controller plane**：正式 graph 的 verify、tree/context/export、prepare/fork、register、
  opening/result/publication/decision 和 retrospective record，都必须由 content-addressed controller
  runner 执行。现有把科学执行与 graph side effect 混在一起的 versioned evaluator orchestration
  不能从历史 candidate checkout 直接使用，必须先拆分。该 runner 由 prepare 返回，或在切换历史 base 前通过
  `rsi-controller-install` 生成；它安装在 `git rev-parse --git-common-dir` 所指向的 Git common
  directory 下，而不是任何 worktree、branch 或 candidate tree 的 tracked/ignored 文件。相同 controller
  内容得到相同地址，candidate checkout 的修改不能就地改写它。
- **candidate plane**：当前 checkout 自带的 `./pi-agent` 只运行功能预测科学实现、公开软件测试和冻结
  prediction。它不是 graph authority，不能发布或验证正式 RSI graph event。唯一的控制面 bootstrap
  例外是从当前 controller generation 调用 installer，或调用 `rsi-version-prepare`：后者只负责
  安装/验证 bundle 并以 child process 启动 exact Node/runner，本身不执行 prepare mutation；这一代的
  其他 `rsi-version-*` 在普通 CLI 上全部拒绝。不可变历史 version 不能被追溯打补丁，它们的旧 CLI
  route 可能仍存在，因此“不得运行历史 `./pi-agent benchmark rsi-version-*`”是 operational contract，
  不是这些旧字节在技术上已失去尝试写图的能力。

prepare/installer 的结构化结果给出 `runnerPath`、`nodeExecutablePath` 和可直接审计的 invocation；必须
原样使用这对精确绝对路径，因为 runner 会校验 Node executable SHA-256，不能换成碰巧在 `PATH` 上的
system Node。下文的 `$RSI_NODE`/`$RSI_CONTROLLER` 分别表示这两个返回值，不表示 candidate tree
中的 `./pi-agent`。installer 本身只接受一个绝对 `--repo`；每次 runner 调用都必须显式给出目标
`--repo /path/to/repository` 和 `--remote origin`，
不能从当前目录或隐式默认 remote 猜测作用域。runner 也只执行现有 append-only 合同：历史 event 19
的 `stop` 只能由 event 20 的显式 resume 恢复；当前 incumbent adoption 也只能授权 spec 中精确的
`v0005`，不能泛化为任意新版本。

这里的安全边界是受支持流程中的**版本代际隔离**：避免 checkout 到历史 candidate 后误用旧
controller，并让当前 controller generation 的普通 CLI 不再直接执行 graph mutation。它不能追溯删除
不可变历史 CLI 的旧 route，也不是针对同一 OS 用户的对抗性 sandbox；拥有 Git common directory、
进程或 credential 写权限的人仍可越过正常命令。若需要抵抗恶意操作者，必须另加独立 OS identity、
只读/受保护 remote refs 和部署层权限隔离。

## 3. 强制不变量

`rsi-version-verify` 会检查，而不是只展示：

1. code-version graph 恰好一个 root、无环、父 binding 完整；
2. 父 commit 是子 commit 的严格 Git 祖先；两个注册版本之间不能有 merge commit，也不能跳过另一个
   已注册版本；
3. tag 必须是 annotated tag，payload 必须是 schema-valid canonical JSON，tag target、source commit
   和 source tree 必须一致；
4. evaluation result 必须绑定已存在的 opening；adaptive-development result 只接受实际 StateRoot
   目录，先运行 archive-only verifier、核对 source commit 与 head outcome，再派生
   `archiveSealHash`、`publicManifestHash` 和确定性的 `publicSummaryHash`。非 adaptive result
   必须没有 StateRoot，且只能从 hash-verified closed result file 派生同一个公开摘要；
5. 新评测严格按 `version → opening → result → publication → decision` 排列。publication 逐项绑定
   version、opening、result、artifact 和公开 StateRoot hash；adaptive 摘要只能从通过验证的 StateRoot
   派生，不能由调用者手填，并须把 Developer plan 的 `codeVersionHistoryHash` 绑定回 version 的
   `developmentContext`；
6. 一个 evaluation 只能有一个 publication 和一个 terminal decision；新 decision 必须绑定 publication，
   decision log 必须连续且只有一个 head；
   同一 version 可先做一个或多个通过的 generic preflight，再做一次 adaptive 蛋白评测；adaptive
   publication 或任一 failed/rejected decision 都会把该 version 置为终态，之后不能用另一个宽松评测
   “复活”它；
7. terminal evaluation/decision 之后只能记录一次绑定该 evaluation 的 Developer exploration。它必须
   使用精确 public-history prefix；v2 plan 的 `baseVersionId` 必须引用该 prefix 中已注册 version，
   并与 evaluation decision 的 selected/champion 独立。exploration 还须确定性包含
   `evaluation_analysis.md`/`next_optimization_plan.md` 的内容 hash；
8. 非 root version 必须紧随一个 `proceed` exploration，并绑定计划中的 exact parent/base、
   `plannedVersionId`、hypothesis、change summary 和 Developer context。`stop` exploration 后不能再
   发布 version 或其他 mutation；
9. event sequence 必须从 `00000001` 连续，每个语义 tag 恰好被一个 event 覆盖；
10. `rsi-version-verify` 强制指定 remote；remote 和本地完整 RSI namespace 的 ref 与 object ID
   必须逐项相同，stale checkout 不能给出“通过”。

上述 verifier 不会把任意旧 branch、worktree 或报告自动升级成正式版本。运维层必须先判定该实验是否
真的按 prospective 合同执行；若答案是否定的，只能进入 retrospective 知识档案，不能用人工补 tag 的
方式取得 selection 资格。

注册、开启评测和记录结果要求 canonical Git checkout 顶层的 index、tracked worktree 及 non-ignored
untracked set 全部 clean。严格入口还禁用 fsmonitor，拒绝 `assume-unchanged`、`skip-worktree`、
shallow repository、`refs/replace/*`、非空 grafts、submodule 和 tracked symlink；它直接对 HEAD tree
中的每个 blob 重新计算 raw worktree Git object ID 与 executable bit，不调用可能掩盖差异的 clean
filter。`src`、`schemas`、`python`、`bootstrap`、`protocols`、`scripts` 等执行/模式根目录内也不允许
ignored-untracked overlay；依赖、构建输出和 evaluator state 则必须由各自的 lock、receipt 与
StateRoot 另行绑定。注册新版本还要求其父版本正是 v2 plan 的 `baseVersionId`，该 base 已注册并存在于
plan 绑定的 history prefix；它不要求等于当前 selected version。验证输出会分别列出
`incompleteEvaluationIds`、`unpublishedEvaluationIds`、`undecidedEvaluationIds` 和
`unevaluatedVersionIds`：

- `historyComplete` 表示上述集合都为空，且所有非 root version 均绑定 Developer context 和产生它的
  exploration plan；它只证明版本—评测—publication—decision 历史闭合，不等于已经有蛋白效果证据。
- `evaluationComplete` 还要求每个非 legacy version 至少有一条可形成终态反思边界的
  `prospective` publication。通常它是 `adaptive_protein_function`，并同时公开聚合蛋白指标和
  Teacher 反馈；当前唯一可形成终态的 `frozen_replay` 是精确绑定
  `z55-prospective20-mf-consensus-v1` 和详细
  `pi-deepgoplus-hybrid-rsi-public-summary.v1` receipt 的 Z-55 路径。它必须验证正式 protocol raw
  hash、cohort、control/candidate genome、DeepGOPlus method、ontology、control batch、live replay、
  finalist 及 selection/test coherence；任意 generic checks receipt 均被拒绝。通过 selection 时必须
  `continue` 被评测 candidate；失败时可 `retain(selectionBefore)`，若使用 `backtrack` 则目标必须是
  candidate 的历史 selected strict ancestor。root 失败只能 retain。该 publication 固定
  `teacher=null`，不能虚构 adaptive Teacher 诊断。另一个正常例外是候选在精确绑定
  `rsi-code-version-quality-v1` 协议及其固定 SHA-256，且
  `typescript_typecheck`、`typescript_tests`、`python_tests`、`production_build`、
  `committed_diff_check` 五项必需检查均实际执行并至少一项失败后，被 terminal backtrack/retain——
  任意自定义 generic receipt 不能获得这个豁免。这种节点会作为“未进入蛋白评测的失败候选”公开，
  不能产生性能 claim，但也不会让 RSI 树永久死锁。另一个 grandfather
  例外是 publication 合约出现前已存在的 root v0001。实现不仅检查名字，还固定核对该 version、opening、
  result、decision 的既有 manifest hash、tag object ID 和 software receipt hash；只有这条精确历史链
  可用 `retrospective_legacy` software-only publication 补齐记录，且不能由此产生蛋白性能 claim。

`rsi-version-verify --format json` 还会列出兼容字段
`proteinEvaluationIncompleteVersionIds`。只有 `historyComplete: true` 且该集合为空，
`evaluationComplete` 才成立。字段名沿用旧合约，但集合现在表达“尚无合格 prospective 终态评测”的
version：adaptive 蛋白/Teacher publication 和完成 decision 的上述 Z-55 prospective frozen replay
都可清空对应节点；单独通过的 `software_verification` 或任意 generic frozen replay 仍不能清空，也
不能授权下一轮。精确失败并终止的 quality preflight candidate 仍可作为无性能结论的负分支留在公开树中。

`unreflectedTerminalVersionIds` 列出还没有 exploration 的终态评测。只有
`evaluationComplete: true` 且该集合为空，`paperComplete` 才成立；这表示每个终态评测都已经沉淀成
当前版本的两份探索文本。`paperComplete` 仍不等于“可立即开发下一版”：最后一个 event 还必须是
`proceed` exploration，`readyForNextVersion` 才为 `true`；`stop` 会留下完整、可公开但关闭的叶节点。

## 4. 单一 primary checkout 开发流程（默认）

长期候选分支和目录都不是 RSI 的身份，version tag 才是身份。默认从 plan 授权的 exact base 在同一个
primary checkout 中准备短生命周期 working branch；完成注册后，该 branch 可以继续用于本轮评测，也可在
耐久保存门通过后删除。无论 branch 是否存在，已注册版本的 commit/tree 和不可变记录都不受影响。

在切换到历史 base 之前，先从 clean、可信的当前 controller checkout 安装 runner。installer/prepare
结构化输出中的 `runnerPath`/`nodeExecutablePath` 是后续唯一入口；下面的变量必须逐字复制本次
结构化返回值，任何部署都不能手工猜路径或改用 system Node：

```bash
./pi-agent benchmark rsi-controller-install \
  --repo /path/to/repository

RSI_NODE=/exact/nodeExecutablePath/from/structured-output
RSI_CONTROLLER=/exact/runnerPath/from/structured-output

git fetch origin 'refs/tags/rsi/*:refs/tags/rsi/*'

"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-verify \
  --repo /path/to/repository \
  --remote origin \
  --format json

"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-tree \
  --repo /path/to/repository \
  --remote origin \
  --format text
```

### 4.1 创建第一版

第一版是唯一没有 `--parent-version` 的 root。先在 clean commit 上完成不读取 private/gold 的软件验证，
把公开 receipt 保存在可持久化的位置，再注册：

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-register \
  --repo /path/to/repository \
  --version-id v1 \
  --change-summary "initial frozen whole-codebase version" \
  --hypothesis "establish the prospective RSI baseline" \
  --verification-receipt /durable/public-receipts/v1.json \
  --remote origin
```

`--verification-receipt` 在 version manifest 中只记录 SHA-256 与大小，不嵌入 receipt bytes；所以 receipt
本身仍需外部持久化。`protocols/rsi-code-version-quality-v1.json` 是推荐的公开软件验证协议。它不含
`canonicalHash` 字段；evaluation opening 绑定的是该 tracked 文件的原始字节 SHA-256。

### 4.2 先冻结反思和计划，再从 plan 授权的历史 base 开发 candidate

上一版完成 terminal publication/decision 后，先由 Developer 基于完整公开历史提交 closed plan spec：

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-exploration-record \
  --repo /path/to/repository \
  --exploration-id reflect-v1-for-v2 \
  --plan-spec /durable/plans/v2-plan-spec.json \
  --remote origin
```

harness 会把该 evaluation 的公开 aggregate/Teacher 投影确定性生成为 `evaluationAnalysis`，再从
closed `pi-rsi-next-optimization-plan-spec.v2` 把 Developer 的问题判断、研究 cards、假设、controls、
falsifiers、各 aspect 预期效果、`plannedVersionId` 和显式 `baseVersionId` 生成为 v2
`nextOptimizationPlan`。base 必须是精确 history prefix 中已经注册的 version，但不必等于
selected/champion。二者与 history prefix 一起进入 annotated `rsi/exploration` tag 和 event。plan 为
`stop` 时图在这里终止；只有 `proceed` 才能继续 prepare（默认）或 fork（可选隔离）。

v2 是向前追加的 schema 升级：既有 v1 plan/exploration 和合法 backtrack events 继续按其原始 payload
验证，不能迁移、覆盖或重写。历史 event 19 的 v1 `stop` 没有因实现 v2 自动恢复，而是由 event 20 的
独立 append-only resume 显式恢复。

若人类在一个已关闭 leaf 之后明确批准新 epoch，先提交 closed
`pi-rsi-epoch-resume-spec.v1`，再使用 stable controller：

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-epoch-resume \
  --repo /path/to/repository \
  --resume-id resume-v0004 \
  --spec /durable/plans/v0004-epoch-resume.json \
  --remote origin
```

spec 必须给出 `epochId`、历史 `baseVersionId`、唯一 `plannedVersionId`、理由、假设、变更摘要、
代码目标、controls 与验证要求；固定 policy 要求新的 private evaluation 先发布 prospective opening，
并声明旧 evidence 永远不具 promotion eligibility。resume event 本身不含 future commit，不改变
selected version，也不证明性能提升。后续 register 使用 `--epoch-resume resume-v0004` 替代
`--developer-exploration`，二者必须且只能选择一个。

给人阅读的“双文本探索树”是权威 tag/event 的确定性视图，不是另一套可随意修改的记录：

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-exploration-export \
  --repo /path/to/repository \
  --output-dir /durable/exploration-tree \
  --remote origin
```

每个被反思的 source version 得到
`versions/<version-id>/evaluation_analysis.md`、
`versions/<version-id>/next_optimization_plan.md` 和 `manifest.json`。删除 export 后，fresh clone
仍能由相同 tags 逐字重建；论文公开时仍需把生成的目录作为 artifact 发布。

然后默认在同一个 primary checkout 中准备 candidate：

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-prepare \
  --repo /path/to/repository \
  --from-version v1 \
  --developer-exploration reflect-v1-for-v2 \
  --branch rsi/dev/v2 \
  --developer-context-output /durable/public-history/v2-developer-context.json \
  --remote origin
```

`rsi-version-prepare` 不复制 repository。它要求调用位置是该 repository 的 primary checkout、整个
checkout strict-clean、目标 branch 不存在，并要求除了 primary checkout 外没有额外 linked worktree。
最新 `proceed` exploration/plan 是 base、planned version 和 history head 的唯一 authority；
`--from-version` 只是防止操作者误解的相等性断言：它不能覆盖 plan，但 plan 本身可以选择 history
prefix 中任意已注册 base。命令在同一目录把 HEAD 切到 plan 指定的 source commit，创建短生命周期
branch，并从精确 event head 生成 Developer context；context 必须是 repository 外的绝对新路径，且以
exclusive-create 写入，不能覆盖旧文件。

输出会列出 previous HEAD/ref、working branch/ref、base/planned version、source commit、
plan/context hash 和 worktree count，方便审计“同一目录从哪里开始本轮施工”。任何检查或切换失败都必须
回滚到原 HEAD/ref，不能留下半准备状态。branch 名只是临时开发指针，不进入 version identity；随后真正
的版本仍由 commit + `rsi/version` tag + event/plan/context/evaluation records 冻结。

若确实需要并行或隔离执行，可以显式选择旧的 worktree 模式：

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-fork \
  --repo /path/to/repository \
  --from-version v1 \
  --developer-exploration reflect-v1-for-v2 \
  --worktree /path/to/optional-detached-worktree \
  --developer-context-output /durable/public-history/v2-developer-context.json \
  --remote origin
```

`rsi-version-fork` 创建 detached linked worktree；它是 opt-in 施工副本，不是另一种版本身份，也不应按
“每版一个永久目录”保留。两种准备方式都必须接受 exploration 中的 exact base，并在
`paperComplete: false`、`readyForNextVersion: false` 或最新 plan 为 `stop` 时 fail closed。

也可以在准备 candidate 前单独导出同一份 canonical JSON：

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-developer-context \
  --repo /path/to/repository \
  --remote origin \
  --output /durable/public-history/v2-developer-context.json
```

context 按 publication event 顺序包含整棵树上所有已公开评测，包括已拒绝和已回退的 sibling：
版本/父节点、修改摘要、假设、方法族、结果类别、control/challenger 的 overall/MF/BP/CC Fmax
压缩趋势、Teacher hypothesis/mechanism verdict、诊断、prioritized actions、选择决策和 claim
boundary。它刻意不包含逐蛋白预测、accession、GO 标签、私有路径或 evaluator-private 内容。
若当前唯一公开记录仍是 legacy software baseline（没有 method template），selector 会继续使用
campaign-local Teacher 历史；它不会因为“存在一份空的公开方法历史”而把已有 no-gain/saturation
经验清零。对同一 template，selector 分别计算公开跨版本记录和本地 campaign 记录的连续 no-gain，
取两者最大值：既不把重叠轮次相加两遍，也不丢掉只存在于其中一侧的 legacy 尝试。

adaptive 开发应通过 versioned planner 消费同一个完整历史，而不是只看当前 campaign 的最后一轮：

```bash
./pi-agent benchmark outer-adaptive-versioned-plan-next \
  --developer-dir campaigns/<campaign>/developer \
  --research-cards research-cards.json \
  --proposal-spec proposal-spec.json \
  --version-repo /path/to/repository \
  --version-remote origin
```

该命令只有在 `paperComplete: true` 且最新 graph mutation 是上述 `proceed` exploration 时才运行：
除 grandfathered root 和已被 terminal preflight 按上述精确质量协议拒绝的负分支外，每个版本不仅要
complete/publish/decide，还必须已有 prospective adaptive 蛋白/Teacher publication。生成的 adaptive
Developer plan 记录 `codeVersionHistoryHash`，并绑定最新 exploration 的
`explorationId`/`planHash`。它向 Developer 提供上述跨分支脱敏记录，既保留失败经验，也避免把原始
private/gold 或逐蛋白答案放进开发上下文。
完成修改、公开验证和 commit 后，在当前 primary checkout 注册：

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-register \
  --repo /path/to/repository \
  --version-id v2 \
  --parent-version v1 \
  --change-summary "..." \
  --hypothesis "..." \
  --verification-receipt /durable/public-receipts/v2.json \
  --developer-context /durable/public-history/v2-developer-context.json \
  --developer-exploration reflect-v1-for-v2 \
  --remote origin
```

到这里 v2 已经先成为远端可验证、不可变的完整 codebase 版本；之后才允许开始 private/gold 评测。
未通过公开验证、尚未注册的 candidate commit 只是 WIP，不是 RSI version。非 root 注册若遗漏
context/exploration、使用 stale context、与 plan 的 ID/hypothesis/change summary 不符，或 context
没有覆盖当时完整公开图，都会 fail closed。

“已注册”不能只指本地存在 tag。正式 opening 前必须再次运行带 `--remote origin` 的
`rsi-version-verify`，确认 version/exploration/event refs 及 object ID 在 remote 与本地逐项一致。
本地-only tag、尚未推送的 commit 或 stale remote 都没有 formal evaluation 资格。

这里的 event 因果关系只能证明 exploration/plan **先于 child version registration**，并证明已注册
child 精确引用哪份历史和计划。它不能证明其他目录中从未提前存在代码草稿或未注册 commit，也不会逐行
证明实际 diff 符合 plan 的所有 `codeChangeTargets`。因此不能把该合同夸大为对“思考先于任何代码字节
产生”的密码学证明。prepare/fork、planner 与 non-root register 仍会在 `paperComplete: false` 或
`readyForNextVersion: false` 时拒绝继续，不能先登记下一版、事后再补当前版的蛋白评测或反思。

### 4.3 明确打开、完成并公开一次评测

通用接口适合 software verification 或 frozen replay。先 open，再 complete：

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-evaluation-open \
  --repo /path/to/repository \
  --version-id v2 \
  --evaluation-id eval-v2 \
  --protocol-id rsi-code-version-quality-v1 \
  --protocol-file protocols/rsi-code-version-quality-v1.json \
  --remote origin

# opening 已发布后，才运行可能读取 private/gold 的 evaluator。

"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-evaluation-complete \
  --repo /path/to/repository \
  --evaluation-id eval-v2 \
  --result-kind software_verification \
  --result-file /durable/public-results/eval-v2.json \
  --claim-boundary "software and lineage verification only; no performance claim" \
  --remote origin
```

software/frozen-replay 的 result artifact 本身必须是公开 JSON receipt，并绑定 `evaluationId`、
精确 `candidateCommit`、`claimBoundary` 和 `checks[{checkId,status}]`。status 是 closed enum：
`passed | failed | not_applicable`，不能用自由文本状态把失败包装成成功。在 decision 前，publisher
会重新计算该文件 SHA-256，要求它等于 result tag 的 `artifactHash`，再核对 artifact 的
`evaluationId`、`candidateCommit`、可选 `resultKind` 和 `claimBoundary`；它不接受另一份可手填的
摘要文件：

prospective software receipt 必须使用 closed `pi-rsi-generic-public-result.v1`：顶层只允许
`schemaVersion/evaluationId/candidateCommit/resultKind/claimBoundary/checks/outcome`，每个 check
也只允许 `checkId/status`，至少要有一个实际 `passed` check，且 `outcome` 必须与 failed checks 一致。
`frozen_replay` 不接受这份 generic schema：它只接受 formal Z-55 opening 对应的完整
`pi-deepgoplus-hybrid-rsi-public-summary.v1`，并逐字段重建 selection decision、finalist hash 和六项
closed checks。complete 阶段就会先验证对应契约，避免先写下一个以后无法 publication 的坏 result tag；
整份 receipt 还会扫描 accession、GO/case identifier、URL、绝对路径和 private-looking field，而不是
把不认识的字段静默丢弃。扫描也覆盖 Ensembl/GenBank/PDB 风格 identifier、常见 GO 分隔写法、
Windows/UNC/赋值形式绝对路径、data/base64 payload、疑似氨基酸长串和换行控制字符；任何 publication
自由文本最终都要经过同一检查。

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-evaluation-publish \
  --repo /path/to/repository \
  --evaluation-id eval-v2 \
  --publication-mode prospective \
  --result-file /durable/public-results/eval-v2.json \
  --claim-boundary "software and lineage verification only; no performance claim" \
  --remote origin
```

publication 只从 closed checks 确定性生成摘要并嵌入 annotated tag，同时绑定 opening、result、
artifact hash 和 claim boundary。complete 阶段已把同一摘要的 canonical `publicSummaryHash`
写入 result tag；publisher 与 fresh-clone verifier 都会重新计算并比较该 hash。因此不能拿另一版本、
另一评测或事后美化的摘要来补 publication，fresh clone 也能重建聚合审计历史。原始 result artifact
仍应按其 hash 在受控存储中保存。通过的 software publication 和严格 Z-55 frozen-replay publication
都可令 `historyComplete` 成立；但只有完成 closed selection/test decision 的
**Z-55 prospective frozen replay** 可作为无 Teacher 的终态反思边界，并在随后记录 exploration 后令
该节点满足 `paperComplete`。
通过的 `software_verification` 仍是非终态，不能单独授权 exploration 或下一版；失败并 terminal
拒绝的精确 quality preflight 则被如实记录为没有蛋白性能结论的负节点。

如果是 adaptive-development result，complete 命令必须提供
`--state-root-dir /durable/state-roots/eval-v2`；CLI 不接受手填的 seal/public hash，而是验证归档后
自行派生。它的 publication 也不接受手写 summary，必须用
`rsi-version-evaluation-publish --state-root-dir /durable/state-roots/eval-v2`，由已验证 StateRoot
中的 feedback/outcome/proposal 确定性提取 control/challenger 的 overall、MF、BP、CC 聚合指标、
paired delta、Teacher verdict/diagnoses/prioritized actions 和本轮方法假设。
complete 和 publication 都会先把通过 archive-only 验证的 StateRoot 复制到 owner-only 临时快照，
再只从该快照读取 `round-N-binding.json.rsiEvaluation` 及 source documents，要求
version/source commit/version tag、evaluation/opening tag、protocol ID/hash 与当前 immutable opening
逐项完全一致；复制前后的 seal/public manifest/head outcome 必须相同，避免 verify 后再从可变原目录
重读的 TOCTOU。同一个 commit 上用其他 protocol 产生的 StateRoot 也不能移花接木。adaptive
`retrospective_legacy` 被禁止，旧 adaptive action 若不符合当前语义时不会在推 tag 后才把图永久污染。

opening 已存在但执行中断时，graph 会将其列入
`incompleteEvaluationIds`；不能移动或覆盖原 tag，也不能用同一个 evaluation ID 倒填另一场评测。
调查并保留中断证据后，应使用新的 evaluation ID 重试。

### 4.4 继续、回退或保留当前节点

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-decide \
  --repo /path/to/repository \
  --decision-id decide-v2 \
  --evaluation-id eval-v2 \
  --action continue \
  --selected-version v2 \
  --rationale "passed the precommitted gate" \
  --remote origin
```

decision action 的语义是 closed 的：

- software checks 全部无 `failed` 时必须 `continue` candidate；一旦出现 `failed`，可以
  `retain` 并精确保留该 evaluation 的 `selectionBefore`。若选择 `backtrack`，目标仍必须是 candidate
  的 strict ancestor 且历史上曾被 selected。Z-55 frozen replay 同样由 exact selection gate 决定：
  全部 promotion gate 通过时 `continue` candidate，否则只能 backtrack/retain；
- 上述共同的 decision 语义不代表二者拥有相同证据强度：prospective `frozen_replay` 可形成终态反思
  边界，但必须保持 `proteinEvaluation=false`、`teacher=null`；通过的 `software_verification`
  仍只是中间验证，不能形成终态反思边界；
- adaptive outcome 为 `selected_successor`：必须 `continue` 并选择被评测 candidate；
- adaptive candidate 被拒绝时，`retain` 必须保持 `selectedVersionId == selectionBefore`，不把失败
  candidate 或它的 base 误当成 champion。若 `selectionBefore` 不是 candidate 的祖先（典型 side
  branch），默认必须 retain；若显式 backtrack，则仍只能选择 candidate 的历史 selected strict
  ancestor；
- root 被拒绝时没有合法 backtrack target，仍以 `retain` 保持 root。旧协议下已经发布且满足祖先/
  historical-selected 条件的 backtrack decisions 保持不可变且继续兼容。

因此 v2 未通过时用 `--action backtrack --selected-version v1`；若是在 root v1 自身做的评测未通过，
则用 `--action retain --selected-version v1`。记录 backtrack 后必须先记录一条授权下一 child 的
`proceed` exploration；plan v2 可以把任意已注册历史节点（例如 v1）写为 `baseVersionId`。随后运行
`rsi-version-prepare --from-version v1`（默认单 checkout）或显式选择 `rsi-version-fork`（可选隔离），
下一份注册版本会成为 plan base 的子节点。不要删除 v2 tag，也不要通过 reset/force-push 把 v2 伪装成
另一份代码。

例如已选中过 `v1 → v2 → v3`，v3 被拒绝时可以直接选择 v1：

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-decide \
  --repo /path/to/repository \
  --decision-id decide-v3 \
  --evaluation-id eval-v3 \
  --action backtrack \
  --selected-version v1 \
  --rationale "the failure mechanism is inherited from v2; restart from v1" \
  --remote origin
```

验证器同时检查 v1 是 v3 的 strict Git ancestor，且 v1 出现在历史 selected 集合中；sibling、从未被
selected 的实验节点和任意裸 commit 都不能成为 backtrack 目标。下一条 exploration 会把
`sourceVersionId=v3` 与 `baseVersionId=v1` 同时保存：分析解释 v3 为什么失败，计划说明为何从 v1
重新开发。

### 4.5 旧 v0001 的一次性迁移与当前已关闭 epoch

`v0001` 是 publication 合约出现前已经完成 decision 的历史节点。它的旧 version/opening/result/decision
tag 都不可修改；迁移只能在它们之后追加：

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-evaluation-publish \
  --repo /path/to/repository \
  --evaluation-id verify-v0001 \
  --publication-mode retrospective_legacy \
  --result-file /durable/public-results/rsi-v0001-software-result.json \
  --claim-boundary "Software, lineage, and repository-integrity verification only; no protein-function performance claim" \
  --remote origin
```

这一 migration 只发布既有 software verification 的真实 checks，并明确标成
`retrospective_legacy`。因为 v0001 当时没有做受控蛋白评测，所以它的公开记录必须写
“not a protein evaluation”，不能借用其他 campaign 的 StateRoot、补写蛋白指标或假装存在 Teacher
反馈。publisher 和 fresh-clone verifier 都会核对这条既有 v0001 链的固定 manifest/tag/receipt 指纹；
同名新 root、其他 software/frozen-replay 结果或人工构造的 retrospective tag 都不能获得这个例外。
上面的 claim boundary 必须逐字使用 immutable result tag 中的值。旧 artifact 当时记录了更详细的
边界（明确列出 accuracy、Fmax、AUPR、Smin、calibration、generalization 和 leaderboard 均不作 claim）；
mode-scoped legacy compatibility 只在 `retrospective_legacy`（它又要求已有 immutable decision）下允许
这条历史 boundary 差异，并同时保存 `artifactClaimBoundary`、result/publication boundary、精确 artifact
hash、result-manifest hash 和 tag-object hash。它是仅限这条已审核历史的固定指纹 allowlist，且绝不放松
`prospective` generic publication 的 `evaluationId`/`candidateCommit`/`claimBoundary` 一致性检查。

之后的新评测一律使用正常的 prospective 顺序；`retrospective_legacy` 只允许在已有 decision 之后追加，
不能成为绕过预提交顺序的常规入口。这个 grandfathered root 只能令
`evaluationComplete` 成立；在记录一条如实声明“no protein evaluation”的 exploration 前，
`paperComplete` 仍为 false。它只能作为软件/lineage baseline，不能伪装成一轮蛋白/Teacher 评测。

当前 remote 已在这条 root 历史之后追加了正式 `v0002`、`v0003` 和 `v0004`。`v0002` 在 pre-gold
contract failure 后回退，`v0003` 完成 Z-55 frozen replay 后因 selection regression 回退；正式
selected/champion 仍为 `v0001`。这恰好说明“最新注册版本”“formal champion”和“operational
incumbent”是三个不同概念。

事件 `00000019` 的 mutation 指向
`refs/tags/rsi/exploration/stop-after-v0003-z55-mf-selection-regression`。该 plan 的 action 是
`stop`；事件 `00000020` 随后以显式 `epoch-resume` 合同恢复新 epoch，事件 `00000021` 注册其唯一
planned child `v0004`。resume 没有移动 selected/champion。之后
`adopt-v0004-priority100` 用下述命令把 v0004 登记为 retrospective operational incumbent，并绑定
`protocols/rsi-v0004-retrospective-incumbent-v0005.json` 中的 Priority100 证据与 v0005 计划：

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-incumbent-adopt \
  --repo /path/to/repository \
  --remote origin \
  --adoption-id adopt-v0004-priority100 \
  --spec /path/to/repository/protocols/rsi-v0004-retrospective-incumbent-v0005.json
```

这不会把 Priority100 倒填为 prospective evaluation，也不会移动 v0001 champion。event replay 要求
下一条语义事件只能注册 exact `v0005`；该版本使用
`--retrospective-incumbent adopt-v0004-priority100`，之后必须从 fresh prospective opening 开始评测。

## 5. strict adaptive 三阶段入口与 controller 集成边界

现有 `outer-adaptive-versioned-*` 三阶段实现把 candidate 科学执行与 opening/publication/decision
graph side effects 放在同一个进程中，并要求从被评测版本自己的 canonical checkout 执行。这个旧接口
解释了既有 Z-55 receipt，但**不能**在切到历史 base 后作为新正式轮次入口：那会让 historical
`./pi-agent` 直接写当前 graph，违反 2.4 的 controller/candidate-plane 分离合同。因此这些命令不得
绕过当前 incumbent plan 直接启动或晋级 `v0005`。

下面三个命令块仅记录现有耦合接口及其历史 binding，不是新 epoch 的可执行指令。未来正式 adaptive
集成必须先完成以下二选一设计并测试：把 graph side effects 拆为 stable runner 的
`rsi-version-evaluation-open/complete/publish/decide`，candidate 只生成预测、公开 result 和
StateRoot；或显式扩展 content-addressed runner 的受控 command surface。集成完成前，不得声称
historical checkout 能安全运行新的 versioned adaptive round。

第一步只读取 label-free executor/proposal precommit，发布精确协议 opening：

```bash
./pi-agent benchmark outer-adaptive-versioned-evaluation-open \
  --execution-spec executor-spec.json \
  --proposal-spec proposal-spec.json \
  --precommitted-proposal campaigns/<campaign>/developer/adaptive30/generations/000N/proposal.json \
  --code-version v2 \
  --evaluation-id eval-v2 \
  --version-repo /path/to/repository \
  --version-remote origin
```

opening 的 protocol hash 同时绑定 code version/commit、round、execution spec、proposal spec、
canonical proposal precommit，以及 cohort/freeze/metric/StateRoot policy。

第二步才允许执行预测 replay 并生成 evaluator-private bundle：

```bash
./pi-agent benchmark outer-adaptive-versioned-build-bundles \
  --developer-dir campaigns/<campaign>/developer \
  --public ... --private ... --batch-dir ... --go-ontology .../go-basic.obo \
  --execution-spec executor-spec.json \
  --proposal-spec proposal-spec.json \
  --precommitted-proposal campaigns/<campaign>/developer/adaptive30/generations/000N/proposal.json \
  --evaluator-output campaigns/<campaign>/evaluator_private/input/round-N \
  --binding-output campaigns/<campaign>/developer/adaptive30/round-N-binding.json \
  --code-version v2 --evaluation-id eval-v2 \
  --version-repo /path/to/repository --version-remote origin
```

它在读取 caller-supplied executor/private 输入前先要求远端 opening 已存在，再核对完整 protocol hash；
freeze bundle、gold bundle 和 developer-safe binding 都携带同一 opening/tag-object binding。普通
`outer-adaptive-build-bundles` 产生 `rsiEvaluation: null`，不能交给严格 round 冒充 versioned 产物。

第三步运行评测、归档并作决策：

```bash
./pi-agent benchmark outer-adaptive-versioned-round \
  --developer-dir campaigns/<campaign>/developer \
  --evaluator-dir campaigns/<campaign>/evaluator_private \
  --execution-spec executor-spec.json \
  --proposal-spec proposal-spec.json \
  --precommitted-proposal campaigns/<campaign>/developer/adaptive30/generations/000N/proposal.json \
  --research-cards research-cards.json \
  --freeze-bundle freeze-bundle.json \
  --gold-bundle gold-bundle.json \
  --go-ontology /path/to/go-basic.obo \
  --code-version v2 \
  --evaluation-id eval-v2 \
  --decision-id decide-v2 \
  --version-repo /path/to/repository \
  --version-remote origin \
  --backtrack-version v1 \
  --archive-output /durable/state-roots/eval-v2
```

`--backtrack-version` 是可选项，并且只决定 **rejected candidate** 的显式回退目标。显式值必须是
candidate 的 strict ancestor 且历史上曾被 selected。省略时，如果 `selectionBefore` 是 candidate
的 strict ancestor，可回退并保持该 champion；如果它不是祖先（从旧 base 创建 side branch 的典型
情形），则以 `retain` 保持 `selectionBefore`。candidate 若得到 `selected_successor`，decision 仍固定
为 `continue` 当前 candidate，该参数不会把成功结果改成回退。

这里的 gate 只写 decision/selected pointer。它无权删除 candidate version，也无权因未晋级而跳过
publication、exploration 或耐久 archive；否则下一轮 Developer 无法从完整历史判断过拟合、aspect
trade-off 和已经证伪的优化方向。

它在读取 proposal/research/freeze/gold bundle 前先要求 opening 已发布，并继续检查：

- challenger `sourceCommit` 必须正好对应 `--code-version`；
- control 必须对应 candidate 的 code-version parent；
- 本地和 remote 的完整 version/event graph 必须通过验证；
- exact candidate commit 必须是当前 clean HEAD。
- execution/proposal/precommit 的 protocol hash 必须等于 opening；
- freeze/gold bundle 的 opening、version tag object 与 protocol binding 必须完全相同。
- candidate version 的 `developmentContext.contextHash` 必须等于本轮 Developer plan 的
  `codeVersionHistoryHash`，防止“用一份历史制定计划，却注册另一份没有看过该历史的 codebase”。

成功执行后，它依次运行 adaptive round、创建并验证 StateRoot、追加 result tag、写 publication tag，
最后按预提交 gate 写 decision。publication 中的公开聚合指标和 Teacher 摘要完全从刚验证的 StateRoot
派生；其 `sourceDocuments` 同时绑定 Developer plan hash 和 plan 的 `codeVersionHistoryHash`。对
non-root version，后者必须等于 version manifest 的 `developmentContext.contextHash`，所以
“历史 → Developer plan → code version → evaluation”整条链不能被替换。

gate outcome 为 `selected_successor` 时自动 `continue`。candidate 被拒绝时，显式
`--backtrack-version` 仍只接受合法的历史 selected ancestor；未指定时，若 `selectionBefore` 是
candidate ancestor 则可 backtrack 到它，否则自动 `retain(selectionBefore)`。root 没有祖先可退，也
retain root。这样从任意历史 base 开出的 sibling 失败时不会错误选择 candidate parent，更不会移动原
champion；旧 v0002/v0003 的合法 immutable backtrack 仍按原记录验证。

整个三阶段协议不是事务数据库：若进程在 opening 之后中断，已推送的 immutable opening 会保留，后续 graph
验证会报告 incomplete evaluation，不能通过删除事件掩盖失败。

## 6. StateRoot 与 Git 版本图各自保存什么

Git version tag 保存完整 tracked code tree 的身份；evaluation tags 保存协议、结果、公开摘要和选择事件；
exploration tag 保存本轮双文本的结构化权威内容及下一 child 计划。它们不复制被 `.gitignore` 排除的
campaign、预测或 evaluator-private 文件。

adaptive result 因此必须先用 `outer-adaptive-archive` 创建 repository 外的 StateRoot。严格 round 会
自动创建并再次验证它；通用 complete 也只接收 `--state-root-dir`，不会信任调用者提供的两个裸 hash。
StateRoot 分离
Developer/public manifest 与 evaluator-private manifest，逐文件绑定大小和 SHA-256，并可在源 checkout
切换到其他 commit、删除短期 branch 或移除可选 worktree 后独立验证：

```bash
./pi-agent benchmark outer-adaptive-archive-verify \
  --archive-dir /durable/state-roots/eval-v2
```

result tag 只公开绑定 StateRoot 的 seal hash 和 public manifest hash，不包含 private manifest hash。
publication tag 进一步嵌入论文可用的聚合层摘要：样本数、control/challenger 的 overall/MF/BP/CC 指标、
paired delta、Teacher 诊断与优先建议、方法假设/修改摘要和 source-document hashes。它不嵌入逐蛋白
预测、序列、gold GO、accession、case ID、工作站绝对路径或 private manifest；public scanner 会拒绝
这类 identifier。Developer context 又从 publication 生成更窄的脱敏策略摘要：只保留聚合 Fmax
趋势、增益和最大 aspect drop，不把完整 paired delta、逐样本指标或原始样本反馈暴露给方法开发者。

这里描述的是正常命令和可序列化 artifact 的角色合同。指定蛋白身份、标准答案、完整冻结预测及逐蛋白
错误只作为 Evaluator 输入；Developer API 不提供这些字段。但 closed schema 和 identifier/path scanner
不是完备 DLP、强进程隔离或 differential privacy：拥有同一 filesystem、进程或 credential 的操作者仍
可能绕过命令直接读取 evaluator-private 文件。正式实验需要独立 OS user/container/remote worker 和
最小权限挂载，不能仅凭目录名声称保密。

因此，只要公开 Git repository 及完整 `refs/tags/rsi/*`，他人就能验证并重建版本树、聚合指标、
Teacher 结论、Developer history 和选择/回退记录；这是可公开、可复现的 summary/audit layer。
但 tag 只嵌入摘要和 hashes，不携带 detailed result receipt 或 StateRoot public-file bytes。要让他人
逐文件复核，仍须另行发布耐久 artifact bundle/hosting，并用 tag 中 hashes 校验。evaluator-private
身份映射、逐蛋白 gold 和其他 private shards 永远不能进入公开 Git、paper export 或 public artifact
bundle。

在删除短生命周期 candidate branch 或移除显式 opt-in 的额外 worktree 前，以下条件必须全部满足，
不是建议清单：

- `rsi-version-verify --remote origin` 通过；
- StateRoot archive-only verify 通过；
- exact source commit/tree 与 code version、opening、result、publication、decision、exploration、
  event refs 都已在 remote，且 object ID 与本地逐项一致；
- 若要开始下一版，terminal evaluation 已有 exploration tag，且双文本可从 fresh clone 重建；
- receipt/result/StateRoot 有受控的持久副本；
- checkout 中非生成、未跟踪但具有知识价值的 findings、plan、validation/error notes 已进入受 Git 管理的
  retrospective record 或其他可验证耐久档案。

任一条件未满足都禁止清理施工指针/副本。primary checkout 本身长期保留；短期 branch 可在门通过后用正常
Git branch 操作移除，而额外 linked worktree 必须使用 `git worktree remove`，不能用递归删除绕过 Git
元数据检查。旧 Z-46 evaluator worktree 的高信号决策与验证边界已凝练在
[`research/z46_pilot_evaluator_worktree_notes.v1.md`](../research/z46_pilot_evaluator_worktree_notes.v1.md)；
该记录本身仍须随 canonical commit 推到 remote 后，才能作为对应清理门的一部分。

## 7. Developer 历史和论文公开导出

Developer 使用的精确、脱敏输入可以随时重建：

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-developer-context \
  --repo /path/to/repository \
  --remote origin \
  --output /durable/public-history/developer-context.json
```

它带 canonical hash、event head 和 selected version，不再在第 128 条 publication 静默截断或让
后续 RSI 死锁；所有已发布分支记录都按 event 顺序进入 context，所以回退不会让 Developer 忘记失败
实验。若长期运行使上下文过大，未来应新增 hash-bound 分层 rollup，而不能在没有可验证承诺的情况下
丢弃旧记录。`outer-adaptive-versioned-plan-next` 消费的正是这份结构，
deterministic selector 也会利用历史 Teacher action、机制诊断和失败次数选择下一类优化。

面向论文/附录的公开记录可直接导出：

```bash
"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-paper-export \
  --repo /path/to/repository \
  --remote origin \
  --format json \
  --output /durable/public-history/rsi-history.json

"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-paper-export \
  --repo /path/to/repository \
  --remote origin \
  --format markdown \
  --output /durable/public-history/rsi-history.md

"$RSI_NODE" "$RSI_CONTROLLER" rsi-version-exploration-export \
  --repo /path/to/repository \
  --remote origin \
  --output-dir /durable/public-history/exploration-tree
```

导出包含版本树、commit/tree、每版假设和修改摘要、评测协议、公开聚合指标、Teacher 反馈、
continue/backtrack/retain、
claim boundary，以及 opening/result/publication/artifact/StateRoot public manifest 的 hashes；JSON
自身也有 canonical hash。只有 `paperComplete: true` 才允许导出，因此缺失版本评测、publication、
decision、non-root Developer-context binding，或某个非 legacy version 既缺少 prospective
protein/Teacher publication、也没有精确质量协议下的 terminal preflight rejection，都会显式失败。
`historyComplete: true` 但 `paperComplete: false` 的图仍是可审计历史，却不能被导出成 paper-ready
performance history。

exploration export 另按被评测版本保存 `evaluation_analysis.md`、
`next_optimization_plan.md` 和 `manifest.json`，并用 `tree.json` 绑定完整 inventory。这样“哪一版看过
哪些历史、做了什么修改、用哪些蛋白 cohort 进行聚合评测、Teacher 给了什么建议、为何继续/回退、为何
proceed/stop”都有迹可循并可公开。需要同时公开可复核的原始 result/StateRoot public files 时，仍须把
对应 artifact 放入独立持久存储并按 tag 中的 hash 校验；Git publication 不能替代 artifact hosting。
任何涉及 private evaluator identity、保密蛋白、逐蛋白 gold/prediction 或 evaluator-private 的材料
都不属于公开导出，也不得随论文 artifact bundle 发布。

## 8. `main` 不是 RSI 权威指针

`main` 可以用于集成稳定代码、发布和日常协作，但它可能领先、落后或包含多个已评测版本。primary
checkout 也可能暂时停在某个准备中的 working branch。RSI 当前状态应由 `rsi-version-tree` 输出的
`selectedVersionId`、latest version/evaluation 和 `decisionHeadId` 判断，而不是由 `main`、当前
checkout 或某个开发 branch 判断。删除短期 branch/可选 worktree 不影响已发布 version tag；删除或移动
version/event tag 则会破坏审计链。相同地，`rsi-version-prepare` 成功只表示“同一目录已准备到某个
plan-authorized base”，不表示 planned version 已注册、已评测或已成为 champion。

这里还必须区分普通 Git commit 与“确定下来的一版功能预测智能体”。单独修改 harness、测试、文档或版本
协议的维护 commit 可以先进入 `main`，但它本身不是新的 RSI version；应在下一份真正准备接受蛋白/Teacher
评测的完整 predictor candidate 中一并冻结。当前协议故意不提供“harness-only software checks 就算
paper complete”的捷径，否则一次没有运行蛋白预测的基础设施修改也会被误报成新的功能预测结果。若未来
确实需要把纯 harness 版本作为独立 RSI 节点，应先新增独立的、预注册的 30-case prediction-equivalence
协议和明确的 infrastructure-only verdict；在该协议实现前，不得用 identical predictions、
零增益阈值或借用旧 StateRoot 伪造 adaptive improvement。

## 9. 已知限制与运维要求

- 当前 v0004 的 Priority100 证据是 retrospective development/procedural-holdout evidence，不是 temporal
  blind benchmark 或 publication-grade generalization evidence。它只授权 operational incumbent 与
  v0005 pre-code plan；v0001 formal champion 保持不变，v0005 必须另开 fresh prospective evaluation。
- 当前 tag 明确使用 annotated、`--no-sign`，是 hash-addressed 但未做密码学签名。需要强身份时，应增加
  签名和独立 transparency/audit log。单个 tag 也不自证“由哪个 verifier/schema 发布”；公开复现包
  必须同时绑定被审计的 `main` commit、verifier/schema 代码和完整 `refs/tags/rsi/*`，论文中应把
  受控远端 ACL 明确写成信任边界，而不是声称已有签名 transparency log。
- CLI 使用 immutable event slot + atomic push 解决正常客户端的 stale-read 并发，但不能替远端配置权限。
  remote 必须支持 atomic push，并设置禁止 tag 删除、禁止
  force-update，并限制 `refs/tags/rsi/**` 的写权限。
- StateRoot seal 能发现普通损坏或不一致，但能重写整个目录的人也能重算 seal。应把 seal hash、tag object
  ID 和 Git bundle hash 锚定到另一审计系统，并保存在不同故障域。
- 新图主体是 prospective contract：旧 branch、merge、`rsi-z*` tag、method generation 和历史
  StateRoot 不自动变成 `refs/tags/rsi/version/*` 节点，也不应为追求“完整”而事后虚构
  version/opening/result/decision。唯一兼容入口是给已经存在完整旧链的 evaluation 追加
  `retrospective_legacy` publication，而且必须如实限制 claim。
- `rsi-version-exploration-record` 接受 Developer/调用者编写的 plan spec。harness 会验证历史、
  evaluation、v2 `baseVersionId` 已在 bound prefix 注册、closed schema 和事件顺序，但不会自主联网，
  也不能证明提交者在认知上读过
  每条历史；research cards 的搜索与清洗仍是外部 Developer/research stage 的责任。
- exploration event 在 child version event 之前，只证明“计划先于 RSI child 注册”，不证明任意
  unregistered draft/commit 的物理创建时间，也不逐行证明实现符合计划。论文应公开写成 auditable
  pre-registration，而不是更强的思维或代码生成时序证明。
- version graph 证明“哪份代码、基于哪段历史、按什么协议、产生哪个 artifact、公开了哪些聚合结果与
  Teacher 结论、最终选了谁”；它本身不把 adaptive-development cohort 变成独立 holdout，也不自动
  证明蛋白功能预测的总体效果。性能结论仍需独立、预提交、无泄漏的 benchmark 与不确定性分析。
- 当前公开层是 identifier/path DLP 与聚合级最小披露，不是 differential privacy。精确 aspect 指标和
  稳定 cohort commitment 仍可能在极小子组或拥有额外背景知识时产生统计推断/跨轮关联风险；论文发布前
  应设定最小分组大小并对小样本 aspect 做 suppression/分桶，必要时使用带审计盐的 cohort commitment。
