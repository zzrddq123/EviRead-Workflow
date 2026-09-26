import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { loadGenome } from "./genome.js";
import {
  assertLearnedPredictorCompleteness,
  type LearnedPredictorBinding,
} from "./learned_predictor_contract.js";
import type { AgentGenome } from "./types.js";

const HASH = "a".repeat(64);

function enabledGenome(source: "mdeepfri_cnn" | "mdeepfri_gcn" | "deepgoplus_cnn"): AgentGenome {
  return {
    schemaVersion: "pi-agent-genome.v1",
    genomeId: `learned-${source}`,
    parentGenomeId: null,
    generation: 1,
    evidencePolicy: { mode: "fixed_full_pipeline", requiredInputs: ["sequence"] },
    goPolicy: {
      methodId: "fixture",
      evidenceWeights: { MODEL: 1 },
      unknownEvidenceWeight: 0,
      lineageFloor: 0,
      lineageRange: 1,
      domainStructurePenalty: 1,
      globalStructureCoverageFloor: 0,
      minimumDonorGroupSupport: 0,
      minimumIndependentProvenanceRoots: 1,
      thresholds: {
        molecular_function: 0,
        biological_process: 0,
        cellular_component: 0,
      },
      maxSelectedTermsPerAspect: 1,
      requireTwoStructureDonorGroups: true,
      learnedPredictorPolicy: {
        mode: "candidate_channel",
        allowedSources: [source] as ["mdeepfri_cnn"] | ["mdeepfri_gcn"] | ["deepgoplus_cnn"],
        allowedAspects: ["molecular_function"],
        minimumScore: 0,
        scoreScale: 1,
        requireIndependentRoots: 1,
      },
    },
    narrativePolicy: { defaultMode: "deterministic", maxRevisionCycles: 0 },
    improvementPolicy: {
      enabled: false,
      externalFeedbackRequired: true,
      promotionEvaluator: "not_configured_in_mvp",
    },
    claimBoundary: "Fixture-only learned predictor completeness genome.",
  };
}

function binding(source: "mdeepfri_cnn" | "mdeepfri_gcn"): LearnedPredictorBinding {
  return {
    provider: "mDeepFRI",
    sourceType: source,
    overlayHash: HASH,
    methodHash: "b".repeat(64),
    predictionSetHash: "c".repeat(64),
    baseFrozenEvidenceSetHash: "d".repeat(64),
  };
}

function deepGoPlusBinding(): LearnedPredictorBinding {
  return {
    provider: "DeepGOPlus",
    sourceType: "deepgoplus_cnn",
    overlayHash: HASH,
    methodHash: "b".repeat(64),
    predictionSetHash: "c".repeat(64),
    baseFrozenEvidenceSetHash: "d".repeat(64),
  };
}

test("baseline genomes do not require a learned predictor binding", async () => {
  const baseline = await loadGenome(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"));
  assert.doesNotThrow(() => assertLearnedPredictorCompleteness({
    genome: baseline.genome,
    binding: null,
    boundary: "live prediction",
  }));
});

test("enabled learned phenotype rejects a missing binding instead of donor-only fallback", () => {
  assert.throws(() => assertLearnedPredictorCompleteness({
    genome: enabledGenome("mdeepfri_cnn"),
    binding: null,
    boundary: "frozen evidence replay",
  }), /mdeepfri_cnn is enabled.*no hash-bound.*refusing silent donor-only fallback/);
});

test("enabled learned phenotype rejects an architecture-mismatched binding", () => {
  assert.throws(() => assertLearnedPredictorCompleteness({
    genome: enabledGenome("mdeepfri_cnn"),
    binding: binding("mdeepfri_gcn"),
    boundary: "frozen evidence replay",
  }), /requires mdeepfri_cnn.*supplied binding is mdeepfri_gcn.*refusing architecture fallback/);
});

test("enabled learned phenotype rejects a malformed hash binding", () => {
  assert.throws(() => assertLearnedPredictorCompleteness({
    genome: enabledGenome("mdeepfri_cnn"),
    binding: { ...binding("mdeepfri_cnn"), overlayHash: "not-a-hash" },
    boundary: "frozen evidence replay",
  }), /overlayHash is not a canonical SHA-256 binding/);
});

test("enabled learned phenotype accepts the matching complete hash binding", () => {
  assert.doesNotThrow(() => assertLearnedPredictorCompleteness({
    genome: enabledGenome("mdeepfri_cnn"),
    binding: binding("mdeepfri_cnn"),
    boundary: "frozen evidence replay",
  }));
});

test("DeepGOPlus phenotype requires the DeepGOPlus provider and accepts its bound receipt", () => {
  assert.throws(() => assertLearnedPredictorCompleteness({
    genome: enabledGenome("deepgoplus_cnn"),
    binding: binding("mdeepfri_cnn"),
    boundary: "live prediction",
  }), /expected provider DeepGOPlus, received mDeepFRI/);
  assert.doesNotThrow(() => assertLearnedPredictorCompleteness({
    genome: enabledGenome("deepgoplus_cnn"),
    binding: deepGoPlusBinding(),
    boundary: "live prediction",
  }));
});

test("an expected learned method hash prevents model substitution", () => {
  const genome = enabledGenome("deepgoplus_cnn");
  genome.goPolicy.learnedPredictorPolicy!.expectedMethodHash = "e".repeat(64);
  assert.throws(() => assertLearnedPredictorCompleteness({
    genome,
    binding: deepGoPlusBinding(),
    boundary: "live prediction",
  }), /policy requires method e{64}.*refusing model substitution/);
  assert.doesNotThrow(() => assertLearnedPredictorCompleteness({
    genome,
    binding: { ...deepGoPlusBinding(), methodHash: "e".repeat(64) },
    boundary: "live prediction",
  }));
});
