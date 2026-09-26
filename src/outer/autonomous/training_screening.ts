import { hashCanonical } from "../../hash.js";

export interface TrainingScreenResult {
  schemaVersion: "pi-autonomous-rsi-training-screen-result.v1";
  candidate: { candidateId: string; artifactHash: string; sourceCommit: string };
  metric: { metricId: string; value: number };
  threshold: number;
  passed: boolean;
  screeningAttempt: number;
  maxScreeningAttempts: number;
  canonicalHash: string;
}

export function makeTrainingScreenResult(input: Omit<TrainingScreenResult, "schemaVersion" | "passed" | "canonicalHash">): TrainingScreenResult {
  const body = { schemaVersion: "pi-autonomous-rsi-training-screen-result.v1" as const, ...input, passed: input.metric.value >= input.threshold };
  return { ...body, canonicalHash: hashCanonical(body) };
}

export function assertTrainingScreenResult(value: unknown, expectedCandidate?: TrainingScreenResult["candidate"]): TrainingScreenResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("training screening result must be an object");
  const result = value as Record<string, unknown>;
  if (result.schemaVersion !== "pi-autonomous-rsi-training-screen-result.v1") throw new Error("unsupported training screening result schemaVersion");
  const candidate = result.candidate as Record<string, unknown>;
  const metric = result.metric as Record<string, unknown>;
  if (!candidate || typeof candidate !== "object" || !metric || typeof metric !== "object") throw new Error("training screening result binding is invalid");
  if (typeof candidate.candidateId !== "string" || typeof candidate.artifactHash !== "string" || typeof candidate.sourceCommit !== "string") throw new Error("training screening candidate binding is invalid");
  if (expectedCandidate && (candidate.candidateId !== expectedCandidate.candidateId || candidate.artifactHash !== expectedCandidate.artifactHash || candidate.sourceCommit !== expectedCandidate.sourceCommit)) throw new Error("training screening candidate binding mismatch");
  if (typeof metric.metricId !== "string" || typeof metric.value !== "number" || !Number.isFinite(metric.value) || typeof result.threshold !== "number" || !Number.isFinite(result.threshold)) throw new Error("training screening metric is invalid");
  if (typeof result.passed !== "boolean" || result.passed !== (metric.value >= result.threshold)) throw new Error("training screening pass decision is invalid");
  const body = { ...result }; delete body.canonicalHash;
  if (typeof result.canonicalHash !== "string" || result.canonicalHash !== hashCanonical(body)) throw new Error("training screening canonicalHash mismatch");
  return result as unknown as TrainingScreenResult;
}
