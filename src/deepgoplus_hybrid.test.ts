import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { attachCandidateSources } from "./candidate_stage.js";
import {
  collectDeepGoPlusHybridCandidateSource,
  deepGoPlusHybridCandidateSourceFromBatchCase,
  deepGoPlusHybridComponentProjectionHash,
  deepGoPlusHybridConfigFromEnv,
  runDeepGoPlusHybridBatch,
  type DeepGoPlusHybridConfig,
} from "./deepgoplus_hybrid.js";
import { hashCanonical, sha256Text } from "./hash.js";
import {
  learnedPredictorBindingFromEvidenceBundle,
} from "./learned_predictor_contract.js";

async function fixture(): Promise<{
  root: string;
  config: DeepGoPlusHybridConfig;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "deepgoplus-hybrid-adapter-"));
  const artifacts = Object.fromEntries(await Promise.all([
    "model.h5",
    "terms.pkl",
    "go.obo",
    "train_data.pkl",
    "train_data.dmnd",
    "train_data.fa",
    "last_release.json",
    "diamond",
  ].map(async (name) => {
    const path = join(root, name);
    await writeFile(path, name, "utf8");
    return [name, path] as const;
  })));
  return {
    root,
    config: {
      mode: "local",
      pythonExecutable: "/usr/bin/true",
      runnerPath: resolve("python/deepgoplus_hybrid_predictor.py"),
      modelPath: artifacts["model.h5"],
      termsPath: artifacts["terms.pkl"],
      ontologyPath: artifacts["go.obo"],
      annotationsPath: artifacts["train_data.pkl"],
      diamondDatabasePath: artifacts["train_data.dmnd"],
      trainingFastaPath: artifacts["train_data.fa"],
      metadataPath: artifacts["last_release.json"],
      diamondExecutablePath: artifacts.diamond,
      packageVersion: "1.0.2",
      tensorflowVersion: "2.15.1",
      numpyVersion: "1.26.4",
      pandasVersion: "1.5.3",
      dataRelease: "1.0.28",
      exportMinimumScore: 0.1,
      timeoutMs: 1000,
      maxStdoutBytes: 1024 * 1024,
    },
    cleanup: async () => await rm(root, { recursive: true, force: true }),
  };
}

function resultFor(
  request: Record<string, unknown>,
  exactTrainingSequenceMatchCount = 0,
  nearExactTrainingSequenceMatchCount = 0,
): Record<string, unknown> {
  const method = request.method as Record<string, unknown>;
  const cases = request.cases as Array<Record<string, unknown>>;
  const resultCases = [{
    caseId: cases[0].caseId as string,
    sequenceSha256: cases[0].sequenceSha256 as string,
    diamondHitCount: 3,
    hasDiamondHit: true,
    exactTrainingSequenceMatchCount,
    nearExactTrainingSequenceMatchCount,
    hasNearExactTrainingSequenceMatch:
      nearExactTrainingSequenceMatchCount > 0,
    topDiamondDonors: [{
      subjectId: "TRAIN_A",
      accession: "P00001",
      taxonId: "9606",
      bitScore: 100,
      percentIdentity: nearExactTrainingSequenceMatchCount > 0 ? 99.5 : 80,
      alignmentLength: nearExactTrainingSequenceMatchCount > 0 ? 100 : 80,
      queryLength: 100,
      subjectLength: 100,
      queryCoverage: nearExactTrainingSequenceMatchCount > 0 ? 1 : 0.8,
      subjectCoverage: nearExactTrainingSequenceMatchCount > 0 ? 1 : 0.8,
      nearExact: nearExactTrainingSequenceMatchCount > 0,
    }],
    predictions: [{
      goId: "GO:0000001",
      termName: "hybrid function",
      aspect: "molecular_function" as const,
      score: 0.75,
      directHybridScore: 0.75,
      directCnnScore: 0.25,
      directDiamondScore: 1,
      agentDirectDiamondScore: 0.6,
      agentDirectHybridScore: 0.481,
      propagated: false,
    }, {
      goId: "GO:0000002",
      termName: "provider-propagated ancestor",
      aspect: "biological_process" as const,
      score: 0.4,
      directHybridScore: null,
      directCnnScore: null,
      directDiamondScore: null,
      agentDirectDiamondScore: null,
      agentDirectHybridScore: null,
      propagated: true,
    }, {
      goId: "GO:0000003",
      termName: "raw annotation only function",
      aspect: "molecular_function" as const,
      score: null,
      directHybridScore: null,
      directCnnScore: null,
      directDiamondScore: null,
      agentDirectDiamondScore: 0.7,
      agentDirectHybridScore: 0.462,
      propagated: false,
    }],
  }];
  return {
    schemaVersion: "pi-deepgoplus-hybrid-run-result.v1",
    methodHash: method.methodHash,
    predictionSetHash: deepGoPlusHybridComponentProjectionHash(resultCases),
    cases: resultCases,
  };
}

function environment(config: DeepGoPlusHybridConfig): NodeJS.ProcessEnv {
  return {
    DEEPGOPLUS_HYBRID_MODE: "local",
    DEEPGOPLUS_PYTHON: config.pythonExecutable,
    DEEPGOPLUS_HYBRID_RUNNER: config.runnerPath,
    DEEPGOPLUS_MODEL: config.modelPath,
    DEEPGOPLUS_TERMS: config.termsPath,
    DEEPGOPLUS_ONTOLOGY: config.ontologyPath,
    DEEPGOPLUS_ANNOTATIONS: config.annotationsPath,
    DEEPGOPLUS_DIAMOND_DATABASE: config.diamondDatabasePath,
    DEEPGOPLUS_TRAINING_FASTA: config.trainingFastaPath,
    DEEPGOPLUS_METADATA: config.metadataPath,
    DEEPGOPLUS_DIAMOND_EXECUTABLE: config.diamondExecutablePath,
    DEEPGOPLUS_PACKAGE_VERSION: config.packageVersion,
    DEEPGOPLUS_TENSORFLOW_VERSION: config.tensorflowVersion,
    DEEPGOPLUS_NUMPY_VERSION: config.numpyVersion,
    DEEPGOPLUS_PANDAS_VERSION: config.pandasVersion,
    DEEPGOPLUS_DATA_RELEASE: config.dataRelease,
    DEEPGOPLUS_HYBRID_EXPORT_MINIMUM_SCORE:
      String(config.exportMinimumScore),
  };
}

test("hybrid mode is independent from the historical CNN-only configuration", () => {
  assert.equal(deepGoPlusHybridConfigFromEnv({}).mode, "unconfigured");
  assert.equal(
    deepGoPlusHybridConfigFromEnv({ DEEPGOPLUS_HYBRID_MODE: "disabled" }).mode,
    "disabled",
  );
  assert.throws(
    () => deepGoPlusHybridConfigFromEnv({ DEEPGOPLUS_HYBRID_MODE: "cnn" }),
    /must be disabled or local/,
  );
});

test("hybrid batch binds every DIAMOND/model artifact and preserves components", async () => {
  const setup = await fixture();
  try {
    const result = await runDeepGoPlusHybridBatch(
      [{ caseId: "CASE_001_HYBRID", sequence: "ACDEFGHIK" }],
      setup.config,
      { run: async (request) => resultFor(request) },
    );
    assert.equal(result.method.sourceType, "deepgoplus_hybrid");
    assert.equal(result.method.architecture, "sequence_cnn_plus_diamond");
    assert.match(result.method.annotationsSha256, /^[a-f0-9]{64}$/);
    assert.match(result.method.diamondDatabaseSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.method.diamondArguments, [
      "blastp", "--more-sensitive", "--outfmt", "6",
      "qseqid", "sseqid", "bitscore", "pident", "length", "qlen", "slen",
    ]);
    assert.equal(result.cases[0].diamondHitCount, 3);
    assert.equal(result.cases[0].predictions[0].agentDirectDiamondScore, 0.6);
    assert.equal(result.cases[0].predictions[0].agentDirectHybridScore, 0.481);
    assert.equal(result.cases[0].predictions[1].propagated, true);
    assert.equal(result.cases[0].predictions[2].score, null);
    assert.equal(result.cases[0].predictions[2].agentDirectHybridScore, 0.462);
  } finally {
    await setup.cleanup();
  }
});

test("hybrid candidate receipt is reconstructable and exact training matches quarantine rows", async () => {
  const setup = await fixture();
  try {
    const sequence = "ACDEFGHIK";
    const baseEvidence = {
      schema_version: "pi-function-evidence.v3",
      protein: {
        header: "anonymous_query",
        sequence_sha256: sha256Text(sequence),
      },
      evidence_ids: ["BASE-2", "BASE-1"],
    };
    const baseHash = hashCanonical(baseEvidence);
    const clean = await collectDeepGoPlusHybridCandidateSource({
      sequence,
      baseFrozenEvidenceSetHash: baseHash,
      env: environment(setup.config),
      dependencies: { run: async (request) => resultFor(request) },
    });
    assert.ok(clean);
    assert.equal(clean.candidate_sources.go_candidates.length, 2);
    assert.equal(
      clean.candidate_sources.go_candidates[0].base_score,
      0.481,
    );
    assert.equal(
      clean.candidate_sources.go_candidates[1].base_score,
      0.462,
    );
    assert.ok(clean.candidate_sources.go_candidates.every((row) =>
      row.source_type === "deepgoplus_hybrid"
      && row.query_like === false
      && row.provenance_root.startsWith("deepgoplus-hybrid:")));
    const receipt = clean.candidate_sources.deepgoplus_receipt!;
    assert.equal(receipt.homology_component, "diamond_executed");
    assert.equal(
      receipt.ontology_propagation,
      "host_safe_closure_from_agent_direct_rows",
    );
    assert.equal(receipt.agent_direct_candidate_count, 2);
    assert.equal(
      receipt.agent_direct_candidate_set_hash,
      hashCanonical(clean.candidate_sources.go_candidates.map((candidate) => ({
        go_id: candidate.go_id,
        term_name: candidate.term_name,
        aspect: candidate.aspect,
        base_score: candidate.base_score,
        query_like: candidate.query_like,
        evidence_id: candidate.evidence_id,
        provenance_root: candidate.provenance_root,
      }))),
    );
    assert.equal(receipt.top_diamond_donors[0].taxonId, "9606");
    const evidence = attachCandidateSources(baseEvidence, clean);
    const binding = learnedPredictorBindingFromEvidenceBundle(evidence);
    assert.equal(binding?.sourceType, "deepgoplus_hybrid");
    assert.equal(binding?.methodHash, receipt.method_hash);

    const frozenBatch = await runDeepGoPlusHybridBatch(
      [{ caseId: "CASE_FROZEN_BATCH", sequence }],
      setup.config,
      { run: async (request) => resultFor(request) },
    );
    const replayed = deepGoPlusHybridCandidateSourceFromBatchCase({
      sequence,
      baseFrozenEvidenceSetHash: baseHash,
      batch: frozenBatch,
      caseId: "CASE_FROZEN_BATCH",
    });
    assert.deepEqual(
      replayed.candidate_sources.go_candidates,
      clean.candidate_sources.go_candidates,
    );
    assert.equal(
      replayed.candidate_sources.deepgoplus_receipt?.request_sha256,
      receipt.request_sha256,
    );
    assert.equal(
      learnedPredictorBindingFromEvidenceBundle(
        attachCandidateSources(baseEvidence, replayed),
      )?.sourceType,
      "deepgoplus_hybrid",
    );

    const exact = await collectDeepGoPlusHybridCandidateSource({
      sequence,
      baseFrozenEvidenceSetHash: baseHash,
      env: environment(setup.config),
      dependencies: { run: async (request) => resultFor(request, 1) },
    });
    assert.ok(exact?.candidate_sources.go_candidates.every((row) =>
      row.query_like === true));
    assert.match(
      exact?.candidate_sources.providers[0].reason ?? "",
      /quarantined/,
    );

    const nearExact = await collectDeepGoPlusHybridCandidateSource({
      sequence,
      baseFrozenEvidenceSetHash: baseHash,
      env: environment(setup.config),
      dependencies: { run: async (request) => resultFor(request, 0, 1) },
    });
    assert.ok(nearExact?.candidate_sources.go_candidates.every((row) =>
      row.query_like === false));
    assert.match(
      nearExact?.candidate_sources.providers[0].reason ?? "",
      /retained as legitimate homology evidence/,
    );
    assert.equal(
      learnedPredictorBindingFromEvidenceBundle(
        attachCandidateSources(baseEvidence, nearExact!),
      )?.sourceType,
      "deepgoplus_hybrid",
    );
  } finally {
    await setup.cleanup();
  }
});

test("hybrid receipt or component-accounting tampering fails closed", async () => {
  const setup = await fixture();
  try {
    await assert.rejects(
      runDeepGoPlusHybridBatch(
        [{ caseId: "CASE_001_HYBRID", sequence: "ACDEFGHIK" }],
        setup.config,
        {
          run: async (request) => {
            const value = resultFor(request);
            const item = (value.cases as Array<Record<string, unknown>>)[0];
            const prediction = (item.predictions as Array<Record<string, unknown>>)[0];
            prediction.agentDirectHybridScore = 0.9;
            return value;
          },
        },
      ),
      /prediction\/component hash/,
    );
  } finally {
    await setup.cleanup();
  }
});
