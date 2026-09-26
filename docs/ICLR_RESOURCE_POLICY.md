# ICLR shared data and private tool governance

## Purpose

Keep neutral public data identical while preventing one RSI campaign from learning that another campaign installed or used a method tool.

## Three planes

1. **Common data** — a sealed, read-only PDB/PDB100, UniProt/Swiss-Prot, AlphaFold/Swiss-Prot and GO snapshot. It is physically shared and identified by `COMMON_DATA_MANIFEST.json`.
2. **Starting toolbox** — tools visible before G1. The two early-Agent repositories use the same manifest; the R09 repository may list only capabilities already present in its frozen R09/v1.4 baseline.
3. **Acquired toolbox** — append-only, campaign-private tools independently requested from G1 onward. Other campaigns must not receive its path, name, logs, prompt context or `PATH` entry.

A manifest hash is a canonical SHA-256 inventory fingerprint. It identifies bytes; it is not encryption or an access-control mechanism.

## Host layout

```text
.iclr-host/
  common-data-v1/        sealed neutral data
  common-toolchain-v1/   pinned Python/BLAST/Foldseek runtime
  frozen-g0-toolboxes/   immutable Early/R09 factory toolboxes
  cas/sha256/            Host-only immutable deduplication store
  campaigns/<experiment>/<replicate>/<arm>--<campaign>/
    capability-view/     only resources authorized for this campaign
    private-tools/       immutable acquired artifacts
    dependency-env/      campaign-private dependency environment
    development-inputs/  opaque public FASTA/PDB inputs
    cache/ home/ tmp/ receipts/
  evaluators/            private Gold and Host-only evaluation receipts
```

The candidate sandbox receives explicit paths for common data, its frozen G0 toolbox and its own acquired toolbox. It must not be able to enumerate `.iclr-host/cas`, another frozen toolbox, another campaign or evaluator-private Gold. Frozen G0 toolboxes never update in place; campaign acquisitions remain in their leaf.

## Acquisition order

```text
Agent independently chooses a tool
→ immutable ToolAcquisitionPrecommit
→ Host validates HTTPS source, budget and optional expected hash
→ Host downloads into private staging
→ content hash and size are checked
→ Host CAS stores one immutable copy
→ a copy-on-write private artifact is published to this campaign
→ ToolAcquisitionReceipt is appended
→ Verify/Evaluate
```

`capability-acquire` deliberately downloads a direct immutable artifact and never executes a remote installer or `curl | bash`. Archive extraction and dependency installation require a separately frozen Host recipe; they may not be chosen as arbitrary shell text by candidate code. Restricted-license tools require explicit operator acceptance before their Host recipe is enabled.

## Commands

```bash
./pi-agent rsi capability-manifest-seal --kind common-data --input draft.json --output COMMON_DATA_MANIFEST.json
./pi-agent rsi capability-manifest-seal --kind starting-toolbox --input draft.json --output STARTING_TOOLBOX_MANIFEST.json
./pi-agent rsi capability-init --campaign-root /absolute/campaign/capabilities --campaign-id ID --common-data COMMON.json --starting-toolbox TOOLBOX.json
./pi-agent rsi capability-precommit --campaign-root /absolute/campaign/capabilities --request request.json
./pi-agent rsi capability-acquire --campaign-root /absolute/campaign/capabilities --host-cas /absolute/.iclr-host/cas --precommit HASH
./pi-agent rsi capability-verify --campaign-root /absolute/campaign/capabilities
```

After `capability-init`, bind the private campaign to the production worker before `*-rsi-production-start`:

```bash
export PI_ICLR_CAPABILITY_CAMPAIGN_ROOT=/absolute/.iclr-host/campaigns/<campaign-id>
export PI_ICLR_HOST_CAS=/absolute/.iclr-host/cas
```

The production worker inherits these only for Develop and exposes the narrow `request_tool_acquisition` model tool. The Agent supplies the independent tool/purpose/HTTPS source/hash/byte cap; the Host callback precommits and acquires it without exposing a shell or CAS path. Verify/Evaluate receive only `PI_ICLR_PRIVATE_TOOL_ROOT` for that campaign. If the two Host variables are absent, acquisition is fail-closed/unavailable; if only one is set, the worker rejects the run.

For the local provisioned Host plane, direct prediction additionally binds:

```bash
export PI_FUNCTION_RUNTIME_DIR=/path/to/.iclr-host/common-toolchain-v1
```

A compact task/development-set request can prepare or start the correct native loop through `.iclr-host/bin/campaign_launcher.py`; see `.iclr-host/CAMPAIGN_LAUNCH_REQUEST.template.json`. The launcher freezes opaque public inputs, keeps Gold in `.iclr-host/evaluators`, disables cross-campaign published history, binds the correct G0 toolbox, and evaluates candidates under a macOS file sandbox with aggregate-only feedback.

The experiment's `toolConfigHash` must bind the sealed starting-toolbox manifest. The common-data manifest hash belongs in the frozen runtime/resource configuration receipt. A campaign is not confirmatory-ready until these exact bindings and the OS/Host sandbox attestation are present.

## Invariants

- Acquisition is enabled from update G1; failures consume attempt budget.
- A receipt is invalid without an earlier same-campaign precommit.
- CAS paths never appear in candidate-facing receipts.
- Published artifacts are read-only and re-hashed by `capability-verify`.
- Shared data cannot be mutated during a campaign.
- Candidate package/test scripts, controllers, instrumentation and evaluator assets remain protected.
- Package/Python dependency acquisition must use a Host recipe that changes only declared dependencies/locks; test scripts and governance files remain immutable.
- Gold, sealed data and evaluator-private artifacts never enter this resource plane.

## Capability-closed promotion

A Git commit alone is not a reusable RSI baseline. A reusable baseline binds the exact candidate commit/tree, common-data manifest, starting-toolbox manifest, and required acquired-capability closure.

Every successfully acquired artifact must be classified exactly once for the retained candidate by a canonical `pi-rsi-candidate-capability-usage.v1` record as either `required` or `unused`, with evidence hashes. Acquired-but-unclassified is unresolved and blocks promotion. Acquired-but-unused does not enter the next toolbox.

Code-only promotion is allowed only when the retained candidate has no required acquired capability. If one or more acquired capabilities are required, the Host must first materialize and verify a new immutable versioned baseline containing only the required artifacts. The original G0 toolbox is never modified. Promotion preview and apply bind the exact versioned-baseline hash and fail closed on missing, mismatched, or tampered artifacts.

```bash
./pi-agent rsi capability-usage-seal --campaign-root DIR --draft DRAFT.json
./pi-agent rsi baseline-materialize --campaign-root DIR --usage USAGE.json --draft DRAFT.json --output-root NEW_BASELINE_DIR
./pi-agent rsi baseline-verify --baseline-root NEW_BASELINE_DIR
```

A new campaign must bind one baseline manifest whose code commit/tree, common data and starting toolbox agree. It must not infer code from current `main` while independently falling back to an old default toolbox. Matched replicates continue to bind the same original G0 baseline; a promoted baseline is used only for an explicitly new experiment.
