import { hashCanonical } from "../../hash.js";
import type {
  AutonomousRsiCandidate,
  AutonomousRsiSpec,
  AutonomousRsiStage,
  AutonomousRsiStageOutput,
} from "./contracts.js";
import type { AutonomousRsiCandidateGraph } from "./candidate_graph.js";

export interface AutonomousRsiHistoryRecord {
  iteration: number;
  stage: AutonomousRsiStage;
  status: AutonomousRsiStageOutput["status"];
  summary: string;
  payload: Record<string, unknown>;
  outputHash: string;
}

export interface AutonomousRsiHistoryContext extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-history-context.v1";
  campaignId: string;
  specHash: string;
  forIteration: number;
  forStage: AutonomousRsiStage;
  currentCandidate: AutonomousRsiCandidate;
  selectedBaseCandidate: AutonomousRsiCandidate | null;
  candidateGraphHash: string;
  rootCandidateId: string;
  latestEvaluatedCandidateId: string | null;
  bestCandidateId: string | null;
  selectedBaseCandidateId: string | null;
  candidateTree: Array<{
    candidateId: string;
    parentCandidateId: string | null;
    sourceCommit: string | null;
    status: "pending_evaluation" | "evaluated";
    metric: { metricId: string; value: number } | null;
    outcome: "initial" | "improved" | "flat" | "regressed" | null;
    deltaFromParent: number | null;
    hypothesis: string | null;
    lesson: string | null;
    branchAction: string | null;
  }>;
  explorationRecords: AutonomousRsiHistoryRecord[];
  knowledgeCards: AutonomousRsiCandidateGraph["knowledgeCards"];
  unresolvedProblems: string[];
  opportunities: string[];
  comparisonReference?: AutonomousRsiSpec["comparisonReference"];
  readableSummary: string;
  canonicalHash: string;
}

const HASH = /^[a-f0-9]{64}$/;

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function readableTree(graph: AutonomousRsiCandidateGraph): string[] {
  return graph.nodes.map((node) => {
    const parent = node.parentCandidateId ?? "ROOT";
    const metric = node.evaluation
      ? `${node.evaluation.metricId}=${node.evaluation.value}; outcome=${node.evaluation.outcome}; delta-from-parent=${node.evaluation.deltaFromParent ?? "n/a"}`
      : "not-yet-evaluated";
    const lesson = node.reflection?.lesson ? `; lesson=${node.reflection.lesson}` : "";
    return `${node.candidate.candidateId} <- ${parent}; ${metric}; status=${node.status}${lesson}`;
  });
}

export function createAutonomousHistoryContext(input: {
  spec: AutonomousRsiSpec;
  graph: AutonomousRsiCandidateGraph;
  iteration: number;
  stage: AutonomousRsiStage;
  currentCandidate: AutonomousRsiCandidate;
  selectedBaseCandidate: AutonomousRsiCandidate | null;
  records: AutonomousRsiHistoryRecord[];
}): AutonomousRsiHistoryContext {
  const unresolvedProblems = unique(input.graph.nodes.flatMap((node) =>
    node.reflection?.diagnoses ?? []));
  const tree = input.graph.nodes.map((node) => ({
    candidateId: node.candidate.candidateId,
    parentCandidateId: node.parentCandidateId,
    sourceCommit: node.candidate.sourceCommit,
    status: node.status,
    metric: node.evaluation
      ? { metricId: node.evaluation.metricId, value: node.evaluation.value }
      : null,
    outcome: node.evaluation?.outcome ?? null,
    deltaFromParent: node.evaluation?.deltaFromParent ?? null,
    hypothesis: node.plan?.hypothesis ?? null,
    lesson: node.reflection?.lesson ?? null,
    branchAction: node.plan?.branchAction ?? null,
  }));
  const opportunities = unique([
    ...input.graph.nodes.filter((node) => node.evaluation?.outcome === "improved").map((node) => node.plan?.hypothesis ? `Promising direction: ${node.plan.hypothesis}` : "An evaluated change improved the objective; inspect its mechanism for reuse."),
    ...input.graph.knowledgeCards.map((card) => card.finding ? `Research-supported opportunity: ${card.finding}` : "A research-backed opportunity is available in the knowledge cards."),
  ]);
  const reference = input.spec.comparisonReference;
  if (reference) {
    opportunities.push(`Comparison target: exceed ${reference.targetMethod} on ${reference.metricId} (${reference.targetValue}).`);
    const strongest = reference.context.filter((row) => !row.diagnosticOnly).sort((a, b) => b.metric - a.metric)[0];
    if (strongest) opportunities.push(`Use the strongest non-diagnostic baseline as a directional challenge, then diagnose whether the gap is evidence construction, decision policy, or workflow.`);
  }
  const readableSummary = [
    `Campaign ${input.spec.campaignId}; preparing iteration ${input.iteration} stage ${input.stage}.`,
    `Latest evaluated candidate: ${input.graph.latestEvaluatedCandidateId ?? "none"}.`,
    `Best evaluated candidate: ${input.graph.bestCandidateId ?? "none"}.`,
    `Selected development base: ${input.graph.selectedBaseCandidateId ?? "not selected yet"}.`,
    "Candidate tree:",
    ...readableTree(input.graph),
    `Persistent research cards: ${input.graph.knowledgeCards.map((card) => card.evidenceId).join(", ") || "none"}.`,
    `Unresolved problems: ${unresolvedProblems.join(" | ") || "none recorded"}.`,
    `Positive opportunities: ${opportunities.join(" | ") || "none recorded"}.`,
  ].join("\n");
  const content = {
    schemaVersion: "pi-autonomous-rsi-history-context.v1" as const,
    campaignId: input.spec.campaignId,
    specHash: input.spec.canonicalHash,
    forIteration: input.iteration,
    forStage: input.stage,
    currentCandidate: structuredClone(input.currentCandidate),
    selectedBaseCandidate: input.selectedBaseCandidate ? structuredClone(input.selectedBaseCandidate) : null,
    candidateGraphHash: input.graph.canonicalHash,
    rootCandidateId: input.graph.rootCandidateId,
    latestEvaluatedCandidateId: input.graph.latestEvaluatedCandidateId,
    bestCandidateId: input.graph.bestCandidateId,
    selectedBaseCandidateId: input.graph.selectedBaseCandidateId,
    candidateTree: tree,
    explorationRecords: structuredClone(input.records),
    knowledgeCards: structuredClone(input.graph.knowledgeCards),
    unresolvedProblems,
    opportunities,
    ...(reference ? { comparisonReference: structuredClone(reference) } : {}),
    readableSummary,
  };
  return assertAutonomousHistoryContext({ ...content, canonicalHash: hashCanonical(content) }, input.spec);
}

export function resetAutonomousHistoryContext(value: AutonomousRsiHistoryContext, spec: AutonomousRsiSpec): AutonomousRsiHistoryContext {
  const current = value.candidateTree.find((entry) => entry.candidateId === value.currentCandidate.candidateId);
  if (!current) throw new Error("reset history cannot locate the current candidate");
  const content = {
    schemaVersion: value.schemaVersion,
    campaignId: value.campaignId,
    specHash: value.specHash,
    forIteration: value.forIteration,
    forStage: value.forStage,
    currentCandidate: structuredClone(value.currentCandidate),
    selectedBaseCandidate: value.selectedBaseCandidate ? structuredClone(value.selectedBaseCandidate) : null,
    candidateGraphHash: value.candidateGraphHash,
    rootCandidateId: value.rootCandidateId,
    latestEvaluatedCandidateId: value.latestEvaluatedCandidateId,
    bestCandidateId: null,
    selectedBaseCandidateId: value.selectedBaseCandidateId,
    candidateTree: [structuredClone(current)],
    explorationRecords: [],
    knowledgeCards: [],
    unresolvedProblems: [],
    opportunities: [],
    ...(value.comparisonReference ? { comparisonReference: structuredClone(value.comparisonReference) } : {}),
    readableSummary: `Reset-history condition for iteration ${value.forIteration} stage ${value.forStage}; no prior candidate, episode, failure, or knowledge records are exposed.`,
  };
  return assertAutonomousHistoryContext({ ...content, canonicalHash: hashCanonical(content) }, spec);
}

export function shuffledAutonomousHistoryContext(value: AutonomousRsiHistoryContext, artifact: unknown, spec: AutonomousRsiSpec): AutonomousRsiHistoryContext {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error("shuffled history artifact must be an object");
  const item = artifact as Record<string, unknown>;
  const { canonicalHash, ...artifactBody } = item;
  if (item.schemaVersion !== "pi-rsi-shuffled-history.v1" || typeof canonicalHash !== "string" || canonicalHash !== hashCanonical(artifactBody) || !Array.isArray(item.candidateTree) || !Array.isArray(item.explorationRecords) || !Array.isArray(item.knowledgeCards) || !Array.isArray(item.unresolvedProblems)) throw new Error("shuffled history artifact identity/hash mismatch");
  const content = {
    schemaVersion: value.schemaVersion,
    campaignId: value.campaignId,
    specHash: value.specHash,
    forIteration: value.forIteration,
    forStage: value.forStage,
    currentCandidate: structuredClone(value.currentCandidate),
    selectedBaseCandidate: value.selectedBaseCandidate ? structuredClone(value.selectedBaseCandidate) : null,
    candidateGraphHash: value.candidateGraphHash,
    rootCandidateId: value.rootCandidateId,
    latestEvaluatedCandidateId: value.latestEvaluatedCandidateId,
    bestCandidateId: value.bestCandidateId,
    selectedBaseCandidateId: value.selectedBaseCandidateId,
    candidateTree: structuredClone(item.candidateTree) as AutonomousRsiHistoryContext["candidateTree"],
    explorationRecords: structuredClone(item.explorationRecords) as AutonomousRsiHistoryRecord[],
    knowledgeCards: structuredClone(item.knowledgeCards) as AutonomousRsiCandidateGraph["knowledgeCards"],
    unresolvedProblems: structuredClone(item.unresolvedProblems) as string[],
    opportunities: Array.isArray(item.opportunities) ? structuredClone(item.opportunities) as string[] : [],
    ...(item.comparisonReference ? { comparisonReference: structuredClone(item.comparisonReference) as AutonomousRsiSpec["comparisonReference"] } : {}),
    readableSummary: `Shuffled-history matched control; artifact ${canonicalHash}; semantic order/source is intentionally unrelated to this campaign.`,
  };
  return assertAutonomousHistoryContext({ ...content, canonicalHash: hashCanonical(content) }, spec);
}

export function assertAutonomousHistoryContext(
  value: AutonomousRsiHistoryContext,
  spec: AutonomousRsiSpec,
): AutonomousRsiHistoryContext {
  const { canonicalHash, ...content } = value;
  if (value.schemaVersion !== "pi-autonomous-rsi-history-context.v1"
    || value.campaignId !== spec.campaignId
    || value.specHash !== spec.canonicalHash
    || !Number.isInteger(value.forIteration)
    || value.forIteration < 1
    || !HASH.test(canonicalHash)
    || canonicalHash !== hashCanonical(content)
    || value.candidateGraphHash.length !== 64
    || !Array.isArray(value.candidateTree)
    || !Array.isArray(value.explorationRecords)
    || !Array.isArray(value.knowledgeCards)
    || !Array.isArray(value.opportunities)
    || typeof value.readableSummary !== "string") {
    throw new Error("autonomous history context binding/hash is invalid");
  }
  return value;
}
