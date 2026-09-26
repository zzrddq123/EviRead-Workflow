# ICLR RSI experiment instrumentation

This repository separates three concerns:

1. the strict-blind GO prediction candidate;
2. the native RSI loop (Latest autonomous or Early cumulative);
3. a loop-neutral, hash-bound experiment layer under `src/experiment/`.

The experiment layer does not select biological methods. It makes campaign identity, pre-action hypotheses, evaluations, resource usage, failure recovery and sealing auditable.

## Round counting

A ten-update campaign means:

```text
G0      initial candidate evaluation
G1–G10  ten verified and development-evaluated child candidates
```

Therefore `targetValidUpdates=10` and at least 11 candidate evaluations are needed. Failed verification attempts are recorded, rolled back and retried; they consume `maxPatchAttempts`, not `targetValidUpdates`.

## Immutable records

A campaign-local `experiment/` directory contains:

- `manifest.json`: condition, replicate/block, framework, feedback/history policy, hashes and budgets;
- `records/precommit/`: diagnosis, change family/targets, predicted effects, controls/falsifiers and rollback condition, written before development;
- `records/evaluation/`: candidate/commit/diff binding, primary or canonical 16 metrics, slices and decisions;
- `records/resource/`: stage timing, retries/failures and available token/call/cost telemetry;
- `freeze.json`: final candidate selected by the development-only rule while sealed evaluation remains unopened;
- `index.json`: append-only hash chain over every record.

`experiment-verify` rejects an evaluated child with no earlier precommit and rejects sealed records before campaign freeze.

## Feedback conditions

The private evaluator result is rendered into one of two developer views:

- `metric_only`: aggregate objective/metrics only;
- `structured_diagnostic`: the same aggregate metrics plus sanitized mechanism-level diagnosis.

Both views bind the same private evaluation hash. Target identities, accessions, GO answers, sequences, per-target errors and evaluator-private paths are forbidden in developer-visible feedback.

## History conditions

LatestRSI supports:

- `reset`: current code/current feedback, with no prior episodes, failures or knowledge cards;
- `persistent`: the native complete candidate/history/knowledge context;
- `shuffled`: a DLP-checked, hash-bound matched history artifact imported before the first stage.

EarlyRSI is restricted to `native_linear`; it does not gain Latest research, tree search, arbitrary historical-base selection or full persistent history.

## Five-cell design

`experiment-batch-plan` generates:

1. Latest metric/reset;
2. Latest structured/reset;
3. Latest metric/persistent;
4. Latest structured/persistent (also the Latest native framework arm);
5. Early native.

The four Latest cells estimate feedback, history and interaction while loop topology is fixed. The two native arms estimate the whole-framework difference. These are separate estimands.

## Typical workflow

```bash
# Replace every placeholder first.
./pi-agent rsi experiment-manifest-seal \
  --input examples/experiment-manifest.template.json \
  --output /outside/repo/manifest.json

# Bind the sealed manifest into a loop spec.
./pi-agent rsi experiment-spec-bind \
  --spec /outside/repo/spec.draft.json \
  --manifest /outside/repo/manifest.json \
  --output /outside/repo/spec.sealed.json

# The loop init command automatically initializes campaign/experiment when
# the spec contains `experiment`.
./pi-agent rsi experiment-verify --campaign-dir /outside/repo/campaign
./pi-agent rsi experiment-export \
  --campaign-dir /outside/repo/campaign \
  --output /outside/repo/campaign-export.json
```

For Latest production initialization, the same manifest can be supplied with `--experiment-manifest`. A shuffled condition must additionally run `experiment-history-import` before the first stage.

## Pilot and confirmatory boundary

Pilot manifests may use `metricsCompleteness=primary_only` and may freeze short canaries. Confirmatory manifests require a non-null sealed-data commitment, the full `targetValidUpdates`, and a bound `canonical_16` development evaluation before freeze.

All campaign final candidates must be frozen before any sealed evaluator is opened. Archived checkpoint replay is post-freeze analysis and cannot change candidate selection.

## Candidate trust boundary

The stable host/controller owns experiment records and evaluator access. Candidate worktrees may change only allowlisted prediction implementation files. They may not modify `src/outer`, `src/experiment`, RSI tests, experiment schemas, package/test commands, formal version state or evaluator assets.
