import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { hashCanonical } from "../hash.js";
import { withExperimentHash, type CandidateBinding, type RsiEvaluationReceipt, type RsiExperimentManifest, type RsiIterationPrecommit, type RsiResourceUsageReceipt } from "./contracts.js";
import { appendExperimentRecord, readExperimentRecords, sha256File } from "./store.js";

const execFileAsync = promisify(execFile);

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function strings(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))] : []; }
function candidate(value: unknown, fallback: CandidateBinding): CandidateBinding { const item = object(value); return typeof item.candidateId === "string" && typeof item.artifactHash === "string" && typeof item.sourceCommit === "string" ? item as unknown as CandidateBinding : fallback; }
function now(): string { return new Date().toISOString(); }

async function git(repository: string, args: string[]): Promise<string> {
  return (await execFileAsync("/usr/bin/git", args, { cwd: repository, env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C.UTF-8" }, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}

async function codeChange(repository: string, current: CandidateBinding, parentCommit: string | null): Promise<RsiEvaluationReceipt["codeChange"]> {
  const sourceTree = await git(repository, ["rev-parse", `${current.sourceCommit}^{tree}`]);
  if (!parentCommit) return { parentCommit: null, sourceCommit: current.sourceCommit, sourceTree, diffHash: null, changedPaths: [], insertions: null, deletions: null };
  const diff = await git(repository, ["diff", "--binary", parentCommit, current.sourceCommit, "--"]);
  const names = (await git(repository, ["diff", "--name-only", parentCommit, current.sourceCommit, "--"])).split("\n").filter(Boolean).sort();
  const numstat = (await git(repository, ["diff", "--numstat", parentCommit, current.sourceCommit, "--"])).split("\n").filter(Boolean);
  let insertions = 0; let deletions = 0;
  for (const line of numstat) { const [added, removed] = line.split("\t"); if (/^\d+$/.test(added ?? "")) insertions += Number(added); if (/^\d+$/.test(removed ?? "")) deletions += Number(removed); }
  return { parentCommit, sourceCommit: current.sourceCommit, sourceTree, diffHash: hashCanonical({ parentCommit, sourceCommit: current.sourceCommit, diff }), changedPaths: names, insertions, deletions };
}

export async function recordLoopPrecommit(input: {
  campaignDir: string; manifest: RsiExperimentManifest; updateIndex: number; patchAttempt: number;
  currentCandidate: CandidateBinding; baseCandidate: CandidateBinding; evaluateOutput: Record<string, unknown>;
  diagnosisOutput: Record<string, unknown>; planOutput: Record<string, unknown>; historyContextHash: string | null;
  historyRecordCount: number; matchedHistoryHash: string | null;
}): Promise<RsiIterationPrecommit> {
  const evaluatePayload = object(input.evaluateOutput.payload); const binding = object(evaluatePayload.evaluationBinding); const feedback = object(evaluatePayload.feedback);
  if (input.manifest.phase === "confirmatory" && (typeof binding.evaluatorResultHash !== "string" || typeof binding.developerFeedbackHash !== "string")) throw new Error("confirmatory precommit requires evaluator/developer view hashes from the evaluator adapter");
  const diagnosis = object(input.diagnosisOutput.payload); const plan = object(input.planOutput.payload);
  const record = withExperimentHash({
    schemaVersion: "pi-rsi-iteration-precommit.v1" as const, manifestHash: input.manifest.canonicalHash, campaignId: input.manifest.campaignId,
    updateIndex: input.updateIndex, patchAttempt: input.patchAttempt, currentCandidate: input.currentCandidate, baseCandidate: input.baseCandidate,
    feedbackExposure: { policy: input.manifest.feedbackPolicy, privateEvaluationHash: typeof binding.evaluatorResultHash === "string" ? binding.evaluatorResultHash : input.evaluateOutput.canonicalHash as string, developerViewHash: typeof binding.developerFeedbackHash === "string" ? binding.developerFeedbackHash : hashCanonical(feedback) },
    historyExposure: { policy: input.manifest.historyPolicy, contextHash: input.historyContextHash, recordCount: input.manifest.historyPolicy === "reset" ? 0 : input.historyRecordCount, matchedArtifactHash: input.manifest.historyPolicy === "shuffled" ? input.matchedHistoryHash : null },
    diagnosis: { problemCodes: strings(diagnosis.problemCodes ?? diagnosis.diagnoses), summary: String(diagnosis.summary ?? input.diagnosisOutput.summary ?? "No diagnosis summary supplied."), rootCause: String(diagnosis.rootCauseRationale ?? diagnosis.rootCause ?? "No structured root cause supplied.") },
    intervention: { changeFamily: String(plan.changeFamily), changeTargets: strings(plan.changeTargets), hypothesis: String(plan.hypothesis), predictedEffects: plan.predictedEffects as RsiIterationPrecommit["intervention"]["predictedEffects"], guardrails: strings(plan.controls ?? plan.guardrails), falsifiers: strings(plan.falsifiers), rollbackCondition: String(plan.rollbackCondition) },
    preActionSourceHash: hashCanonical({ evaluate: input.evaluateOutput.canonicalHash, diagnosis: input.diagnosisOutput.canonicalHash, plan: input.planOutput.canonicalHash, history: input.historyContextHash }), recordedAt: now(),
  }) as RsiIterationPrecommit;
  await appendExperimentRecord(input.campaignDir, record); return record;
}

export async function recordLoopEvaluation(input: {
  campaignDir: string; manifest: RsiExperimentManifest; repositoryRoot: string; updateIndex: number; evaluatorCallIndex: number;
  candidate: CandidateBinding; parentCandidateId: string | null; parentCommit: string | null; output: Record<string, unknown>;
  deltaFromParent: number | null; deltaFromInitial: number | null; deltaFromBestBefore: number | null; decision: RsiEvaluationReceipt["decision"];
}): Promise<RsiEvaluationReceipt> {
  const payload = object(input.output.payload); const metric = object(payload.metric); const feedback = object(payload.feedback); const binding = object(payload.evaluationBinding);
  if (input.manifest.phase === "confirmatory" && (typeof binding.evaluatorResultHash !== "string" || typeof binding.developerFeedbackHash !== "string")) throw new Error("confirmatory evaluation requires evaluator adapter bindings");
  const suppliedMetrics = Array.isArray(feedback.metrics16) ? feedback.metrics16 : Array.isArray(feedback.aggregateMetrics) ? feedback.aggregateMetrics : [];
  const metrics = suppliedMetrics.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) as RsiEvaluationReceipt["metrics"];
  const slices = Array.isArray(feedback.slices) ? feedback.slices.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) as RsiEvaluationReceipt["slices"] : [];
  const record = withExperimentHash({
    schemaVersion: "pi-rsi-evaluation-receipt.v1" as const, manifestHash: input.manifest.canonicalHash, campaignId: input.manifest.campaignId,
    evaluationId: `${input.manifest.campaignId}-dev-${String(input.evaluatorCallIndex).padStart(4, "0")}`.slice(0, 128), split: "development" as const,
    candidate: input.candidate, parentCandidateId: input.parentCandidateId, updateIndex: input.updateIndex, evaluatorCallIndex: input.evaluatorCallIndex,
    evaluatorContractHash: input.manifest.bindings.evaluatorContractHash, privateArtifactHash: typeof binding.evaluatorResultHash === "string" ? binding.evaluatorResultHash : input.output.canonicalHash as string,
    developerViewHash: typeof binding.developerFeedbackHash === "string" ? binding.developerFeedbackHash : hashCanonical(feedback), feedbackPolicy: input.manifest.feedbackPolicy,
    primary: { metricId: String(metric.metricId), value: Number(metric.value), direction: "maximize" as const, threshold: typeof feedback.operatingThreshold === "number" ? feedback.operatingThreshold : null },
    metricsCompleteness: metrics.length >= 16 ? "canonical_16" as const : "primary_only" as const, metrics, slices,
    deltas: { fromParent: input.deltaFromParent, fromInitial: input.deltaFromInitial, fromBestBefore: input.deltaFromBestBefore }, decision: input.decision,
    codeChange: await codeChange(input.repositoryRoot, input.candidate, input.parentCommit), recordedAt: now(),
  }) as RsiEvaluationReceipt;
  await appendExperimentRecord(input.campaignDir, record); return record;
}

export async function freezeLoopExperiment(input: {
  campaignDir: string; manifest: RsiExperimentManifest; finalCandidate: CandidateBinding; selectionRule: string;
  validUpdateCount: number; patchAttemptCount: number; evaluatorCallCount: number; eventHeadHash: string;
}): Promise<void> {
  const loaded = await readExperimentRecords(input.campaignDir);
  if (loaded.index.frozen) return;
  const evaluations = loaded.records.filter((record): record is RsiEvaluationReceipt => record.schemaVersion === "pi-rsi-evaluation-receipt.v1" && record.split === "development");
  const selected = [...evaluations].reverse().find((record) => record.candidate.candidateId === input.finalCandidate.candidateId);
  if (!selected) throw new Error("cannot freeze experiment without the selected candidate development receipt");
  const record = withExperimentHash({
    schemaVersion: "pi-rsi-campaign-freeze-manifest.v1" as const, manifestHash: input.manifest.canonicalHash, campaignId: input.manifest.campaignId,
    finalCandidate: input.finalCandidate, selectionRule: input.selectionRule, developmentEvaluationHash: selected.canonicalHash,
    validUpdateCount: input.validUpdateCount, patchAttemptCount: input.patchAttemptCount, evaluatorCallCount: input.evaluatorCallCount,
    eventHeadHash: input.eventHeadHash, sealedEvaluationState: "unopened" as const, frozenAt: now(),
  });
  await appendExperimentRecord(input.campaignDir, record);
}

export async function recordLoopResource(input: {
  campaignDir: string; manifest: RsiExperimentManifest; updateIndex: number; patchAttempt: number; stage: string; attempt: number;
  startedAt: string; finishedAt: string; wallClockMs: number; exitCode: number; status: RsiResourceUsageReceipt["status"];
  output?: Record<string, unknown>; stdoutPath?: string; stderrPath?: string; errorClass?: string | null;
}): Promise<RsiResourceUsageReceipt> {
  const usage = object(object(input.output?.payload).resourceUsage);
  const known = (key: string): number | null => typeof usage[key] === "number" && Number.isFinite(usage[key]) && Number(usage[key]) >= 0 ? Number(usage[key]) : null;
  const record = withExperimentHash({
    schemaVersion: "pi-rsi-resource-usage-receipt.v1" as const, manifestHash: input.manifest.canonicalHash, campaignId: input.manifest.campaignId,
    updateIndex: input.updateIndex, patchAttempt: input.patchAttempt, stage: input.stage, attempt: input.attempt, startedAt: input.startedAt, finishedAt: input.finishedAt,
    wallClockMs: Math.max(0, Math.round(input.wallClockMs)), exitCode: input.exitCode, status: input.status,
    usage: { inputTokens: known("inputTokens"), outputTokens: known("outputTokens"), cacheReadTokens: known("cacheReadTokens"), cacheWriteTokens: known("cacheWriteTokens"), modelCalls: known("modelCalls"), toolCalls: known("toolCalls"), evaluatorCalls: input.stage === "evaluate" && input.status === "completed" ? 1 : 0, costUsd: known("costUsd") },
    errorClass: input.errorClass ?? null, stdoutHash: input.stdoutPath ? await sha256File(input.stdoutPath) : null, stderrHash: input.stderrPath ? await sha256File(input.stderrPath) : null,
  }) as RsiResourceUsageReceipt;
  await appendExperimentRecord(input.campaignDir, record); return record;
}
