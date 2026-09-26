# Independent evidence profiles

This repository owns its resource installation. It must not depend on a sibling repository's source tree, runtime state, or absolute paths.

## Profiles

- `t0`: immutable `t0-afdb-v5-v1` biological evidence plane. It binds the historical LAFA Sep-2025 87,925-protein BLAST/eligible-label universe, Swiss-Prot 2025_03 rich metadata for those donors, GO 2025-07-22, NCBI Taxonomy 2025-09-01, PDB100 250101, AFDB Swiss-Prot v5, and disables current biological network evidence.
- `t0-swissprot-full`: immutable `t0-swissprot-2025_03-full-all-t0-go-v1` generation. BLAST searches all 573,661 reviewed Swiss-Prot `2025_03` proteins, resolves compact historical context, and exposes every positive Swiss-Prot GOA association frozen on 2025-09-04. `Experimental + IC + TAS` is marked direct-eligible; phylogenetic/computational/electronic evidence remains visible and is scored by genome evidence weights; `NOT` is stored separately and never becomes a positive candidate. GO 2025-07-22 remains the scoring ontology.
- `discovery`: explicitly current-resource functional discovery. It is never benchmark-comparable and records the observed installation releases and hashes.

The canonical scientific contract is `release/evidence-profiles.lock.json`. Large resources are ignored by Git.

## Commands

```bash
./pi-agent evidence-resources plan --profile t0 --resource-root .resources/t0-afdb-v5-v1
./pi-agent evidence-resources install --profile t0 \
  --source-root /path/to/an/exact-verified-t0-plane \
  --resource-root .resources/t0-afdb-v5-v1
./pi-agent evidence-resources verify --profile t0 --resource-root .resources/t0-afdb-v5-v1
./pi-agent evidence-resources verify --profile t0-swissprot-full \
  --resource-root .resources/t0-swissprot-2025_03-full-all-t0-go-v1
```

`install` also accepts `--bundle /path/or/https-url [--bundle-sha256 HASH]`, so a GitHub release can carry independently downloadable split/packaged resources while Git retains only the lock, installer, and licenses. The installer refuses nested/same roots, verifies the source before copying, preserves only relative database symlinks, and verifies the independent destination again.

A site which reconstructs from official upstream archives must produce the exact installed hashes in the same lock. LAFA-distributed inputs or license-gated artifacts may be supplied through a verified source cache; failure to acquire an exact T0 source is fatal and never falls back to current data.

Generate a profile config after installing resources:

```bash
./pi-agent evidence-resources render-config --profile t0 \
  --resource-root .resources/t0-afdb-v5-v1 \
  --base-config config/local.env \
  --resource-profile config/resource_profiles/z86_t0_afdb_v5.json \
  --target-manifest /benchmark/TARGET_STRUCTURE_MANIFEST.json \
  --target-root /benchmark/structures \
  --oma-root .release-resources/evidence/t0-oma-jul2024-v1 \
  --snapshot .resources/profiles/t0/local-evidence-snapshot.json \
  --output .resources/profiles/t0/runtime.env
```

Render the full-Swiss-Prot comparison config with the same command, changing the profile/root/resource profile/target manifest/output to `t0-swissprot-full` bindings. Then select a whole plane atomically:

```bash
./pi-agent predict ... --evidence-profile t0
./pi-agent predict ... --evidence-profile t0-swissprot-full
./pi-agent predict ... --evidence-profile discovery
```

The requested full-resource A/B uses the same target, structure, model/genome, thresholds, random settings, ontology, taxonomy and structure resources. The full profile changes both the reviewed sequence/context search universe and the positive frozen T0 donor-GO evidence universe; it is not described as a sequence-only ablation. A Gold-blind paired canary is available:

```bash
python3 scripts/compare_t0_sequence_profiles.py \
  --sequence /benchmark/target.fasta \
  --structure /benchmark/target.pdb \
  --output-root runs/profile-ab-canary
```

It runs and validates both profiles sequentially, stores separate artifacts, and emits a hash-bound `AB_RECEIPT.json` without reading Gold. Formal comparison then freezes both prediction sets and evaluates coverage, first eligible-donor rank, selected GO surface, abstention, Fmax/AUPR/IA-wFmax/Smin and paired per-target changes. Historical r08 remains bound to `t0`; a method comparison on the full generation requires rerunning the comparator there.

Do not combine `--evidence-profile` with `--config`. Both T0 selections require their generated profile configs and fail closed if absent. `--oma-root` is required for an R09/Bio installation that exposes OMA/OMAmer; Early intentionally omits it. Discovery selection uses its separately rendered current-resource config and must be marked non-benchmark-comparable.

## CI

Normal PR CI validates the canonical lock, profile-selection policy, tamper behavior, and small fixtures. Full 28.5-GB AFDB acquisition/build verification belongs in a manual or self-hosted release job. Source archives are resumable and transient; after exact verification and database construction, retain the compact database and receipts, not duplicate archives.
