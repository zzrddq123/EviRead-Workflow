import { hashCanonical } from "../hash.js";
import { readExperimentRecords } from "./store.js";
import type { RsiEvaluationReceipt, RsiIterationPrecommit, RsiResourceUsageReceipt } from "./contracts.js";

function sumKnown(values: Array<number | null>): number | null { return values.every((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0); }

export async function exportCampaign(campaignDir: string): Promise<Record<string, unknown>> {
  const { manifest, index, records } = await readExperimentRecords(campaignDir);
  const precommits = records.filter((record): record is RsiIterationPrecommit => record.schemaVersion === "pi-rsi-iteration-precommit.v1");
  const evaluations = records.filter((record): record is RsiEvaluationReceipt => record.schemaVersion === "pi-rsi-evaluation-receipt.v1");
  const resources = records.filter((record): record is RsiResourceUsageReceipt => record.schemaVersion === "pi-rsi-resource-usage-receipt.v1");
  const freeze = records.find((record) => record.schemaVersion === "pi-rsi-campaign-freeze-manifest.v1") ?? null;
  const development = evaluations.filter((record) => record.split === "development");
  const sealed = evaluations.filter((record) => record.split === "sealed");
  const trajectory = precommits.map((precommit) => {
    const evaluation = development.find((item) => item.updateIndex === precommit.updateIndex) ?? null;
    const observed = new Map<string, number | null>();
    if (evaluation) {
      observed.set(evaluation.primary.metricId, evaluation.primary.value);
      evaluation.metrics.forEach((metric) => observed.set(metric.label, metric.value));
      evaluation.slices.forEach((slice) => observed.set(`${slice.sliceId}:${slice.metricId}`, slice.value));
    }
    const predictedEffects = precommit.intervention.predictedEffects.map((effect) => {
      const key = effect.sliceId === "overall" ? effect.metricId : `${effect.sliceId}:${effect.metricId}`;
      const value = observed.get(key) ?? null;
      return { ...effect, observedValue: value, evaluable: value !== null };
    });
    return {
      updateIndex: precommit.updateIndex,
      patchAttempt: precommit.patchAttempt,
      baseCandidateId: precommit.baseCandidate.candidateId,
      diagnosisProblemCodes: precommit.diagnosis.problemCodes,
      changeFamily: precommit.intervention.changeFamily,
      changeTargets: precommit.intervention.changeTargets,
      predictedEffects,
      evaluationHash: evaluation?.canonicalHash ?? null,
      primaryValue: evaluation?.primary.value ?? null,
      decision: evaluation?.decision ?? null,
      deltaFromParent: evaluation?.deltas.fromParent ?? null,
    };
  });
  const body = {
    schemaVersion: "pi-rsi-campaign-export.v1" as const,
    manifestHash: manifest.canonicalHash,
    experimentId: manifest.experimentId,
    conditionId: manifest.conditionId,
    replicateId: manifest.replicateId,
    blockId: manifest.blockId,
    campaignId: manifest.campaignId,
    phase: manifest.phase,
    framework: manifest.framework,
    feedbackPolicy: manifest.feedbackPolicy,
    historyPolicy: manifest.historyPolicy,
    initialCandidate: manifest.initialCandidate,
    budget: manifest.budget,
    recordCount: index.records.length,
    frozen: index.frozen,
    freeze,
    developmentEvaluations: development.map((entry) => ({ evaluationId: entry.evaluationId, updateIndex: entry.updateIndex, candidateId: entry.candidate.candidateId, value: entry.primary.value, decision: entry.decision, receiptHash: entry.canonicalHash })),
    sealedEvaluations: sealed.map((entry) => ({ evaluationId: entry.evaluationId, candidateId: entry.candidate.candidateId, value: entry.primary.value, receiptHash: entry.canonicalHash })),
    trajectory,
    reliability: {
      stageAttempts: resources.length,
      retryableFailures: resources.filter((entry) => entry.status === "retryable_failure").length,
      fatalFailures: resources.filter((entry) => entry.status === "fatal_failure").length,
      invalidCandidates: resources.filter((entry) => entry.status === "invalid_candidate").length,
    },
    compute: {
      wallClockMs: resources.reduce((sum, entry) => sum + entry.wallClockMs, 0),
      inputTokens: sumKnown(resources.map((entry) => entry.usage.inputTokens)),
      outputTokens: sumKnown(resources.map((entry) => entry.usage.outputTokens)),
      cacheReadTokens: sumKnown(resources.map((entry) => entry.usage.cacheReadTokens)),
      cacheWriteTokens: sumKnown(resources.map((entry) => entry.usage.cacheWriteTokens)),
      modelCalls: sumKnown(resources.map((entry) => entry.usage.modelCalls)),
      toolCalls: sumKnown(resources.map((entry) => entry.usage.toolCalls)),
      evaluatorCalls: resources.reduce((sum, entry) => sum + entry.usage.evaluatorCalls, 0),
      costUsd: sumKnown(resources.map((entry) => entry.usage.costUsd)),
    },
    claimBoundary: "read-only export; archived checkpoint scores cannot change the frozen candidate selection" as const,
  };
  return { ...body, canonicalHash: hashCanonical(body) };
}
