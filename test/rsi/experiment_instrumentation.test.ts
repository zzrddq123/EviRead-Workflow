import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFiveCellBatch } from "../../src/experiment/batch.js";
import { assertCandidatePaths } from "../../src/experiment/candidate_guard.js";
import { assertExperimentManifest, withExperimentHash, type RsiEvaluationReceipt, type RsiExperimentManifest, type RsiIterationPrecommit, type RsiResourceUsageReceipt } from "../../src/experiment/contracts.js";
import { renderDeveloperFeedback } from "../../src/experiment/feedback.js";
import { exportCampaign } from "../../src/experiment/exporter.js";
import { appendExperimentRecord, initializeExperimentStore, verifyExperimentStore } from "../../src/experiment/store.js";

const h = (value: string) => value.repeat(64).slice(0, 64);
const commit = "a".repeat(40);
const candidate = { candidateId: "g0", artifactHash: h("b"), sourceCommit: commit };

function manifest(framework: "latest_autonomous" | "early_cumulative" = "latest_autonomous"): RsiExperimentManifest {
  return assertExperimentManifest(withExperimentHash({
    schemaVersion: "pi-rsi-experiment-manifest.v1" as const,
    experimentId: "pilot-e0", conditionId: framework === "latest_autonomous" ? "latest-structured-persistent" : "early-native",
    replicateId: "r01", blockId: "b01", campaignId: framework === "latest_autonomous" ? "latest-r01" : "early-r01", phase: "pilot" as const,
    framework, feedbackPolicy: "structured_diagnostic" as const, historyPolicy: framework === "latest_autonomous" ? "persistent" as const : "native_linear" as const,
    initialCandidate: candidate,
    bindings: { scientificBaselineHash: h("c"), evaluatorContractHash: h("d"), developmentDataHash: h("e"), sealedDataCommitmentHash: h("f"), modelConfigHash: h("1"), promptConfigHash: h("2"), toolConfigHash: h("3"), runtimeConfigHash: h("4") },
    budget: { targetValidUpdates: 10, maxPatchAttempts: 14, maxEvaluatorCalls: 15, maxStageAttempts: 2, maxWallClockSeconds: 86400 },
    stopping: { allowEvaluatorStop: false, allowPlateauStop: false, plateauPatience: null, invalidCandidatePolicy: "record_rollback_continue" as const },
    randomization: { campaignSeedHash: h("5"), matchedBlock: true },
    claimBoundary: "development-only selection; sealed evaluation cannot influence candidate selection" as const,
  }));
}

function precommit(m: RsiExperimentManifest): RsiIterationPrecommit {
  return withExperimentHash({
    schemaVersion: "pi-rsi-iteration-precommit.v1" as const, manifestHash: m.canonicalHash, campaignId: m.campaignId, updateIndex: 1, patchAttempt: 1,
    currentCandidate: candidate, baseCandidate: candidate,
    feedbackExposure: { policy: m.feedbackPolicy, privateEvaluationHash: h("6"), developerViewHash: h("7") },
    historyExposure: { policy: m.historyPolicy, contextHash: h("8"), recordCount: 1, matchedArtifactHash: null },
    diagnosis: { problemCodes: ["candidate_recall_risk"], summary: "Candidate generation is too narrow.", rootCause: "A conservative evidence gate drops recoverable candidates." },
    intervention: { changeFamily: "candidate_generation", changeTargets: ["src/go.ts"], hypothesis: "A bounded candidate expansion improves recall.", predictedEffects: [{ metricId: "development_macro_groups123_overall_fmax", sliceId: "overall", direction: "increase" as const, minimumDelta: 0.001 }], guardrails: ["MF Fmax must not regress"], falsifiers: ["Overall Fmax does not improve"], rollbackCondition: "Rollback on objective regression." },
    preActionSourceHash: h("9"), recordedAt: "2026-08-17T00:00:00Z",
  }) as RsiIterationPrecommit;
}

function evaluation(m: RsiExperimentManifest, split: "development" | "sealed" = "development"): RsiEvaluationReceipt {
  return withExperimentHash({
    schemaVersion: "pi-rsi-evaluation-receipt.v1" as const, manifestHash: m.canonicalHash, campaignId: m.campaignId,
    evaluationId: split === "development" ? "dev-g1" : "sealed-g1", split, candidate: { candidateId: "g1", artifactHash: h("a"), sourceCommit: "b".repeat(40) }, parentCandidateId: "g0", updateIndex: 1, evaluatorCallIndex: split === "development" ? 2 : 3,
    evaluatorContractHash: m.bindings.evaluatorContractHash, privateArtifactHash: h(split === "development" ? "b" : "c"), developerViewHash: split === "development" ? h("d") : null, feedbackPolicy: split === "development" ? m.feedbackPolicy : null,
    primary: { metricId: "development_macro_groups123_overall_fmax", value: split === "development" ? 0.3 : 0.28, direction: "maximize" as const, threshold: 0.42 }, metricsCompleteness: "primary_only" as const, metrics: [], slices: [],
    deltas: { fromParent: 0.1, fromInitial: 0.1, fromBestBefore: 0.1 }, decision: split === "development" ? "promote" as const : "record_only" as const,
    codeChange: { parentCommit: commit, sourceCommit: "b".repeat(40), sourceTree: "c".repeat(40), diffHash: h("e"), changedPaths: ["src/go.ts"], insertions: 4, deletions: 1 }, recordedAt: split === "development" ? "2026-08-17T00:01:00Z" : "2026-08-17T00:03:00Z",
  }) as RsiEvaluationReceipt;
}

function resource(m: RsiExperimentManifest): RsiResourceUsageReceipt {
  return withExperimentHash({ schemaVersion: "pi-rsi-resource-usage-receipt.v1" as const, manifestHash: m.canonicalHash, campaignId: m.campaignId, updateIndex: 1, patchAttempt: 1, stage: "develop", attempt: 1, startedAt: "2026-08-17T00:00:00Z", finishedAt: "2026-08-17T00:00:05Z", wallClockMs: 5000, exitCode: 0, status: "completed" as const, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, modelCalls: 1, toolCalls: 2, evaluatorCalls: 0, costUsd: 0.01 }, errorClass: null, stdoutHash: h("f"), stderrHash: h("0") }) as RsiResourceUsageReceipt;
}

test("experiment store freezes pre-action records before outcomes and seals evaluation order", async () => {
  const root = await mkdtemp(join(tmpdir(), "rsi-experiment-")); const m = manifest();
  try {
    await initializeExperimentStore(root, m);
    await assert.rejects(() => appendExperimentRecord(root, evaluation(m)), /no earlier precommit/);
    await appendExperimentRecord(root, precommit(m)); await appendExperimentRecord(root, resource(m));
    const dev = evaluation(m); await appendExperimentRecord(root, dev);
    await assert.rejects(() => appendExperimentRecord(root, evaluation(m, "sealed")), /frozen campaign/);
    const freeze = withExperimentHash({ schemaVersion: "pi-rsi-campaign-freeze-manifest.v1" as const, manifestHash: m.canonicalHash, campaignId: m.campaignId, finalCandidate: dev.candidate, selectionRule: "highest development primary metric; deterministic commit tie-break", developmentEvaluationHash: dev.canonicalHash, validUpdateCount: 1, patchAttemptCount: 1, evaluatorCallCount: 2, eventHeadHash: h("1"), sealedEvaluationState: "unopened" as const, frozenAt: "2026-08-17T00:02:00Z" });
    await appendExperimentRecord(root, freeze); await appendExperimentRecord(root, evaluation(m, "sealed"));
    const verified = await verifyExperimentStore(root); assert.equal(verified.valid, true); assert.equal(verified.frozen, true); assert.equal(verified.recordCount, 5);
    await assert.rejects(() => appendExperimentRecord(root, precommit(m)), /campaign is frozen/);
    const exported = await exportCampaign(root); assert.equal(exported.framework, "latest_autonomous"); assert.deepEqual((exported.compute as Record<string, unknown>).inputTokens, 100);
    const stored = JSON.parse(await readFile(join(root, "experiment", "records", "precommit", "update-001-attempt-001.json"), "utf8")) as Record<string, unknown>; assert.equal(stored.canonicalHash, precommit(m).canonicalHash);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("feedback renderer exposes aggregates but excludes structured diagnosis in metric-only condition", () => {
  const body = { schemaVersion: "pi-rsi-private-evaluation.v1", evaluationId: "eval-1", primary: { metricId: "overall_fmax", value: 0.2 }, aggregateMetrics: [{ label: "Overall Fmax", value: 0.2 }], decision: "continue", budgetRemaining: { evaluatorCalls: 10 }, structuredDiagnostic: { earliestFailureStage: "candidate_generation", dominantLoss: "recall" } };
  const privateEvaluation = { ...body, canonicalHash: (withExperimentHash(body)).canonicalHash };
  const metric = renderDeveloperFeedback(privateEvaluation, "metric_only"); const structured = renderDeveloperFeedback(privateEvaluation, "structured_diagnostic");
  assert.equal(metric.structuredDiagnostic, undefined); assert.equal(structured.structuredDiagnostic?.dominantLoss, "recall"); assert.equal(metric.privateEvaluationHash, structured.privateEvaluationHash);
  const leaking = { ...body, structuredDiagnostic: { gold_go_id: "GO:0000001" } }; const sealedLeak = { ...leaking, canonicalHash: (withExperimentHash(leaking)).canonicalHash };
  assert.throws(() => renderDeveloperFeedback(sealedLeak, "structured_diagnostic"), /forbidden key|identifier/);
});

test("candidate guard permits prediction code but protects controller, instrumentation and tests", () => {
  assert.deepEqual(assertCandidatePaths(["src/go.ts", "python/evidence_pipeline.py"]), ["python/evidence_pipeline.py", "src/go.ts"]);
  assert.throws(() => assertCandidatePaths(["src/outer/autonomous/orchestrator.ts"]), /protected/);
  assert.throws(() => assertCandidatePaths(["src/go.test.ts"]), /protected/);
  assert.throws(() => assertCandidatePaths(["package.json"]), /protected|outside/);
});

test("five-cell batch separates Latest mechanism factorial from Early native framework comparison", () => {
  const m = manifest();
  const batch = createFiveCellBatch({ schemaVersion: "pi-rsi-five-cell-design-input.v1", experimentId: "confirmatory-e1", phase: "pilot", replicateCount: 2, blockPrefix: "block", latestInitialCandidate: candidate, earlyInitialCandidate: { ...candidate, sourceCommit: "d".repeat(40) }, bindings: m.bindings, budget: m.budget, stopping: m.stopping, seedRootHash: h("2") });
  assert.equal(batch.cells.length, 5); assert.equal(batch.campaigns.length, 10);
  const early = batch.campaigns.filter((entry) => entry.framework === "early_cumulative"); assert.equal(early.length, 2); assert.ok(early.every((entry) => entry.historyPolicy === "native_linear"));
  assert.equal(batch.cells.filter((entry) => entry.framework === "latest_autonomous").length, 4);
  assert.equal(batch.cells.filter((entry) => entry.estimandRole.includes("latest_factorial")).length, 4);
});
