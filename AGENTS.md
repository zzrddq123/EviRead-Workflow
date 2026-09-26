# Pi R09 Function Prediction Agent + LatestRSI Guidelines

## Scope
This is an independent ICLR arm: immutable R09 method identity (`7ba7710...`), clean v1.4.0 executable runtime (`3302ba25...`), and the LatestRSI controller/P0-P1 layer. Do not import the dirty source filesystem, old Git refs, historical campaigns/results, legacy outer/CAFA command systems, or Bio-side mechanism-v3 work.

Large resources remain outside Git. Portable setup must be driven by committed locks/manifests; workstation paths are explicit local bindings, never portable evidence.

## Scientific integrity
- Never invent accessions, database IDs, GO terms, scores, citations, or tool results.
- Preserve anonymous/strict-blind inputs and quarantine query-like donor records.
- Historical R09 is retrospective human engineering, not a prospective RSI promotion or sealed scientific result.
- Gold, sealed data and evaluator-private outputs never enter the developer resource plane.

## RSI experiment boundary
- This repository uses LatestRSI autonomous Research/history/tree-search/branch/backtrack. Do not replace it with EarlyRSI.
- R09/v1.4 is only the generation-0 Agent baseline. Candidate code may improve the prediction method but cannot rewrite controller, instrumentation, tests, schemas, package/test commands, composition or governance state.
- Keep campaign/evaluator/runtime/worktree/capability state outside the repository.
- `src/experiment/`, `src/outer/`, `test/rsi/`, experiment/capability schemas and formal state are Host-owned.
- Precommit before development/acquisition; invalid candidates consume attempts and roll back; sealed evaluation stays closed until freeze.

## Resources and tool acquisition
- Shared neutral PDB/UniProt/AlphaFold/GO bytes are read-only and manifest-bound.
- The R09 starting toolbox is separately sealed. Other campaigns cannot browse it.
- New tools are allowed from G1 only through `capability-precommit` then Host `capability-acquire`; artifacts enter only this campaign's private toolbox.
- Never use candidate-controlled `curl | bash`, arbitrary installer commands, shared writable caches, or another campaign's history/tools.
- Chainsaw requires explicit restricted-license acceptance; Gold/private data cannot be acquired through this interface.

## Campaign promotion
Use `./pi-agent rsi autonomous-rsi-promote --worktree ...` preview first, then exact preview-hash apply. Never merge/cherry-pick/guess worktree HEAD. Promotion is ff-only from the verified/frozen selected candidate and remains separate from scientific claims.

Every successful acquisition must be classified for the retained candidate as required or unused. Unclassified acquisition blocks promotion. If any acquired capability is required, `--baseline-root` must identify a verified immutable versioned baseline binding the exact candidate commit/tree, common data, toolbox and required acquisition receipts. Never mutate an original G0 toolbox; a promoted baseline is a new versioned directory for an explicitly new experiment.

## Validation
Before delivery run TypeScript/Python/product tests, `test:rsi`, bootstrap plan, capability isolation/tamper tests, composition/provenance verification, secret/result scans and Git integrity checks. A real prediction/evaluator campaign requires separately provisioned frozen resources and data.

## Operator-selected data partitions
Production RSI requires a content-bound external train/validation/test manifest selected by the operator. Training Gold is explicitly permitted through the read-only `training_read` tool; this is the exception to generic Gold prohibitions above. Validation/test Gold remains evaluator-only; validation returns aggregate metrics and test runs only after the selected candidate is frozen. Never commit training labels or specialize code to particular benchmark proteins/categories. Prefer mechanistically justified changes with aggregate validation generalization. Preserve each arm's existing Early/Latest and starting-Agent boundaries.

## Current Codebase1 operator policy (2026-09-23)
- High-similarity and identical-sequence reference proteins remain eligible evidence. Never infer query identity or discard a donor from similarity, coverage, cosine score, or equal sequence hash. Explicit operator exclusions and invalid/negative annotation handling are separate from similarity.
- Current operational changes are bound by `config/codebase1-codex-rsi-release.json`. Historical R09 composition/provenance files remain immutable historical records, not an assertion that the current Codebase1 has identical source bytes. Default composition verification checks historical metadata plus the new full operational inventory; `--historical-only` is for reconstructing the original imported payload.
- Training-first RSI retains real training scores and may add evaluator-only validation feedback when the frozen baseline-proximity gate passes. Validation is not the end of development. Test stays frozen until final evaluation.
