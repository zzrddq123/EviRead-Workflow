# 精简功能预测开发方法（RSI develop）

## 事实边界
`FunctionBench-Bio-GAF1389` 是否包含全部 Swiss-Prot 及其冻结证据，不能仅凭目录名确认；必须以数据 manifest、UniProt release 和 SHA-256 核对。本仓库的 `t0-swissprot-full` 明确绑定的是 Swiss-Prot 2025_03 的 573,661 条 reviewed 记录和 2025-09-04 冻结的 GOA 关联（见 `docs/EVIDENCE_PROFILES.md`），因此不能把另一个路径默认等同于它。GO 关联携带 evidence code：EXP/IDA/IMP 等是实验或直接研究支持；IEA 是电子/计算推断；ISS/ISO 等是序列/同源推断；TAS/IC 是人工整理但不等于实验。`NOT` 注释只作为负约束，不能转成正例。

## 三步流程
1. **检索**：只运行配置选择的 BioLM（默认 ESM2）；按验证集 macro-Fmax/AUPR 选择，不要求所有模型都运行。模型共享参考注释，不视为独立证据。
2. **证据融合**：对每个 Swiss-Prot donor 的 GO annotation 读取 evidence code；实验/直接证据权重 1.0，TAS 0.9，IC 0.85，同源/计算证据 0.65，NAS/ND/IEA 分别 0.45/0.35/0.35。相同 GO 的支持按 `cosine × evidence_weight` 累加；负约束永不产生正分。权重是候选排序先验，不是概率，需在 OOF 验证中校准。
3. **输出**：只保留候选生成、ontology closure 和校验；不把长历史、重复模型上下文传给 develop。保留 hash、release、evidence code 和 donor provenance，保证可审计。

## 模型选择规则
每个模型先单独作为 baseline；只有在同一 split、同一参考库、无 query-like 泄漏下，验证指标超过当前 baseline 且没有其他 GO aspect 回退时才启用。Benchmark 的冻结历史结果显示，BioLM 三者中 ProTrek（macro-Fmax 0.4056）高于 ESM2（0.3322）和 ESMC（0.2864），因此默认使用 ProTrek；ESMC/ESM2 通过 `config/biolm_policy.json` 的 `models` 和 `model_weights` 显式加入，权重由 OOF 验证指标确定，而不是预先假定“模型越多越好”。

## RSI develop contract
开发循环只提交一个可证伪变化：`select model → evidence-weighted retrieval → validate → retain/revert`。训练/验证可用于开发；测试保持冻结。资源 release/hash 必须随 artifact 记录，不能在线混用当前 UniProt 数据。
