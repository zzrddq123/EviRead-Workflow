# Codebase composition: R09 Agent + LatestRSI

## Frozen Agent identity

- Human method identity: `human/revision/v0005/r09`, commit `7ba7710c9c99acb33b184d93307dd7ac79c81e19`, tree `1b7ff5656ff9b8d14f3b1f8597c22787893a3156`.
- Executable product runtime: `v1.4.0`, commit `3302ba25cc80f2a987668c31ea597eb6ff1dc0a8`, tree `844fcb516b570bed506aeb21efbc2ca15c72b452`.
- Genome: `genomes/human-v0005-mainline-semantic-reasoner-r9.json`, SHA-256 `ea8aa7cc5f90fadeda114ac311402fa982854511432446c543b38e16c7ed240a`.
- Every imported matching v1.4 file is listed in `config/r09-v140-source-provenance.json`. Sources came from committed Git objects, not the dirty source worktree.

R09 is retrospective human-directed engineering. This identity does not import or assert any historical score, prospective selection or sealed result.

## LatestRSI controller

The autonomous controller, P0/P1 instrumentation and formal version implementation are copied from ICLR LatestRSI. The only baseline adapter is `src/outer/autonomous/production_init.ts`, which selects `config/autonomous-rsi-r09-v140-baseline.json` instead of the early d24a111 baseline.

The fresh repository has no inherited tags, candidates, campaign graph, formal events or evaluation history.

## Capability governance

The three ICLR repositories share the same capability-governance implementation and schemas. Common neutral data is external/read-only; starting tools are baseline-specific; acquired artifacts are precommitted and campaign-private. The Host CAS is an invisible storage optimization, never a candidate-facing catalog.

The parent `.iclr-host` plane is now provisioned from allowlisted original-product resources using APFS copy-on-write. Common/R09 manifests, tool entrypoints, prediction canaries, evaluator sandbox and campaign preparation have been verified; a real scientific campaign still requires an explicit task/development-set request.

## Exclusions

Not inherited:

- source `.git`, tags or branches;
- historical RSI candidates/campaigns/formal events;
- benchmark cohorts, Gold, private evaluator data, predictions, reports or scores;
- old CAFA/outer/optimization command systems;
- current dirty source worktree changes;
- Bio-side mechanism-v3 work.

Two old genomes exist only under `test/fixtures/genomes/` to exercise unchanged v1.4 validation tests. They are protected test fixtures, not operational starting candidates or visible-tool manifests.

`CODEBASE_COMPOSITION.json` is the machine-readable receipt. `python3 scripts/verify_iclr_composition.py` verifies provenance, canonical hashes, current inventories, exclusions and empty inherited tag state.

## P3 capability-closed baseline addendum

A reusable campaign baseline is the exact code commit/tree plus common-data manifest, starting-toolbox manifest, and required acquired-capability closure. Every successful acquisition is classified exactly once for the retained candidate. Unclassified acquisitions block promotion; required acquisitions require a separately materialized and verified immutable versioned baseline passed to promotion with `--baseline-root`. Original G0 toolboxes never update. New campaigns bind the exact baseline manifest/hash and reject repository, toolbox, common-data or artifact drift. This governance is byte-identical across all three codebases and does not change their loop semantics.
