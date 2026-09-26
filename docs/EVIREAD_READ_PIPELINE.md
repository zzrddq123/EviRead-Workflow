# EviRead Read pipeline (model-only G0)

This document is the executable contract for the first EviRead reader. The RSI controller remains the inherited LatestRSI framework; this change adds a bounded Read interface and a BioLM evidence adapter.

## End-to-end flow

```text
1. Input: one protein FASTA and optional sequence-matched structure.
2. Redaction: create anonymous staged inputs and discard identity metadata.
3. BioLM observation:
   - use an existing verified `biolm-evidence.v1` artifact, or
   - ask the GPU worker for ESM2/ESMC/ProTrek observations.
   - observations may be whole-protein, sequence-crop, or structure-crop.
4. Read compiler:
   - validate model/schema/input hashes;
   - retain model, scope, input range, pooling, retrieval, donor support,
     GO hypotheses, provenance, and limitations;
   - render deterministic agent-readable text in `evidence/eviread_read.txt`;
   - attach candidates as `biolm_retrieval` evidence records.
5. Function prediction agent:
   - receives the blind evidence view and the rendered evidence interface;
   - treats GO rows as hypotheses, not calibrated probabilities;
   - performs support/reject/abstain reasoning and ontology-aware GO handling.
6. Host exporter:
   - validates evidence citations and GO IDs;
   - applies the existing GO inference/closure/export contract;
   - emits the standard prediction artifacts and `go_predictions.tsv`.
7. RSI:
   - evaluates the reusable reader on development feedback;
   - may revise only the declared reader/agent surface;
   - records parent, patch, hypothesis, validation, cost, and promotion.
```

## BioLM artifact contract

The first reader consumes JSON with:

```json
{
  "schema": "biolm-evidence.v1",
  "sequence_sha256": "...",
  "models": [
    {
      "model": "esm2",
      "observation_scope": "whole_protein",
      "neighbors": [{"id": "opaque-donor", "cosine": 0.81}],
      "predictions": [{"go_id": "GO:0000000", "aspect": "MF", "score": 0.42}]
    }
  ],
  "candidates": [{
    "go_id": "GO:0000000",
    "aspect": "MF",
    "score": 0.42,
    "source_id": "esm2",
    "evidence_id": "...",
    "provenance_root": "..."
  }],
  "limitations": ["Similarity is not calibrated probability."]
}
```

The model worker may use a GPU and may request a new observation for a declared domain/crop. The reader does not assume that every target has one precomputed whole-protein embedding. Each observation is bound to its input sequence/structure hash and scope.

## Run with a verified artifact

From this repository:

```bash
./pi-agent predict \
  --sequence /path/query.fasta \
  --structure /path/query.pdb \
  --biolm-evidence /path/biolm-evidence.json \
  --config /path/managed.env \
  --narrative-mode deterministic \
  --run-dir /path/runs/eviread-g0-query
```

The run writes:

```text
runs/eviread-g0-query/evidence/eviread_read.json
runs/eviread-g0-query/evidence/eviread_read.txt
runs/eviread-g0-query/evidence/evidence_bundle.json
runs/eviread-g0-query/prediction/go_predictions.tsv
```

The `--biolm-evidence` option is intentionally an artifact boundary. A GPU worker can produce the artifact online, or a previously verified cache can supply it. Changing the model, crop, pooling, retrieval policy, or donor index requires a new artifact and a new resource receipt.

## First RSI edit surface

The initial G0 reader exposes these candidate changes:

- evidence-record filtering and grouping;
- model-agreement and shared-provenance rendering;
- crop/domain observation requests when the capability is pre-registered;
- candidate retention and per-aspect organization;
- deterministic evidence serialization;
- downstream GO support/reject/abstain policy.

The following remain protected:

- RSI controller and experiment instrumentation;
- evaluator and private Gold;
- GO ontology and T0 resource bytes;
- model weights and unregistered model channels;
- target accession mapping;
- output schema and provenance checks.
