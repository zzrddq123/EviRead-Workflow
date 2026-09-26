# Anonymous data release

This file lists the large biological data artifacts that are intentionally **not** committed to this repository because they would push the repository beyond the 100 MB supplementary-material size limit. They are hosted on a separate anonymous data archive (e.g., an anonymous Zenodo/OSF/OpenReview record). Reviewers can verify every downloaded byte against the SHA-256 values below.

No author names, affiliations, or machine-local paths are present in this listing.

## How to use this listing

1. Download each artifact from the anonymous archive URL referenced in the paper/appendix.
2. Verify the SHA-256 (and, where applicable, the aggregate directory hash).
3. Place the artifacts at the locations expected by the code (see `resources/*.manifest.json` and the `ANONYMOUS_DATA_RELEASE.md` notes below).

## Artifacts

### 1. Full BioLM evidence directory

- Path (in a full clone of the pre-anonymized working tree): `resources/biolm-evidence-gaf1389-full/`
- Description: per-query BioLM evidence JSON for the 1,389-query FunctionBench-Bio-GAF1389 cohort (ESM2/ESMC/ProTrek donor neighbors).
- File count: 1,389
- Total bytes: 238,296,568 (~227.3 MB)
- Aggregate SHA-256 (SHA-256 over the sorted `<filename>\t<file-sha256>` lines): `f8d2a972cbabdbb724f1c45a2b0dbb7b517cddff9795a3b74dd2eae2efa2ed20`
- Referenced by: `resources/biolm-evidence-gaf1389-full.manifest.json`

### 2. Full Swiss-Prot donor references

- Path (in a full clone): `resources/full-swissprot-references.json`
- Description: full Swiss-Prot donor reference records used to resolve BioLM donor neighbors.
- SHA-256: `bff469a7be9ac81f63537602e22bf019126c34592b18ec878db60be13b851834`
- Referenced by: `resources/full-swissprot-index-manifest.json` and `resources/query-embeddings-1389.manifest.json`

### 3. Full Swiss-Prot donor embedding index (optional, large)

- Description: full donor embedding index matrices used to build the hash-bound retrieval index. These are referenced by `resources/full-swissprot-index-manifest.json` but are only required to rebuild the index from scratch.
- Files and SHA-256 (from `resources/full-swissprot-index-manifest.json`):

| File | Shape | SHA-256 |
| --- | --- | --- |
| `esm2.npy` | 573661 x 1280 float32 | `57353ed7a8d48461ad28088bc0178b2b875f914f860de213a2b299661e9c8c37` |
| `esmc.npy` | 573661 x 1152 float32 | `3779ba8269b4930bbf0f249624988eebee12e205259195658ca4f9d531fa2f68` |
| `protrek.npy` | 573661 x 1024 float32 | `6c319823609706ebd3d60561256f88f083d8ada95146ab10935c7fe026335eb2` |

## Artifacts already committed in this repository

The following smaller, hash-bound artifacts are committed under `resources/`:

- `resources/query-embeddings-1389-esm2.npy`, `-esmc.npy`, `-protrek.npy` and `query-embeddings-1389.manifest.json`
- `resources/retrieval-1389/esm2.json`, `esmc.json`, `protrek.json`
- `resources/full-swissprot-index-manifest.json`
- `resources/biolm-evidence-gaf1389-full.manifest.json`
- `resources/RSI_READINESS.md`

## Integrity verification examples

```bash
# Verify the full donor references file
shasum -a 256 resources/full-swissprot-references.json
# expected: bff469a7be9ac81f63537602e22bf019126c34592b18ec878db60be13b851834

# Verify the evidence directory aggregate hash
# (compute SHA-256 over the sorted "<filename>\t<file-sha256>" lines)
python3 - <<'PY'
import hashlib, pathlib
d = pathlib.Path('resources/biolm-evidence-gaf1389-full')
lines = []
for f in sorted(d.iterdir()):
    if f.is_file():
        lines.append(f"{f.name}\t{hashlib.sha256(f.read_bytes()).hexdigest()}")
print(hashlib.sha256("\n".join(lines).encode()).hexdigest())
# expected: f8d2a972cbabdbb724f1c45a2b0dbb7b517cddff9795a3b74dd2eae2efa2ed20
PY
```
