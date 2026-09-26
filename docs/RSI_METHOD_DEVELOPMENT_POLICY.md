# RSI method development policy

When training `ontology_macro:Fmax` is far below the strongest comparable
baseline, the RSI loop must optimize for closing the gap quickly. The
configured minimum improvement is a falsification threshold for accepting a
candidate, not the development target.

In this regime, diagnose and test foundational, globally applicable changes to
how the pipeline uses information: BioLM representation integration, evidence
construction, candidate generation and breadth, candidate filtering, evidence
fusion, ranking, calibration, and ontology-aware decoding. Prefer a small
number of mechanism-based changes with material expected aggregate impact over
local threshold tweaks. Keep the model-only BioLM and semantic GO Agent
contract, avoid protein-, accession-, and GO-category-specific rules, and use
aggregate training Fmax to decide whether a change is useful.

Once training performance is near the strongest baseline, shift to smaller
controlled improvements and apply the training gate before spending time on
validation. Validation remains feedback for generalization and never becomes a
terminal event by itself.
