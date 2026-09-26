import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

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

export const DEEPGOPLUS_PROVIDER = "DeepGOPlus" as const;
export const DEEPGOPLUS_SOURCE_TYPE = "deepgoplus_cnn" as const;
export const DEEPGOPLUS_REQUEST_SCHEMA = "pi-deepgoplus-cnn-run-request.v1" as const;
export const DEEPGOPLUS_RESULT_SCHEMA = "pi-deepgoplus-cnn-run-result.v1" as const;
export const DEEPGOPLUS_RECEIPT_SCHEMA = "pi-deepgoplus-candidate-receipt.v1" as const;

export type DeepGoPlusMode = "unconfigured" | "disabled" | "local";
export type DeepGoPlusAspect = typeof ASPECTS[number];

export interface DeepGoPlusConfig {
  mode: DeepGoPlusMode;
  pythonExecutable?: string;
  runnerPath?: string;
  modelPath?: string;
  termsPath?: string;
  ontologyPath?: string;
  packageVersion?: string;
  dataRelease?: string;
  exportMinimumScore: number;
  timeoutMs: number;
  maxStdoutBytes: number;
}

export interface DeepGoPlusCaseInput {
  caseId: string;
  sequence: string;
}

export interface DeepGoPlusPrediction {
  goId: string;
  termName: string;
  aspect: DeepGoPlusAspect;
  score: number;
}

export interface DeepGoPlusCaseResult {
  caseId: string;
  sequenceSha256: string;
  predictions: DeepGoPlusPrediction[];
}

export interface DeepGoPlusMethodBinding {
  provider: typeof DEEPGOPLUS_PROVIDER;
  sourceType: typeof DEEPGOPLUS_SOURCE_TYPE;
  architecture: "sequence_cnn";
  packageName: "deepgoplus";
  packageVersion: string;
  dataRelease: string;
  runnerSha256: string;
  modelSha256: string;
  termsSha256: string;
  ontologySha256: string;
  exportMinimumScore: number;
  methodHash: string;
}

export interface DeepGoPlusCandidateReceipt extends Record<string, unknown> {
  schema_version: typeof DEEPGOPLUS_RECEIPT_SCHEMA;
  provider: typeof DEEPGOPLUS_PROVIDER;
  source_type: typeof DEEPGOPLUS_SOURCE_TYPE;
  architecture: "sequence_cnn";
  package_version: string;
  data_release: string;
  runner_sha256: string;
  model_sha256: string;
  terms_sha256: string;
  ontology_sha256: string;
  method_hash: string;
  request_sha256: string;
  prediction_set_hash: string;
  base_frozen_evidence_set_hash: string;
  score_semantics: "direct_cnn_head_pre_ontology";
  homology_component: "not_executed";
  ontology_propagation: "host_only";
  canonical_hash: string;
}

export interface DeepGoPlusBatchResult {
  method: DeepGoPlusMethodBinding;
  requestSha256: string;
  predictionSetHash: string;
  cases: DeepGoPlusCaseResult[];
}

export interface DeepGoPlusDependencies {
  run?: (request: Record<string, unknown>, config: DeepGoPlusConfig) => Promise<unknown>;
}

export type DeepGoPlusCandidateSourceBundle = SnakeCaseCandidateSourceBundle & {
  candidate_sources: SnakeCaseCandidateSourceBundle["candidate_sources"] & {
    deepgoplus_receipt?: DeepGoPlusCandidateReceipt;
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
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
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
    throw new Error(`${label} must be ${integer ? "an integer" : "a number"} in [${minimum},${maximum}]`);
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

export function deepGoPlusConfigFromEnv(env: NodeJS.ProcessEnv): DeepGoPlusConfig {
  const rawMode = env.DEEPGOPLUS_MODE?.trim().toLowerCase();
  const mode: DeepGoPlusMode = rawMode === undefined || rawMode === ""
    ? "unconfigured"
    : rawMode === "disabled" || rawMode === "local"
      ? rawMode
      : (() => {
        throw new Error("DEEPGOPLUS_MODE must be disabled or local");
      })();
  const base = env.DEEPGOPLUS_DATA_ROOT?.trim();
  return {
    mode,
    ...(mode === "local" ? {
      pythonExecutable: configuredPath(
        env.DEEPGOPLUS_PYTHON,
        ".runtime/predictors/deepgoplus-cnn-v1/bin/python",
      ),
      runnerPath: configuredPath(
        env.DEEPGOPLUS_RUNNER,
        "python/deepgoplus_cnn_predictor.py",
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
      packageVersion: optionalSafeId(env.DEEPGOPLUS_PACKAGE_VERSION, "DEEPGOPLUS_PACKAGE_VERSION"),
      dataRelease: optionalSafeId(env.DEEPGOPLUS_DATA_RELEASE, "DEEPGOPLUS_DATA_RELEASE"),
    } : {}),
    exportMinimumScore: boundedNumber(
      env.DEEPGOPLUS_EXPORT_MINIMUM_SCORE,
      0.01,
      "DEEPGOPLUS_EXPORT_MINIMUM_SCORE",
      0,
      1,
    ),
    timeoutMs: boundedNumber(
      env.DEEPGOPLUS_TIMEOUT_MS,
      600_000,
      "DEEPGOPLUS_TIMEOUT_MS",
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

function normalizeCases(cases: readonly DeepGoPlusCaseInput[]): Array<DeepGoPlusCaseInput & {
  sequenceSha256: string;
}> {
  if (cases.length < 1 || cases.length > 1000) throw new Error("DeepGOPlus requires 1-1000 cases");
  const normalized = cases.map((item, index) => {
    const caseId = item.caseId.trim();
    const sequence = item.sequence.trim().toUpperCase();
    if (!SAFE_ID.test(caseId)) throw new Error(`DeepGOPlus case ${index + 1} has an invalid caseId`);
    if (!SEQUENCE.test(sequence) || sequence.length > 10_000) {
      throw new Error(`DeepGOPlus case ${caseId} has an invalid protein sequence`);
    }
    return { caseId, sequence, sequenceSha256: sha256Text(sequence) };
  });
  if (new Set(normalized.map((item) => item.caseId)).size !== normalized.length) {
    throw new Error("DeepGOPlus case IDs must be unique");
  }
  if (normalized.reduce((sum, item) => sum + item.sequence.length, 0) > 2_000_000) {
    throw new Error("DeepGOPlus total sequence length exceeds the limit");
  }
  return normalized;
}

async function methodAndArtifacts(config: DeepGoPlusConfig): Promise<{
  method: DeepGoPlusMethodBinding;
  artifacts: {
    runnerPath: string;
    modelPath: string;
    termsPath: string;
    ontologyPath: string;
  };
}> {
  if (config.mode !== "local"
    || !config.pythonExecutable
    || !config.runnerPath
    || !config.modelPath
    || !config.termsPath
    || !config.ontologyPath
    || !config.packageVersion
    || !config.dataRelease) {
    throw new Error("DeepGOPlus local mode requires Python, runner/model/terms/ontology paths, package version, and data release");
  }
  const artifacts = {
    runnerPath: await ordinaryResolvedPath(config.runnerPath, "DeepGOPlus runner"),
    modelPath: await ordinaryResolvedPath(config.modelPath, "DeepGOPlus model"),
    termsPath: await ordinaryResolvedPath(config.termsPath, "DeepGOPlus terms"),
    ontologyPath: await ordinaryResolvedPath(config.ontologyPath, "DeepGOPlus ontology"),
  };
  const content = {
    provider: DEEPGOPLUS_PROVIDER,
    sourceType: DEEPGOPLUS_SOURCE_TYPE,
    architecture: "sequence_cnn" as const,
    packageName: "deepgoplus" as const,
    packageVersion: config.packageVersion,
    dataRelease: config.dataRelease,
    runnerSha256: await sha256File(artifacts.runnerPath),
    modelSha256: await sha256File(artifacts.modelPath),
    termsSha256: await sha256File(artifacts.termsPath),
    ontologySha256: await sha256File(artifacts.ontologyPath),
    exportMinimumScore: config.exportMinimumScore,
  };
  return {
    method: { ...content, methodHash: hashCanonical(content) },
    artifacts,
  };
}

function parseResult(
  value: unknown,
  method: DeepGoPlusMethodBinding,
  expectedCases: readonly { caseId: string; sequenceSha256: string }[],
): DeepGoPlusCaseResult[] {
  const root = record(value, "DeepGOPlus result");
  exactKeys(root, ["schemaVersion", "methodHash", "cases"], "DeepGOPlus result");
  if (root.schemaVersion !== DEEPGOPLUS_RESULT_SCHEMA || root.methodHash !== method.methodHash) {
    throw new Error("DeepGOPlus result method binding is invalid");
  }
  if (!Array.isArray(root.cases) || root.cases.length !== expectedCases.length) {
    throw new Error("DeepGOPlus result case accounting is invalid");
  }
  return root.cases.map((raw, caseIndex) => {
    const item = record(raw, `DeepGOPlus result cases[${caseIndex}]`);
    exactKeys(item, ["caseId", "sequenceSha256", "predictions"], `DeepGOPlus result cases[${caseIndex}]`);
    const expected = expectedCases[caseIndex];
    if (item.caseId !== expected.caseId || item.sequenceSha256 !== expected.sequenceSha256) {
      throw new Error("DeepGOPlus result case order/binding is invalid");
    }
    if (!Array.isArray(item.predictions)) throw new Error("DeepGOPlus result predictions must be an array");
    const predictions = item.predictions.map((rawPrediction, predictionIndex) => {
      const prediction = record(
        rawPrediction,
        `DeepGOPlus result ${expected.caseId} predictions[${predictionIndex}]`,
      );
      exactKeys(
        prediction,
        ["goId", "termName", "aspect", "score"],
        `DeepGOPlus result ${expected.caseId} predictions[${predictionIndex}]`,
      );
      if (typeof prediction.goId !== "string"
        || !GO_ID.test(prediction.goId)
        || typeof prediction.termName !== "string"
        || prediction.termName.trim() === ""
        || !(ASPECTS as readonly unknown[]).includes(prediction.aspect)
        || typeof prediction.score !== "number"
        || !Number.isFinite(prediction.score)
        || prediction.score < method.exportMinimumScore
        || prediction.score > 1) {
        throw new Error(`DeepGOPlus result ${expected.caseId} contains an invalid prediction`);
      }
      return {
        goId: prediction.goId,
        termName: prediction.termName.trim(),
        aspect: prediction.aspect as DeepGoPlusAspect,
        score: prediction.score,
      };
    });
    const sorted = [...predictions].sort((left, right) =>
      left.goId.localeCompare(right.goId) || left.aspect.localeCompare(right.aspect));
    if (JSON.stringify(sorted) !== JSON.stringify(predictions)
      || new Set(predictions.map((prediction) => prediction.goId)).size !== predictions.length) {
      throw new Error(`DeepGOPlus result ${expected.caseId} predictions are not uniquely sorted`);
    }
    return {
      caseId: expected.caseId,
      sequenceSha256: expected.sequenceSha256,
      predictions,
    };
  });
}

async function defaultRun(
  request: Record<string, unknown>,
  config: DeepGoPlusConfig,
): Promise<unknown> {
  if (!config.pythonExecutable) throw new Error("DeepGOPlus Python executable is missing");
  const executable = await ordinaryResolvedPath(config.pythonExecutable, "DeepGOPlus Python executable");
  const environment: NodeJS.ProcessEnv = { PYTHONNOUSERSITE: "1" };
  for (const name of [
    "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return await new Promise<unknown>((resolvePromise, rejectPromise) => {
    const runnerPath = String(record(request.artifacts, "DeepGOPlus request artifacts").runnerPath);
    const child = spawn(executable, ["-I", runnerPath], {
      cwd: PROJECT_ROOT,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
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
      finish(new Error("DeepGOPlus runner timed out"));
    }, config.timeoutMs);
    child.on("error", (error) => finish(new Error(`DeepGOPlus runner failed to start: ${error.message}`)));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > config.maxStdoutBytes) {
        child.kill("SIGKILL");
        finish(new Error("DeepGOPlus runner exceeded its stdout limit"));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const current = stderr.reduce((sum, item) => sum + item.length, 0);
      if (current < 16_384) stderr.push(Buffer.from(chunk).subarray(0, 16_384 - current));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 2000);
        finish(new Error(`DeepGOPlus runner exited with ${code ?? signal}: ${detail}`));
        return;
      }
      try {
        finish(undefined, JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown);
      } catch (error) {
        finish(new Error(`DeepGOPlus runner returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`, "utf8");
  });
}

export async function runDeepGoPlusBatch(
  casesInput: readonly DeepGoPlusCaseInput[],
  config: DeepGoPlusConfig,
  dependencies: DeepGoPlusDependencies = {},
): Promise<DeepGoPlusBatchResult> {
  const cases = normalizeCases(casesInput);
  const { method, artifacts } = await methodAndArtifacts(config);
  const request = {
    schemaVersion: DEEPGOPLUS_REQUEST_SCHEMA,
    method,
    artifacts,
    cases,
  };
  const requestSha256 = hashCanonical({
    schemaVersion: DEEPGOPLUS_REQUEST_SCHEMA,
    methodHash: method.methodHash,
    cases: cases.map(({ caseId, sequenceSha256 }) => ({ caseId, sequenceSha256 })),
  });
  const raw = await (dependencies.run ?? defaultRun)(request, config);
  const parsed = parseResult(raw, method, cases);
  return {
    method,
    requestSha256,
    predictionSetHash: hashCanonical(parsed),
    cases: parsed,
  };
}

function providerRecord(input: {
  status: "completed" | "disabled" | "failed";
  release: string | null;
  requestSha256: string | null;
  payloadSha256: string | null;
  reason: string | null;
}): SnakeCaseCandidateSourceBundle["candidate_sources"]["providers"][number] {
  return {
    provider: DEEPGOPLUS_PROVIDER,
    status: input.status,
    endpoint_or_path: input.payloadSha256
      ? `local:model-bound:${input.payloadSha256.slice(0, 16)}`
      : "local:disabled",
    release: input.release,
    request_sha256: input.requestSha256,
    payload_sha256: input.payloadSha256,
    cache_hit: false,
    reason: input.reason,
  };
}

export async function collectDeepGoPlusCandidateSource(input: {
  sequence: string;
  baseFrozenEvidenceSetHash: string;
  env: NodeJS.ProcessEnv;
  dependencies?: DeepGoPlusDependencies;
}): Promise<DeepGoPlusCandidateSourceBundle | null> {
  const config = deepGoPlusConfigFromEnv(input.env);
  if (config.mode === "unconfigured") return null;
  if (config.mode === "disabled") {
    return {
      candidate_sources: {
        providers: [providerRecord({
          status: "disabled",
          release: null,
          requestSha256: null,
          payloadSha256: null,
          reason: "DEEPGOPLUS_MODE=disabled",
        })],
        go_candidates: [],
      },
    };
  }
  if (!HASH.test(input.baseFrozenEvidenceSetHash)) {
    throw new Error("DeepGOPlus requires a canonical base frozen evidence-set hash");
  }
  const sequence = input.sequence.trim().toUpperCase();
  const sequenceSha256 = sha256Text(sequence);
  const caseId = `DGP_${sequenceSha256.slice(0, 16).toUpperCase()}`;
  const batch = await runDeepGoPlusBatch(
    [{ caseId, sequence }],
    config,
    input.dependencies,
  );
  const item = batch.cases[0];
  const dependencyRoot = `deepgoplus-cnn:${sha256Text(`${batch.method.methodHash}\0${sequenceSha256}`)}`;
  const candidates: SnakeCaseGOCandidate[] = item.predictions.map((prediction) => {
    const token = sha256Text(`${dependencyRoot}\0${prediction.goId}\0${prediction.score}`);
    return {
      schema_version: "pi-go-candidate.v1",
      go_id: prediction.goId,
      term_name: prediction.termName,
      aspect: prediction.aspect,
      source_type: DEEPGOPLUS_SOURCE_TYPE,
      source_id: `${DEEPGOPLUS_SOURCE_TYPE}:${batch.method.modelSha256.slice(0, 16)}`,
      mapping_id: `${DEEPGOPLUS_SOURCE_TYPE}:${prediction.goId}`,
      provider: DEEPGOPLUS_PROVIDER,
      provider_release: `${batch.method.packageVersion};data-${batch.method.dataRelease}`,
      provider_payload_sha256: batch.predictionSetHash,
      evidence_id: `CAND-DGP-${token.slice(0, 20).toUpperCase()}`,
      provenance_root: dependencyRoot,
      base_score: prediction.score,
      query_coverage: null,
      domain_range: null,
      query_like: false,
      annotation_evidence_code: "MODEL",
      donor_accession: null,
      phylogeny: null,
    };
  });
  const receiptContent = {
    schema_version: DEEPGOPLUS_RECEIPT_SCHEMA,
    provider: DEEPGOPLUS_PROVIDER,
    source_type: DEEPGOPLUS_SOURCE_TYPE,
    architecture: "sequence_cnn" as const,
    package_version: batch.method.packageVersion,
    data_release: batch.method.dataRelease,
    runner_sha256: batch.method.runnerSha256,
    model_sha256: batch.method.modelSha256,
    terms_sha256: batch.method.termsSha256,
    ontology_sha256: batch.method.ontologySha256,
    method_hash: batch.method.methodHash,
    request_sha256: batch.requestSha256,
    prediction_set_hash: batch.predictionSetHash,
    base_frozen_evidence_set_hash: input.baseFrozenEvidenceSetHash,
    score_semantics: "direct_cnn_head_pre_ontology" as const,
    homology_component: "not_executed" as const,
    ontology_propagation: "host_only" as const,
  };
  const receipt: DeepGoPlusCandidateReceipt = {
    ...receiptContent,
    canonical_hash: hashCanonical(receiptContent),
  };
  return {
    candidate_sources: {
      providers: [providerRecord({
        status: "completed",
        release: `${batch.method.packageVersion};data-${batch.method.dataRelease}`,
        requestSha256: batch.requestSha256,
        payloadSha256: batch.predictionSetHash,
        reason: null,
      })],
      go_candidates: candidates,
      deepgoplus_receipt: receipt,
    },
  };
}
