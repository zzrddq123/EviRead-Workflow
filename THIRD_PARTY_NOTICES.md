# Third-party software and data

The repository's original source is licensed under Apache-2.0. Third-party software, models, and biological data retain their own terms. The repository includes one small identity-stripped AlphaFold DB v5 demo coordinate under CC BY 4.0; large resources are acquired from named upstream channels or, only after review, an immutable release dataset. `--accept-licenses` confirms that the user has reviewed these terms; it does not grant rights that an upstream license withholds.

| Component | Pinned/acquired form | Purpose | Upstream terms/source |
| --- | --- | --- | --- |
| micromamba | release `2.6.2-1`, upstream `.sha256` verified | Creates the repo-managed environment | BSD-3-Clause; [mamba-org/micromamba-releases](https://github.com/mamba-org/micromamba-releases) |
| Node.js | conda-forge direct constraint `nodejs=22` | TypeScript orchestration and Pi SDK | MIT; [Node.js source](https://github.com/nodejs/node) |
| Python | conda-forge direct constraint `python=3.11` | Evidence pipeline and bootstrap verification | PSF-2.0; [CPython source](https://github.com/python/cpython) |
| NCBI BLAST+ | Bioconda `blast=2.16.0` | Swiss-Prot sequence search | NCBI-PD; [Bioconda recipe](https://bioconda.github.io/recipes/blast/README.html) |
| Foldseek | Bioconda `foldseek=10.941cd33` | Structure search and database acquisition | GPL-3.0; [official repository](https://github.com/steineggerlab/foldseek) |
| DeepFRI/mDeepFRI sequence-CNN reference | mDeepFRI commit `366acae69245fba7b7bf0673c2c3e618e3e00869`, reference path `mDeepFRI/predict.pyx` | Reference behavior for the repository-owned one-hot/CPU ONNX adapter | GPL-3.0-or-later; [Metagenomic-DeepFRI](https://github.com/Tomasz-Lab/Metagenomic-DeepFRI) |
| mDeepFRI DeepCNN-MERGED weights | model version `1.0`, Hugging Face revision `31bfca094fc7ccef57456dcee001fdc653709f14`; every downloaded byte is size/SHA-256 bound | Optional sequence-only GO candidate generation for MF, BP, and CC | MIT as declared by the model repository; [valentynbez/mDeepFRI](https://huggingface.co/valentynbez/mDeepFRI) |
| mDeepFRI DeepFRI-MERGED GraphConv weights | model version `1.0`, Hugging Face revision `31bfca094fc7ccef57456dcee001fdc653709f14`; every downloaded byte is size/SHA-256 bound | Optional structure-GCN GO candidate generation for MF, BP, and CC from exact C-alpha contact maps | MIT as declared by the model repository; [valentynbez/mDeepFRI](https://huggingface.co/valentynbez/mDeepFRI) |
| ONNX Runtime / NumPy predictor environment | `onnxruntime==1.16.3`, `numpy==1.26.4`, with all transitive wheels version- and SHA-256-pinned in `bootstrap/mdeepfri-requirements.lock.txt` | Isolated CPU execution of the optional sequence-CNN models | ONNX Runtime: MIT; NumPy: BSD-3-Clause; review the licenses shipped in each pinned wheel for transitive packages |
| NCBI BLAST Common URL API | rolling public service, `swissprot` database | Remote-profile sequence search | Follow [NCBI BLAST developer guidance](https://blast.ncbi.nlm.nih.gov/doc/blast-help/developerinfo.html), rate limits, and database-provider terms; a real contact email is required |
| Foldseek public server API | rolling public service, `afdb-swissprot,pdb100`, `tmalign` mode | Remote structure search, including the default `local_blast` profile | Review [Foldseek server API documentation](https://search.foldseek.com/docs/api) and underlying AlphaFold DB/PDB data terms |
| UniProtKB/Swiss-Prot | current-release FASTA, verified against `RELEASE.metalink` | BLAST database and live annotation lookup | CC BY 4.0; [UniProt license](https://www.uniprot.org/help/license) |
| Gene Ontology `go-basic.obo` | current official snapshot; observed byte hash and `data-version` recorded | Alt-ID resolution and safe `is_a`/`part_of` ancestor closure | CC BY 4.0; [GO ontology downloads](https://geneontology.org/docs/download-ontology/) |
| AlphaFold DB / Swiss-Prot Foldseek DB | `foldseek databases Alphafold/Swiss-Prot` | Structure donor search | Review [AlphaFold DB terms](https://alphafold.ebi.ac.uk/) and attribution requirements |
| PDB100 Foldseek DB | release `250101`, official archive and complete extracted manifest hash | Experimentally solved structure search | PDB coordinate data are CC0; retain wwPDB and Foldseek database-preparation attribution; [RCSB policies](https://www.rcsb.org/pages/policies) |
| NCBI Taxonomy | historical taxdump `2025-09-01` | Frozen donor-lineage calibration | [NCBI data usage policies](https://www.ncbi.nlm.nih.gov/home/about/policies/) |
| OMA / OMAmer | OMA `All.Jul2024`, OMAmer 2.0.3 LUCA | Offline HOG placement and conservative GO support | CC BY 4.0; [OMA Browser](https://omabrowser.org/) and immutable Zenodo records named in `release/resources.lock.json` |
| DeepGOPlus | software 1.0.2 / data 1.0.25, official archive and hash-locked isolated runtime | Frozen learned GO prior | DeepGOPlus authors; bundled UniProt/GO data retain their terms; [DeepGOPlus](https://github.com/bio-ontology-research-group/deepgoplus) |
| Merizo | exact commit/tree `41d12fb84e6e8fdb586c2c859d12161dc7bb5bfd` | Domain segmentation | GPL-3.0-only; direct official checkout; [Merizo](https://github.com/psipred/Merizo) |
| Chainsaw | exact commit/tree `9ced6e6d04043b0f2c50afa4527013997e305d4d` | Domain segmentation | MIT code plus NSC/STRIDE academic/noncommercial/no-redistribution restrictions; direct official checkout only after separate explicit acceptance; [Chainsaw](https://github.com/JudeWells/chainsaw) |
| uv | 0.12.3, per-platform official archive/binary SHA-256 | Isolated hash-synchronized Python environments | Apache-2.0 OR MIT; [Astral uv](https://github.com/astral-sh/uv) |
| Pi coding-agent harness | npm lock: `@earendil-works/pi-coding-agent` `0.80.10` | Synthesis/critic harness | MIT; [earendil-works/pi](https://github.com/earendil-works/pi) |

The full `live` product profile installs Merizo and a compatible exact Chainsaw tree directly from their official repositories. Merizo uses an isolated hash-synchronized runtime. Chainsaw requires a separate explicit acceptance flag, is never mirrored, and retains bundled NSC/STRIDE restrictions; commercial use requires a separate upstream license.

The mDeepFRI CNN channel is also optional. `--with-mdeepfri-cnn` installs its
Python dependencies into a separate repository-managed environment and
downloads only the three sequence-CNN heads plus their parameter metadata.
Bootstrap and doctor verify the pinned package version, model filenames,
sizes, SHA-256 values, CPU provider, and a real inference smoke. These checks
establish executable reproducibility; they do not establish score calibration,
absence of model-training overlap with an evaluation cohort, temporal validity,
or biological correctness.

The mDeepFRI GCN channel is independently optional. `--with-mdeepfri-gcn`
installs a separate lock-bound runtime and the three GraphConv heads. Its
repository-owned adapter requires an exact anonymous FASTA/PDB sequence match,
uses a single-chain C-alpha contact map at the model-declared 10 Å threshold,
and fails closed on missing residues, alternate chains, or identity mismatch.

## Release boundary

Every direct and transitive conda package archive is pinned by URL and SHA-256,
and the bootstrap records the installed package set in
`.runtime/tool_install_manifest.json`. NCBI BLAST and Foldseek public services,
UniProt `current_release`, the GO `current` endpoint, and Foldseek's local
database endpoints are rolling resources. The default `local_blast` profile
verifies the official UniProt release hash, records SHA-256 values for every
installed Swiss-Prot/BLAST and GO file, and hash-caches remote Foldseek payloads
per run. The explicit `remote` profiles record the observed GO bytes, download
no local search database, and additionally cache NCBI payloads. Fully local
profiles record every installed data file. Each path makes one observed run
auditable, but exact replay requires separately archiving its remote payloads
and local data bytes.

GO annotations in this MVP are retrieved from live UniProt REST responses and cached with payload hashes per run. The OBO graph can be pinned locally, but the annotation assertions are still live. Therefore the managed runtime is portable, but not a fully offline, cutoff-frozen GO benchmark distribution. A paper-grade temporal benchmark still needs an archived, release-matched GAF/GPAD/OBO/taxon-constraint bundle.
