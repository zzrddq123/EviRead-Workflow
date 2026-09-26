# CodeBase1: ESM2 + ESMC + ProTrek EviRead agent

CodeBase1 is the first experimental codebase. It is a strict BioLM-only resource plane. CodeBase2 will later add conventional sequence/structure tools and a separate augmented RSI campaign.

## Machine-local GPU binding

On the current workstation, real ESM2/ESMC/ProTrek inference is executed through a local GPU deployment helper. The non-portable deployment helper is kept at a machine-local host path. It uses pinned environments and model files under a remote model directory. The portable CodeBase1 contract remains the `biolm-evidence.v1` boundary; the machine binding is deliberately kept outside the repository.

## Allowed channels

- ESM2
- ESMC
- ProTrek

## Forbidden channels

- BLAST/BLASTP
- Foldseek
- InterPro, Pfam, PANTHER, EC mappings
- OMA/OMA FastMap
- DeepGOPlus
- mDeepFRI
- any other sequence or structure search provider

The `EVIREAD_PROFILE=model_only` gate is fail-closed. It requires a `biolm-evidence.v1` artifact, requires all three model names, rejects non-BioLM providers, and never calls the inherited evidence runner.

## Model output contract

Each model worker returns observations containing:

- model name;
- input sequence/structure hash;
- observation scope (`whole_protein`, `sequence_crop`, or `structure_crop`);
- embedding metadata and optional vector hash;
- retrieved donor observations or model hypotheses;
- GO candidate rows and provenance;
- runtime/device/model revision receipt.

The first Read compiler turns these numeric/model outputs into two synchronized views:

1. a structured candidate/evidence view used by host-side GO inference;
2. deterministic text evidence used by the function agent.

The text explicitly distinguishes similarity support from calibrated probability and reports limitations such as correlated donor annotations.

## Execution

```bash
./pi-agent predict \
  --sequence query.fasta \
  --biolm-evidence biolm-evidence.v1.json \
  --config config/model_only.env \
  --genome genomes/codebase1-model-only.json \
  --narrative-mode deterministic
```

A structure may be supplied as an input to a BioLM structure-aware worker, but CodeBase1 does not run Foldseek or any structure search tool.

## RSI surface

RSI may optimize:

- how the three model channels are normalized and grouped;
- whole-protein versus domain/crop observation requests;
- model agreement and disagreement summaries;
- donor/provenance deduplication;
- candidate budget and aspect allocation;
- evidence-to-text serialization;
- GO support/reject/abstain reasoning and evidence citation.

RSI may not add tools, change private Gold access, alter the evaluator, silently change model weights, or introduce an unregistered model channel. Every model-only candidate must remain reproducible from its model/input/resource receipts.
