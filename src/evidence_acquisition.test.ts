import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertEvidenceAcquisitionPlan,
  assertEvidenceAcquisitionReceipt,
  buildEvidenceAcquisitionPlan,
  buildEvidenceAcquisitionReceipt,
  buildRemoteCacheManifest,
} from "./evidence_acquisition.js";
import { PROJECT_ROOT } from "./config.js";
import { loadGenome } from "./genome.js";
import { hashCanonical, sha256File } from "./hash.js";
import { readJson, withCanonicalHash, writeJson } from "./benchmark_io.js";
import type {
  BatchManifest,
  PrivateBenchmarkExclusions,
  PublicBenchmarkManifestV2,
} from "./benchmark_io.js";

function publicSuite(): PublicBenchmarkManifestV2 {
  return withCanonicalHash({
    schemaVersion: "pi-bioreason-public-suite.v2" as const,
    suiteId: "protected20-fixture",
    seed: "fixed-seed",
    metric: "aspect_masked_flat_exact_smoke_v2" as const,
    claimBoundary: "fixture",
    cases: [],
  }) as PublicBenchmarkManifestV2;
}

function exclusions(suite: PublicBenchmarkManifestV2): PrivateBenchmarkExclusions {
  return withCanonicalHash({
    schemaVersion: "pi-bioreason-private-exclusions.v1" as const,
    suiteId: suite.suiteId,
    publicManifestHash: suite.canonicalHash,
    cases: [],
  }) as PrivateBenchmarkExclusions;
}

async function fixture(profile: "remote" | "remote_broad" = "remote_broad") {
  const root = await mkdtemp(join(tmpdir(), "pi-acquisition-"));
  await mkdir(join(PROJECT_ROOT, ".runtime", "cache"), { recursive: true });
  const cacheRoot = await mkdtemp(join(PROJECT_ROOT, ".runtime", "cache", "acquisition-test-"));
  const ontology = join(root, "go-basic.obo");
  await writeFile(ontology, "format-version: 1.2\ndata-version: test/releases/2026-07-21\n\n[Term]\nid: GO:0003674\nname: molecular_function\nnamespace: molecular_function\n", "utf8");
  const config = join(root, "managed.env");
  const broad = profile === "remote_broad";
  await writeFile(config, [
    `EVIDENCE_PROFILE=${profile}`,
    "SEQUENCE_SEARCH_BACKEND=ncbi",
    "STRUCTURE_SEARCH_BACKEND=foldseek_remote",
    `NCBI_BLAST_DATABASES=${broad ? "swissprot,nr_cluster_seq" : "swissprot"}`,
    "NCBI_BLAST_URL=https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi",
    "NCBI_BLAST_EMAIL=private-contact@example.org",
    "NCBI_BLAST_TOOL=FunctionPredAgent07B",
    "NCBI_BLAST_JOB_TIMEOUT_SECONDS=1800",
    "NCBI_BLAST_JOB_TIMEOUT_SECONDS_SWISSPROT=3600",
    "NCBI_BLAST_JOB_TIMEOUT_SECONDS_NR_CLUSTER_SEQ=7200",
    `NCBI_BLAST_CACHE_DIR=${join(cacheRoot, "ncbi")}`,
    `FOLDSEEK_REMOTE_DATABASES=${broad ? "afdb-swissprot,afdb50,pdb100" : "afdb-swissprot,pdb100"}`,
    "FOLDSEEK_REMOTE_URL=https://search.foldseek.com/api",
    `FOLDSEEK_REMOTE_CACHE_DIR=${join(cacheRoot, "foldseek")}`,
    `FOLDSEEK_REMOTE_PACER_DIR=${join(cacheRoot, "foldseek")}`,
    "FOLDSEEK_REMOTE_MAX_ATTEMPTS=3",
    "FOLDSEEK_REMOTE_BACKOFF_BASE_SECONDS=1",
    "FOLDSEEK_REMOTE_BACKOFF_MAX_SECONDS=30",
    "FOLDSEEK_REMOTE_BACKOFF_JITTER_FRACTION=0.2",
    "FOLDSEEK_REMOTE_SUBMISSION_INTERVAL_SECONDS=5",
    `REMOTE_CANDIDATE_CACHE_DIR=${join(cacheRoot, "candidate")}`,
    `TOP_K=${broad ? 12 : 8}`,
    `ANNOTATION_LIMIT=${broad ? 32 : 16}`,
    `GO_ONTOLOGY_OBO=${ontology}`,
  ].join("\n"), "utf8");
  const suite = publicSuite();
  const privateExclusions = exclusions(suite);
  const plan = await buildEvidenceAcquisitionPlan({
    planId: "fixture-plan",
    acquisitionEpochId: "epoch-20260721",
    profile,
    publicManifest: suite,
    privateExclusions,
    publicTargetContextHash: null,
    genomePath: join(PROJECT_ROOT, "test", "fixtures", "genomes", "bootstrap-v0.json"),
    configPath: config,
    ontologyPath: ontology,
  });
  return { root, cacheRoot, ontology, config, suite, privateExclusions, plan };
}

async function completeSequenceOnlyBatch(value: Awaited<ReturnType<typeof fixture>>) {
  const caseId = "CASE_OPAQUE";
  const batchDir = join(value.root, "batch");
  const runDir = join(batchDir, "runs", caseId);
  const ncbiRoot = join(value.cacheRoot, "ncbi");
  await mkdir(join(runDir, "raw", "sequence"), { recursive: true });
  await mkdir(join(runDir, "evidence"), { recursive: true });
  await mkdir(join(runDir, "prediction"), { recursive: true });
  await mkdir(ncbiRoot, { recursive: true });
  await mkdir(join(value.cacheRoot, "foldseek"), { recursive: true });
  const identity = {
    schema_version: "pi-ncbi-remote-blast-cache.v1",
    endpoint: "https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi",
    program: "blastp",
    database: "swissprot",
    query_sha256: "1".repeat(64),
    query_length: 42,
    parameters: { expect: "1e-5", format_type: "JSON2_S" },
  };
  const cacheKey = hashCanonical(identity);
  const rawRelative = "raw/sequence/blast_swissprot.remote.json";
  const provenanceRelative = "raw/sequence/blast_swissprot.remote.provenance.json";
  const rawPath = join(runDir, rawRelative);
  await writeFile(rawPath, '{"BlastOutput2":[]}\n', "utf8");
  const rawSha256 = await sha256File(rawPath);
  const rawSize = Buffer.byteLength('{"BlastOutput2":[]}\n');
  const record = {
    schema_version: "pi-ncbi-remote-blast-provenance.v1",
    status: "completed",
    backend: "ncbi_common_url_api",
    request: { ...identity, contact_email_configured: true },
    cache: { key: cacheKey, hit: true },
    raw_payload_sha256: rawSha256,
    raw_payload_size: rawSize,
  };
  await writeJson(join(runDir, provenanceRelative), record);
  await writeFile(join(ncbiRoot, `${cacheKey}.json`), '{"BlastOutput2":[]}\n', "utf8");
  await writeJson(join(ncbiRoot, `${cacheKey}.meta.json`), {
    ...identity,
    cache_key: cacheKey,
    response_sha256: rawSha256,
    response_size: rawSize,
  });
  await writeJson(join(runDir, "run_manifest.json"), {
    schemaVersion: "pi-function-run.v4",
    status: "completed",
    evidenceAcquisition: { planHash: value.plan.canonicalHash, epochId: value.plan.acquisitionEpochId },
    inputs: { structure: null },
  });
  await writeJson(join(runDir, "evidence_manifest.json"), {
    schema_version: "pi-function-evidence-manifest.v1",
    status: "completed",
    stages: {
      sequence_search: {
        status: "completed",
        backend: "ncbi_common_url_api",
        databases: ["swissprot"],
        searches: { swissprot: record },
      },
      structure_search: { status: "skipped", reason: "no structure supplied" },
    },
  });
  await writeJson(join(runDir, "evidence", "evidence_bundle.json"), {
    runtime: { search_backends: { sequence: "ncbi", structure: null } },
  });
  await writeJson(join(runDir, "evidence", "blind_evidence_bundle.json"), { evidence: [] });
  await writeJson(join(runDir, "prediction", "go_predictions.json"), { terms: [] });
  const genome = await loadGenome(join(PROJECT_ROOT, "test", "fixtures", "genomes", "bootstrap-v0.json"));
  const batch = withCanonicalHash({
    schemaVersion: "pi-bioreason-batch.v2" as const,
    suiteId: value.suite.suiteId,
    publicManifestHash: value.suite.canonicalHash,
    privateExclusionsHash: value.privateExclusions.canonicalHash,
    publicTargetContextHash: null,
    phylogenyMode: "optional" as const,
    genomePath: "test/fixtures/genomes/bootstrap-v0.json",
    genomeHash: genome.genomeHash,
    narrativeMode: "deterministic" as const,
    identityExclusionPolicy: "trusted_private_accession_v1" as const,
    configLabel: "managed.env",
    configSha256: await sha256File(value.config),
    evidenceAcquisitionPlanHash: value.plan.canonicalHash,
    evidenceAcquisitionEpochId: value.plan.acquisitionEpochId,
    status: "completed" as const,
    cases: [{
      caseId,
      split: "hidden" as const,
      runDir: `runs/${caseId}`,
      status: "completed" as const,
      startedAt: "2026-07-21T00:00:00.000Z",
      finishedAt: "2026-07-21T00:01:00.000Z",
      validationOk: true,
    }],
    startedAt: "2026-07-21T00:00:00.000Z",
    finishedAt: "2026-07-21T00:01:00.000Z",
  }) as BatchManifest;
  return { batchDir, runDir, batch, cacheKey };
}

test("full-tool acquisition plan binds remote_broad and strips credentials and paths", async () => {
  const value = await fixture();
  try {
    assert.equal(assertEvidenceAcquisitionPlan(value.plan).profile, "remote_broad");
    const serialized = JSON.stringify(value.plan);
    assert.doesNotMatch(serialized, /private-contact|@example|NCBI_BLAST_EMAIL/);
    assert.doesNotMatch(serialized, new RegExp(value.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(value.plan.sanitizedConfig.NCBI_BLAST_DATABASES, "swissprot,nr_cluster_seq");
    assert.equal(value.plan.sanitizedConfig.NCBI_BLAST_JOB_TIMEOUT_SECONDS_SWISSPROT, "3600");
    assert.equal(value.plan.sanitizedConfig.NCBI_BLAST_JOB_TIMEOUT_SECONDS_NR_CLUSTER_SEQ, "7200");
    assert.equal(value.plan.sanitizedConfig.FOLDSEEK_REMOTE_MAX_ATTEMPTS, "3");
    assert.match(value.plan.sanitizedConfig.FOLDSEEK_REMOTE_PACER_SCOPE, /^acquisition-test-/);
    assert.equal(value.plan.responsePolicy.silentLocalFallbackAllowed, false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
    await rm(value.cacheRoot, { recursive: true, force: true });
  }
});

test("remote cache manifest is cohort-exact, ignores historical cache, and rejects referenced symlinks", async () => {
  const value = await fixture("remote");
  try {
    const batchValue = await completeSequenceOnlyBatch(value);
    await writeFile(join(value.cacheRoot, "ncbi", "unrelated-history.json"), "{\"old\":true}\n", "utf8");
    const input = { plan: value.plan, batchDir: batchValue.batchDir, batchManifest: batchValue.batch, configPath: value.config };
    const first = await buildRemoteCacheManifest(input);
    const second = await buildRemoteCacheManifest(input);
    assert.deepEqual(first, second);
    assert.equal(first.scope, "batch_exact_remote_search_cache_v1");
    assert.equal(first.totalFiles, 2);
    assert.equal(first.cases?.[0]?.providers[0]?.cacheKey, batchValue.cacheKey);
    assert.doesNotMatch(JSON.stringify(first), /unrelated-history/);

    const metadata = join(value.cacheRoot, "ncbi", `${batchValue.cacheKey}.meta.json`);
    await unlink(metadata);
    await symlink(join(value.cacheRoot, "ncbi", `${batchValue.cacheKey}.json`), metadata);
    await assert.rejects(
      () => buildRemoteCacheManifest(input),
      /non-symlink/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
    await rm(value.cacheRoot, { recursive: true, force: true });
  }
});

test("full-tool receipt binds every prediction artifact and refuses a different config hash", async () => {
  const value = await fixture("remote");
  try {
    const batchValue = await completeSequenceOnlyBatch(value);
    const cache = await buildRemoteCacheManifest({
      plan: value.plan,
      batchDir: batchValue.batchDir,
      batchManifest: batchValue.batch,
      configPath: value.config,
    });
    const receipt = await buildEvidenceAcquisitionReceipt({
      plan: value.plan,
      batchDir: batchValue.batchDir,
      batchManifest: batchValue.batch,
      cacheManifest: cache,
    });
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.completedCaseCount, 1);
    assert.equal(receipt.cases[0]?.remoteProviderCount, 1);
    assert.equal(receipt.cases[0]?.runManifestSha256, await sha256File(join(batchValue.runDir, "run_manifest.json")));
    assert.match(receipt.cases[0]?.evidenceManifestSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(assertEvidenceAcquisitionReceipt(receipt).patchBinding, null);
    const missingPatchBinding = withCanonicalHash(Object.fromEntries(
      Object.entries(receipt).filter(([key]) => key !== "patchBinding" && key !== "canonicalHash"),
    ));
    assert.throws(
      () => assertEvidenceAcquisitionReceipt(missingPatchBinding),
      /receipt patch binding is invalid/,
    );

    const tampered = withCanonicalHash({ ...batchValue.batch, configSha256: "0".repeat(64) }) as BatchManifest;
    await assert.rejects(
      () => buildEvidenceAcquisitionReceipt({
        plan: value.plan,
        batchDir: batchValue.batchDir,
        batchManifest: tampered,
        cacheManifest: cache,
      }),
      /not bound/,
    );
    await unlink(join(batchValue.runDir, "prediction", "go_predictions.json"));
    await assert.rejects(
      () => buildEvidenceAcquisitionReceipt({
        plan: value.plan,
        batchDir: batchValue.batchDir,
        batchManifest: batchValue.batch,
        cacheManifest: cache,
      }),
      /required acquisition artifact is missing/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
    await rm(value.cacheRoot, { recursive: true, force: true });
  }
});

test("a structure-bearing completed case cannot omit any profile-required Foldseek lane", async () => {
  const value = await fixture("remote");
  try {
    const batchValue = await completeSequenceOnlyBatch(value);
    const runPath = join(batchValue.runDir, "run_manifest.json");
    const run = await readJson<Record<string, unknown>>(runPath);
    await writeJson(runPath, { ...run, inputs: { structure: "input/structure.pdb" } });
    const evidencePath = join(batchValue.runDir, "evidence_manifest.json");
    const evidence = await readJson<Record<string, unknown>>(evidencePath);
    const stages = evidence.stages as Record<string, unknown>;
    await writeJson(evidencePath, {
      ...evidence,
      stages: { ...stages, structure_search: { status: "completed", searches: {} } },
    });
    await writeJson(join(batchValue.runDir, "evidence", "evidence_bundle.json"), {
      runtime: { search_backends: { sequence: "ncbi", structure: "foldseek_remote" } },
    });
    await assert.rejects(
      () => buildRemoteCacheManifest({
        plan: value.plan,
        batchDir: batchValue.batchDir,
        batchManifest: batchValue.batch,
        configPath: value.config,
      }),
      /raw\/foldseek\/remote\/result\.json|afdb-swissprot.*Foldseek provenance/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
    await rm(value.cacheRoot, { recursive: true, force: true });
  }
});
