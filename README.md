# EviRead-Workflow

Protein function prediction agent with an autonomous recursive self-improvement (RSI) loop, prepared for anonymous ICLR 2027 supplementary code release.

> **Anonymity note.** This repository is anonymized for double-blind review. It contains no author names, institutional affiliations, or machine-local absolute paths. Large biological data artifacts that would exceed the repository size limit are described in [`ANONYMOUS_DATA_RELEASE.md`](ANONYMOUS_DATA_RELEASE.md) and are hosted separately on an anonymous data archive.

## Overview

The repository contains:

- **Read/Agent runtime** — a BioLM evidence pipeline (`ESM2`, `ESMC`, `ProTrek`) that turns protein sequences into structured, hash-bound evidence, followed by a semantic GO reasoning agent and final GO selection/export.
- **LatestRSI controller** — a Git/program-level autonomous RSI controller with capability governance, persistent history/tree search, aggregate-only evaluation, rollback, freeze, and promotion.
- **Deterministic preprocessing** — evidence/ontology preprocessing and a deterministic contract baseline that is a component of the single pipeline (not an alternative predictor architecture).
- **Composition/provenance** — `CODEBASE_COMPOSITION.json` binds the agent runtime, the RSI controller, version governance, and capability inventories.

The repository exports the standard `target_id<TAB>go_id<TAB>score` prediction surface. The canonical benchmark, evaluator, Gold labels, ontology scoring, and final metrics live outside this repository and are owned by the evaluator trust domain.

## Repository layout

```text
src/            TypeScript orchestration, Read agent, RSI controller, experiment instrumentation
python/         BioLM evidence construction, embedding/retrieval, GO reasoning adapters, evaluator bridges
bootstrap/      Reproducible environment/toolchain provisioning (micromamba/conda locks)
config/         Environment templates and RSI/release manifests
docs/           Design and protocol documentation
schemas/        JSON schemas for RSI receipts, manifests, and publication contracts
scripts/        Evaluator-side and campaign-preparation scripts
test/           TypeScript and Python test suites
resources/      Small hash-bound artifacts (query embeddings and retrieval evidence)
```

Large resources (full Swiss-Prot references and the full BioLM evidence directory) are **not** committed here; see `ANONYMOUS_DATA_RELEASE.md`.

## Main commands

```bash
npm ci --ignore-scripts
npm test
npm run test:rsi
./pi-agent doctor --config config/local.example.env
./pi-agent predict --sequence query.fasta --config config/local.example.env
./pi-agent rsi help
```

The production RSI entry point is the complete Git/program-level controller:

```bash
./pi-agent rsi autonomous-rsi-production-start --profile /path/to/production-start-profile.json
```

## Benchmark bridge

The canonical GO submission and scoring contract lives in the external benchmark package, not in this repository. This repository provides a bridge that turns completed strict-blind run outputs into `target_id<TAB>go_id<TAB>score` group files and delegates scoring to the external evaluator.

```bash
./pi-agent z86-bridge prepare-inputs \
  --benchmark /path/to/benchmarks/z86-function-198-pair-clean-v2 \
  --output-root /tmp/z86-smoke-inputs \
  --groups group_4 \
  --limit-per-group 2
```

```bash
./pi-agent predict \
  --input-dir /tmp/z86-smoke-inputs/group_4/<target-id> \
  --run-name <target-id> \
  --config /path/to/host/configs/r09-g0.env
```

```bash
./pi-agent z86-bridge export \
  --benchmark /path/to/benchmarks/z86-function-198-pair-clean-v2 \
  --runs-root /path/to/target-bound-runs \
  --predictions /tmp/z86-predictions \
  --receipt /tmp/z86-predictions/export_receipt.json \
  --groups group_1,group_2,group_3,group_4 \
  --allow-missing
```

```bash
./pi-agent z86-bridge evaluate \
  --benchmark /path/to/benchmarks/z86-function-198-pair-clean-v2 \
  --private /path/to/benchmarks/z86-function-198-pair-clean-v2/private \
  --predictions /tmp/z86-predictions \
  --output /tmp/z86-evaluation.json \
  --track gold_v1
```

## Resource plane

Large databases/tools are not committed. See [`docs/ICLR_RESOURCE_POLICY.md`](docs/ICLR_RESOURCE_POLICY.md) and `ANONYMOUS_DATA_RELEASE.md`.

```text
../.iclr-host/common-data-v1                    shared neutral frozen data
../.iclr-host/common-toolchain-v1               pinned Python/BLAST/Foldseek runtime
../.iclr-host/frozen-g0-toolboxes/...           frozen starting toolboxes
../.iclr-host/campaigns/...                     campaign-private state/tools/cache
```

The local resource plane is provisioned and sealed. For direct prediction, set `PI_FUNCTION_RUNTIME_DIR` to the provisioned toolchain root and use the matching environment config. The launcher and evidence process re-resolve the managed CA bundle after relocation; `bootstrap` verification and `doctor` require a parseable bundle.

## Composition

- `CODEBASE_COMPOSITION.json` binds the agent, RSI/P0-P1, version governance, and capability inventories.
- `config/` holds environment templates and hash-bound release/manifest files.
- `CODEBASE_COMPOSITION.md` summarizes the composition contract.

## Reproducibility and data

- Small reproducible artifacts (query embeddings, retrieval evidence, and their hash-bound manifests) are committed under `resources/`.
- Large artifacts are listed with SHA-256 integrity hashes in [`ANONYMOUS_DATA_RELEASE.md`](ANONYMOUS_DATA_RELEASE.md) so reviewers can verify the anonymous archive.
