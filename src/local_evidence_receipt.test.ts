import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test from "node:test";

import {
  buildEvidenceAcquisitionPlan,
  buildLocalEvidenceAcquisitionReceipt,
} from "./evidence_acquisition.js";
import {
  buildLocalEvidenceSnapshot,
  validateLocalBatchAgainstSnapshot,
} from "./local_evidence_snapshot.js";
import { PROJECT_ROOT } from "./config.js";
import { loadGenome } from "./genome.js";
import { hashCanonical, sha256File } from "./hash.js";
import { withCanonicalHash, writeJson } from "./benchmark_io.js";
import type {
  BatchManifest,
  PrivateBenchmarkExclusions,
  PublicBenchmarkManifestV2,
} from "./benchmark_io.js";

async function localFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-local-receipt-"));
  const bin = join(root, "bin");
  const db = join(root, "db");
  await mkdir(bin, { recursive: true });
  await mkdir(db, { recursive: true });
  const executable = async (name: string, version: string): Promise<string> => {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, "utf8");
    await chmod(path, 0o755);
    return path;
  };
  const python = await executable("python", "Python 3.11.13");
  const blastp = await executable("blastp", "blastp: 2.17.0+");
  const blastdbcmd = await executable("blastdbcmd", "blastdbcmd: 2.17.0+");
  const foldseek = await executable("foldseek", "foldseek-test");
  const blastDb = join(db, "uniprot_sprot");
  const swissDb = join(db, "afdb_swissprot");
  const pdbDb = join(db, "pdb");
  await writeFile(`${blastDb}.pin`, "pin\n", "utf8");
  await writeFile(`${blastDb}.psq`, "psq\n", "utf8");
  await writeFile(swissDb, "swiss\n", "utf8");
  await writeFile(`${swissDb}.index`, "swiss-index\n", "utf8");
  await writeFile(pdbDb, "pdb\n", "utf8");
  await writeFile(`${pdbDb}.index`, "pdb-index\n", "utf8");
  const ontology = join(root, "go-basic.obo");
  await writeFile(ontology, "format-version: 1.2\ndata-version: test/releases/2026-07-21\n", "utf8");
  const profile = join(root, "resource-profile.json");
  const profileContent = {
    schemaVersion: "pi-external-resource-profile.v1",
    profileId: "strict_t0",
    mode: "strict_t0_evidence_plane",
    knowledgeCutoff: "2025-09-04",
    networkPolicy: "biological_network_disabled",
    resources: [],
    candidateProviders: {},
  };
  await writeFile(profile, JSON.stringify({
    ...profileContent,
    canonicalHash: hashCanonical(profileContent),
  }), "utf8");
  const config = join(root, "local.env");
  await writeFile(config, [
    "EVIDENCE_PROFILE=sequence_structure",
    "SEQUENCE_SEARCH_BACKEND=local",
    "STRUCTURE_SEARCH_BACKEND=local",
    `TEMPORAL_RESOURCE_PROFILE=${profile}`,
    `PYTHON_BIN=${python}`,
    `BLASTP_BIN=${blastp}`,
    `BLASTDBCMD_BIN=${blastdbcmd}`,
    `BLAST_DB=${blastDb}`,
    `FOLDSEEK_BIN=${foldseek}`,
    `FOLDSEEK_SWISSPROT_DB=${swissDb}`,
    `FOLDSEEK_PDB_DB=${pdbDb}`,
    `GO_ONTOLOGY_OBO=${ontology}`,
    "MERIZO_ROOT=",
    "CHAINSAW_ROOT=",
    "TOP_K=8",
    "ANNOTATION_LIMIT=16",
    "CANDIDATE_PROVIDER_MODE=remote",
  ].join("\n") + "\n", "utf8");
  return { root, config, ontology, python, blastp, blastdbcmd, foldseek, blastDb, swissDb, pdbDb };
}

function rawInventory(files: Array<{ path: string; size: number; sha256: string }>) {
  // Match Python's code-point ordering used by evidence_pipeline.py.
  const sorted = [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { file_count: sorted.length, files: sorted, canonical_sha256: hashCanonical(sorted) };
}

test("local acquisition receipt validates Python-ordered punctuation-rich raw inventory and unchanged source bytes", async () => {
  const value = await localFixture();
  try {
    const suite = withCanonicalHash({
      schemaVersion: "pi-bioreason-public-suite.v2" as const,
      suiteId: "local-suite",
      seed: "seed",
      metric: "aspect_masked_flat_exact_smoke_v2" as const,
      claimBoundary: "fixture",
      cases: [],
    }) as PublicBenchmarkManifestV2;
    const exclusions = withCanonicalHash({
      schemaVersion: "pi-bioreason-private-exclusions.v1" as const,
      suiteId: suite.suiteId,
      publicManifestHash: suite.canonicalHash,
      cases: [],
    }) as PrivateBenchmarkExclusions;
    const pre = await buildLocalEvidenceSnapshot({ configPath: value.config, ontologyPath: value.ontology });
    const plan = await buildEvidenceAcquisitionPlan({
      planId: "local-plan",
      acquisitionEpochId: "local-epoch",
      profile: "sequence_structure",
      executionScope: "developer_local_snapshot",
      localSnapshot: pre,
      publicManifest: suite,
      privateExclusions: exclusions,
      publicTargetContextHash: null,
      genomePath: join(PROJECT_ROOT, "test", "fixtures", "genomes", "bootstrap-v0.json"),
      configPath: value.config,
      ontologyPath: value.ontology,
    });
    assert.equal(plan.sourceManifestHash, pre.canonicalHash);
    assert.doesNotMatch(JSON.stringify(plan), new RegExp(value.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const batchDir = join(value.root, "batch");
    const caseId = "CASE_LOCAL";
    const runDir = join(batchDir, "runs", caseId);
    const rawPaths = [
      "raw/sequence/blast_swissprot.tsv",
      "raw/foldseek/swissprot/full_length/results.tsv",
      "raw/foldseek/pdb/full_length/results.tsv",
      "raw/query-aux.tsv",
      "raw/query.pdb",
      "raw/query[0].tsv",
      "raw/query_extra.tsv",
      "raw/query~cache.tsv",
    ];
    for (const path of rawPaths) {
      await mkdir(join(runDir, path, ".."), { recursive: true });
      await writeFile(join(runDir, path), `${path}\n`, "utf8");
    }
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await mkdir(join(runDir, "prediction"), { recursive: true });
    const inventoryFiles = await Promise.all(rawPaths.map(async (path) => ({
      path,
      size: Buffer.byteLength(`${path}\n`),
      sha256: await sha256File(join(runDir, path)),
    })));
    const pythonOrderedInventory = rawInventory(inventoryFiles);
    assert.deepEqual(
      pythonOrderedInventory.files.map((file) => file.path).filter((path) => path.startsWith("raw/query")),
      [
        "raw/query-aux.tsv",
        "raw/query.pdb",
        "raw/query[0].tsv",
        "raw/query_extra.tsv",
        "raw/query~cache.tsv",
      ],
    );
    const weakInventory = (label: "blast_swissprot" | "foldseek_swissprot" | "foldseek_pdb") => {
      const database = pre.databases.find((item) => item.label === label)!;
      return {
        prefix: "private-runtime-path",
        fingerprint_kind: "metadata_plus_small_file_content_v1",
        file_count: database.fileCount,
        files: database.files.map((file) => ({ name: file.name, size: file.sizeBytes, mtime_ns: 0, content_sha256: null })),
        canonical_sha256: "untrusted-legacy-fingerprint",
      };
    };
    await writeJson(join(runDir, "run_manifest.json"), {
      schemaVersion: "pi-function-run.v4",
      status: "completed",
      evidenceAcquisition: { planHash: plan.canonicalHash, epochId: plan.acquisitionEpochId },
      inputs: { structure: "input/structure.pdb" },
    });
    await writeJson(join(runDir, "evidence_manifest.json"), {
      schema_version: "pi-function-evidence-manifest.v1",
      status: "completed",
      stages: {
        sequence_search: {
          status: "completed",
          command: [value.blastp, "-query", "query", "-db", value.blastDb, "-out", join(runDir, rawPaths[0])],
        },
        structure_search: {
          status: "completed",
          searches: {
            swissprot_full_length: { status: "completed", command: [value.foldseek, "easy-search", "query", value.swissDb, join(runDir, rawPaths[1])] },
            pdb_full_length: { status: "completed", command: [value.foldseek, "easy-search", "query", value.pdbDb, join(runDir, rawPaths[2])] },
          },
        },
      },
    });
    await writeJson(join(runDir, "evidence", "evidence_bundle.json"), {
      runtime: {
        search_backends: { sequence: "local", structure: "local" },
        blast_database: value.blastDb,
        foldseek_swissprot_database: value.swissDb,
        foldseek_pdb_database: value.pdbDb,
        tool_versions: { python: "3.11.13", blastp: "blastp: 2.17.0+", foldseek: "foldseek-test" },
        database_inventories: {
          blast_swissprot: weakInventory("blast_swissprot"),
          foldseek_swissprot: weakInventory("foldseek_swissprot"),
          foldseek_pdb: weakInventory("foldseek_pdb"),
        },
        optional_tool_identities: {
          merizo: { configured: false, artifacts: [], canonical_sha256: hashCanonical([]) },
          chainsaw: { configured: false, artifacts: [], canonical_sha256: hashCanonical([]) },
        },
        raw_artifact_inventory: pythonOrderedInventory,
      },
    });
    await writeJson(join(runDir, "evidence", "blind_evidence_bundle.json"), { evidence_ids: [] });
    await writeJson(join(runDir, "prediction", "go_predictions.json"), { terms: [] });
    const genome = await loadGenome(join(PROJECT_ROOT, "test", "fixtures", "genomes", "bootstrap-v0.json"));
    const batch = withCanonicalHash({
      schemaVersion: "pi-bioreason-batch.v2" as const,
      suiteId: suite.suiteId,
      publicManifestHash: suite.canonicalHash,
      privateExclusionsHash: exclusions.canonicalHash,
      publicTargetContextHash: null,
      phylogenyMode: "optional" as const,
      genomePath: "test/fixtures/genomes/bootstrap-v0.json",
      genomeHash: genome.genomeHash,
      narrativeMode: "deterministic" as const,
      identityExclusionPolicy: "trusted_private_accession_v1" as const,
      configLabel: "local.env",
      configSha256: await sha256File(value.config),
      evidenceAcquisitionPlanHash: plan.canonicalHash,
      evidenceAcquisitionEpochId: plan.acquisitionEpochId,
      status: "completed" as const,
      cases: [{
        caseId,
        split: "hidden" as const,
        runDir: relative(batchDir, runDir).split(sep).join("/"),
        status: "completed" as const,
        startedAt: "2026-07-21T00:00:00.000Z",
        finishedAt: "2026-07-21T00:01:00.000Z",
        validationOk: true,
      }],
      startedAt: "2026-07-21T00:00:00.000Z",
      finishedAt: "2026-07-21T00:01:00.000Z",
    }) as BatchManifest;
    const post = await buildLocalEvidenceSnapshot({ configPath: value.config, ontologyPath: value.ontology });
    const receipt = await buildLocalEvidenceAcquisitionReceipt({
      plan,
      preRunSnapshot: pre,
      postRunSnapshot: post,
      configPath: value.config,
      batchDir,
      batchManifest: batch,
    });
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.sourceManifestHash, pre.canonicalHash);
    assert.equal(receipt.cases[0].remoteProviderCount, 0);
    assert.equal(receipt.cases[0].localProviderCount, 3);

    await writeFile(join(runDir, rawPaths[0]), "tampered\n", "utf8");
    await assert.rejects(
      () => validateLocalBatchAgainstSnapshot({ snapshot: pre, configPath: value.config, batchDir, batchManifest: batch }),
      /raw artifact inventory is missing, stale, or tampered/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
