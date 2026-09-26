import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  collectDeepGoPlusCandidateSource,
  deepGoPlusConfigFromEnv,
  runDeepGoPlusBatch,
  type DeepGoPlusConfig,
} from "./deepgoplus.js";
import { attachCandidateSources } from "./candidate_stage.js";
import { hashCanonical, sha256Text } from "./hash.js";
import { learnedPredictorBindingFromEvidenceBundle } from "./learned_predictor_contract.js";

async function fixture(): Promise<{
  root: string;
  config: DeepGoPlusConfig;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "deepgoplus-adapter-"));
  const modelPath = join(root, "model.h5");
  const termsPath = join(root, "terms.pkl");
  const ontologyPath = join(root, "go.obo");
  await writeFile(modelPath, "model", "utf8");
  await writeFile(termsPath, "terms", "utf8");
  await writeFile(ontologyPath, "ontology", "utf8");
  return {
    root,
    config: {
      mode: "local",
      pythonExecutable: "/usr/bin/true",
      runnerPath: resolve("python/deepgoplus_cnn_predictor.py"),
      modelPath,
      termsPath,
      ontologyPath,
      packageVersion: "1.0.2",
      dataRelease: "1.0.28",
      exportMinimumScore: 0.01,
      timeoutMs: 1000,
      maxStdoutBytes: 1024 * 1024,
    },
    cleanup: async () => await rm(root, { recursive: true, force: true }),
  };
}

test("DeepGOPlus remains byte-compatible when no mode is configured", () => {
  assert.equal(deepGoPlusConfigFromEnv({}).mode, "unconfigured");
  assert.equal(deepGoPlusConfigFromEnv({ DEEPGOPLUS_MODE: "disabled" }).mode, "disabled");
  assert.throws(
    () => deepGoPlusConfigFromEnv({ DEEPGOPLUS_MODE: "hybrid" }),
    /must be disabled or local/,
  );
});

test("batch contract binds model artifacts and accepts sorted direct CNN predictions", async () => {
  const setup = await fixture();
  try {
    let observedRequest: Record<string, unknown> | undefined;
    const result = await runDeepGoPlusBatch(
      [{ caseId: "CASE_001_TEST0001", sequence: "ACDEFGHIK" }],
      setup.config,
      {
        run: async (request) => {
          observedRequest = request;
          const method = request.method as Record<string, unknown>;
          const cases = request.cases as Array<Record<string, unknown>>;
          return {
            schemaVersion: "pi-deepgoplus-cnn-run-result.v1",
            methodHash: method.methodHash,
            cases: [{
              caseId: cases[0].caseId,
              sequenceSha256: cases[0].sequenceSha256,
              predictions: [
                {
                  goId: "GO:0000001",
                  termName: "test molecular function",
                  aspect: "molecular_function",
                  score: 0.75,
                },
              ],
            }],
          };
        },
      },
    );
    assert.ok(observedRequest);
    assert.equal(result.method.provider, "DeepGOPlus");
    assert.equal(result.method.sourceType, "deepgoplus_cnn");
    assert.equal(result.method.architecture, "sequence_cnn");
    assert.match(result.method.methodHash, /^[a-f0-9]{64}$/);
    assert.equal(result.cases[0].predictions[0].score, 0.75);
    assert.match(result.predictionSetHash, /^[a-f0-9]{64}$/);
  } finally {
    await setup.cleanup();
  }
});

test("candidate adapter emits one CNN provenance root and a hash-complete receipt", async () => {
  const setup = await fixture();
  try {
    const sequence = "ACDEFGHIK";
    const baseEvidence = {
      schema_version: "pi-function-evidence.v3",
      protein: {
        header: "anonymous_query",
        sequence_sha256: sha256Text(sequence),
      },
      // Deliberately non-lexical: attachment must preserve the base ordering
      // so receipt validation can reconstruct the pre-candidate hash.
      evidence_ids: ["SEQ-BASE-2", "INTRINSIC-BASE-1"],
    };
    const baseEvidenceHash = hashCanonical(baseEvidence);
    const env = {
      DEEPGOPLUS_MODE: "local",
      DEEPGOPLUS_PYTHON: setup.config.pythonExecutable,
      DEEPGOPLUS_RUNNER: setup.config.runnerPath,
      DEEPGOPLUS_MODEL: setup.config.modelPath,
      DEEPGOPLUS_TERMS: setup.config.termsPath,
      DEEPGOPLUS_ONTOLOGY: setup.config.ontologyPath,
      DEEPGOPLUS_PACKAGE_VERSION: setup.config.packageVersion,
      DEEPGOPLUS_DATA_RELEASE: setup.config.dataRelease,
    };
    const bundle = await collectDeepGoPlusCandidateSource({
      sequence,
      baseFrozenEvidenceSetHash: baseEvidenceHash,
      env,
      dependencies: {
        run: async (request) => {
          const method = request.method as Record<string, unknown>;
          const cases = request.cases as Array<Record<string, unknown>>;
          return {
            schemaVersion: "pi-deepgoplus-cnn-run-result.v1",
            methodHash: method.methodHash,
            cases: [{
              caseId: cases[0].caseId,
              sequenceSha256: cases[0].sequenceSha256,
              predictions: [
                { goId: "GO:0000001", termName: "one", aspect: "molecular_function", score: 0.7 },
                { goId: "GO:0000002", termName: "two", aspect: "biological_process", score: 0.4 },
              ],
            }],
          };
        },
      },
    });
    assert.ok(bundle);
    const candidates = bundle.candidate_sources.go_candidates;
    assert.equal(candidates.length, 2);
    assert.deepEqual(new Set(candidates.map((item) => item.provenance_root)).size, 1);
    assert.ok(candidates.every((item) =>
      item.source_type === "deepgoplus_cnn"
      && item.provider === "DeepGOPlus"
      && item.annotation_evidence_code === "MODEL"));
    const receipt = bundle.candidate_sources.deepgoplus_receipt!;
    assert.equal(receipt.score_semantics, "direct_cnn_head_pre_ontology");
    assert.equal(receipt.homology_component, "not_executed");
    assert.equal(receipt.ontology_propagation, "host_only");
    assert.equal(receipt.base_frozen_evidence_set_hash, baseEvidenceHash);
    assert.match(receipt.canonical_hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(receipt).includes(setup.root), false);

    const evidenceBundle = attachCandidateSources(baseEvidence, bundle);
    assert.deepEqual(
      (evidenceBundle.evidence_ids as string[]).slice(0, 2),
      baseEvidence.evidence_ids,
    );
    const binding = learnedPredictorBindingFromEvidenceBundle(evidenceBundle);
    assert.equal(binding?.provider, "DeepGOPlus");
    assert.equal(binding?.sourceType, "deepgoplus_cnn");
    assert.equal(binding?.overlayHash, receipt.canonical_hash);

    const forgedCanonicalHash = structuredClone(evidenceBundle);
    (forgedCanonicalHash.candidate_sources as Record<string, unknown>).deepgoplus_receipt = {
      ...receipt,
      canonical_hash: "f".repeat(64),
    };
    assert.equal(
      learnedPredictorBindingFromEvidenceBundle(forgedCanonicalHash),
      null,
      "a SHA-shaped but non-canonical receipt must not manufacture a binding",
    );

    const transplantedProvider = structuredClone(evidenceBundle);
    const transplantedSources = transplantedProvider.candidate_sources as Record<string, unknown>;
    const transplantedReceipt = structuredClone(receipt) as Record<string, unknown>;
    transplantedReceipt.prediction_set_hash = "e".repeat(64);
    const { canonical_hash: _oldCanonicalHash, ...transplantedContent } = transplantedReceipt;
    transplantedReceipt.canonical_hash = hashCanonical(transplantedContent);
    transplantedSources.deepgoplus_receipt = transplantedReceipt;
    assert.equal(
      learnedPredictorBindingFromEvidenceBundle(transplantedProvider),
      null,
      "receipt prediction identity must match the completed provider payload",
    );

    const alteredCandidate = structuredClone(evidenceBundle);
    const alteredSources = alteredCandidate.candidate_sources as Record<string, unknown>;
    const alteredRows = alteredSources.go_candidates as Array<Record<string, unknown>>;
    alteredRows[0].provider_payload_sha256 = "d".repeat(64);
    assert.equal(
      learnedPredictorBindingFromEvidenceBundle(alteredCandidate),
      null,
      "every DeepGOPlus row must bind the receipt payload",
    );

    const alteredBase = structuredClone(evidenceBundle);
    (alteredBase.protein as Record<string, unknown>).sequence_length = 999;
    assert.equal(
      learnedPredictorBindingFromEvidenceBundle(alteredBase),
      null,
      "a receipt cannot be transplanted onto a different frozen evidence base",
    );
  } finally {
    await setup.cleanup();
  }
});

test("adapter rejects reordered and below-floor runner output", async () => {
  const setup = await fixture();
  try {
    await assert.rejects(
      runDeepGoPlusBatch(
        [{ caseId: "CASE_001_TEST0001", sequence: "ACDEFGHIK" }],
        { ...setup.config, exportMinimumScore: 0.2 },
        {
          run: async (request) => {
            const method = request.method as Record<string, unknown>;
            const cases = request.cases as Array<Record<string, unknown>>;
            return {
              schemaVersion: "pi-deepgoplus-cnn-run-result.v1",
              methodHash: method.methodHash,
              cases: [{
                caseId: cases[0].caseId,
                sequenceSha256: cases[0].sequenceSha256,
                predictions: [
                  { goId: "GO:0000002", termName: "two", aspect: "biological_process", score: 0.4 },
                  { goId: "GO:0000001", termName: "one", aspect: "molecular_function", score: 0.1 },
                ],
              }],
            };
          },
        },
      ),
      /invalid prediction|not uniquely sorted/,
    );
  } finally {
    await setup.cleanup();
  }
});

test("disabled mode records an explicit non-execution without a learned receipt", async () => {
  const result = await collectDeepGoPlusCandidateSource({
    sequence: "ACDEFGHIK",
    baseFrozenEvidenceSetHash: "",
    env: { DEEPGOPLUS_MODE: "disabled" },
  });
  assert.equal(result?.candidate_sources.providers[0].status, "disabled");
  assert.equal(result?.candidate_sources.go_candidates.length, 0);
  assert.equal(result?.candidate_sources.deepgoplus_receipt, undefined);
});
