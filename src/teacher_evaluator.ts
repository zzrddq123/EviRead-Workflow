import type { PrivateBenchmarkTarget, ScoredAspect } from "./benchmark_io.js";
import { BENCHMARK_GO_ASPECTS } from "./benchmark_metrics.js";
import { canonicalJson, hashCanonical } from "./hash.js";
import {
  assertRsiErrorAttribution,
  buildRsiErrorAttribution,
  RSI_FAILURE_STAGES,
  type RsiErrorAttribution,
  type RsiFailureStage,
} from "./rsi_reflect.js";
import type { GODonorSupport, GOPredictionSet, GOTermPrediction } from "./types.js";

/**
 * The teacher owns private labels.  Only TeacherFeedback may cross into the
 * developer process; PrivateTeacherAssessment is an evaluator-vault artifact.
 */
export const TEACHER_ACTION_IDS = [
  "expand_direct_candidates",
  "add_ontology_label_retriever",
  "rerun_evidence_acquisition",
  "strengthen_phylogeny_context",
  "decorrelate_sources",
  "activate_selective_candidates",
  "apply_evidence_frontier",
  "tighten_selection_budget",
  "calibrate_mf_selection",
  "calibrate_bp_selection",
  "calibrate_cc_selection",
  "calibrate_aspect_selection",
  "hold_baseline",
] as const;

export type TeacherActionId = typeof TEACHER_ACTION_IDS[number];

export const TEACHER_EFFECT_BANDS = ["improved", "flat", "regressed", "suppressed"] as const;
export type TeacherEffectBand = typeof TEACHER_EFFECT_BANDS[number];

export const TEACHER_EXPERIMENT_LESSON_IDS = [
  "candidate_recall_not_improved",
  "candidate_expansion_hurt_selection",
  "selection_rescue_without_candidate_gain",
  "selection_tradeoff_across_aspects",
  "no_material_effect",
] as const;
export type TeacherExperimentLessonId = typeof TEACHER_EXPERIMENT_LESSON_IDS[number];

export const TEACHER_EXPERIMENT_FAMILIES = [
  "selection_policy",
  "modality_fusion",
  "ontology_reasoning",
  "candidate_sources",
  "phylogeny",
] as const;
export type TeacherExperimentFamily = typeof TEACHER_EXPERIMENT_FAMILIES[number];

export const TEACHER_QUALITY_BANDS = [
  "critical",
  "weak",
  "adequate",
  "strong",
  "not_evaluated",
  "suppressed",
] as const;
export type TeacherQualityBand = typeof TEACHER_QUALITY_BANDS[number];

export const TEACHER_LOSS_BANDS = [
  "none",
  "low",
  "medium",
  "high",
  "not_evaluated",
  "suppressed",
] as const;
export type TeacherLossBand = typeof TEACHER_LOSS_BANDS[number];

export const TEACHER_FAILURE_STAGES = [
  "label_coverage",
  "evidence_gate",
  "score_gate",
  "judge_gate",
  "selector_gate",
  "mixed",
  "no_detected_failure",
  "not_evaluated",
  "suppressed",
] as const;
export type TeacherFailureStage = typeof TEACHER_FAILURE_STAGES[number];

export const TEACHER_DOMINANT_LOSSES = [
  "candidate_generation",
  "ancestor_only_specificity",
  "phylogeny_context",
  "source_correlation",
  "candidate_impurity",
  "selection_rejection",
  "no_detected_loss",
  "small_sample",
] as const;
export type TeacherDominantLoss = typeof TEACHER_DOMINANT_LOSSES[number];

export const TEACHER_DIAGNOSIS_IDS = [
  "candidate_recall_low",
  "direct_candidates_sparse",
  "ancestor_dependence_high",
  "phylogeny_context_sparse",
  "source_diversity_low",
  "candidate_purity_low",
  "selected_precision_low",
  "selection_retention_low",
  "machine_blocker_loss_high",
  "label_coverage_gap",
  "evidence_gate_loss",
  "score_gate_loss",
  "judge_gate_loss",
  "selector_gate_loss",
  "selection_overbreadth_high",
  "small_sample_suppressed",
  "no_material_weakness",
] as const;
export type TeacherDiagnosisId = typeof TEACHER_DIAGNOSIS_IDS[number];

export const TEACHER_MACHINE_BLOCKERS = [
  "candidate_provider_floor",
  "candidate_independent_roots",
  "candidate_term_threshold",
  "phylogeny_leaf_forbidden",
  "non_mf_structure_only",
  "insufficient_structure_groups",
  "insufficient_provenance_roots",
  "below_threshold",
  "unknown_aspect",
  "selector_cap_or_unattributed",
] as const;
export type TeacherMachineBlocker = typeof TEACHER_MACHINE_BLOCKERS[number];

export const TEACHER_ORIGINS = [
  "direct_annotation",
  "direct_candidate_source",
  "ontology_ancestor",
  "unattributed",
] as const;
export type TeacherOrigin = typeof TEACHER_ORIGINS[number];

export const TEACHER_PROVIDERS = ["InterProScan", "GOA_mapping", "OMA", "mDeepFRI", "DeepGOPlus", "unattributed"] as const;
export type TeacherProvider = typeof TEACHER_PROVIDERS[number];

export const TEACHER_CANDIDATE_SOURCES = [
  "interpro",
  "pfam",
  "panther",
  "ec",
  "oma_ortholog",
  "oma_fastmap",
  "mdeepfri_cnn",
  "mdeepfri_gcn",
  "deepgoplus_cnn",
  "deepgoplus_hybrid",
  "unattributed",
] as const;
export type TeacherCandidateSource = typeof TEACHER_CANDIDATE_SOURCES[number];

export interface TeacherUseCounts {
  candidateTermCount: number;
  selectedTermCount: number;
  candidateTruePositiveCount: number;
  selectedTruePositiveCount: number;
}

export interface PrivateTeacherAspectAssessment {
  scoredCaseCount: number;
  goldTermCount: number;
  candidateTermCount: number;
  selectedTermCount: number;
  candidateTruePositiveCount: number;
  selectedTruePositiveCount: number;
  candidateFalsePositiveCount: number;
  selectedFalsePositiveCount: number;
  candidateFalseNegativeCount: number;
  selectedFalseNegativeCount: number;
  directCandidateTruePositiveCount: number;
  ancestorCandidateTruePositiveCount: number;
  unattributedCandidateTruePositiveCount: number;
  directSelectedTruePositiveCount: number;
  ancestorSelectedTruePositiveCount: number;
  unattributedSelectedTruePositiveCount: number;
  lostCandidateTruePositiveCount: number;
  phylogenyAppliedCandidateTermCount: number;
  phylogenyAppliedSelectedTermCount: number;
  candidatePrecisionProxy: number;
  selectedPrecisionProxy: number;
  candidateRecallCeiling: number;
  selectedRecall: number;
  truePositiveSelectionRetention: number;
  candidateSelectionRate: number;
  directCandidateTruePositiveFraction: number;
  phylogenyCandidateUseFraction: number;
  machineBlockerLossCounts: Record<TeacherMachineBlocker, number>;
  originUse: Record<TeacherOrigin, TeacherUseCounts>;
  providerUse: Record<TeacherProvider, TeacherUseCounts>;
  candidateSourceUse: Record<TeacherCandidateSource, TeacherUseCounts>;
}

export interface PrivateTeacherAssessment {
  schemaVersion: "pi-private-teacher-assessment.v2";
  candidateDefinition: "positive_finite_judge_phylogeny_or_raw_score";
  aspectMaskPolicy: "explicit_scored_aspects_else_nonempty_gold";
  causalTracePolicy: "earliest_observable_machine_checkpoint_v1";
  caseCount: number;
  aspects: Record<ScoredAspect, PrivateTeacherAspectAssessment>;
  /** Sum over scored protein/aspect units; it is not a case-level micro-average. */
  overall: PrivateTeacherAspectAssessment;
  causalTrace: PrivateTeacherCausalTrace;
  canonicalHash: string;
}

export interface PrivateTeacherCausalSignal {
  failureStageCounts: Record<RsiFailureStage, number>;
  failureStageDistinctCaseCounts: Record<RsiFailureStage, number>;
  selectedFalsePositiveDistinctCaseCount: number;
}

export interface PrivateTeacherCausalTrace {
  aspects: Record<ScoredAspect, PrivateTeacherCausalSignal>;
  overall: PrivateTeacherCausalSignal;
}

interface ThresholdTriplet {
  criticalUpperExclusive: number;
  weakUpperExclusive: number;
  adequateUpperExclusive: number;
}

export interface TeacherPolicy {
  schemaVersion: "pi-teacher-policy.v5";
  minimumScoredCasesPerSignal: 2;
  minimumAffectedCasesPerCausalSignal: 2;
  contrastFlatEpsilon: number;
  actionResolutionPolicy: "material_actions_exclude_hold_v1";
  /** Absolute weaknesses always describe the genome retained for the next round. */
  absoluteCalibrationPolicy: "retained_parent_aspect_localized_v2";
  /** Trial lessons compare the evaluated pre-gate parent with each trial. */
  contrastiveLessonPolicy: "evaluated_parent_trial_aspect_bands_v2";
  /** Contrastive actions use semantic priority before absolute parent coaching. */
  actionPriorityPolicy: "semantic_order_then_absolute_v1";
  qualityThresholds: {
    candidateRecall: ThresholdTriplet;
    candidatePurity: ThresholdTriplet;
    selectedPrecision: ThresholdTriplet;
    selectionRetention: ThresholdTriplet;
    directCandidateSupport: ThresholdTriplet;
    phylogenyContext: ThresholdTriplet;
  };
  blockerLossThresholds: {
    lowUpperInclusive: number;
    mediumUpperInclusive: number;
  };
  sourceDiversityThresholds: {
    criticalMaximum: number;
    weakMaximum: number;
    adequateMaximum: number;
  };
  causalActionOrder: TeacherActionId[];
  canonicalHash: string;
}

const POLICY_CONTENT = {
  schemaVersion: "pi-teacher-policy.v5" as const,
  minimumScoredCasesPerSignal: 2 as const,
  minimumAffectedCasesPerCausalSignal: 2 as const,
  contrastFlatEpsilon: 0.001,
  actionResolutionPolicy: "material_actions_exclude_hold_v1" as const,
  absoluteCalibrationPolicy: "retained_parent_aspect_localized_v2" as const,
  contrastiveLessonPolicy: "evaluated_parent_trial_aspect_bands_v2" as const,
  actionPriorityPolicy: "semantic_order_then_absolute_v1" as const,
  qualityThresholds: {
    candidateRecall: { criticalUpperExclusive: 0.25, weakUpperExclusive: 0.5, adequateUpperExclusive: 0.75 },
    candidatePurity: { criticalUpperExclusive: 0.05, weakUpperExclusive: 0.15, adequateUpperExclusive: 0.35 },
    selectedPrecision: { criticalUpperExclusive: 0.1, weakUpperExclusive: 0.25, adequateUpperExclusive: 0.5 },
    selectionRetention: { criticalUpperExclusive: 0.25, weakUpperExclusive: 0.5, adequateUpperExclusive: 0.75 },
    directCandidateSupport: { criticalUpperExclusive: 0.1, weakUpperExclusive: 0.3, adequateUpperExclusive: 0.6 },
    phylogenyContext: { criticalUpperExclusive: 0.05, weakUpperExclusive: 0.2, adequateUpperExclusive: 0.5 },
  },
  blockerLossThresholds: { lowUpperInclusive: 0.2, mediumUpperInclusive: 0.5 },
  sourceDiversityThresholds: { criticalMaximum: 0, weakMaximum: 1, adequateMaximum: 2 },
  causalActionOrder: [...TEACHER_ACTION_IDS],
};

export const TEACHER_POLICY_HASH = hashCanonical(POLICY_CONTENT);

export interface TeacherSignal {
  sampleStatus: "sufficient" | "suppressed";
  candidateRecall: TeacherQualityBand;
  candidatePurity: TeacherQualityBand;
  selectedPrecision: TeacherQualityBand;
  selectionRetention: TeacherQualityBand;
  directCandidateSupport: TeacherQualityBand;
  sourceDiversity: TeacherQualityBand;
  phylogenyContext: TeacherQualityBand;
  machineBlockerLoss: TeacherLossBand;
  earliestFailureStage: TeacherFailureStage;
  failureBurden: TeacherLossBand;
  selectionOverbreadth: TeacherLossBand;
  dominantLoss: TeacherDominantLoss;
  diagnoses: TeacherDiagnosisId[];
}

export interface TeacherFeedback {
  schemaVersion: "pi-teacher-feedback.v4";
  policyHash: string;
  aspects: Record<ScoredAspect, TeacherSignal>;
  overall: TeacherSignal;
  dominantLoss: TeacherDominantLoss;
  diagnoses: TeacherDiagnosisId[];
  experimentLessons: TeacherExperimentLesson[];
  prioritizedActions: TeacherActionId[];
  canonicalHash: string;
}

export interface TeacherExperimentLesson {
  candidateHash: string;
  family: TeacherExperimentFamily;
  aspectEffects: Record<ScoredAspect, TeacherEffectBand>;
  candidateRecallEffects: Record<ScoredAspect, TeacherEffectBand>;
  selectionRetentionEffects: Record<ScoredAspect, TeacherEffectBand>;
  lessonIds: TeacherExperimentLessonId[];
  recommendedActions: TeacherActionId[];
}

export interface PrivateTeacherCandidateTrial {
  candidateHash: string;
  family: TeacherExperimentFamily;
  assessment: PrivateTeacherAssessment;
}

interface MutableCounts {
  scoredCaseCount: number;
  goldTermCount: number;
  candidateTermCount: number;
  selectedTermCount: number;
  candidateTruePositiveCount: number;
  selectedTruePositiveCount: number;
  directCandidateTruePositiveCount: number;
  ancestorCandidateTruePositiveCount: number;
  unattributedCandidateTruePositiveCount: number;
  directSelectedTruePositiveCount: number;
  ancestorSelectedTruePositiveCount: number;
  unattributedSelectedTruePositiveCount: number;
  phylogenyAppliedCandidateTermCount: number;
  phylogenyAppliedSelectedTermCount: number;
  machineBlockerLossCounts: Record<TeacherMachineBlocker, number>;
  originUse: Record<TeacherOrigin, TeacherUseCounts>;
  providerUse: Record<TeacherProvider, TeacherUseCounts>;
  candidateSourceUse: Record<TeacherCandidateSource, TeacherUseCounts>;
}

const GO_ID = /^GO:\d{7}$/;
const FOLDED_SELECTOR_BLOCKERS = [
  "per_aspect_budget",
  "judge_candidate_budget",
  "source_hypothesis_not_selected",
] as const;
const SELECTION_BLOCKERS = new Set<string>([
  ...TEACHER_MACHINE_BLOCKERS.filter((item) => item !== "selector_cap_or_unattributed"),
  ...FOLDED_SELECTOR_BLOCKERS,
]);

function emptyUseCounts(): TeacherUseCounts {
  return { candidateTermCount: 0, selectedTermCount: 0, candidateTruePositiveCount: 0, selectedTruePositiveCount: 0 };
}

function keyedRecord<K extends string, V>(keys: readonly K[], make: () => V): Record<K, V> {
  return Object.fromEntries(keys.map((key) => [key, make()])) as Record<K, V>;
}

function emptyCounts(): MutableCounts {
  return {
    scoredCaseCount: 0,
    goldTermCount: 0,
    candidateTermCount: 0,
    selectedTermCount: 0,
    candidateTruePositiveCount: 0,
    selectedTruePositiveCount: 0,
    directCandidateTruePositiveCount: 0,
    ancestorCandidateTruePositiveCount: 0,
    unattributedCandidateTruePositiveCount: 0,
    directSelectedTruePositiveCount: 0,
    ancestorSelectedTruePositiveCount: 0,
    unattributedSelectedTruePositiveCount: 0,
    phylogenyAppliedCandidateTermCount: 0,
    phylogenyAppliedSelectedTermCount: 0,
    machineBlockerLossCounts: keyedRecord(TEACHER_MACHINE_BLOCKERS, () => 0),
    originUse: keyedRecord(TEACHER_ORIGINS, emptyUseCounts),
    providerUse: keyedRecord(TEACHER_PROVIDERS, emptyUseCounts),
    candidateSourceUse: keyedRecord(TEACHER_CANDIDATE_SOURCES, emptyUseCounts),
  };
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function isCandidate(term: GOTermPrediction): boolean {
  return [term.fusionAdjustedScore, term.judgeAdjustedScore, term.phylogenyAdjustedScore, term.rawScore]
    .some((score) => typeof score === "number" && Number.isFinite(score) && score > 0);
}

function scored(target: PrivateBenchmarkTarget, aspect: ScoredAspect): boolean {
  return target.scoredAspects ? target.scoredAspects.includes(aspect) : target.gold[aspect].length > 0;
}

function origin(term: GOTermPrediction): TeacherOrigin {
  if (term.candidateOrigin) return term.candidateOrigin;
  if ((term.ontologyDepth ?? 0) > 0) return "ontology_ancestor";
  if (term.donorSupports.some((support) => support.candidateSourceType !== undefined)) return "direct_candidate_source";
  // Legacy direct-transfer artifacts omitted candidateOrigin when both the
  // ontology and external candidate providers were disabled. Their ordinary
  // annotation supports are still unambiguously direct evidence.
  return term.donorSupports.length > 0 ? "direct_annotation" : "unattributed";
}

function providers(term: GOTermPrediction): TeacherProvider[] {
  const values = [...new Set(term.donorSupports.map((support) => support.sourceProvider).filter(
    (provider): provider is Exclude<TeacherProvider, "unattributed"> => provider !== undefined,
  ))].sort();
  return values.length > 0 ? values : ["unattributed"];
}

function candidateSources(term: GOTermPrediction): TeacherCandidateSource[] {
  const values = [...new Set(term.donorSupports.map((support) => support.candidateSourceType).filter(
    (source): source is Exclude<TeacherCandidateSource, "unattributed"> => source !== undefined,
  ))].sort();
  return values.length > 0 ? values : ["unattributed"];
}

function hasAppliedPhylogeny(term: GOTermPrediction): boolean {
  // Orthology is a source class, not proof that target-species/lineage
  // context was actually applied. Missing-taxon or disabled-policy OMA terms
  // retain lineageStatus=unavailable and must not inflate this signal.
  return term.donorSupports.some((support) => support.lineageStatus === "applied");
}

function primaryBlocker(term: GOTermPrediction): TeacherMachineBlocker {
  const blockers = new Set(term.selectionBlockers ?? []);
  return TEACHER_MACHINE_BLOCKERS.find((blocker) => blocker !== "selector_cap_or_unattributed" && blockers.has(blocker))
    ?? "selector_cap_or_unattributed";
}

function recordUse(
  use: TeacherUseCounts,
  input: { selected: boolean; truePositive: boolean },
): void {
  use.candidateTermCount += 1;
  if (input.selected) use.selectedTermCount += 1;
  if (input.truePositive) use.candidateTruePositiveCount += 1;
  if (input.selected && input.truePositive) use.selectedTruePositiveCount += 1;
}

function addTerm(counts: MutableCounts, term: GOTermPrediction, gold: ReadonlySet<string>): void {
  if (!isCandidate(term)) return;
  const truePositive = gold.has(term.goId);
  counts.candidateTermCount += 1;
  if (term.selected) counts.selectedTermCount += 1;
  if (truePositive) counts.candidateTruePositiveCount += 1;
  if (truePositive && term.selected) counts.selectedTruePositiveCount += 1;

  const termOrigin = origin(term);
  recordUse(counts.originUse[termOrigin], { selected: term.selected, truePositive });
  for (const provider of providers(term)) recordUse(counts.providerUse[provider], { selected: term.selected, truePositive });
  for (const source of candidateSources(term)) recordUse(counts.candidateSourceUse[source], { selected: term.selected, truePositive });

  if (hasAppliedPhylogeny(term)) {
    counts.phylogenyAppliedCandidateTermCount += 1;
    if (term.selected) counts.phylogenyAppliedSelectedTermCount += 1;
  }
  if (!truePositive) return;
  const candidateKey = termOrigin === "ontology_ancestor" ? "ancestorCandidateTruePositiveCount"
    : termOrigin === "unattributed" ? "unattributedCandidateTruePositiveCount"
      : "directCandidateTruePositiveCount";
  counts[candidateKey] += 1;
  if (term.selected) {
    const selectedKey = termOrigin === "ontology_ancestor" ? "ancestorSelectedTruePositiveCount"
      : termOrigin === "unattributed" ? "unattributedSelectedTruePositiveCount"
        : "directSelectedTruePositiveCount";
    counts[selectedKey] += 1;
  } else {
    counts.machineBlockerLossCounts[primaryBlocker(term)] += 1;
  }
}

function finalize(counts: MutableCounts): PrivateTeacherAspectAssessment {
  const lostCandidateTruePositiveCount = counts.candidateTruePositiveCount - counts.selectedTruePositiveCount;
  return {
    scoredCaseCount: counts.scoredCaseCount,
    goldTermCount: counts.goldTermCount,
    candidateTermCount: counts.candidateTermCount,
    selectedTermCount: counts.selectedTermCount,
    candidateTruePositiveCount: counts.candidateTruePositiveCount,
    selectedTruePositiveCount: counts.selectedTruePositiveCount,
    candidateFalsePositiveCount: counts.candidateTermCount - counts.candidateTruePositiveCount,
    selectedFalsePositiveCount: counts.selectedTermCount - counts.selectedTruePositiveCount,
    candidateFalseNegativeCount: counts.goldTermCount - counts.candidateTruePositiveCount,
    selectedFalseNegativeCount: counts.goldTermCount - counts.selectedTruePositiveCount,
    directCandidateTruePositiveCount: counts.directCandidateTruePositiveCount,
    ancestorCandidateTruePositiveCount: counts.ancestorCandidateTruePositiveCount,
    unattributedCandidateTruePositiveCount: counts.unattributedCandidateTruePositiveCount,
    directSelectedTruePositiveCount: counts.directSelectedTruePositiveCount,
    ancestorSelectedTruePositiveCount: counts.ancestorSelectedTruePositiveCount,
    unattributedSelectedTruePositiveCount: counts.unattributedSelectedTruePositiveCount,
    lostCandidateTruePositiveCount,
    phylogenyAppliedCandidateTermCount: counts.phylogenyAppliedCandidateTermCount,
    phylogenyAppliedSelectedTermCount: counts.phylogenyAppliedSelectedTermCount,
    candidatePrecisionProxy: safeRatio(counts.candidateTruePositiveCount, counts.candidateTermCount),
    selectedPrecisionProxy: safeRatio(counts.selectedTruePositiveCount, counts.selectedTermCount),
    candidateRecallCeiling: safeRatio(counts.candidateTruePositiveCount, counts.goldTermCount),
    selectedRecall: safeRatio(counts.selectedTruePositiveCount, counts.goldTermCount),
    truePositiveSelectionRetention: safeRatio(counts.selectedTruePositiveCount, counts.candidateTruePositiveCount),
    candidateSelectionRate: safeRatio(counts.selectedTermCount, counts.candidateTermCount),
    directCandidateTruePositiveFraction: safeRatio(counts.directCandidateTruePositiveCount, counts.candidateTruePositiveCount),
    phylogenyCandidateUseFraction: safeRatio(counts.phylogenyAppliedCandidateTermCount, counts.candidateTermCount),
    machineBlockerLossCounts: structuredClone(counts.machineBlockerLossCounts),
    originUse: structuredClone(counts.originUse),
    providerUse: structuredClone(counts.providerUse),
    candidateSourceUse: structuredClone(counts.candidateSourceUse),
  };
}

function addAssessmentCounts(target: MutableCounts, source: PrivateTeacherAspectAssessment): void {
  for (const key of [
    "scoredCaseCount", "goldTermCount", "candidateTermCount", "selectedTermCount",
    "candidateTruePositiveCount", "selectedTruePositiveCount", "directCandidateTruePositiveCount",
    "ancestorCandidateTruePositiveCount", "unattributedCandidateTruePositiveCount",
    "directSelectedTruePositiveCount", "ancestorSelectedTruePositiveCount",
    "unattributedSelectedTruePositiveCount", "phylogenyAppliedCandidateTermCount",
    "phylogenyAppliedSelectedTermCount",
  ] as const) target[key] += source[key];
  for (const blocker of TEACHER_MACHINE_BLOCKERS) target.machineBlockerLossCounts[blocker] += source.machineBlockerLossCounts[blocker];
  for (const originId of TEACHER_ORIGINS) addUse(target.originUse[originId], source.originUse[originId]);
  for (const provider of TEACHER_PROVIDERS) addUse(target.providerUse[provider], source.providerUse[provider]);
  for (const sourceId of TEACHER_CANDIDATE_SOURCES) addUse(target.candidateSourceUse[sourceId], source.candidateSourceUse[sourceId]);
}

function causalSignalFromAttribution(
  attribution: RsiErrorAttribution,
  aspect?: ScoredAspect,
): PrivateTeacherCausalSignal {
  if (aspect) {
    const summary = attribution.aspects[aspect];
    return {
      failureStageCounts: structuredClone(summary.failureStageCounts),
      failureStageDistinctCaseCounts: structuredClone(summary.failureStageDistinctCaseCounts),
      selectedFalsePositiveDistinctCaseCount: new Set(
        summary.selectedFalsePositives.map((item) => item.caseId),
      ).size,
    };
  }
  const failureStageCounts = keyedRecord(RSI_FAILURE_STAGES, () => 0);
  const affectedCases = keyedRecord(RSI_FAILURE_STAGES, () => new Set<string>());
  const selectedFalsePositiveCases = new Set<string>();
  for (const item of attribution.cases) {
    for (const scoredAspect of BENCHMARK_GO_ASPECTS) {
      const row = item.aspects[scoredAspect];
      if (!row.scored) continue;
      for (const missing of row.missingGold) {
        failureStageCounts[missing.earliestFailureStage] += 1;
        affectedCases[missing.earliestFailureStage].add(item.caseId);
      }
      if (row.selectedFalsePositiveGoIds.length > 0) selectedFalsePositiveCases.add(item.caseId);
    }
  }
  return {
    failureStageCounts,
    failureStageDistinctCaseCounts: Object.fromEntries(RSI_FAILURE_STAGES.map((stage) => [
      stage,
      affectedCases[stage].size,
    ])) as Record<RsiFailureStage, number>,
    selectedFalsePositiveDistinctCaseCount: selectedFalsePositiveCases.size,
  };
}

/** Deterministic private projection consumed by the Teacher causal trace. */
export function privateTeacherCausalTraceFromAttribution(value: unknown): PrivateTeacherCausalTrace {
  const attribution = assertRsiErrorAttribution(value);
  return {
    aspects: {
      molecular_function: causalSignalFromAttribution(attribution, "molecular_function"),
      biological_process: causalSignalFromAttribution(attribution, "biological_process"),
      cellular_component: causalSignalFromAttribution(attribution, "cellular_component"),
    },
    overall: causalSignalFromAttribution(attribution),
  };
}

/**
 * Bind a persisted Teacher assessment to the exact per-case gold error trace
 * from which its causal diagnosis was derived. Both artifacts remain private.
 */
export function assertPrivateTeacherAssessmentAttributionBinding(input: {
  assessment: unknown;
  attribution: unknown;
}): { assessment: PrivateTeacherAssessment; attribution: RsiErrorAttribution } {
  const assessment = assertPrivateTeacherAssessment(input.assessment);
  const attribution = assertRsiErrorAttribution(input.attribution);
  const expected = privateTeacherCausalTraceFromAttribution(attribution);
  if (assessment.caseCount !== attribution.caseCount
    || canonicalJson(assessment.causalTrace) !== canonicalJson(expected)) {
    throw new Error("private teacher assessment causal trace is not bound to its RSI error attribution");
  }
  const bindCounts = (scope: PrivateTeacherAspectAssessment, counts: {
    scoredCaseCount: number;
    goldCount: number;
    selectedCount: number;
    truePositiveCount: number;
    falsePositiveCount: number;
    falseNegativeCount: number;
    candidateTruePositiveCount: number;
  }, label: string): void => {
    const candidateFalseNegativeCount = counts.goldCount - counts.candidateTruePositiveCount;
    const candidateRecallCeiling = safeRatio(counts.candidateTruePositiveCount, counts.goldCount);
    if (scope.scoredCaseCount !== counts.scoredCaseCount
      || scope.goldTermCount !== counts.goldCount
      || scope.selectedTermCount !== counts.selectedCount
      || scope.selectedTruePositiveCount !== counts.truePositiveCount
      || scope.selectedFalsePositiveCount !== counts.falsePositiveCount
      || scope.selectedFalseNegativeCount !== counts.falseNegativeCount
      || scope.candidateTruePositiveCount !== counts.candidateTruePositiveCount
      || scope.candidateFalseNegativeCount !== candidateFalseNegativeCount
      || scope.lostCandidateTruePositiveCount !== counts.candidateTruePositiveCount - counts.truePositiveCount
      || Math.abs(scope.candidateRecallCeiling - candidateRecallCeiling) > 1e-12
      || Math.abs(scope.selectedRecall - safeRatio(counts.truePositiveCount, counts.goldCount)) > 1e-12
      || Math.abs(scope.selectedPrecisionProxy - safeRatio(counts.truePositiveCount, counts.selectedCount)) > 1e-12) {
      throw new Error(`private teacher assessment ${label} exact-score counts are not bound to its RSI error attribution`);
    }
  };
  for (const aspect of BENCHMARK_GO_ASPECTS) bindCounts(assessment.aspects[aspect], attribution.aspects[aspect], aspect);
  bindCounts(assessment.overall, {
    scoredCaseCount: BENCHMARK_GO_ASPECTS.reduce((sum, aspect) => sum + attribution.aspects[aspect].scoredCaseCount, 0),
    goldCount: BENCHMARK_GO_ASPECTS.reduce((sum, aspect) => sum + attribution.aspects[aspect].goldCount, 0),
    selectedCount: BENCHMARK_GO_ASPECTS.reduce((sum, aspect) => sum + attribution.aspects[aspect].selectedCount, 0),
    truePositiveCount: BENCHMARK_GO_ASPECTS.reduce((sum, aspect) => sum + attribution.aspects[aspect].truePositiveCount, 0),
    falsePositiveCount: BENCHMARK_GO_ASPECTS.reduce((sum, aspect) => sum + attribution.aspects[aspect].falsePositiveCount, 0),
    falseNegativeCount: BENCHMARK_GO_ASPECTS.reduce((sum, aspect) => sum + attribution.aspects[aspect].falseNegativeCount, 0),
    candidateTruePositiveCount: BENCHMARK_GO_ASPECTS.reduce((sum, aspect) => sum + attribution.aspects[aspect].candidateTruePositiveCount, 0),
  }, "overall");
  return { assessment, attribution };
}

function addUse(target: TeacherUseCounts, source: TeacherUseCounts): void {
  target.candidateTermCount += source.candidateTermCount;
  target.selectedTermCount += source.selectedTermCount;
  target.candidateTruePositiveCount += source.candidateTruePositiveCount;
  target.selectedTruePositiveCount += source.selectedTruePositiveCount;
}

function assertInput(targets: readonly PrivateBenchmarkTarget[], predictions: ReadonlyMap<string, GOPredictionSet>): void {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("teacher assessment requires at least one private target");
  const caseIds = new Set<string>();
  for (const target of targets) {
    if (!target || typeof target !== "object" || typeof target.caseId !== "string" || target.caseId.trim() === "") {
      throw new Error("private teacher target has an invalid caseId");
    }
    if (caseIds.has(target.caseId)) throw new Error(`duplicate private teacher caseId: ${target.caseId}`);
    caseIds.add(target.caseId);
    if (!target.gold || typeof target.gold !== "object") throw new Error(`private teacher target ${target.caseId} has no gold record`);
    const scoredAspects: readonly ScoredAspect[] = target.scoredAspects
      ?? BENCHMARK_GO_ASPECTS.filter((aspect) => target.gold[aspect].length > 0);
    if (new Set(scoredAspects).size !== scoredAspects.length
      || scoredAspects.some((aspect) => !(BENCHMARK_GO_ASPECTS as readonly string[]).includes(aspect))) {
      throw new Error(`private teacher target ${target.caseId} has invalid scored aspects`);
    }
    for (const aspect of BENCHMARK_GO_ASPECTS) {
      const values = target.gold[aspect];
      if (!Array.isArray(values) || values.some((goId) => typeof goId !== "string" || !GO_ID.test(goId))) {
        throw new Error(`private teacher target ${target.caseId} has invalid gold GO terms`);
      }
      if (new Set(values).size !== values.length) throw new Error(`private teacher target ${target.caseId} has duplicate gold GO terms`);
    }
  }
  if (predictions.size !== caseIds.size || [...predictions.keys()].some((caseId) => !caseIds.has(caseId))) {
    throw new Error("private teacher predictions must exactly cover the target cases");
  }
  for (const [caseId, prediction] of predictions) {
    if (!prediction || prediction.proteinId !== caseId || !Array.isArray(prediction.terms)) {
      throw new Error(`private teacher prediction binding mismatch for ${caseId}`);
    }
    const termKeys = new Set<string>();
    for (const term of prediction.terms) {
      if (!term || !GO_ID.test(term.goId)
        || ![...BENCHMARK_GO_ASPECTS, "unknown"].includes(term.aspect)) {
        throw new Error(`private teacher prediction ${caseId} contains an invalid GO term`);
      }
      const termKey = `${term.aspect}\u0000${term.goId}`;
      if (termKeys.has(termKey)) throw new Error(`private teacher prediction ${caseId} contains a duplicate GO term`);
      termKeys.add(termKey);
      if (typeof term.selected !== "boolean" || !Array.isArray(term.donorSupports)) {
        throw new Error(`private teacher prediction ${caseId} contains an invalid candidate`);
      }
      for (const score of [term.rawScore, term.phylogenyAdjustedScore, term.judgeAdjustedScore, term.fusionAdjustedScore]) {
        if (score !== null && score !== undefined && (!Number.isFinite(score) || score < 0 || score > 1)) {
          throw new Error(`private teacher prediction ${caseId} contains an invalid candidate score`);
        }
      }
      if (term.selected && !isCandidate(term)) throw new Error(`private teacher prediction ${caseId} selected a non-candidate term`);
      if (term.candidateOrigin !== undefined && !(TEACHER_ORIGINS as readonly string[]).includes(term.candidateOrigin)) {
        throw new Error(`private teacher prediction ${caseId} contains an invalid candidate origin`);
      }
      if (term.selectionBlockers?.some((blocker) => !SELECTION_BLOCKERS.has(blocker))) {
        throw new Error(`private teacher prediction ${caseId} contains an invalid selection blocker`);
      }
      for (const support of term.donorSupports) assertSupport(support, caseId);
    }
  }
}

function assertSupport(support: GODonorSupport, caseId: string): void {
  if (!support || typeof support !== "object") throw new Error(`private teacher prediction ${caseId} has an invalid donor support`);
  if (support.sourceProvider !== undefined && !(TEACHER_PROVIDERS as readonly string[]).includes(support.sourceProvider)) {
    throw new Error(`private teacher prediction ${caseId} has an invalid source provider`);
  }
  if (support.candidateSourceType !== undefined
    && !(TEACHER_CANDIDATE_SOURCES as readonly string[]).includes(support.candidateSourceType)) {
    throw new Error(`private teacher prediction ${caseId} has an invalid candidate source`);
  }
  if (support.lineageStatus !== "applied" && support.lineageStatus !== "unavailable") {
    throw new Error(`private teacher prediction ${caseId} has an invalid lineage status`);
  }
}

/** Build the exact private teacher view. This function performs no I/O. */
export function buildPrivateTeacherAssessment(input: {
  targets: readonly PrivateBenchmarkTarget[];
  predictions: ReadonlyMap<string, GOPredictionSet>;
}): PrivateTeacherAssessment {
  assertInput(input.targets, input.predictions);
  const attribution = buildRsiErrorAttribution(input.targets, input.predictions);
  const aspects = keyedRecord(BENCHMARK_GO_ASPECTS, () => emptyCounts());
  for (const target of [...input.targets].sort((left, right) => left.caseId.localeCompare(right.caseId))) {
    const prediction = input.predictions.get(target.caseId)!;
    for (const aspect of BENCHMARK_GO_ASPECTS) {
      if (!scored(target, aspect)) continue;
      const counts = aspects[aspect];
      counts.scoredCaseCount += 1;
      const gold = new Set(target.gold[aspect]);
      counts.goldTermCount += gold.size;
      for (const term of prediction.terms.filter((candidate) => candidate.aspect === aspect)) addTerm(counts, term, gold);
    }
  }
  const finalizedAspects = {
    molecular_function: finalize(aspects.molecular_function),
    biological_process: finalize(aspects.biological_process),
    cellular_component: finalize(aspects.cellular_component),
  };
  const overallCounts = emptyCounts();
  for (const aspect of BENCHMARK_GO_ASPECTS) addAssessmentCounts(overallCounts, finalizedAspects[aspect]);
  const content = {
    schemaVersion: "pi-private-teacher-assessment.v2" as const,
    candidateDefinition: "positive_finite_judge_phylogeny_or_raw_score" as const,
    aspectMaskPolicy: "explicit_scored_aspects_else_nonempty_gold" as const,
    causalTracePolicy: "earliest_observable_machine_checkpoint_v1" as const,
    caseCount: input.targets.length,
    aspects: finalizedAspects,
    overall: finalize(overallCounts),
    causalTrace: privateTeacherCausalTraceFromAttribution(attribution),
  };
  const assessment = { ...content, canonicalHash: hashCanonical(content) };
  return assertPrivateTeacherAssessment(assessment);
}

const ASSESSMENT_KEYS = ["schemaVersion", "candidateDefinition", "aspectMaskPolicy", "causalTracePolicy", "caseCount", "aspects", "overall", "causalTrace", "canonicalHash"] as const;
const ASPECT_KEYS = [
  "scoredCaseCount", "goldTermCount", "candidateTermCount", "selectedTermCount", "candidateTruePositiveCount",
  "selectedTruePositiveCount", "candidateFalsePositiveCount", "selectedFalsePositiveCount", "candidateFalseNegativeCount",
  "selectedFalseNegativeCount", "directCandidateTruePositiveCount", "ancestorCandidateTruePositiveCount",
  "unattributedCandidateTruePositiveCount", "directSelectedTruePositiveCount", "ancestorSelectedTruePositiveCount",
  "unattributedSelectedTruePositiveCount", "lostCandidateTruePositiveCount", "phylogenyAppliedCandidateTermCount",
  "phylogenyAppliedSelectedTermCount", "candidatePrecisionProxy", "selectedPrecisionProxy", "candidateRecallCeiling",
  "selectedRecall", "truePositiveSelectionRetention", "candidateSelectionRate", "directCandidateTruePositiveFraction",
  "phylogenyCandidateUseFraction", "machineBlockerLossCounts", "originUse", "providerUse", "candidateSourceUse",
] as const;
const USE_KEYS = ["candidateTermCount", "selectedTermCount", "candidateTruePositiveCount", "selectedTruePositiveCount"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has an invalid field set`);
}

function nonnegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer`);
}

function finiteRatio(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a finite ratio`);
}

function assertUseRecord<K extends string>(
  value: unknown,
  keys: readonly K[],
  label: string,
): asserts value is Record<K, TeacherUseCounts> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, keys, label);
  for (const key of keys) {
    const item = value[key];
    if (!isRecord(item)) throw new Error(`${label}.${key} must be an object`);
    exactKeys(item, USE_KEYS, `${label}.${key}`);
    for (const countKey of USE_KEYS) nonnegativeInteger(item[countKey], `${label}.${key}.${countKey}`);
    if ((item.selectedTermCount as number) > (item.candidateTermCount as number)
      || (item.candidateTruePositiveCount as number) > (item.candidateTermCount as number)
      || (item.selectedTruePositiveCount as number) > (item.selectedTermCount as number)
      || (item.selectedTruePositiveCount as number) > (item.candidateTruePositiveCount as number)) {
      throw new Error(`${label}.${key} violates use-count invariants`);
    }
  }
}

function assertUseRecordWithinTotals<K extends string>(
  value: Record<K, TeacherUseCounts>,
  keys: readonly K[],
  totals: Pick<PrivateTeacherAspectAssessment,
    "candidateTermCount" | "selectedTermCount" | "candidateTruePositiveCount" | "selectedTruePositiveCount">,
  label: string,
): void {
  for (const key of keys) {
    const item = value[key];
    if (item.candidateTermCount > totals.candidateTermCount
      || item.selectedTermCount > totals.selectedTermCount
      || item.candidateTruePositiveCount > totals.candidateTruePositiveCount
      || item.selectedTruePositiveCount > totals.selectedTruePositiveCount) {
      throw new Error(`${label}.${key} exceeds the corresponding assessment total`);
    }
  }
}

function assessmentCounts(value: PrivateTeacherAspectAssessment): MutableCounts {
  return {
    scoredCaseCount: value.scoredCaseCount,
    goldTermCount: value.goldTermCount,
    candidateTermCount: value.candidateTermCount,
    selectedTermCount: value.selectedTermCount,
    candidateTruePositiveCount: value.candidateTruePositiveCount,
    selectedTruePositiveCount: value.selectedTruePositiveCount,
    directCandidateTruePositiveCount: value.directCandidateTruePositiveCount,
    ancestorCandidateTruePositiveCount: value.ancestorCandidateTruePositiveCount,
    unattributedCandidateTruePositiveCount: value.unattributedCandidateTruePositiveCount,
    directSelectedTruePositiveCount: value.directSelectedTruePositiveCount,
    ancestorSelectedTruePositiveCount: value.ancestorSelectedTruePositiveCount,
    unattributedSelectedTruePositiveCount: value.unattributedSelectedTruePositiveCount,
    phylogenyAppliedCandidateTermCount: value.phylogenyAppliedCandidateTermCount,
    phylogenyAppliedSelectedTermCount: value.phylogenyAppliedSelectedTermCount,
    machineBlockerLossCounts: structuredClone(value.machineBlockerLossCounts),
    originUse: structuredClone(value.originUse),
    providerUse: structuredClone(value.providerUse),
    candidateSourceUse: structuredClone(value.candidateSourceUse),
  };
}

function assertAspectAssessment(value: unknown, label: string): asserts value is PrivateTeacherAspectAssessment {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, ASPECT_KEYS, label);
  for (const key of ASPECT_KEYS.slice(0, 19)) nonnegativeInteger(value[key], `${label}.${key}`);
  for (const key of ASPECT_KEYS.slice(19, 27)) finiteRatio(value[key], `${label}.${key}`);
  if (!isRecord(value.machineBlockerLossCounts)) throw new Error(`${label}.machineBlockerLossCounts must be an object`);
  exactKeys(value.machineBlockerLossCounts, TEACHER_MACHINE_BLOCKERS, `${label}.machineBlockerLossCounts`);
  for (const blocker of TEACHER_MACHINE_BLOCKERS) nonnegativeInteger(value.machineBlockerLossCounts[blocker], `${label}.${blocker}`);
  assertUseRecord(value.originUse, TEACHER_ORIGINS, `${label}.originUse`);
  assertUseRecord(value.providerUse, TEACHER_PROVIDERS, `${label}.providerUse`);
  assertUseRecord(value.candidateSourceUse, TEACHER_CANDIDATE_SOURCES, `${label}.candidateSourceUse`);
  const typed = value as unknown as PrivateTeacherAspectAssessment;
  const expected = finalize(assessmentCounts(typed));
  if (canonicalJson(expected) !== canonicalJson(typed)) throw new Error(`${label} violates derived aggregate invariants`);
  const blockerLossTotal = TEACHER_MACHINE_BLOCKERS.reduce((sum, blocker) => sum + typed.machineBlockerLossCounts[blocker], 0);
  if (blockerLossTotal !== typed.lostCandidateTruePositiveCount) throw new Error(`${label} blocker losses do not partition lost true positives`);
  const originCandidateTotal = TEACHER_ORIGINS.reduce((sum, item) => sum + typed.originUse[item].candidateTermCount, 0);
  const originSelectedTotal = TEACHER_ORIGINS.reduce((sum, item) => sum + typed.originUse[item].selectedTermCount, 0);
  if (originCandidateTotal !== typed.candidateTermCount || originSelectedTotal !== typed.selectedTermCount) {
    throw new Error(`${label} origin-use counts do not partition candidates`);
  }
  const directCandidateTruePositiveCount = typed.originUse.direct_annotation.candidateTruePositiveCount
    + typed.originUse.direct_candidate_source.candidateTruePositiveCount;
  const directSelectedTruePositiveCount = typed.originUse.direct_annotation.selectedTruePositiveCount
    + typed.originUse.direct_candidate_source.selectedTruePositiveCount;
  const originCandidateTruePositiveTotal = TEACHER_ORIGINS.reduce(
    (sum, item) => sum + typed.originUse[item].candidateTruePositiveCount,
    0,
  );
  const originSelectedTruePositiveTotal = TEACHER_ORIGINS.reduce(
    (sum, item) => sum + typed.originUse[item].selectedTruePositiveCount,
    0,
  );
  if (typed.directCandidateTruePositiveCount !== directCandidateTruePositiveCount
    || typed.ancestorCandidateTruePositiveCount !== typed.originUse.ontology_ancestor.candidateTruePositiveCount
    || typed.unattributedCandidateTruePositiveCount !== typed.originUse.unattributed.candidateTruePositiveCount
    || typed.directSelectedTruePositiveCount !== directSelectedTruePositiveCount
    || typed.ancestorSelectedTruePositiveCount !== typed.originUse.ontology_ancestor.selectedTruePositiveCount
    || typed.unattributedSelectedTruePositiveCount !== typed.originUse.unattributed.selectedTruePositiveCount
    || originCandidateTruePositiveTotal !== typed.candidateTruePositiveCount
    || originSelectedTruePositiveTotal !== typed.selectedTruePositiveCount) {
    throw new Error(`${label} true-positive origin decomposition is inconsistent`);
  }
  assertUseRecordWithinTotals(typed.providerUse, TEACHER_PROVIDERS, typed, `${label}.providerUse`);
  assertUseRecordWithinTotals(typed.candidateSourceUse, TEACHER_CANDIDATE_SOURCES, typed, `${label}.candidateSourceUse`);
}

const CAUSAL_SIGNAL_KEYS = [
  "failureStageCounts",
  "failureStageDistinctCaseCounts",
  "selectedFalsePositiveDistinctCaseCount",
] as const;

function assertPrivateCausalSignal(
  value: unknown,
  assessment: PrivateTeacherAspectAssessment,
  caseCount: number,
  label: string,
): asserts value is PrivateTeacherCausalSignal {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, CAUSAL_SIGNAL_KEYS, label);
  for (const field of ["failureStageCounts", "failureStageDistinctCaseCounts"] as const) {
    const record = value[field];
    if (!isRecord(record)) throw new Error(`${label}.${field} must be an object`);
    exactKeys(record, RSI_FAILURE_STAGES, `${label}.${field}`);
    for (const stage of RSI_FAILURE_STAGES) nonnegativeInteger(record[stage], `${label}.${field}.${stage}`);
  }
  nonnegativeInteger(value.selectedFalsePositiveDistinctCaseCount, `${label}.selectedFalsePositiveDistinctCaseCount`);
  const typed = value as unknown as PrivateTeacherCausalSignal;
  const failureTotal = RSI_FAILURE_STAGES.reduce((sum, stage) => sum + typed.failureStageCounts[stage], 0);
  if (failureTotal !== assessment.selectedFalseNegativeCount) {
    throw new Error(`${label} failure stages do not partition selected false negatives`);
  }
  for (const stage of RSI_FAILURE_STAGES) {
    if (typed.failureStageDistinctCaseCounts[stage] > typed.failureStageCounts[stage]
      || typed.failureStageDistinctCaseCounts[stage] > caseCount) {
      throw new Error(`${label}.${stage} distinct-case support is invalid`);
    }
  }
  if (typed.selectedFalsePositiveDistinctCaseCount > assessment.selectedFalsePositiveCount
    || typed.selectedFalsePositiveDistinctCaseCount > caseCount) {
    throw new Error(`${label} false-positive distinct-case support is invalid`);
  }
}

function assertPrivateCausalTrace(
  value: unknown,
  assessment: Pick<PrivateTeacherAssessment, "caseCount" | "aspects" | "overall">,
): asserts value is PrivateTeacherCausalTrace {
  if (!isRecord(value)) throw new Error("private teacher causal trace must be an object");
  exactKeys(value, ["aspects", "overall"], "private teacher causal trace");
  if (!isRecord(value.aspects)) throw new Error("private teacher causal trace aspects must be an object");
  exactKeys(value.aspects, BENCHMARK_GO_ASPECTS, "private teacher causal trace aspects");
  for (const aspect of BENCHMARK_GO_ASPECTS) {
    assertPrivateCausalSignal(
      value.aspects[aspect],
      assessment.aspects[aspect],
      assessment.caseCount,
      `private teacher causal trace ${aspect}`,
    );
  }
  assertPrivateCausalSignal(
    value.overall,
    assessment.overall,
    assessment.caseCount,
    "private teacher causal trace overall",
  );
  const typed = value as unknown as PrivateTeacherCausalTrace;
  for (const stage of RSI_FAILURE_STAGES) {
    const aspectCount = BENCHMARK_GO_ASPECTS.reduce(
      (sum, aspect) => sum + typed.aspects[aspect].failureStageCounts[stage],
      0,
    );
    if (typed.overall.failureStageCounts[stage] !== aspectCount) {
      throw new Error(`private teacher causal trace overall ${stage} count does not aggregate aspects`);
    }
    const maximumAspectSupport = Math.max(...BENCHMARK_GO_ASPECTS.map(
      (aspect) => typed.aspects[aspect].failureStageDistinctCaseCounts[stage],
    ));
    const summedAspectSupport = BENCHMARK_GO_ASPECTS.reduce(
      (sum, aspect) => sum + typed.aspects[aspect].failureStageDistinctCaseCounts[stage],
      0,
    );
    if (typed.overall.failureStageDistinctCaseCounts[stage] < maximumAspectSupport
      || typed.overall.failureStageDistinctCaseCounts[stage] > summedAspectSupport) {
      throw new Error(`private teacher causal trace overall ${stage} distinct-case union is invalid`);
    }
  }
}

export function assertPrivateTeacherAssessment(value: unknown): PrivateTeacherAssessment {
  if (!isRecord(value)) throw new Error("private teacher assessment must be an object");
  exactKeys(value, ASSESSMENT_KEYS, "private teacher assessment");
  if (value.schemaVersion !== "pi-private-teacher-assessment.v2"
    || value.candidateDefinition !== "positive_finite_judge_phylogeny_or_raw_score"
    || value.aspectMaskPolicy !== "explicit_scored_aspects_else_nonempty_gold"
    || value.causalTracePolicy !== "earliest_observable_machine_checkpoint_v1") {
    throw new Error("private teacher assessment schema is unsupported");
  }
  nonnegativeInteger(value.caseCount, "private teacher assessment caseCount");
  if ((value.caseCount as number) < 1) throw new Error("private teacher assessment caseCount must be positive");
  if (!isRecord(value.aspects)) throw new Error("private teacher assessment aspects must be an object");
  exactKeys(value.aspects, BENCHMARK_GO_ASPECTS, "private teacher assessment aspects");
  for (const aspect of BENCHMARK_GO_ASPECTS) assertAspectAssessment(value.aspects[aspect], `private teacher assessment ${aspect}`);
  assertAspectAssessment(value.overall, "private teacher assessment overall");
  const typed = value as unknown as PrivateTeacherAssessment;
  assertPrivateCausalTrace(value.causalTrace, typed);
  const aggregate = emptyCounts();
  for (const aspect of BENCHMARK_GO_ASPECTS) addAssessmentCounts(aggregate, typed.aspects[aspect]);
  if (canonicalJson(finalize(aggregate)) !== canonicalJson(typed.overall)) throw new Error("private teacher overall aggregate mismatch");
  const { canonicalHash, ...content } = typed;
  if (typeof canonicalHash !== "string" || !/^[a-f0-9]{64}$/.test(canonicalHash) || canonicalHash !== hashCanonical(content)) {
    throw new Error("private teacher assessment canonical hash mismatch");
  }
  return typed;
}

function assertTriplet(value: ThresholdTriplet, label: string): void {
  for (const key of ["criticalUpperExclusive", "weakUpperExclusive", "adequateUpperExclusive"] as const) finiteRatio(value[key], `${label}.${key}`);
  if (!(value.criticalUpperExclusive < value.weakUpperExclusive && value.weakUpperExclusive < value.adequateUpperExclusive)) {
    throw new Error(`${label} thresholds must be strictly increasing`);
  }
}

export function assertTeacherPolicy(value: unknown): TeacherPolicy {
  if (!isRecord(value)) throw new Error("teacher policy must be an object");
  exactKeys(value, ["schemaVersion", "minimumScoredCasesPerSignal", "minimumAffectedCasesPerCausalSignal", "contrastFlatEpsilon", "actionResolutionPolicy", "absoluteCalibrationPolicy", "contrastiveLessonPolicy", "actionPriorityPolicy", "qualityThresholds", "blockerLossThresholds", "sourceDiversityThresholds", "causalActionOrder", "canonicalHash"], "teacher policy");
  if (value.schemaVersion !== "pi-teacher-policy.v5"
    || value.minimumScoredCasesPerSignal !== 2
    || value.minimumAffectedCasesPerCausalSignal !== 2
    || value.actionResolutionPolicy !== "material_actions_exclude_hold_v1"
    || value.absoluteCalibrationPolicy !== "retained_parent_aspect_localized_v2"
    || value.contrastiveLessonPolicy !== "evaluated_parent_trial_aspect_bands_v2"
    || value.actionPriorityPolicy !== "semantic_order_then_absolute_v1") {
    throw new Error("teacher policy schema is unsupported");
  }
  finiteRatio(value.contrastFlatEpsilon, "teacher policy contrast flat epsilon");
  if (value.contrastFlatEpsilon <= 0) throw new Error("teacher policy contrast flat epsilon must be positive");
  if (!isRecord(value.qualityThresholds)) throw new Error("teacher policy quality thresholds are invalid");
  exactKeys(value.qualityThresholds, ["candidateRecall", "candidatePurity", "selectedPrecision", "selectionRetention", "directCandidateSupport", "phylogenyContext"], "teacher policy quality thresholds");
  for (const key of Object.keys(value.qualityThresholds)) {
    const threshold = value.qualityThresholds[key];
    if (!isRecord(threshold)) throw new Error(`teacher policy ${key} threshold is invalid`);
    exactKeys(threshold, ["criticalUpperExclusive", "weakUpperExclusive", "adequateUpperExclusive"], `teacher policy ${key}`);
    assertTriplet(threshold as unknown as ThresholdTriplet, `teacher policy ${key}`);
  }
  if (!isRecord(value.blockerLossThresholds)) throw new Error("teacher policy blocker thresholds are invalid");
  exactKeys(value.blockerLossThresholds, ["lowUpperInclusive", "mediumUpperInclusive"], "teacher policy blocker thresholds");
  finiteRatio(value.blockerLossThresholds.lowUpperInclusive, "teacher policy blocker low threshold");
  finiteRatio(value.blockerLossThresholds.mediumUpperInclusive, "teacher policy blocker medium threshold");
  if (value.blockerLossThresholds.lowUpperInclusive >= value.blockerLossThresholds.mediumUpperInclusive) throw new Error("teacher policy blocker thresholds must increase");
  if (!isRecord(value.sourceDiversityThresholds)) throw new Error("teacher policy source-diversity thresholds are invalid");
  exactKeys(value.sourceDiversityThresholds, ["criticalMaximum", "weakMaximum", "adequateMaximum"], "teacher policy source-diversity thresholds");
  for (const key of ["criticalMaximum", "weakMaximum", "adequateMaximum"] as const) nonnegativeInteger(value.sourceDiversityThresholds[key], `teacher policy source ${key}`);
  const sourceThresholds = value.sourceDiversityThresholds as unknown as TeacherPolicy["sourceDiversityThresholds"];
  if (!(sourceThresholds.criticalMaximum < sourceThresholds.weakMaximum
    && sourceThresholds.weakMaximum < sourceThresholds.adequateMaximum)) {
    throw new Error("teacher policy source-diversity thresholds must increase");
  }
  if (!Array.isArray(value.causalActionOrder) || canonicalJson(value.causalActionOrder) !== canonicalJson(TEACHER_ACTION_IDS)) {
    throw new Error("teacher policy causal action catalog is invalid");
  }
  const typed = value as unknown as TeacherPolicy;
  const { canonicalHash, ...content } = typed;
  if (canonicalHash !== hashCanonical(content) || canonicalHash !== TEACHER_POLICY_HASH) throw new Error("teacher policy canonical hash mismatch");
  return typed;
}

export function teacherPolicy(): TeacherPolicy {
  return assertTeacherPolicy({ ...structuredClone(POLICY_CONTENT), canonicalHash: TEACHER_POLICY_HASH });
}

function qualityBand(value: number, thresholds: ThresholdTriplet): TeacherQualityBand {
  if (value < thresholds.criticalUpperExclusive) return "critical";
  if (value < thresholds.weakUpperExclusive) return "weak";
  if (value < thresholds.adequateUpperExclusive) return "adequate";
  return "strong";
}

function lossBand(value: number, policy: TeacherPolicy): TeacherLossBand {
  if (value === 0) return "none";
  if (value <= policy.blockerLossThresholds.lowUpperInclusive) return "low";
  if (value <= policy.blockerLossThresholds.mediumUpperInclusive) return "medium";
  return "high";
}

function sourceDiversityBand(value: PrivateTeacherAspectAssessment, policy: TeacherPolicy): TeacherQualityBand {
  const active = TEACHER_PROVIDERS.filter((provider) => provider !== "unattributed" && value.providerUse[provider].candidateTermCount > 0).length
    + (value.originUse.direct_annotation.candidateTermCount > 0 ? 1 : 0);
  if (active <= policy.sourceDiversityThresholds.criticalMaximum) return "critical";
  if (active <= policy.sourceDiversityThresholds.weakMaximum) return "weak";
  if (active <= policy.sourceDiversityThresholds.adequateMaximum) return "adequate";
  return "strong";
}

function weak(band: TeacherQualityBand): boolean {
  return band === "critical" || band === "weak";
}

const PUBLIC_CAUSAL_STAGES = [
  "label_coverage",
  "evidence_gate",
  "score_gate",
  "judge_gate",
  "selector_gate",
] as const satisfies readonly RsiFailureStage[];

function causalBands(
  value: PrivateTeacherAspectAssessment,
  trace: PrivateTeacherCausalSignal,
  policy: TeacherPolicy,
): Pick<TeacherSignal, "earliestFailureStage" | "failureBurden" | "selectionOverbreadth"> {
  const supported = PUBLIC_CAUSAL_STAGES.filter((stage) => (
    trace.failureStageCounts[stage] > 0
      && trace.failureStageDistinctCaseCounts[stage] >= policy.minimumAffectedCasesPerCausalSignal
  ));
  let earliestFailureStage: TeacherFailureStage;
  let failureBurden: TeacherLossBand;
  if (value.selectedFalseNegativeCount === 0) {
    earliestFailureStage = "no_detected_failure";
    failureBurden = "none";
  } else if (supported.length === 0) {
    earliestFailureStage = "suppressed";
    failureBurden = "suppressed";
  } else {
    const maximum = Math.max(...supported.map((stage) => trace.failureStageCounts[stage]));
    const dominant = supported.filter((stage) => trace.failureStageCounts[stage] === maximum);
    earliestFailureStage = dominant.length === 1 ? dominant[0] : "mixed";
    failureBurden = value.goldTermCount === 0 ? "not_evaluated" : lossBand(
      safeRatio(maximum, value.goldTermCount),
      policy,
    );
  }
  let selectionOverbreadth: TeacherLossBand;
  if (value.selectedTermCount === 0) {
    selectionOverbreadth = "not_evaluated";
  } else if (value.selectedFalsePositiveCount === 0) {
    selectionOverbreadth = "none";
  } else if (trace.selectedFalsePositiveDistinctCaseCount < policy.minimumAffectedCasesPerCausalSignal) {
    selectionOverbreadth = "suppressed";
  } else {
    selectionOverbreadth = lossBand(
      safeRatio(value.selectedFalsePositiveCount, value.selectedTermCount),
      policy,
    );
  }
  return { earliestFailureStage, failureBurden, selectionOverbreadth };
}

function signalDiagnoses(signal: Omit<TeacherSignal, "dominantLoss" | "diagnoses">): TeacherDiagnosisId[] {
  if (signal.sampleStatus === "suppressed") return ["small_sample_suppressed"];
  const diagnoses: TeacherDiagnosisId[] = [];
  if (weak(signal.candidateRecall)) diagnoses.push("candidate_recall_low");
  if (weak(signal.directCandidateSupport)) diagnoses.push("direct_candidates_sparse", "ancestor_dependence_high");
  if (weak(signal.phylogenyContext)) diagnoses.push("phylogeny_context_sparse");
  if (weak(signal.sourceDiversity)) diagnoses.push("source_diversity_low");
  if (weak(signal.candidatePurity)) diagnoses.push("candidate_purity_low");
  if (weak(signal.selectedPrecision)) diagnoses.push("selected_precision_low");
  if (weak(signal.selectionRetention)) diagnoses.push("selection_retention_low");
  if (signal.machineBlockerLoss === "medium" || signal.machineBlockerLoss === "high") diagnoses.push("machine_blocker_loss_high");
  if (signal.earliestFailureStage === "label_coverage") diagnoses.push("label_coverage_gap");
  if (signal.earliestFailureStage === "evidence_gate") diagnoses.push("evidence_gate_loss");
  if (signal.earliestFailureStage === "score_gate") diagnoses.push("score_gate_loss");
  if (signal.earliestFailureStage === "judge_gate") diagnoses.push("judge_gate_loss");
  if (signal.earliestFailureStage === "selector_gate") diagnoses.push("selector_gate_loss");
  if (signal.selectionOverbreadth === "medium" || signal.selectionOverbreadth === "high") {
    diagnoses.push("selection_overbreadth_high");
  }
  return diagnoses.length === 0 ? ["no_material_weakness"] : TEACHER_DIAGNOSIS_IDS.filter((item) => diagnoses.includes(item));
}

function dominantLoss(diagnoses: readonly TeacherDiagnosisId[]): TeacherDominantLoss {
  if (diagnoses.includes("small_sample_suppressed")) return "small_sample";
  if (diagnoses.includes("candidate_recall_low") || diagnoses.includes("label_coverage_gap")) return "candidate_generation";
  if (diagnoses.includes("direct_candidates_sparse") || diagnoses.includes("ancestor_dependence_high")) return "ancestor_only_specificity";
  if (diagnoses.includes("phylogeny_context_sparse")) return "phylogeny_context";
  if (diagnoses.includes("source_diversity_low")) return "source_correlation";
  if (diagnoses.includes("candidate_purity_low") || diagnoses.includes("selected_precision_low")
    || diagnoses.includes("selection_overbreadth_high")) return "candidate_impurity";
  if (diagnoses.includes("selection_retention_low") || diagnoses.includes("machine_blocker_loss_high")
    || diagnoses.includes("evidence_gate_loss") || diagnoses.includes("score_gate_loss")
    || diagnoses.includes("judge_gate_loss") || diagnoses.includes("selector_gate_loss")) return "selection_rejection";
  return "no_detected_loss";
}

function suppressedSignal(): TeacherSignal {
  return {
    sampleStatus: "suppressed",
    candidateRecall: "suppressed",
    candidatePurity: "suppressed",
    selectedPrecision: "suppressed",
    selectionRetention: "suppressed",
    directCandidateSupport: "suppressed",
    sourceDiversity: "suppressed",
    phylogenyContext: "suppressed",
    machineBlockerLoss: "suppressed",
    earliestFailureStage: "suppressed",
    failureBurden: "suppressed",
    selectionOverbreadth: "suppressed",
    dominantLoss: "small_sample",
    diagnoses: ["small_sample_suppressed"],
  };
}

function quantizeSignal(
  value: PrivateTeacherAspectAssessment,
  trace: PrivateTeacherCausalSignal,
  policy: TeacherPolicy,
): TeacherSignal {
  if (value.scoredCaseCount < policy.minimumScoredCasesPerSignal) return suppressedSignal();
  const candidateRecall = value.goldTermCount === 0 ? "not_evaluated" : qualityBand(value.candidateRecallCeiling, policy.qualityThresholds.candidateRecall);
  const candidatePurity = value.candidateTermCount === 0 ? "not_evaluated" : qualityBand(value.candidatePrecisionProxy, policy.qualityThresholds.candidatePurity);
  const selectedPrecision = value.selectedTermCount === 0 ? "not_evaluated" : qualityBand(value.selectedPrecisionProxy, policy.qualityThresholds.selectedPrecision);
  const selectionRetention = value.candidateTruePositiveCount === 0 ? "not_evaluated" : qualityBand(value.truePositiveSelectionRetention, policy.qualityThresholds.selectionRetention);
  const directCandidateSupport = value.candidateTruePositiveCount === 0 ? "not_evaluated" : qualityBand(value.directCandidateTruePositiveFraction, policy.qualityThresholds.directCandidateSupport);
  const phylogenyContext = value.candidateTermCount === 0 ? "not_evaluated" : qualityBand(value.phylogenyCandidateUseFraction, policy.qualityThresholds.phylogenyContext);
  const machineBlockerLoss = value.candidateTruePositiveCount === 0 ? "not_evaluated" : lossBand(
    safeRatio(value.lostCandidateTruePositiveCount, value.candidateTruePositiveCount),
    policy,
  );
  const partial = {
    sampleStatus: "sufficient" as const,
    candidateRecall,
    candidatePurity,
    selectedPrecision,
    selectionRetention,
    directCandidateSupport,
    sourceDiversity: sourceDiversityBand(value, policy),
    phylogenyContext,
    machineBlockerLoss,
    ...causalBands(value, trace, policy),
  };
  const diagnoses = signalDiagnoses(partial);
  return { ...partial, dominantLoss: dominantLoss(diagnoses), diagnoses };
}

const ACTION_DIAGNOSES: Readonly<Record<TeacherActionId, readonly TeacherDiagnosisId[]>> = {
  expand_direct_candidates: ["candidate_recall_low", "direct_candidates_sparse", "ancestor_dependence_high", "label_coverage_gap"],
  add_ontology_label_retriever: ["candidate_recall_low", "direct_candidates_sparse", "ancestor_dependence_high", "label_coverage_gap"],
  rerun_evidence_acquisition: ["label_coverage_gap", "evidence_gate_loss"],
  strengthen_phylogeny_context: ["candidate_recall_low", "phylogeny_context_sparse", "evidence_gate_loss"],
  decorrelate_sources: ["source_diversity_low", "candidate_purity_low"],
  activate_selective_candidates: ["candidate_recall_low", "candidate_purity_low"],
  apply_evidence_frontier: ["candidate_purity_low", "selected_precision_low"],
  tighten_selection_budget: ["selected_precision_low", "selection_overbreadth_high"],
  calibrate_mf_selection: [],
  calibrate_bp_selection: [],
  calibrate_cc_selection: [],
  // Retained in the closed vocabulary so older developer mappings remain
  // readable, but TeacherPolicy v4 never emits this ambiguous action. Absolute
  // coaching is localized to an explicit GO aspect below.
  calibrate_aspect_selection: [],
  hold_baseline: ["small_sample_suppressed", "no_material_weakness"],
};

export function coachingActionsForDiagnoses(
  diagnoses: readonly TeacherDiagnosisId[],
  policy: TeacherPolicy = teacherPolicy(),
): TeacherActionId[] {
  assertTeacherPolicy(policy);
  if (diagnoses.some((item) => !(TEACHER_DIAGNOSIS_IDS as readonly string[]).includes(item))) throw new Error("teacher diagnoses contain an invalid identifier");
  const material = diagnoses.some((item) => item !== "small_sample_suppressed" && item !== "no_material_weakness");
  return policy.causalActionOrder.filter((action) => {
    if (action === "hold_baseline") return !material;
    return ACTION_DIAGNOSES[action].some((diagnosis) => diagnoses.includes(diagnosis));
  });
}

function selectedF1(value: PrivateTeacherAspectAssessment): number {
  const precision = value.selectedPrecisionProxy;
  const recall = value.selectedRecall;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function contrastBand(
  parent: PrivateTeacherAspectAssessment,
  candidate: PrivateTeacherAspectAssessment,
  value: (assessment: PrivateTeacherAspectAssessment) => number,
  policy: TeacherPolicy,
): TeacherEffectBand {
  if (parent.scoredCaseCount < policy.minimumScoredCasesPerSignal
    || candidate.scoredCaseCount < policy.minimumScoredCasesPerSignal) return "suppressed";
  const delta = value(candidate) - value(parent);
  if (delta > policy.contrastFlatEpsilon) return "improved";
  if (delta < -policy.contrastFlatEpsilon) return "regressed";
  return "flat";
}

function canonicalEffects(
  parent: PrivateTeacherAssessment,
  candidate: PrivateTeacherAssessment,
  value: (assessment: PrivateTeacherAspectAssessment) => number,
  policy: TeacherPolicy,
): Record<ScoredAspect, TeacherEffectBand> {
  return {
    molecular_function: contrastBand(parent.aspects.molecular_function, candidate.aspects.molecular_function, value, policy),
    biological_process: contrastBand(parent.aspects.biological_process, candidate.aspects.biological_process, value, policy),
    cellular_component: contrastBand(parent.aspects.cellular_component, candidate.aspects.cellular_component, value, policy),
  };
}

const ASPECT_CALIBRATION_ACTION: Readonly<Record<ScoredAspect, TeacherActionId>> = {
  molecular_function: "calibrate_mf_selection",
  biological_process: "calibrate_bp_selection",
  cellular_component: "calibrate_cc_selection",
};

const ASPECT_CALIBRATION_DIAGNOSES = new Set<TeacherDiagnosisId>([
  "selected_precision_low",
  "selection_retention_low",
  "machine_blocker_loss_high",
  "score_gate_loss",
  "judge_gate_loss",
  "selector_gate_loss",
]);

function absoluteAspectCalibrationActions(
  aspects: Readonly<Record<ScoredAspect, TeacherSignal>>,
): TeacherActionId[] {
  return BENCHMARK_GO_ASPECTS
    .filter((aspect) => aspects[aspect].sampleStatus === "sufficient"
      && aspects[aspect].diagnoses.some((diagnosis) => ASPECT_CALIBRATION_DIAGNOSES.has(diagnosis)))
    .map((aspect) => ASPECT_CALIBRATION_ACTION[aspect]);
}

function lessonActions(
  ids: readonly TeacherExperimentLessonId[],
  aspectEffects: Readonly<Record<ScoredAspect, TeacherEffectBand>>,
): TeacherActionId[] {
  const actions: TeacherActionId[] = [];
  const add = (action: TeacherActionId): void => {
    if (!actions.includes(action)) actions.push(action);
  };
  // A cross-aspect rescue is the most specific causal signal: preserve the
  // helped branch instead of applying the same selector globally.
  if (ids.includes("selection_tradeoff_across_aspects") || ids.includes("selection_rescue_without_candidate_gain")) {
    for (const aspect of BENCHMARK_GO_ASPECTS) {
      if (aspectEffects[aspect] === "improved") add(ASPECT_CALIBRATION_ACTION[aspect]);
    }
  }
  if (ids.includes("candidate_expansion_hurt_selection")) {
    add("tighten_selection_budget");
    add("decorrelate_sources");
    add("apply_evidence_frontier");
  }
  if (ids.includes("candidate_recall_not_improved")) add("add_ontology_label_retriever");
  if (ids.includes("no_material_effect")) add("hold_baseline");
  return actions;
}

function experimentLesson(
  parent: PrivateTeacherAssessment,
  trial: PrivateTeacherCandidateTrial,
  policy: TeacherPolicy,
): TeacherExperimentLesson {
  if (!/^[a-f0-9]{64}$/.test(trial.candidateHash)) throw new Error("teacher trial candidate hash is invalid");
  if (!(TEACHER_EXPERIMENT_FAMILIES as readonly string[]).includes(trial.family)) throw new Error("teacher trial family is invalid");
  const candidate = assertPrivateTeacherAssessment(trial.assessment);
  const aspectEffects = canonicalEffects(parent, candidate, selectedF1, policy);
  const candidateRecallEffects = canonicalEffects(parent, candidate, (item) => item.candidateRecallCeiling, policy);
  const selectionRetentionEffects = canonicalEffects(parent, candidate, (item) => item.truePositiveSelectionRetention, policy);
  const evaluableEffects = Object.values(aspectEffects).filter((effect) => effect !== "suppressed");
  const evaluableRecall = Object.values(candidateRecallEffects).filter((effect) => effect !== "suppressed");
  const recallImproved = evaluableRecall.includes("improved");
  const selectedImproved = evaluableEffects.includes("improved");
  const selectedRegressed = evaluableEffects.includes("regressed");
  const ids = TEACHER_EXPERIMENT_LESSON_IDS.filter((id) => {
    if (id === "candidate_recall_not_improved") return evaluableRecall.length > 0 && !recallImproved;
    if (id === "candidate_expansion_hurt_selection") {
      return trial.family === "candidate_sources" && !recallImproved && selectedRegressed;
    }
    if (id === "selection_rescue_without_candidate_gain") return !recallImproved && selectedImproved;
    if (id === "selection_tradeoff_across_aspects") return selectedImproved && selectedRegressed;
    return evaluableEffects.length > 0 && evaluableEffects.every((effect) => effect === "flat");
  });
  return {
    candidateHash: trial.candidateHash,
    family: trial.family,
    aspectEffects,
    candidateRecallEffects,
    selectionRetentionEffects,
    lessonIds: ids,
    recommendedActions: lessonActions(ids, aspectEffects),
  };
}

function prioritizedActions(
  diagnoses: readonly TeacherDiagnosisId[],
  lessons: readonly TeacherExperimentLesson[],
  policy: TeacherPolicy,
  aspects: Readonly<Record<ScoredAspect, TeacherSignal>>,
): TeacherActionId[] {
  const actions: TeacherActionId[] = [];
  const add = (action: TeacherActionId): void => {
    if (!actions.includes(action)) actions.push(action);
  };
  // Lessons are serialized in candidate-hash order for canonical output, but
  // hashes carry no causal meaning. Aggregate first, then apply a fixed
  // semantic priority so genome-hash changes cannot reorder the experiment
  // budget.
  const lessonActionSet = new Set(lessons.flatMap((lesson) => lesson.recommendedActions));
  const contrastiveOrder: readonly TeacherActionId[] = [
    "calibrate_mf_selection",
    "calibrate_bp_selection",
    "calibrate_cc_selection",
    "tighten_selection_budget",
    "decorrelate_sources",
    "apply_evidence_frontier",
    "add_ontology_label_retriever",
    "hold_baseline",
  ];
  for (const action of contrastiveOrder) if (lessonActionSet.has(action)) add(action);
  for (const action of policy.causalActionOrder) if (lessonActionSet.has(action)) add(action);
  // A supported overbreadth signal is already downstream-specific and maps to
  // an isolated registered mutation. Give it one bounded experiment slot
  // before broader candidate/source coaching can consume the round budget.
  if (diagnoses.includes("selection_overbreadth_high")) add("tighten_selection_budget");
  const absoluteActions = new Set<TeacherActionId>([
    ...coachingActionsForDiagnoses(diagnoses, policy),
    ...absoluteAspectCalibrationActions(aspects),
  ]);
  for (const action of policy.causalActionOrder) if (absoluteActions.has(action)) add(action);
  // `hold_baseline` is a terminal control, not a mutation. A flat trial may
  // recommend it while the parent still has a different material weakness;
  // in that mixed case it must not consume one of the Developer's bounded
  // experiment slots ahead of executable actions.
  return actions.some((action) => action !== "hold_baseline")
    ? actions.filter((action) => action !== "hold_baseline")
    : actions;
}

/**
 * Convert private aggregates to the only object allowed across the evaluator
 * boundary. It intentionally does not bind or expose the private assessment
 * hash, raw counts, ratios, labels, cases, or accessions.
 */
export function quantizeTeacherAssessment(
  privateAssessment: unknown,
  policyInput: TeacherPolicy = teacherPolicy(),
): TeacherFeedback {
  const assessment = assertPrivateTeacherAssessment(privateAssessment);
  const policy = assertTeacherPolicy(policyInput);
  const aspects = {
    molecular_function: quantizeSignal(assessment.aspects.molecular_function, assessment.causalTrace.aspects.molecular_function, policy),
    biological_process: quantizeSignal(assessment.aspects.biological_process, assessment.causalTrace.aspects.biological_process, policy),
    cellular_component: quantizeSignal(assessment.aspects.cellular_component, assessment.causalTrace.aspects.cellular_component, policy),
  };
  const overall = quantizeSignal(assessment.overall, assessment.causalTrace.overall, policy);
  const allSignals = [...BENCHMARK_GO_ASPECTS.map((aspect) => aspects[aspect]), overall];
  const diagnoses = TEACHER_DIAGNOSIS_IDS.filter((diagnosis) => allSignals.some((signal) => signal.diagnoses.includes(diagnosis)));
  const materialDiagnoses = diagnoses.filter((item) => item !== "small_sample_suppressed" && item !== "no_material_weakness");
  const effectiveDiagnoses = materialDiagnoses.length > 0 ? materialDiagnoses : diagnoses;
  const dominant = dominantLoss(effectiveDiagnoses);
  const content = {
    schemaVersion: "pi-teacher-feedback.v4" as const,
    policyHash: policy.canonicalHash,
    aspects,
    overall,
    dominantLoss: dominant,
    diagnoses,
    experimentLessons: [] as TeacherExperimentLesson[],
    prioritizedActions: prioritizedActions(effectiveDiagnoses, [], policy, aspects),
  };
  return assertLeakSafeTeacherFeedback({ ...content, canonicalHash: hashCanonical(content) });
}

/**
 * Quantize the retained parent plus every tested candidate into a contrastive
 * teacher message. The developer learns which *kind* of experiment helped or
 * hurt each GO aspect, never the underlying counts, ratios, cases, or labels.
 */
export function quantizeTeacherRound(input: {
  /** Pre-gate parent used only as the causal baseline for trial lessons. */
  evaluatedParentAssessment: unknown;
  /** Post-gate parent retained for the next round and all absolute coaching. */
  retainedParentAssessment: unknown;
  candidateTrials: readonly PrivateTeacherCandidateTrial[];
  policy?: TeacherPolicy;
}): TeacherFeedback {
  const evaluatedParent = assertPrivateTeacherAssessment(input.evaluatedParentAssessment);
  const retainedParent = assertPrivateTeacherAssessment(input.retainedParentAssessment);
  const policy = assertTeacherPolicy(input.policy ?? teacherPolicy());
  const base = quantizeTeacherAssessment(retainedParent, policy);
  const seen = new Set<string>();
  const lessons = [...input.candidateTrials]
    .sort((left, right) => left.candidateHash.localeCompare(right.candidateHash))
    .map((trial) => {
      if (seen.has(trial.candidateHash)) throw new Error("teacher candidate trials must be unique");
      seen.add(trial.candidateHash);
      return experimentLesson(evaluatedParent, trial, policy);
    });
  const material = base.diagnoses.filter((item) => item !== "small_sample_suppressed" && item !== "no_material_weakness");
  const effective = material.length > 0 ? material : base.diagnoses;
  const { canonicalHash: _baseHash, ...baseContent } = base;
  const content = {
    ...baseContent,
    experimentLessons: lessons,
    prioritizedActions: prioritizedActions(effective, lessons, policy, base.aspects),
  };
  return assertLeakSafeTeacherFeedback({ ...content, canonicalHash: hashCanonical(content) });
}

const FEEDBACK_KEYS = ["schemaVersion", "policyHash", "aspects", "overall", "dominantLoss", "diagnoses", "experimentLessons", "prioritizedActions", "canonicalHash"] as const;
const SIGNAL_KEYS = ["sampleStatus", "candidateRecall", "candidatePurity", "selectedPrecision", "selectionRetention", "directCandidateSupport", "sourceDiversity", "phylogenyContext", "machineBlockerLoss", "earliestFailureStage", "failureBurden", "selectionOverbreadth", "dominantLoss", "diagnoses"] as const;
const EXPERIMENT_LESSON_KEYS = ["candidateHash", "family", "aspectEffects", "candidateRecallEffects", "selectionRetentionEffects", "lessonIds", "recommendedActions"] as const;
const PRIVATE_KEY = /^(?:accessions?|proteins?|cases?|go(?:_?ids?|_?terms?)?|gold|targets?|sequences?|structures?|raw(?:_?counts?)?|labels?|answers?|paths?|files?|urls?)$/i;
const CASE_ID = /(?:^|[^A-Z0-9])CASE(?:[_-][A-Z0-9]+)+(?=$|[^A-Z0-9])/i;
const ACCESSION = /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-\d+)?$/;

function assertNoRecursiveLeak(value: unknown, path: string): void {
  if (typeof value === "number") throw new Error(`${path} contains a forbidden raw number`);
  if (typeof value === "string") {
    if (/GO:\d{7}/i.test(value) || CASE_ID.test(value) || ACCESSION.test(value)
      || /\b(?:https?|file):\/\//i.test(value) || /(?:^|\s)(?:\.\.?\/|\/)[^\s]*/.test(value)) {
      throw new Error(`${path} contains a forbidden private identifier`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRecursiveLeak(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    if (value !== null && value !== undefined && typeof value !== "boolean") throw new Error(`${path} contains an invalid value`);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) throw new Error(`${path}.${key} is a forbidden private-looking field`);
    assertNoRecursiveLeak(item, `${path}.${key}`);
  }
}

function assertSignal(value: unknown, label: string): TeacherSignal {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, SIGNAL_KEYS, label);
  if (value.sampleStatus !== "sufficient" && value.sampleStatus !== "suppressed") throw new Error(`${label} sample status is invalid`);
  for (const key of ["candidateRecall", "candidatePurity", "selectedPrecision", "selectionRetention", "directCandidateSupport", "sourceDiversity", "phylogenyContext"] as const) {
    if (!(TEACHER_QUALITY_BANDS as readonly unknown[]).includes(value[key])) throw new Error(`${label}.${key} is invalid`);
  }
  if (!(TEACHER_LOSS_BANDS as readonly unknown[]).includes(value.machineBlockerLoss)) throw new Error(`${label} blocker-loss band is invalid`);
  if (!(TEACHER_FAILURE_STAGES as readonly unknown[]).includes(value.earliestFailureStage)) throw new Error(`${label} failure stage is invalid`);
  if (!(TEACHER_LOSS_BANDS as readonly unknown[]).includes(value.failureBurden)
    || !(TEACHER_LOSS_BANDS as readonly unknown[]).includes(value.selectionOverbreadth)) {
    throw new Error(`${label} causal loss band is invalid`);
  }
  if (!(TEACHER_DOMINANT_LOSSES as readonly unknown[]).includes(value.dominantLoss)) throw new Error(`${label} dominant loss is invalid`);
  if (!Array.isArray(value.diagnoses) || value.diagnoses.some((item) => !(TEACHER_DIAGNOSIS_IDS as readonly unknown[]).includes(item))) {
    throw new Error(`${label} diagnoses are invalid`);
  }
  const typed = value as unknown as TeacherSignal;
  if (new Set(typed.diagnoses).size !== typed.diagnoses.length
    || canonicalJson(typed.diagnoses) !== canonicalJson(TEACHER_DIAGNOSIS_IDS.filter((item) => typed.diagnoses.includes(item)))) {
    throw new Error(`${label} diagnoses are not canonical`);
  }
  if (typed.sampleStatus === "suppressed") {
    if ([typed.candidateRecall, typed.candidatePurity, typed.selectedPrecision, typed.selectionRetention,
      typed.directCandidateSupport, typed.sourceDiversity, typed.phylogenyContext].some((band) => band !== "suppressed")
      || typed.machineBlockerLoss !== "suppressed" || typed.earliestFailureStage !== "suppressed"
      || typed.failureBurden !== "suppressed" || typed.selectionOverbreadth !== "suppressed"
      || typed.dominantLoss !== "small_sample"
      || canonicalJson(typed.diagnoses) !== canonicalJson(["small_sample_suppressed"])) {
      throw new Error(`${label} violates small-sample suppression`);
    }
  } else if ([typed.candidateRecall, typed.candidatePurity, typed.selectedPrecision, typed.selectionRetention,
    typed.directCandidateSupport, typed.sourceDiversity, typed.phylogenyContext].some((band) => band === "suppressed")
    || typed.machineBlockerLoss === "suppressed") {
    throw new Error(`${label} contains a stray suppression band`);
  }
  if (typed.earliestFailureStage === "suppressed" && typed.failureBurden !== "suppressed") {
    throw new Error(`${label} failure-stage suppression is inconsistent`);
  }
  if (typed.earliestFailureStage !== "suppressed" && typed.failureBurden === "suppressed") {
    throw new Error(`${label} failure-burden suppression is inconsistent`);
  }
  if (typed.dominantLoss !== dominantLoss(typed.diagnoses)) throw new Error(`${label} dominant loss is inconsistent`);
  return typed;
}

function assertEffectRecord(value: unknown, label: string): Record<ScoredAspect, TeacherEffectBand> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, BENCHMARK_GO_ASPECTS, label);
  for (const aspect of BENCHMARK_GO_ASPECTS) {
    if (!(TEACHER_EFFECT_BANDS as readonly unknown[]).includes(value[aspect])) throw new Error(`${label}.${aspect} is invalid`);
  }
  return value as unknown as Record<ScoredAspect, TeacherEffectBand>;
}

function assertExperimentLesson(value: unknown, label: string): TeacherExperimentLesson {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, EXPERIMENT_LESSON_KEYS, label);
  if (typeof value.candidateHash !== "string" || !/^[a-f0-9]{64}$/.test(value.candidateHash)) {
    throw new Error(`${label}.candidateHash is invalid`);
  }
  if (!(TEACHER_EXPERIMENT_FAMILIES as readonly unknown[]).includes(value.family)) throw new Error(`${label}.family is invalid`);
  assertEffectRecord(value.aspectEffects, `${label}.aspectEffects`);
  assertEffectRecord(value.candidateRecallEffects, `${label}.candidateRecallEffects`);
  assertEffectRecord(value.selectionRetentionEffects, `${label}.selectionRetentionEffects`);
  if (!Array.isArray(value.lessonIds)
    || value.lessonIds.some((item) => !(TEACHER_EXPERIMENT_LESSON_IDS as readonly unknown[]).includes(item))) {
    throw new Error(`${label}.lessonIds are invalid`);
  }
  if (!Array.isArray(value.recommendedActions)
    || value.recommendedActions.some((item) => !(TEACHER_ACTION_IDS as readonly unknown[]).includes(item))) {
    throw new Error(`${label}.recommendedActions are invalid`);
  }
  const typed = value as unknown as TeacherExperimentLesson;
  if (canonicalJson(typed.lessonIds) !== canonicalJson(TEACHER_EXPERIMENT_LESSON_IDS.filter((item) => typed.lessonIds.includes(item)))) {
    throw new Error(`${label}.lessonIds are not canonical`);
  }
  if (canonicalJson(typed.recommendedActions) !== canonicalJson(lessonActions(typed.lessonIds, typed.aspectEffects))) {
    throw new Error(`${label}.recommendedActions are inconsistent`);
  }
  return typed;
}

export function assertLeakSafeTeacherFeedback(value: unknown): TeacherFeedback {
  assertNoRecursiveLeak(value, "teacher feedback");
  if (!isRecord(value)) throw new Error("teacher feedback must be an object");
  exactKeys(value, FEEDBACK_KEYS, "teacher feedback");
  if (value.schemaVersion !== "pi-teacher-feedback.v4" || value.policyHash !== TEACHER_POLICY_HASH) throw new Error("teacher feedback policy binding is invalid");
  if (!isRecord(value.aspects)) throw new Error("teacher feedback aspects must be an object");
  exactKeys(value.aspects, BENCHMARK_GO_ASPECTS, "teacher feedback aspects");
  const aspects = {
    molecular_function: assertSignal(value.aspects.molecular_function, "teacher feedback molecular_function"),
    biological_process: assertSignal(value.aspects.biological_process, "teacher feedback biological_process"),
    cellular_component: assertSignal(value.aspects.cellular_component, "teacher feedback cellular_component"),
  };
  const overall = assertSignal(value.overall, "teacher feedback overall");
  if (!(TEACHER_DOMINANT_LOSSES as readonly unknown[]).includes(value.dominantLoss)) throw new Error("teacher feedback dominant loss is invalid");
  if (!Array.isArray(value.diagnoses) || value.diagnoses.some((item) => !(TEACHER_DIAGNOSIS_IDS as readonly unknown[]).includes(item))) {
    throw new Error("teacher feedback diagnoses are invalid");
  }
  if (!Array.isArray(value.prioritizedActions) || value.prioritizedActions.some((item) => !(TEACHER_ACTION_IDS as readonly unknown[]).includes(item))) {
    throw new Error("teacher feedback actions are invalid");
  }
  if (!Array.isArray(value.experimentLessons)) throw new Error("teacher feedback experiment lessons are invalid");
  const experimentLessons = value.experimentLessons.map((lesson, index) => assertExperimentLesson(lesson, `teacher feedback experiment lesson ${index}`));
  const lessonHashes = experimentLessons.map((lesson) => lesson.candidateHash);
  if (new Set(lessonHashes).size !== lessonHashes.length
    || canonicalJson(lessonHashes) !== canonicalJson([...lessonHashes].sort())) {
    throw new Error("teacher feedback experiment lessons must be unique and hash-sorted");
  }
  const typed = value as unknown as TeacherFeedback;
  const signals = [...BENCHMARK_GO_ASPECTS.map((aspect) => aspects[aspect]), overall];
  const expectedDiagnoses = TEACHER_DIAGNOSIS_IDS.filter((diagnosis) => signals.some((signal) => signal.diagnoses.includes(diagnosis)));
  if (canonicalJson(typed.diagnoses) !== canonicalJson(expectedDiagnoses)) throw new Error("teacher feedback diagnoses are not the canonical aggregate");
  const material = expectedDiagnoses.filter((item) => item !== "small_sample_suppressed" && item !== "no_material_weakness");
  const effective = material.length > 0 ? material : expectedDiagnoses;
  if (typed.dominantLoss !== dominantLoss(effective)) throw new Error("teacher feedback dominant loss is inconsistent");
  if (canonicalJson(typed.prioritizedActions) !== canonicalJson(prioritizedActions(
    effective,
    experimentLessons,
    teacherPolicy(),
    aspects,
  ))) {
    throw new Error("teacher feedback actions violate causal ordering");
  }
  const { canonicalHash, ...content } = typed;
  if (typeof canonicalHash !== "string" || canonicalHash !== hashCanonical(content)) throw new Error("teacher feedback canonical hash mismatch");
  return typed;
}
