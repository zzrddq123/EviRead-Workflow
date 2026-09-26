import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { PROJECT_ROOT } from "./config.js";
import { hashCanonical, sha256File, sha256Text } from "./hash.js";
import type {
  SnakeCaseCandidateSourceBundle,
  SnakeCaseGOCandidate,
} from "./remote_candidate_providers.js";

const HASH = /^[a-f0-9]{64}$/;
const GO_ID = /^GO:\d{7}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.+@-]{0,127}$/;
const SEQUENCE = /^[ACDEFGHIKLMNPQRSTVWYBZXOU]+$/;
const ASPECTS = [
  "molecular_function",
  "biological_process",
  "cellular_component",
] as const;
const DIAMOND_ARGUMENTS = [
  "blastp",
  "--more-sensitive",
  "--outfmt",
  "6",
  "qseqid",
  "sseqid",
  "bitscore",
  "pident",
  "length",
  "qlen",
  "slen",
] as const;
const MAX_DONOR_AUDIT = 20;

export const DEEPGOPLUS_HYBRID_SOURCE_TYPE = "deepgoplus_hybrid" as const;
export const DEEPGOPLUS_HYBRID_REQUEST_SCHEMA =
  "pi-deepgoplus-hybrid-run-request.v1" as const;
export const DEEPGOPLUS_HYBRID_RESULT_SCHEMA =
  "pi-deepgoplus-hybrid-run-result.v1" as const;
export const DEEPGOPLUS_HYBRID_RECEIPT_SCHEMA =
  "pi-deepgoplus-hybrid-candidate-receipt.v1" as const;

export type DeepGoPlusHybridMode = "unconfigured" | "disabled" | "local";
export type DeepGoPlusHybridAspect = typeof ASPECTS[number];

export interface DeepGoPlusHybridConfig {
  mode: DeepGoPlusHybridMode;
  pythonExecutable?: string;
  runnerPath?: string;
  modelPath?: string;
  termsPath?: string;
  ontologyPath?: string;
  annotationsPath?: string;
  diamondDatabasePath?: string;
  trainingFastaPath?: string;
  metadataPath?: string;
  diamondExecutablePath?: string;
  packageVersion?: string;
  tensorflowVersion?: string;
  numpyVersion?: string;
  pandasVersion?: string;
  dataRelease?: string;
  exportMinimumScore: number;
  timeoutMs: number;
  maxStdoutBytes: number;
}

export interface DeepGoPlusHybridCaseInput {
  caseId: string;
  sequence: string;
}

export interface DeepGoPlusHybridPrediction {
  goId: string;
  termName: string;
  aspect: DeepGoPlusHybridAspect;
  /** Stock DeepGOPlus final score; null for raw-annotation-only Agent rows. */
  score: number | null;
  directHybridScore: number | null;
  directCnnScore: number | null;
  directDiamondScore: number | null;
  agentDirectDiamondScore: number | null;
  agentDirectHybridScore: number | null;
  propagated: boolean;
}

export interface DeepGoPlusHybridDonorAudit {
  subjectId: string;
  accession: string | null;
  taxonId: string | null;
  bitScore: number;
  percentIdentity: number;
  alignmentLength: number;
  queryLength: number;
  subjectLength: number;
  queryCoverage: number;
  subjectCoverage: number;
  nearExact: boolean;
}

export interface DeepGoPlusHybridCaseResult {
  caseId: string;
  sequenceSha256: string;
  diamondHitCount: number;
  hasDiamondHit: boolean;
  exactTrainingSequenceMatchCount: number;
  nearExactTrainingSequenceMatchCount: number;
  hasNearExactTrainingSequenceMatch: boolean;
  topDiamondDonors: DeepGoPlusHybridDonorAudit[];
  predictions: DeepGoPlusHybridPrediction[];
}

export interface DeepGoPlusHybridMethodBinding {
  provider: "DeepGOPlus";
  sourceType: typeof DEEPGOPLUS_HYBRID_SOURCE_TYPE;
  architecture: "sequence_cnn_plus_diamond";
  packageName: "deepgoplus";
  packageVersion: string;
  pythonExecutableSha256: string;
  tensorflowVersion: string;
  numpyVersion: string;
  pandasVersion: string;
  dataRelease: string;
  runnerSha256: string;
  modelSha256: string;
  termsSha256: string;
  ontologySha256: string;
  annotationsSha256: string;
  diamondDatabaseSha256: string;
  trainingFastaSha256: string;
  metadataSha256: string;
  diamondExecutableSha256: string;
  exportMinimumScore: number;
  diamondArguments: readonly string[];
  methodHash: string;
}

export interface DeepGoPlusHybridCandidateReceipt extends Record<string, unknown> {
  schema_version: typeof DEEPGOPLUS_HYBRID_RECEIPT_SCHEMA;
  provider: "DeepGOPlus";
  source_type: typeof DEEPGOPLUS_HYBRID_SOURCE_TYPE;
  architecture: "sequence_cnn_plus_diamond";
  package_version: string;
  python_executable_sha256: string;
  tensorflow_version: string;
  numpy_version: string;
  pandas_version: string;
  data_release: string;
  runner_sha256: string;
  model_sha256: string;
  terms_sha256: string;
  ontology_sha256: string;
  annotations_sha256: string;
  diamond_database_sha256: string;
  training_fasta_sha256: string;
  metadata_sha256: string;
  diamond_executable_sha256: string;
  method_hash: string;
  request_sha256: string;
  prediction_set_hash: string;
  base_frozen_evidence_set_hash: string;
  score_semantics:
    "raw_stock_final_for_audit_and_unpropagated_agent_direct_for_candidates";
  stock_score_semantics:
    "stock_prop_annotations_diamond_plus_cnn_post_all_relation_ontology";
  agent_candidate_score_semantics:
    "raw_annotations_diamond_plus_cnn_direct_pre_ontology";
  homology_component: "diamond_executed";
  ontology_propagation: "host_safe_closure_from_agent_direct_rows";
  diamond_hit_count: number;
  exact_training_sequence_match_count: number;
  near_exact_training_sequence_match_count: number;
  query_like_policy: "quarantine_all_rows_for_exact_training_sequence_case";
  agent_direct_candidate_floor: number;
  agent_direct_candidate_count: number;
  agent_direct_candidate_set_hash: string;
  top_diamond_donors: DeepGoPlusHybridDonorAudit[];
  canonical_hash: string;
}

export interface DeepGoPlusHybridBatchResult {
  method: DeepGoPlusHybridMethodBinding;
  requestSha256: string;
  predictionSetHash: string;
  cases: DeepGoPlusHybridCaseResult[];
}

export interface DeepGoPlusHybridDependencies {
  run?: (
    request: Record<string, unknown>,
    config: DeepGoPlusHybridConfig,
  ) => Promise<unknown>;
}

export type DeepGoPlusHybridCandidateSourceBundle =
  SnakeCaseCandidateSourceBundle & {
    candidate_sources: SnakeCaseCandidateSourceBundle["candidate_sources"] & {
      deepgoplus_receipt?: DeepGoPlusHybridCandidateReceipt;
    };
  };

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an invalid field set`);
  }
}

function boundedNumber(
  raw: string | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)
    || value < minimum
    || value > maximum
    || (integer && !Number.isSafeInteger(value))) {
    throw new Error(
      `${label} must be ${integer ? "an integer" : "a number"} in [${minimum},${maximum}]`,
    );
  }
  return value;
}

function configuredPath(value: string | undefined, fallback: string): string {
  const configured = value?.trim() || fallback;
  return isAbsolute(configured) ? configured : resolve(PROJECT_ROOT, configured);
}

function optionalSafeId(value: string | undefined, label: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!SAFE_ID.test(normalized)) throw new Error(`${label} must be a path-free identifier`);
  return normalized;
}

export function deepGoPlusHybridConfigFromEnv(
  env: NodeJS.ProcessEnv,
): DeepGoPlusHybridConfig {
  const rawMode = (
    env.DEEPGOPLUS_HYBRID_MODE
    ?? env.DEEPGOPLUS_MODE
    ?? ""
  ).trim().toLowerCase();
  const mode: DeepGoPlusHybridMode = rawMode === ""
    ? "unconfigured"
    : rawMode === "disabled" || rawMode === "local"
      ? rawMode
      : (() => {
        throw new Error("DEEPGOPLUS_HYBRID_MODE must be disabled or local");
      })();
  const base = env.DEEPGOPLUS_DATA_ROOT?.trim();
  const pythonExecutable = configuredPath(
    env.DEEPGOPLUS_PYTHON,
    ".runtime/predictors/deepgoplus-cnn-v1/bin/python",
  );
  return {
    mode,
    ...(mode === "local" ? {
      pythonExecutable,
      runnerPath: configuredPath(
        env.DEEPGOPLUS_HYBRID_RUNNER,
        "python/deepgoplus_hybrid_predictor.py",
      ),
      modelPath: configuredPath(
        env.DEEPGOPLUS_MODEL,
        base ? resolve(base, "model.h5") : ".databases/deepgoplus-v1/model.h5",
      ),
      termsPath: configuredPath(
        env.DEEPGOPLUS_TERMS,
        base ? resolve(base, "terms.pkl") : ".databases/deepgoplus-v1/terms.pkl",
      ),
      ontologyPath: configuredPath(
        env.DEEPGOPLUS_ONTOLOGY,
        base ? resolve(base, "go.obo") : ".databases/deepgoplus-v1/go.obo",
      ),
      annotationsPath: configuredPath(
        env.DEEPGOPLUS_ANNOTATIONS,
        base ? resolve(base, "train_data.pkl") : ".databases/deepgoplus-v1/train_data.pkl",
      ),
      diamondDatabasePath: configuredPath(
        env.DEEPGOPLUS_DIAMOND_DATABASE,
        base ? resolve(base, "train_data.dmnd") : ".databases/deepgoplus-v1/train_data.dmnd",
      ),
      trainingFastaPath: configuredPath(
        env.DEEPGOPLUS_TRAINING_FASTA,
        base ? resolve(base, "train_data.fa") : ".databases/deepgoplus-v1/train_data.fa",
      ),
      metadataPath: configuredPath(
        env.DEEPGOPLUS_METADATA,
        base
          ? resolve(base, "metadata", "last_release.json")
          : ".databases/deepgoplus-v1/metadata/last_release.json",
      ),
      diamondExecutablePath: configuredPath(
        env.DEEPGOPLUS_DIAMOND_EXECUTABLE,
        resolve(dirname(pythonExecutable), "diamond"),
      ),
      packageVersion: optionalSafeId(
        env.DEEPGOPLUS_PACKAGE_VERSION,
        "DEEPGOPLUS_PACKAGE_VERSION",
      ),
      tensorflowVersion: optionalSafeId(
        env.DEEPGOPLUS_TENSORFLOW_VERSION,
        "DEEPGOPLUS_TENSORFLOW_VERSION",
      ),
      numpyVersion: optionalSafeId(
        env.DEEPGOPLUS_NUMPY_VERSION,
        "DEEPGOPLUS_NUMPY_VERSION",
      ),
      pandasVersion: optionalSafeId(
        env.DEEPGOPLUS_PANDAS_VERSION,
        "DEEPGOPLUS_PANDAS_VERSION",
      ),
      dataRelease: optionalSafeId(
        env.DEEPGOPLUS_DATA_RELEASE,
        "DEEPGOPLUS_DATA_RELEASE",
      ),
    } : {}),
    exportMinimumScore: boundedNumber(
      env.DEEPGOPLUS_HYBRID_EXPORT_MINIMUM_SCORE,
      0.1,
      "DEEPGOPLUS_HYBRID_EXPORT_MINIMUM_SCORE",
      0,
      1,
    ),
    timeoutMs: boundedNumber(
      env.DEEPGOPLUS_HYBRID_TIMEOUT_MS ?? env.DEEPGOPLUS_TIMEOUT_MS,
      900_000,
      "DEEPGOPLUS_HYBRID_TIMEOUT_MS",
      1,
      3_600_000,
      true,
    ),
    maxStdoutBytes: boundedNumber(
      env.DEEPGOPLUS_MAX_STDOUT_BYTES,
      50 * 1024 * 1024,
      "DEEPGOPLUS_MAX_STDOUT_BYTES",
      1,
      100 * 1024 * 1024,
      true,
    ),
  };
}

async function ordinaryResolvedPath(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  const stat = await lstat(absolute).catch(() => null);
  if (!stat || (!stat.isFile() && !stat.isSymbolicLink())) {
    throw new Error(`${label} does not exist`);
  }
  const resolved = await realpath(absolute);
  const target = await lstat(resolved);
  if (!target.isFile()) throw new Error(`${label} must resolve to an ordinary file`);
  return resolved;
}

function normalizeCases(
  cases: readonly DeepGoPlusHybridCaseInput[],
): Array<DeepGoPlusHybridCaseInput & { sequenceSha256: string }> {
  if (cases.length < 1 || cases.length > 1000) {
    throw new Error("DeepGOPlus hybrid requires 1-1000 cases");
  }
  const normalized = cases.map((item, index) => {
    const caseId = item.caseId.trim();
    const sequence = item.sequence.trim().toUpperCase();
    if (!SAFE_ID.test(caseId)) {
      throw new Error(`DeepGOPlus hybrid case ${index + 1} has an invalid caseId`);
    }
    if (!SEQUENCE.test(sequence) || sequence.length > 10_000) {
      throw new Error(`DeepGOPlus hybrid case ${caseId} has an invalid protein sequence`);
    }
    return { caseId, sequence, sequenceSha256: sha256Text(sequence) };
  });
  if (new Set(normalized.map((item) => item.caseId)).size !== normalized.length) {
    throw new Error("DeepGOPlus hybrid case IDs must be unique");
  }
  if (normalized.reduce((sum, item) => sum + item.sequence.length, 0) > 2_000_000) {
    throw new Error("DeepGOPlus hybrid total sequence length exceeds the limit");
  }
  return normalized;
}

async function methodAndArtifacts(config: DeepGoPlusHybridConfig): Promise<{
  method: DeepGoPlusHybridMethodBinding;
  artifacts: Record<string, string>;
}> {
  if (config.mode !== "local"
    || !config.pythonExecutable
    || !config.runnerPath
    || !config.modelPath
    || !config.termsPath
    || !config.ontologyPath
    || !config.annotationsPath
    || !config.diamondDatabasePath
    || !config.trainingFastaPath
    || !config.metadataPath
    || !config.diamondExecutablePath
    || !config.packageVersion
    || !config.tensorflowVersion
    || !config.numpyVersion
    || !config.pandasVersion
    || !config.dataRelease) {
    throw new Error(
      "DeepGOPlus hybrid local mode requires runner/model/terms/ontology/"
      + "annotations/DIAMOND/training/metadata paths and release identifiers",
    );
  }
  const artifacts = {
    runnerPath: await ordinaryResolvedPath(config.runnerPath, "DeepGOPlus hybrid runner"),
    modelPath: await ordinaryResolvedPath(config.modelPath, "DeepGOPlus model"),
    termsPath: await ordinaryResolvedPath(config.termsPath, "DeepGOPlus terms"),
    ontologyPath: await ordinaryResolvedPath(config.ontologyPath, "DeepGOPlus ontology"),
    annotationsPath: await ordinaryResolvedPath(
      config.annotationsPath,
      "DeepGOPlus annotations",
    ),
    diamondDatabasePath: await ordinaryResolvedPath(
      config.diamondDatabasePath,
      "DeepGOPlus DIAMOND database",
    ),
    trainingFastaPath: await ordinaryResolvedPath(
      config.trainingFastaPath,
      "DeepGOPlus training FASTA",
    ),
    metadataPath: await ordinaryResolvedPath(config.metadataPath, "DeepGOPlus metadata"),
    diamondExecutablePath: await ordinaryResolvedPath(
      config.diamondExecutablePath,
      "DeepGOPlus DIAMOND executable",
    ),
  };
  const content = {
    provider: "DeepGOPlus" as const,
    sourceType: DEEPGOPLUS_HYBRID_SOURCE_TYPE,
    architecture: "sequence_cnn_plus_diamond" as const,
    packageName: "deepgoplus" as const,
    packageVersion: config.packageVersion,
    pythonExecutableSha256: await sha256File(
      await ordinaryResolvedPath(
        config.pythonExecutable!,
        "DeepGOPlus Python executable",
      ),
    ),
    tensorflowVersion: config.tensorflowVersion,
    numpyVersion: config.numpyVersion,
    pandasVersion: config.pandasVersion,
    dataRelease: config.dataRelease,
    runnerSha256: await sha256File(artifacts.runnerPath),
    modelSha256: await sha256File(artifacts.modelPath),
    termsSha256: await sha256File(artifacts.termsPath),
    ontologySha256: await sha256File(artifacts.ontologyPath),
    annotationsSha256: await sha256File(artifacts.annotationsPath),
    diamondDatabaseSha256: await sha256File(artifacts.diamondDatabasePath),
    trainingFastaSha256: await sha256File(artifacts.trainingFastaPath),
    metadataSha256: await sha256File(artifacts.metadataPath),
    diamondExecutableSha256: await sha256File(artifacts.diamondExecutablePath),
    exportMinimumScore: config.exportMinimumScore,
    diamondArguments: [...DIAMOND_ARGUMENTS],
  };
  return {
    method: { ...content, methodHash: hashCanonical(content) },
    artifacts,
  };
}

function nullableUnit(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > 1) {
    throw new Error(`${label} must be null or within [0,1]`);
  }
  return value;
}

function nullableBoundedString(
  value: unknown,
  label: string,
  maximumLength: number,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string"
    || value.trim() === ""
    || value.length > maximumLength
    || value.includes("\0")) {
    throw new Error(`${label} must be null or a bounded non-empty string`);
  }
  return value;
}

function parseDonorAudit(
  raw: unknown,
  label: string,
): DeepGoPlusHybridDonorAudit {
  const donor = record(raw, label);
  exactKeys(donor, [
    "subjectId",
    "accession",
    "taxonId",
    "bitScore",
    "percentIdentity",
    "alignmentLength",
    "queryLength",
    "subjectLength",
    "queryCoverage",
    "subjectCoverage",
    "nearExact",
  ], label);
  if (typeof donor.subjectId !== "string"
    || donor.subjectId.trim() === ""
    || donor.subjectId.length > 256
    || typeof donor.bitScore !== "number"
    || !Number.isFinite(donor.bitScore)
    || donor.bitScore <= 0
    || typeof donor.percentIdentity !== "number"
    || !Number.isFinite(donor.percentIdentity)
    || donor.percentIdentity < 0
    || donor.percentIdentity > 100
    || !Number.isSafeInteger(donor.alignmentLength)
    || Number(donor.alignmentLength) <= 0
    || !Number.isSafeInteger(donor.queryLength)
    || Number(donor.queryLength) <= 0
    || !Number.isSafeInteger(donor.subjectLength)
    || Number(donor.subjectLength) <= 0
    || typeof donor.queryCoverage !== "number"
    || !Number.isFinite(donor.queryCoverage)
    || donor.queryCoverage <= 0
    || donor.queryCoverage > 1
    || typeof donor.subjectCoverage !== "number"
    || !Number.isFinite(donor.subjectCoverage)
    || donor.subjectCoverage <= 0
    || donor.subjectCoverage > 1
    || typeof donor.nearExact !== "boolean") {
    throw new Error(`${label} has invalid similarity metrics`);
  }
  const computedNearExact = donor.percentIdentity >= 99
    && donor.queryCoverage >= 0.95
    && donor.subjectCoverage >= 0.95;
  if (donor.nearExact !== computedNearExact) {
    throw new Error(`${label} near-exact classification is inconsistent`);
  }
  return {
    subjectId: donor.subjectId,
    accession: nullableBoundedString(donor.accession, `${label}.accession`, 128),
    taxonId: nullableBoundedString(donor.taxonId, `${label}.taxonId`, 64),
    bitScore: donor.bitScore,
    percentIdentity: donor.percentIdentity,
    alignmentLength: Number(donor.alignmentLength),
    queryLength: Number(donor.queryLength),
    subjectLength: Number(donor.subjectLength),
    queryCoverage: donor.queryCoverage,
    subjectCoverage: donor.subjectCoverage,
    nearExact: donor.nearExact,
  };
}

function fixed(value: number | null): string | null {
  return value === null ? null : value.toFixed(9);
}

function componentHashProjection(
  cases: readonly DeepGoPlusHybridCaseResult[],
): unknown {
  return cases.map((item) => ({
    caseId: item.caseId,
    sequenceSha256: item.sequenceSha256,
    diamondHitCount: item.diamondHitCount,
    hasDiamondHit: item.hasDiamondHit,
    exactTrainingSequenceMatchCount: item.exactTrainingSequenceMatchCount,
    nearExactTrainingSequenceMatchCount:
      item.nearExactTrainingSequenceMatchCount,
    hasNearExactTrainingSequenceMatch:
      item.hasNearExactTrainingSequenceMatch,
    topDiamondDonors: item.topDiamondDonors.map((donor) => ({
      subjectId: donor.subjectId,
      accession: donor.accession,
      taxonId: donor.taxonId,
      bitScore: fixed(donor.bitScore),
      percentIdentity: fixed(donor.percentIdentity),
      alignmentLength: donor.alignmentLength,
      queryLength: donor.queryLength,
      subjectLength: donor.subjectLength,
      queryCoverage: fixed(donor.queryCoverage),
      subjectCoverage: fixed(donor.subjectCoverage),
      nearExact: donor.nearExact,
    })),
    predictions: item.predictions.map((prediction) => ({
      goId: prediction.goId,
      termName: prediction.termName,
      aspect: prediction.aspect,
      score: fixed(prediction.score),
      directHybridScore: fixed(prediction.directHybridScore),
      directCnnScore: fixed(prediction.directCnnScore),
      directDiamondScore: fixed(prediction.directDiamondScore),
      agentDirectDiamondScore: fixed(prediction.agentDirectDiamondScore),
      agentDirectHybridScore: fixed(prediction.agentDirectHybridScore),
      propagated: prediction.propagated,
    })),
  }));
}

export function deepGoPlusHybridComponentProjectionHash(
  cases: readonly DeepGoPlusHybridCaseResult[],
): string {
  return hashCanonical(componentHashProjection(cases));
}

function parseResult(
  value: unknown,
  method: DeepGoPlusHybridMethodBinding,
  expectedCases: readonly { caseId: string; sequenceSha256: string }[],
): {
  cases: DeepGoPlusHybridCaseResult[];
  predictionSetHash: string;
} {
  const root = record(value, "DeepGOPlus hybrid result");
  exactKeys(
    root,
    ["schemaVersion", "methodHash", "predictionSetHash", "cases"],
    "DeepGOPlus hybrid result",
  );
  if (root.schemaVersion !== DEEPGOPLUS_HYBRID_RESULT_SCHEMA
    || root.methodHash !== method.methodHash
    || typeof root.predictionSetHash !== "string"
    || !HASH.test(root.predictionSetHash)
    || !Array.isArray(root.cases)
    || root.cases.length !== expectedCases.length) {
    throw new Error("DeepGOPlus hybrid result binding/accounting is invalid");
  }
  const cases = root.cases.map((raw, caseIndex) => {
    const item = record(raw, `DeepGOPlus hybrid cases[${caseIndex}]`);
    exactKeys(item, [
      "caseId",
      "sequenceSha256",
      "diamondHitCount",
      "hasDiamondHit",
      "exactTrainingSequenceMatchCount",
      "nearExactTrainingSequenceMatchCount",
      "hasNearExactTrainingSequenceMatch",
      "topDiamondDonors",
      "predictions",
    ], `DeepGOPlus hybrid cases[${caseIndex}]`);
    const expected = expectedCases[caseIndex];
    if (item.caseId !== expected.caseId
      || item.sequenceSha256 !== expected.sequenceSha256
      || !Number.isSafeInteger(item.diamondHitCount)
      || Number(item.diamondHitCount) < 0
      || item.hasDiamondHit !== (Number(item.diamondHitCount) > 0)
      || !Number.isSafeInteger(item.exactTrainingSequenceMatchCount)
      || Number(item.exactTrainingSequenceMatchCount) < 0
      || !Number.isSafeInteger(item.nearExactTrainingSequenceMatchCount)
      || Number(item.nearExactTrainingSequenceMatchCount) < 0
      || item.hasNearExactTrainingSequenceMatch
        !== (Number(item.nearExactTrainingSequenceMatchCount) > 0)
      || !Array.isArray(item.topDiamondDonors)
      || item.topDiamondDonors.length > MAX_DONOR_AUDIT
      || !Array.isArray(item.predictions)) {
      throw new Error("DeepGOPlus hybrid case binding or hit accounting is invalid");
    }
    const topDiamondDonors = item.topDiamondDonors.map((rawDonor, donorIndex) =>
      parseDonorAudit(
        rawDonor,
        `DeepGOPlus hybrid ${expected.caseId} topDiamondDonors[${donorIndex}]`,
      ));
    if (new Set(topDiamondDonors.map((donor) => donor.subjectId)).size
        !== topDiamondDonors.length
      || topDiamondDonors.some(
        (donor, donorIndex) => donorIndex > 0
          && (Number(topDiamondDonors[donorIndex - 1].nearExact)
              < Number(donor.nearExact)
            || (topDiamondDonors[donorIndex - 1].nearExact === donor.nearExact
              && topDiamondDonors[donorIndex - 1].bitScore < donor.bitScore)),
      )
      || topDiamondDonors.filter((donor) => donor.nearExact).length
        > Number(item.nearExactTrainingSequenceMatchCount)) {
      throw new Error(
        `DeepGOPlus hybrid ${expected.caseId} donor audit is inconsistent`,
      );
    }
    const predictions = item.predictions.map((rawPrediction, predictionIndex) => {
      const prediction = record(
        rawPrediction,
        `DeepGOPlus hybrid ${expected.caseId} predictions[${predictionIndex}]`,
      );
      exactKeys(prediction, [
        "goId",
        "termName",
        "aspect",
        "score",
        "directHybridScore",
        "directCnnScore",
        "directDiamondScore",
        "agentDirectDiamondScore",
        "agentDirectHybridScore",
        "propagated",
      ], `DeepGOPlus hybrid ${expected.caseId} prediction`);
      if (typeof prediction.goId !== "string"
        || !GO_ID.test(prediction.goId)
        || typeof prediction.termName !== "string"
        || prediction.termName.trim() === ""
        || !(ASPECTS as readonly unknown[]).includes(prediction.aspect)
        || typeof prediction.propagated !== "boolean") {
        throw new Error(`DeepGOPlus hybrid ${expected.caseId} has an invalid prediction`);
      }
      const score = nullableUnit(prediction.score, "score");
      const directHybridScore = nullableUnit(
        prediction.directHybridScore,
        "directHybridScore",
      );
      const directCnnScore = nullableUnit(
        prediction.directCnnScore,
        "directCnnScore",
      );
      const directDiamondScore = nullableUnit(
        prediction.directDiamondScore,
        "directDiamondScore",
      );
      const agentDirectDiamondScore = nullableUnit(
        prediction.agentDirectDiamondScore,
        "agentDirectDiamondScore",
      );
      const agentDirectHybridScore = nullableUnit(
        prediction.agentDirectHybridScore,
        "agentDirectHybridScore",
      );
      if ((score === null || score < method.exportMinimumScore)
        && (agentDirectHybridScore === null
          || agentDirectHybridScore <= method.exportMinimumScore)) {
        throw new Error(
          `DeepGOPlus hybrid ${expected.caseId} prediction is below both export floors`,
        );
      }
      if (score === null && prediction.propagated) {
        throw new Error(
          `DeepGOPlus hybrid ${expected.caseId} raw-only prediction cannot be propagated`,
        );
      }
      return {
        goId: prediction.goId,
        termName: prediction.termName.trim(),
        aspect: prediction.aspect as DeepGoPlusHybridAspect,
        score,
        directHybridScore,
        directCnnScore,
        directDiamondScore,
        agentDirectDiamondScore,
        agentDirectHybridScore,
        propagated: prediction.propagated,
      };
    });
    const sorted = [...predictions].sort((left, right) =>
      left.goId.localeCompare(right.goId));
    if (JSON.stringify(sorted) !== JSON.stringify(predictions)
      || new Set(predictions.map((prediction) => prediction.goId)).size
        !== predictions.length) {
      throw new Error(
        `DeepGOPlus hybrid ${expected.caseId} predictions are not uniquely sorted`,
      );
    }
    return {
      caseId: expected.caseId,
      sequenceSha256: expected.sequenceSha256,
      diamondHitCount: Number(item.diamondHitCount),
      hasDiamondHit: Boolean(item.hasDiamondHit),
      exactTrainingSequenceMatchCount: Number(item.exactTrainingSequenceMatchCount),
      nearExactTrainingSequenceMatchCount:
        Number(item.nearExactTrainingSequenceMatchCount),
      hasNearExactTrainingSequenceMatch:
        Boolean(item.hasNearExactTrainingSequenceMatch),
      topDiamondDonors,
      predictions,
    };
  });
  if (root.predictionSetHash !== deepGoPlusHybridComponentProjectionHash(cases)) {
    throw new Error(
      "DeepGOPlus hybrid prediction/component hash does not match all result fields",
    );
  }
  return { cases, predictionSetHash: root.predictionSetHash };
}

async function defaultRun(
  request: Record<string, unknown>,
  config: DeepGoPlusHybridConfig,
): Promise<unknown> {
  if (!config.pythonExecutable) {
    throw new Error("DeepGOPlus hybrid Python executable is missing");
  }
  const executable = await ordinaryResolvedPath(
    config.pythonExecutable,
    "DeepGOPlus hybrid Python executable",
  );
  const environment: NodeJS.ProcessEnv = { PYTHONNOUSERSITE: "1" };
  for (const name of [
    "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return await new Promise<unknown>((resolvePromise, rejectPromise) => {
    const runnerPath = String(
      record(request.artifacts, "DeepGOPlus hybrid artifacts").runnerPath,
    );
    const child = spawn(executable, ["-I", runnerPath], {
      cwd: PROJECT_ROOT,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("DeepGOPlus hybrid runner timed out"));
    }, config.timeoutMs);
    child.on("error", (error) =>
      finish(new Error(`DeepGOPlus hybrid runner failed to start: ${error.message}`)));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > config.maxStdoutBytes) {
        child.kill("SIGKILL");
        finish(new Error("DeepGOPlus hybrid runner exceeded its stdout limit"));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 16_384) return;
      const copy = Buffer.from(chunk).subarray(0, 16_384 - stderrBytes);
      stderrBytes += copy.length;
      stderr.push(copy);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 2000);
        finish(
          new Error(
            `DeepGOPlus hybrid runner exited with ${code ?? signal}: ${detail}`,
          ),
        );
        return;
      }
      try {
        finish(
          undefined,
          JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown,
        );
      } catch (error) {
        finish(
          new Error(
            `DeepGOPlus hybrid runner returned invalid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`, "utf8");
  });
}

export async function runDeepGoPlusHybridBatch(
  casesInput: readonly DeepGoPlusHybridCaseInput[],
  config: DeepGoPlusHybridConfig,
  dependencies: DeepGoPlusHybridDependencies = {},
): Promise<DeepGoPlusHybridBatchResult> {
  const cases = normalizeCases(casesInput);
  const { method, artifacts } = await methodAndArtifacts(config);
  const request = {
    schemaVersion: DEEPGOPLUS_HYBRID_REQUEST_SCHEMA,
    method,
    artifacts,
    cases,
  };
  const requestSha256 = hashCanonical({
    schemaVersion: DEEPGOPLUS_HYBRID_REQUEST_SCHEMA,
    methodHash: method.methodHash,
    cases: cases.map(({ caseId, sequenceSha256 }) => ({
      caseId,
      sequenceSha256,
    })),
  });
  const raw = await (dependencies.run ?? defaultRun)(request, config);
  const parsed = parseResult(raw, method, cases);
  return {
    method,
    requestSha256,
    predictionSetHash: parsed.predictionSetHash,
    cases: parsed.cases,
  };
}

function providerRecord(input: {
  status: "completed" | "disabled";
  release: string | null;
  requestSha256: string | null;
  payloadSha256: string | null;
  reason: string | null;
}): SnakeCaseCandidateSourceBundle["candidate_sources"]["providers"][number] {
  return {
    provider: "DeepGOPlus",
    status: input.status,
    endpoint_or_path: input.payloadSha256
      ? `local:hybrid-bound:${input.payloadSha256.slice(0, 16)}`
      : "local:disabled",
    release: input.release,
    request_sha256: input.requestSha256,
    payload_sha256: input.payloadSha256,
    cache_hit: false,
    reason: input.reason,
  };
}

export async function collectDeepGoPlusHybridCandidateSource(input: {
  sequence: string;
  baseFrozenEvidenceSetHash: string;
  env: NodeJS.ProcessEnv;
  dependencies?: DeepGoPlusHybridDependencies;
}): Promise<DeepGoPlusHybridCandidateSourceBundle | null> {
  const config = deepGoPlusHybridConfigFromEnv(input.env);
  if (config.mode === "unconfigured") return null;
  if (config.mode === "disabled") {
    return {
      candidate_sources: {
        providers: [providerRecord({
          status: "disabled",
          release: null,
          requestSha256: null,
          payloadSha256: null,
          reason: "DEEPGOPLUS_HYBRID_MODE=disabled",
        })],
        go_candidates: [],
      },
    };
  }
  if (!HASH.test(input.baseFrozenEvidenceSetHash)) {
    throw new Error(
      "DeepGOPlus hybrid requires a canonical base frozen evidence-set hash",
    );
  }
  const sequence = input.sequence.trim().toUpperCase();
  const sequenceSha256 = sha256Text(sequence);
  const caseId = `DGPH_${sequenceSha256.slice(0, 16).toUpperCase()}`;
  const batch = await runDeepGoPlusHybridBatch(
    [{ caseId, sequence }],
    config,
    input.dependencies,
  );
  return deepGoPlusHybridCandidateSourceFromBatchCase({
    sequence,
    baseFrozenEvidenceSetHash: input.baseFrozenEvidenceSetHash,
    batch,
    caseId,
  });
}

/**
 * Reconstruct the exact single-case candidate overlay from a case that was
 * already executed inside a larger, frozen DeepGOPlus batch.
 *
 * The learned-predictor receipt is deliberately normalized to the same
 * anonymous singleton request identity used by the live adapter. The
 * underlying method binding and every case result field come directly from
 * the frozen batch; no model process is re-run.
 */
export function deepGoPlusHybridCandidateSourceFromBatchCase(input: {
  sequence: string;
  baseFrozenEvidenceSetHash: string;
  batch: DeepGoPlusHybridBatchResult;
  caseId: string;
}): DeepGoPlusHybridCandidateSourceBundle {
  if (!HASH.test(input.baseFrozenEvidenceSetHash)) {
    throw new Error(
      "DeepGOPlus hybrid replay requires a canonical base frozen evidence-set hash",
    );
  }
  const sequence = input.sequence.trim().toUpperCase();
  if (!SEQUENCE.test(sequence)) {
    throw new Error("DeepGOPlus hybrid replay sequence is invalid");
  }
  const sequenceSha256 = sha256Text(sequence);
  const matches = input.batch.cases.filter((item) => item.caseId === input.caseId);
  if (matches.length !== 1 || matches[0].sequenceSha256 !== sequenceSha256) {
    throw new Error(
      "DeepGOPlus hybrid replay case is not uniquely sequence-bound to the frozen batch",
    );
  }
  const sourceItem = matches[0];
  const singletonCaseId = `DGPH_${sequenceSha256.slice(0, 16).toUpperCase()}`;
  const item: DeepGoPlusHybridCaseResult = {
    ...sourceItem,
    caseId: singletonCaseId,
  };
  const requestSha256 = hashCanonical({
    schemaVersion: DEEPGOPLUS_HYBRID_REQUEST_SCHEMA,
    methodHash: input.batch.method.methodHash,
    cases: [{ caseId: singletonCaseId, sequenceSha256 }],
  });
  const predictionSetHash = deepGoPlusHybridComponentProjectionHash([item]);
  const dependencyRoot =
    `deepgoplus-hybrid:${sha256Text(`${input.batch.method.methodHash}\0${sequenceSha256}`)}`;
  const exactMatch = item.exactTrainingSequenceMatchCount > 0;
  const queryLike = exactMatch;
  const directPredictions = item.predictions.filter(
    (prediction) => prediction.agentDirectHybridScore !== null
      && prediction.agentDirectHybridScore
        > input.batch.method.exportMinimumScore,
  );
  const candidates: SnakeCaseGOCandidate[] = directPredictions.map((prediction) => {
    const candidateScore = prediction.agentDirectHybridScore!;
    const token = sha256Text(
      `${dependencyRoot}\0${prediction.goId}\0${candidateScore}`,
    );
    return {
      schema_version: "pi-go-candidate.v1",
      go_id: prediction.goId,
      term_name: prediction.termName,
      aspect: prediction.aspect,
      source_type: DEEPGOPLUS_HYBRID_SOURCE_TYPE,
      source_id:
        `deepgoplus_hybrid:${input.batch.method.methodHash.slice(0, 16)}`,
      mapping_id: `deepgoplus_hybrid:${prediction.goId}`,
      provider: "DeepGOPlus",
      provider_release:
        `${input.batch.method.packageVersion};data-${input.batch.method.dataRelease}`,
      provider_payload_sha256: predictionSetHash,
      evidence_id: `CAND-DGPH-${token.slice(0, 20).toUpperCase()}`,
      provenance_root: dependencyRoot,
      base_score: candidateScore,
      query_coverage: null,
      domain_range: null,
      query_like: queryLike,
      annotation_evidence_code: "MODEL_HOMOLOGY",
      donor_accession: null,
      phylogeny: null,
    };
  });
  const receiptContent = {
    schema_version: DEEPGOPLUS_HYBRID_RECEIPT_SCHEMA,
    provider: "DeepGOPlus",
    source_type: DEEPGOPLUS_HYBRID_SOURCE_TYPE,
    architecture: "sequence_cnn_plus_diamond",
    package_version: input.batch.method.packageVersion,
    python_executable_sha256: input.batch.method.pythonExecutableSha256,
    tensorflow_version: input.batch.method.tensorflowVersion,
    numpy_version: input.batch.method.numpyVersion,
    pandas_version: input.batch.method.pandasVersion,
    data_release: input.batch.method.dataRelease,
    runner_sha256: input.batch.method.runnerSha256,
    model_sha256: input.batch.method.modelSha256,
    terms_sha256: input.batch.method.termsSha256,
    ontology_sha256: input.batch.method.ontologySha256,
    annotations_sha256: input.batch.method.annotationsSha256,
    diamond_database_sha256: input.batch.method.diamondDatabaseSha256,
    training_fasta_sha256: input.batch.method.trainingFastaSha256,
    metadata_sha256: input.batch.method.metadataSha256,
    diamond_executable_sha256: input.batch.method.diamondExecutableSha256,
    method_hash: input.batch.method.methodHash,
    request_sha256: requestSha256,
    prediction_set_hash: predictionSetHash,
    base_frozen_evidence_set_hash: input.baseFrozenEvidenceSetHash,
    score_semantics:
      "raw_stock_final_for_audit_and_unpropagated_agent_direct_for_candidates",
    stock_score_semantics:
      "stock_prop_annotations_diamond_plus_cnn_post_all_relation_ontology",
    agent_candidate_score_semantics:
      "raw_annotations_diamond_plus_cnn_direct_pre_ontology",
    homology_component: "diamond_executed",
    ontology_propagation: "host_safe_closure_from_agent_direct_rows",
    diamond_hit_count: item.diamondHitCount,
    exact_training_sequence_match_count: item.exactTrainingSequenceMatchCount,
    near_exact_training_sequence_match_count:
      item.nearExactTrainingSequenceMatchCount,
    query_like_policy: "quarantine_all_rows_for_exact_training_sequence_case",
    agent_direct_candidate_floor: input.batch.method.exportMinimumScore,
    agent_direct_candidate_count: candidates.length,
    agent_direct_candidate_set_hash: hashCanonical(candidates.map((candidate) => ({
      go_id: candidate.go_id,
      term_name: candidate.term_name,
      aspect: candidate.aspect,
      base_score: candidate.base_score,
      query_like: candidate.query_like,
      evidence_id: candidate.evidence_id,
      provenance_root: candidate.provenance_root,
    }))),
    top_diamond_donors: item.topDiamondDonors,
  } as const;
  const receipt: DeepGoPlusHybridCandidateReceipt = {
    ...receiptContent,
    canonical_hash: hashCanonical(receiptContent),
  };
  return {
    candidate_sources: {
      providers: [providerRecord({
        status: "completed",
        release:
          `${input.batch.method.packageVersion};data-${input.batch.method.dataRelease}`,
        requestSha256,
        payloadSha256: predictionSetHash,
        reason: queryLike
          ? `Full DIAMOND+CNN completed with ${item.diamondHitCount} hit(s); `
            + `${item.exactTrainingSequenceMatchCount} exact and `
            + `${item.nearExactTrainingSequenceMatchCount} near-exact `
            + "training match(es); the exact match caused all agent-direct rows "
            + "to be quarantined."
          : `Full DIAMOND+CNN completed with ${item.diamondHitCount} hit(s); `
            + `${candidates.length} unpropagated agent-direct row(s) were exported; `
            + `${item.nearExactTrainingSequenceMatchCount} near-exact match(es) `
            + "were retained as legitimate homology evidence; the stock final "
            + "vector remains audit-only.",
      })],
      go_candidates: candidates,
      deepgoplus_receipt: receipt,
    },
  };
}
