# 自主 RSI orchestrator：以候选版本为中心的迭代导游

这层解决的是外层 harness 过去缺少的顶层控制问题。已有 `outer-*` 命令负责具体的冻结、评测、Teacher 反馈和 promotion 合同；新的 orchestrator 不替代这些机制，而是把可执行 worker 串成一个可恢复循环：

```text
当前候选完成 private evaluation
   │
   ▼
读取完整候选树、历轮结果、经验和研究卡
   │
   ▼
Diagnose/reflect：先定位问题来源
   │
   ├─ 参数/超参数 ───────────────> 直接进入 Plan 调参 ───────────────┐
   ├─ 实现/流程 bug ─────────────> 直接进入 Plan 修复 ───────────────┤
   ├─ 评测/测量问题 ─────────────> 直接进入 Plan 修正或停止 ─────────┤
   ├─ 无安全动作 ────────────────> Stop                           │
   └─ 方法/工具能力缺口 ──> 高质量文献 Research ──> 来源绑定知识卡 ─┤
                                                                        ▼
Plan：同时选择一个已评测历史 base + 一个可证伪改进方案
   │
   ▼
Develop from exact base + Git commit ──> software Verify
   │
   └────────────────────────────────────> private Evaluate 下一候选

停止条件：评测主动停止 / 指标平台期 / 轮数预算 / worker 失败 / 验证失败
最终产物：完整 development candidate tree + best-candidate formal_handoff.json（不是自动 promotion）
```

这里的“自主”有一个明确含义：控制器会自行推进阶段、重试失败阶段、从中断点继续、按指标判断是否再迭代，并把每轮可读经验和候选父子关系写入可重放探索树。模型负责解释结果、判断是否需要研究、选择历史 base 和提出改进；host 负责验证 base 确实存在且已评测，并强制从该 exact commit 开发。每个阶段的智能工作由配置的 worker 命令完成；worker 可以是 Pi/Codex 类 coding agent、已有评测命令，或团队自己的脚本。

## 1. 对外是五段生命周期，内部是六个可恢复 worker

| 对外阶段 | 内部 worker | 角色 | 必须产出 |
|---|---|---|---|
| Plan | `plan` | developer | 结合完整历史和知识，同时提交 exact historical base、continue/backtrack/branch、理由、可证伪假设、改动目标、controls、rollback 条件 |
| Develop | `develop` | developer | 新候选 ID、artifact hash、**非空 Git source commit** |
| Test | `verify` | developer | 软件测试结果和 commit/candidate binding |
| Test | `evaluate` | 私有 evaluator | 待测蛋白指标、脱敏反馈、continue/stop |
| Diagnose | `diagnose` | developer | **先分类问题来源再路由**：parameter/hyperparameter、implementation/pipeline、method/tool capability、evaluation/measurement 或 no-safe-action；保存 primary/secondary source 与根因理由 |
| Research/knowledge | `research` | developer | 仅在 Diagnose 要求时联网检索 Q1/top-venue 方法文献；否则 host 记录 `not_required`，需要时把 source-bound research cards 加入永久知识 |

`verify` 和 `evaluate` 不是两轮重复评测：前者回答“这个 commit 能否稳定运行”，后者回答“它在冻结蛋白集
上效果如何”。所以 UI/状态把两者合并为 `Test`，代码仍分开，便于断点恢复，也确保只有 evaluator
worker 能读 private 数据。`autonomous-rsi-status` 的 `lifecycle` 字段会给出当前 phase、Test gate、
active candidate、current-best candidate 和 next action；`candidateGraph` 同时显示 root、最新已评测节点、历史最好节点、Plan 选择的 base 和全部父子边。

只有 `evaluate` 可以接触 evaluator/private 环境。其输出进入后续阶段前必须通过 identifier DLP：GO ID、accession、case ID、gold/private 字段或路径都会被拒绝。生产 adapter 只在 evaluate 进程继承 evaluator allowlist；私有 evaluator 命令本身由一个 evaluator-only 环境变量提供，developer worker 既看不到命令也看不到 vault 值。

Pi knowledge worker 只有一个结构化 submit tool；Pi develop worker只能使用 host-owned、相对路径、realpath/symlink 检查和改动 allowlist 约束的 workspace tools，没有通用 shell 或任意文件读取工具。Diagnose 必须先输出 `primaryProblemSource`、可选 `secondaryProblemSources` 和 `rootCauseRationale`。Host 强制路由：参数/超参数、实现/流程和评测/测量问题跳过联网 Research，直接进入 bounded Plan；只要分类中包含 method/tool capability gap，就必须 Research 后才能 Plan；`no_safe_action` 不得混入其他分类。Research 的外部资料只能由 `researchCommand` 注入。这里的 Research **不是搜索待预测蛋白的功能信息**，而是为了补足新方法/新工具的外部方法学依据。生产 `methodResearchPolicy` 固定禁止 target-specific research；每次 required Research 至少绑定两份独立的 Q1 journal/top venue peer-reviewed 来源及 DOI/PMID。官方 tool/database 文档只能补充实现细节；preprint、blog、forum 和 vendor marketing 不能作为知识卡证据。若选择外部 command backend，则部署方仍必须在容器/agent runtime 中执行对应沙箱；生产配置要求三项 runtime attestation 全部为真，否则 fail closed。

三个 `src/outer` 目录也不是三套同时运行的 RSI：`autonomous/` 是当前 primary runtime；`adaptive/` 是旧参数/策略实验的 replay/compatibility 层；`version_graph/` 是可选的 formal prospective 科学治理层，不是优化算法。只做 development campaign 时无需调用后两者。详见 [`src/outer/README.md`](../src/outer/README.md)。

## 2. 为什么它不会破坏现有 RSI 治理

开发控制器只能运行 `development_only`，`formalGovernance.mode` 固定为 `handoff_only`。它不会：

- 写 `refs/tags/rsi/*`；
- 把一次开发评测冒充 formal opening、selection 或 promotion；
- 在已有 terminal stop 后偷偷制造新版本。

如果 spec 绑定了 terminal stop 的 event sequence/hash，最终 handoff 会明确要求：先用 stable controller 的 `rsi-version-epoch-resume` 追加 `resume/new_epoch` 事件，再执行 candidate commit → register → remote verification → fresh opening。resume spec 必须绑定 base、planned version、验证要求，并固定“旧 evidence 只作 retrospective knowledge、不能 promotion”。也就是说，自主开发可以持续产出候选和知识，但正式 RSI 历史仍保持 append-only。每次 campaign 只创建一个仓库外的 detached campaign worktree；Plan 选择任一已评测历史节点后，host 会先确认工作区干净，再把这个共享 worktree 切到该节点的 exact commit。每次有效迭代仍生成独立、永久、可重放的 candidate commit/tree node，host 还为成功 commit 建立 `refs/autonomous/<campaign>/candidates/*` 本地归档 ref。物理目录复用不会覆盖版本历史。最终只把历史最好且经过审查的候选交给 formal bridge；探索 ref 不会自动 push，也不会冒充 prospective `rsi/version`。

## 3. 最小 spec

`autonomous-rsi-init` 接受未带 `canonicalHash` 的 JSON，主机校验后自动封存 hash。完整 schema 在 `schemas/autonomous_rsi_spec.schema.json`。

```json
{
  "schemaVersion": "pi-autonomous-rsi-spec.v1",
  "campaignId": "development-autonomous-r1",
  "mode": "development_only",
  "objective": {
    "metricId": "development_overall_f1",
    "direction": "maximize",
    "minimumImprovement": 0.002,
    "plateauPatience": 2
  },
  "budget": { "maxIterations": 8, "maxStageAttempts": 2 },
  "initialCandidate": {
    "candidateId": "baseline",
    "artifactHash": "<64-hex-artifact-hash>",
    "sourceCommit": "<40-or-64-hex-git-object-id-or-null>"
  },
  "workers": {
    "evaluate":  { "command": "./workers/evaluate", "args": ["--input", "{{input}}", "--output", "{{output}}"], "workingDirectory": "project", "timeoutSeconds": 7200, "inheritEnv": [], "networkAccess": "disabled" },
    "diagnose":  { "command": "./workers/agent", "args": ["diagnose", "{{input}}", "{{output}}"], "workingDirectory": "project", "timeoutSeconds": 1800, "inheritEnv": ["HOME"], "networkAccess": "disabled" },
    "research":  { "command": "./workers/agent", "args": ["research", "{{input}}", "{{output}}"], "workingDirectory": "project", "timeoutSeconds": 3600, "inheritEnv": ["HOME", "RESEARCH_API_TOKEN"], "networkAccess": "enabled" },
    "plan":      { "command": "./workers/agent", "args": ["plan", "{{input}}", "{{output}}"], "workingDirectory": "project", "timeoutSeconds": 1800, "inheritEnv": ["HOME"], "networkAccess": "disabled" },
    "develop":   { "command": "./workers/agent", "args": ["develop", "{{input}}", "{{output}}"], "workingDirectory": "project", "timeoutSeconds": 7200, "inheritEnv": ["HOME"], "networkAccess": "disabled" },
    "verify":    { "command": "./workers/verify", "args": ["--input", "{{input}}", "--output", "{{output}}"], "workingDirectory": "project", "timeoutSeconds": 7200, "inheritEnv": [], "networkAccess": "disabled" }
  },
  "formalGovernance": {
    "mode": "handoff_only",
    "terminalStopEventSequence": null,
    "terminalStopEventHash": null,
    "resumeContract": "explicit_append_only_new_epoch_required"
  }
}
```

worker 参数支持 `{{input}}`、`{{output}}`、`{{campaign}}`、`{{project}}`、`{{iteration}}`、`{{stage}}` 和 `{{attempt}}`。命令通过 `execFile` 直接执行，不经过 shell。环境默认最小化；只有 `inheritEnv` 中明确列出的变量会传入。非 research 阶段不能声明 token/secret/password 类环境变量。

`maxIterations` 是 operator 在实验前封存的私有评测次数上限，不由模型在运行中扩张；第一次 baseline evaluation 也计数。因此生产默认 `2` 表示 baseline 加最多一个新候选。模型可以在预算内建议 continue/backtrack/branch/stop，evaluator/plateau/失败规则也可提前停止，但任何 worker 都不能越过 hard cap。这一设计使自主搜索仍受预注册计算预算约束。

## 4. 运行和恢复

```bash
./pi-agent benchmark autonomous-rsi-init \
  --spec autonomous-rsi-spec.json \
  --campaign-dir campaigns/development-autonomous-r1

./pi-agent benchmark autonomous-rsi-run \
  --campaign-dir campaigns/development-autonomous-r1 \
  --project-root .

./pi-agent benchmark autonomous-rsi-status \
  --campaign-dir campaigns/development-autonomous-r1

./pi-agent benchmark autonomous-rsi-verify \
  --campaign-dir campaigns/development-autonomous-r1
```

调试时可加 `--max-transitions 1`，每次只推进一个阶段。再次运行同一条 `run` 命令会从 `state.json` 的 cursor 恢复；已经封存的 stage result 不会重复执行。

每个 worker 向 `{{output}}` 写 `pi-autonomous-rsi-stage-output.v1` JSON。它必须绑定 campaign、iteration 和 stage，并返回 `completed`、`stop`、`retryable_failure` 或 `fatal_failure`。主机校验 stage-specific payload；schema 入口为 `schemas/autonomous_rsi_stage_output.schema.json`。

## 5. 产物层次

```text
campaigns/<id>/
├── spec.json                         # 封存后的控制合同
├── state.json                        # 可恢复 cursor、预算、最佳指标、event chain
├── iterations/
│   └── 0001/
│       ├── evaluate/
│       │   ├── input.json
│       │   ├── attempts/001/{output.json,stdout.log,stderr.log}
│       │   └── result.json
│       └── ... diagnose/research/plan/develop/verify
├── exploration/
│   └── candidate_graph.json          # 全部探索节点、父子边、评测、反思、base 决策和知识卡
├── history/contexts/
│   └── 0002-plan.json                # 真正交给下一阶段模型阅读的完整脱敏历史
├── knowledge/
│   ├── index.json                    # 跨轮 hash chain
│   └── iterations/0001.json          # 本轮六个 stage hash + parent/next candidate
└── formal_handoff.json               # 绑定历史最好候选和 candidate-tree head 的正式审查边界
```

`autonomous-rsi-verify` 会重算 spec/state/stage/event/knowledge/history/candidate-tree/handoff 的 canonical hash 和链关系。`knowledgeHeadHash` 继续提供不可变链头；新增 history context 则包含模型可直接阅读的全部公开探索记录、候选树、历轮 lesson 和 research cards。它不是只有一个无法理解的历史哈希。

## 6. 和原外层 harness 的关系

可以把两层理解成：

```text
autonomous orchestrator = 调度员、循环状态机、记忆和停止规则
outer RSI harness       = 评测场、隐私墙、候选生成合同和正式晋升规则
stage workers           = 真正做诊断、联网研究、写代码和跑测试的智能体/命令
```

因此新层不是另起一套评分系统。生产 adapter 已经把这三段实现为：一次 campaign 创建一个 detached worktree；Develop 先将它切换到 Plan 选定的 exact historical commit，再由 host 检查改动 allowlist、拒绝 symlink、执行 `git diff --check` 并提交；Verify/Evaluate 在需要时把同一个干净 worktree 切到所绑定的 exact candidate commit，分别运行固定软件检查和隔离 development evaluator。代码拒绝不存在、未评测或与 Plan 不一致的 base，也拒绝 `sourceCommit=null` 的新候选，保证 tree parent、代码 commit 和科学计划一致。所有有效迭代仍由 commit/ref/candidate graph 永久保存；共享 worktree 只是可复用的物理桌面。失败且尚未形成合法 candidate commit 的 stage attempt 才会在这个 campaign-owned worktree 内清理，以便按封存规则重试；主 checkout 从不 reset/stash。

## 7. 一配置文件、一条命令的生产入口

正常使用不必手写十几个 CLI 参数。先复制 `config/autonomous-rsi-production-start.example.json`，只填写 campaign ID、仓库外 run root、research/evaluator command 文件和 hard evaluation 次数，然后前台执行：

```bash
./pi-agent benchmark autonomous-rsi-production-start \
  --profile /absolute/production-start-profile.json
```

该命令会按固定安全默认值完成 initialize-or-resume → run → status/verify。默认模型是 `openai-codex/gpt-5.6-sol` high，默认 objective 是 canonical benchmark 定义的 `development_macro_groups123_overall_fmax`（Gold_v1 三组 Overall Fmax 宏平均）；最小提升、plateau 和重试沿用 production init 的封存默认。高级实验仍可使用下面的显式 init/run 入口覆盖。Evaluator command file 只包含 runner 和允许继承的环境变量名，不包含 Gold 或 secret 值；research/evaluator 凭据仍由环境提供。

两个外部 adapter 不是每轮人工输入：private evaluator 是隔离的“阅卷器”，避免 Developer 看到 Gold；method-literature runner 是受来源策略约束的“图书馆检索器”。它们配置一次后，one-command start 会在所有轮次自动调用。由于具体 private cohort/Gold 和文献 provider/凭据不属于公开 codebase，系统不能安全地替操作者猜出这两个绑定。

## 8. R08 GPT-wide 底层/高级生产入口

`config/autonomous-rsi-r08-gpt-wide-baseline.json` 把开发起点显式冻结为 `openai-codex/gpt-5.6-sol`、`128 candidates / 12 donor contexts`，并绑定 genome、历史 r08 code identity、治理记录及指标。它只表示“首选 retrospective development baseline”：overlap-42 已打开，不能据此晋升。

```bash
./pi-agent benchmark autonomous-rsi-production-init \
  --repository-root /absolute/clean/repository \
  --campaign-id r08-wide-development-r1 \
  --campaign-dir /durable/r08-wide-development-r1 \
  --runtime-dir /durable/r08-wide-runtime \
  --workspace-root /durable/r08-wide-workspaces \
  --research-command-file /absolute/method-research-command.json \
  --model-provider openai-codex \
  --model-id gpt-5.6-sol \
  --max-iterations 2
```

入口要求 repository 的 tracked state 干净，campaign/runtime/workspace 全部在 repository 外，并要求一个显式 research command；这是唯一可以检索外部资料的命令。生产 init 只接受 rooted Pi knowledge/development backends，外部 command backend 仅保留给隔离集成测试。入口将当前 clean HEAD 作为工程起点，同时把 R08 GPT-wide 方法 binding 纳入 initial artifact hash；不会把历史 r08 tag 移动到当前平台 commit。

`research-command-file` 的格式可从 `config/autonomous-rsi-method-research-command.example.json` 复制。该命令只在 Diagnose 明确要求方法研究时执行；stdout 必须是一个 `schemas/autonomous_rsi_method_research_material.schema.json` 对象，而不是自由文本。对象要逐字绑定 Diagnose 的 questions，并为每个来源给出 source type、Q1/top-venue quality tier、分区/venue 依据、title/authors/year/venue、DOI 或 PMID、HTTPS URL、相关发现和限制。Host 拒绝 questions 漂移、target-specific 问题、只有官方文档而没有足够 scholarly support、以及知识卡引用不存在的 source ID。

Production init 只负责封存 campaign；随后直接运行，不需要再给 coding agent 逐轮提示词：

```bash
./pi-agent benchmark autonomous-rsi-run \
  --campaign-dir /durable/r08-wide-development-r1 \
  --project-root /absolute/clean/repository

./pi-agent benchmark autonomous-rsi-status \
  --campaign-dir /durable/r08-wide-development-r1

./pi-agent benchmark autonomous-rsi-verify \
  --campaign-dir /durable/r08-wide-development-r1
```

生产 worker config schema 是 `schemas/autonomous_rsi_production_worker_config.schema.json`。Evaluator-only 环境变量的值是一个 command JSON：

```json
{
  "executable": "/absolute/evaluator-runner",
  "args": ["--input", "{{input}}", "--output", "{{output}}", "--workspace", "{{workspace}}"],
  "timeoutMs": 21600000,
  "inheritEnv": ["FROZEN_EVALUATOR_CONFIG"]
}
```

Evaluator 必须按 `schemas/autonomous_rsi_evaluator_result.schema.json` 向 `{{output}}` 写 `{ "schemaVersion": "pi-autonomous-rsi-evaluator-result.v1", "metric": { "metricId": "...", "value": 0.0 }, "decision": "continue|stop", "feedback": { ...sanitized... } }`。Host 再绑定 candidate、校验 objective 和 DLP，worker 不能自行伪造另一个 candidate。

## 9. 自动 formal lifecycle 的 fail-closed 门

`formal_handoff.json` 生成后仍不会自动改变正式图。只有显式提供 `pi-autonomous-rsi-formal-authorization.v1`、其 canonical hash、完全一致的 handoff/candidate binding，以及独立的 approval token preimage，才可运行 formal bridge：

```bash
PI_AUTONOMOUS_RSI_FORMAL_APPROVAL_TOKEN='out-of-band-token' \
./pi-agent benchmark autonomous-rsi-formal-bridge \
  --authorization /durable/formal-authorization.json \
  --receipt /durable/formal-bridge-receipt.json
```

授权文件 schema 是 `schemas/autonomous_rsi_formal_authorization.schema.json`。它必须逐项接受：campaign 已验证、handoff 已审阅、evaluator isolation 已验证、未打开 cohort 已预提交、remote publication 必须成功、所有 mutation 仅由 controller 完成。允许的有序操作只有：register → evaluation-open → evaluation-complete → evaluation-publish → decide → exploration-record。

Bridge 会再次验证 campaign hash chain、handoff hash、candidate 三元组、clean candidate HEAD 和 remote，然后从该 exact commit 安装 content-addressed controller，并只通过其 exact Node/runner 执行授权操作。候选代码永远不能直接写 formal refs。每步先写 `running` receipt；任何失败或“命令可能成功但 receipt 未确认”的情况都变成 `reconciliation_required`，不会猜测、重放或静默继续。

这意味着自动 formal lifecycle 已具备执行通道，但默认仍关闭。只有在新的 unopened confirmatory protocol、R7/DeepGOPlus comparator、私有 evaluator 和 out-of-band approval 同时准备好后，才能为某个候选生成授权。R08 GPT-wide 的旧 overlap-42 结果不能满足该门。

## 10. Campaign 完成后：在 M 个 worktree 中选择、归档和提升

一次 campaign 是“一张工作桌 + 一棵完整候选树”。如果并行运行 M 次，就是 M 张注册桌面和 M 棵独立树：

```text
main=A
├─ campaign-1/worktree → A/B/C
├─ campaign-2/worktree → A/D/E   # 人选择这一轮
└─ campaign-3/worktree → A/F/G

选择 campaign-2 后：
main → campaign-2 的 verified best（例如 D）
refs/campaigns/campaign-2/candidates/* → A/D/E 的完整 commits
refs/campaigns/campaign-2/archive      → 脱敏 graph、指标、反思、lessons
campaign-1/3                           → 完全不动
```

自然语言入口是“把这个 RSI worktree 合并回 main”。Pi/Codex 根据 `AGENTS.md` 调用 Host，而不是自行 merge：

```bash
# 在目标 worktree 内：只读 preview
./pi-agent benchmark autonomous-rsi-promote

# 明确同意 preview 后：hash-bound apply
./pi-agent benchmark autonomous-rsi-promote \
  --apply --expected-preview-hash <preview.canonicalHash>
```

Host 自动完成：worktree→campaign 身份发现；terminal campaign replay verification；graph/handoff best 一致性；candidate commit/tree/parent/ref 验证；private/Gold/target 内容拒绝；全部候选 refs 和 sanitized archive 发布；remote 回读；receipt 和 identity 状态更新。Best 永远从 verified handoff 读取，不能靠 `--best-candidate` 人工覆盖。

Capability promotion 也 fail closed：任何成功 acquisition 都必须在 retained candidate 的 usage manifest 中分类为 `required` 或 `unused`。若存在 required acquisition，先用 `baseline-materialize` 建立并验证新的只读 versioned baseline，再在 preview/apply 两次命令中传同一个 `--baseline-root <DIR>`。缺少 usage、baseline/tool hash 不匹配或 artifact 篡改都会阻止 main 移动。原始 G0 toolbox 永远不被修改。

如果 main 已从 campaign baseline 前进，Host 不做普通三方 merge，也不继承旧分数，因为 `new-main + old-candidate` 是一个未评测的新版本。此时 fail closed，要求先形成单独的 integration candidate 并重新 Verify/Evaluate。未选中的 campaign 可用 `autonomous-rsi-archive` 完整发布而不修改 main。

下一 campaign 的 start profile 新增：

```json
{
  "evaluatorContractHash": "<frozen evaluator/benchmark SHA256>",
  "publishedHistory": "auto"
}
```

`auto` 会 fetch/discover canonical repository 的 immutable `refs/campaigns/*/archive`，无需手工整理 manifest 路径；高级恢复仍可给一个仓库外 manifest 文件。Host 只导入 evaluator contract、metric 和软件验证仍兼容的 evaluated candidates；它们作为带 provenance 的 historical seeds 出现在完整 history context 中，Plan 可从当前 main 或旧 C/D/E 节点继续。验证失败或 graph 外候选的代码同样完整保存，但不直接成为 executable base；它们需要修复和重评。

## 11. 验收边界

自动化测试现在覆盖真实临时 Git repository 中的树搜索：baseline A 评测后生成 B；下一轮读取完整历史，Plan 回到已评测 A，生成 sibling C，而不是被迫沿 B 继续。测试同时检查：

- candidate graph/hash replay、best/latest/selected-base 三个指针相互独立；
- Reflection 可在 operator 硬上限内提前停止；
- 不需要新知识时不启动外部 research，需要时知识卡永久进入后续 history；
- Develop 的 commit parent 精确等于 Plan 选择的历史 base；成功 commit 有非正式本地归档 ref；
- formal handoff 选择历史最好候选，而不是误选最新候选；
- resume/hash chain、primary checkout 不变、无 `refs/rsi`/tag、evaluator vault 不进入 knowledge。

Pi backend 与 command backend 共用相同 host contract；测试使用低成本 deterministic commands，生产使用 Pi SDK 和真实 evaluator。生产 campaign 的科学有效性仍取决于另行配置并预注册的真实 private evaluator/research command；代码测试不会伪造 ICLR 实验结果。
