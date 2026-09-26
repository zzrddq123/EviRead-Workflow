/**
 * Label-free public projection of method-level causal evidence.
 *
 * The evaluator may construct this value after opening private labels, but no
 * metric values, protein identifiers, GO identifiers, or free-text biological
 * claims cross this boundary.  Only registered candidate identifiers and
 * closed diagnostic bands are returned to the developer loop.
 */

export const CAUSAL_TEACHER_ASPECTS = [
  "molecular_function",
  "biological_process",
  "cellular_component",
] as const;
export type CausalTeacherAspect = typeof CAUSAL_TEACHER_ASPECTS[number];

export const CAUSAL_TEACHER_FAMILIES = [
  "selection_policy",
  "modality_fusion",
  "ontology_reasoning",
  "candidate_sources",
  "phylogeny",
  "external_predictor",
  "score_calibration",
  "aspect_router",
  "pipeline",
] as const;
export type CausalTeacherFamily = typeof CAUSAL_TEACHER_FAMILIES[number];

export const CAUSAL_TEACHER_DECISIONS = [
  "selected_successor",
  "eligible_ranked_lower",
  "reject_no_gain",
  "reject_aspect_guardrail",
  "reject_falsifier",
] as const;
export type CausalTeacherDecision = typeof CAUSAL_TEACHER_DECISIONS[number];

export const CAUSAL_EFFECT_BANDS = [
  "improved",
  "flat",
  "regressed",
  "not_evaluable",
] as const;
export type CausalEffectBand = typeof CAUSAL_EFFECT_BANDS[number];

export const CAUSAL_ACTIVATION_BANDS = [
  "not_applicable",
  "invalid",
  "inactive",
  "normalized_only",
  "admitted_not_eligible",
  "eligible_not_selected",
  "selected_sparse",
  "selected_material",
] as const;
export type CausalActivationBand = typeof CAUSAL_ACTIVATION_BANDS[number];

export const CAUSAL_PIPELINE_INVARIANTS = [
  "not_applicable",
  "satisfied",
  "violated_missing_candidate_channel",
  "violated_invalid_count",
  "violated_stage_order",
] as const;
export type CausalPipelineInvariant = typeof CAUSAL_PIPELINE_INVARIANTS[number];

export const CAUSAL_MECHANISM_VERDICTS = [
  "pipeline_invariant_violation",
  "inactive",
  "localized_gain_precision_tradeoff",
  "no_material_effect",
  "general_gain",
  "cross_aspect_interference",
  "localized_gain",
  "general_regression",
  "not_evaluable",
] as const;
export type CausalMechanismVerdict = typeof CAUSAL_MECHANISM_VERDICTS[number];

export const CAUSAL_HYPOTHESIS_VERDICTS = [
  "supported",
  "partially_supported",
  "falsified",
  "not_tested",
] as const;
export type CausalHypothesisVerdict = typeof CAUSAL_HYPOTHESIS_VERDICTS[number];

export const CAUSAL_CONTROL_ROLES = ["control", "challenger"] as const;
export type CausalControlRole = typeof CAUSAL_CONTROL_ROLES[number];

export const CAUSAL_COMPARISON_BASES = ["parent", "matched_control"] as const;
export type CausalComparisonBasis = typeof CAUSAL_COMPARISON_BASES[number];

/**
 * Closed, proposal-declared ways in which a method hypothesis can fail.
 *
 * The order is part of the public projection contract: callers must declare a
 * canonical subset and results are emitted in this order, never in evaluator
 * discovery order.
 */
export const CAUSAL_FALSIFIER_CODES = [
  "no_material_overall_gain",
  "populated_aspect_regression",
  "method_channel_inactive",
  "pipeline_invariant_violation",
  "precision_recall_tradeoff",
] as const;
export type CausalFalsifierCode = typeof CAUSAL_FALSIFIER_CODES[number];

export const CAUSAL_FALSIFIER_STATUSES = [
  "triggered",
  "not_triggered",
  "not_evaluable",
] as const;
export type CausalFalsifierStatus = typeof CAUSAL_FALSIFIER_STATUSES[number];

export interface CausalFalsifierResult {
  code: CausalFalsifierCode;
  status: CausalFalsifierStatus;
}

export const CAUSAL_DIAGNOSES = [
  "pipeline_stage_count_inconsistent",
  "learned_channel_inactive",
  "learned_channel_dropped_before_admission",
  "learned_channel_dropped_before_selection_eligibility",
  "learned_channel_not_selected",
  "learned_channel_activation_sparse",
  "method_no_material_effect",
  "method_localized_gain",
  "precision_recall_tradeoff",
  "cross_aspect_interference",
  "method_general_gain",
  "method_general_regression",
  "effect_not_evaluable",
  "candidate_rejected_by_aspect_guardrail",
  "candidate_not_retained",
  "same_mechanism_saturated",
] as const;
export type CausalDiagnosis = typeof CAUSAL_DIAGNOSES[number];

export const CAUSAL_ACTIONS = [
  "repair_pipeline_invariant",
  "activate_method_channel",
  "inspect_admission_gate",
  "inspect_selection_eligibility_gate",
  "add_new_router",
  "add_new_calibrator",
  "isolate_effective_aspect_path",
  "switch_exhausted_mechanism",
  "change_predictor_or_information_source",
  "validate_on_fresh_cohort",
  "hold_baseline",
] as const;
export type CausalAction = typeof CAUSAL_ACTIONS[number];

export const CAUSAL_NOVELTY_CLASSES = [
  "none",
  "new_predictor",
  "new_information_source",
  "new_router",
  "new_calibrator",
  "pipeline_fix",
] as const;
export type CausalNoveltyClass = typeof CAUSAL_NOVELTY_CLASSES[number];

export const CAUSAL_SATURATION_GATE_DECISIONS = [
  "allow_unexhausted",
  "allow_material_novelty",
  "reject_exhausted_mechanism_intervention",
] as const;
export type CausalSaturationGateDecision = typeof CAUSAL_SATURATION_GATE_DECISIONS[number];

export interface CausalMetricScope {
  evaluable: boolean;
  fmax: number | null;
  precisionAtFmax: number | null;
  recallAtFmax: number | null;
  coverageAtFmax: number | null;
}

export interface CausalMetricSummary {
  overall: CausalMetricScope;
  aspects: Record<CausalTeacherAspect, CausalMetricScope>;
}

export interface CausalLearnedChannelCounts {
  normalizedCandidates: number;
  admittedCandidates: number;
  selectionEligibleCandidates: number;
  selectedTerms: number;
  coveredProteins: number;
}

export interface CausalLineageAttempt {
  candidateId: string;
  family: CausalTeacherFamily;
  interventionId: string;
  decision: CausalTeacherDecision;
  mechanismVerdict: CausalMechanismVerdict;
}

export interface CausalEffectBands {
  fmax: CausalEffectBand;
  precisionAtFmax: CausalEffectBand;
  recallAtFmax: CausalEffectBand;
  coverageAtFmax: CausalEffectBand;
}

export interface OptimizationCausalTeacherInput {
  candidateId: string;
  family: CausalTeacherFamily;
  interventionId: string;
  decision: CausalTeacherDecision;
  controlRole: CausalControlRole;
  /** Public, proposal-declared hypothesis. It is validated but never interpreted as free text. */
  hypothesis: string;
  /** Canonically ordered, proposal-declared falsifiers; undeclared tests do not decide the hypothesis. */
  falsifierCodes: readonly CausalFalsifierCode[];
  parentMetrics: CausalMetricSummary;
  candidateMetrics: CausalMetricSummary;
  parentLearnedChannel?: CausalLearnedChannelCounts | null;
  candidateLearnedChannel?: CausalLearnedChannelCounts | null;
  /**
   * Optional same-opening matched control. When present it replaces the parent
   * as the metric and learned-channel comparison basis.
   */
  matchedControlMetrics?: CausalMetricSummary | null;
  matchedControlLearnedChannel?: CausalLearnedChannelCounts | null;
  /** Chronological prior attempts; the current candidate must not be included. */
  lineageAttempts: readonly CausalLineageAttempt[];
}

export interface OptimizationCausalTeacherFeedback {
  schemaVersion: "pi-optimization-causal-teacher-feedback.v2";
  candidateId: string;
  family: CausalTeacherFamily;
  decision: CausalTeacherDecision;
  comparisonBasis: CausalComparisonBasis;
  activationBand: CausalActivationBand;
  pipelineInvariant: CausalPipelineInvariant;
  overallEffect: CausalEffectBands;
  aspectEffects: Record<CausalTeacherAspect, CausalEffectBands>;
  mechanismVerdict: CausalMechanismVerdict;
  hypothesisVerdict: CausalHypothesisVerdict;
  falsifierResults: CausalFalsifierResult[];
  diagnoses: CausalDiagnosis[];
  prioritizedActions: CausalAction[];
  consecutiveSameMechanismNoGain: number;
  consecutiveSameInterventionNoGain: number;
  forbiddenExhaustedMechanisms: CausalTeacherFamily[];
}

export interface CausalSaturationGateResult {
  allowed: boolean;
  decision: CausalSaturationGateDecision;
  priorConsecutiveNoGain: number;
}

export const CAUSAL_TEACHER_POLICY = {
  materialEffectEpsilon: 0.001,
  sparseActivationUpperExclusive: 0.25,
  maximumConsecutiveNoGain: 2,
} as const;

const SAFE_DEVELOPER_ID = /^[a-z][a-z0-9_]{0,63}$/;
const MATERIAL_NOVELTY = new Set<CausalNoveltyClass>([
  "new_predictor",
  "new_information_source",
  "new_router",
  "new_calibrator",
  "pipeline_fix",
]);

function assertDeveloperId(value: string, label: string): void {
  if (!SAFE_DEVELOPER_ID.test(value) || value.startsWith("case_") || value.startsWith("protein_") || value.startsWith("go_")) {
    throw new Error(`${label} must be a registered lower-snake-case developer identifier`);
  }
}

function metricBand(parent: number | null, candidate: number | null, evaluable: boolean): CausalEffectBand {
  if (!evaluable || parent === null || candidate === null) return "not_evaluable";
  if (!Number.isFinite(parent) || !Number.isFinite(candidate)
    || parent < 0 || parent > 1 || candidate < 0 || candidate > 1) {
    throw new Error("causal teacher metric inputs must be finite values in [0, 1]");
  }
  const delta = candidate - parent;
  if (delta > CAUSAL_TEACHER_POLICY.materialEffectEpsilon) return "improved";
  if (delta < -CAUSAL_TEACHER_POLICY.materialEffectEpsilon) return "regressed";
  return "flat";
}

function effectBands(parent: CausalMetricScope, candidate: CausalMetricScope): CausalEffectBands {
  const evaluable = parent.evaluable && candidate.evaluable;
  return {
    fmax: metricBand(parent.fmax, candidate.fmax, evaluable),
    precisionAtFmax: metricBand(parent.precisionAtFmax, candidate.precisionAtFmax, evaluable),
    recallAtFmax: metricBand(parent.recallAtFmax, candidate.recallAtFmax, evaluable),
    coverageAtFmax: metricBand(parent.coverageAtFmax, candidate.coverageAtFmax, evaluable),
  };
}

function validCounts(value: CausalLearnedChannelCounts): boolean {
  return [
    value.normalizedCandidates,
    value.admittedCandidates,
    value.selectionEligibleCandidates,
    value.selectedTerms,
    value.coveredProteins,
  ].every((count) => Number.isSafeInteger(count) && count >= 0);
}

function orderedCounts(value: CausalLearnedChannelCounts): boolean {
  return value.normalizedCandidates >= value.admittedCandidates
    && value.admittedCandidates >= value.selectionEligibleCandidates
    // selectedTerms counts unique GO terms after ontology propagation, whereas
    // selectionEligibleCandidates counts provider rows.  One eligible row may
    // therefore support multiple selected ancestors; only the zero/non-zero
    // stage implication is an invariant across those different units.
    && (value.selectionEligibleCandidates > 0 || value.selectedTerms === 0)
    && value.normalizedCandidates >= value.coveredProteins;
}

export function causalPipelineInvariant(input: Pick<
  OptimizationCausalTeacherInput,
  "parentLearnedChannel" | "candidateLearnedChannel"
>): CausalPipelineInvariant {
  const parent = input.parentLearnedChannel ?? null;
  const candidate = input.candidateLearnedChannel ?? null;
  if (!parent && !candidate) return "not_applicable";
  if (parent && !candidate) return "violated_missing_candidate_channel";
  if ((parent && !validCounts(parent)) || (candidate && !validCounts(candidate))) {
    return "violated_invalid_count";
  }
  if ((parent && !orderedCounts(parent)) || (candidate && !orderedCounts(candidate))) {
    return "violated_stage_order";
  }
  return "satisfied";
}

export function causalActivationBand(
  channel: CausalLearnedChannelCounts | null | undefined,
  invariant: CausalPipelineInvariant,
): CausalActivationBand {
  if (invariant === "not_applicable") return "not_applicable";
  if (invariant !== "satisfied" || !channel) return "invalid";
  if (channel.normalizedCandidates === 0) return "inactive";
  if (channel.admittedCandidates === 0) return "normalized_only";
  if (channel.selectionEligibleCandidates === 0) return "admitted_not_eligible";
  if (channel.selectedTerms === 0) return "eligible_not_selected";
  if (channel.selectedTerms / Math.max(1, channel.coveredProteins)
    < CAUSAL_TEACHER_POLICY.sparseActivationUpperExclusive) return "selected_sparse";
  return "selected_material";
}

function mechanismVerdict(
  pipelineInvariant: CausalPipelineInvariant,
  activationBand: CausalActivationBand,
  overall: CausalEffectBands,
  aspects: Record<CausalTeacherAspect, CausalEffectBands>,
): CausalMechanismVerdict {
  if (pipelineInvariant !== "not_applicable" && pipelineInvariant !== "satisfied") {
    return "pipeline_invariant_violation";
  }
  if (["inactive", "normalized_only", "admitted_not_eligible", "eligible_not_selected"].includes(activationBand)) {
    return "inactive";
  }
  const aspectValues = CAUSAL_TEACHER_ASPECTS.map((aspect) => aspects[aspect]);
  const fmaxValues = aspectValues.map((value) => value.fmax);
  if (overall.fmax === "not_evaluable" && fmaxValues.every((value) => value === "not_evaluable")) {
    return "not_evaluable";
  }
  const improved = fmaxValues.filter((value) => value === "improved").length;
  const regressed = fmaxValues.filter((value) => value === "regressed").length;
  if (improved > 0 && regressed > 0) return "cross_aspect_interference";
  if (aspectValues.some((value) => value.fmax === "improved"
    && value.precisionAtFmax === "regressed"
    && value.recallAtFmax === "improved")) {
    return "localized_gain_precision_tradeoff";
  }
  if (improved >= 2 && regressed === 0) return "general_gain";
  if (improved > 0 || overall.fmax === "improved") return "localized_gain";
  if (regressed > 0 || overall.fmax === "regressed") return "general_regression";
  return "no_material_effect";
}

function legacyHypothesisVerdict(verdict: CausalMechanismVerdict): CausalHypothesisVerdict {
  if (["pipeline_invariant_violation", "inactive", "not_evaluable"].includes(verdict)) return "not_tested";
  if (["general_gain", "localized_gain"].includes(verdict)) return "supported";
  if (["localized_gain_precision_tradeoff", "cross_aspect_interference"].includes(verdict)) {
    return "partially_supported";
  }
  return "falsified";
}

const INACTIVE_ACTIVATION_BANDS = new Set<CausalActivationBand>([
  "inactive",
  "normalized_only",
  "admitted_not_eligible",
  "eligible_not_selected",
]);

const EFFICACY_FALSIFIERS = new Set<CausalFalsifierCode>([
  "no_material_overall_gain",
  "populated_aspect_regression",
  "precision_recall_tradeoff",
]);

function falsifierStatusForBand(
  band: CausalEffectBand,
  trigger: readonly CausalEffectBand[],
): CausalFalsifierStatus {
  if (band === "not_evaluable") return "not_evaluable";
  return trigger.includes(band) ? "triggered" : "not_triggered";
}

function populatedAspectRegression(
  aspects: Record<CausalTeacherAspect, CausalEffectBands>,
): CausalFalsifierStatus {
  const bands = CAUSAL_TEACHER_ASPECTS.map((aspect) => aspects[aspect].fmax)
    .filter((band) => band !== "not_evaluable");
  if (bands.length === 0) return "not_evaluable";
  return bands.includes("regressed") ? "triggered" : "not_triggered";
}

function precisionRecallTradeoff(
  overall: CausalEffectBands,
  aspects: Record<CausalTeacherAspect, CausalEffectBands>,
): CausalFalsifierStatus {
  const scopes = [overall, ...CAUSAL_TEACHER_ASPECTS.map((aspect) => aspects[aspect])];
  const evaluable = scopes.filter((scope) => scope.precisionAtFmax !== "not_evaluable"
    && scope.recallAtFmax !== "not_evaluable");
  if (evaluable.length === 0) return "not_evaluable";
  return evaluable.some((scope) => scope.precisionAtFmax === "regressed"
      && scope.recallAtFmax === "improved")
    ? "triggered"
    : "not_triggered";
}

function evaluateFalsifiers(input: {
  declared: readonly CausalFalsifierCode[];
  activationBand: CausalActivationBand;
  pipelineInvariant: CausalPipelineInvariant;
  overallEffect: CausalEffectBands;
  aspectEffects: Record<CausalTeacherAspect, CausalEffectBands>;
}): CausalFalsifierResult[] {
  const statusByCode: Record<CausalFalsifierCode, CausalFalsifierStatus> = {
    no_material_overall_gain: falsifierStatusForBand(
      input.overallEffect.fmax,
      ["flat", "regressed"],
    ),
    populated_aspect_regression: populatedAspectRegression(input.aspectEffects),
    method_channel_inactive: input.activationBand === "not_applicable" || input.activationBand === "invalid"
      ? "not_evaluable"
      : INACTIVE_ACTIVATION_BANDS.has(input.activationBand) ? "triggered" : "not_triggered",
    pipeline_invariant_violation: input.pipelineInvariant === "not_applicable"
      ? "not_evaluable"
      : input.pipelineInvariant === "satisfied" ? "not_triggered" : "triggered",
    precision_recall_tradeoff: precisionRecallTradeoff(input.overallEffect, input.aspectEffects),
  };
  return CAUSAL_FALSIFIER_CODES
    .filter((code) => input.declared.includes(code))
    .map((code) => ({ code, status: statusByCode[code] }));
}

function hypothesisVerdict(input: {
  mechanismVerdict: CausalMechanismVerdict;
  falsifierResults: readonly CausalFalsifierResult[];
  matchedControlInvalidOrInactive: boolean;
}): CausalHypothesisVerdict {
  if (input.matchedControlInvalidOrInactive
    || ["pipeline_invariant_violation", "inactive", "not_evaluable"].includes(input.mechanismVerdict)) {
    return "not_tested";
  }
  if (input.falsifierResults.some((result) =>
    EFFICACY_FALSIFIERS.has(result.code) && result.status === "triggered")) {
    return "falsified";
  }
  if (input.falsifierResults.some((result) => result.status === "not_evaluable")) return "not_tested";
  return legacyHypothesisVerdict(input.mechanismVerdict);
}

function standaloneChannelInvariant(
  channel: CausalLearnedChannelCounts | null | undefined,
): CausalPipelineInvariant {
  if (!channel) return "not_applicable";
  if (!validCounts(channel)) return "violated_invalid_count";
  if (!orderedCounts(channel)) return "violated_stage_order";
  return "satisfied";
}

function matchedControlInvalidOrInactive(
  channel: CausalLearnedChannelCounts | null | undefined,
): boolean {
  if (!channel) return false;
  const invariant = standaloneChannelInvariant(channel);
  const activation = causalActivationBand(channel, invariant);
  return invariant !== "satisfied" || INACTIVE_ACTIVATION_BANDS.has(activation);
}

function assertCausalExperimentContract(input: Pick<
  OptimizationCausalTeacherInput,
  "controlRole" | "hypothesis" | "falsifierCodes" | "matchedControlMetrics" | "matchedControlLearnedChannel"
>): void {
  if (!(CAUSAL_CONTROL_ROLES as readonly string[]).includes(input.controlRole)) {
    throw new Error("controlRole must be a registered causal control role");
  }
  if (typeof input.hypothesis !== "string"
    || input.hypothesis.trim().length === 0
    || input.hypothesis.length > 1_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.hypothesis)) {
    throw new Error("hypothesis must be non-empty bounded public text");
  }
  if (!Array.isArray(input.falsifierCodes)
    || input.falsifierCodes.length === 0
    || new Set(input.falsifierCodes).size !== input.falsifierCodes.length
    || input.falsifierCodes.some((code) => !(CAUSAL_FALSIFIER_CODES as readonly string[]).includes(code))) {
    throw new Error("falsifierCodes must be a non-empty unique subset of the registered falsifiers");
  }
  const canonical = CAUSAL_FALSIFIER_CODES.filter((code) => input.falsifierCodes.includes(code));
  if (canonical.some((code, index) => input.falsifierCodes[index] !== code)) {
    throw new Error("falsifierCodes must be in canonical order");
  }
  if (input.matchedControlLearnedChannel != null && input.matchedControlMetrics == null) {
    throw new Error("matchedControlLearnedChannel requires matchedControlMetrics");
  }
}

function isNoGain(attempt: Pick<CausalLineageAttempt, "decision" | "mechanismVerdict">): boolean {
  if (attempt.decision === "selected_successor" || attempt.decision === "eligible_ranked_lower") return false;
  return true;
}

function trailingNoGain(
  attempts: readonly CausalLineageAttempt[],
  predicate: (attempt: CausalLineageAttempt) => boolean,
): number {
  const matching = attempts.filter(predicate);
  let count = 0;
  for (let index = matching.length - 1; index >= 0; index -= 1) {
    if (!isNoGain(matching[index])) break;
    count += 1;
  }
  return count;
}

function appendCurrentAttempt(
  input: Pick<OptimizationCausalTeacherInput, "candidateId" | "family" | "interventionId" | "decision">,
  verdict: CausalMechanismVerdict,
  lineage: readonly CausalLineageAttempt[],
): CausalLineageAttempt[] {
  return [...lineage, {
    candidateId: input.candidateId,
    family: input.family,
    interventionId: input.interventionId,
    decision: input.decision,
    mechanismVerdict: verdict,
  }];
}

function pushUnique<T>(items: T[], item: T): void {
  if (!items.includes(item)) items.push(item);
}

export function evaluateCausalSaturationGate(input: {
  family: CausalTeacherFamily;
  interventionId: string;
  novelty: CausalNoveltyClass;
  lineageAttempts: readonly CausalLineageAttempt[];
}): CausalSaturationGateResult {
  assertDeveloperId(input.interventionId, "interventionId");
  const priorConsecutiveNoGain = trailingNoGain(
    input.lineageAttempts,
    (attempt) => attempt.family === input.family && attempt.interventionId === input.interventionId,
  );
  if (priorConsecutiveNoGain < CAUSAL_TEACHER_POLICY.maximumConsecutiveNoGain) {
    return { allowed: true, decision: "allow_unexhausted", priorConsecutiveNoGain };
  }
  if (MATERIAL_NOVELTY.has(input.novelty)) {
    return { allowed: true, decision: "allow_material_novelty", priorConsecutiveNoGain };
  }
  return {
    allowed: false,
    decision: "reject_exhausted_mechanism_intervention",
    priorConsecutiveNoGain,
  };
}

export function assertCausalSaturationGate(input: Parameters<typeof evaluateCausalSaturationGate>[0]): void {
  const gate = evaluateCausalSaturationGate(input);
  if (!gate.allowed) {
    throw new Error(`causal saturation gate rejected proposal: ${gate.decision}`);
  }
}

export function buildOptimizationCausalTeacherFeedback(
  input: OptimizationCausalTeacherInput,
): OptimizationCausalTeacherFeedback {
  assertDeveloperId(input.candidateId, "candidateId");
  assertDeveloperId(input.interventionId, "interventionId");
  assertCausalExperimentContract(input);
  input.lineageAttempts.forEach((attempt, index) => {
    assertDeveloperId(attempt.candidateId, `lineageAttempts[${index}].candidateId`);
    assertDeveloperId(attempt.interventionId, `lineageAttempts[${index}].interventionId`);
  });
  const useMatchedControl = input.matchedControlMetrics != null;
  const comparisonBasis: CausalComparisonBasis = useMatchedControl ? "matched_control" : "parent";
  const comparisonMetrics = useMatchedControl ? input.matchedControlMetrics! : input.parentMetrics;
  const comparisonLearnedChannel = useMatchedControl
    ? input.matchedControlLearnedChannel ?? null
    : input.parentLearnedChannel ?? null;
  const pipelineInvariant = causalPipelineInvariant({
    parentLearnedChannel: comparisonLearnedChannel,
    candidateLearnedChannel: input.candidateLearnedChannel,
  });
  const activationBand = causalActivationBand(input.candidateLearnedChannel, pipelineInvariant);
  const overallEffect = effectBands(comparisonMetrics.overall, input.candidateMetrics.overall);
  const aspectEffects = Object.fromEntries(CAUSAL_TEACHER_ASPECTS.map((aspect) => [
    aspect,
    effectBands(comparisonMetrics.aspects[aspect], input.candidateMetrics.aspects[aspect]),
  ])) as Record<CausalTeacherAspect, CausalEffectBands>;
  const verdict = mechanismVerdict(pipelineInvariant, activationBand, overallEffect, aspectEffects);
  const falsifierResults = evaluateFalsifiers({
    declared: input.falsifierCodes,
    activationBand,
    pipelineInvariant,
    overallEffect,
    aspectEffects,
  });
  const matchedControlIsInvalidOrInactive = useMatchedControl
    && matchedControlInvalidOrInactive(input.matchedControlLearnedChannel);
  const attempts = appendCurrentAttempt(input, verdict, input.lineageAttempts);
  const consecutiveSameMechanismNoGain = trailingNoGain(attempts, (attempt) => attempt.family === input.family);
  const consecutiveSameInterventionNoGain = trailingNoGain(
    attempts,
    (attempt) => attempt.family === input.family && attempt.interventionId === input.interventionId,
  );
  const forbiddenExhaustedMechanisms = CAUSAL_TEACHER_FAMILIES.filter((family) =>
    trailingNoGain(attempts, (attempt) => attempt.family === family)
      >= CAUSAL_TEACHER_POLICY.maximumConsecutiveNoGain);
  const diagnoses: CausalDiagnosis[] = [];
  const prioritizedActions: CausalAction[] = [];

  if (verdict === "pipeline_invariant_violation") {
    pushUnique(diagnoses, "pipeline_stage_count_inconsistent");
    pushUnique(prioritizedActions, "repair_pipeline_invariant");
  } else if (verdict === "inactive") {
    if (activationBand === "inactive") {
      pushUnique(diagnoses, "learned_channel_inactive");
      pushUnique(prioritizedActions, "activate_method_channel");
    } else if (activationBand === "normalized_only") {
      pushUnique(diagnoses, "learned_channel_dropped_before_admission");
      pushUnique(prioritizedActions, "inspect_admission_gate");
    } else if (activationBand === "admitted_not_eligible") {
      pushUnique(diagnoses, "learned_channel_dropped_before_selection_eligibility");
      pushUnique(prioritizedActions, "inspect_selection_eligibility_gate");
    } else {
      pushUnique(diagnoses, "learned_channel_not_selected");
      pushUnique(prioritizedActions, "add_new_router");
    }
  } else if (verdict === "localized_gain_precision_tradeoff") {
    pushUnique(diagnoses, "method_localized_gain");
    pushUnique(diagnoses, "precision_recall_tradeoff");
    pushUnique(prioritizedActions, "add_new_calibrator");
    pushUnique(prioritizedActions, "isolate_effective_aspect_path");
  } else if (verdict === "cross_aspect_interference") {
    pushUnique(diagnoses, "cross_aspect_interference");
    pushUnique(prioritizedActions, "add_new_router");
    pushUnique(prioritizedActions, "isolate_effective_aspect_path");
  } else if (verdict === "general_gain") {
    pushUnique(diagnoses, "method_general_gain");
    pushUnique(prioritizedActions, "validate_on_fresh_cohort");
  } else if (verdict === "localized_gain") {
    pushUnique(diagnoses, "method_localized_gain");
    pushUnique(prioritizedActions, "isolate_effective_aspect_path");
  } else if (verdict === "general_regression") {
    pushUnique(diagnoses, "method_general_regression");
    pushUnique(prioritizedActions, "hold_baseline");
    pushUnique(prioritizedActions, "change_predictor_or_information_source");
  } else if (verdict === "not_evaluable") {
    pushUnique(diagnoses, "effect_not_evaluable");
    pushUnique(prioritizedActions, "hold_baseline");
  } else {
    pushUnique(diagnoses, "method_no_material_effect");
    pushUnique(prioritizedActions, "switch_exhausted_mechanism");
    pushUnique(prioritizedActions, "change_predictor_or_information_source");
  }
  if (activationBand === "selected_sparse") {
    pushUnique(diagnoses, "learned_channel_activation_sparse");
    pushUnique(prioritizedActions, "add_new_router");
  }
  if (input.decision === "reject_aspect_guardrail") {
    pushUnique(diagnoses, "candidate_rejected_by_aspect_guardrail");
  }
  if (input.decision !== "selected_successor") pushUnique(diagnoses, "candidate_not_retained");
  if (consecutiveSameMechanismNoGain >= CAUSAL_TEACHER_POLICY.maximumConsecutiveNoGain) {
    pushUnique(diagnoses, "same_mechanism_saturated");
    pushUnique(prioritizedActions, "switch_exhausted_mechanism");
  }

  return {
    schemaVersion: "pi-optimization-causal-teacher-feedback.v2",
    candidateId: input.candidateId,
    family: input.family,
    decision: input.decision,
    comparisonBasis,
    activationBand,
    pipelineInvariant,
    overallEffect,
    aspectEffects,
    mechanismVerdict: verdict,
    hypothesisVerdict: hypothesisVerdict({
      mechanismVerdict: verdict,
      falsifierResults,
      matchedControlInvalidOrInactive: matchedControlIsInvalidOrInactive,
    }),
    falsifierResults,
    diagnoses,
    prioritizedActions,
    consecutiveSameMechanismNoGain,
    consecutiveSameInterventionNoGain,
    forbiddenExhaustedMechanisms,
  };
}
