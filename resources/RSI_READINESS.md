# GAF1389 RSI readiness

- Query embeddings: `query-embeddings-1389-*.npy`, 1389 rows per model.
- Retrieval: `retrieval-1389/*.json`, top-20 per model/query.
- Materialized evidence: `biolm-evidence-gaf1389-full/*.json`, 1389 artifacts.
- Every 60-donor set (20/model/query) has resolved Swiss-Prot donor context; no unresolved donors in the materialization audit.
- The official evaluator bridge uses this evidence root by default when `EVIREAD_FORMAL_EVIDENCE_ROOT` is unset.
- Validation Gold remains evaluator-only; these artifacts contain no validation labels.

The donor `.npy` index remains in the benchmark resource plane and is hash-bound by `full-swissprot-index-manifest.json`; it is not duplicated in this repository.
