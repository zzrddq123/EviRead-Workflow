import { hashCanonical } from "../../hash.js";
import {
  assertAutonomousCandidate,
  type AutonomousRsiCandidate,
  type AutonomousRsiSpec,
  type AutonomousRsiStageOutput,
} from "./contracts.js";

export type AutonomousRsiBranchAction = "continue" | "backtrack" | "branch";

export interface AutonomousRsiCandidateEvaluation {
  iteration: number;
  metricId: string;
  value: number;
  decision: "continue" | "stop";
  outcome: "initial" | "improved" | "flat" | "regressed";
  deltaFromParent: number | null;
  deltaFromBestBefore: number | null;
  outputHash: string;
}

export interface AutonomousRsiCandidateReflection {
  iteration: number;
  diagnoses: string[];
  prioritizedActions: string[];
  lesson: string;
  primaryProblemSource: string | null;
  secondaryProblemSources: string[];
  rootCauseRationale: string | null;
  researchRequired: boolean;
  researchScope: "function_prediction_process_or_method_improvement" | null;
  researchQuestions: string[];
  outputHash: string;
}

export interface AutonomousRsiCandidatePlan {
  iteration: number;
  planId: string;
  branchAction: AutonomousRsiBranchAction;
  baseCandidateId: string;
  baseRationale: string;
  hypothesis: string;
  changeTargets: string[];
  historyEvidenceIds: string[];
  knowledgeEvidenceIds: string[];
  outputHash: string;
}

export interface AutonomousRsiCandidateVerification {
  iteration: number;
  passed: boolean;
  checks: string[];
  outputHash: string;
}

export interface AutonomousRsiCandidateNode {
  candidate: AutonomousRsiCandidate;
  parentCandidateId: string | null;
  createdIteration: number;
  status: "pending_evaluation" | "evaluated";
  provenance?: {
    kind: "historical_seed";
    originCampaignId: string;
    originalCandidateId: string;
    archiveManifestHash: string;
    evaluatorContractHash: string;
  };
  plan: AutonomousRsiCandidatePlan | null;
  verification: AutonomousRsiCandidateVerification | null;
  evaluation: AutonomousRsiCandidateEvaluation | null;
  reflection: AutonomousRsiCandidateReflection | null;
}

export interface AutonomousRsiKnowledgeCard {
  iteration: number;
  evidenceId: string;
  sourceIds: string[];
  sources: Array<Record<string, unknown>>;
  finding: string;
  limitations: string[];
  supportedActions: string[];
  outputHash: string;
}

export interface AutonomousRsiBaseDecision {
  iteration: number;
  evaluatedCandidateId: string;
  baseCandidateId: string;
  branchAction: AutonomousRsiBranchAction;
  rationale: string;
  planId: string;
  hypothesis: string;
  changeTargets: string[];
  historyEvidenceIds: string[];
  knowledgeEvidenceIds: string[];
  planHash: string;
}

export interface AutonomousRsiCandidateGraph extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-candidate-graph.v1";
  campaignId: string;
  specHash: string;
  rootCandidateId: string;
  nodes: AutonomousRsiCandidateNode[];
  baseDecisions: AutonomousRsiBaseDecision[];
  knowledgeCards: AutonomousRsiKnowledgeCard[];
  latestEvaluatedCandidateId: string | null;
  bestCandidateId: string | null;
  selectedBaseCandidateId: string | null;
  canonicalHash: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;

function graphWithHash(
  value: Omit<AutonomousRsiCandidateGraph, "canonicalHash">,
): AutonomousRsiCandidateGraph {
  return { ...value, canonicalHash: hashCanonical(value) } as AutonomousRsiCandidateGraph;
}

function cloneGraph(graph: AutonomousRsiCandidateGraph): Omit<AutonomousRsiCandidateGraph, "canonicalHash"> {
  const copy = structuredClone(graph) as AutonomousRsiCandidateGraph;
  const { canonicalHash: _canonicalHash, ...content } = copy;
  return content;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function autonomousPlanBaseCandidateId(
  output: AutonomousRsiStageOutput,
  fallback: AutonomousRsiCandidate,
): string {
  const value = output.payload.baseCandidateId;
  if (value === undefined) return fallback.candidateId;
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error("plan baseCandidateId is invalid");
  return value;
}

export function autonomousPlanBranchAction(
  output: AutonomousRsiStageOutput,
  baseCandidateId: string,
  currentCandidateId: string,
): AutonomousRsiBranchAction {
  const value = output.payload.branchAction;
  if (value === undefined) return baseCandidateId === currentCandidateId ? "continue" : "branch";
  if (value !== "continue" && value !== "backtrack" && value !== "branch") {
    throw new Error("plan branchAction is invalid");
  }
  if (value === "continue" && baseCandidateId !== currentCandidateId) {
    throw new Error("continue plan must use the latest evaluated candidate as its base");
  }
  return value;
}

export function initialAutonomousCandidateGraph(spec: AutonomousRsiSpec): AutonomousRsiCandidateGraph {
  const historicalSeeds = spec.historicalSeeds ?? [];
  const candidateIdByCommit = new Map<string, string>();
  if (spec.initialCandidate.sourceCommit) candidateIdByCommit.set(spec.initialCandidate.sourceCommit, spec.initialCandidate.candidateId);
  for (const seed of historicalSeeds) candidateIdByCommit.set(seed.candidate.sourceCommit!, seed.seedId);
  const historicalNodes: AutonomousRsiCandidateNode[] = historicalSeeds.map((seed) => ({
    candidate: { ...seed.candidate, candidateId: seed.seedId },
    parentCandidateId: seed.parentSourceCommit ? candidateIdByCommit.get(seed.parentSourceCommit) ?? null : null,
    createdIteration: 0,
    status: "evaluated",
    provenance: {
      kind: "historical_seed",
      originCampaignId: seed.originCampaignId,
      originalCandidateId: seed.originalCandidateId,
      archiveManifestHash: seed.archiveManifestHash,
      evaluatorContractHash: seed.evaluatorContractHash,
    },
    plan: seed.hypothesis === null ? null : {
      iteration: seed.evaluation.iteration,
      planId: `import-${seed.seedId}`.slice(0, 128),
      branchAction: "branch",
      baseCandidateId: candidateIdByCommit.get(seed.parentSourceCommit ?? "") ?? seed.seedId,
      baseRationale: `Imported from immutable campaign ${seed.originCampaignId}.`,
      hypothesis: seed.hypothesis,
      changeTargets: [],
      historyEvidenceIds: [],
      knowledgeEvidenceIds: [],
      outputHash: seed.archiveManifestHash,
    },
    verification: {
      iteration: seed.evaluation.iteration,
      passed: true,
      checks: ["immutable published campaign archive and exact commit binding verified"],
      outputHash: seed.archiveManifestHash,
    },
    evaluation: {
      iteration: seed.evaluation.iteration,
      metricId: seed.evaluation.metricId,
      value: seed.evaluation.value,
      decision: "continue",
      outcome: "initial",
      deltaFromParent: null,
      deltaFromBestBefore: null,
      outputHash: seed.evaluation.outputHash,
    },
    reflection: seed.lesson === null ? null : {
      iteration: seed.evaluation.iteration,
      diagnoses: [],
      prioritizedActions: [],
      lesson: seed.lesson,
      primaryProblemSource: null,
      secondaryProblemSources: [],
      rootCauseRationale: null,
      researchRequired: false,
      researchScope: null,
      researchQuestions: [],
      outputHash: seed.archiveManifestHash,
    },
  }));
  const historicalBest = historicalNodes.reduce<AutonomousRsiCandidateNode | null>((incumbent, node) => {
    if (!incumbent) return node;
    const current = node.evaluation!.value;
    const previous = incumbent.evaluation!.value;
    return spec.objective.direction === "maximize"
      ? current > previous ? node : incumbent
      : current < previous ? node : incumbent;
  }, null);
  return graphWithHash({
    schemaVersion: "pi-autonomous-rsi-candidate-graph.v1",
    campaignId: spec.campaignId,
    specHash: spec.canonicalHash,
    rootCandidateId: spec.initialCandidate.candidateId,
    nodes: [{
      candidate: spec.initialCandidate,
      parentCandidateId: null,
      createdIteration: 0,
      status: "pending_evaluation",
      plan: null,
      verification: null,
      evaluation: null,
      reflection: null,
    }, ...historicalNodes],
    baseDecisions: [],
    knowledgeCards: [],
    latestEvaluatedCandidateId: null,
    bestCandidateId: historicalBest?.candidate.candidateId ?? null,
    selectedBaseCandidateId: null,
  });
}

function better(
  direction: AutonomousRsiSpec["objective"]["direction"],
  current: number,
  incumbent: number,
  minimumImprovement: number,
): boolean {
  return direction === "maximize"
    ? current - incumbent >= minimumImprovement
    : incumbent - current >= minimumImprovement;
}

function nodeById(graph: AutonomousRsiCandidateGraph, candidateId: string): AutonomousRsiCandidateNode {
  const node = graph.nodes.find((item) => item.candidate.candidateId === candidateId);
  if (!node) throw new Error(`candidate graph does not contain ${candidateId}`);
  return node;
}

export function applyAutonomousCandidateGraphStage(input: {
  graph: AutonomousRsiCandidateGraph;
  output: AutonomousRsiStageOutput;
  currentCandidate: AutonomousRsiCandidate;
  spec: AutonomousRsiSpec;
}): AutonomousRsiCandidateGraph {
  assertAutonomousCandidate(input.currentCandidate, "candidate graph current candidate");
  const content = cloneGraph(assertAutonomousCandidateGraph(input.graph, input.spec));
  const graph = graphWithHash(content);
  if (input.output.status !== "completed") return graph;
  const node = nodeById(graph, input.currentCandidate.candidateId);
  if (input.output.stage === "evaluate") {
    const metric = input.output.payload.metric as Record<string, unknown>;
    const value = Number(metric.value);
    if (!Number.isFinite(value)) throw new Error("candidate graph evaluation metric is invalid");
    const direction = input.spec.objective.direction === "maximize" ? 1 : -1;
    const parentEvaluation = node.parentCandidateId === null
      ? null
      : nodeById(graph, node.parentCandidateId).evaluation;
    const incumbent = graph.bestCandidateId === null ? null : nodeById(graph, graph.bestCandidateId);
    const deltaFromParent = parentEvaluation === null ? null : direction * (value - parentEvaluation.value);
    const deltaFromBestBefore = incumbent?.evaluation
      ? direction * (value - incumbent.evaluation.value)
      : null;
    const minimum = input.spec.objective.minimumImprovement;
    const outcome = parentEvaluation === null
      ? "initial" as const
      : deltaFromParent! >= minimum
        ? "improved" as const
        : deltaFromParent! <= -minimum
          ? "regressed" as const
          : "flat" as const;
    node.status = "evaluated";
    node.evaluation = {
      iteration: input.output.iteration,
      metricId: String(metric.metricId),
      value,
      decision: input.output.payload.decision as "continue" | "stop",
      outcome,
      deltaFromParent,
      deltaFromBestBefore,
      outputHash: input.output.canonicalHash,
    };
    graph.latestEvaluatedCandidateId = node.candidate.candidateId;
    if (!incumbent?.evaluation || better(
      input.spec.objective.direction,
      value,
      incumbent.evaluation.value,
      input.spec.objective.minimumImprovement,
    )) {
      graph.bestCandidateId = node.candidate.candidateId;
    }
  } else if (input.output.stage === "diagnose") {
    node.reflection = {
      iteration: input.output.iteration,
      diagnoses: stringArray(input.output.payload.diagnoses),
      prioritizedActions: stringArray(input.output.payload.prioritizedActions),
      lesson: typeof input.output.payload.lesson === "string"
        ? input.output.payload.lesson
        : input.output.summary,
      primaryProblemSource: typeof input.output.payload.primaryProblemSource === "string"
        ? input.output.payload.primaryProblemSource
        : null,
      secondaryProblemSources: stringArray(input.output.payload.secondaryProblemSources),
      rootCauseRationale: typeof input.output.payload.rootCauseRationale === "string"
        ? input.output.payload.rootCauseRationale
        : null,
      researchRequired: booleanValue(input.output.payload.researchRequired, true),
      researchScope: input.output.payload.researchScope === "function_prediction_process_or_method_improvement"
        ? input.output.payload.researchScope
        : null,
      researchQuestions: stringArray(input.output.payload.researchQuestions),
      outputHash: input.output.canonicalHash,
    };
  } else if (input.output.stage === "research") {
    const cards = Array.isArray(input.output.payload.cards) ? input.output.payload.cards : [];
    const sources = Array.isArray(input.output.payload.sources)
      ? input.output.payload.sources.filter((source): source is Record<string, unknown> => Boolean(source) && typeof source === "object" && !Array.isArray(source))
      : [];
    const sourceById = new Map(sources.map((source) => [String(source.sourceId), source]));
    for (const raw of cards) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const card = raw as Record<string, unknown>;
      const sourceIds = stringArray(card.sourceIds);
      graph.knowledgeCards.push({
        iteration: input.output.iteration,
        evidenceId: String(card.evidenceId),
        sourceIds,
        sources: sourceIds.flatMap((sourceId) => sourceById.has(sourceId) ? [structuredClone(sourceById.get(sourceId)!)] : []),
        finding: String(card.finding),
        limitations: stringArray(card.limitations),
        supportedActions: stringArray(card.supportedActions),
        outputHash: input.output.canonicalHash,
      });
    }
  } else if (input.output.stage === "plan") {
    const baseCandidateId = autonomousPlanBaseCandidateId(input.output, input.currentCandidate);
    const base = nodeById(graph, baseCandidateId);
    if (base.status !== "evaluated" || !base.evaluation) {
      throw new Error("plan base candidate must already have a completed evaluation");
    }
    const branchAction = autonomousPlanBranchAction(
      input.output,
      baseCandidateId,
      input.currentCandidate.candidateId,
    );
    if (branchAction !== "continue" && baseCandidateId === input.currentCandidate.candidateId) {
      throw new Error(`${branchAction} plan must select a historical candidate other than the latest evaluated candidate`);
    }
    if (branchAction === "backtrack") {
      let cursor: string | null = node.parentCandidateId;
      let found = false;
      while (cursor !== null) {
        if (cursor === baseCandidateId) {
          found = true;
          break;
        }
        cursor = nodeById(graph, cursor).parentCandidateId;
      }
      if (!found) throw new Error("backtrack plan base must be an ancestor of the latest evaluated candidate");
    }
    const planId = String(input.output.payload.planId);
    const historyEvidenceIds = stringArray(input.output.payload.historyEvidenceIds);
    const knowledgeEvidenceIds = stringArray(input.output.payload.knowledgeEvidenceIds);
    if (input.output.payload.historyEvidenceIds !== undefined
      && historyEvidenceIds.some((id) => !graph.nodes.some((item) => item.candidate.candidateId === id))) {
      throw new Error("plan cites a candidate-history record that is absent from the graph");
    }
    if (input.output.payload.knowledgeEvidenceIds !== undefined
      && knowledgeEvidenceIds.some((id) => !graph.knowledgeCards.some((card) => card.evidenceId === id))) {
      throw new Error("plan cites a research card that is absent from persistent knowledge");
    }
    const rationale = typeof input.output.payload.baseRationale === "string"
      ? input.output.payload.baseRationale
      : `Use ${baseCandidateId} as the bound development base.`;
    graph.selectedBaseCandidateId = baseCandidateId;
    graph.baseDecisions = graph.baseDecisions.filter((item) => item.iteration !== input.output.iteration);
    graph.baseDecisions.push({
      iteration: input.output.iteration,
      evaluatedCandidateId: input.currentCandidate.candidateId,
      baseCandidateId,
      branchAction,
      rationale,
      planId,
      hypothesis: String(input.output.payload.hypothesis),
      changeTargets: stringArray(input.output.payload.changeTargets),
      historyEvidenceIds,
      knowledgeEvidenceIds,
      planHash: input.output.canonicalHash,
    });
  } else if (input.output.stage === "verify" && input.output.payload.passed === true) {
    const candidate = assertAutonomousCandidate(input.output.payload.candidate, "verified graph candidate");
    let decision = graph.baseDecisions.find((item) => item.iteration === input.output.iteration);
    // Automatic verification repairs reuse the original Plan while receiving a
    // fresh iteration/candidate binding. Materialize that binding explicitly so
    // replay remains append-only and the repaired candidate can be evaluated.
    if (!decision && graph.baseDecisions.length > 0) {
      const prior = graph.baseDecisions.at(-1)!;
      decision = { ...prior, iteration: input.output.iteration, evaluatedCandidateId: input.currentCandidate.candidateId };
      graph.baseDecisions.push(decision);
    }
    if (!decision) throw new Error("verified candidate has no bound base decision");
    if (graph.nodes.some((item) => item.candidate.candidateId === candidate.candidateId)) {
      throw new Error("candidate graph already contains the verified candidate");
    }
    const planOutputHash = decision.planHash;
    graph.nodes.push({
      candidate,
      parentCandidateId: decision.baseCandidateId,
      createdIteration: input.output.iteration,
      status: "pending_evaluation",
      plan: {
        iteration: input.output.iteration,
        planId: decision.planId,
        branchAction: decision.branchAction,
        baseCandidateId: decision.baseCandidateId,
        baseRationale: decision.rationale,
        hypothesis: decision.hypothesis,
        changeTargets: decision.changeTargets,
        historyEvidenceIds: decision.historyEvidenceIds,
        knowledgeEvidenceIds: decision.knowledgeEvidenceIds,
        outputHash: planOutputHash,
      },
      verification: {
        iteration: input.output.iteration,
        passed: true,
        checks: stringArray(input.output.payload.checks),
        outputHash: input.output.canonicalHash,
      },
      evaluation: null,
      reflection: null,
    });
  }
  const { canonicalHash: _canonicalHash, ...next } = graph;
  return assertAutonomousCandidateGraph(graphWithHash(next), input.spec);
}

export function assertAutonomousCandidateGraph(
  value: AutonomousRsiCandidateGraph,
  spec: AutonomousRsiSpec,
): AutonomousRsiCandidateGraph {
  const { canonicalHash, ...content } = value;
  if (value.schemaVersion !== "pi-autonomous-rsi-candidate-graph.v1"
    || value.campaignId !== spec.campaignId
    || value.specHash !== spec.canonicalHash
    || !HASH.test(canonicalHash)
    || canonicalHash !== hashCanonical(content)) {
    throw new Error("autonomous candidate graph binding/hash is invalid");
  }
  if (!Array.isArray(value.nodes) || value.nodes.length < 1) throw new Error("candidate graph has no nodes");
  const ids = new Set<string>();
  for (const node of value.nodes) {
    const candidate = assertAutonomousCandidate(node.candidate, "candidate graph node");
    if (ids.has(candidate.candidateId)) throw new Error("candidate graph contains duplicate candidate IDs");
    ids.add(candidate.candidateId);
    if (!Number.isInteger(node.createdIteration) || node.createdIteration < 0) throw new Error("candidate graph node iteration is invalid");
    if (node.status !== "pending_evaluation" && node.status !== "evaluated") throw new Error("candidate graph node status is invalid");
    if ((node.status === "evaluated") !== (node.evaluation !== null)) throw new Error("candidate graph evaluation/status mismatch");
  }
  if (!ids.has(value.rootCandidateId)) throw new Error("candidate graph root is absent");
  for (const node of value.nodes) {
    if (node.candidate.candidateId === value.rootCandidateId) {
      if (node.parentCandidateId !== null) throw new Error("candidate graph root cannot have a parent");
    } else if (node.provenance?.kind === "historical_seed") {
      if (node.parentCandidateId === value.rootCandidateId || (node.parentCandidateId !== null && !ids.has(node.parentCandidateId))) {
        throw new Error("historical candidate graph seed has an invalid parent");
      }
    } else if (node.parentCandidateId === null || !ids.has(node.parentCandidateId)) {
      throw new Error("candidate graph child has an invalid parent");
    } else {
      const parent = value.nodes.find((item) => item.candidate.candidateId === node.parentCandidateId)!;
      if (parent.createdIteration >= node.createdIteration) {
        throw new Error("candidate graph parent must predate its child");
      }
    }
  }
  for (const pointer of [value.latestEvaluatedCandidateId, value.bestCandidateId, value.selectedBaseCandidateId]) {
    if (pointer !== null && !ids.has(pointer)) throw new Error("candidate graph pointer is absent from nodes");
  }
  return value;
}

export function autonomousCandidateFromGraph(
  graph: AutonomousRsiCandidateGraph,
  candidateId: string,
): AutonomousRsiCandidate {
  return structuredClone(nodeById(graph, candidateId).candidate);
}
