# Z86 T0 + AFDB v5 runtime

This repository supports the Host-managed `z86-function-198-pair-clean-v2` temporal generation. The benchmark adapter supplies each anonymous target sequence and its benchmark-provided structure. Target coordinates are inputs, not donor databases.

The predictor evidence boundary is:

- LAFA Sep-2025 sequence-search database;
- LAFA T0 annotations plus UniProtKB/Swiss-Prot 2025_03 rich metadata in the local SQLite store;
- GO `releases/2025-07-22`;
- NCBI Taxonomy 2025-09-01;
- PDB100 250101 and the exact AFDB Swiss-Prot v5 archive available 2025-08-24;
- no current UniProt, RCSB, QuickGO, AFDB v6, or remote biological candidate provider.

The Host profiles live under `.iclr-host/configs/*-z86-t0-afdbv5.env`. Run `.iclr-host/bin/z86_benchmark_adapter.py verify` before selecting a public case. Strict mode recomputes the contracted resource/database/tool hashes and fails closed on drift. Every accepted run records `strict_t0_evidence_plane` and `biological network requests = 0`.

The evaluator may use frozen T1-minus-T0 Gold only after prediction freeze. Gold and evaluator-private labels never enter this repository, the predictor process, or RSI candidate development.

The Early starting Agent remains BLAST + full-length Foldseek without Merizo/ChainSaw/OMA/DeepGOPlus. The R09 starting Agent retains those pre-T0 capabilities. Enabling AFDB v5 is shared neutral evidence-plane construction, not a transfer of R09 method capability to Early.
