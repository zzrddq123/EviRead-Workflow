# RSI 轮次、冻结与验证集协议

## 统一术语

- G0：未接受本次 RSI 修改的 initial reader，先评估，再诊断。
- 一次有效更新：新候选完成冻结、所需软件检查和 train/validation 评估。分数退步的 rejected candidate 也计一次有效更新；“有效”不等于“被接受”。
- 一次尝试：规划、开发或验证失败也消耗预算，但不算完成的有效更新。
- 五次更新：G0 + 五个已完成评估的 child，共六次评估。若失败、平台期或预算导致提前停止，必须报告实际完成数，不能宣称已完成五轮。
- child 编号是评估顺序，不保证线性继承；parent 可以是历史已评估节点。

## 验证集何时打开

G0 先被冻结并评估训练集和验证集。随后每次：读取允许的训练诊断及验证聚合指标 → 诊断/必要的方法学 research → 提出假设和可证伪计划 → 修改 reader/workflow → 冻结候选 → 软件检查 → evaluator 对冻结候选评估 train 与 validation → 记录并选择。

开发中的 train-only probe 可以帮助调试，但须单独记账，不算完成更新；当前轻量 runner 不调度这种 probe。验证集不能成为开发工具的任意查询接口。候选通过检查后，host 按协议触发验证，而不是模型在编辑过程中随意反复查看。

训练指标用于诊断，验证指标用于选择；两者的反馈都会影响后续搜索，所以 validation 是自适应使用的开发资源，不是最终无偏测试。若 train/val 来自 GAF1389，全体 GAF1389 包含这两个子集，不能再把全体分数称为独立 held-out test。最终测试须另行指定未参与开发的样本。

## Git commit 与最终 freeze

完整 LatestRSI 的 Develop worker 从 exact parent commit 开始；host 检查编辑边界后创建 candidate commit。Verify/Evaluate 使用同一个 exact commit。该 commit 是“可评估候选快照”，不是“实验最终选定版本”，也不是自动合并主分支。终止搜索后再固定 selected candidate，生成 handoff；promotion 是独立操作。

候选失败、退步和被拒绝的记录不能删除。Git commit 存在不代表评估成功。完整控制器的具体失败重试/停止行为由封存预算决定，不承诺自动补足 N 次。

## 两个入口的实际语义

### 完整 program-level LatestRSI

入口：`./pi-agent rsi autonomous-rsi-production-start --profile ...`。

普通 profile 中 `maxIterations` 是**含 G0 的总评估上限**；五个 child 设置 6，不是 5。平台期可以提前停止。绑定 experiment manifest 时另有 `targetValidUpdates` 和 `maxPatchAttempts`，不可与普通上限混淆。此入口支持 Git 候选、代码修改、历史树及软件验证。其 host-owned controller 本轮未修改。

### Legacy policy runner removed

历史 Python policy runner 只能冻结 policy 并调用外部 evaluator，不能创建 Git candidate、运行完整 Verify/Develop/Promotion，也不能代表正式 LatestRSI。它已经从 active tree 删除并归档；任何正式实验都必须使用上面的 `pi-agent rsi autonomous-rsi-production-start` 入口。

## Baseline reference for the complete controller

The full autonomous controller accepts an optional `comparisonReference` field in the sealed spec. It is aggregate-only and is copied into every readable history context, so Diagnose/Research/Plan can see the train/validation baseline landscape and the declared target without accessing target-level predictions or labels. Generate it from the subset results with:

```bash
PYTHONPATH=python python3 python/build_baseline_reference.py \
  --results /path/FunctionBench-Bio-GAF1389/Baseline_Subset_Results \
  --train-manifest /path/train.manifest.json \
  --validation-manifest /path/validation.manifest.json \
  --output /outside/comparison-reference.json
```

Copy the resulting object into the sealed autonomous spec as `comparisonReference`. Its `sourceManifestHash` binds the reference to the validation manifest. The target is the strongest non-diagnostic baseline; oracle rows remain context only. A later candidate is successful scientifically only when it exceeds the target, while normal promotion still compares candidates to their incumbent.

## 历史经验：现状，不在本轮修改

完整 LatestRSI 保存候选图、阶段产物、评价、反思和 knowledge；persistent history 会提供历史上下文，reset/shuffled 对照不等价。轻量 Python runner 保存所有轮次文件，但 planner 目前主要接收 incumbent 的 policy/result，而非完整历史。保存记录不等于已让模型充分使用记录。

后续可以增加“有证据支持的机会/下一步假设”视图来提供正向经验，但不能删除退步事实或把失败改写成成功。本轮只明确计数与冻结，不改经验生成策略。
