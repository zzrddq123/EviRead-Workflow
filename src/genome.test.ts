import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadGenome } from "./genome.js";

const RAW_GENOME_PATH = join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json");
const V10_DEVELOPMENT_CANDIDATE_PATH = join(
  process.cwd(),
  "test",
  "fixtures",
  "genomes",
  "development-v10-bp-frontier.json",
);

async function withTemporaryGenome(
  value: unknown,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-genome-test-"));
  const path = join(directory, "genome.json");
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("new default genome pins the OpenAI Codex GPT-5.6 Sol semantic reasoning contract", async () => {
  const loaded = await loadGenome(join(process.cwd(), "genomes", "human-v0005-mainline-semantic-reasoner-r9.json"));
  assert.deepEqual(loaded.genome.goPolicy.goJudgePolicy, {
    mode: "semantic_reasoning",
    executionMode: "pi",
    maxCandidates: 128,
    maxDonorContexts: 12,
    modelProvider: "openai-codex",
    modelId: "gpt-5.6-sol",
    thinkingLevel: "high",
  });
  assert.equal(loaded.genome.goPolicy.scoreFusionPolicy?.mode, "disabled");
});

test("loadGenome accepts a canonical outer-harness GenomeSnapshot", async () => {
  const raw = await loadGenome(RAW_GENOME_PATH);
  await withTemporaryGenome(raw, async (path) => {
    assert.deepEqual(await loadGenome(path), raw);
  });
});

test("loadGenome rejects a snapshot with a stale genome hash", async () => {
  const raw = await loadGenome(RAW_GENOME_PATH);
  await withTemporaryGenome({ ...raw, genomeHash: "0".repeat(64) }, async (path) => {
    await assert.rejects(loadGenome(path), /genomeHash mismatch/);
  });
});

test("loadGenome rejects a snapshot with a different immutable contract", async () => {
  const raw = await loadGenome(RAW_GENOME_PATH);
  await withTemporaryGenome({ ...raw, immutableContractHash: "f".repeat(64) }, async (path) => {
    await assert.rejects(loadGenome(path), /immutableContractHash mismatch/);
  });
});

test("loadGenome rejects unsupported snapshot fields", async () => {
  const raw = await loadGenome(RAW_GENOME_PATH);
  await withTemporaryGenome({ ...raw, untrusted: true }, async (path) => {
    await assert.rejects(loadGenome(path), /unsupported fields/);
  });
});

test("raw committed genome remains supported", async () => {
  const source = JSON.parse(await readFile(RAW_GENOME_PATH, "utf8")) as unknown;
  await withTemporaryGenome(source, async (path) => {
    const loaded = await loadGenome(path);
    assert.equal(loaded.schemaVersion, "pi-agent-genome-snapshot.v1");
    assert.deepEqual(loaded.genome, source);
  });
});

test("historical genome requires explicit rebinding to the current no-similarity-quarantine contract", async () => {
  await assert.rejects(loadGenome(V10_DEVELOPMENT_CANDIDATE_PATH), /immutableContractHash mismatch/);
  const historical = JSON.parse(await readFile(V10_DEVELOPMENT_CANDIDATE_PATH, "utf8"));
  await withTemporaryGenome(historical.genome, async (path) => {
  const loaded = await loadGenome(path);
  assert.equal(
    loaded.genomeHash,
    "e1afeaffed01e4aff98c9399ba10302964919453fd071a1a452f443bb25af6e6",
  );
  assert.deepEqual(loaded.genome.goPolicy.selectionPolicy, {
    mode: "evidence_frontier_v1",
    aspects: ["biological_process"],
  });
  assert.match(loaded.genome.claimBoundary, /not deployed without one-shot selection and promotion/);
  });
});

test("candidate-source aspect allowlist is canonical and storage-light only", async () => {
  const raw = await loadGenome(RAW_GENOME_PATH);
  raw.genome.goPolicy.candidateSourcePolicy = {
    mode: "storage_light",
    allowedAspects: ["biological_process", "cellular_component"],
    minimumBaseScore: 0.4,
    minimumQueryCoverage: 0.2,
    minimumEvidenceWeight: 0.4,
    requireIndependentRoots: 1,
    allowedSources: ["interpro", "pfam", "panther", "ec", "oma_ortholog"],
  };
  raw.genomeHash = "0".repeat(64);
  await withTemporaryGenome(raw.genome, async (path) => {
    assert.deepEqual(
      (await loadGenome(path)).genome.goPolicy.candidateSourcePolicy?.allowedAspects,
      ["biological_process", "cellular_component"],
    );
  });

  raw.genome.goPolicy.candidateSourcePolicy.allowedSources = ["pfam", "panther", "ec", "oma_ortholog", "oma_fastmap"];
  await withTemporaryGenome(raw.genome, async (path) => {
    assert.deepEqual(
      (await loadGenome(path)).genome.goPolicy.candidateSourcePolicy?.allowedSources,
      ["pfam", "panther", "ec", "oma_ortholog", "oma_fastmap"],
    );
  });

  raw.genome.goPolicy.candidateSourcePolicy.allowedAspects = ["cellular_component", "biological_process"];
  await withTemporaryGenome(raw.genome, async (path) => {
    await assert.rejects(loadGenome(path), /canonical GO-aspect list/);
  });
});

test("learned predictor policy accepts only a canonical optional method pin", async () => {
  const raw = await loadGenome(RAW_GENOME_PATH);
  raw.genome.goPolicy.learnedPredictorPolicy = {
    mode: "candidate_channel",
    allowedSources: ["deepgoplus_cnn"],
    expectedMethodHash: "a".repeat(64),
    allowedAspects: ["molecular_function"],
    activationMode: "prediction_aspect_gap_only",
    maxCandidatesPerAspect: 10,
    minimumScore: 0.1,
    scoreScale: 1,
    requireIndependentRoots: 1,
  };
  await withTemporaryGenome(raw.genome, async (path) => {
    assert.equal(
      (await loadGenome(path)).genome.goPolicy.learnedPredictorPolicy?.expectedMethodHash,
      "a".repeat(64),
    );
    assert.equal(
      (await loadGenome(path)).genome.goPolicy.learnedPredictorPolicy?.maxCandidatesPerAspect,
      10,
    );
  });
  raw.genome.goPolicy.learnedPredictorPolicy.activationMode = "host_term_agreement_only";
  await withTemporaryGenome(raw.genome, async (path) => {
    assert.equal(
      (await loadGenome(path)).genome.goPolicy.learnedPredictorPolicy?.activationMode,
      "host_term_agreement_only",
    );
  });
  raw.genome.goPolicy.learnedPredictorPolicy.allowedAspects = ["biological_process"];
  await withTemporaryGenome(raw.genome, async (path) => {
    await assert.rejects(loadGenome(path), /host_term_agreement_only is restricted to molecular_function/);
  });
  raw.genome.goPolicy.learnedPredictorPolicy.allowedAspects = ["molecular_function"];
  raw.genome.goPolicy.learnedPredictorPolicy.expectedMethodHash = "not-a-hash";
  await withTemporaryGenome(raw.genome, async (path) => {
    await assert.rejects(loadGenome(path), /expectedMethodHash must be a canonical SHA-256/);
  });
  raw.genome.goPolicy.learnedPredictorPolicy.expectedMethodHash = "a".repeat(64);
  raw.genome.goPolicy.learnedPredictorPolicy.maxCandidatesPerAspect = 0;
  await withTemporaryGenome(raw.genome, async (path) => {
    await assert.rejects(loadGenome(path), /maxCandidatesPerAspect must be an integer from 1 to 512/);
  });
});
