import type { PrivateBenchmarkTarget, ScoredAspect } from "./benchmark_io.js";
import { BENCHMARK_GO_ASPECTS } from "./benchmark_metrics.js";
import { canonicalJson, hashCanonical } from "./hash.js";
import type { GODonorSupport, GOPredictionSet, GOTermPrediction } from "./types.js";

export const RSI_FAILURE_STAGES = [
  "identity_quarantined",
  "label_coverage",
  "evidence_gate",
  "score_gate",
  "judge_gate",
  "selector_gate",
  "unattributed",
] as const;

export type RsiFailureStage = typeof RSI_FAILURE_STAGES[number];

export const RSI_TRACE_CHECKPOINTS = [
  "identity_policy",
  "label_coverage",
  "evidence_gate",
  "score_gate",
  "judge_gate",
  "selector_gate",
] as const;

export type RsiTraceCheckpoint = typeof RSI_TRACE_CHECKPOINTS[number];
export type RsiCheckpointStatus = "passed" | "failed" | "not_reached" | "not_applicable";

export type RsiCheckpointTrace = Record<RsiTraceCheckpoint, RsiCheckpointStatus>;

export interface MissingGoldAttribution {
  goId: string;
  /** The first failure that is observable in a machine-readable prediction trace. */
  earliestFailureStage: RsiFailureStage;
  /** Structured checkpoints only; free-form reasons and hidden model reasoning are never parsed. */
  checkpoints: RsiCheckpointTrace;
}

export interface SelectedSupportModeCounts {
  sequenceSupportedTermCount: number;
  structureOnlyTermCount: number;
}

export interface LineageSupportCounts {
  /** Donor-support rows on every scored candidate term. */
  candidateAppliedCount: number;
  candidateUnavailableCount: number;
  /** Donor-support rows on the operationally selected subset. */
  selectedAppliedCount: number;
  selectedUnavailableCount: number;
}

export interface RsiCaseAspectAttribution {
  aspect: ScoredAspect;
  /** Whether this protein/ontology pair belongs to the benchmark target stratum. */
  scored: boolean;
  goldCount: number;
  selectedCount: number;
  truePositiveCount: number;
  falsePositiveCount: number;
  falseNegativeCount: number;
  candidateTruePositiveCount: number;
  candidateRecallCeiling: number;
  selectedSupportModes: SelectedSupportModeCounts;
  lineageSupports: LineageSupportCounts;
  missingGold: MissingGoldAttribution[];
  selectedFalsePositiveGoIds: string[];
}

export interface RsiCaseAttribution {
  caseId: string;
  split: PrivateBenchmarkTarget["split"];
  predictionAvailable: boolean;
  aspects: Record<ScoredAspect, RsiCaseAspectAttribution>;
}

export interface SelectedFalsePositiveAttribution {
  caseId: string;
  goId: string;
}

export interface RsiAspectAttributionSummary {
  aspect: ScoredAspect;
  scoredCaseCount: number;
  goldCount: number;
  selectedCount: number;
  truePositiveCount: number;
  falsePositiveCount: number;
  falseNegativeCount: number;
  candidateTruePositiveCount: number;
  candidateRecallCeiling: number;
  selectedSupportModes: SelectedSupportModeCounts;
  lineageSupports: LineageSupportCounts;
  failureStageCounts: Record<RsiFailureStage, number>;
  failureStageDistinctCaseCounts: Record<RsiFailureStage, number>;
  selectedFalsePositives: SelectedFalsePositiveAttribution[];
}

export interface RsiErrorAttribution {
  schemaVersion: "pi-rsi-error-attribution.v2";
  candidateDefinition: "positive_finite_judge_phylogeny_or_raw_score";
  tracePolicy: "earliest_observable_machine_checkpoint_v1";
  caseCount: number;
  predictionAvailableCaseCount: number;
  missingPredictionCaseIds: string[];
  aspects: Record<ScoredAspect, RsiAspectAttributionSummary>;
  cases: RsiCaseAttribution[];
  canonicalHash: string;
}

type AttributionWithoutHash = Omit<RsiErrorAttribution, "canonicalHash">;

const ATTRIBUTION_KEYS = [
  "schemaVersion", "candidateDefinition", "tracePolicy", "caseCount",
  "predictionAvailableCaseCount", "missingPredictionCaseIds", "aspects",
  "cases", "canonicalHash",
] as const;
const CASE_KEYS = ["caseId", "split", "predictionAvailable", "aspects"] as const;
const CASE_ASPECT_KEYS = [
  "aspect", "scored", "goldCount", "selectedCount", "truePositiveCount",
  "falsePositiveCount", "falseNegativeCount", "candidateTruePositiveCount",
  "candidateRecallCeiling", "selectedSupportModes", "lineageSupports",
  "missingGold", "selectedFalsePositiveGoIds",
] as const;
const SUMMARY_KEYS = [
  "aspect", "scoredCaseCount", "goldCount", "selectedCount", "truePositiveCount",
  "falsePositiveCount", "falseNegativeCount", "candidateTruePositiveCount",
  "candidateRecallCeiling", "selectedSupportModes", "lineageSupports",
  "failureStageCounts", "failureStageDistinctCaseCounts", "selectedFalsePositives",
] as const;
const SUPPORT_MODE_KEYS = ["sequenceSupportedTermCount", "structureOnlyTermCount"] as const;
const LINEAGE_KEYS = [
  "candidateAppliedCount", "candidateUnavailableCount", "selectedAppliedCount",
  "selectedUnavailableCount",
] as const;
const MISSING_GOLD_KEYS = ["goId", "earliestFailureStage", "checkpoints"] as const;
const GO_ID = /^GO:\d{7}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} has an invalid field set`);
}

function nonnegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
}

function unitNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite unit number`);
  }
}

function assertStringArray(value: unknown, label: string, pattern?: RegExp): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || (pattern && !pattern.test(item)))) {
    throw new Error(`${label} must be a valid string array`);
  }
  if (new Set(value).size !== value.length || canonicalJson(value) !== canonicalJson([...value].sort())) {
    throw new Error(`${label} must be sorted and unique`);
  }
}

function assertCountRecord(value: unknown, keys: readonly string[], label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, keys, label);
  for (const key of keys) nonnegativeInteger(value[key], `${label}.${key}`);
}

function assertCheckpointTrace(value: unknown, failure: RsiFailureStage, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, RSI_TRACE_CHECKPOINTS, label);
  const allowed = new Set<RsiCheckpointStatus>(["passed", "failed", "not_reached", "not_applicable"]);
  for (const checkpoint of RSI_TRACE_CHECKPOINTS) {
    if (!allowed.has(value[checkpoint] as RsiCheckpointStatus)) throw new Error(`${label}.${checkpoint} has an invalid status`);
  }
  const signature = RSI_TRACE_CHECKPOINTS.map((checkpoint) => value[checkpoint]).join("/");
  const deterministic = (states: readonly RsiCheckpointStatus[]) => states.join("/");
  const valid: Record<RsiFailureStage, string[]> = {
    identity_quarantined: [deterministic(["failed", "not_reached", "not_reached", "not_reached", "not_reached", "not_reached"])],
    label_coverage: [deterministic(["passed", "failed", "not_reached", "not_reached", "not_reached", "not_reached"])],
    evidence_gate: [deterministic(["passed", "passed", "failed", "not_reached", "not_reached", "not_reached"])],
    score_gate: [deterministic(["passed", "passed", "passed", "failed", "not_reached", "not_reached"])],
    judge_gate: [deterministic(["passed", "passed", "passed", "passed", "failed", "not_reached"])],
    selector_gate: [
      deterministic(["passed", "passed", "passed", "passed", "passed", "failed"]),
      deterministic(["passed", "passed", "passed", "passed", "not_applicable", "failed"]),
      deterministic(["passed", "passed", "passed", "not_applicable", "not_applicable", "failed"]),
    ],
    unattributed: [
      deterministic(["passed", "passed", "passed", "passed", "passed", "not_applicable"]),
      deterministic(["passed", "passed", "passed", "passed", "not_applicable", "not_applicable"]),
      deterministic(["passed", "passed", "passed", "not_applicable", "not_applicable", "not_applicable"]),
    ],
  };
  if (!valid[failure].includes(signature)) throw new Error(`${label} does not match earliest failure stage ${failure}`);
}

function assertCaseAspectAttribution(value: unknown, aspect: ScoredAspect, label: string): RsiCaseAspectAttribution {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, CASE_ASPECT_KEYS, label);
  if (value.aspect !== aspect || typeof value.scored !== "boolean") throw new Error(`${label} has an invalid aspect binding`);
  for (const key of [
    "goldCount", "selectedCount", "truePositiveCount", "falsePositiveCount",
    "falseNegativeCount", "candidateTruePositiveCount",
  ] as const) nonnegativeInteger(value[key], `${label}.${key}`);
  unitNumber(value.candidateRecallCeiling, `${label}.candidateRecallCeiling`);
  assertCountRecord(value.selectedSupportModes, SUPPORT_MODE_KEYS, `${label}.selectedSupportModes`);
  assertCountRecord(value.lineageSupports, LINEAGE_KEYS, `${label}.lineageSupports`);
  assertStringArray(value.selectedFalsePositiveGoIds, `${label}.selectedFalsePositiveGoIds`, GO_ID);
  if (!Array.isArray(value.missingGold)) throw new Error(`${label}.missingGold must be an array`);
  const missingGoIds: string[] = [];
  for (const [index, raw] of value.missingGold.entries()) {
    if (!isRecord(raw)) throw new Error(`${label}.missingGold[${index}] must be an object`);
    exactKeys(raw, MISSING_GOLD_KEYS, `${label}.missingGold[${index}]`);
    if (typeof raw.goId !== "string" || !GO_ID.test(raw.goId)
      || !(RSI_FAILURE_STAGES as readonly unknown[]).includes(raw.earliestFailureStage)) {
      throw new Error(`${label}.missingGold[${index}] is invalid`);
    }
    assertCheckpointTrace(
      raw.checkpoints,
      raw.earliestFailureStage as RsiFailureStage,
      `${label}.missingGold[${index}].checkpoints`,
    );
    missingGoIds.push(raw.goId);
  }
  if (new Set(missingGoIds).size !== missingGoIds.length
    || canonicalJson(missingGoIds) !== canonicalJson([...missingGoIds].sort())) {
    throw new Error(`${label}.missingGold must be GO-sorted and unique`);
  }
  const typed = value as unknown as RsiCaseAspectAttribution;
  if (typed.selectedCount !== typed.truePositiveCount + typed.falsePositiveCount
    || typed.goldCount !== typed.truePositiveCount + typed.falseNegativeCount
    || typed.candidateTruePositiveCount < typed.truePositiveCount
    || typed.candidateTruePositiveCount > typed.goldCount
    || typed.missingGold.length !== typed.falseNegativeCount
    || typed.selectedFalsePositiveGoIds.length !== typed.falsePositiveCount
    || typed.selectedSupportModes.sequenceSupportedTermCount + typed.selectedSupportModes.structureOnlyTermCount !== typed.selectedCount
    || typed.lineageSupports.selectedAppliedCount > typed.lineageSupports.candidateAppliedCount
    || typed.lineageSupports.selectedUnavailableCount > typed.lineageSupports.candidateUnavailableCount
    || Math.abs(typed.candidateRecallCeiling - ratio(typed.candidateTruePositiveCount, typed.goldCount)) > 1e-12) {
    throw new Error(`${label} violates attribution count invariants`);
  }
  if (!typed.scored && canonicalJson(typed) !== canonicalJson({
    aspect,
    scored: false,
    goldCount: 0,
    selectedCount: 0,
    truePositiveCount: 0,
    falsePositiveCount: 0,
    falseNegativeCount: 0,
    candidateTruePositiveCount: 0,
    candidateRecallCeiling: 0,
    selectedSupportModes: { sequenceSupportedTermCount: 0, structureOnlyTermCount: 0 },
    lineageSupports: {
      candidateAppliedCount: 0,
      candidateUnavailableCount: 0,
      selectedAppliedCount: 0,
      selectedUnavailableCount: 0,
    },
    missingGold: [],
    selectedFalsePositiveGoIds: [],
  })) throw new Error(`${label} unscored attribution must be empty`);
  return typed;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => right.has(value)).sort();
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

function hasFiniteScore(term: GOTermPrediction): boolean {
  return [term.fusionAdjustedScore, term.judgeAdjustedScore, term.phylogenyAdjustedScore, term.rawScore]
    .some((score) => score !== null && score !== undefined && Number.isFinite(score) && score > 0);
}

const HARD_EVIDENCE_BLOCKERS = new Set<NonNullable<GOTermPrediction["selectionBlockers"]>[number]>([
  "unknown_aspect",
  "non_mf_structure_only",
  "insufficient_structure_groups",
  "insufficient_provenance_roots",
  "candidate_provider_floor",
  "candidate_independent_roots",
  "candidate_term_threshold",
  "phylogeny_leaf_forbidden",
]);

const SELECTOR_BLOCKERS = new Set<NonNullable<GOTermPrediction["selectionBlockers"]>[number]>([
  "per_aspect_budget",
  "source_hypothesis_not_selected",
]);

function checkpointTrace(failure: RsiFailureStage): RsiCheckpointTrace {
  const trace = Object.fromEntries(RSI_TRACE_CHECKPOINTS.map((checkpoint) => [checkpoint, "not_reached"])) as RsiCheckpointTrace;
  const fail = (checkpoint: RsiTraceCheckpoint): RsiCheckpointTrace => {
    trace[checkpoint] = "failed";
    return trace;
  };
  if (failure === "identity_quarantined") return fail("identity_policy");
  trace.identity_policy = "passed";
  if (failure === "label_coverage") return fail("label_coverage");
  trace.label_coverage = "passed";
  if (failure === "evidence_gate") return fail("evidence_gate");
  trace.evidence_gate = "passed";
  if (failure === "score_gate") return fail("score_gate");
  trace.score_gate = "passed";
  if (failure === "judge_gate") return fail("judge_gate");
  trace.judge_gate = "passed";
  if (failure === "selector_gate") return fail("selector_gate");
  trace.selector_gate = "not_applicable";
  return trace;
}

function frontierAncestorBypassesScore(
  prediction: GOPredictionSet,
  term: GOTermPrediction,
): boolean {
  if (prediction.selectionPolicyMode !== "evidence_frontier_v1"
    || term.candidateOrigin !== "ontology_ancestor"
    || term.aspect === "unknown") return false;
  return prediction.selectionPolicyAspects === undefined
    || prediction.selectionPolicyAspects.includes(term.aspect);
}

function termFailure(
  prediction: GOPredictionSet,
  term: GOTermPrediction,
): { earliestFailureStage: RsiFailureStage; checkpoints: RsiCheckpointTrace } {
  const blockers = new Set(term.selectionBlockers ?? []);
  const trace = Object.fromEntries(RSI_TRACE_CHECKPOINTS.map((checkpoint) => [checkpoint, "not_reached"])) as RsiCheckpointTrace;
  trace.identity_policy = "passed";
  trace.label_coverage = "passed";

  if ([...HARD_EVIDENCE_BLOCKERS].some((blocker) => blockers.has(blocker))) {
    trace.evidence_gate = "failed";
    return { earliestFailureStage: "evidence_gate", checkpoints: trace };
  }
  trace.evidence_gate = "passed";

  // Evidence-frontier ancestors are closure consequences, not independently
  // thresholded or judged hypotheses. A stale `below_threshold` blocker may
  // coexist with the selector's source-hypothesis blocker, but it is not the
  // causal gate for this path.
  if (frontierAncestorBypassesScore(prediction, term)) {
    trace.score_gate = "not_applicable";
    trace.judge_gate = "not_applicable";
    if ([...SELECTOR_BLOCKERS].some((blocker) => blockers.has(blocker))) {
      trace.selector_gate = "failed";
      return { earliestFailureStage: "selector_gate", checkpoints: trace };
    }
    trace.selector_gate = "not_applicable";
    return { earliestFailureStage: "unattributed", checkpoints: trace };
  }

  const threshold = term.aspect === "unknown" ? undefined : prediction.thresholds[term.aspect];
  const preJudgeScore = term.phylogenyAdjustedScore ?? term.rawScore;
  const judgeScore = term.judgeAdjustedScore;
  const judgeApplied = term.agentJudgment !== undefined;
  const judgeRescuedScore = judgeApplied
    && threshold !== undefined
    && judgeScore !== null
    && judgeScore !== undefined
    && judgeScore >= threshold
    && !blockers.has("below_threshold");
  const preJudgeBelowThreshold = threshold !== undefined
    && (preJudgeScore === null || preJudgeScore < threshold);
  if (preJudgeBelowThreshold && !judgeRescuedScore) {
    trace.score_gate = "failed";
    return { earliestFailureStage: "score_gate", checkpoints: trace };
  }
  trace.score_gate = "passed";

  const judgeDemotedBelowThreshold = judgeApplied
    && threshold !== undefined
    && judgeScore !== null
    && judgeScore !== undefined
    && judgeScore < threshold;
  if (blockers.has("judge_candidate_budget")
    || term.agentJudgment?.verdict === "contradict"
    || judgeDemotedBelowThreshold) {
    trace.judge_gate = "failed";
    return { earliestFailureStage: "judge_gate", checkpoints: trace };
  }
  trace.judge_gate = judgeApplied ? "passed" : "not_applicable";

  if ([...SELECTOR_BLOCKERS].some((blocker) => blockers.has(blocker))) {
    trace.selector_gate = "failed";
    return { earliestFailureStage: "selector_gate", checkpoints: trace };
  }
  trace.selector_gate = "not_applicable";
  return { earliestFailureStage: "unattributed", checkpoints: trace };
}

function earliestFailure(
  prediction: GOPredictionSet | undefined,
  term: GOTermPrediction | undefined,
  goId: string,
): MissingGoldAttribution {
  let earliestFailureStage: RsiFailureStage;
  if (!term) {
    earliestFailureStage = prediction?.quarantinedGoIds.includes(goId)
      ? "identity_quarantined"
      : "label_coverage";
  } else {
    const failure = termFailure(prediction!, term);
    return { goId, ...failure };
  }
  return { goId, earliestFailureStage, checkpoints: checkpointTrace(earliestFailureStage) };
}

function donorHasSequence(support: GODonorSupport): boolean {
  return support.hasSequence ?? support.matchMode === "sequence";
}

function supportModeCounts(selectedTerms: readonly GOTermPrediction[]): SelectedSupportModeCounts {
  let sequenceSupportedTermCount = 0;
  for (const term of selectedTerms) {
    if (term.donorSupports.some(donorHasSequence)) sequenceSupportedTermCount += 1;
  }
  return {
    sequenceSupportedTermCount,
    structureOnlyTermCount: selectedTerms.length - sequenceSupportedTermCount,
  };
}

function lineageCounts(
  candidateTerms: readonly GOTermPrediction[],
  selectedTerms: readonly GOTermPrediction[],
): LineageSupportCounts {
  const count = (terms: readonly GOTermPrediction[], status: GODonorSupport["lineageStatus"]): number => terms
    .flatMap((term) => term.donorSupports)
    .filter((support) => support.lineageStatus === status)
    .length;
  return {
    candidateAppliedCount: count(candidateTerms, "applied"),
    candidateUnavailableCount: count(candidateTerms, "unavailable"),
    selectedAppliedCount: count(selectedTerms, "applied"),
    selectedUnavailableCount: count(selectedTerms, "unavailable"),
  };
}

function termsByAspect(prediction: GOPredictionSet | undefined, aspect: ScoredAspect): GOTermPrediction[] {
  if (!prediction) return [];
  const terms = prediction.terms.filter((term) => term.aspect === aspect);
  const seen = new Set<string>();
  for (const term of terms) {
    if (seen.has(term.goId)) throw new Error(`Duplicate prediction term for ${prediction.proteinId}/${aspect}: ${term.goId}`);
    seen.add(term.goId);
  }
  return terms;
}

function caseAspectAttribution(
  target: PrivateBenchmarkTarget,
  prediction: GOPredictionSet | undefined,
  aspect: ScoredAspect,
): RsiCaseAspectAttribution {
  const gold = new Set(sortedUnique(target.gold[aspect]));
  // BioReason-Pro is an aspect-specific temporal holdout. New manifests carry
  // the source null/non-null mask explicitly. In the legacy private manifest,
  // null was represented as [], while every sampled scored stratum retained at
  // least one non-root term, so nonempty gold is the safe migration fallback.
  const scored = target.scoredAspects
    ? target.scoredAspects.includes(aspect)
    : gold.size > 0;
  if (!scored) {
    return {
      aspect,
      scored: false,
      goldCount: 0,
      selectedCount: 0,
      truePositiveCount: 0,
      falsePositiveCount: 0,
      falseNegativeCount: 0,
      candidateTruePositiveCount: 0,
      candidateRecallCeiling: 0,
      selectedSupportModes: { sequenceSupportedTermCount: 0, structureOnlyTermCount: 0 },
      lineageSupports: {
        candidateAppliedCount: 0,
        candidateUnavailableCount: 0,
        selectedAppliedCount: 0,
        selectedUnavailableCount: 0,
      },
      missingGold: [],
      selectedFalsePositiveGoIds: [],
    };
  }
  const terms = termsByAspect(prediction, aspect);
  const selectedTerms = terms.filter((term) => term.selected);
  const candidateTerms = terms.filter(hasFiniteScore);
  const selected = new Set(selectedTerms.map((term) => term.goId));
  const candidates = new Set(candidateTerms.map((term) => term.goId));
  const truePositives = intersection(selected, gold);
  const falsePositives = difference(selected, gold);
  const falseNegatives = difference(gold, selected);
  const candidateTruePositives = intersection(candidates, gold);
  const termIndex = new Map(terms.map((term) => [term.goId, term]));
  const missingGold = falseNegatives.map((goId) => earliestFailure(prediction, termIndex.get(goId), goId));

  return {
    aspect,
    scored: true,
    goldCount: gold.size,
    selectedCount: selected.size,
    truePositiveCount: truePositives.length,
    falsePositiveCount: falsePositives.length,
    falseNegativeCount: falseNegatives.length,
    candidateTruePositiveCount: candidateTruePositives.length,
    candidateRecallCeiling: ratio(candidateTruePositives.length, gold.size),
    selectedSupportModes: supportModeCounts(selectedTerms),
    lineageSupports: lineageCounts(candidateTerms, selectedTerms),
    missingGold,
    selectedFalsePositiveGoIds: falsePositives,
  };
}

function caseAttribution(
  target: PrivateBenchmarkTarget,
  prediction: GOPredictionSet | undefined,
): RsiCaseAttribution {
  if (prediction && prediction.proteinId !== target.caseId) {
    throw new Error(`Prediction proteinId mismatch for ${target.caseId}: ${prediction.proteinId}`);
  }
  const molecularFunction = caseAspectAttribution(target, prediction, "molecular_function");
  const biologicalProcess = caseAspectAttribution(target, prediction, "biological_process");
  const cellularComponent = caseAspectAttribution(target, prediction, "cellular_component");
  return {
    caseId: target.caseId,
    split: target.split,
    predictionAvailable: prediction !== undefined,
    aspects: {
      molecular_function: molecularFunction,
      biological_process: biologicalProcess,
      cellular_component: cellularComponent,
    },
  };
}

function summarizeAspect(cases: readonly RsiCaseAttribution[], aspect: ScoredAspect): RsiAspectAttributionSummary {
  const rows = cases.map((item) => item.aspects[aspect]).filter((item) => item.scored);
  const sum = (select: (row: RsiCaseAspectAttribution) => number): number => rows.reduce(
    (total, row) => total + select(row),
    0,
  );
  const goldCount = sum((row) => row.goldCount);
  const candidateTruePositiveCount = sum((row) => row.candidateTruePositiveCount);
  const selectedFalsePositives = cases.flatMap((item) => item.aspects[aspect].selectedFalsePositiveGoIds.map((goId) => ({
    caseId: item.caseId,
    goId,
  }))).sort((a, b) => a.caseId.localeCompare(b.caseId) || a.goId.localeCompare(b.goId));
  const missingGold = rows.flatMap((row) => row.missingGold);
  const failureStageCounts = Object.fromEntries(RSI_FAILURE_STAGES.map((stage) => [
    stage,
    missingGold.filter((item) => item.earliestFailureStage === stage).length,
  ])) as Record<RsiFailureStage, number>;
  const failureStageDistinctCaseCounts = Object.fromEntries(RSI_FAILURE_STAGES.map((stage) => [
    stage,
    cases.filter((item) => item.aspects[aspect].missingGold.some((missing) => missing.earliestFailureStage === stage)).length,
  ])) as Record<RsiFailureStage, number>;
  return {
    aspect,
    scoredCaseCount: rows.length,
    goldCount,
    selectedCount: sum((row) => row.selectedCount),
    truePositiveCount: sum((row) => row.truePositiveCount),
    falsePositiveCount: sum((row) => row.falsePositiveCount),
    falseNegativeCount: sum((row) => row.falseNegativeCount),
    candidateTruePositiveCount,
    candidateRecallCeiling: ratio(candidateTruePositiveCount, goldCount),
    selectedSupportModes: {
      sequenceSupportedTermCount: sum((row) => row.selectedSupportModes.sequenceSupportedTermCount),
      structureOnlyTermCount: sum((row) => row.selectedSupportModes.structureOnlyTermCount),
    },
    lineageSupports: {
      candidateAppliedCount: sum((row) => row.lineageSupports.candidateAppliedCount),
      candidateUnavailableCount: sum((row) => row.lineageSupports.candidateUnavailableCount),
      selectedAppliedCount: sum((row) => row.lineageSupports.selectedAppliedCount),
      selectedUnavailableCount: sum((row) => row.lineageSupports.selectedUnavailableCount),
    },
    failureStageCounts,
    failureStageDistinctCaseCounts,
    selectedFalsePositives,
  };
}

/**
 * Validate a persisted private attribution record and recompute every public
 * aggregate from its per-case trace. This makes the attribution usable as a
 * replay binding, rather than trusting a self-consistent hash over arbitrary
 * JSON supplied beside a Teacher assessment.
 */
export function assertRsiErrorAttribution(value: unknown): RsiErrorAttribution {
  if (!isRecord(value)) throw new Error("RSI error attribution must be an object");
  exactKeys(value, ATTRIBUTION_KEYS, "RSI error attribution");
  if (value.schemaVersion !== "pi-rsi-error-attribution.v2"
    || value.candidateDefinition !== "positive_finite_judge_phylogeny_or_raw_score"
    || value.tracePolicy !== "earliest_observable_machine_checkpoint_v1") {
    throw new Error("RSI error attribution schema is unsupported");
  }
  nonnegativeInteger(value.caseCount, "RSI error attribution caseCount");
  nonnegativeInteger(value.predictionAvailableCaseCount, "RSI error attribution predictionAvailableCaseCount");
  assertStringArray(value.missingPredictionCaseIds, "RSI error attribution missingPredictionCaseIds");
  if (!Array.isArray(value.cases) || value.cases.length !== value.caseCount) {
    throw new Error("RSI error attribution case count mismatch");
  }
  const cases: RsiCaseAttribution[] = [];
  for (const [index, raw] of value.cases.entries()) {
    if (!isRecord(raw)) throw new Error(`RSI error attribution case ${index} must be an object`);
    exactKeys(raw, CASE_KEYS, `RSI error attribution case ${index}`);
    if (typeof raw.caseId !== "string" || raw.caseId.trim() === ""
      || !["search", "selection", "promotion"].includes(String(raw.split))
      || typeof raw.predictionAvailable !== "boolean"
      || !isRecord(raw.aspects)) {
      throw new Error(`RSI error attribution case ${index} has an invalid binding`);
    }
    exactKeys(raw.aspects, BENCHMARK_GO_ASPECTS, `RSI error attribution case ${index} aspects`);
    cases.push({
      caseId: raw.caseId,
      split: raw.split as RsiCaseAttribution["split"],
      predictionAvailable: raw.predictionAvailable,
      aspects: {
        molecular_function: assertCaseAspectAttribution(
          raw.aspects.molecular_function,
          "molecular_function",
          `RSI error attribution case ${index} molecular_function`,
        ),
        biological_process: assertCaseAspectAttribution(
          raw.aspects.biological_process,
          "biological_process",
          `RSI error attribution case ${index} biological_process`,
        ),
        cellular_component: assertCaseAspectAttribution(
          raw.aspects.cellular_component,
          "cellular_component",
          `RSI error attribution case ${index} cellular_component`,
        ),
      },
    });
  }
  const caseIds = cases.map((item) => item.caseId);
  if (new Set(caseIds).size !== caseIds.length
    || canonicalJson(caseIds) !== canonicalJson([...caseIds].sort())) {
    throw new Error("RSI error attribution cases must be caseId-sorted and unique");
  }
  const missingPredictionCaseIds = cases
    .filter((item) => !item.predictionAvailable)
    .map((item) => item.caseId);
  if (value.predictionAvailableCaseCount !== cases.length - missingPredictionCaseIds.length
    || canonicalJson(value.missingPredictionCaseIds) !== canonicalJson(missingPredictionCaseIds)) {
    throw new Error("RSI error attribution prediction availability summary mismatch");
  }
  if (!isRecord(value.aspects)) throw new Error("RSI error attribution aspects must be an object");
  exactKeys(value.aspects, BENCHMARK_GO_ASPECTS, "RSI error attribution aspects");
  for (const aspect of BENCHMARK_GO_ASPECTS) {
    const stored = value.aspects[aspect];
    if (!isRecord(stored)) throw new Error(`RSI error attribution ${aspect} summary must be an object`);
    exactKeys(stored, SUMMARY_KEYS, `RSI error attribution ${aspect} summary`);
    if (canonicalJson(stored) !== canonicalJson(summarizeAspect(cases, aspect))) {
      throw new Error(`RSI error attribution ${aspect} summary does not aggregate its case traces`);
    }
  }
  const typed = value as unknown as RsiErrorAttribution;
  const { canonicalHash, ...content } = typed;
  if (typeof canonicalHash !== "string" || !/^[a-f0-9]{64}$/.test(canonicalHash)
    || canonicalHash !== hashCanonical(content)) {
    throw new Error("RSI error attribution canonical hash mismatch");
  }
  return typed;
}

/**
 * Builds a deterministic, development-only error attribution from already
 * loaded private gold labels and GO prediction artifacts. It performs no I/O
 * and has no access to promotion state.
 */
export function buildRsiErrorAttribution(
  targets: readonly PrivateBenchmarkTarget[],
  predictions: ReadonlyMap<string, GOPredictionSet>,
): RsiErrorAttribution {
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.caseId)) throw new Error(`Duplicate private target caseId: ${target.caseId}`);
    seen.add(target.caseId);
  }
  const cases = [...targets]
    .sort((a, b) => a.caseId.localeCompare(b.caseId))
    .map((target) => caseAttribution(target, predictions.get(target.caseId)));
  const missingPredictionCaseIds = cases.filter((item) => !item.predictionAvailable).map((item) => item.caseId);
  const withoutHash: AttributionWithoutHash = {
    schemaVersion: "pi-rsi-error-attribution.v2",
    candidateDefinition: "positive_finite_judge_phylogeny_or_raw_score",
    tracePolicy: "earliest_observable_machine_checkpoint_v1",
    caseCount: cases.length,
    predictionAvailableCaseCount: cases.length - missingPredictionCaseIds.length,
    missingPredictionCaseIds,
    aspects: {
      molecular_function: summarizeAspect(cases, BENCHMARK_GO_ASPECTS[0]),
      biological_process: summarizeAspect(cases, BENCHMARK_GO_ASPECTS[1]),
      cellular_component: summarizeAspect(cases, BENCHMARK_GO_ASPECTS[2]),
    },
    cases,
  };
  return assertRsiErrorAttribution({ ...withoutHash, canonicalHash: hashCanonical(withoutHash) });
}
