# EviRead Codebase1 下一版本研究与实验方案

状态：方案草案，供研究者检查；本文件本身不宣称已经完成实验，也不改变当前生产基线。

依据：`EviRead-Handoff-20260925.zip`（2026-09-25 研究交接）及当前仓库的只读审计。交接包是研究材料，不是完整复现环境；它没有补造 Gold、原始输入、evaluator 或模型资源。

## 1. 研究对象和本版本的目标

下一版本研究的是：在冻结 BioLM 与协调 LLM 权重的条件下，任务反馈能否让系统形成一套可执行、可修订、可携带、可在新对象上复用的沟通载体。载体可以包括问法、候选和选项的组织、原生响应的有限解释、分歧处理、追问和停止规则，以及这些约定到真实模型操作的绑定。

本版本不把“增加 agent 数量”“加长解释”“调融合权重”或“重复调用”当作沟通学习。若当前能力只能读取已经生成的三模型表，实验只能称为融合、证据组织或自适应工具使用；只有真实原生操作被核定并且沟通修改能改变操作输入或候选决策，才能检验更强的 communication 主张。

要检验的三个命题是：

* **H1，载体可学习：**反馈促成了问法、回应解释或沟通惯例的可执行变化，而不只是数值融合变化。
* **H2，变化有因果作用：**撤掉惯例、换回旧解释或替换关键原生响应后，相应行为会改变，且不能由更多预算或 LLM 先验单独解释。
* **H3，经验可继承：**清空会话和临时状态，只加载冻结载体，在未参与优化的新对象上仍能复用。

三项都未满足时，研究结论必须按实际结果收束为读出方法、证据组织或工具使用结果。

## 2. 当前 Codebase 的事实、边界和待核对项

当前主路径是：

```text
BioLM artifact → model-only evidence/Read → deterministic GO inference
→ mandatory semantic GO judge → GO selection/export → 外部 evaluator
```

`src/eviread_read.ts` 读取并校验 `biolm-evidence.v1`，`src/model_only_profile.ts` 限制 Codebase1 的候选来源，`src/semantic_go_judge.ts` 生成受限候选视图并作语义判断。现有 `python/biolm.py` 的可确认接口主要是模型选择、序列 embedding、检索 `k`、相似度阈值和权重；未审计出可直接进行自然语言问答的 BioLM 接口。因此不能把当前固定 TSV、确定性文本或语义 judge 的说明文字称为模型间对话。

审计还发现一个必须先处理的运行契约问题：`config/biolm_policy.json` 当前默认模型集合与 `src/biolm.ts`、`src/model_only_profile.ts` 的三模型强制检查并不一致。必须在工作段 A 明确并哈希绑定两类状态：

1. **三模型离线重分析绑定：**用于复核交接包中的 ESM2/ESMC/ProTrek 结果。
2. **当前在线绑定：**若 operator 选择 ProTrek 单模型或其他明确集合，代码必须按该集合验证，而不是用三模型结果冒充在线运行。

另外，旧检查曾记录 `candidate_stage.attachCandidateSources` 可能覆盖已有候选来源。它是待核对的历史线索；若当前仍存在，先修复并做回归，再做通信实验。调用失败、空返回、生物学拒绝和“无法区分”必须在记录中分开。

必须保持不变的边界：

* LatestRSI 是唯一外层控制器；不新增第二套历史、evolver 或 EarlyRSI。
* `src/experiment/`、`src/outer/`、`test/rsi/`、正式 experiment/capability schemas、package/test 命令、Gold、evaluator 和治理状态属于 Host 或 evaluator 边界。
* 不修改模型权重、ontology、GO ID、原始 `base_score`、provider payload、匿名/盲视图规则或测试信息协议。
* 不删除旧 provider 和历史模块。所谓“精简”只指收窄本实验的 active profile；旧代码保留为兼容或 inactive 记录。

## 3. vNext 的最小代码结构

新方法只增加一层候选侧 communication layer，插入 `loadModelOnlyEvidence` 之后、`inferGoPredictions` 和 semantic GO judge 之前：

```text
immutable raw BioLM artifact
        ↓
communication carrier + typed adapter（candidate-owned，版本/hash）
        ↓
derived evidence view（只引用原 evidence ID）
        ↓
现有 deterministic inference → semantic GO judge → selection/export
```

建议新增以下方法层文件，先在新 baseline 中完成，再启动 RSI：

* `src/communication/contracts.ts`：有限的 typed operation、carrier、trace 类型和哈希校验。
* `src/communication/carrier.ts`：加载、校验、版本继承、diff 和适用条件检查。
* `src/communication/adapters.ts`：把真实 BioLM 能力绑定到 operation；未知或未开放能力必须 fail-closed。
* `src/communication/executor.ts`：每个对象重置 inner state，执行候选选择、比较、保留多假设、追问/停止，并生成派生 evidence view。
* `src/communication/trace.ts`：记录 raw artifact、operation、适配解释、协调决定、证据引用和成本的哈希链。
* `src/index.ts`：仅接入上述 stage，不绕过现有 blind、GO、semantic 和 exporter。

载体至少包含：`schemaVersion`、`carrierId`、`parentHash`、`origin`、`researcherSeed`、`aiChanges`、`capabilities`、`heuristics`、`immutableBindings`、`status` 和 `canonicalHash`。每条 heuristic 至少包含 `trigger`、`questionConstruction`、`nativeOperation`、`interpretation`、`nextStep`、`mustNotInfer`、`supportingCases`、`counterexamples`、`intervention` 和状态。研究者提供的 seed、AI 提议、接受、拒绝和回退必须分开记录。

初始 operation 只允许已核定能力，例如：

* `source_select`：选择已存在的模型/来源视图；
* `support_compare`：比较共享支持、区分支持、来源依赖或候选排序；
* `interpret`：在有限枚举中表示支持、不足、冲突、不可用；
* `retain_multi`、`request_more`、`stop`。

如果操作只是对缓存分数做整理，记录为 adapter/host transform，不称作 BioLM 的新回答。自然语言 query、ProTrek text query、动态 crop 等能力只有在本地版本、输入输出和资源锁全部核定后才能加入 capability manifest。

原始 artifact 永不覆写。派生 view 可以改变候选子集、顺序、分组或可见解释，但必须保留原始 evidence ID、provider hash 和 `base_score`。通信 trace 单独落在 run 外部目录，不能把字段硬塞进已有严格的 episode schema；新 baseline 的 validator 需要对 trace 做 privacy 扫描、哈希核对和 deterministic replay。外层 updater 只能看到现有 `metric_only` 或 `structured_diagnostic` 安全视图；不能把 GO、accession、target、Gold 或逐对象私有标签传给更新器。

固定 carrier 与可演化 carrier 的条件差异由 Host 的外部 condition manifest 和 hash/path 检查表达，不修改 LatestRSI controller schema。现有 `promptConfigHash` 可绑定 carrier，`toolConfigHash` 可绑定 capability manifest，`modelConfigHash` 固定模型集合。固定条件不得修改持久 heuristic 语义；可演化条件才允许 candidate 修改 `src/communication` 与绑定的 carrier 文件。

## 4. 实验推进顺序

### 工作段 A：把已有结果变成可解释起点

**输入：**交接包、实际原始 TSV/预测输入、同一 evaluator、训练/验证/测试 manifest、当前源码 commit、模型和资源绑定。

**动作：**

1. 运行交接包只读 audit，并记录其 SHA-256；不把 audit 当作 Fmax 复现。
2. 在同一集合、同一 evaluator 下重建最强单模型、等权/校准 mean、已有 max 和一个简单可学习融合。交接包记录的 mean `.283465`、max `.335958` 等只作为历史记录，不能替代当前重算；validation 已参与选择，不是独立测试。
3. 核对候选集合、来源链、missing 与 zero、模型集合 policy hash，以及旧 candidate 覆盖线索。
4. 对 `max > mean` 至少形成两种竞争解释并设计区分检查：尺度/校准、候选缺失、来源互补、过度具体标签或其他可观测机制。不要预先写成“专家协作”。
5. 挑出可回放的分歧、失败和反例，说明它们是融合问题、执行问题还是确实需要改变问法/解释的问题。

**产物：**起点结果表、版本和暴露记录、模型能力表、两个以上真实案例、max 竞争解释和检查脚本。

**继续条件：**链路可回放，至少知道一个不是全局加权即可解释的错误。关键输入缺失时暂停 B，恢复缺失对象，不重建大框架掩盖缺失。

### 工作段 B：最小可执行载体

**输入：**A 的真实失败和 capability manifest。

**动作：**以研究者明确提供的少量 seed 作为起点，在约 8–12 个开发对象上做机制调试。每个对象重置 task state；保留 raw response → adapter interpretation → coordinator decision 三层。至少有一条 heuristic 能改变候选 view、semantic view、最终决策或停止行为，并保留一个会受损的反例。

**产物：**carrier v0、可执行入口、通信 trace、前后 diff、支持案例和反例。若只改变文字而候选/操作/决策不变，判定为接口展示，不进入 C。

**继续条件：**可以证明载体变化进入预测路径；否则先修复接口或把结果收束为证据组织。

### 工作段 C：有对照的反馈学习

使用四个独立 LatestRSI campaign，初始 candidate、模型、资源、查询/计算预算和 evaluator 相同。新的因子通过外部 condition manifest 表达，不能冒充现有 history 五 cell：

| 条件 | 持久载体可修改范围 | updater 可见反馈 |
|---|---|---|
| A `fixed_metric` | 固定 seed 的既有 operation 选择/顺序；不得新增 heuristic 语义 | `metric_only` |
| B `fixed_structured` | 同 A | `structured_diagnostic` |
| C `evolve_metric` | 可修订/组合问法、回应解释和惯例 | `metric_only` |
| D `evolve_structured` | 同 C | `structured_diagnostic` |

关键比较是 D 对 B（同类过程反馈下，允许沟通载体演化是否有增量）和 D 对 C（结构化反馈的增量）。保留从相同初始状态独立提出候选、再统一开发评价选择的搜索对照，证明不是“多试几次”即可解释。报告全部尝试、失败、回退、调用数、token、GPU/CPU、缓存和费用；不只报告最好曲线。

补强对照包括：最强单模型、mean/校准融合、max、简单 learned fusion、同接口同预算但无持久 carrier 的自适应 tool-use，以及同更新预算的通用 prompt/program optimizer。若新方法使用更多查询或新模型能力，必须做等查询/等计算预算比较；也可做固定已收集证据的条件化诊断，但不能把它当主动策略的替代。

开发反馈必须遵守 `src/experiment/feedback.ts` 的安全视图。逐例标签、GO、目标 ID 和 Gold 不进入 updater；若未来需要更细反馈，先由 Host 建立新的安全接口和绑定。

### 工作段 D：机制干预、冻结和载体继承

对一条具体保留 heuristic 做有语义的干预：撤掉它、换回旧问法/解释，或替换关键原生响应。检查候选、semantic view、决策和分数是否按预期改变；不能用随机打乱制造分布外故障。若切断原生响应后不变，检查 LLM 先验、历史泄漏和证据路径。

所有 campaign 冻结、完成 promotion preview 并核对 exact preview hash 后，才开放 sealed evaluation。载体继承单独运行：清空会话、历史和临时状态，只加载冻结 carrier，在未参与选择的新对象上与 seed carrier 比较，报告受益和受损。测试标签不得反向修改 carrier。换 coordinator、换模型和未见组合测试列为后续工作，不作为本轮前置要求。

## 5. 统一证据链和记录格式

每一次保留的修改都必须能回放以下链条：

```text
真实失败与原生证据
→ 沟通假设
→ 具体 carrier/heuristic diff
→ 同条件下的实际行为变化
→ 支持案例与反例
→ 规则移除或响应干预
→ 清空历史后的新对象复用
```

记录至少绑定：集合和阶段、source commit、carrier hash/parent hash、raw artifact hash、derived view hash、trace hash、evaluator contract hash、condition/feedback policy、预算与成本。采用交接包中的 `research-note.md` 和 `communication-change.md` 字段；没有运行的内容写“未运行”，不得用模拟对话补齐。

主指标继续使用 operator 核定的 ontology-macro Fmax，并报告 aspect、AUPR/覆盖和按蛋白重采样的统计；分数不是概率，未记录功能不等于否定。质量和成本分开报告。测试集只在冻结后评估，当前交接包的 50 validation 对象不能重新命名为独立 test。

## 6. 给后续执行型 Codex 的工作包

执行助手按以下顺序工作，不得跳到大规模搜索：

1. **只读绑定：**读取交接主文件，确认实际 evaluator、数据划分、模型、资源和预算；输出缺失清单，不猜服务器路径。
2. **A 实现：**完成模型集合契约消歧、候选来源回归和同集合基线脚本；生成起点结果与案例。
3. **基线代码：**在新 baseline 中加入 communication contracts/carrier/adapters/executor/trace 及单元/回放测试；固定模式必须与旧路径等价，adaptive 必须 fail-closed。
4. **B 原型：**只用 capability manifest 中的真实 operation，运行 8–12 个开发对象，生成第一条完整证据链。
5. **C pilot：**由 Host 生成四份 condition manifest，复用现有 LatestRSI 和 feedback policy；保存所有尝试和失败。
6. **D 机制检查：**完成至少一项语义干预和一次 carrier-only 新对象继承；未完成前不开放 sealed test。
7. **验证与发布：**运行 TypeScript/Python/product tests、`test:rsi`、bootstrap plan、capability isolation/tamper、privacy/secret/result scans、composition/provenance 和 Git integrity；新增文件后由 Host 创建新的 operational release manifest，不能覆盖旧 release 或 G0 toolbox。

执行助手最后应按研究记录模板交付：真实结果表、支持案例和反例、carrier 前后差异、竞争解释、建议继续的一项工作和建议暂缓的一项工作。代码行数、文件数、agent 数和长篇 AI 文本不能替代这些证据。

## 7. 研究决策门槛

* 只有 max/权重提升：按读出方法记录，继续寻找不能由融合解释的失败。
* 规则改变行为但新对象不改善：判定为适应或过拟合，收紧条件，不宣称泛化。
* 丰富反馈有效但问法演化无增量：研究重点转向反馈组织。
* 额外查询解释全部提升：按主动信息获取报告，不称语义学习。
* 清空历史后收益消失：载体不完整，检查隐式上下文。
* 强 tool-use 同效：比较迁移、维护或成本；没有增量则收束主张。
* 只有“行为改变 + 有语义干预效果 + 新对象 carrier-only 复用”同时出现，才允许提出支持沟通载体学习的结果性主张。

本方案的近期交付不是重写论文，而是完成一条可检查的证据链。研究者确认 A 的真实输入和能力边界后，执行型 Codex 才进入 B；在用户检查并确认本方案前，不启动新的模型实验或 sealed evaluation。

## 8. 下一轮检查时需要确认的三个决策

1. **模型绑定：**A 段是先恢复交接包的三模型离线结果，还是先解决当前在线 ProTrek/三模型契约并运行在线基线。两者的结果表和 hash 必须分开。
2. **原生能力：**B 段是否只做离线 evidence organization，还是 operator 已能提供一个真实可调用、锁定版本的额外 BioLM operation。没有后者时，论文定位暂时停留在证据组织/工具使用。
3. **载体保存位置：**候选 carrier 在新 baseline 中放入明确的 `config/communication/` 绑定文件，还是由 Host 外部绑定后在 promotion 时生成 versioned baseline。无论选择哪一种，都必须让 candidate commit、carrier hash 和 trace hash 可共同复现。
