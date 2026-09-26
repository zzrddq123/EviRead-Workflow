# CodeBase1 RSI

## Canonical entry point

The only production RSI entry point for this repository is the complete Git/program-level LatestRSI controller:

```bash
./pi-agent rsi autonomous-rsi-production-start --profile /absolute/production-start-profile.json
```

Do **not** use the historical `semantic_rsi_supervisor.py`, `rsi_supervisor.py`, or `python/codebase1_rsi.py` as the production controller. These legacy policy runners have been removed from the active repository and archived outside it under `eviread-rsi-gaf1389_50x60/archive/legacy-policy-sweeps/`. They are not part of the formal RSI release.

See [RSI_ROUND_PROTOCOL.md](RSI_ROUND_PROTOCOL.md) for the authoritative distinction between candidate freeze, completed update, and selected-reader freeze. The complete controller's `maxIterations` includes G0. It owns the candidate graph, exact Git commits/worktrees, Diagnose/Research/Plan/Develop/Verify/Evaluate stages, aggregate-only evaluator boundary, history, rollback/backtrack, and final freeze/promotion.

CodeBase1's RSI objective is to optimize **how the agent reads and uses ESM2/ESMC/ProTrek evidence**, not to change biological-model weights. Model identity, weights, input hashes, ontology and evaluator remain fixed. Candidate edits target Read policy, observation scope/crops, model agreement, provenance grouping, evidence text, candidate budgets, and GO abstention rules.

## Dataset manifest

Use an external, content-bound manifest (do not commit Gold):

```json
{
  "schema": "eviread-rsi-dataset.v1",
  "split": "development",
  "proteins": [
    {"protein_id": "anonymous-1", "sequence": "/sealed/anonymous-1.fasta", "biolm_evidence": "/sealed/anonymous-1.json"}
  ]
}
```

Training and validation IDs must be disjoint. Validation results must be aggregate-only. The evaluator command is responsible for accessing permitted training/validation labels in its trust domain; candidates receive only the numeric objective and bounded diagnostics.

## Start a campaign

Use only the complete controller:

```bash
./pi-agent rsi autonomous-rsi-production-start \
  --profile /outside/production-start-profile.json
```

The profile must bind the sealed train/validation manifest, evaluator command and hash, research command, campaign run root, model identity, metric, and hard iteration budget. Do not use an ad-hoc Python policy command.

When `--baseline-results` is supplied, the runner creates a hash-bound `baseline_reference.json` containing aggregate metrics only. The reference is visible to the planner and evaluator through `EVIREAD_RSI_BASELINE_REFERENCE`; it contains no target-level labels, accessions, or prediction rows. The default optimization target is the strongest non-oracle baseline on the declared split. Oracle rows remain diagnostic and cannot become the promotion target. Each round records the candidate's gap to and whether it exceeds that target.

The reference includes both `train_50` and `val_60` metrics by default; `--baseline-split` selects the validation target while `--baseline-context-splits` controls the context visible to the planner. The evaluator receives:

```text
EVIREAD_RSI_REQUEST=/outside/campaigns/.../round-000-request.json
EVIREAD_RSI_POLICY=/outside/campaigns/.../round-000-read-policy.json
```

It must return JSON containing both finite [0,1] `train_macro_fmax` and `validation_macro_fmax`. Selection uses only the latter; training results support diagnosis. The runner records every round, parent policy, policy hash, score, acceptance decision, incumbent, baseline target, baseline gap, and baseline-beaten status in the campaign directory. `--require-baseline-beat` can make campaign completion fail unless the selected incumbent exceeds the declared comparison target.

This runner is the campaign orchestration boundary. A production evaluator must invoke CodeBase1's model-only `predict` for every manifest protein and must use a separately protected label/evaluator domain. It must never pass private labels or accession mappings into the candidate process.

## User-defined tasks and splits

A campaign does not hard-code a benchmark or a 50/50 split. The operator supplies a content-bound `pi-rsi-data-split-manifest.v1` with the selected train/validation proteins, file hashes, and Gold access policy. For this experiment the selected manifests must bind exactly:

```text
/path/to/FunctionBench-Bio-GAF1389/train_50
/path/to/FunctionBench-Bio-GAF1389/val_60
```

The production entry point validates the manifest, seals its hash into the campaign spec, and refuses a changed split. Training Gold is available only through the controller's read-only `training_read` resource; validation Gold remains evaluator-only. No Python campaign runner is used.

## Full RSI contract

The controller is deliberately layered:

1. **Task layer**: user-supplied dataset, selections, objective, seed, and resource manifest. `rsi_prepare.py` creates anonymous locked manifests.
2. **Evidence layer**: a declared BioLM/tool resource produces hash-bound evidence artifacts. Cached and online acquisition are interchangeable if the artifact schema and receipt match.
3. **Read/Agent layer**: an evaluator or prediction command converts evidence to bounded text/structured observations and performs GO reasoning. A planner may change rendering, prompts, thresholds, fusion, abstention, or workflow routing.
4. **Diagnosis layer**: training labels may produce detailed FP/FN and failure-mode feedback; RSI development evaluates training only; validation runs after candidate freeze and returns only aggregate metrics and permitted diagnostics.
5. **Improvement layer**: optional research command, LLM planner, candidate policy/code generation, evaluator execution, and promotion.
6. **Lineage layer**: every round stores task/resource hashes, parent version, policy/planner/research hashes, outputs, score, and accept/reject decision.

The planner is an external command by design so the framework can use a local or hosted language model without hard-coding a provider. It must return `planner.v1` with a candidate policy; a production planner can additionally emit a bounded patch/workflow plan consumed by the evaluator. No planner, research command, or candidate may read private labels or change the evaluator.

`python/read_agent.py` is the batch Read boundary. It accepts anonymous manifests plus one `biolm-evidence.v1` artifact per protein. With `--agent-command`, each request is sent to a local/hosted language-model adapter through `EVIREAD_AGENT_REQUEST`; the adapter must return `agent-prediction.v1` with GO IDs, bounded scores, decisions, evidence citations, and rationale. Without that command it runs an explicitly labelled deterministic contract baseline. The included `python/pi_agent_adapter.py` is a provider-neutral Pi adapter for real reasoning (`--agent-command 'python3 python/pi_agent_adapter.py'`). The included `python/pi_rsi_planner.py` is the corresponding Pi outer-planner adapter (`--planner-command 'python3 python/pi_rsi_planner.py'`). They run with tools disabled and no session persistence; provider readiness/API credentials remain an environment concern. Thus the same RSI controller can optimize a real language-agent Read, a policy, or a workflow, while the evaluator remains the only label owner.

## Research-augmented RSI

A research stage can be enabled with `--research-command`. After each incumbent evaluation, the runner sends the command only a sanitized aggregate diagnosis, the current Read policy, and an allowed research scope. The command may query approved literature/web sources and must return:

```json
{"schema":"eviread-rsi-research.v1", "sources":[...], "insights":[...], "limitations":[...]}
```

A planner can then be enabled with `--planner-command`. It receives the aggregate feedback and research receipt, and returns:

```json
{"schema":"eviread-rsi-planner.v1", "hypothesis":"...", "patch":"...", "policy":{...}}
```

The candidate is evaluated on the fixed train/validation protocol and promoted only when the declared aggregate objective improves. Research is advisory evidence, not permission to access Gold or alter the evaluator. Every research receipt, planner output, policy hash, parent version, and promotion decision is saved. This makes external scientific knowledge an explicit RSI input while preserving the blind validation boundary.
