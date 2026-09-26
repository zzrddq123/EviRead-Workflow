import { hashCanonical } from "../hash.js";

export type RsiFramework = "latest_autonomous" | "early_cumulative";
export type FeedbackPolicy = "metric_only" | "structured_diagnostic";
export type HistoryPolicy = "reset" | "persistent" | "shuffled" | "native_linear";
export type ExperimentPhase = "pilot" | "confirmatory";
export type MetricDirection = "maximize" | "minimize";

export interface CandidateBinding {
  candidateId: string;
  artifactHash: string;
  sourceCommit: string;
}

export interface RsiExperimentManifest extends Record<string, unknown> {
  schemaVersion: "pi-rsi-experiment-manifest.v1";
  experimentId: string;
  conditionId: string;
  replicateId: string;
  blockId: string;
  campaignId: string;
  phase: ExperimentPhase;
  framework: RsiFramework;
  feedbackPolicy: FeedbackPolicy;
  historyPolicy: HistoryPolicy;
  initialCandidate: CandidateBinding;
  bindings: {
    scientificBaselineHash: string;
    evaluatorContractHash: string;
    developmentDataHash: string;
    sealedDataCommitmentHash: string | null;
    modelConfigHash: string;
    promptConfigHash: string;
    toolConfigHash: string;
    runtimeConfigHash: string;
  };
  budget: {
    targetValidUpdates: number;
    maxPatchAttempts: number;
    maxEvaluatorCalls: number;
    maxStageAttempts: number;
    maxWallClockSeconds: number;
  };
  stopping: {
    allowEvaluatorStop: boolean;
    allowPlateauStop: boolean;
    plateauPatience: number | null;
    invalidCandidatePolicy: "record_rollback_continue";
  };
  randomization: {
    campaignSeedHash: string;
    matchedBlock: boolean;
  };
  claimBoundary: "development-only selection; sealed evaluation cannot influence candidate selection";
  canonicalHash: string;
}

export interface RsiIterationPrecommit extends Record<string, unknown> {
  schemaVersion: "pi-rsi-iteration-precommit.v1";
  manifestHash: string;
  campaignId: string;
  updateIndex: number;
  patchAttempt: number;
  currentCandidate: CandidateBinding;
  baseCandidate: CandidateBinding;
  feedbackExposure: {
    policy: FeedbackPolicy;
    privateEvaluationHash: string;
    developerViewHash: string;
  };
  historyExposure: {
    policy: HistoryPolicy;
    contextHash: string | null;
    recordCount: number;
    matchedArtifactHash: string | null;
  };
  diagnosis: {
    problemCodes: string[];
    summary: string;
    rootCause: string;
  };
  intervention: {
    changeFamily: string;
    changeTargets: string[];
    hypothesis: string;
    predictedEffects: Array<{
      metricId: string;
      sliceId: string;
      direction: "increase" | "decrease" | "unchanged";
      minimumDelta: number | null;
    }>;
    guardrails: string[];
    falsifiers: string[];
    rollbackCondition: string;
  };
  preActionSourceHash: string;
  recordedAt: string;
  canonicalHash: string;
}

export interface RsiEvaluationReceipt extends Record<string, unknown> {
  schemaVersion: "pi-rsi-evaluation-receipt.v1";
  manifestHash: string;
  campaignId: string;
  evaluationId: string;
  split: "development" | "sealed";
  candidate: CandidateBinding;
  parentCandidateId: string | null;
  updateIndex: number;
  evaluatorCallIndex: number;
  evaluatorContractHash: string;
  privateArtifactHash: string;
  developerViewHash: string | null;
  feedbackPolicy: FeedbackPolicy | null;
  primary: {
    metricId: string;
    value: number;
    direction: MetricDirection;
    threshold: number | null;
  };
  metricsCompleteness: "primary_only" | "canonical_16";
  metrics: Array<{
    label: string;
    scope: "overall" | "molecular_function" | "biological_process" | "cellular_component";
    metric: "Fmax" | "AUPR" | "IA-wFmax" | "nSmin" | "Smin" | "fixed_precision" | "fixed_recall";
    direction: MetricDirection;
    value: number | null;
    threshold: number | null;
    proteinCount: number;
  }>;
  slices: Array<{
    sliceId: string;
    proteinCount: number;
    metricId: string;
    value: number | null;
  }>;
  deltas: {
    fromParent: number | null;
    fromInitial: number | null;
    fromBestBefore: number | null;
  };
  decision: "initial" | "promote" | "retain_parent" | "record_only";
  codeChange: {
    parentCommit: string | null;
    sourceCommit: string;
    sourceTree: string;
    diffHash: string | null;
    changedPaths: string[];
    insertions: number | null;
    deletions: number | null;
  };
  recordedAt: string;
  canonicalHash: string;
}

export interface RsiResourceUsageReceipt extends Record<string, unknown> {
  schemaVersion: "pi-rsi-resource-usage-receipt.v1";
  manifestHash: string;
  campaignId: string;
  updateIndex: number;
  patchAttempt: number;
  stage: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  wallClockMs: number;
  exitCode: number;
  status: "completed" | "retryable_failure" | "fatal_failure" | "invalid_candidate";
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    modelCalls: number | null;
    toolCalls: number | null;
    evaluatorCalls: number;
    costUsd: number | null;
  };
  errorClass: string | null;
  stdoutHash: string | null;
  stderrHash: string | null;
  canonicalHash: string;
}

export interface RsiCampaignFreezeManifest extends Record<string, unknown> {
  schemaVersion: "pi-rsi-campaign-freeze-manifest.v1";
  manifestHash: string;
  campaignId: string;
  finalCandidate: CandidateBinding;
  selectionRule: string;
  developmentEvaluationHash: string;
  validUpdateCount: number;
  patchAttemptCount: number;
  evaluatorCallCount: number;
  eventHeadHash: string;
  sealedEvaluationState: "unopened";
  frozenAt: string;
  canonicalHash: string;
}

export interface RsiSealedReplayManifest extends Record<string, unknown> {
  schemaVersion: "pi-rsi-sealed-replay-manifest.v1";
  experimentId: string;
  sealedDataCommitmentHash: string;
  allCampaignsFrozenHash: string;
  finalCandidateEvaluationHashes: string[];
  archivedCheckpointEvaluationHashes: string[];
  selectionAfterSealedEvaluation: "forbidden";
  openedAt: string;
  canonicalHash: string;
}

export type RsiExperimentRecord =
  | RsiIterationPrecommit
  | RsiEvaluationReceipt
  | RsiResourceUsageReceipt
  | RsiCampaignFreezeManifest
  | RsiSealedReplayManifest;

export interface RsiExperimentIndex extends Record<string, unknown> {
  schemaVersion: "pi-rsi-experiment-index.v1";
  manifestHash: string;
  campaignId: string;
  records: Array<{
    sequence: number;
    kind: RsiExperimentRecord["schemaVersion"];
    relativePath: string;
    recordHash: string;
    previousEventHash: string | null;
    eventHash: string;
  }>;
  eventHeadHash: string | null;
  frozen: boolean;
  canonicalHash: string;
}

const HASH = /^[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40,64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} keys mismatch`);
}

function text(value: unknown, label: string, maximum = 4000): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`${label} must be bounded text`);
  return value;
}

function id(value: unknown, label: string): string {
  const output = text(value, label, 128);
  if (!ID.test(output)) throw new Error(`${label} is not a safe identifier`);
  return output;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} is not a SHA-256 hash`);
  return value;
}

function oid(value: unknown, label: string): string {
  if (typeof value !== "string" || !OID.test(value)) throw new Error(`${label} is not a Git object id`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${label} is outside [${minimum}, ${maximum}]`);
  return Number(value);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be RFC3339 UTC`);
  return value;
}

function stringList(value: unknown, label: string, maximum = 256): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be a bounded array`);
  const output = value.map((entry, index) => text(entry, `${label}[${index}]`, 1200));
  if (new Set(output).size !== output.length) throw new Error(`${label} contains duplicates`);
  return output;
}

function canonical<T extends Record<string, unknown>>(value: T, label: string): T {
  const { canonicalHash, ...body } = value;
  if (typeof canonicalHash !== "string" || canonicalHash !== hashCanonical(body)) throw new Error(`${label} canonicalHash mismatch`);
  return value;
}

export function withExperimentHash<T extends Record<string, unknown>>(value: T): T & { canonicalHash: string } {
  return { ...value, canonicalHash: hashCanonical(value) };
}

export function assertCandidateBinding(value: unknown, label: string): CandidateBinding {
  const item = object(value, label);
  exact(item, ["candidateId", "artifactHash", "sourceCommit"], label);
  return { candidateId: id(item.candidateId, `${label}.candidateId`), artifactHash: hash(item.artifactHash, `${label}.artifactHash`), sourceCommit: oid(item.sourceCommit, `${label}.sourceCommit`) };
}

export function assertExperimentManifest(value: unknown): RsiExperimentManifest {
  const item = canonical(object(value, "experiment manifest"), "experiment manifest");
  exact(item, ["schemaVersion", "experimentId", "conditionId", "replicateId", "blockId", "campaignId", "phase", "framework", "feedbackPolicy", "historyPolicy", "initialCandidate", "bindings", "budget", "stopping", "randomization", "claimBoundary", "canonicalHash"], "experiment manifest");
  if (item.schemaVersion !== "pi-rsi-experiment-manifest.v1") throw new Error("unsupported experiment manifest");
  ["experimentId", "conditionId", "replicateId", "blockId", "campaignId"].forEach((key) => id(item[key], `experiment manifest.${key}`));
  if (!["pilot", "confirmatory"].includes(String(item.phase))) throw new Error("experiment phase is invalid");
  if (!["latest_autonomous", "early_cumulative"].includes(String(item.framework))) throw new Error("experiment framework is invalid");
  if (!["metric_only", "structured_diagnostic"].includes(String(item.feedbackPolicy))) throw new Error("feedback policy is invalid");
  if (!["reset", "persistent", "shuffled", "native_linear"].includes(String(item.historyPolicy))) throw new Error("history policy is invalid");
  if (item.framework === "early_cumulative" && item.historyPolicy !== "native_linear") throw new Error("EarlyRSI must retain native_linear history semantics");
  if (item.framework === "latest_autonomous" && item.historyPolicy === "native_linear") throw new Error("LatestRSI cannot use native_linear history semantics");
  assertCandidateBinding(item.initialCandidate, "experiment manifest.initialCandidate");
  const bindings = object(item.bindings, "experiment manifest.bindings");
  exact(bindings, ["scientificBaselineHash", "evaluatorContractHash", "developmentDataHash", "sealedDataCommitmentHash", "modelConfigHash", "promptConfigHash", "toolConfigHash", "runtimeConfigHash"], "experiment manifest.bindings");
  for (const [key, entry] of Object.entries(bindings)) if (entry !== null) hash(entry, `experiment manifest.bindings.${key}`);
  if (item.phase === "confirmatory" && bindings.sealedDataCommitmentHash === null) throw new Error("confirmatory manifest requires a sealed data commitment");
  const budget = object(item.budget, "experiment manifest.budget");
  exact(budget, ["targetValidUpdates", "maxPatchAttempts", "maxEvaluatorCalls", "maxStageAttempts", "maxWallClockSeconds"], "experiment manifest.budget");
  integer(budget.targetValidUpdates, "targetValidUpdates", 1, 100);
  integer(budget.maxPatchAttempts, "maxPatchAttempts", Number(budget.targetValidUpdates), 1000);
  integer(budget.maxEvaluatorCalls, "maxEvaluatorCalls", Number(budget.targetValidUpdates) + 1, 2000);
  integer(budget.maxStageAttempts, "maxStageAttempts", 1, 100);
  integer(budget.maxWallClockSeconds, "maxWallClockSeconds", 1, 31_536_000);
  const stopping = object(item.stopping, "experiment manifest.stopping");
  exact(stopping, ["allowEvaluatorStop", "allowPlateauStop", "plateauPatience", "invalidCandidatePolicy"], "experiment manifest.stopping");
  if (typeof stopping.allowEvaluatorStop !== "boolean" || typeof stopping.allowPlateauStop !== "boolean" || stopping.invalidCandidatePolicy !== "record_rollback_continue") throw new Error("experiment stopping policy is invalid");
  if (stopping.plateauPatience !== null) integer(stopping.plateauPatience, "plateauPatience", 1, 10000);
  const randomization = object(item.randomization, "experiment manifest.randomization");
  exact(randomization, ["campaignSeedHash", "matchedBlock"], "experiment manifest.randomization");
  hash(randomization.campaignSeedHash, "campaignSeedHash");
  if (typeof randomization.matchedBlock !== "boolean") throw new Error("matchedBlock must be boolean");
  if (item.claimBoundary !== "development-only selection; sealed evaluation cannot influence candidate selection") throw new Error("experiment claim boundary is invalid");
  return item as unknown as RsiExperimentManifest;
}

function assertRecordBase(item: Record<string, unknown>, manifest: RsiExperimentManifest, label: string): void {
  hash(item.manifestHash, `${label}.manifestHash`);
  if (item.manifestHash !== manifest.canonicalHash || item.campaignId !== manifest.campaignId) throw new Error(`${label} does not bind the experiment manifest`);
  integer(item.updateIndex, `${label}.updateIndex`, 0, manifest.budget.maxPatchAttempts);
}

export function assertIterationPrecommit(value: unknown, manifest: RsiExperimentManifest): RsiIterationPrecommit {
  const item = canonical(object(value, "iteration precommit"), "iteration precommit");
  exact(item, ["schemaVersion", "manifestHash", "campaignId", "updateIndex", "patchAttempt", "currentCandidate", "baseCandidate", "feedbackExposure", "historyExposure", "diagnosis", "intervention", "preActionSourceHash", "recordedAt", "canonicalHash"], "iteration precommit");
  if (item.schemaVersion !== "pi-rsi-iteration-precommit.v1") throw new Error("unsupported iteration precommit");
  assertRecordBase(item, manifest, "iteration precommit");
  integer(item.patchAttempt, "iteration precommit.patchAttempt", 1, manifest.budget.maxPatchAttempts);
  assertCandidateBinding(item.currentCandidate, "iteration precommit.currentCandidate");
  assertCandidateBinding(item.baseCandidate, "iteration precommit.baseCandidate");
  const feedback = object(item.feedbackExposure, "iteration precommit.feedbackExposure");
  exact(feedback, ["policy", "privateEvaluationHash", "developerViewHash"], "iteration precommit.feedbackExposure");
  if (feedback.policy !== manifest.feedbackPolicy) throw new Error("precommit feedback policy differs from manifest");
  hash(feedback.privateEvaluationHash, "privateEvaluationHash"); hash(feedback.developerViewHash, "developerViewHash");
  const history = object(item.historyExposure, "iteration precommit.historyExposure");
  exact(history, ["policy", "contextHash", "recordCount", "matchedArtifactHash"], "iteration precommit.historyExposure");
  if (history.policy !== manifest.historyPolicy) throw new Error("precommit history policy differs from manifest");
  if (history.contextHash !== null) hash(history.contextHash, "history contextHash");
  if (history.matchedArtifactHash !== null) hash(history.matchedArtifactHash, "history matchedArtifactHash");
  integer(history.recordCount, "history recordCount", 0, 100000);
  if (manifest.historyPolicy === "reset" && (Number(history.recordCount) !== 0 || history.matchedArtifactHash !== null)) throw new Error("reset history must expose zero prior records");
  if (manifest.historyPolicy === "shuffled" && history.matchedArtifactHash === null) throw new Error("shuffled history requires a matched artifact hash");
  const diagnosis = object(item.diagnosis, "iteration precommit.diagnosis");
  exact(diagnosis, ["problemCodes", "summary", "rootCause"], "iteration precommit.diagnosis");
  stringList(diagnosis.problemCodes, "problemCodes", 32); text(diagnosis.summary, "diagnosis.summary"); text(diagnosis.rootCause, "diagnosis.rootCause");
  const intervention = object(item.intervention, "iteration precommit.intervention");
  exact(intervention, ["changeFamily", "changeTargets", "hypothesis", "predictedEffects", "guardrails", "falsifiers", "rollbackCondition"], "iteration precommit.intervention");
  id(intervention.changeFamily, "changeFamily"); stringList(intervention.changeTargets, "changeTargets", 64); text(intervention.hypothesis, "hypothesis");
  if (!Array.isArray(intervention.predictedEffects) || intervention.predictedEffects.length < 1 || intervention.predictedEffects.length > 64) throw new Error("predictedEffects must contain 1..64 entries");
  for (const [index, raw] of intervention.predictedEffects.entries()) {
    const effect = object(raw, `predictedEffects[${index}]`);
    exact(effect, ["metricId", "sliceId", "direction", "minimumDelta"], `predictedEffects[${index}]`);
    id(effect.metricId, `predictedEffects[${index}].metricId`); id(effect.sliceId, `predictedEffects[${index}].sliceId`);
    if (!["increase", "decrease", "unchanged"].includes(String(effect.direction))) throw new Error("predicted effect direction is invalid");
    if (effect.minimumDelta !== null) finite(effect.minimumDelta, `predictedEffects[${index}].minimumDelta`);
  }
  stringList(intervention.guardrails, "guardrails", 32); stringList(intervention.falsifiers, "falsifiers", 32); text(intervention.rollbackCondition, "rollbackCondition");
  hash(item.preActionSourceHash, "preActionSourceHash"); timestamp(item.recordedAt, "recordedAt");
  return item as unknown as RsiIterationPrecommit;
}

const EXPECTED_16 = new Set(["Overall Fmax", "Overall AUPR", "Overall IA-wFmax", "Overall nSmin", "MF Fmax", "MF AUPR", "MF IA-wFmax", "MF Smin", "BP Fmax", "BP AUPR", "BP IA-wFmax", "BP Smin", "CC Fmax", "CC AUPR", "CC IA-wFmax", "CC Smin"]);

export function assertEvaluationReceipt(value: unknown, manifest: RsiExperimentManifest): RsiEvaluationReceipt {
  const item = canonical(object(value, "evaluation receipt"), "evaluation receipt");
  exact(item, ["schemaVersion", "manifestHash", "campaignId", "evaluationId", "split", "candidate", "parentCandidateId", "updateIndex", "evaluatorCallIndex", "evaluatorContractHash", "privateArtifactHash", "developerViewHash", "feedbackPolicy", "primary", "metricsCompleteness", "metrics", "slices", "deltas", "decision", "codeChange", "recordedAt", "canonicalHash"], "evaluation receipt");
  if (item.schemaVersion !== "pi-rsi-evaluation-receipt.v1") throw new Error("unsupported evaluation receipt");
  assertRecordBase(item, manifest, "evaluation receipt"); id(item.evaluationId, "evaluationId");
  if (item.split !== "development" && item.split !== "sealed") throw new Error("evaluation split is invalid");
  if (item.split === "sealed" && !manifest.bindings.sealedDataCommitmentHash) throw new Error("sealed evaluation requires a sealed commitment");
  assertCandidateBinding(item.candidate, "evaluation receipt.candidate");
  if (item.parentCandidateId !== null) id(item.parentCandidateId, "parentCandidateId");
  integer(item.evaluatorCallIndex, "evaluatorCallIndex", 1, manifest.budget.maxEvaluatorCalls);
  if (item.evaluatorContractHash !== manifest.bindings.evaluatorContractHash) throw new Error("evaluation contract differs from manifest");
  hash(item.privateArtifactHash, "privateArtifactHash");
  if (item.developerViewHash !== null) hash(item.developerViewHash, "developerViewHash");
  if (item.split === "development" && item.feedbackPolicy !== manifest.feedbackPolicy) throw new Error("development feedback policy differs from manifest");
  if (item.split === "sealed" && (item.developerViewHash !== null || item.feedbackPolicy !== null)) throw new Error("sealed evaluation cannot expose developer feedback");
  const primary = object(item.primary, "evaluation receipt.primary");
  exact(primary, ["metricId", "value", "direction", "threshold"], "evaluation receipt.primary");
  id(primary.metricId, "primary.metricId"); finite(primary.value, "primary.value");
  if (primary.direction !== "maximize" && primary.direction !== "minimize") throw new Error("primary direction is invalid");
  if (primary.threshold !== null) finite(primary.threshold, "primary.threshold");
  if (item.metricsCompleteness !== "primary_only" && item.metricsCompleteness !== "canonical_16") throw new Error("metricsCompleteness is invalid");
  if (!Array.isArray(item.metrics)) throw new Error("metrics must be an array");
  const labels = new Set<string>();
  for (const [index, raw] of item.metrics.entries()) {
    const metric = object(raw, `metrics[${index}]`);
    exact(metric, ["label", "scope", "metric", "direction", "value", "threshold", "proteinCount"], `metrics[${index}]`);
    const label = text(metric.label, `metrics[${index}].label`, 64); if (labels.has(label)) throw new Error("metrics contains duplicate labels"); labels.add(label);
    if (!["overall", "molecular_function", "biological_process", "cellular_component"].includes(String(metric.scope))) throw new Error("metric scope is invalid");
    if (!["Fmax", "AUPR", "IA-wFmax", "nSmin", "Smin", "fixed_precision", "fixed_recall"].includes(String(metric.metric))) throw new Error("metric name is invalid");
    if (metric.direction !== "maximize" && metric.direction !== "minimize") throw new Error("metric direction is invalid");
    if (metric.value !== null) finite(metric.value, `metrics[${index}].value`);
    if (metric.threshold !== null) finite(metric.threshold, `metrics[${index}].threshold`);
    integer(metric.proteinCount, `metrics[${index}].proteinCount`, 0, 10_000_000);
  }
  if (item.metricsCompleteness === "canonical_16" && (EXPECTED_16.size !== [...labels].filter((label) => EXPECTED_16.has(label)).length)) throw new Error("canonical_16 receipt is missing canonical metrics");
  if (!Array.isArray(item.slices)) throw new Error("slices must be an array");
  item.slices.forEach((raw, index) => { const slice = object(raw, `slices[${index}]`); exact(slice, ["sliceId", "proteinCount", "metricId", "value"], `slices[${index}]`); id(slice.sliceId, `slices[${index}].sliceId`); id(slice.metricId, `slices[${index}].metricId`); integer(slice.proteinCount, `slices[${index}].proteinCount`, 0, 10_000_000); if (slice.value !== null) finite(slice.value, `slices[${index}].value`); });
  const deltas = object(item.deltas, "evaluation receipt.deltas"); exact(deltas, ["fromParent", "fromInitial", "fromBestBefore"], "evaluation receipt.deltas"); for (const [key, entry] of Object.entries(deltas)) if (entry !== null) finite(entry, `deltas.${key}`);
  if (!["initial", "promote", "retain_parent", "record_only"].includes(String(item.decision))) throw new Error("evaluation decision is invalid");
  const code = object(item.codeChange, "evaluation receipt.codeChange"); exact(code, ["parentCommit", "sourceCommit", "sourceTree", "diffHash", "changedPaths", "insertions", "deletions"], "evaluation receipt.codeChange");
  if (code.parentCommit !== null) oid(code.parentCommit, "codeChange.parentCommit"); oid(code.sourceCommit, "codeChange.sourceCommit"); oid(code.sourceTree, "codeChange.sourceTree"); if (code.diffHash !== null) hash(code.diffHash, "codeChange.diffHash"); stringList(code.changedPaths, "codeChange.changedPaths", 10000); if (code.insertions !== null) integer(code.insertions, "insertions"); if (code.deletions !== null) integer(code.deletions, "deletions");
  timestamp(item.recordedAt, "recordedAt");
  return item as unknown as RsiEvaluationReceipt;
}

export function assertResourceUsageReceipt(value: unknown, manifest: RsiExperimentManifest): RsiResourceUsageReceipt {
  const item = canonical(object(value, "resource usage receipt"), "resource usage receipt");
  exact(item, ["schemaVersion", "manifestHash", "campaignId", "updateIndex", "patchAttempt", "stage", "attempt", "startedAt", "finishedAt", "wallClockMs", "exitCode", "status", "usage", "errorClass", "stdoutHash", "stderrHash", "canonicalHash"], "resource usage receipt");
  if (item.schemaVersion !== "pi-rsi-resource-usage-receipt.v1") throw new Error("unsupported resource usage receipt");
  assertRecordBase(item, manifest, "resource usage receipt"); integer(item.patchAttempt, "patchAttempt", 0, manifest.budget.maxPatchAttempts); text(item.stage, "stage", 128); integer(item.attempt, "attempt", 1, manifest.budget.maxStageAttempts); timestamp(item.startedAt, "startedAt"); timestamp(item.finishedAt, "finishedAt"); integer(item.wallClockMs, "wallClockMs", 0, manifest.budget.maxWallClockSeconds * 1000); integer(item.exitCode, "exitCode", -255, 255);
  if (!["completed", "retryable_failure", "fatal_failure", "invalid_candidate"].includes(String(item.status))) throw new Error("resource status is invalid");
  const usage = object(item.usage, "resource usage receipt.usage"); exact(usage, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "modelCalls", "toolCalls", "evaluatorCalls", "costUsd"], "resource usage receipt.usage");
  for (const [key, entry] of Object.entries(usage)) if (entry !== null) { if (key === "costUsd") { if (finite(entry, `usage.${key}`) < 0) throw new Error("costUsd cannot be negative"); } else integer(entry, `usage.${key}`, 0); }
  if (item.errorClass !== null) id(item.errorClass, "errorClass"); if (item.stdoutHash !== null) hash(item.stdoutHash, "stdoutHash"); if (item.stderrHash !== null) hash(item.stderrHash, "stderrHash");
  return item as unknown as RsiResourceUsageReceipt;
}

export function assertFreezeManifest(value: unknown, manifest: RsiExperimentManifest): RsiCampaignFreezeManifest {
  const item = canonical(object(value, "campaign freeze manifest"), "campaign freeze manifest");
  exact(item, ["schemaVersion", "manifestHash", "campaignId", "finalCandidate", "selectionRule", "developmentEvaluationHash", "validUpdateCount", "patchAttemptCount", "evaluatorCallCount", "eventHeadHash", "sealedEvaluationState", "frozenAt", "canonicalHash"], "campaign freeze manifest");
  if (item.schemaVersion !== "pi-rsi-campaign-freeze-manifest.v1") throw new Error("unsupported campaign freeze manifest");
  if (item.manifestHash !== manifest.canonicalHash || item.campaignId !== manifest.campaignId) throw new Error("freeze manifest binding mismatch");
  assertCandidateBinding(item.finalCandidate, "freeze finalCandidate"); text(item.selectionRule, "selectionRule"); hash(item.developmentEvaluationHash, "developmentEvaluationHash"); integer(item.validUpdateCount, "validUpdateCount", 0, manifest.budget.targetValidUpdates); integer(item.patchAttemptCount, "patchAttemptCount", 0, manifest.budget.maxPatchAttempts); integer(item.evaluatorCallCount, "evaluatorCallCount", 1, manifest.budget.maxEvaluatorCalls); hash(item.eventHeadHash, "eventHeadHash"); if (item.sealedEvaluationState !== "unopened") throw new Error("campaign must freeze before sealed evaluation"); timestamp(item.frozenAt, "frozenAt");
  if (manifest.phase === "confirmatory" && Number(item.validUpdateCount) !== manifest.budget.targetValidUpdates) throw new Error("confirmatory campaign cannot freeze before targetValidUpdates");
  return item as unknown as RsiCampaignFreezeManifest;
}

export function assertSealedReplayManifest(value: unknown): RsiSealedReplayManifest {
  const item = canonical(object(value, "sealed replay manifest"), "sealed replay manifest");
  exact(item, ["schemaVersion", "experimentId", "sealedDataCommitmentHash", "allCampaignsFrozenHash", "finalCandidateEvaluationHashes", "archivedCheckpointEvaluationHashes", "selectionAfterSealedEvaluation", "openedAt", "canonicalHash"], "sealed replay manifest");
  if (item.schemaVersion !== "pi-rsi-sealed-replay-manifest.v1" || item.selectionAfterSealedEvaluation !== "forbidden") throw new Error("unsupported sealed replay manifest");
  id(item.experimentId, "experimentId"); hash(item.sealedDataCommitmentHash, "sealedDataCommitmentHash"); hash(item.allCampaignsFrozenHash, "allCampaignsFrozenHash");
  ["finalCandidateEvaluationHashes", "archivedCheckpointEvaluationHashes"].forEach((key) => { if (!Array.isArray(item[key])) throw new Error(`${key} must be an array`); item[key].forEach((entry, index) => hash(entry, `${key}[${index}]`)); });
  if ((item.finalCandidateEvaluationHashes as unknown[]).length < 1) throw new Error("sealed replay must contain final candidate evaluations"); timestamp(item.openedAt, "openedAt");
  return item as unknown as RsiSealedReplayManifest;
}

export function assertExperimentRecord(value: unknown, manifest: RsiExperimentManifest): RsiExperimentRecord {
  const schema = object(value, "experiment record").schemaVersion;
  if (schema === "pi-rsi-iteration-precommit.v1") return assertIterationPrecommit(value, manifest);
  if (schema === "pi-rsi-evaluation-receipt.v1") return assertEvaluationReceipt(value, manifest);
  if (schema === "pi-rsi-resource-usage-receipt.v1") return assertResourceUsageReceipt(value, manifest);
  if (schema === "pi-rsi-campaign-freeze-manifest.v1") return assertFreezeManifest(value, manifest);
  if (schema === "pi-rsi-sealed-replay-manifest.v1") {
    const replay = assertSealedReplayManifest(value);
    if (replay.experimentId !== manifest.experimentId || replay.sealedDataCommitmentHash !== manifest.bindings.sealedDataCommitmentHash) throw new Error("sealed replay does not bind this experiment/data commitment");
    return replay;
  }
  throw new Error(`unsupported experiment record schema: ${String(schema)}`);
}
