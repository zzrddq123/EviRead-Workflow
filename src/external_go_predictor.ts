import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import {
  loadBatchManifest,
  loadPublicManifest,
  type PublicBenchmarkManifest,
} from "./benchmark_io.js";
import {
  assertEvidenceAcquisitionReceipt,
  type EvidenceAcquisitionReceipt,
} from "./evidence_acquisition.js";
import { parseEnvFile, PROJECT_ROOT } from "./config.js";
import { canonicalJson, hashCanonical, sha256File, sha256Text } from "./hash.js";

type JsonObject = Record<string, unknown>;

const HASH = /^[a-f0-9]{64}$/;
const GO_ID = /^GO:\d{7}$/;
const CASE_ID = /^CASE_[0-9]{3}_[A-F0-9]{8}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.+@-]{0,127}$/;
const ASPECTS = ["molecular_function", "biological_process", "cellular_component"] as const;
const SOURCE_TYPE = "mdeepfri_cnn" as const;
const PROVIDER = "mDeepFRI" as const;
const ANNOTATION_CODE = "MODEL" as const;

export type ExternalGoPredictorAspect = typeof ASPECTS[number];

export interface ExternalGoPredictorToolInput {
  toolName: string;
  packageName: string;
  packageVersion: string;
}

export interface ExternalGoPredictorModelFileBinding {
  aspect: ExternalGoPredictorAspect;
  paramsSha256: string;
  onnxSha256: string;
}

export interface ExternalGoPredictorMethodBinding extends ExternalGoPredictorToolInput {
  provider: typeof PROVIDER;
  sourceType: typeof SOURCE_TYPE;
  annotationEvidenceCode: typeof ANNOTATION_CODE;
  architecture: "cnn";
  /** Explicit score floor applied by the runner before predictions are exported. */
  exportMinimumScore: number;
  runnerSha256: string;
  /** Hash of the complete, canonically ordered three-aspect model set. */
  modelSha256: string;
  modelConfigSha256: string;
  modelFiles: ExternalGoPredictorModelFileBinding[];
  methodHash: string;
}

export interface ExternalGoPredictorPublicCaseBinding {
  caseId: string;
  sequenceSha256: string;
}

export interface ExternalGoPredictorBaseBinding {
  suiteId: string;
  publicManifestHash: string;
  baseBatchManifestHash: string;
  acquisitionPlanHash: string;
  acquisitionReceiptHash: string;
  baseFrozenEvidenceSetHash: string;
  orderedPublicCases: ExternalGoPredictorPublicCaseBinding[];
}

export interface ExternalGoPredictorRawPrediction {
  goId: string;
  termName: string;
  aspect: ExternalGoPredictorAspect;
  score: number;
}

/**
 * Snake-case by design: this record can be appended directly to the evidence
 * bundle consumed by the candidate-source normalizer.
 */
export interface MDeepFriCnnCandidateRow {
  schema_version: "pi-go-candidate.v1";
  go_id: string;
  term_name: string;
  aspect: ExternalGoPredictorAspect;
  source_type: typeof SOURCE_TYPE;
  source_id: string;
  mapping_id: string;
  provider: typeof PROVIDER;
  provider_release: string;
  provider_payload_sha256: string;
  evidence_id: string;
  provenance_root: string;
  base_score: number;
  query_coverage: null;
  domain_range: null;
  query_like: false;
  annotation_evidence_code: typeof ANNOTATION_CODE;
  donor_accession: null;
  phylogeny: null;
}

export interface ExternalGoPredictorOverlayCase {
  caseId: string;
  sequenceSha256: string;
  requestSha256: string;
  dependencyRoot: string;
  rawPredictionHash: string;
  rawPredictions: ExternalGoPredictorRawPrediction[];
  candidates: MDeepFriCnnCandidateRow[];
  canonicalHash: string;
}

export interface ExternalGoPredictorOverlay extends JsonObject {
  schemaVersion: "pi-external-go-predictor-overlay.v1";
  base: ExternalGoPredictorBaseBinding;
  method: ExternalGoPredictorMethodBinding;
  caseCount: number;
  cases: ExternalGoPredictorOverlayCase[];
  predictionSetHash: string;
  claimBoundary: string;
  canonicalHash: string;
}

export interface ExternalGoPredictorRunnerRequest {
  schemaVersion: "pi-external-go-predictor-run-request.v1";
  method: ExternalGoPredictorMethodBinding;
  artifacts: {
    modelConfigPath: string;
    modelFiles: Array<{
      aspect: ExternalGoPredictorAspect;
      paramsPath: string;
      onnxPath: string;
    }>;
  };
  cases: Array<ExternalGoPredictorPublicCaseBinding & { sequence: string }>;
}

export type ExternalGoPredictorRunner = (
  request: ExternalGoPredictorRunnerRequest,
) => Promise<unknown>;

export interface ExternalGoPredictorDependencies {
  run?: ExternalGoPredictorRunner;
}

export interface GenerateExternalGoPredictorOverlayInput {
  publicDir: string;
  batchDir: string;
  /** Defaults to the evaluator-owned receipt under the batch directory. */
  acquisitionReceiptPath?: string;
  baseFrozenEvidenceSetHash: string;
  runnerPath: string;
  modelConfigPath: string;
  /** Exactly one CNN model for each GO aspect, in canonical aspect order. */
  modelFiles: Array<{
    aspect: ExternalGoPredictorAspect;
    paramsPath: string;
    onnxPath: string;
  }>;
  /** Required and provenance-bound; this channel has no implicit score floor. */
  exportMinimumScore: number;
  tool: ExternalGoPredictorToolInput;
  pythonExecutable?: string;
  runnerTimeoutMs?: number;
  runnerMaxStdoutBytes?: number;
}

export interface ExternalGoPredictorExpectedBindings {
  suiteId?: string;
  publicManifestHash?: string;
  baseBatchManifestHash?: string;
  acquisitionPlanHash?: string;
  acquisitionReceiptHash?: string;
  baseFrozenEvidenceSetHash?: string;
  orderedPublicCases?: readonly ExternalGoPredictorPublicCaseBinding[];
  methodHash?: string;
}

function record(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an invalid field set`);
  }
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be a SHA-256 hash`);
  return value;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} must be a path-free identifier`);
  }
  return value;
}

function assertNoPathLeak(value: string, label: string): void {
  const looksLikePath = isAbsolute(value)
    || win32.isAbsolute(value)
    || /^file:/i.test(value)
    || /(?:^|[\s"'(])\/(?:Users|home|tmp|private|var|etc)\//i.test(value)
    || /\\Users\\/i.test(value)
    || value.includes("\0");
  if (looksLikePath) throw new Error(`${label} contains a filesystem path`);
}

function safeTermName(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is empty or unsafe`);
  }
  assertNoPathLeak(normalized, label);
  return normalized;
}

function unitScore(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite score in [0,1]`);
  }
  return Math.round(value * 1_000_000) / 1_000_000;
}

function withCanonicalHash<T extends JsonObject>(value: T): T & { canonicalHash: string } {
  const { canonicalHash: _ignored, ...content } = value;
  return { ...content, canonicalHash: hashCanonical(content) } as T & { canonicalHash: string };
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let cursor = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`path contains a symbolic link: ${cursor}`);
  }
}

async function ordinaryDirectory(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  await assertNoSymlinkComponents(absolute);
  const stat = await lstat(absolute).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be an ordinary directory`);
  return absolute;
}

async function ordinaryFile(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  await assertNoSymlinkComponents(absolute);
  const stat = await lstat(absolute).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error(`${label} must be a non-empty ordinary file`);
  }
  return absolute;
}

async function ordinaryJson(path: string, label: string): Promise<unknown> {
  const ordinary = await ordinaryFile(path, label);
  try {
    return JSON.parse(await readFile(ordinary, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseAnonymousFasta(source: string, expectedLength: number, label: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim() !== "");
  const headers = lines.filter((line) => line.startsWith(">"));
  if (headers.length !== 1 || headers[0].trim() !== ">anonymous_query" || lines[0] !== headers[0]) {
    throw new Error(`${label} must contain one anonymous_query FASTA record`);
  }
  const sequence = lines.slice(1).join("").replace(/\s+/g, "").toUpperCase();
  if (!sequence || !/^[A-Z]+$/.test(sequence) || sequence.length !== expectedLength) {
    throw new Error(`${label} contains an invalid amino-acid sequence`);
  }
  return sequence;
}

function validateToolInput(value: ExternalGoPredictorToolInput): ExternalGoPredictorToolInput {
  return {
    toolName: safeId(value.toolName, "tool.toolName"),
    packageName: safeId(value.packageName, "tool.packageName"),
    packageVersion: safeId(value.packageVersion, "tool.packageVersion"),
  };
}

function methodBinding(
  toolInput: ExternalGoPredictorToolInput,
  exportMinimumScoreInput: number,
  hashes: {
    runnerSha256: string;
    modelConfigSha256: string;
    modelFiles: readonly ExternalGoPredictorModelFileBinding[];
  },
): ExternalGoPredictorMethodBinding {
  const tool = validateToolInput(toolInput);
  if (hashes.modelFiles.length !== ASPECTS.length
    || hashes.modelFiles.some((item, index) => item.aspect !== ASPECTS[index])) {
    throw new Error("method.modelFiles must contain one model per GO aspect in canonical order");
  }
  const modelFiles = hashes.modelFiles.map((item, index) => ({
    aspect: item.aspect,
    paramsSha256: hash(item.paramsSha256, `method.modelFiles[${index}].paramsSha256`),
    onnxSha256: hash(item.onnxSha256, `method.modelFiles[${index}].onnxSha256`),
  }));
  const modelConfigSha256 = hash(hashes.modelConfigSha256, "method.modelConfigSha256");
  const modelSha256 = hashCanonical({
    schemaVersion: "pi-mdeepfri-cnn-model-set.v1",
    modelConfigSha256,
    modelFiles,
  });
  const content = {
    provider: PROVIDER,
    sourceType: SOURCE_TYPE,
    annotationEvidenceCode: ANNOTATION_CODE,
    architecture: "cnn" as const,
    exportMinimumScore: unitScore(exportMinimumScoreInput, "method.exportMinimumScore"),
    ...tool,
    runnerSha256: hash(hashes.runnerSha256, "method.runnerSha256"),
    modelSha256,
    modelConfigSha256,
    modelFiles,
  };
  return { ...content, methodHash: hashCanonical(content) };
}

function normalizeRawPrediction(value: unknown, label: string): ExternalGoPredictorRawPrediction {
  const item = record(value, label);
  exactKeys(item, ["goId", "termName", "aspect", "score"], label);
  const goId = typeof item.goId === "string" ? item.goId.toUpperCase() : "";
  if (!GO_ID.test(goId)) throw new Error(`${label}.goId is invalid`);
  if (!ASPECTS.includes(item.aspect as ExternalGoPredictorAspect)) {
    throw new Error(`${label}.aspect is invalid`);
  }
  return {
    goId,
    termName: safeTermName(item.termName, `${label}.termName`),
    aspect: item.aspect as ExternalGoPredictorAspect,
    score: unitScore(item.score, `${label}.score`),
  };
}

function candidateRows(input: {
  method: ExternalGoPredictorMethodBinding;
  caseId: string;
  sequenceSha256: string;
  rawPredictionHash: string;
  dependencyRoot: string;
  predictions: readonly ExternalGoPredictorRawPrediction[];
}): MDeepFriCnnCandidateRow[] {
  const release = `${input.method.packageName}@${input.method.packageVersion}`;
  return input.predictions.map((prediction) => ({
    schema_version: "pi-go-candidate.v1",
    go_id: prediction.goId,
    term_name: prediction.termName,
    aspect: prediction.aspect,
    source_type: SOURCE_TYPE,
    source_id: `${SOURCE_TYPE}:${input.method.modelSha256.slice(0, 16)}`,
    mapping_id: `${SOURCE_TYPE}:${prediction.goId}`,
    provider: PROVIDER,
    provider_release: release,
    provider_payload_sha256: input.rawPredictionHash,
    evidence_id: `CAND-MDF-${sha256Text(`${input.caseId}\0${prediction.goId}\0${input.method.methodHash}`).slice(0, 16)}`,
    provenance_root: input.dependencyRoot,
    base_score: prediction.score,
    query_coverage: null,
    domain_range: null,
    query_like: false,
    annotation_evidence_code: ANNOTATION_CODE,
    donor_accession: null,
    phylogeny: null,
  }));
}

function normalizeRunnerOutput(
  value: unknown,
  publicCases: readonly ExternalGoPredictorPublicCaseBinding[],
  method: ExternalGoPredictorMethodBinding,
): ExternalGoPredictorOverlayCase[] {
  const root = record(typeof value === "string" ? JSON.parse(value) as unknown : value, "external predictor output");
  exactKeys(root, ["schemaVersion", "exportMinimumScore", "cases"], "external predictor output");
  if (root.schemaVersion !== "pi-external-go-predictor-run-result.v1"
    || root.exportMinimumScore !== method.exportMinimumScore
    || !Array.isArray(root.cases)) {
    throw new Error("external predictor output has an invalid schemaVersion or case list");
  }
  const byId = new Map<string, JsonObject>();
  for (const [index, rawCase] of root.cases.entries()) {
    const item = record(rawCase, `external predictor output cases[${index}]`);
    exactKeys(item, ["caseId", "sequenceSha256", "predictions"], `external predictor output cases[${index}]`);
    if (typeof item.caseId !== "string" || byId.has(item.caseId)) {
      throw new Error("external predictor output contains a missing or duplicate caseId");
    }
    byId.set(item.caseId, item);
  }
  if (byId.size !== publicCases.length) throw new Error("external predictor output is not an exact public-case cover");

  return publicCases.map((publicCase) => {
    const item = byId.get(publicCase.caseId);
    if (!item || item.sequenceSha256 !== publicCase.sequenceSha256 || !Array.isArray(item.predictions)) {
      throw new Error(`external predictor output binding failed for ${publicCase.caseId}`);
    }
    const predictions = item.predictions
      .map((prediction, index) => normalizeRawPrediction(
        prediction,
        `external predictor output ${publicCase.caseId} predictions[${index}]`,
      ))
      .sort((left, right) => left.goId.localeCompare(right.goId));
    if (predictions.some((prediction) => prediction.score < method.exportMinimumScore)) {
      throw new Error(`external predictor output contains a below-floor score for ${publicCase.caseId}`);
    }
    if (new Set(predictions.map((prediction) => prediction.goId)).size !== predictions.length) {
      throw new Error(`external predictor output contains duplicate GO IDs for ${publicCase.caseId}`);
    }
    const rawPredictionHash = hashCanonical({
      schemaVersion: "pi-external-go-predictor-normalized-case.v1",
      caseId: publicCase.caseId,
      sequenceSha256: publicCase.sequenceSha256,
      predictions,
    });
    const requestSha256 = hashCanonical({
      schemaVersion: "pi-external-go-predictor-case-request.v1",
      methodHash: method.methodHash,
      caseId: publicCase.caseId,
      sequenceSha256: publicCase.sequenceSha256,
    });
    const dependencyRoot = `mdeepfri:${sha256Text(`${method.methodHash}\0${publicCase.sequenceSha256}`).slice(0, 64)}`;
    const content = {
      caseId: publicCase.caseId,
      sequenceSha256: publicCase.sequenceSha256,
      requestSha256,
      dependencyRoot,
      rawPredictionHash,
      rawPredictions: predictions,
      candidates: candidateRows({
        method,
        caseId: publicCase.caseId,
        sequenceSha256: publicCase.sequenceSha256,
        rawPredictionHash,
        dependencyRoot,
        predictions,
      }),
    };
    return withCanonicalHash(content) as ExternalGoPredictorOverlayCase;
  });
}

function validateMethod(value: unknown): ExternalGoPredictorMethodBinding {
  const item = record(value, "external predictor method");
  exactKeys(item, [
    "provider", "sourceType", "annotationEvidenceCode", "architecture",
    "exportMinimumScore", "toolName", "packageName", "packageVersion", "runnerSha256", "modelSha256",
    "modelConfigSha256", "modelFiles", "methodHash",
  ], "external predictor method");
  if (item.provider !== PROVIDER || item.sourceType !== SOURCE_TYPE
    || item.annotationEvidenceCode !== ANNOTATION_CODE || item.architecture !== "cnn") {
    throw new Error("external predictor method is not the mDeepFRI CNN channel");
  }
  if (!Array.isArray(item.modelFiles)) throw new Error("external predictor method.modelFiles must be an array");
  const modelFiles = item.modelFiles.map((raw, index) => {
    const model = record(raw, `method.modelFiles[${index}]`);
    exactKeys(model, ["aspect", "paramsSha256", "onnxSha256"], `method.modelFiles[${index}]`);
    if (!ASPECTS.includes(model.aspect as ExternalGoPredictorAspect)) {
      throw new Error(`method.modelFiles[${index}].aspect is invalid`);
    }
    return {
      aspect: model.aspect as ExternalGoPredictorAspect,
      paramsSha256: hash(model.paramsSha256, `method.modelFiles[${index}].paramsSha256`),
      onnxSha256: hash(model.onnxSha256, `method.modelFiles[${index}].onnxSha256`),
    };
  });
  const expected = methodBinding(
    {
      toolName: safeId(item.toolName, "method.toolName"),
      packageName: safeId(item.packageName, "method.packageName"),
      packageVersion: safeId(item.packageVersion, "method.packageVersion"),
    },
    unitScore(item.exportMinimumScore, "method.exportMinimumScore"),
    {
      runnerSha256: hash(item.runnerSha256, "method.runnerSha256"),
      modelConfigSha256: hash(item.modelConfigSha256, "method.modelConfigSha256"),
      modelFiles,
    },
  );
  if (item.modelSha256 !== expected.modelSha256 || item.methodHash !== expected.methodHash) {
    throw new Error("external predictor modelSha256 or methodHash is invalid");
  }
  return expected;
}

function validatePublicCaseBindings(value: unknown): ExternalGoPredictorPublicCaseBinding[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("orderedPublicCases must be a non-empty array");
  const cases = value.map((raw, index) => {
    const item = record(raw, `orderedPublicCases[${index}]`);
    exactKeys(item, ["caseId", "sequenceSha256"], `orderedPublicCases[${index}]`);
    if (typeof item.caseId !== "string" || !CASE_ID.test(item.caseId)) {
      throw new Error(`orderedPublicCases[${index}].caseId is invalid`);
    }
    return {
      caseId: item.caseId,
      sequenceSha256: hash(item.sequenceSha256, `orderedPublicCases[${index}].sequenceSha256`),
    };
  });
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length
    || new Set(cases.map((item) => item.sequenceSha256)).size !== cases.length) {
    throw new Error("orderedPublicCases contains duplicate cases or sequences");
  }
  return cases;
}

function validateBase(value: unknown): ExternalGoPredictorBaseBinding {
  const item = record(value, "external predictor base binding");
  exactKeys(item, [
    "suiteId", "publicManifestHash", "baseBatchManifestHash", "acquisitionPlanHash",
    "acquisitionReceiptHash", "baseFrozenEvidenceSetHash", "orderedPublicCases",
  ], "external predictor base binding");
  return {
    suiteId: safeId(item.suiteId, "base.suiteId"),
    publicManifestHash: hash(item.publicManifestHash, "base.publicManifestHash"),
    baseBatchManifestHash: hash(item.baseBatchManifestHash, "base.baseBatchManifestHash"),
    acquisitionPlanHash: hash(item.acquisitionPlanHash, "base.acquisitionPlanHash"),
    acquisitionReceiptHash: hash(item.acquisitionReceiptHash, "base.acquisitionReceiptHash"),
    baseFrozenEvidenceSetHash: hash(item.baseFrozenEvidenceSetHash, "base.baseFrozenEvidenceSetHash"),
    orderedPublicCases: validatePublicCaseBindings(item.orderedPublicCases),
  };
}

function assertExpectedBindings(
  overlay: ExternalGoPredictorOverlay,
  expected: ExternalGoPredictorExpectedBindings,
): void {
  const comparisons: Array<[unknown, unknown, string]> = [
    [expected.suiteId, overlay.base.suiteId, "suiteId"],
    [expected.publicManifestHash, overlay.base.publicManifestHash, "publicManifestHash"],
    [expected.baseBatchManifestHash, overlay.base.baseBatchManifestHash, "baseBatchManifestHash"],
    [expected.acquisitionPlanHash, overlay.base.acquisitionPlanHash, "acquisitionPlanHash"],
    [expected.acquisitionReceiptHash, overlay.base.acquisitionReceiptHash, "acquisitionReceiptHash"],
    [expected.baseFrozenEvidenceSetHash, overlay.base.baseFrozenEvidenceSetHash, "baseFrozenEvidenceSetHash"],
    [expected.methodHash, overlay.method.methodHash, "methodHash"],
  ];
  for (const [wanted, actual, label] of comparisons) {
    if (wanted !== undefined && wanted !== actual) throw new Error(`external predictor ${label} binding mismatch`);
  }
  if (expected.orderedPublicCases !== undefined
    && hashCanonical(expected.orderedPublicCases) !== hashCanonical(overlay.base.orderedPublicCases)) {
    throw new Error("external predictor ordered public-case binding mismatch");
  }
}

export function validateExternalGoPredictorOverlay(
  value: unknown,
  expected: ExternalGoPredictorExpectedBindings = {},
): ExternalGoPredictorOverlay {
  const root = record(value, "external GO predictor overlay");
  exactKeys(root, [
    "schemaVersion", "base", "method", "caseCount", "cases",
    "predictionSetHash", "claimBoundary", "canonicalHash",
  ], "external GO predictor overlay");
  if (root.schemaVersion !== "pi-external-go-predictor-overlay.v1") {
    throw new Error("unsupported external GO predictor overlay schemaVersion");
  }
  const base = validateBase(root.base);
  const method = validateMethod(root.method);
  if (!Number.isSafeInteger(root.caseCount) || Number(root.caseCount) !== base.orderedPublicCases.length
    || !Array.isArray(root.cases) || root.cases.length !== base.orderedPublicCases.length) {
    throw new Error("external GO predictor overlay case accounting is invalid");
  }

  const cases = root.cases.map((raw, index) => {
    const item = record(raw, `external GO predictor overlay cases[${index}]`);
    exactKeys(item, [
      "caseId", "sequenceSha256", "requestSha256", "dependencyRoot", "rawPredictionHash",
      "rawPredictions", "candidates", "canonicalHash",
    ], `external GO predictor overlay cases[${index}]`);
    const bound = base.orderedPublicCases[index];
    if (item.caseId !== bound.caseId || item.sequenceSha256 !== bound.sequenceSha256) {
      throw new Error("external GO predictor overlay case order/binding is invalid");
    }
    if (!Array.isArray(item.rawPredictions)) throw new Error(`overlay ${bound.caseId} rawPredictions must be an array`);
    const normalized = item.rawPredictions
      .map((prediction, offset) => normalizeRawPrediction(prediction, `overlay ${bound.caseId} rawPredictions[${offset}]`));
    if (normalized.some((prediction, offset) => offset > 0
      && normalized[offset - 1].goId.localeCompare(prediction.goId) >= 0)) {
      throw new Error(`overlay ${bound.caseId} rawPredictions are not uniquely sorted`);
    }
    const rawPredictionHash = hashCanonical({
      schemaVersion: "pi-external-go-predictor-normalized-case.v1",
      caseId: bound.caseId,
      sequenceSha256: bound.sequenceSha256,
      predictions: normalized,
    });
    const requestSha256 = hashCanonical({
      schemaVersion: "pi-external-go-predictor-case-request.v1",
      methodHash: method.methodHash,
      caseId: bound.caseId,
      sequenceSha256: bound.sequenceSha256,
    });
    const dependencyRoot = `mdeepfri:${sha256Text(`${method.methodHash}\0${bound.sequenceSha256}`).slice(0, 64)}`;
    if (item.rawPredictionHash !== rawPredictionHash || item.requestSha256 !== requestSha256
      || item.dependencyRoot !== dependencyRoot) {
      throw new Error(`overlay ${bound.caseId} prediction/request/dependency binding is invalid`);
    }
    const candidates = candidateRows({
      method,
      caseId: bound.caseId,
      sequenceSha256: bound.sequenceSha256,
      rawPredictionHash,
      dependencyRoot,
      predictions: normalized,
    });
    if (hashCanonical(item.candidates) !== hashCanonical(candidates)) {
      throw new Error(`overlay ${bound.caseId} candidate projection is invalid`);
    }
    const content = {
      caseId: bound.caseId,
      sequenceSha256: bound.sequenceSha256,
      requestSha256,
      dependencyRoot,
      rawPredictionHash,
      rawPredictions: normalized,
      candidates,
    };
    const canonical = withCanonicalHash(content) as ExternalGoPredictorOverlayCase;
    if (item.canonicalHash !== canonical.canonicalHash) throw new Error(`overlay ${bound.caseId} canonicalHash is invalid`);
    return canonical;
  });
  const predictionSetHash = hashCanonical({
    schemaVersion: "pi-external-go-predictor-prediction-set.v1",
    methodHash: method.methodHash,
    cases: cases.map((item) => ({
      caseId: item.caseId,
      sequenceSha256: item.sequenceSha256,
      rawPredictionHash: item.rawPredictionHash,
    })),
  });
  if (root.predictionSetHash !== predictionSetHash) throw new Error("external predictor predictionSetHash is invalid");
  if (typeof root.claimBoundary !== "string" || root.claimBoundary.length < 1 || root.claimBoundary.length > 1000) {
    throw new Error("external predictor claimBoundary is invalid");
  }
  assertNoPathLeak(root.claimBoundary, "external predictor claimBoundary");
  const content = {
    schemaVersion: "pi-external-go-predictor-overlay.v1" as const,
    base,
    method,
    caseCount: cases.length,
    cases,
    predictionSetHash,
    claimBoundary: root.claimBoundary,
  };
  const overlay = withCanonicalHash(content) as ExternalGoPredictorOverlay;
  if (root.canonicalHash !== overlay.canonicalHash) throw new Error("external predictor overlay canonicalHash is invalid");
  assertExpectedBindings(overlay, expected);
  return overlay;
}

export async function loadExternalGoPredictorOverlay(
  path: string,
  expected: ExternalGoPredictorExpectedBindings = {},
): Promise<ExternalGoPredictorOverlay> {
  return validateExternalGoPredictorOverlay(
    await ordinaryJson(path, "external GO predictor overlay"),
    expected,
  );
}

function receiptCaseMap(receipt: EvidenceAcquisitionReceipt): Map<string, EvidenceAcquisitionReceipt["cases"][number]> {
  return new Map(receipt.cases.map((item) => [item.caseId, item]));
}

async function computeBaseFrozenEvidenceSetHash(input: {
  batchDir: string;
  manifest: PublicBenchmarkManifest;
  batchManifestHash: string;
  batchCases: Array<{ caseId: string; runDir: string; status: string; validationOk: boolean }>;
  receipt: EvidenceAcquisitionReceipt;
}): Promise<string> {
  const batchById = new Map(input.batchCases.map((item) => [item.caseId, item]));
  const receiptById = receiptCaseMap(input.receipt);
  if (batchById.size !== input.manifest.cases.length || receiptById.size !== input.manifest.cases.length) {
    throw new Error("base batch/receipt is not an exact public-case cover");
  }
  const receipts = [];
  for (const publicCase of input.manifest.cases) {
    const batchCase = batchById.get(publicCase.caseId);
    const receiptCase = receiptById.get(publicCase.caseId);
    if (!batchCase || !receiptCase || batchCase.status !== "completed" || batchCase.validationOk !== true
      || receiptCase.status !== "completed" || receiptCase.validationOk !== true) {
      throw new Error(`base batch/receipt is incomplete for ${publicCase.caseId}`);
    }
    const runDir = await ordinaryDirectory(join(input.batchDir, batchCase.runDir), `base run ${publicCase.caseId}`);
    const artifactBindings: Array<[string, string | null, string]> = [
      ["run_manifest.json", receiptCase.runManifestSha256, "run manifest"],
      ["evidence_manifest.json", receiptCase.evidenceManifestSha256, "evidence manifest"],
      ["evidence/evidence_bundle.json", receiptCase.evidenceBundleSha256, "evidence bundle"],
      ["evidence/blind_evidence_bundle.json", receiptCase.blindEvidenceBundleSha256, "blind evidence bundle"],
      ["prediction/go_predictions.json", receiptCase.goPredictionSha256, "GO prediction"],
    ];
    for (const [relativePath, expectedHash, label] of artifactBindings) {
      if (!expectedHash || await sha256File(await ordinaryFile(join(runDir, relativePath), `${publicCase.caseId} ${label}`)) !== expectedHash) {
        throw new Error(`base receipt artifact binding failed for ${publicCase.caseId} ${label}`);
      }
    }
    const evidence = record(
      await ordinaryJson(join(runDir, "evidence/evidence_bundle.json"), `${publicCase.caseId} evidence bundle`),
      `${publicCase.caseId} evidence bundle`,
    );
    const episodeTrace = record(
      await ordinaryJson(join(runDir, "prediction/episode_trace.json"), `${publicCase.caseId} episode trace`),
      `${publicCase.caseId} episode trace`,
    );
    const outputHashes = record(episodeTrace.outputHashes, `${publicCase.caseId} episode outputHashes`);
    const evidenceCanonicalHash = hashCanonical(evidence);
    if (outputHashes.evidenceBundle !== evidenceCanonicalHash) {
      throw new Error(`base evidence/episode binding failed for ${publicCase.caseId}`);
    }
    receipts.push({
      caseId: publicCase.caseId,
      fileSha256: receiptCase.evidenceBundleSha256,
      canonicalHash: evidenceCanonicalHash,
      episodeTraceHash: hashCanonical(episodeTrace),
    });
  }
  return hashCanonical({
    schemaVersion: "pi-cafa-frozen-evidence-set.v1",
    sourceBatchManifestHash: input.batchManifestHash,
    receipts,
  });
}

async function defaultRunner(input: GenerateExternalGoPredictorOverlayInput): Promise<ExternalGoPredictorRunner> {
  const timeoutMs = input.runnerTimeoutMs ?? 600_000;
  const maxStdoutBytes = input.runnerMaxStdoutBytes ?? 50 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error("runnerTimeoutMs must be an integer in [1,3600000]");
  }
  if (!Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes < 1 || maxStdoutBytes > 100 * 1024 * 1024) {
    throw new Error("runnerMaxStdoutBytes must be an integer in [1,104857600]");
  }
  const requestedExecutable = input.pythonExecutable?.trim() || "python3";
  if (!requestedExecutable || requestedExecutable.includes("\0") || /[\r\n]/.test(requestedExecutable)) {
    throw new Error("pythonExecutable is invalid");
  }
  const executable = requestedExecutable.includes("/") || requestedExecutable.includes("\\")
    ? resolve(requestedExecutable)
    : requestedExecutable;
  // The model/runtime bytes are meaningful bindings only if host Python
  // configuration cannot replace the imported modules.  Keep the small set of
  // process variables needed to locate an explicitly named interpreter and
  // create temporary files, while excluding Python/user-site, virtual-env,
  // package-manager, dynamic-loader, credential, and network configuration.
  // `-I` independently enables Python isolated mode (`-E -P -s`).
  const runnerEnvironment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  ]) {
    const value = process.env[name];
    if (value !== undefined) runnerEnvironment[name] = value;
  }
  runnerEnvironment.PYTHONNOUSERSITE = "1";
  return async (request) => await new Promise<unknown>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, ["-I", resolve(input.runnerPath)], {
      cwd: dirname(resolve(input.runnerPath)),
      env: runnerEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("external GO predictor runner timed out"));
    }, timeoutMs);
    child.on("error", (error) => finish(new Error(`external GO predictor runner failed to start: ${error.message}`)));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        child.kill("SIGKILL");
        finish(new Error("external GO predictor runner exceeded the stdout limit"));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((sum, item) => sum + item.length, 0) < 16_384) stderr.push(Buffer.from(chunk));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 2000);
        finish(new Error(`external GO predictor runner exited unsuccessfully (${String(code ?? signal)})${detail ? `: ${detail}` : ""}`));
        return;
      }
      const text = Buffer.concat(stdout).toString("utf8");
      try {
        finish(undefined, JSON.parse(text) as unknown);
      } catch (error) {
        finish(new Error(`external GO predictor runner emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.on("error", (error) => finish(new Error(`external GO predictor runner stdin failed: ${error.message}`)));
    child.stdin.end(`${JSON.stringify(request)}\n`, "utf8");
  });
}

export async function generateExternalGoPredictorOverlay(
  input: GenerateExternalGoPredictorOverlayInput,
  dependencies: ExternalGoPredictorDependencies = {},
): Promise<ExternalGoPredictorOverlay> {
  const publicDir = await ordinaryDirectory(input.publicDir, "external predictor publicDir");
  const batchDirInput = await ordinaryDirectory(input.batchDir, "external predictor batchDir");
  const receiptPath = await ordinaryFile(
    input.acquisitionReceiptPath
      ?? join(batchDirInput, "evaluation/evaluator_private/acquisition/evidence_acquisition_receipt.json"),
    "external predictor acquisition receipt",
  );
  if (!Array.isArray(input.modelFiles) || input.modelFiles.length !== ASPECTS.length
    || input.modelFiles.some((item, index) => item.aspect !== ASPECTS[index])) {
    throw new Error("external predictor modelFiles must contain MF, BP, and CC models in canonical order");
  }
  const artifacts = {
    runnerPath: await ordinaryFile(input.runnerPath, "external predictor runner"),
    modelConfigPath: await ordinaryFile(input.modelConfigPath, "external predictor model config"),
    modelFiles: await Promise.all(input.modelFiles.map(async (item, index) => ({
      aspect: item.aspect,
      paramsPath: await ordinaryFile(item.paramsPath, `external predictor ${item.aspect} params ${index + 1}`),
      onnxPath: await ordinaryFile(item.onnxPath, `external predictor ${item.aspect} ONNX model ${index + 1}`),
    }))),
  };
  const modelDirectory = dirname(artifacts.modelConfigPath);
  const modelArtifactPaths = [
    artifacts.modelConfigPath,
    ...artifacts.modelFiles.flatMap((item) => [item.paramsPath, item.onnxPath]),
  ];
  if (modelArtifactPaths.some((path) => dirname(path) !== modelDirectory)) {
    throw new Error("external predictor config and three-aspect model files must share one directory");
  }
  if (new Set(modelArtifactPaths).size !== modelArtifactPaths.length) {
    throw new Error("external predictor config and three-aspect model files must be distinct files");
  }
  const { manifest } = await loadPublicManifest(publicDir);
  const { batchDir, manifest: batch } = await loadBatchManifest(batchDirInput, manifest);
  if (batch.status !== "completed" || batch.cases.length !== manifest.cases.length) {
    throw new Error("external predictor requires a completed base batch with exact public coverage");
  }
  const receipt = assertEvidenceAcquisitionReceipt(await ordinaryJson(receiptPath, "external predictor acquisition receipt"));
  if (receipt.status !== "completed" || receipt.batchManifestHash !== batch.canonicalHash
    || receipt.acquisitionPlanHash !== batch.evidenceAcquisitionPlanHash) {
    throw new Error("external predictor acquisition receipt is not bound to the completed base batch");
  }
  const suppliedFrozenHash = hash(input.baseFrozenEvidenceSetHash, "baseFrozenEvidenceSetHash");
  const computedFrozenHash = await computeBaseFrozenEvidenceSetHash({
    batchDir,
    manifest,
    batchManifestHash: batch.canonicalHash,
    batchCases: batch.cases,
    receipt,
  });
  if (suppliedFrozenHash !== computedFrozenHash) {
    throw new Error("external predictor baseFrozenEvidenceSetHash does not match the receipt-bound base evidence");
  }
  const method = methodBinding(input.tool, input.exportMinimumScore, {
    runnerSha256: await sha256File(artifacts.runnerPath),
    modelConfigSha256: await sha256File(artifacts.modelConfigPath),
    modelFiles: await Promise.all(artifacts.modelFiles.map(async (item) => ({
      aspect: item.aspect,
      paramsSha256: await sha256File(item.paramsPath),
      onnxSha256: await sha256File(item.onnxPath),
    }))),
  });
  const orderedPublicCases = manifest.cases.map((item) => ({
    caseId: item.caseId,
    sequenceSha256: item.sequenceSha256,
  }));
  const runnerCases = await Promise.all(manifest.cases.map(async (item) => {
    const path = await ordinaryFile(join(publicDir, item.sequence), `${item.caseId} public FASTA`);
    return {
      caseId: item.caseId,
      sequenceSha256: item.sequenceSha256,
      sequence: parseAnonymousFasta(await readFile(path, "utf8"), item.length, `${item.caseId} public FASTA`),
    };
  }));
  const request: ExternalGoPredictorRunnerRequest = {
    schemaVersion: "pi-external-go-predictor-run-request.v1",
    method,
    artifacts: {
      modelConfigPath: artifacts.modelConfigPath,
      modelFiles: artifacts.modelFiles,
    },
    cases: runnerCases,
  };
  const run = dependencies.run ?? await defaultRunner(input);
  const cases = normalizeRunnerOutput(await run(request), orderedPublicCases, method);
  const base: ExternalGoPredictorBaseBinding = {
    suiteId: manifest.suiteId,
    publicManifestHash: manifest.canonicalHash,
    baseBatchManifestHash: batch.canonicalHash,
    acquisitionPlanHash: receipt.acquisitionPlanHash,
    acquisitionReceiptHash: receipt.canonicalHash,
    baseFrozenEvidenceSetHash: suppliedFrozenHash,
    orderedPublicCases,
  };
  const predictionSetHash = hashCanonical({
    schemaVersion: "pi-external-go-predictor-prediction-set.v1",
    methodHash: method.methodHash,
    cases: cases.map((item) => ({
      caseId: item.caseId,
      sequenceSha256: item.sequenceSha256,
      rawPredictionHash: item.rawPredictionHash,
    })),
  });
  return validateExternalGoPredictorOverlay(withCanonicalHash({
    schemaVersion: "pi-external-go-predictor-overlay.v1" as const,
    base,
    method,
    caseCount: cases.length,
    cases,
    predictionSetHash,
    claimBoundary: "mDeepFRI CNN scores are a frozen learned-sequence candidate channel, not calibrated probabilities or database annotations. All terms for one query share one model-dependency provenance root.",
  }));
}

/**
 * Add one overlay case to an immutable evidence bundle. The overlay itself is
 * validated again, and the public FASTA hash must match the bundle's original
 * input hash. Existing mDeepFRI rows are rejected to prevent double counting.
 */
export function mergeCandidateOverlay(
  evidenceBundle: JsonObject,
  overlayValue: unknown,
  caseId: string,
): JsonObject {
  const overlay = validateExternalGoPredictorOverlay(overlayValue);
  const item = overlay.cases.find((candidate) => candidate.caseId === caseId);
  if (!item) throw new Error(`external predictor overlay has no case ${caseId}`);
  const protein = record(evidenceBundle.protein, "evidence bundle protein");
  if (protein.sequence_input_sha256 !== item.sequenceSha256) {
    throw new Error("external predictor overlay sequence hash does not match the evidence bundle");
  }
  const source = evidenceBundle.candidate_sources === undefined
    ? { providers: [], go_candidates: [] }
    : record(evidenceBundle.candidate_sources, "evidence bundle candidate_sources");
  const providers = Array.isArray(source.providers) ? [...source.providers] : [];
  const candidates = Array.isArray(source.go_candidates) ? [...source.go_candidates] : [];
  if (providers.some((provider) => record(provider, "candidate provider").provider === PROVIDER)
    || candidates.some((candidate) => record(candidate, "GO candidate").source_type === SOURCE_TYPE)) {
    throw new Error("evidence bundle already contains the mDeepFRI CNN overlay");
  }
  const evidenceIds = Array.isArray(evidenceBundle.evidence_ids)
    ? evidenceBundle.evidence_ids.map(String)
    : [];
  return {
    ...evidenceBundle,
    candidate_sources: {
      ...source,
      providers: [...providers, {
        provider: PROVIDER,
        status: "completed",
        endpoint_or_path: `local:model-bound:${overlay.method.modelSha256.slice(0, 16)}`,
        release: `${overlay.method.packageName}@${overlay.method.packageVersion}`,
        request_sha256: item.requestSha256,
        payload_sha256: item.rawPredictionHash,
        cache_hit: false,
        reason: null,
      }],
      go_candidates: [...candidates, ...item.candidates],
      external_predictor_overlay: {
        overlay_hash: overlay.canonicalHash,
        method_hash: overlay.method.methodHash,
        prediction_set_hash: overlay.predictionSetHash,
        base_frozen_evidence_set_hash: overlay.base.baseFrozenEvidenceSetHash,
        case_hash: item.canonicalHash,
      },
    },
    evidence_ids: [...new Set([
      ...evidenceIds,
      ...item.candidates.map((candidate) => candidate.evidence_id),
    ])].sort(),
  };
}

// ---------------------------------------------------------------------------
// Structure-GCN overlay
// ---------------------------------------------------------------------------

const GCN_SOURCE_TYPE = "mdeepfri_gcn" as const;
const GCN_STRUCTURE_POLICY = "single_chain_exact_ca_v1" as const;
const GCN_CONTACT_THRESHOLD_ANGSTROM = 10 as const;

export interface ExternalGoPredictorGcnPublicCaseBinding extends ExternalGoPredictorPublicCaseBinding {
  structureSha256: string;
}

export interface ExternalGoPredictorGcnMethodBinding extends ExternalGoPredictorToolInput {
  provider: typeof PROVIDER;
  sourceType: typeof GCN_SOURCE_TYPE;
  annotationEvidenceCode: typeof ANNOTATION_CODE;
  architecture: "gcn";
  structurePolicy: typeof GCN_STRUCTURE_POLICY;
  contactThresholdAngstrom: typeof GCN_CONTACT_THRESHOLD_ANGSTROM;
  exportMinimumScore: number;
  runnerSha256: string;
  modelSha256: string;
  modelConfigSha256: string;
  modelFiles: ExternalGoPredictorModelFileBinding[];
  methodHash: string;
}

export interface MDeepFriGcnCandidateRow {
  schema_version: "pi-go-candidate.v1";
  go_id: string;
  term_name: string;
  aspect: ExternalGoPredictorAspect;
  source_type: typeof GCN_SOURCE_TYPE;
  source_id: string;
  mapping_id: string;
  provider: typeof PROVIDER;
  provider_release: string;
  provider_payload_sha256: string;
  evidence_id: string;
  provenance_root: string;
  base_score: number;
  query_coverage: null;
  domain_range: null;
  query_like: false;
  annotation_evidence_code: typeof ANNOTATION_CODE;
  donor_accession: null;
  phylogeny: null;
}

export interface ExternalGoPredictorGcnOverlayCase {
  caseId: string;
  sequenceSha256: string;
  structureSha256: string;
  requestSha256: string;
  dependencyRoot: string;
  rawPredictionHash: string;
  rawPredictions: ExternalGoPredictorRawPrediction[];
  candidates: MDeepFriGcnCandidateRow[];
  canonicalHash: string;
}

export interface ExternalGoPredictorGcnOverlay extends JsonObject {
  schemaVersion: "pi-external-go-predictor-gcn-overlay.v1";
  base: Omit<ExternalGoPredictorBaseBinding, "orderedPublicCases"> & {
    orderedPublicCases: ExternalGoPredictorGcnPublicCaseBinding[];
  };
  method: ExternalGoPredictorGcnMethodBinding;
  caseCount: number;
  cases: ExternalGoPredictorGcnOverlayCase[];
  predictionSetHash: string;
  claimBoundary: string;
  canonicalHash: string;
}

export interface ExternalGoPredictorGcnRunnerRequest {
  schemaVersion: "pi-external-go-gcn-run-request.v1";
  method: ExternalGoPredictorGcnMethodBinding;
  artifacts: ExternalGoPredictorRunnerRequest["artifacts"];
  cases: Array<ExternalGoPredictorGcnPublicCaseBinding & {
    sequence: string;
    structurePath: string;
  }>;
}

export type ExternalGoPredictorGcnRunner = (
  request: ExternalGoPredictorGcnRunnerRequest,
) => Promise<unknown>;

export interface GenerateExternalGoPredictorGcnOverlayInput {
  publicDir: string;
  batchDir: string;
  acquisitionReceiptPath?: string;
  baseFrozenEvidenceSetHash: string;
  runnerPath: string;
  modelConfigPath: string;
  modelFiles: GenerateExternalGoPredictorOverlayInput["modelFiles"];
  exportMinimumScore: number;
  tool: ExternalGoPredictorToolInput;
  pythonExecutable?: string;
  runnerTimeoutMs?: number;
  runnerMaxStdoutBytes?: number;
}

export interface ExternalGoPredictorGcnDependencies {
  run?: ExternalGoPredictorGcnRunner;
}

export interface ExternalGoPredictorGcnExpectedBindings
  extends Omit<ExternalGoPredictorExpectedBindings, "orderedPublicCases"> {
  orderedPublicCases?: readonly ExternalGoPredictorGcnPublicCaseBinding[];
}

export type AnyExternalGoPredictorOverlay = ExternalGoPredictorOverlay | ExternalGoPredictorGcnOverlay;

function gcnMethodBinding(
  toolInput: ExternalGoPredictorToolInput,
  exportMinimumScoreInput: number,
  hashes: {
    runnerSha256: string;
    modelConfigSha256: string;
    modelFiles: readonly ExternalGoPredictorModelFileBinding[];
  },
): ExternalGoPredictorGcnMethodBinding {
  const tool = validateToolInput(toolInput);
  if (hashes.modelFiles.length !== ASPECTS.length
    || hashes.modelFiles.some((item, index) => item.aspect !== ASPECTS[index])) {
    throw new Error("GCN method.modelFiles must contain one model per GO aspect in canonical order");
  }
  const modelFiles = hashes.modelFiles.map((item, index) => ({
    aspect: item.aspect,
    paramsSha256: hash(item.paramsSha256, `GCN method.modelFiles[${index}].paramsSha256`),
    onnxSha256: hash(item.onnxSha256, `GCN method.modelFiles[${index}].onnxSha256`),
  }));
  const modelConfigSha256 = hash(hashes.modelConfigSha256, "GCN method.modelConfigSha256");
  const modelSha256 = hashCanonical({
    schemaVersion: "pi-mdeepfri-gcn-model-set.v1",
    modelConfigSha256,
    modelFiles,
  });
  const content = {
    provider: PROVIDER,
    sourceType: GCN_SOURCE_TYPE,
    annotationEvidenceCode: ANNOTATION_CODE,
    architecture: "gcn" as const,
    structurePolicy: GCN_STRUCTURE_POLICY,
    contactThresholdAngstrom: GCN_CONTACT_THRESHOLD_ANGSTROM,
    exportMinimumScore: unitScore(exportMinimumScoreInput, "GCN method.exportMinimumScore"),
    ...tool,
    runnerSha256: hash(hashes.runnerSha256, "GCN method.runnerSha256"),
    modelSha256,
    modelConfigSha256,
    modelFiles,
  };
  return { ...content, methodHash: hashCanonical(content) };
}

function gcnCandidateRows(input: {
  method: ExternalGoPredictorGcnMethodBinding;
  caseId: string;
  rawPredictionHash: string;
  dependencyRoot: string;
  predictions: readonly ExternalGoPredictorRawPrediction[];
}): MDeepFriGcnCandidateRow[] {
  const release = `${input.method.packageName}@${input.method.packageVersion}`;
  return input.predictions.map((prediction) => ({
    schema_version: "pi-go-candidate.v1",
    go_id: prediction.goId,
    term_name: prediction.termName,
    aspect: prediction.aspect,
    source_type: GCN_SOURCE_TYPE,
    source_id: `${GCN_SOURCE_TYPE}:${input.method.modelSha256.slice(0, 16)}`,
    mapping_id: `${GCN_SOURCE_TYPE}:${prediction.goId}`,
    provider: PROVIDER,
    provider_release: release,
    provider_payload_sha256: input.rawPredictionHash,
    evidence_id: `CAND-MDG-${sha256Text(`${input.caseId}\0${prediction.goId}\0${input.method.methodHash}`).slice(0, 16)}`,
    provenance_root: input.dependencyRoot,
    base_score: prediction.score,
    query_coverage: null,
    domain_range: null,
    query_like: false,
    annotation_evidence_code: ANNOTATION_CODE,
    donor_accession: null,
    phylogeny: null,
  }));
}

function normalizeGcnRunnerOutput(
  value: unknown,
  publicCases: readonly ExternalGoPredictorGcnPublicCaseBinding[],
  method: ExternalGoPredictorGcnMethodBinding,
): ExternalGoPredictorGcnOverlayCase[] {
  const root = record(typeof value === "string" ? JSON.parse(value) as unknown : value, "external GCN output");
  exactKeys(root, ["schemaVersion", "exportMinimumScore", "cases"], "external GCN output");
  if (root.schemaVersion !== "pi-external-go-gcn-run-result.v1"
    || root.exportMinimumScore !== method.exportMinimumScore
    || !Array.isArray(root.cases)) {
    throw new Error("external GCN output has an invalid schemaVersion or case list");
  }
  const byId = new Map<string, JsonObject>();
  for (const [index, rawCase] of root.cases.entries()) {
    const item = record(rawCase, `external GCN output cases[${index}]`);
    exactKeys(item, ["caseId", "sequenceSha256", "structureSha256", "predictions"], `external GCN output cases[${index}]`);
    if (typeof item.caseId !== "string" || byId.has(item.caseId)) {
      throw new Error("external GCN output contains a missing or duplicate caseId");
    }
    byId.set(item.caseId, item);
  }
  if (byId.size !== publicCases.length) throw new Error("external GCN output is not an exact public-case cover");
  return publicCases.map((publicCase) => {
    const item = byId.get(publicCase.caseId);
    if (!item || item.sequenceSha256 !== publicCase.sequenceSha256
      || item.structureSha256 !== publicCase.structureSha256 || !Array.isArray(item.predictions)) {
      throw new Error(`external GCN output binding failed for ${publicCase.caseId}`);
    }
    const predictions = item.predictions.map((prediction, index) => normalizeRawPrediction(
      prediction, `external GCN output ${publicCase.caseId} predictions[${index}]`,
    )).sort((left, right) => left.goId.localeCompare(right.goId));
    if (predictions.some((prediction) => prediction.score < method.exportMinimumScore)) {
      throw new Error(`external GCN output contains a below-floor score for ${publicCase.caseId}`);
    }
    if (new Set(predictions.map((prediction) => prediction.goId)).size !== predictions.length) {
      throw new Error(`external GCN output contains duplicate GO IDs for ${publicCase.caseId}`);
    }
    const rawPredictionHash = hashCanonical({
      schemaVersion: "pi-external-go-gcn-normalized-case.v1",
      caseId: publicCase.caseId,
      sequenceSha256: publicCase.sequenceSha256,
      structureSha256: publicCase.structureSha256,
      predictions,
    });
    const requestSha256 = hashCanonical({
      schemaVersion: "pi-external-go-gcn-case-request.v1",
      methodHash: method.methodHash,
      caseId: publicCase.caseId,
      sequenceSha256: publicCase.sequenceSha256,
      structureSha256: publicCase.structureSha256,
    });
    const dependencyRoot = `mdeepfri-gcn:${sha256Text(
      `${method.methodHash}\0${publicCase.sequenceSha256}\0${publicCase.structureSha256}`,
    ).slice(0, 64)}`;
    const content = {
      ...publicCase,
      requestSha256,
      dependencyRoot,
      rawPredictionHash,
      rawPredictions: predictions,
      candidates: gcnCandidateRows({
        method, caseId: publicCase.caseId, rawPredictionHash, dependencyRoot, predictions,
      }),
    };
    return withCanonicalHash(content) as ExternalGoPredictorGcnOverlayCase;
  });
}

function validateGcnMethod(value: unknown): ExternalGoPredictorGcnMethodBinding {
  const item = record(value, "external GCN method");
  exactKeys(item, [
    "provider", "sourceType", "annotationEvidenceCode", "architecture", "structurePolicy",
    "contactThresholdAngstrom", "exportMinimumScore", "toolName", "packageName", "packageVersion",
    "runnerSha256", "modelSha256", "modelConfigSha256", "modelFiles", "methodHash",
  ], "external GCN method");
  if (item.provider !== PROVIDER || item.sourceType !== GCN_SOURCE_TYPE
    || item.annotationEvidenceCode !== ANNOTATION_CODE || item.architecture !== "gcn"
    || item.structurePolicy !== GCN_STRUCTURE_POLICY
    || item.contactThresholdAngstrom !== GCN_CONTACT_THRESHOLD_ANGSTROM
    || !Array.isArray(item.modelFiles)) {
    throw new Error("external predictor method is not the mDeepFRI structure-GCN channel");
  }
  const modelFiles = item.modelFiles.map((raw, index) => {
    const model = record(raw, `GCN method.modelFiles[${index}]`);
    exactKeys(model, ["aspect", "paramsSha256", "onnxSha256"], `GCN method.modelFiles[${index}]`);
    if (!ASPECTS.includes(model.aspect as ExternalGoPredictorAspect)) {
      throw new Error(`GCN method.modelFiles[${index}].aspect is invalid`);
    }
    return {
      aspect: model.aspect as ExternalGoPredictorAspect,
      paramsSha256: hash(model.paramsSha256, `GCN method.modelFiles[${index}].paramsSha256`),
      onnxSha256: hash(model.onnxSha256, `GCN method.modelFiles[${index}].onnxSha256`),
    };
  });
  const expected = gcnMethodBinding({
    toolName: safeId(item.toolName, "GCN method.toolName"),
    packageName: safeId(item.packageName, "GCN method.packageName"),
    packageVersion: safeId(item.packageVersion, "GCN method.packageVersion"),
  }, unitScore(item.exportMinimumScore, "GCN method.exportMinimumScore"), {
    runnerSha256: hash(item.runnerSha256, "GCN method.runnerSha256"),
    modelConfigSha256: hash(item.modelConfigSha256, "GCN method.modelConfigSha256"),
    modelFiles,
  });
  if (item.modelSha256 !== expected.modelSha256 || item.methodHash !== expected.methodHash) {
    throw new Error("external GCN modelSha256 or methodHash is invalid");
  }
  return expected;
}

function validateGcnPublicCases(value: unknown): ExternalGoPredictorGcnPublicCaseBinding[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error("GCN orderedPublicCases must be non-empty");
  const cases = value.map((raw, index) => {
    const item = record(raw, `GCN orderedPublicCases[${index}]`);
    exactKeys(item, ["caseId", "sequenceSha256", "structureSha256"], `GCN orderedPublicCases[${index}]`);
    if (typeof item.caseId !== "string" || !CASE_ID.test(item.caseId)) {
      throw new Error(`GCN orderedPublicCases[${index}].caseId is invalid`);
    }
    return {
      caseId: item.caseId,
      sequenceSha256: hash(item.sequenceSha256, `GCN orderedPublicCases[${index}].sequenceSha256`),
      structureSha256: hash(item.structureSha256, `GCN orderedPublicCases[${index}].structureSha256`),
    };
  });
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length
    || new Set(cases.map((item) => item.sequenceSha256)).size !== cases.length) {
    throw new Error("GCN orderedPublicCases contains duplicate bindings");
  }
  return cases;
}

export function validateExternalGoPredictorGcnOverlay(
  value: unknown,
  expected: ExternalGoPredictorGcnExpectedBindings = {},
): ExternalGoPredictorGcnOverlay {
  const root = record(value, "external GCN overlay");
  exactKeys(root, ["schemaVersion", "base", "method", "caseCount", "cases", "predictionSetHash", "claimBoundary", "canonicalHash"], "external GCN overlay");
  if (root.schemaVersion !== "pi-external-go-predictor-gcn-overlay.v1") {
    throw new Error("external GCN overlay schemaVersion is invalid");
  }
  const rawBase = record(root.base, "external GCN overlay base");
  exactKeys(rawBase, [
    "suiteId", "publicManifestHash", "baseBatchManifestHash", "acquisitionPlanHash",
    "acquisitionReceiptHash", "baseFrozenEvidenceSetHash", "orderedPublicCases",
  ], "external GCN overlay base");
  const base = {
    suiteId: safeId(rawBase.suiteId, "GCN base.suiteId"),
    publicManifestHash: hash(rawBase.publicManifestHash, "GCN base.publicManifestHash"),
    baseBatchManifestHash: hash(rawBase.baseBatchManifestHash, "GCN base.baseBatchManifestHash"),
    acquisitionPlanHash: hash(rawBase.acquisitionPlanHash, "GCN base.acquisitionPlanHash"),
    acquisitionReceiptHash: hash(rawBase.acquisitionReceiptHash, "GCN base.acquisitionReceiptHash"),
    baseFrozenEvidenceSetHash: hash(rawBase.baseFrozenEvidenceSetHash, "GCN base.baseFrozenEvidenceSetHash"),
    orderedPublicCases: validateGcnPublicCases(rawBase.orderedPublicCases),
  };
  const method = validateGcnMethod(root.method);
  if (!Array.isArray(root.cases) || root.caseCount !== root.cases.length
    || root.cases.length !== base.orderedPublicCases.length) {
    throw new Error("external GCN overlay case accounting is invalid");
  }
  const cases = root.cases.map((raw, index) => {
    const item = record(raw, `external GCN overlay cases[${index}]`);
    exactKeys(item, [
      "caseId", "sequenceSha256", "structureSha256", "requestSha256", "dependencyRoot",
      "rawPredictionHash", "rawPredictions", "candidates", "canonicalHash",
    ], `external GCN overlay cases[${index}]`);
    const bound = base.orderedPublicCases[index];
    if (item.caseId !== bound.caseId || item.sequenceSha256 !== bound.sequenceSha256
      || item.structureSha256 !== bound.structureSha256 || !Array.isArray(item.rawPredictions)) {
      throw new Error("external GCN overlay case order/binding is invalid");
    }
    const predictions = item.rawPredictions.map((prediction, offset) => normalizeRawPrediction(
      prediction, `external GCN overlay ${bound.caseId} rawPredictions[${offset}]`,
    ));
    if (predictions.some((prediction, offset) => offset > 0
      && predictions[offset - 1].goId.localeCompare(prediction.goId) >= 0)) {
      throw new Error(`external GCN overlay ${bound.caseId} predictions are not uniquely sorted`);
    }
    const rawPredictionHash = hashCanonical({
      schemaVersion: "pi-external-go-gcn-normalized-case.v1",
      ...bound,
      predictions,
    });
    const requestSha256 = hashCanonical({
      schemaVersion: "pi-external-go-gcn-case-request.v1",
      methodHash: method.methodHash,
      ...bound,
    });
    const dependencyRoot = `mdeepfri-gcn:${sha256Text(
      `${method.methodHash}\0${bound.sequenceSha256}\0${bound.structureSha256}`,
    ).slice(0, 64)}`;
    if (item.rawPredictionHash !== rawPredictionHash || item.requestSha256 !== requestSha256
      || item.dependencyRoot !== dependencyRoot) {
      throw new Error(`external GCN overlay ${bound.caseId} prediction/request/dependency binding is invalid`);
    }
    const candidates = gcnCandidateRows({
      method, caseId: bound.caseId, rawPredictionHash, dependencyRoot, predictions,
    });
    if (hashCanonical(item.candidates) !== hashCanonical(candidates)) {
      throw new Error(`external GCN overlay ${bound.caseId} candidate projection is invalid`);
    }
    const canonical = withCanonicalHash({
      ...bound, requestSha256, dependencyRoot, rawPredictionHash, rawPredictions: predictions, candidates,
    }) as ExternalGoPredictorGcnOverlayCase;
    if (item.canonicalHash !== canonical.canonicalHash) {
      throw new Error(`external GCN overlay ${bound.caseId} canonicalHash is invalid`);
    }
    return canonical;
  });
  const predictionSetHash = hashCanonical({
    schemaVersion: "pi-external-go-gcn-prediction-set.v1",
    methodHash: method.methodHash,
    cases: cases.map((item) => ({
      caseId: item.caseId,
      sequenceSha256: item.sequenceSha256,
      structureSha256: item.structureSha256,
      rawPredictionHash: item.rawPredictionHash,
    })),
  });
  if (root.predictionSetHash !== predictionSetHash) throw new Error("external GCN predictionSetHash is invalid");
  if (typeof root.claimBoundary !== "string" || root.claimBoundary.length < 1 || root.claimBoundary.length > 1000) {
    throw new Error("external GCN claimBoundary is invalid");
  }
  assertNoPathLeak(root.claimBoundary, "external GCN claimBoundary");
  const overlay = withCanonicalHash({
    schemaVersion: "pi-external-go-predictor-gcn-overlay.v1" as const,
    base, method, caseCount: cases.length, cases, predictionSetHash, claimBoundary: root.claimBoundary,
  }) as ExternalGoPredictorGcnOverlay;
  if (root.canonicalHash !== overlay.canonicalHash) throw new Error("external GCN overlay canonicalHash is invalid");
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue === undefined) continue;
    const actual = key === "methodHash" ? overlay.method.methodHash
      : key === "orderedPublicCases" ? overlay.base.orderedPublicCases
        : overlay.base[key as keyof typeof overlay.base];
    if (hashCanonical(actual) !== hashCanonical(expectedValue)) {
      throw new Error(`external GCN overlay ${key} binding mismatch`);
    }
  }
  return overlay;
}

export async function loadExternalGoPredictorGcnOverlay(
  path: string,
  expected: ExternalGoPredictorGcnExpectedBindings = {},
): Promise<ExternalGoPredictorGcnOverlay> {
  return validateExternalGoPredictorGcnOverlay(await ordinaryJson(path, "external GCN overlay"), expected);
}

async function defaultGcnRunner(
  input: GenerateExternalGoPredictorGcnOverlayInput,
): Promise<ExternalGoPredictorGcnRunner> {
  const timeoutMs = input.runnerTimeoutMs ?? 600_000;
  const maxStdoutBytes = input.runnerMaxStdoutBytes ?? 50 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error("GCN runnerTimeoutMs must be an integer in [1,3600000]");
  }
  if (!Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes < 1 || maxStdoutBytes > 100 * 1024 * 1024) {
    throw new Error("GCN runnerMaxStdoutBytes is invalid");
  }
  const requestedExecutable = input.pythonExecutable?.trim() || "python3";
  if (!requestedExecutable || requestedExecutable.includes("\0") || /[\r\n]/.test(requestedExecutable)) {
    throw new Error("GCN pythonExecutable is invalid");
  }
  const executable = requestedExecutable.includes("/") || requestedExecutable.includes("\\")
    ? resolve(requestedExecutable) : requestedExecutable;
  const runnerEnvironment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  ]) {
    const value = process.env[name];
    if (value !== undefined) runnerEnvironment[name] = value;
  }
  runnerEnvironment.PYTHONNOUSERSITE = "1";
  return async (request) => await new Promise<unknown>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, ["-I", resolve(input.runnerPath)], {
      cwd: dirname(resolve(input.runnerPath)), env: runnerEnvironment, stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error); else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("external GCN runner timed out"));
    }, timeoutMs);
    child.on("error", (error) => finish(new Error(`external GCN runner failed to start: ${error.message}`)));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        child.kill("SIGKILL");
        finish(new Error("external GCN runner exceeded the stdout limit"));
      } else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((sum, item) => sum + item.length, 0) < 16_384) stderr.push(Buffer.from(chunk));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 2000);
        finish(new Error(`external GCN runner exited unsuccessfully (${String(code ?? signal)})${detail ? `: ${detail}` : ""}`));
        return;
      }
      try {
        finish(undefined, JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown);
      } catch (error) {
        finish(new Error(`external GCN runner emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.on("error", (error) => finish(new Error(`external GCN runner stdin failed: ${error.message}`)));
    child.stdin.end(`${JSON.stringify(request)}\n`, "utf8");
  });
}

export async function generateExternalGoPredictorGcnOverlay(
  input: GenerateExternalGoPredictorGcnOverlayInput,
  dependencies: ExternalGoPredictorGcnDependencies = {},
): Promise<ExternalGoPredictorGcnOverlay> {
  const publicDir = await ordinaryDirectory(input.publicDir, "external GCN publicDir");
  const batchDirInput = await ordinaryDirectory(input.batchDir, "external GCN batchDir");
  const receiptPath = await ordinaryFile(
    input.acquisitionReceiptPath
      ?? join(batchDirInput, "evaluation/evaluator_private/acquisition/evidence_acquisition_receipt.json"),
    "external GCN acquisition receipt",
  );
  if (!Array.isArray(input.modelFiles) || input.modelFiles.length !== ASPECTS.length
    || input.modelFiles.some((item, index) => item.aspect !== ASPECTS[index])) {
    throw new Error("external GCN modelFiles must contain MF, BP, and CC models in canonical order");
  }
  const artifacts = {
    runnerPath: await ordinaryFile(input.runnerPath, "external GCN runner"),
    modelConfigPath: await ordinaryFile(input.modelConfigPath, "external GCN model config"),
    modelFiles: await Promise.all(input.modelFiles.map(async (item, index) => ({
      aspect: item.aspect,
      paramsPath: await ordinaryFile(item.paramsPath, `external GCN ${item.aspect} params ${index + 1}`),
      onnxPath: await ordinaryFile(item.onnxPath, `external GCN ${item.aspect} ONNX model ${index + 1}`),
    }))),
  };
  const modelDirectory = dirname(artifacts.modelConfigPath);
  const modelArtifactPaths = [
    artifacts.modelConfigPath, ...artifacts.modelFiles.flatMap((item) => [item.paramsPath, item.onnxPath]),
  ];
  if (modelArtifactPaths.some((path) => dirname(path) !== modelDirectory)
    || new Set(modelArtifactPaths).size !== modelArtifactPaths.length) {
    throw new Error("external GCN config and three-aspect model files must be distinct files in one directory");
  }
  const { manifest } = await loadPublicManifest(publicDir);
  const { batchDir, manifest: batch } = await loadBatchManifest(batchDirInput, manifest);
  if (batch.status !== "completed" || batch.cases.length !== manifest.cases.length) {
    throw new Error("external GCN requires a completed base batch with exact public coverage");
  }
  const receipt = assertEvidenceAcquisitionReceipt(await ordinaryJson(receiptPath, "external GCN acquisition receipt"));
  if (receipt.status !== "completed" || receipt.batchManifestHash !== batch.canonicalHash
    || receipt.acquisitionPlanHash !== batch.evidenceAcquisitionPlanHash) {
    throw new Error("external GCN acquisition receipt is not bound to the completed base batch");
  }
  const suppliedFrozenHash = hash(input.baseFrozenEvidenceSetHash, "GCN baseFrozenEvidenceSetHash");
  const computedFrozenHash = await computeBaseFrozenEvidenceSetHash({
    batchDir, manifest, batchManifestHash: batch.canonicalHash, batchCases: batch.cases, receipt,
  });
  if (suppliedFrozenHash !== computedFrozenHash) {
    throw new Error("external GCN baseFrozenEvidenceSetHash does not match receipt-bound evidence");
  }
  const method = gcnMethodBinding(input.tool, input.exportMinimumScore, {
    runnerSha256: await sha256File(artifacts.runnerPath),
    modelConfigSha256: await sha256File(artifacts.modelConfigPath),
    modelFiles: await Promise.all(artifacts.modelFiles.map(async (item) => ({
      aspect: item.aspect,
      paramsSha256: await sha256File(item.paramsPath),
      onnxSha256: await sha256File(item.onnxPath),
    }))),
  });
  const orderedPublicCases = manifest.cases.map((item) => {
    if (!item.structure || !item.structureSha256) {
      throw new Error(`external GCN requires a receipt-bound structure for ${item.caseId}`);
    }
    return { caseId: item.caseId, sequenceSha256: item.sequenceSha256, structureSha256: item.structureSha256 };
  });
  const runnerCases = await Promise.all(manifest.cases.map(async (item, index) => {
    const sequencePath = await ordinaryFile(join(publicDir, item.sequence), `${item.caseId} public FASTA`);
    const structurePath = await ordinaryFile(join(publicDir, item.structure!), `${item.caseId} public structure`);
    if (await sha256File(structurePath) !== orderedPublicCases[index].structureSha256) {
      throw new Error(`external GCN public structure hash mismatch for ${item.caseId}`);
    }
    return {
      ...orderedPublicCases[index],
      sequence: parseAnonymousFasta(await readFile(sequencePath, "utf8"), item.length, `${item.caseId} public FASTA`),
      structurePath,
    };
  }));
  const request: ExternalGoPredictorGcnRunnerRequest = {
    schemaVersion: "pi-external-go-gcn-run-request.v1",
    method,
    artifacts: { modelConfigPath: artifacts.modelConfigPath, modelFiles: artifacts.modelFiles },
    cases: runnerCases,
  };
  const run = dependencies.run ?? await defaultGcnRunner(input);
  const cases = normalizeGcnRunnerOutput(await run(request), orderedPublicCases, method);
  const base = {
    suiteId: manifest.suiteId,
    publicManifestHash: manifest.canonicalHash,
    baseBatchManifestHash: batch.canonicalHash,
    acquisitionPlanHash: receipt.acquisitionPlanHash,
    acquisitionReceiptHash: receipt.canonicalHash,
    baseFrozenEvidenceSetHash: suppliedFrozenHash,
    orderedPublicCases,
  };
  const predictionSetHash = hashCanonical({
    schemaVersion: "pi-external-go-gcn-prediction-set.v1",
    methodHash: method.methodHash,
    cases: cases.map((item) => ({
      caseId: item.caseId,
      sequenceSha256: item.sequenceSha256,
      structureSha256: item.structureSha256,
      rawPredictionHash: item.rawPredictionHash,
    })),
  });
  return validateExternalGoPredictorGcnOverlay(withCanonicalHash({
    schemaVersion: "pi-external-go-predictor-gcn-overlay.v1" as const,
    base, method, caseCount: cases.length, cases, predictionSetHash,
    claimBoundary: "mDeepFRI GCN scores are a frozen learned-structure candidate channel, not calibrated probabilities or database annotations. Each query uses one exact anonymous PDB C-alpha contact map and one model-dependency provenance root; no CNN fallback occurs.",
  }));
}

export async function loadAnyExternalGoPredictorOverlay(
  path: string,
  expected: ExternalGoPredictorExpectedBindings | ExternalGoPredictorGcnExpectedBindings = {},
): Promise<AnyExternalGoPredictorOverlay> {
  const value = await ordinaryJson(path, "external GO predictor overlay");
  const root = record(value, "external GO predictor overlay");
  return root.schemaVersion === "pi-external-go-predictor-gcn-overlay.v1"
    ? validateExternalGoPredictorGcnOverlay(value, expected as ExternalGoPredictorGcnExpectedBindings)
    : validateExternalGoPredictorOverlay(value, expected as ExternalGoPredictorExpectedBindings);
}

export function mergeGcnCandidateOverlay(
  evidenceBundle: JsonObject,
  overlayValue: unknown,
  caseId: string,
): JsonObject {
  const overlay = validateExternalGoPredictorGcnOverlay(overlayValue);
  const item = overlay.cases.find((candidate) => candidate.caseId === caseId);
  if (!item) throw new Error(`external GCN overlay has no case ${caseId}`);
  const protein = record(evidenceBundle.protein, "evidence bundle protein");
  if (protein.sequence_input_sha256 !== item.sequenceSha256) {
    throw new Error("external GCN overlay sequence hash does not match the evidence bundle");
  }
  const source = evidenceBundle.candidate_sources === undefined
    ? { providers: [], go_candidates: [] }
    : record(evidenceBundle.candidate_sources, "evidence bundle candidate_sources");
  const providers = Array.isArray(source.providers) ? [...source.providers] : [];
  const candidates = Array.isArray(source.go_candidates) ? [...source.go_candidates] : [];
  if (providers.some((provider) => record(provider, "candidate provider").provider === PROVIDER)
    || candidates.some((candidate) => {
      const sourceType = record(candidate, "GO candidate").source_type;
      return sourceType === SOURCE_TYPE || sourceType === GCN_SOURCE_TYPE;
    })) {
    throw new Error("evidence bundle already contains an mDeepFRI learned overlay");
  }
  const evidenceIds = Array.isArray(evidenceBundle.evidence_ids)
    ? evidenceBundle.evidence_ids.map(String) : [];
  return {
    ...evidenceBundle,
    candidate_sources: {
      ...source,
      providers: [...providers, {
        provider: PROVIDER,
        status: "completed",
        endpoint_or_path: `local:model-bound:${overlay.method.modelSha256.slice(0, 16)}`,
        release: `${overlay.method.packageName}@${overlay.method.packageVersion}`,
        request_sha256: item.requestSha256,
        payload_sha256: item.rawPredictionHash,
        cache_hit: false,
        reason: null,
      }],
      go_candidates: [...candidates, ...item.candidates],
      external_predictor_overlay: {
        overlay_hash: overlay.canonicalHash,
        method_hash: overlay.method.methodHash,
        prediction_set_hash: overlay.predictionSetHash,
        base_frozen_evidence_set_hash: overlay.base.baseFrozenEvidenceSetHash,
        case_hash: item.canonicalHash,
        structure_sha256: item.structureSha256,
      },
    },
    evidence_ids: [...new Set([...evidenceIds, ...item.candidates.map((candidate) => candidate.evidence_id)])].sort(),
  };
}

export function mergeAnyCandidateOverlay(
  evidenceBundle: JsonObject,
  overlay: AnyExternalGoPredictorOverlay,
  caseId: string,
): JsonObject {
  return overlay.schemaVersion === "pi-external-go-predictor-gcn-overlay.v1"
    ? mergeGcnCandidateOverlay(evidenceBundle, overlay, caseId)
    : mergeCandidateOverlay(evidenceBundle, overlay, caseId);
}

// ---------------------------------------------------------------------------
// Repository-locked exact overlay reproduction
// ---------------------------------------------------------------------------

const REPRODUCTION_MODE = "repository_locked_exact_reproduction_v1" as const;
const PREDICTOR_IDS = ["mdeepfri-cnn-v1", "mdeepfri-gcn-v1"] as const;
type ExternalGoPredictorId = typeof PREDICTOR_IDS[number];

interface LockedPredictorModelFile {
  aspect: ExternalGoPredictorAspect;
  kind: "model_params" | "onnx";
  name: string;
  sizeBytes: number;
  sha256: string;
}

interface LockedPredictor {
  predictorId: ExternalGoPredictorId;
  adapter: {
    name: string;
    sourcePath: string;
    runnerSha256: string;
    runtimePackage: string;
    runtimeVersion: string;
  };
  runtime: {
    python: string;
    requirementsPath: string;
    requirementsSha256: string;
    environmentPath: string;
    installManifestPath: string;
  };
  model: {
    networkType: "sequence_cnn" | "structure_gcn";
    config: { name: string; sizeBytes: number; sha256: string };
    files: LockedPredictorModelFile[];
  };
}

export interface VerifyLockedExternalGoPredictorOverlayReproductionInput {
  /** The candidate artifact. It is structurally validated before any runner is invoked. */
  overlay: AnyExternalGoPredictorOverlay;
  /** Anonymous public inputs only; no private target/label path is accepted by this API. */
  publicDir: string;
  batchDir: string;
  configPath: string;
  acquisitionReceiptPath?: string;
  runnerTimeoutMs?: number;
  runnerMaxStdoutBytes?: number;
}

export interface ExternalGoPredictorRuntimeInspection {
  pythonVersion: string;
  packageName: string;
  packageVersion: string;
}

export interface LockedExternalGoPredictorReproductionDependencies {
  /** Optional deterministic test/replay seam; all lock and byte checks still run first. */
  cnnRun?: ExternalGoPredictorRunner;
  /** Optional deterministic test/replay seam; all lock and byte checks still run first. */
  gcnRun?: ExternalGoPredictorGcnRunner;
  /** Narrow test seam for package metadata inspection. Production callers should omit it. */
  inspectRuntimePackage?: (input: {
    pythonExecutable: string;
    packageName: string;
  }) => Promise<ExternalGoPredictorRuntimeInspection>;
  /** Test-fixture seam only. Production always resolves locks from PROJECT_ROOT. */
  repositoryRootForTests?: string;
}

export interface LockedExternalGoPredictorReproductionReceipt extends JsonObject {
  schemaVersion: "pi-external-go-predictor-reproduction-receipt.v1";
  mode: typeof REPRODUCTION_MODE;
  predictorId: ExternalGoPredictorId;
  architecture: "cnn" | "gcn";
  predictorLockSha256: string;
  requirementsSha256: string;
  runtimeManifestSha256: string;
  managedConfigSha256: string;
  runtimePackage: string;
  runtimeVersion: string;
  methodHash: string;
  predictionSetHash: string;
  sourceOverlayHash: string;
  reproducedOverlayHash: string;
  canonicalOverlayBytesSha256: string;
  reproductionHash: string;
  caseCount: number;
  labelAccess: "public_inputs_only";
  claimBoundary: string;
  canonicalHash: string;
}

export interface LockedExternalGoPredictorReproductionResult {
  overlay: AnyExternalGoPredictorOverlay;
  receipt: LockedExternalGoPredictorReproductionReceipt;
}

function repositoryRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || isAbsolute(value) || win32.isAbsolute(value)
    || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${label} must be a safe repository-relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a safe repository-relative path`);
  }
  return value;
}

function positiveSize(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function lockedPredictor(value: unknown, expectedId: ExternalGoPredictorId): LockedPredictor {
  const root = record(value, "repository external predictor lock");
  if (root.schemaVersion !== "pi-external-go-predictor-lock.v1" || root.predictorId !== expectedId) {
    throw new Error("repository external predictor lock header is invalid");
  }
  const adapter = record(root.adapter, "repository external predictor lock adapter");
  const runtime = record(root.runtime, "repository external predictor lock runtime");
  const model = record(root.model, "repository external predictor lock model");
  const config = record(model.config, "repository external predictor lock model config");
  if (adapter.name !== (expectedId === "mdeepfri-cnn-v1"
    ? "deepfri-cnn-onnx-adapter" : "deepfri-gcn-onnx-adapter")
    || adapter.runtimePackage !== "onnxruntime"
    || typeof adapter.runtimeVersion !== "string"
    || !SAFE_ID.test(adapter.runtimeVersion)
    || runtime.python !== "3.11"
    || runtime.environmentPath !== `.runtime/predictors/${expectedId}`
    || runtime.installManifestPath !== `.runtime/${expectedId}-install-manifest.json`
    || model.networkType !== (expectedId === "mdeepfri-cnn-v1" ? "sequence_cnn" : "structure_gcn")) {
    throw new Error("repository external predictor lock contract is invalid");
  }
  if (expectedId === "mdeepfri-gcn-v1") {
    const structure = record(model.structureInput, "repository GCN structure policy");
    if (structure.policy !== GCN_STRUCTURE_POLICY
      || structure.contactDistanceAngstrom !== GCN_CONTACT_THRESHOLD_ANGSTROM
      || structure.sequenceStructureIdentity !== "exact" || structure.atomSelection !== "CA") {
      throw new Error("repository GCN structure policy is invalid");
    }
  }
  if (!Array.isArray(model.files) || model.files.length !== ASPECTS.length * 2) {
    throw new Error("repository external predictor model lock must bind six model files");
  }
  const files = model.files.map((raw, index) => {
    const item = record(raw, `repository external predictor model file ${index}`);
    if (!ASPECTS.includes(item.aspect as ExternalGoPredictorAspect)
      || (item.kind !== "model_params" && item.kind !== "onnx")) {
      throw new Error(`repository external predictor model file ${index} has an invalid aspect or kind`);
    }
    return {
      aspect: item.aspect as ExternalGoPredictorAspect,
      kind: item.kind as "model_params" | "onnx",
      name: repositoryRelativePath(item.name, `repository external predictor model file ${index} name`),
      sizeBytes: positiveSize(item.sizeBytes, `repository external predictor model file ${index} sizeBytes`),
      sha256: hash(item.sha256, `repository external predictor model file ${index} sha256`),
    };
  });
  const pairs = new Set(files.map((item) => `${item.aspect}:${item.kind}`));
  if (pairs.size !== files.length || ASPECTS.some((aspect) =>
    !pairs.has(`${aspect}:model_params`) || !pairs.has(`${aspect}:onnx`))) {
    throw new Error("repository external predictor model lock is not an exact three-aspect pair set");
  }
  return {
    predictorId: expectedId,
    adapter: {
      name: safeId(adapter.name, "repository external predictor adapter name"),
      sourcePath: repositoryRelativePath(adapter.sourcePath, "repository external predictor adapter sourcePath"),
      runnerSha256: hash(adapter.runnerSha256, "repository external predictor runnerSha256"),
      runtimePackage: safeId(adapter.runtimePackage, "repository external predictor runtimePackage"),
      runtimeVersion: safeId(adapter.runtimeVersion, "repository external predictor runtimeVersion"),
    },
    runtime: {
      python: runtime.python,
      requirementsPath: repositoryRelativePath(
        runtime.requirementsPath, "repository external predictor requirementsPath",
      ),
      requirementsSha256: hash(
        runtime.requirementsSha256, "repository external predictor requirementsSha256",
      ),
      environmentPath: repositoryRelativePath(
        runtime.environmentPath, "repository external predictor environmentPath",
      ),
      installManifestPath: repositoryRelativePath(
        runtime.installManifestPath, "repository external predictor installManifestPath",
      ),
    },
    model: {
      networkType: model.networkType as "sequence_cnn" | "structure_gcn",
      config: {
        name: repositoryRelativePath(config.name, "repository external predictor model config name"),
        sizeBytes: positiveSize(config.sizeBytes, "repository external predictor model config sizeBytes"),
        sha256: hash(config.sha256, "repository external predictor model config sha256"),
      },
      files,
    },
  };
}

async function requireFileBinding(
  path: string,
  expectedSha256: string,
  expectedSize: number | undefined,
  label: string,
): Promise<string> {
  const ordinary = await ordinaryFile(path, label);
  const stat = await lstat(ordinary);
  if ((expectedSize !== undefined && stat.size !== expectedSize) || await sha256File(ordinary) !== expectedSha256) {
    throw new Error(`${label} does not match the repository predictor lock`);
  }
  return ordinary;
}

async function managedPythonExecutable(path: string, repositoryRoot: string): Promise<string> {
  const absolute = resolve(path);
  const link = await lstat(absolute).catch(() => null);
  if (!link || (!link.isFile() && !link.isSymbolicLink()) || (link.mode & 0o111) === 0) {
    throw new Error("managed external predictor Python is missing or not executable");
  }
  const target = await realpath(absolute).catch(() => null);
  const targetStat = target ? await lstat(target).catch(() => null) : null;
  const runtimeRoot = resolve(repositoryRoot, ".runtime");
  const targetRelative = target ? relative(runtimeRoot, target) : "..";
  if (!target || !targetStat?.isFile() || targetRelative === ".." || targetRelative.startsWith(`..${sep}`)
    || isAbsolute(targetRelative)) {
    throw new Error("managed external predictor Python resolves outside the repository runtime");
  }
  return absolute;
}

async function inspectRuntimePackage(input: {
  pythonExecutable: string;
  packageName: string;
}): Promise<ExternalGoPredictorRuntimeInspection> {
  const environment: NodeJS.ProcessEnv = { PYTHONNOUSERSITE: "1" };
  for (const name of [
    "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  const script = [
    "import importlib.metadata,json,platform",
    `name=${JSON.stringify(input.packageName)}`,
    "print(json.dumps({'pythonVersion':platform.python_version(),'packageName':name,'packageVersion':importlib.metadata.version(name)}))",
  ].join(";");
  return await new Promise<ExternalGoPredictorRuntimeInspection>((resolvePromise, rejectPromise) => {
    const child = spawn(input.pythonExecutable, ["-I", "-c", script], {
      cwd: dirname(input.pythonExecutable), env: environment, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: ExternalGoPredictorRuntimeInspection): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value!);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("managed external predictor package inspection timed out"));
    }, 30_000);
    child.on("error", (error) => finish(new Error(`managed external predictor package inspection failed: ${error.message}`)));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16_384) {
        child.kill("SIGKILL");
        finish(new Error("managed external predictor package inspection exceeded its output limit"));
      } else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((sum, item) => sum + item.length, 0) < 4096) stderr.push(Buffer.from(chunk));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 1000);
        finish(new Error(
          `managed external predictor package inspection exited unsuccessfully (${String(code ?? signal)})${detail ? `: ${detail}` : ""}`,
        ));
        return;
      }
      try {
        const value = record(JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown, "runtime inspection");
        finish(undefined, {
          pythonVersion: safeId(value.pythonVersion, "runtime inspection pythonVersion"),
          packageName: safeId(value.packageName, "runtime inspection packageName"),
          packageVersion: safeId(value.packageVersion, "runtime inspection packageVersion"),
        });
      } catch (error) {
        finish(new Error(`managed external predictor package inspection returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

function configuredPredictorArtifacts(input: {
  config: Record<string, string>;
  architecture: "cnn" | "gcn";
  lock: LockedPredictor;
  repositoryRoot: string;
}): {
  pythonExecutable: string;
  runnerPath: string;
  modelConfigPath: string;
  modelFiles: GenerateExternalGoPredictorOverlayInput["modelFiles"];
} {
  const enabledKey = input.architecture === "cnn" ? "MDEEPFRI_CNN_ENABLED" : "MDEEPFRI_GCN_ENABLED";
  if (input.config[enabledKey] !== "true") {
    throw new Error(`managed config does not enable the repository ${input.architecture.toUpperCase()} predictor`);
  }
  const configured = (key: string, fallback?: string): string => {
    const value = input.config[key] ?? fallback;
    if (!value || value.includes("\0") || /[\r\n]/.test(value)) {
      throw new Error(`managed config is missing ${key}`);
    }
    return resolve(input.repositoryRoot, value);
  };
  const runnerKey = input.architecture === "cnn" ? "MDEEPFRI_RUNNER" : "MDEEPFRI_GCN_RUNNER";
  const pythonKey = input.architecture === "cnn" ? "MDEEPFRI_PYTHON_BIN" : "MDEEPFRI_GCN_PYTHON_BIN";
  const expectedPython = resolve(input.repositoryRoot, input.lock.runtime.environmentPath, "bin", "python");
  const pythonExecutable = configured(pythonKey);
  if (pythonExecutable !== expectedPython) {
    throw new Error("managed config Python does not select the repository-locked predictor runtime");
  }
  const modelKey = (aspect: "MF" | "BP" | "CC", kind: "PARAMS" | "ONNX"): string =>
    input.architecture === "cnn" ? `MDEEPFRI_${aspect}_${kind}` : `MDEEPFRI_GCN_${aspect}_${kind}`;
  return {
    pythonExecutable,
    runnerPath: configured(runnerKey, input.lock.adapter.sourcePath),
    modelConfigPath: configured(
      input.architecture === "cnn" ? "MDEEPFRI_MODEL_CONFIG" : "MDEEPFRI_GCN_MODEL_CONFIG",
    ),
    modelFiles: [
      {
        aspect: "molecular_function",
        paramsPath: configured(modelKey("MF", "PARAMS")),
        onnxPath: configured(modelKey("MF", "ONNX")),
      },
      {
        aspect: "biological_process",
        paramsPath: configured(modelKey("BP", "PARAMS")),
        onnxPath: configured(modelKey("BP", "ONNX")),
      },
      {
        aspect: "cellular_component",
        paramsPath: configured(modelKey("CC", "PARAMS")),
        onnxPath: configured(modelKey("CC", "ONNX")),
      },
    ],
  };
}

async function repositoryLockedPredictor(input: {
  architecture: "cnn" | "gcn";
  configPath: string;
  dependencies: LockedExternalGoPredictorReproductionDependencies;
}): Promise<{
  lock: LockedPredictor;
  predictorLockSha256: string;
  requirementsSha256: string;
  runtimeManifestSha256: string;
  managedConfigSha256: string;
  artifacts: ReturnType<typeof configuredPredictorArtifacts>;
}> {
  const repositoryRoot = resolve(input.dependencies.repositoryRootForTests ?? PROJECT_ROOT);
  const predictorId: ExternalGoPredictorId = input.architecture === "cnn"
    ? "mdeepfri-cnn-v1" : "mdeepfri-gcn-v1";
  const lockRelativePath = `bootstrap/${predictorId}.lock.json`;
  const lockPath = await ordinaryFile(join(repositoryRoot, lockRelativePath), "repository external predictor lock");
  const predictorLockSha256 = await sha256File(lockPath);
  const lock = lockedPredictor(await ordinaryJson(lockPath, "repository external predictor lock"), predictorId);

  const release = record(
    await ordinaryJson(join(repositoryRoot, "bootstrap/release.lock.json"), "repository release contract"),
    "repository release contract",
  );
  if (release.schemaVersion !== "pi-function-release-contract.v1" || !Array.isArray(release.sourceBindings)) {
    throw new Error("repository release contract is invalid");
  }
  const releaseBindings = release.sourceBindings.map((value, index) =>
    record(value, `repository release source binding ${index}`));
  const requireReleaseBinding = (path: string, sha256: string, label: string): void => {
    const matches = releaseBindings.filter((item) => item.path === path && item.sha256 === sha256);
    // CNN and GCN intentionally share one requirements lock, so the release
    // contract may name the same exact path/SHA binding once per predictor.
    if (matches.length < 1) throw new Error(`${label} is not SHA-256-bound by the repository release contract`);
  };
  requireReleaseBinding(lockRelativePath, predictorLockSha256, "repository external predictor lock");

  const requirementsPath = await requireFileBinding(
    join(repositoryRoot, lock.runtime.requirementsPath),
    lock.runtime.requirementsSha256,
    undefined,
    "repository external predictor requirements lock",
  );
  const requirementsSha256 = await sha256File(requirementsPath);
  requireReleaseBinding(lock.runtime.requirementsPath, requirementsSha256, "repository external predictor requirements lock");
  requireReleaseBinding(lock.adapter.sourcePath, lock.adapter.runnerSha256, "repository external predictor runner");

  const configPath = await ordinaryFile(input.configPath, "managed external predictor config");
  const managedConfigSha256 = await sha256File(configPath);
  const artifacts = configuredPredictorArtifacts({
    config: parseEnvFile(configPath), architecture: input.architecture, lock, repositoryRoot,
  });
  artifacts.runnerPath = await requireFileBinding(
    artifacts.runnerPath, lock.adapter.runnerSha256, undefined, "managed external predictor runner",
  );
  artifacts.modelConfigPath = await requireFileBinding(
    artifacts.modelConfigPath, lock.model.config.sha256, lock.model.config.sizeBytes,
    "managed external predictor model config",
  );
  for (const model of artifacts.modelFiles) {
    const params = lock.model.files.find((item) => item.aspect === model.aspect && item.kind === "model_params")!;
    const onnx = lock.model.files.find((item) => item.aspect === model.aspect && item.kind === "onnx")!;
    model.paramsPath = await requireFileBinding(
      model.paramsPath, params.sha256, params.sizeBytes, `${model.aspect} managed predictor parameters`,
    );
    model.onnxPath = await requireFileBinding(
      model.onnxPath, onnx.sha256, onnx.sizeBytes, `${model.aspect} managed predictor model`,
    );
  }
  artifacts.pythonExecutable = await managedPythonExecutable(artifacts.pythonExecutable, repositoryRoot);

  const manifestPath = await ordinaryFile(
    join(repositoryRoot, lock.runtime.installManifestPath), "managed external predictor install manifest",
  );
  const runtimeManifestSha256 = await sha256File(manifestPath);
  const manifest = record(await ordinaryJson(manifestPath, "managed external predictor install manifest"),
    "managed external predictor install manifest");
  if (manifest.schemaVersion !== "pi-external-go-predictor-install.v1"
    || manifest.predictorLockSha256 !== predictorLockSha256
    || manifest.requirementsPath !== lock.runtime.requirementsPath
    || manifest.requirementsSha256 !== requirementsSha256
    || manifest.runnerPath !== lock.adapter.sourcePath
    || manifest.runnerSha256 !== lock.adapter.runnerSha256
    || manifest.runtimePackage !== lock.adapter.runtimePackage
    || manifest.runtimeVersion !== lock.adapter.runtimeVersion
    || !Array.isArray(manifest.packages)) {
    throw new Error("managed external predictor install manifest is not lock-exact");
  }
  const manifestPackages = manifest.packages.map((item, index) =>
    record(item, `managed external predictor install manifest package ${index}`));
  const runtimeRows = manifestPackages.filter((item) =>
    item.name === lock.adapter.runtimePackage && item.version === lock.adapter.runtimeVersion);
  if (runtimeRows.length !== 1) throw new Error("managed external predictor install manifest lacks the locked runtime package");

  const inspect = input.dependencies.inspectRuntimePackage ?? inspectRuntimePackage;
  const inspection = await inspect({
    pythonExecutable: artifacts.pythonExecutable,
    packageName: lock.adapter.runtimePackage,
  });
  if (inspection.packageName !== lock.adapter.runtimePackage
    || inspection.packageVersion !== lock.adapter.runtimeVersion
    || !inspection.pythonVersion.startsWith(`${lock.runtime.python}.`)
    || manifest.pythonVersion !== inspection.pythonVersion) {
    throw new Error("managed external predictor runtime package or Python version is not lock-exact");
  }
  return {
    lock, predictorLockSha256, requirementsSha256, runtimeManifestSha256,
    managedConfigSha256, artifacts,
  };
}

/**
 * Re-run a validated learned-predictor overlay from repository-locked bytes.
 *
 * The API intentionally accepts no private-target or label path. A structurally
 * valid but fully re-hashed forged overlay therefore still fails unless the
 * repo-managed runner reproduces the exact canonical bytes.
 */
export async function verifyLockedExternalGoPredictorOverlayReproduction(
  input: VerifyLockedExternalGoPredictorOverlayReproductionInput,
  dependencies: LockedExternalGoPredictorReproductionDependencies = {},
): Promise<LockedExternalGoPredictorReproductionResult> {
  const architecture = input.overlay.schemaVersion === "pi-external-go-predictor-gcn-overlay.v1"
    ? "gcn" as const : "cnn" as const;
  const sourceOverlay: AnyExternalGoPredictorOverlay = architecture === "gcn"
    ? validateExternalGoPredictorGcnOverlay(input.overlay)
    : validateExternalGoPredictorOverlay(input.overlay);
  const locked = await repositoryLockedPredictor({
    architecture, configPath: input.configPath, dependencies,
  });
  const expectedMethod = sourceOverlay.method;
  const lockedModelFiles = ASPECTS.map((aspect) => ({
    aspect,
    paramsSha256: locked.lock.model.files.find((item) =>
      item.aspect === aspect && item.kind === "model_params")!.sha256,
    onnxSha256: locked.lock.model.files.find((item) =>
      item.aspect === aspect && item.kind === "onnx")!.sha256,
  }));
  if (expectedMethod.toolName !== locked.lock.adapter.name
    || expectedMethod.packageName !== locked.lock.adapter.runtimePackage
    || expectedMethod.packageVersion !== locked.lock.adapter.runtimeVersion
    || expectedMethod.runnerSha256 !== locked.lock.adapter.runnerSha256
    || expectedMethod.modelConfigSha256 !== locked.lock.model.config.sha256
    || hashCanonical(expectedMethod.modelFiles) !== hashCanonical(lockedModelFiles)) {
    throw new Error("external predictor overlay method is not bound to the repository predictor lock");
  }

  const generationInput = {
    publicDir: input.publicDir,
    batchDir: input.batchDir,
    ...(input.acquisitionReceiptPath ? { acquisitionReceiptPath: input.acquisitionReceiptPath } : {}),
    baseFrozenEvidenceSetHash: sourceOverlay.base.baseFrozenEvidenceSetHash,
    runnerPath: locked.artifacts.runnerPath,
    modelConfigPath: locked.artifacts.modelConfigPath,
    modelFiles: locked.artifacts.modelFiles,
    exportMinimumScore: expectedMethod.exportMinimumScore,
    tool: {
      toolName: locked.lock.adapter.name,
      packageName: locked.lock.adapter.runtimePackage,
      packageVersion: locked.lock.adapter.runtimeVersion,
    },
    pythonExecutable: locked.artifacts.pythonExecutable,
    ...(input.runnerTimeoutMs === undefined ? {} : { runnerTimeoutMs: input.runnerTimeoutMs }),
    ...(input.runnerMaxStdoutBytes === undefined ? {} : { runnerMaxStdoutBytes: input.runnerMaxStdoutBytes }),
  } satisfies GenerateExternalGoPredictorOverlayInput;
  const reproduced: AnyExternalGoPredictorOverlay = architecture === "gcn"
    ? await generateExternalGoPredictorGcnOverlay(generationInput, { run: dependencies.gcnRun })
    : await generateExternalGoPredictorOverlay(generationInput, { run: dependencies.cnnRun });
  const sourceCanonicalBytes = canonicalJson(sourceOverlay);
  const reproducedCanonicalBytes = canonicalJson(reproduced);
  if (sourceOverlay.canonicalHash !== reproduced.canonicalHash
    || sourceCanonicalBytes !== reproducedCanonicalBytes) {
    throw new Error("external predictor overlay failed repository-locked exact reproduction");
  }
  const canonicalOverlayBytesSha256 = sha256Text(reproducedCanonicalBytes);
  const reproductionBinding = {
    mode: REPRODUCTION_MODE,
    predictorId: locked.lock.predictorId,
    predictorLockSha256: locked.predictorLockSha256,
    requirementsSha256: locked.requirementsSha256,
    runtimeManifestSha256: locked.runtimeManifestSha256,
    managedConfigSha256: locked.managedConfigSha256,
    reproducedOverlayHash: reproduced.canonicalHash,
    canonicalOverlayBytesSha256,
  };
  const reproductionHash = hashCanonical(reproductionBinding);
  const receipt = withCanonicalHash({
    schemaVersion: "pi-external-go-predictor-reproduction-receipt.v1" as const,
    mode: REPRODUCTION_MODE,
    predictorId: locked.lock.predictorId,
    architecture,
    predictorLockSha256: locked.predictorLockSha256,
    requirementsSha256: locked.requirementsSha256,
    runtimeManifestSha256: locked.runtimeManifestSha256,
    managedConfigSha256: locked.managedConfigSha256,
    runtimePackage: locked.lock.adapter.runtimePackage,
    runtimeVersion: locked.lock.adapter.runtimeVersion,
    methodHash: reproduced.method.methodHash,
    predictionSetHash: reproduced.predictionSetHash,
    sourceOverlayHash: sourceOverlay.canonicalHash,
    reproducedOverlayHash: reproduced.canonicalHash,
    canonicalOverlayBytesSha256,
    reproductionHash,
    caseCount: reproduced.caseCount,
    labelAccess: "public_inputs_only" as const,
    claimBoundary: "Exact reproduction binds the repository release lock, installed runtime/package, managed config, model/runner bytes, anonymous public inputs, and canonical overlay bytes. It does not establish calibration, training-set independence, or biological correctness.",
  }) as LockedExternalGoPredictorReproductionReceipt;
  return { overlay: reproduced, receipt };
}
