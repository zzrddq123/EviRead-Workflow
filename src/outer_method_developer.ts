import type {
  createAgentSession as createPiAgentSession,
} from "./codex_runtime.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { resolveDefaultPiModel } from "./pi_model.js";
import { hashCanonical } from "./hash.js";
import {
  CAUSAL_ACTIONS,
  CAUSAL_ACTIVATION_BANDS,
  CAUSAL_COMPARISON_BASES,
  CAUSAL_DIAGNOSES,
  CAUSAL_EFFECT_BANDS,
  CAUSAL_FALSIFIER_CODES,
  CAUSAL_FALSIFIER_STATUSES,
  CAUSAL_HYPOTHESIS_VERDICTS,
  CAUSAL_MECHANISM_VERDICTS,
  CAUSAL_PIPELINE_INVARIANTS,
  CAUSAL_TEACHER_ASPECTS,
  CAUSAL_TEACHER_DECISIONS,
  CAUSAL_TEACHER_FAMILIES,
  CAUSAL_NOVELTY_CLASSES,
  type CausalAction,
  type CausalTeacherFamily,
  type OptimizationCausalTeacherFeedback,
} from "./outer_causal_teacher.js";
import {
  RSI_EXPLORATION_COMPONENTS,
  RSI_EXPLORATION_PROBLEM_CODES,
  type RsiExplorationComponent,
  type RsiExplorationProblemCode,
  type RsiExplorationResearchCard,
  type RsiExpectedEffect,
} from "./outer/version_graph/rsi_exploration_tree.js";

/**
 * A method-level DeveloperReasoner, deliberately separate from the closed
 * parameter MutationArchitect. The language model may compare public method
 * findings and causal Teacher diagnoses, but it cannot invent an experiment,
 * implementation, metric, biological label, or target-specific instruction.
 */

export const METHOD_EXPERIMENT_TEMPLATE_IDS = [
  "repair_learned_channel_pipeline",
  "route_learned_signal_by_aspect",
  "calibrate_sources_grouped_oof_by_aspect",
  "compare_mdeepfri_gcn_vs_cnn",
  "add_ontology_decoder_source",
] as const;
export type MethodExperimentTemplateId = typeof METHOD_EXPERIMENT_TEMPLATE_IDS[number];

export const METHOD_HYPOTHESES = [
  "restored_pipeline_activation_improves_evaluable_signal",
  "aspect_isolation_preserves_local_gain_without_cross_aspect_regression",
  "grouped_oof_calibration_improves_precision_recall_tradeoff",
  "structure_gcn_adds_signal_beyond_sequence_cnn_control",
  "ontology_decoder_expands_useful_candidates_without_precision_collapse",
] as const;
export type MethodHypothesis = typeof METHOD_HYPOTHESES[number];

export const METHOD_CONTROLS = [
  "retained_parent_identical_evidence_and_policy",
  "shared_candidate_stream_router_disabled",
  "uncalibrated_scores_same_group_split",
  "sequence_cnn_same_model_release",
  "retained_parent_without_decoder_source",
] as const;
export type MethodControl = typeof METHOD_CONTROLS[number];

export const METHOD_FALSIFIERS = [
  "pipeline_invariant_or_activation_not_restored",
  "no_guarded_aspect_gain_or_other_aspect_regression",
  "no_oof_gain_or_fresh_fold_regression",
  "gcn_no_gain_over_cnn_or_overlap_guard_failure",
  "no_candidate_recall_gain_or_precision_regression",
] as const;
export type MethodFalsifier = typeof METHOD_FALSIFIERS[number];

export const METHOD_REQUIRED_CAPABILITIES = [
  "stage_count_instrumentation",
  "aspect_isolated_routing",
  "group_aware_calibration_split",
  "paired_structure_sequence_predictor",
  "ontology_aware_candidate_decoder",
] as const;
export type MethodRequiredCapability = typeof METHOD_REQUIRED_CAPABILITIES[number];

export const METHOD_RATIONALE_CODES = [
  "repair_before_scoring",
  "isolate_cross_aspect_effect",
  "calibrate_precision_recall_tradeoff",
  "test_orthogonal_structure_signal",
  "expand_ontology_candidate_information",
  "switch_saturated_mechanism",
  "public_method_support",
] as const;
export type MethodRationaleCode = typeof METHOD_RATIONALE_CODES[number];

export interface MethodExperimentTemplate {
  templateId: MethodExperimentTemplateId;
  family: CausalTeacherFamily;
  novelty: Exclude<typeof CAUSAL_NOVELTY_CLASSES[number], "none">;
  hypothesis: MethodHypothesis;
  control: MethodControl;
  falsifier: MethodFalsifier;
  requiredCapability: MethodRequiredCapability;
}

const CANONICAL_TEMPLATES: readonly MethodExperimentTemplate[] = [
  {
    templateId: "repair_learned_channel_pipeline",
    family: "pipeline",
    novelty: "pipeline_fix",
    hypothesis: "restored_pipeline_activation_improves_evaluable_signal",
    control: "retained_parent_identical_evidence_and_policy",
    falsifier: "pipeline_invariant_or_activation_not_restored",
    requiredCapability: "stage_count_instrumentation",
  },
  {
    templateId: "route_learned_signal_by_aspect",
    family: "aspect_router",
    novelty: "new_router",
    hypothesis: "aspect_isolation_preserves_local_gain_without_cross_aspect_regression",
    control: "shared_candidate_stream_router_disabled",
    falsifier: "no_guarded_aspect_gain_or_other_aspect_regression",
    requiredCapability: "aspect_isolated_routing",
  },
  {
    templateId: "calibrate_sources_grouped_oof_by_aspect",
    family: "score_calibration",
    novelty: "new_calibrator",
    hypothesis: "grouped_oof_calibration_improves_precision_recall_tradeoff",
    control: "uncalibrated_scores_same_group_split",
    falsifier: "no_oof_gain_or_fresh_fold_regression",
    requiredCapability: "group_aware_calibration_split",
  },
  {
    templateId: "compare_mdeepfri_gcn_vs_cnn",
    family: "external_predictor",
    novelty: "new_predictor",
    hypothesis: "structure_gcn_adds_signal_beyond_sequence_cnn_control",
    control: "sequence_cnn_same_model_release",
    falsifier: "gcn_no_gain_over_cnn_or_overlap_guard_failure",
    requiredCapability: "paired_structure_sequence_predictor",
  },
  {
    templateId: "add_ontology_decoder_source",
    family: "ontology_reasoning",
    novelty: "new_information_source",
    hypothesis: "ontology_decoder_expands_useful_candidates_without_precision_collapse",
    control: "retained_parent_without_decoder_source",
    falsifier: "no_candidate_recall_gain_or_precision_regression",
    requiredCapability: "ontology_aware_candidate_decoder",
  },
] as const;

const PRIMARY_RATIONALE: Readonly<Record<MethodExperimentTemplateId, MethodRationaleCode>> = {
  repair_learned_channel_pipeline: "repair_before_scoring",
  route_learned_signal_by_aspect: "isolate_cross_aspect_effect",
  calibrate_sources_grouped_oof_by_aspect: "calibrate_precision_recall_tradeoff",
  compare_mdeepfri_gcn_vs_cnn: "test_orthogonal_structure_signal",
  add_ontology_decoder_source: "expand_ontology_candidate_information",
};

export interface MethodExperimentRegistry {
  schemaVersion: "pi-method-experiment-registry.v1";
  registryHash: string;
  templates: MethodExperimentTemplate[];
}

export function createDefaultMethodExperimentRegistry(): MethodExperimentRegistry {
  const templates = CANONICAL_TEMPLATES.map((template) => ({ ...template }));
  return {
    schemaVersion: "pi-method-experiment-registry.v1",
    registryHash: `sha256:${hashCanonical(templates)}`,
    templates,
  };
}

export const METHOD_DEVELOPMENT_OBJECTIVES = ["maximize_hierarchical_go_quality"] as const;
export type MethodDevelopmentObjective = typeof METHOD_DEVELOPMENT_OBJECTIVES[number];
export const METHOD_RETAINED_PARENT_STATES = ["baseline", "improved_candidate"] as const;

export interface MethodDevelopmentContext {
  schemaVersion:
    | "pi-method-development-context.v1"
    | "pi-method-development-context.v2";
  objective: MethodDevelopmentObjective;
  position: {
    round: number;
    maximumRounds: number;
    completedRounds: number;
    retainedParent: typeof METHOD_RETAINED_PARENT_STATES[number];
  };
  history: Array<{
    round: number;
    templateId: MethodExperimentTemplateId;
    family: CausalTeacherFamily;
    outcome: typeof CAUSAL_TEACHER_DECISIONS[number];
  }>;
  codeVersionHistory?: {
    schemaVersion:
      | "pi-rsi-developer-history-context.v1"
      | "pi-rsi-developer-history-context.v2"
      | "pi-rsi-developer-history-context.v3"
      | "pi-rsi-developer-history-context.v4";
    graphHead: {
      eventSequence: number;
      eventManifestHash: string;
      selectedVersionId: string;
    };
    records: Array<{
      eventSequence: number;
      versionId: string;
      parentVersionId: string | null;
      evaluationId: string;
      resultKind:
        | "adaptive_development"
        | "software_verification"
        | "frozen_replay";
      changeSummary: string;
      hypothesis: string;
      method: {
        templateId: MethodExperimentTemplateId | null;
        family: CausalTeacherFamily | null;
        externalEvidenceIds: string[];
      } | null;
      metrics: {
        controlFmax: {
          overall: number | null;
          molecularFunction: number | null;
          biologicalProcess: number | null;
          cellularComponent: number | null;
        };
        challengerFmax: {
          overall: number | null;
          molecularFunction: number | null;
          biologicalProcess: number | null;
          cellularComponent: number | null;
        };
        overallFmaxGain: number;
        maximumPopulatedAspectFmaxDrop: number;
      } | null;
      outcome:
        | typeof CAUSAL_TEACHER_DECISIONS[number]
        | "passed"
        | "failed";
      teacher: {
        hypothesisVerdict: typeof CAUSAL_HYPOTHESIS_VERDICTS[number];
        mechanismVerdict: typeof CAUSAL_MECHANISM_VERDICTS[number];
        diagnoses: typeof CAUSAL_DIAGNOSES[number][];
        prioritizedActions: CausalAction[];
      } | null;
      decision: {
        action: "continue" | "backtrack" | "retain";
        selectedVersionId: string;
        rationale: string;
      } | null;
      publicationHash: string;
      claimBoundary: string;
    }>;
    explorations: Array<{
      eventSequence: number;
      explorationId: string;
      sourceVersionId: string;
      sourceEvaluationId: string;
      baseVersionId: string;
      manifestHash: string;
      evaluationAnalysisHash: string;
      planHash: string;
      action: "proceed" | "stop";
      plannedVersionId: string | null;
      teacherDistillation: {
        proteinEvaluation: boolean;
        hypothesisVerdict:
          typeof CAUSAL_HYPOTHESIS_VERDICTS[number] | null;
        mechanismVerdict:
          typeof CAUSAL_MECHANISM_VERDICTS[number] | null;
        diagnoses: typeof CAUSAL_DIAGNOSES[number][];
        prioritizedActions: CausalAction[];
      };
      problemAssessment: string;
      problemCodes: RsiExplorationProblemCode[];
      hypothesis: string;
      plannedChangeSummary: string;
      codeChangeTargets: string[];
      controls: string[];
      expectedEffects: Record<
        | "overall"
        | "molecularFunction"
        | "biologicalProcess"
        | "cellularComponent",
        RsiExpectedEffect
      >;
      experiment: {
        component: RsiExplorationComponent;
        strategy: string;
        requiredCapabilities: string[];
        falsifiers: string[];
      };
      researchCardBundleHash: string;
      researchCards: RsiExplorationResearchCard[];
      rollbackCondition: string;
      claimBoundary: string;
    }>;
    /**
     * Present only in v2. These are immutable, knowledge-only records for
     * experiments that pre-date the prospective version contract. They can
     * guide a later plan, but can never update the selected version or count
     * as a prospectively evaluated code-version attempt.
     */
    retrospectiveRecords?: Array<{
      eventSequence: number;
      recordId: string;
      manifestHash: string;
      evaluatedSource: {
        sourceCommit: string;
        sourceTree: string;
      };
      receipt: {
        relativePath: string;
        blobObjectId: string;
        fileSha256: string;
        canonicalHash: string;
      };
      formalSelectedVersionId: string;
      changeSummary: string;
      hypothesis: string;
      component: RsiExplorationComponent;
      observations: Array<{
        observationId: string;
        cohortRole:
          | "development"
          | "calibration"
          | "development_calibration"
          | "selection"
          | "test"
          | "all_descriptive";
        metric: "fmax";
        baseline: number;
        candidate: number;
        candidateMinusBaseline: number;
        interpretation:
          | "development_signal"
          | "selection_gate"
          | "descriptive_only";
      }>;
      diagnoses: typeof CAUSAL_DIAGNOSES[number][];
      prioritizedActions: CausalAction[];
      localGateOutcome:
        | "retain_experiment_control"
        | "prefer_experiment_candidate"
        | "inconclusive";
      archiveSealHash: string;
      archivePublicManifestHash: string;
      evidenceTiming:
        "retrospective_post_hoc_without_pre_evaluation_opening";
      selectionEligibility:
        "ineligible_never_updates_selected_version";
      promotionEligibility: "ineligible_not_prospective_evidence";
      claimBoundary:
        "Retrospective post-hoc aggregate observation only; not a prospectively registered RSI code version or evaluation, not eligible to update formal selection, and not evidence for promotion.";
    }>;
    retrospectiveIncumbents?: Array<{
      eventSequence: number;
      adoptionId: string;
      manifestHash: string;
      selectedVersionId: string;
      operationalIncumbentVersionId: string;
      evidence: Record<string, unknown>;
      plannedVersionId: string;
      planHash: string;
      claimBoundary:
        "Retrospective incumbent adoption changes the operational development baseline only; formal prospective selection remains unchanged, the adopted version remains prospectively unevaluated, and all future promotion claims require a fresh prospective opening.";
    }>;
    operationalIncumbentVersionId?: string;
    currentBestVersionId?: string;
    lastProspectivelySelectedVersionId?: string;
    canonicalHash: string;
  };
}

export interface SanitizedMethodResearchCard {
  evidenceId: string;
  finding: string;
  limitations: string[];
  supportedTemplateIds: MethodExperimentTemplateId[];
}

export interface MethodDeveloperSelection {
  selections: Array<{
    templateId: MethodExperimentTemplateId;
    rationaleCodes: MethodRationaleCode[];
  }>;
}

export interface CanonicalMethodExperiment {
  templateId: MethodExperimentTemplateId;
  family: CausalTeacherFamily;
  novelty: Exclude<typeof CAUSAL_NOVELTY_CLASSES[number], "none">;
  hypothesis: MethodHypothesis;
  control: MethodControl;
  falsifier: MethodFalsifier;
  requiredCapability: MethodRequiredCapability;
  evidenceIds: string[];
  rationaleCodes: MethodRationaleCode[];
}

export interface MethodExperimentPlan {
  schemaVersion: "pi-method-experiment-plan.v1";
  objective: MethodDevelopmentObjective;
  positionRound: number;
  experiments: CanonicalMethodExperiment[];
  planHash: string;
}

export const METHOD_DEVELOPER_MODES = ["deterministic", "pi"] as const;
export type MethodDeveloperMode = typeof METHOD_DEVELOPER_MODES[number];
export const METHOD_DEVELOPER_SELECTION_BUDGETS = [1, 2] as const;
export type MethodDeveloperSelectionBudget = typeof METHOD_DEVELOPER_SELECTION_BUDGETS[number];

export interface MethodDeveloperInput {
  projectRoot: string;
  mode: MethodDeveloperMode;
  feedback: OptimizationCausalTeacherFeedback[];
  context: MethodDevelopmentContext;
  researchCards: SanitizedMethodResearchCard[];
  registry: MethodExperimentRegistry;
  /** Explicit closed budget: one controlled experiment is preferred; two is the hard maximum. */
  maxSelections: MethodDeveloperSelectionBudget;
}

type ValidatedMethodDeveloperPayload = Pick<
  MethodDeveloperInput,
  "feedback" | "context" | "researchCards" | "registry"
>;

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RAW_SHA256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_HISTORY_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const SAFE_DEVELOPER_ID = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_HISTORY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EVIDENCE_ID = /^EXT-\d{4}$/;
const GO_ID = /GO:\d{7}/i;
const CASE_ID = /(?:^|[^A-Z0-9])CASE(?:[_-][A-Z0-9]+)+(?=$|[^A-Z0-9])/i;
const ACCESSION = /(?:^|[^A-Z0-9])(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-\d+)?(?=$|[^A-Z0-9])/;
const URL_OR_PATH = /\b(?:https?|file):\/\/|(?:^|\s)(?:\.\.?\/|\/)[^\s]*/i;
const PRIVATE_KEY = /^(?:accessions?|proteins?.*|cases?.*|go(?:_?ids?|_?terms?)?|gold.*|private.*|targets?.*|sequences?.*|structures?.*|paths?|files?|urls?|prompts?|code|answers?|labels?|metrics?|scores?)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (expected.has(key)) continue;
    if (PRIVATE_KEY.test(key)) throw new Error(`${label} contains a forbidden private-looking field`);
    throw new Error(`${label} contains an unexpected field`);
  }
  for (const key of keys) if (!(key in value)) throw new Error(`${label} is missing ${key}`);
}

function safePublicText(value: unknown, label: string, maximumLength: number): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  const normalized = value.normalize("NFKC");
  if (GO_ID.test(normalized) || CASE_ID.test(normalized)
    || ACCESSION.test(normalized) || URL_OR_PATH.test(normalized)
    || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u
      .test(normalized)) {
    throw new Error(`${label} contains a forbidden biological identifier, target handle, URL, or path`);
  }
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${label} is not an allowed value`);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}

function uniqueEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  maximum = allowed.length,
): T[] {
  if (!Array.isArray(value) || value.length > maximum || new Set(value).size !== value.length) {
    throw new Error(`${label} must be a bounded unique array`);
  }
  value.forEach((item) => enumValue(item, allowed, `${label} entry`));
  return [...value] as T[];
}

function validateEffectBands(value: unknown, label: string): OptimizationCausalTeacherFeedback["overallEffect"] {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const keys = ["fmax", "precisionAtFmax", "recallAtFmax", "coverageAtFmax"] as const;
  exactKeys(value, keys, label);
  for (const key of keys) enumValue(value[key], CAUSAL_EFFECT_BANDS, `${label}.${key}`);
  return {
    fmax: value.fmax,
    precisionAtFmax: value.precisionAtFmax,
    recallAtFmax: value.recallAtFmax,
    coverageAtFmax: value.coverageAtFmax,
  } as OptimizationCausalTeacherFeedback["overallEffect"];
}

function validateFeedback(value: unknown, index: number): OptimizationCausalTeacherFeedback {
  const label = `feedback[${index}]`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, [
    "schemaVersion", "candidateId", "family", "decision", "comparisonBasis", "activationBand",
    "pipelineInvariant", "overallEffect", "aspectEffects", "mechanismVerdict", "hypothesisVerdict",
    "falsifierResults", "diagnoses",
    "prioritizedActions", "consecutiveSameMechanismNoGain", "consecutiveSameInterventionNoGain",
    "forbiddenExhaustedMechanisms",
  ], label);
  if (value.schemaVersion !== "pi-optimization-causal-teacher-feedback.v2") {
    throw new Error(`${label} uses an unsupported schema`);
  }
  const candidateId = value.candidateId;
  if (typeof candidateId !== "string"
    || !SAFE_DEVELOPER_ID.test(candidateId)
    || ["case_", "protein_", "go_"].some((prefix) => candidateId.startsWith(prefix))) {
    throw new Error(`${label}.candidateId is not a registered developer identifier`);
  }
  enumValue(value.family, CAUSAL_TEACHER_FAMILIES, `${label}.family`);
  enumValue(value.decision, CAUSAL_TEACHER_DECISIONS, `${label}.decision`);
  enumValue(value.comparisonBasis, CAUSAL_COMPARISON_BASES, `${label}.comparisonBasis`);
  enumValue(value.activationBand, CAUSAL_ACTIVATION_BANDS, `${label}.activationBand`);
  enumValue(value.pipelineInvariant, CAUSAL_PIPELINE_INVARIANTS, `${label}.pipelineInvariant`);
  const overallEffect = validateEffectBands(value.overallEffect, `${label}.overallEffect`);
  if (!isRecord(value.aspectEffects)) throw new Error(`${label}.aspectEffects must be an object`);
  const rawAspectEffects = value.aspectEffects;
  exactKeys(rawAspectEffects, CAUSAL_TEACHER_ASPECTS, `${label}.aspectEffects`);
  const aspectEffects = Object.fromEntries(CAUSAL_TEACHER_ASPECTS.map((aspect) => [
    aspect,
    validateEffectBands(rawAspectEffects[aspect], `${label}.aspectEffects.${aspect}`),
  ])) as OptimizationCausalTeacherFeedback["aspectEffects"];
  enumValue(value.mechanismVerdict, CAUSAL_MECHANISM_VERDICTS, `${label}.mechanismVerdict`);
  enumValue(value.hypothesisVerdict, CAUSAL_HYPOTHESIS_VERDICTS, `${label}.hypothesisVerdict`);
  if (!Array.isArray(value.falsifierResults)
    || value.falsifierResults.length < 1
    || value.falsifierResults.length > CAUSAL_FALSIFIER_CODES.length) {
    throw new Error(`${label}.falsifierResults must be a non-empty bounded array`);
  }
  const seenFalsifiers = new Set<string>();
  const falsifierResults = value.falsifierResults.map((raw, falsifierIndex) => {
    const falsifierLabel = `${label}.falsifierResults[${falsifierIndex}]`;
    if (!isRecord(raw)) throw new Error(`${falsifierLabel} must be an object`);
    exactKeys(raw, ["code", "status"], falsifierLabel);
    enumValue(raw.code, CAUSAL_FALSIFIER_CODES, `${falsifierLabel}.code`);
    if (seenFalsifiers.has(raw.code)) throw new Error(`${label}.falsifierResults repeats a falsifier`);
    seenFalsifiers.add(raw.code);
    enumValue(raw.status, CAUSAL_FALSIFIER_STATUSES, `${falsifierLabel}.status`);
    return { code: raw.code, status: raw.status };
  });
  const canonicalFalsifiers = CAUSAL_FALSIFIER_CODES.filter((code) => seenFalsifiers.has(code));
  if (JSON.stringify(falsifierResults.map((result) => result.code)) !== JSON.stringify(canonicalFalsifiers)) {
    throw new Error(`${label}.falsifierResults are not in canonical order`);
  }
  const diagnoses = uniqueEnumArray(value.diagnoses, CAUSAL_DIAGNOSES, `${label}.diagnoses`);
  const prioritizedActions = uniqueEnumArray(value.prioritizedActions, CAUSAL_ACTIONS, `${label}.prioritizedActions`);
  const consecutiveSameMechanismNoGain = boundedInteger(
    value.consecutiveSameMechanismNoGain, 0, 64, `${label}.consecutiveSameMechanismNoGain`,
  );
  const consecutiveSameInterventionNoGain = boundedInteger(
    value.consecutiveSameInterventionNoGain, 0, 64, `${label}.consecutiveSameInterventionNoGain`,
  );
  const forbiddenExhaustedMechanisms = uniqueEnumArray(
    value.forbiddenExhaustedMechanisms,
    CAUSAL_TEACHER_FAMILIES,
    `${label}.forbiddenExhaustedMechanisms`,
  );
  if (consecutiveSameMechanismNoGain >= 2 && !forbiddenExhaustedMechanisms.includes(value.family)) {
    throw new Error(`${label} omits its saturated family from forbiddenExhaustedMechanisms`);
  }
  return {
    schemaVersion: value.schemaVersion,
    candidateId,
    family: value.family,
    decision: value.decision,
    comparisonBasis: value.comparisonBasis,
    activationBand: value.activationBand,
    pipelineInvariant: value.pipelineInvariant,
    overallEffect,
    aspectEffects,
    mechanismVerdict: value.mechanismVerdict,
    hypothesisVerdict: value.hypothesisVerdict,
    falsifierResults,
    diagnoses,
    prioritizedActions,
    consecutiveSameMechanismNoGain,
    consecutiveSameInterventionNoGain,
    forbiddenExhaustedMechanisms,
  };
}

export function validateMethodExperimentRegistry(value: unknown): MethodExperimentRegistry {
  if (!isRecord(value)) throw new Error("registry must be an object");
  exactKeys(value, ["schemaVersion", "registryHash", "templates"], "registry");
  if (value.schemaVersion !== "pi-method-experiment-registry.v1") throw new Error("unsupported registry schema");
  if (typeof value.registryHash !== "string" || !SHA256.test(value.registryHash)) {
    throw new Error("registryHash must be a SHA-256 content hash");
  }
  if (!Array.isArray(value.templates) || value.templates.length < 1 || value.templates.length > CANONICAL_TEMPLATES.length) {
    throw new Error("registry.templates must be a non-empty bounded array");
  }
  const seen = new Set<string>();
  const templates = value.templates.map((raw, index): MethodExperimentTemplate => {
    if (!isRecord(raw)) throw new Error(`registry template ${index} must be an object`);
    exactKeys(raw, ["templateId", "family", "novelty", "hypothesis", "control", "falsifier", "requiredCapability"], `registry template ${index}`);
    enumValue(raw.templateId, METHOD_EXPERIMENT_TEMPLATE_IDS, `registry template ${index}.templateId`);
    if (seen.has(raw.templateId)) throw new Error("registry contains a duplicate templateId");
    seen.add(raw.templateId);
    const canonical = CANONICAL_TEMPLATES.find((template) => template.templateId === raw.templateId)!;
    if (raw.family !== canonical.family
      || raw.novelty !== canonical.novelty
      || raw.hypothesis !== canonical.hypothesis
      || raw.control !== canonical.control
      || raw.falsifier !== canonical.falsifier
      || raw.requiredCapability !== canonical.requiredCapability) {
      throw new Error(`registry template ${raw.templateId} does not match its closed canonical definition`);
    }
    return { ...canonical };
  });
  const expectedOrder = METHOD_EXPERIMENT_TEMPLATE_IDS.filter((id) => seen.has(id));
  if (JSON.stringify(templates.map((item) => item.templateId)) !== JSON.stringify(expectedOrder)) {
    throw new Error("registry templates are not in canonical order");
  }
  if (value.registryHash !== `sha256:${hashCanonical(templates)}`) {
    throw new Error("registryHash does not commit the exact template projection");
  }
  return { schemaVersion: value.schemaVersion, registryHash: value.registryHash, templates };
}

function validateCodeVersionHistory(
  value: unknown,
): NonNullable<MethodDevelopmentContext["codeVersionHistory"]> {
  if (!isRecord(value)) {
    throw new Error("context.codeVersionHistory must be an object");
  }
  if (value.schemaVersion !== "pi-rsi-developer-history-context.v1"
    && value.schemaVersion !== "pi-rsi-developer-history-context.v2"
    && value.schemaVersion !== "pi-rsi-developer-history-context.v3"
    && value.schemaVersion !== "pi-rsi-developer-history-context.v4") {
    throw new Error("unsupported code-version history schema");
  }
  const historySchemaVersion = value.schemaVersion as
    | "pi-rsi-developer-history-context.v1"
    | "pi-rsi-developer-history-context.v2"
    | "pi-rsi-developer-history-context.v3"
    | "pi-rsi-developer-history-context.v4";
  exactKeys(
    value,
    historySchemaVersion === "pi-rsi-developer-history-context.v4"
      ? [
        "schemaVersion",
        "graphHead",
        "records",
        "explorations",
        "retrospectiveRecords",
        "retrospectiveIncumbents",
        "currentBestVersionId",
        "lastProspectivelySelectedVersionId",
        "canonicalHash",
      ]
      : historySchemaVersion === "pi-rsi-developer-history-context.v3"
      ? [
        "schemaVersion",
        "graphHead",
        "records",
        "explorations",
        "retrospectiveRecords",
        "retrospectiveIncumbents",
        "operationalIncumbentVersionId",
        "canonicalHash",
      ]
      : historySchemaVersion === "pi-rsi-developer-history-context.v2"
      ? [
        "schemaVersion",
        "graphHead",
        "records",
        "explorations",
        "retrospectiveRecords",
        "canonicalHash",
      ]
      : [
        "schemaVersion",
        "graphHead",
        "records",
        "explorations",
        "canonicalHash",
      ],
    "context.codeVersionHistory",
  );
  if (!isRecord(value.graphHead)) {
    throw new Error("context.codeVersionHistory.graphHead must be an object");
  }
  exactKeys(
    value.graphHead,
    [
      "eventSequence",
      "eventManifestHash",
      "selectedVersionId",
    ],
    "context.codeVersionHistory.graphHead",
  );
  const eventSequence = boundedInteger(
    value.graphHead.eventSequence,
    1,
    99_999_999,
    "context.codeVersionHistory.graphHead.eventSequence",
  );
  if (typeof value.graphHead.eventManifestHash !== "string"
    || !RAW_SHA256.test(value.graphHead.eventManifestHash)) {
    throw new Error(
      "context.codeVersionHistory.graphHead.eventManifestHash is invalid",
    );
  }
  if (typeof value.graphHead.selectedVersionId !== "string"
    || !SAFE_HISTORY_ID.test(value.graphHead.selectedVersionId)) {
    throw new Error(
      "context.codeVersionHistory.graphHead.selectedVersionId is invalid",
    );
  }
  if (!Array.isArray(value.records)) {
    throw new Error("context.codeVersionHistory.records must be an array");
  }
  let previousEvent = 0;
  const records = value.records.map(
    (raw, index):
      NonNullable<MethodDevelopmentContext["codeVersionHistory"]>["records"][number] => {
      const label = `context.codeVersionHistory.records[${index}]`;
      if (!isRecord(raw)) throw new Error(`${label} must be an object`);
      exactKeys(
        raw,
        [
          "eventSequence",
          "versionId",
          "parentVersionId",
          "evaluationId",
          "resultKind",
          "changeSummary",
          "hypothesis",
          "method",
          "metrics",
          "outcome",
          "teacher",
          "decision",
          "publicationHash",
          "claimBoundary",
        ],
        label,
      );
      const recordEvent = boundedInteger(
        raw.eventSequence,
        1,
        eventSequence,
        `${label}.eventSequence`,
      );
      if (recordEvent <= previousEvent) {
        throw new Error("context.codeVersionHistory.records are not chronological");
      }
      previousEvent = recordEvent;
      if (typeof raw.versionId !== "string"
        || !SAFE_HISTORY_ID.test(raw.versionId)) {
        throw new Error(`${label}.versionId is invalid`);
      }
      const versionId = raw.versionId;
      if (typeof raw.evaluationId !== "string"
        || !SAFE_HISTORY_ID.test(raw.evaluationId)) {
        throw new Error(`${label}.evaluationId is invalid`);
      }
      const evaluationId = raw.evaluationId;
      if (raw.parentVersionId !== null
        && (typeof raw.parentVersionId !== "string"
          || !SAFE_HISTORY_ID.test(raw.parentVersionId))) {
        throw new Error(`${label}.parentVersionId is invalid`);
      }
      enumValue(
        raw.resultKind,
        ["adaptive_development", "software_verification", "frozen_replay"] as const,
        `${label}.resultKind`,
      );
      safePublicText(raw.changeSummary, `${label}.changeSummary`, 1000);
      safePublicText(raw.hypothesis, `${label}.hypothesis`, 1000);
      let method:
        NonNullable<MethodDevelopmentContext["codeVersionHistory"]>["records"][number]["method"] =
          null;
      if (raw.method !== null) {
        if (!isRecord(raw.method)) throw new Error(`${label}.method is invalid`);
        const methodValue = raw.method;
        exactKeys(
          methodValue,
          ["templateId", "family", "externalEvidenceIds"],
          `${label}.method`,
        );
        if (methodValue.templateId !== null) {
          enumValue(
            methodValue.templateId,
            METHOD_EXPERIMENT_TEMPLATE_IDS,
            `${label}.method.templateId`,
          );
        }
        if (methodValue.family !== null) {
          enumValue(
            methodValue.family,
            CAUSAL_TEACHER_FAMILIES,
            `${label}.method.family`,
          );
        }
        const template = methodValue.templateId === null
          ? undefined
          : CANONICAL_TEMPLATES.find(
            (item) => item.templateId === methodValue.templateId,
          );
        if (template && methodValue.family !== template.family) {
          throw new Error(`${label}.method has a mismatched family`);
        }
        if (!Array.isArray(methodValue.externalEvidenceIds)
          || methodValue.externalEvidenceIds.length > 32
          || new Set(methodValue.externalEvidenceIds).size
            !== methodValue.externalEvidenceIds.length
          || methodValue.externalEvidenceIds.some(
            (item) => typeof item !== "string" || !EVIDENCE_ID.test(item),
          )) {
          throw new Error(
            `${label}.method.externalEvidenceIds must be bounded opaque evidence IDs`,
          );
        }
        method = {
          templateId: methodValue.templateId,
          family: methodValue.family,
          externalEvidenceIds: [
            ...methodValue.externalEvidenceIds,
          ] as string[],
        };
      }
      let metrics:
        NonNullable<MethodDevelopmentContext["codeVersionHistory"]>["records"][number]["metrics"] =
          null;
      if (raw.metrics !== null) {
        if (!isRecord(raw.metrics)
          || !isRecord(raw.metrics.controlFmax)
          || !isRecord(raw.metrics.challengerFmax)) {
          throw new Error(`${label}.metrics is invalid`);
        }
        exactKeys(
          raw.metrics,
          [
            "controlFmax",
            "challengerFmax",
            "overallFmaxGain",
            "maximumPopulatedAspectFmaxDrop",
          ],
          `${label}.metrics`,
        );
        const scopeKeys = [
          "overall",
          "molecularFunction",
          "biologicalProcess",
          "cellularComponent",
        ] as const;
        exactKeys(
          raw.metrics.controlFmax,
          [...scopeKeys],
          `${label}.metrics.controlFmax`,
        );
        exactKeys(
          raw.metrics.challengerFmax,
          [...scopeKeys],
          `${label}.metrics.challengerFmax`,
        );
        const metricValue = (
          value: unknown,
          metricLabel: string,
        ): number | null => {
          if (value === null) return null;
          if (typeof value !== "number" || !Number.isFinite(value)
            || value < 0 || value > 1) {
            throw new Error(`${metricLabel} must be null or a finite 0-1 value`);
          }
          return value;
        };
        const deltaValue = (
          value: unknown,
          metricLabel: string,
        ): number => {
          if (typeof value !== "number" || !Number.isFinite(value)
            || value < -1 || value > 1) {
            throw new Error(`${metricLabel} must be a finite -1 to 1 value`);
          }
          return value;
        };
        metrics = {
          controlFmax: {
            overall: metricValue(
              raw.metrics.controlFmax.overall,
              `${label}.metrics.controlFmax.overall`,
            ),
            molecularFunction: metricValue(
              raw.metrics.controlFmax.molecularFunction,
              `${label}.metrics.controlFmax.molecularFunction`,
            ),
            biologicalProcess: metricValue(
              raw.metrics.controlFmax.biologicalProcess,
              `${label}.metrics.controlFmax.biologicalProcess`,
            ),
            cellularComponent: metricValue(
              raw.metrics.controlFmax.cellularComponent,
              `${label}.metrics.controlFmax.cellularComponent`,
            ),
          },
          challengerFmax: {
            overall: metricValue(
              raw.metrics.challengerFmax.overall,
              `${label}.metrics.challengerFmax.overall`,
            ),
            molecularFunction: metricValue(
              raw.metrics.challengerFmax.molecularFunction,
              `${label}.metrics.challengerFmax.molecularFunction`,
            ),
            biologicalProcess: metricValue(
              raw.metrics.challengerFmax.biologicalProcess,
              `${label}.metrics.challengerFmax.biologicalProcess`,
            ),
            cellularComponent: metricValue(
              raw.metrics.challengerFmax.cellularComponent,
              `${label}.metrics.challengerFmax.cellularComponent`,
            ),
          },
          overallFmaxGain: deltaValue(
            raw.metrics.overallFmaxGain,
            `${label}.metrics.overallFmaxGain`,
          ),
          maximumPopulatedAspectFmaxDrop: (() => {
            const value = deltaValue(
              raw.metrics.maximumPopulatedAspectFmaxDrop,
              `${label}.metrics.maximumPopulatedAspectFmaxDrop`,
            );
            if (value < 0) {
              throw new Error(
                `${label}.metrics.maximumPopulatedAspectFmaxDrop must be non-negative`,
              );
            }
            return value;
          })(),
        };
      }
      enumValue(
        raw.outcome,
        [...CAUSAL_TEACHER_DECISIONS, "passed", "failed"] as const,
        `${label}.outcome`,
      );
      let teacher:
        NonNullable<MethodDevelopmentContext["codeVersionHistory"]>["records"][number]["teacher"] =
          null;
      if (raw.teacher !== null) {
        if (!isRecord(raw.teacher)) throw new Error(`${label}.teacher is invalid`);
        exactKeys(
          raw.teacher,
          [
            "hypothesisVerdict",
            "mechanismVerdict",
            "diagnoses",
            "prioritizedActions",
          ],
          `${label}.teacher`,
        );
        enumValue(
          raw.teacher.hypothesisVerdict,
          CAUSAL_HYPOTHESIS_VERDICTS,
          `${label}.teacher.hypothesisVerdict`,
        );
        enumValue(
          raw.teacher.mechanismVerdict,
          CAUSAL_MECHANISM_VERDICTS,
          `${label}.teacher.mechanismVerdict`,
        );
        const diagnoses = uniqueEnumArray(
          raw.teacher.diagnoses,
          CAUSAL_DIAGNOSES,
          `${label}.teacher.diagnoses`,
        );
        const prioritizedActions = uniqueEnumArray(
          raw.teacher.prioritizedActions,
          CAUSAL_ACTIONS,
          `${label}.teacher.prioritizedActions`,
        );
        teacher = {
          hypothesisVerdict: raw.teacher.hypothesisVerdict,
          mechanismVerdict: raw.teacher.mechanismVerdict,
          diagnoses,
          prioritizedActions,
        };
      }
      let decision:
        NonNullable<MethodDevelopmentContext["codeVersionHistory"]>["records"][number]["decision"] =
          null;
      if (raw.decision !== null) {
        if (!isRecord(raw.decision)) throw new Error(`${label}.decision is invalid`);
        exactKeys(
          raw.decision,
          ["action", "selectedVersionId", "rationale"],
          `${label}.decision`,
        );
        enumValue(
          raw.decision.action,
          ["continue", "backtrack", "retain"] as const,
          `${label}.decision.action`,
        );
        if (typeof raw.decision.selectedVersionId !== "string"
          || !SAFE_HISTORY_ID.test(raw.decision.selectedVersionId)) {
          throw new Error(`${label}.decision.selectedVersionId is invalid`);
        }
        safePublicText(
          raw.decision.rationale,
          `${label}.decision.rationale`,
          1000,
        );
        decision = {
          action: raw.decision.action,
          selectedVersionId: raw.decision.selectedVersionId,
          rationale: raw.decision.rationale,
        };
      }
      if (typeof raw.publicationHash !== "string"
        || !RAW_SHA256.test(raw.publicationHash)) {
        throw new Error(`${label}.publicationHash is invalid`);
      }
      safePublicText(raw.claimBoundary, `${label}.claimBoundary`, 1000);
      return {
        eventSequence: recordEvent,
        versionId,
        parentVersionId: raw.parentVersionId,
        evaluationId,
        resultKind: raw.resultKind,
        changeSummary: raw.changeSummary,
        hypothesis: raw.hypothesis,
        method,
        metrics,
        outcome: raw.outcome,
        teacher,
        decision,
        publicationHash: raw.publicationHash,
        claimBoundary: raw.claimBoundary,
      };
    },
  );
  if (!Array.isArray(value.explorations)) {
    throw new Error(
      "context.codeVersionHistory.explorations must be an array",
    );
  }
  let previousExplorationEvent = 0;
  const explorations = value.explorations.map(
    (raw, index):
      NonNullable<MethodDevelopmentContext["codeVersionHistory"]>["explorations"][number] => {
      const label = `context.codeVersionHistory.explorations[${index}]`;
      if (!isRecord(raw)) throw new Error(`${label} must be an object`);
      exactKeys(raw, [
        "eventSequence",
        "explorationId",
        "sourceVersionId",
        "sourceEvaluationId",
        "baseVersionId",
        "manifestHash",
        "evaluationAnalysisHash",
        "planHash",
        "action",
        "plannedVersionId",
        "teacherDistillation",
        "problemAssessment",
        "problemCodes",
        "hypothesis",
        "plannedChangeSummary",
        "codeChangeTargets",
        "controls",
        "expectedEffects",
        "experiment",
        "researchCardBundleHash",
        "researchCards",
        "rollbackCondition",
        "claimBoundary",
      ], label);
      const explorationEvent = boundedInteger(
        raw.eventSequence,
        1,
        eventSequence,
        `${label}.eventSequence`,
      );
      if (explorationEvent <= previousExplorationEvent) {
        throw new Error(
          "context.codeVersionHistory.explorations are not chronological",
        );
      }
      previousExplorationEvent = explorationEvent;
      const historyId = (item: unknown, field: string): string => {
        if (typeof item !== "string" || !SAFE_HISTORY_ID.test(item)) {
          throw new Error(`${label}.${field} is invalid`);
        }
        return item;
      };
      const rawHash = (item: unknown, field: string): string => {
        if (typeof item !== "string" || !RAW_SHA256.test(item)) {
          throw new Error(`${label}.${field} is invalid`);
        }
        return item;
      };
      const boundedTextArray = (
        item: unknown,
        field: string,
        maximumItems: number,
        maximumLength: number,
      ): string[] => {
        if (!Array.isArray(item) || item.length < 1
          || item.length > maximumItems
          || new Set(item).size !== item.length) {
          throw new Error(`${label}.${field} is not a bounded unique array`);
        }
        item.forEach((entry, entryIndex) =>
          safePublicText(
            entry,
            `${label}.${field}[${entryIndex}]`,
            maximumLength,
          ));
        return [...item] as string[];
      };
      const explorationId = historyId(
        raw.explorationId,
        "explorationId",
      );
      const sourceVersionId = historyId(
        raw.sourceVersionId,
        "sourceVersionId",
      );
      const sourceEvaluationId = historyId(
        raw.sourceEvaluationId,
        "sourceEvaluationId",
      );
      const baseVersionId = historyId(
        raw.baseVersionId,
        "baseVersionId",
      );
      if (!records.some((record) =>
        record.evaluationId === sourceEvaluationId
        && record.versionId === sourceVersionId
        && record.eventSequence < explorationEvent)) {
        throw new Error(
          `${label} does not follow its public evaluation record`,
        );
      }
      enumValue(
        raw.action,
        ["proceed", "stop"] as const,
        `${label}.action`,
      );
      let plannedVersionId: string | null = null;
      if (raw.action === "proceed") {
        plannedVersionId = historyId(
          raw.plannedVersionId,
          "plannedVersionId",
        );
      } else if (raw.plannedVersionId !== null) {
        throw new Error(`${label}.stop must not name a planned version`);
      }
      if (!isRecord(raw.teacherDistillation)) {
        throw new Error(`${label}.teacherDistillation is invalid`);
      }
      exactKeys(raw.teacherDistillation, [
        "proteinEvaluation",
        "hypothesisVerdict",
        "mechanismVerdict",
        "diagnoses",
        "prioritizedActions",
      ], `${label}.teacherDistillation`);
      if (typeof raw.teacherDistillation.proteinEvaluation !== "boolean") {
        throw new Error(
          `${label}.teacherDistillation.proteinEvaluation is invalid`,
        );
      }
      const proteinEvaluation =
        raw.teacherDistillation.proteinEvaluation;
      if (proteinEvaluation) {
        enumValue(
          raw.teacherDistillation.hypothesisVerdict,
          CAUSAL_HYPOTHESIS_VERDICTS,
          `${label}.teacherDistillation.hypothesisVerdict`,
        );
        enumValue(
          raw.teacherDistillation.mechanismVerdict,
          CAUSAL_MECHANISM_VERDICTS,
          `${label}.teacherDistillation.mechanismVerdict`,
        );
      } else if (raw.teacherDistillation.hypothesisVerdict !== null
        || raw.teacherDistillation.mechanismVerdict !== null) {
        throw new Error(
          `${label}.non-protein Teacher verdicts must be null`,
        );
      }
      const diagnoses = uniqueEnumArray(
        raw.teacherDistillation.diagnoses,
        CAUSAL_DIAGNOSES,
        `${label}.teacherDistillation.diagnoses`,
      );
      const prioritizedActions = uniqueEnumArray(
        raw.teacherDistillation.prioritizedActions,
        CAUSAL_ACTIONS,
        `${label}.teacherDistillation.prioritizedActions`,
      );
      if (!proteinEvaluation
        && (diagnoses.length > 0 || prioritizedActions.length > 0)) {
        throw new Error(
          `${label}.non-protein Teacher distillation must be empty`,
        );
      }
      safePublicText(
        raw.problemAssessment,
        `${label}.problemAssessment`,
        1000,
      );
      const problemCodes = uniqueEnumArray(
        raw.problemCodes,
        RSI_EXPLORATION_PROBLEM_CODES,
        `${label}.problemCodes`,
      );
      safePublicText(raw.hypothesis, `${label}.hypothesis`, 1000);
      safePublicText(
        raw.plannedChangeSummary,
        `${label}.plannedChangeSummary`,
        1000,
      );
      const codeChangeTargets = boundedTextArray(
        raw.codeChangeTargets,
        "codeChangeTargets",
        16,
        400,
      );
      const controls = boundedTextArray(
        raw.controls,
        "controls",
        16,
        400,
      );
      if (!isRecord(raw.expectedEffects)) {
        throw new Error(`${label}.expectedEffects is invalid`);
      }
      const effectKeys = [
        "overall",
        "molecularFunction",
        "biologicalProcess",
        "cellularComponent",
      ] as const;
      exactKeys(
        raw.expectedEffects,
        [...effectKeys],
        `${label}.expectedEffects`,
      );
      for (const key of effectKeys) {
        enumValue(
          raw.expectedEffects[key],
          ["improve", "hold", "not_targeted"] as const,
          `${label}.expectedEffects.${key}`,
        );
      }
      if (!isRecord(raw.experiment)) {
        throw new Error(`${label}.experiment is invalid`);
      }
      exactKeys(raw.experiment, [
        "component",
        "strategy",
        "requiredCapabilities",
        "falsifiers",
      ], `${label}.experiment`);
      enumValue(
        raw.experiment.component,
        RSI_EXPLORATION_COMPONENTS,
        `${label}.experiment.component`,
      );
      safePublicText(
        raw.experiment.strategy,
        `${label}.experiment.strategy`,
        1000,
      );
      if (!Array.isArray(raw.experiment.requiredCapabilities)
        || raw.experiment.requiredCapabilities.length < 1
        || raw.experiment.requiredCapabilities.length > 16
        || new Set(raw.experiment.requiredCapabilities).size
          !== raw.experiment.requiredCapabilities.length
        || raw.experiment.requiredCapabilities.some((item) =>
          typeof item !== "string" || !SAFE_DEVELOPER_ID.test(item))) {
        throw new Error(
          `${label}.experiment.requiredCapabilities is invalid`,
        );
      }
      const falsifiers = boundedTextArray(
        raw.experiment.falsifiers,
        "experiment.falsifiers",
        16,
        400,
      );
      if (!Array.isArray(raw.researchCards)
        || raw.researchCards.length > 32) {
        throw new Error(`${label}.researchCards is invalid`);
      }
      const researchCards = raw.researchCards.map(
        (card, cardIndex): RsiExplorationResearchCard => {
          const cardLabel = `${label}.researchCards[${cardIndex}]`;
          if (!isRecord(card)) {
            throw new Error(`${cardLabel} must be an object`);
          }
          exactKeys(card, [
            "evidenceId",
            "finding",
            "limitations",
            "supportedComponents",
          ], cardLabel);
          if (typeof card.evidenceId !== "string"
            || !EVIDENCE_ID.test(card.evidenceId)) {
            throw new Error(`${cardLabel}.evidenceId is invalid`);
          }
          safePublicText(card.finding, `${cardLabel}.finding`, 1600);
          const limitations = boundedTextArray(
            card.limitations,
            `researchCards[${cardIndex}].limitations`,
            8,
            400,
          );
          const supportedComponents = uniqueEnumArray(
            card.supportedComponents,
            RSI_EXPLORATION_COMPONENTS,
            `${cardLabel}.supportedComponents`,
          );
          return {
            evidenceId: card.evidenceId,
            finding: card.finding,
            limitations,
            supportedComponents,
          };
        },
      );
      if (new Set(researchCards.map((card) => card.evidenceId)).size
        !== researchCards.length) {
        throw new Error(`${label}.researchCards IDs are not unique`);
      }
      safePublicText(
        raw.rollbackCondition,
        `${label}.rollbackCondition`,
        1000,
      );
      safePublicText(
        raw.claimBoundary,
        `${label}.claimBoundary`,
        1000,
      );
      return {
        eventSequence: explorationEvent,
        explorationId,
        sourceVersionId,
        sourceEvaluationId,
        baseVersionId,
        manifestHash: rawHash(raw.manifestHash, "manifestHash"),
        evaluationAnalysisHash: rawHash(
          raw.evaluationAnalysisHash,
          "evaluationAnalysisHash",
        ),
        planHash: rawHash(raw.planHash, "planHash"),
        action: raw.action,
        plannedVersionId,
        teacherDistillation: {
          proteinEvaluation,
          hypothesisVerdict:
            raw.teacherDistillation.hypothesisVerdict,
          mechanismVerdict:
            raw.teacherDistillation.mechanismVerdict,
          diagnoses,
          prioritizedActions,
        },
        problemAssessment: raw.problemAssessment,
        problemCodes,
        hypothesis: raw.hypothesis,
        plannedChangeSummary: raw.plannedChangeSummary,
        codeChangeTargets,
        controls,
        expectedEffects: {
          overall: raw.expectedEffects.overall as RsiExpectedEffect,
          molecularFunction:
            raw.expectedEffects.molecularFunction as RsiExpectedEffect,
          biologicalProcess:
            raw.expectedEffects.biologicalProcess as RsiExpectedEffect,
          cellularComponent:
            raw.expectedEffects.cellularComponent as RsiExpectedEffect,
        },
        experiment: {
          component: raw.experiment.component,
          strategy: raw.experiment.strategy,
          requiredCapabilities: [
            ...raw.experiment.requiredCapabilities,
          ] as string[],
          falsifiers,
        },
        researchCardBundleHash: rawHash(
          raw.researchCardBundleHash,
          "researchCardBundleHash",
        ),
        researchCards,
        rollbackCondition: raw.rollbackCondition,
        claimBoundary: raw.claimBoundary,
      };
    },
  );
  let retrospectiveRecords:
    NonNullable<
      NonNullable<
        MethodDevelopmentContext["codeVersionHistory"]
      >["retrospectiveRecords"]
    > = [];
  if (historySchemaVersion !== "pi-rsi-developer-history-context.v1") {
    if (!Array.isArray(value.retrospectiveRecords)
      || (historySchemaVersion === "pi-rsi-developer-history-context.v2"
        && value.retrospectiveRecords.length < 1)
      || value.retrospectiveRecords.length > 128) {
      throw new Error(
        "context.codeVersionHistory.retrospectiveRecords must be a non-empty bounded array",
      );
    }
    const seenRecordIds = new Set<string>();
    let previousRetrospectiveEvent = 0;
    const retrospectiveClaimBoundary =
      "Retrospective post-hoc aggregate observation only; not a prospectively registered RSI code version or evaluation, not eligible to update formal selection, and not evidence for promotion." as const;
    retrospectiveRecords = value.retrospectiveRecords.map(
      (raw, index):
        NonNullable<
          NonNullable<
            MethodDevelopmentContext["codeVersionHistory"]
          >["retrospectiveRecords"]
        >[number] => {
        const label =
          `context.codeVersionHistory.retrospectiveRecords[${index}]`;
        if (!isRecord(raw)) throw new Error(`${label} must be an object`);
        exactKeys(raw, [
          "eventSequence",
          "recordId",
          "manifestHash",
          "evaluatedSource",
          "receipt",
          "formalSelectedVersionId",
          "changeSummary",
          "hypothesis",
          "component",
          "observations",
          "diagnoses",
          "prioritizedActions",
          "localGateOutcome",
          "archiveSealHash",
          "archivePublicManifestHash",
          "evidenceTiming",
          "selectionEligibility",
          "promotionEligibility",
          "claimBoundary",
        ], label);
        const recordEvent = boundedInteger(
          raw.eventSequence,
          1,
          eventSequence,
          `${label}.eventSequence`,
        );
        if (recordEvent <= previousRetrospectiveEvent) {
          throw new Error(
            "context.codeVersionHistory.retrospectiveRecords are not chronological",
          );
        }
        previousRetrospectiveEvent = recordEvent;
        if (typeof raw.recordId !== "string"
          || !SAFE_HISTORY_ID.test(raw.recordId)
          || seenRecordIds.has(raw.recordId)) {
          throw new Error(`${label}.recordId is invalid or duplicated`);
        }
        seenRecordIds.add(raw.recordId);
        const rawHash = (item: unknown, field: string): string => {
          if (typeof item !== "string" || !RAW_SHA256.test(item)) {
            throw new Error(`${label}.${field} is invalid`);
          }
          return item;
        };
        const gitObjectId = (item: unknown, field: string): string => {
          if (typeof item !== "string" || !GIT_OBJECT_ID.test(item)) {
            throw new Error(`${label}.${field} is invalid`);
          }
          return item;
        };
        if (!isRecord(raw.evaluatedSource)) {
          throw new Error(`${label}.evaluatedSource is invalid`);
        }
        exactKeys(
          raw.evaluatedSource,
          ["sourceCommit", "sourceTree"],
          `${label}.evaluatedSource`,
        );
        const evaluatedSource = {
          sourceCommit: gitObjectId(
            raw.evaluatedSource.sourceCommit,
            "evaluatedSource.sourceCommit",
          ),
          sourceTree: gitObjectId(
            raw.evaluatedSource.sourceTree,
            "evaluatedSource.sourceTree",
          ),
        };
        if (!isRecord(raw.receipt)) {
          throw new Error(`${label}.receipt is invalid`);
        }
        exactKeys(
          raw.receipt,
          [
            "relativePath",
            "blobObjectId",
            "fileSha256",
            "canonicalHash",
          ],
          `${label}.receipt`,
        );
        if (typeof raw.receipt.relativePath !== "string"
          || raw.receipt.relativePath.length > 512
          || !SAFE_HISTORY_PATH.test(raw.receipt.relativePath)) {
          throw new Error(`${label}.receipt.relativePath is invalid`);
        }
        const receipt = {
          relativePath: raw.receipt.relativePath,
          blobObjectId: gitObjectId(
            raw.receipt.blobObjectId,
            "receipt.blobObjectId",
          ),
          fileSha256: rawHash(
            raw.receipt.fileSha256,
            "receipt.fileSha256",
          ),
          canonicalHash: rawHash(
            raw.receipt.canonicalHash,
            "receipt.canonicalHash",
          ),
        };
        if (typeof raw.formalSelectedVersionId !== "string"
          || !SAFE_HISTORY_ID.test(raw.formalSelectedVersionId)) {
          throw new Error(`${label}.formalSelectedVersionId is invalid`);
        }
        safePublicText(
          raw.changeSummary,
          `${label}.changeSummary`,
          1000,
        );
        safePublicText(raw.hypothesis, `${label}.hypothesis`, 1000);
        enumValue(
          raw.component,
          RSI_EXPLORATION_COMPONENTS,
          `${label}.component`,
        );
        if (!Array.isArray(raw.observations)
          || raw.observations.length < 1
          || raw.observations.length > 32) {
          throw new Error(`${label}.observations must be a bounded array`);
        }
        const seenObservationIds = new Set<string>();
        const observations = raw.observations.map(
          (observation, observationIndex) => {
            const observationLabel =
              `${label}.observations[${observationIndex}]`;
            if (!isRecord(observation)) {
              throw new Error(`${observationLabel} must be an object`);
            }
            exactKeys(observation, [
              "observationId",
              "cohortRole",
              "metric",
              "baseline",
              "candidate",
              "candidateMinusBaseline",
              "interpretation",
            ], observationLabel);
            if (typeof observation.observationId !== "string"
              || !SAFE_HISTORY_ID.test(observation.observationId)
              || seenObservationIds.has(observation.observationId)) {
              throw new Error(
                `${observationLabel}.observationId is invalid or duplicated`,
              );
            }
            seenObservationIds.add(observation.observationId);
            enumValue(
              observation.cohortRole,
              [
                "development",
                "calibration",
                "development_calibration",
                "selection",
                "test",
                "all_descriptive",
              ] as const,
              `${observationLabel}.cohortRole`,
            );
            if (observation.metric !== "fmax") {
              throw new Error(`${observationLabel}.metric is invalid`);
            }
            const unitMetric = (
              metric: unknown,
              field: string,
            ): number => {
              if (typeof metric !== "number"
                || !Number.isFinite(metric)
                || metric < 0
                || metric > 1) {
                throw new Error(
                  `${observationLabel}.${field} must be a finite 0-1 value`,
                );
              }
              return metric;
            };
            const baseline = unitMetric(
              observation.baseline,
              "baseline",
            );
            const candidate = unitMetric(
              observation.candidate,
              "candidate",
            );
            if (typeof observation.candidateMinusBaseline !== "number"
              || !Number.isFinite(observation.candidateMinusBaseline)
              || observation.candidateMinusBaseline < -1
              || observation.candidateMinusBaseline > 1
              || Math.abs(
                observation.candidateMinusBaseline
                  - (candidate - baseline),
              ) > 1e-12) {
              throw new Error(
                `${observationLabel}.candidateMinusBaseline is inconsistent`,
              );
            }
            enumValue(
              observation.interpretation,
              [
                "development_signal",
                "selection_gate",
                "descriptive_only",
              ] as const,
              `${observationLabel}.interpretation`,
            );
            return {
              observationId: observation.observationId,
              cohortRole: observation.cohortRole,
              metric: "fmax" as const,
              baseline,
              candidate,
              candidateMinusBaseline:
                observation.candidateMinusBaseline,
              interpretation: observation.interpretation,
            };
          },
        );
        const diagnoses = uniqueEnumArray(
          raw.diagnoses,
          CAUSAL_DIAGNOSES,
          `${label}.diagnoses`,
          32,
        );
        const prioritizedActions = uniqueEnumArray(
          raw.prioritizedActions,
          CAUSAL_ACTIONS,
          `${label}.prioritizedActions`,
          32,
        );
        enumValue(
          raw.localGateOutcome,
          [
            "retain_experiment_control",
            "prefer_experiment_candidate",
            "inconclusive",
          ] as const,
          `${label}.localGateOutcome`,
        );
        if (raw.evidenceTiming
            !== "retrospective_post_hoc_without_pre_evaluation_opening"
          || raw.selectionEligibility
            !== "ineligible_never_updates_selected_version"
          || raw.promotionEligibility
            !== "ineligible_not_prospective_evidence"
          || raw.claimBoundary !== retrospectiveClaimBoundary) {
          throw new Error(
            `${label} weakens the retrospective eligibility boundary`,
          );
        }
        return {
          eventSequence: recordEvent,
          recordId: raw.recordId,
          manifestHash: rawHash(raw.manifestHash, "manifestHash"),
          evaluatedSource,
          receipt,
          formalSelectedVersionId: raw.formalSelectedVersionId,
          changeSummary: raw.changeSummary,
          hypothesis: raw.hypothesis,
          component: raw.component,
          observations,
          diagnoses,
          prioritizedActions,
          localGateOutcome: raw.localGateOutcome,
          archiveSealHash: rawHash(
            raw.archiveSealHash,
            "archiveSealHash",
          ),
          archivePublicManifestHash: rawHash(
            raw.archivePublicManifestHash,
            "archivePublicManifestHash",
          ),
          evidenceTiming: raw.evidenceTiming,
          selectionEligibility: raw.selectionEligibility,
          promotionEligibility: raw.promotionEligibility,
          claimBoundary: raw.claimBoundary,
        };
      },
    );
  }
  let retrospectiveIncumbents:
    NonNullable<
      NonNullable<
        MethodDevelopmentContext["codeVersionHistory"]
      >["retrospectiveIncumbents"]
    > = [];
  let operationalIncumbentVersionId: string | undefined;
  let currentBestVersionId: string | undefined;
  let lastProspectivelySelectedVersionId: string | undefined;
  if (historySchemaVersion === "pi-rsi-developer-history-context.v3"
    || historySchemaVersion === "pi-rsi-developer-history-context.v4") {
    if (!Array.isArray(value.retrospectiveIncumbents)
      || value.retrospectiveIncumbents.length < 1
      || value.retrospectiveIncumbents.length > 128) {
      throw new Error(
        "context.codeVersionHistory.retrospectiveIncumbents must be a non-empty bounded array",
      );
    }
    const rawCurrentBestVersionId = historySchemaVersion
        === "pi-rsi-developer-history-context.v4"
      ? value.currentBestVersionId
      : value.operationalIncumbentVersionId;
    if (typeof rawCurrentBestVersionId !== "string"
      || !SAFE_HISTORY_ID.test(
        rawCurrentBestVersionId,
      )) {
      throw new Error(
        "context.codeVersionHistory current-best version is invalid",
      );
    }
    currentBestVersionId = rawCurrentBestVersionId;
    if (historySchemaVersion === "pi-rsi-developer-history-context.v3") {
      operationalIncumbentVersionId = rawCurrentBestVersionId;
    } else {
      if (typeof value.lastProspectivelySelectedVersionId !== "string"
        || !SAFE_HISTORY_ID.test(
          value.lastProspectivelySelectedVersionId,
        )
        || value.lastProspectivelySelectedVersionId
          !== value.graphHead.selectedVersionId) {
        throw new Error(
          "context.codeVersionHistory last prospective selection is invalid",
        );
      }
      lastProspectivelySelectedVersionId =
        value.lastProspectivelySelectedVersionId;
    }
    const seenAdoptionIds = new Set<string>();
    const seenIncumbentVersionIds = new Set<string>();
    let previousAdoptionEvent = 0;
    const adoptionClaimBoundary =
      "Retrospective incumbent adoption changes the operational development baseline only; formal prospective selection remains unchanged, the adopted version remains prospectively unevaluated, and all future promotion claims require a fresh prospective opening." as const;
    const evidenceClaimBoundary =
      "Priority100 development/regression evidence with one procedural holdout; not a temporal blind benchmark or publication-grade generalization claim.";
    retrospectiveIncumbents = value.retrospectiveIncumbents.map(
      (raw, index):
        NonNullable<
          NonNullable<
            MethodDevelopmentContext["codeVersionHistory"]
          >["retrospectiveIncumbents"]
        >[number] => {
        const label =
          `context.codeVersionHistory.retrospectiveIncumbents[${index}]`;
        if (!isRecord(raw)) throw new Error(`${label} must be an object`);
        exactKeys(raw, [
          "eventSequence",
          "adoptionId",
          "manifestHash",
          "selectedVersionId",
          "operationalIncumbentVersionId",
          "evidence",
          "plannedVersionId",
          "planHash",
          "claimBoundary",
        ], label);
        const adoptionEvent = boundedInteger(
          raw.eventSequence,
          1,
          eventSequence,
          `${label}.eventSequence`,
        );
        if (adoptionEvent <= previousAdoptionEvent) {
          throw new Error(
            "context.codeVersionHistory.retrospectiveIncumbents are not chronological",
          );
        }
        previousAdoptionEvent = adoptionEvent;
        for (const field of [
          "adoptionId",
          "selectedVersionId",
          "operationalIncumbentVersionId",
          "plannedVersionId",
        ] as const) {
          if (typeof raw[field] !== "string"
            || !SAFE_HISTORY_ID.test(raw[field] as string)) {
            throw new Error(`${label}.${field} is invalid`);
          }
        }
        if (seenAdoptionIds.has(raw.adoptionId as string)
          || seenIncumbentVersionIds.has(
            raw.operationalIncumbentVersionId as string,
          )) {
          throw new Error(
            `${label} repeats an adoption or incumbent version`,
          );
        }
        seenAdoptionIds.add(raw.adoptionId as string);
        seenIncumbentVersionIds.add(
          raw.operationalIncumbentVersionId as string,
        );
        const rawHash = (item: unknown, field: string): string => {
          if (typeof item !== "string" || !RAW_SHA256.test(item)) {
            throw new Error(`${label}.${field} is invalid`);
          }
          return item;
        };
        if (!isRecord(raw.evidence)) {
          throw new Error(`${label}.evidence must be an object`);
        }
        const evidence = raw.evidence;
        exactKeys(evidence, [
          "suiteId",
          "reportPath",
          "reportSha256",
          "reportBlobObjectId",
          "cohort",
          "metric",
          "selectedVariantId",
          "selectionOverallFmax",
          "testOverallFmax",
          "artifactCanonicalHashes",
          "claimBoundary",
        ], `${label}.evidence`);
        if (typeof evidence.suiteId !== "string"
          || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(
            evidence.suiteId,
          )
          || typeof evidence.selectedVariantId !== "string"
          || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(
            evidence.selectedVariantId,
          )
          || typeof evidence.reportPath !== "string"
          || evidence.reportPath.length > 512
          || !SAFE_HISTORY_PATH.test(evidence.reportPath)
          || typeof evidence.reportSha256 !== "string"
          || !RAW_SHA256.test(evidence.reportSha256)
          || typeof evidence.reportBlobObjectId !== "string"
          || !GIT_OBJECT_ID.test(evidence.reportBlobObjectId)
          || evidence.metric
            !== "hierarchical_protein_centric_fmax_v1"
          || evidence.claimBoundary !== evidenceClaimBoundary) {
          throw new Error(`${label}.evidence identity is invalid`);
        }
        if (!isRecord(evidence.cohort)) {
          throw new Error(`${label}.evidence.cohort is invalid`);
        }
        exactKeys(
          evidence.cohort,
          ["development", "calibration", "selection", "test", "total"],
          `${label}.evidence.cohort`,
        );
        if (evidence.cohort.development !== 40
          || evidence.cohort.calibration !== 20
          || evidence.cohort.selection !== 20
          || evidence.cohort.test !== 20
          || evidence.cohort.total !== 100) {
          throw new Error(`${label}.evidence.cohort is invalid`);
        }
        const comparison = (
          item: unknown,
          field: string,
        ): Record<string, unknown> => {
          if (!isRecord(item)) {
            throw new Error(`${label}.evidence.${field} is invalid`);
          }
          exactKeys(
            item,
            ["baseline", "candidate", "candidateMinusBaseline"],
            `${label}.evidence.${field}`,
          );
          const baseline = item.baseline;
          const candidate = item.candidate;
          const delta = item.candidateMinusBaseline;
          if (typeof baseline !== "number"
            || typeof candidate !== "number"
            || typeof delta !== "number"
            || !Number.isFinite(baseline)
            || !Number.isFinite(candidate)
            || !Number.isFinite(delta)
            || baseline < 0 || baseline > 1
            || candidate < 0 || candidate > 1
            || Math.abs(delta - (candidate - baseline)) > 1e-9) {
            throw new Error(
              `${label}.evidence.${field} is inconsistent`,
            );
          }
          return { baseline, candidate, candidateMinusBaseline: delta };
        };
        const selectionOverallFmax = comparison(
          evidence.selectionOverallFmax,
          "selectionOverallFmax",
        );
        const testOverallFmax = comparison(
          evidence.testOverallFmax,
          "testOverallFmax",
        );
        if (!isRecord(evidence.artifactCanonicalHashes)) {
          throw new Error(
            `${label}.evidence.artifactCanonicalHashes is invalid`,
          );
        }
        exactKeys(
          evidence.artifactCanonicalHashes,
          ["opening", "finalist", "testOpening", "publicSummary"],
          `${label}.evidence.artifactCanonicalHashes`,
        );
        const rawArtifactHashes =
          evidence.artifactCanonicalHashes as Record<string, unknown>;
        const artifactCanonicalHashes = Object.fromEntries(
          ["opening", "finalist", "testOpening", "publicSummary"].map(
            (field) => [
              field,
              rawHash(
                rawArtifactHashes[field],
                `evidence.artifactCanonicalHashes.${field}`,
              ),
            ],
          ),
        );
        if (raw.claimBoundary !== adoptionClaimBoundary) {
          throw new Error(
            `${label} weakens the retrospective incumbent boundary`,
          );
        }
        return {
          eventSequence: adoptionEvent,
          adoptionId: raw.adoptionId as string,
          manifestHash: rawHash(raw.manifestHash, "manifestHash"),
          selectedVersionId: raw.selectedVersionId as string,
          operationalIncumbentVersionId:
            raw.operationalIncumbentVersionId as string,
          evidence: {
            suiteId: evidence.suiteId,
            reportPath: evidence.reportPath,
            reportSha256: evidence.reportSha256,
            reportBlobObjectId: evidence.reportBlobObjectId,
            cohort: structuredClone(evidence.cohort),
            metric: evidence.metric,
            selectedVariantId: evidence.selectedVariantId,
            selectionOverallFmax,
            testOverallFmax,
            artifactCanonicalHashes,
            claimBoundary: evidence.claimBoundary,
          },
          plannedVersionId: raw.plannedVersionId as string,
          planHash: rawHash(raw.planHash, "planHash"),
          claimBoundary: adoptionClaimBoundary,
        };
      },
    );
    if (retrospectiveIncumbents.at(-1)
        ?.operationalIncumbentVersionId
      !== currentBestVersionId) {
      throw new Error(
        "context.codeVersionHistory operational incumbent does not match its latest adoption",
      );
    }
  }
  if (typeof value.canonicalHash !== "string"
    || !RAW_SHA256.test(value.canonicalHash)) {
    throw new Error("context.codeVersionHistory.canonicalHash is invalid");
  }
  const commonContent = {
    graphHead: {
      eventSequence,
      eventManifestHash: value.graphHead.eventManifestHash,
      selectedVersionId: value.graphHead.selectedVersionId,
    },
    records,
    explorations,
  };
  const content:
    Omit<
      NonNullable<MethodDevelopmentContext["codeVersionHistory"]>,
      "canonicalHash"
    > = historySchemaVersion === "pi-rsi-developer-history-context.v4"
    ? {
      schemaVersion: historySchemaVersion,
      ...commonContent,
      retrospectiveRecords,
      retrospectiveIncumbents,
      currentBestVersionId,
      lastProspectivelySelectedVersionId,
    }
    : historySchemaVersion === "pi-rsi-developer-history-context.v3"
    ? {
      schemaVersion: historySchemaVersion,
      ...commonContent,
      retrospectiveRecords,
      retrospectiveIncumbents,
      operationalIncumbentVersionId,
    }
    : historySchemaVersion === "pi-rsi-developer-history-context.v2"
    ? {
      schemaVersion: historySchemaVersion,
      ...commonContent,
      retrospectiveRecords,
    }
    : {
      schemaVersion: historySchemaVersion,
      ...commonContent,
    };
  if (value.canonicalHash !== hashCanonical(content)) {
    throw new Error("context.codeVersionHistory canonical hash is invalid");
  }
  return {
    ...content,
    canonicalHash: value.canonicalHash,
  };
}

function validateContext(value: unknown): MethodDevelopmentContext {
  if (!isRecord(value)) throw new Error("context must be an object");
  if (value.schemaVersion !== "pi-method-development-context.v1"
    && value.schemaVersion !== "pi-method-development-context.v2") {
    throw new Error("unsupported context schema");
  }
  exactKeys(
    value,
    value.schemaVersion === "pi-method-development-context.v2"
      ? ["schemaVersion", "objective", "position", "history", "codeVersionHistory"]
      : ["schemaVersion", "objective", "position", "history"],
    "context",
  );
  enumValue(value.objective, METHOD_DEVELOPMENT_OBJECTIVES, "context.objective");
  if (!isRecord(value.position)) throw new Error("context.position must be an object");
  exactKeys(value.position, ["round", "maximumRounds", "completedRounds", "retainedParent"], "context.position");
  const maximumRounds = boundedInteger(value.position.maximumRounds, 1, 64, "context.position.maximumRounds");
  const completedRounds = boundedInteger(value.position.completedRounds, 0, maximumRounds, "context.position.completedRounds");
  const round = boundedInteger(value.position.round, 1, maximumRounds, "context.position.round");
  if (round !== completedRounds + 1) throw new Error("context.position.round must immediately follow completedRounds");
  enumValue(value.position.retainedParent, METHOD_RETAINED_PARENT_STATES, "context.position.retainedParent");
  if (!Array.isArray(value.history) || value.history.length > 128) throw new Error("context.history must be bounded");
  let previousRound = 0;
  const seen = new Set<string>();
  const history = value.history.map((raw, index): MethodDevelopmentContext["history"][number] => {
    if (!isRecord(raw)) throw new Error(`context.history[${index}] must be an object`);
    exactKeys(raw, ["round", "templateId", "family", "outcome"], `context.history[${index}]`);
    const historyRound = boundedInteger(raw.round, 1, completedRounds, `context.history[${index}].round`);
    if (historyRound < previousRound) throw new Error("context.history is not chronological");
    previousRound = historyRound;
    enumValue(raw.templateId, METHOD_EXPERIMENT_TEMPLATE_IDS, `context.history[${index}].templateId`);
    enumValue(raw.family, CAUSAL_TEACHER_FAMILIES, `context.history[${index}].family`);
    enumValue(raw.outcome, CAUSAL_TEACHER_DECISIONS, `context.history[${index}].outcome`);
    const canonical = CANONICAL_TEMPLATES.find((item) => item.templateId === raw.templateId)!;
    if (canonical.family !== raw.family) throw new Error(`context.history[${index}] has a mismatched family`);
    const key = `${historyRound}:${raw.templateId}`;
    if (seen.has(key)) throw new Error("context.history contains a duplicate round/template attempt");
    seen.add(key);
    return { round: historyRound, templateId: raw.templateId, family: raw.family, outcome: raw.outcome };
  });
  const context: MethodDevelopmentContext = {
    schemaVersion: value.schemaVersion,
    objective: value.objective,
    position: { round, maximumRounds, completedRounds, retainedParent: value.position.retainedParent },
    history,
  };
  if (value.schemaVersion === "pi-method-development-context.v2") {
    context.codeVersionHistory = validateCodeVersionHistory(
      value.codeVersionHistory,
    );
  }
  return context;
}

function validateResearchCards(
  value: unknown,
  registeredIds: ReadonlySet<MethodExperimentTemplateId>,
): SanitizedMethodResearchCard[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("researchCards must be a bounded array");
  const seen = new Set<string>();
  const cards = value.map((raw, index): SanitizedMethodResearchCard => {
    if (!isRecord(raw)) throw new Error(`researchCards[${index}] must be an object`);
    exactKeys(raw, ["evidenceId", "finding", "limitations", "supportedTemplateIds"], `researchCards[${index}]`);
    if (typeof raw.evidenceId !== "string" || !EVIDENCE_ID.test(raw.evidenceId) || seen.has(raw.evidenceId)) {
      throw new Error(`researchCards[${index}].evidenceId must be a unique opaque evidence ID`);
    }
    seen.add(raw.evidenceId);
    safePublicText(raw.finding, `researchCards[${index}].finding`, 1600);
    if (!Array.isArray(raw.limitations) || raw.limitations.length < 1 || raw.limitations.length > 8) {
      throw new Error(`researchCards[${index}].limitations must be a non-empty bounded array`);
    }
    raw.limitations.forEach((item, limitationIndex) =>
      safePublicText(item, `researchCards[${index}].limitations[${limitationIndex}]`, 800));
    const supportedTemplateIds = uniqueEnumArray(
      raw.supportedTemplateIds,
      METHOD_EXPERIMENT_TEMPLATE_IDS,
      `researchCards[${index}].supportedTemplateIds`,
    );
    if (supportedTemplateIds.length < 1 || supportedTemplateIds.some((id) => !registeredIds.has(id))) {
      throw new Error(`researchCards[${index}] supports a template outside the round registry`);
    }
    const canonicalIds = METHOD_EXPERIMENT_TEMPLATE_IDS.filter((id) => supportedTemplateIds.includes(id));
    if (JSON.stringify(canonicalIds) !== JSON.stringify(supportedTemplateIds)) {
      throw new Error(`researchCards[${index}].supportedTemplateIds are not in canonical order`);
    }
    return {
      evidenceId: raw.evidenceId,
      finding: raw.finding,
      limitations: [...raw.limitations] as string[],
      supportedTemplateIds,
    };
  });
  const canonical = [...cards].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  if (JSON.stringify(cards) !== JSON.stringify(canonical)) throw new Error("researchCards are not in evidence-ID order");
  return cards;
}

/**
 * Validate the exact sanitized external-research bundle independently of a
 * Teacher payload.  Outer harnesses use this before predictions run so a
 * proposal cannot cite an absent card or a method outside the executable
 * registry and only discover that mismatch after private labels have opened.
 */
export function validateSanitizedMethodResearchCards(
  value: unknown,
  registryInput: unknown,
): SanitizedMethodResearchCard[] {
  const registry = validateMethodExperimentRegistry(registryInput);
  return validateResearchCards(
    value,
    new Set(registry.templates.map((item) => item.templateId)),
  );
}

export function validateMethodDeveloperPayload(input: {
  feedback: unknown;
  context: unknown;
  researchCards: unknown;
  registry: unknown;
}): ValidatedMethodDeveloperPayload {
  if (!isRecord(input)) throw new Error("method developer payload must be an object");
  exactKeys(input as Record<string, unknown>, ["feedback", "context", "researchCards", "registry"], "method developer payload");
  const registry = validateMethodExperimentRegistry(input.registry);
  if (!Array.isArray(input.feedback) || input.feedback.length < 1 || input.feedback.length > 64) {
    throw new Error("feedback must be a non-empty bounded array");
  }
  const feedback = input.feedback.map(validateFeedback);
  const context = validateContext(input.context);
  const registeredIds = new Set(registry.templates.map((item) => item.templateId));
  const researchCards = validateResearchCards(input.researchCards, registeredIds);
  return { feedback, context, researchCards, registry };
}

/** Validate before serialization so private material cannot enter a Pi prompt. */
export function serializeMethodDeveloperPayload(input: {
  feedback: unknown;
  context: unknown;
  researchCards: unknown;
  registry: unknown;
}): string {
  return JSON.stringify(validateMethodDeveloperPayload(input));
}

function boundedMaxSelections(value: unknown): MethodDeveloperSelectionBudget {
  if (!(METHOD_DEVELOPER_SELECTION_BUDGETS as readonly unknown[]).includes(value)) {
    throw new Error("maxSelections must explicitly be one or two");
  }
  return value as MethodDeveloperSelectionBudget;
}

function trailingTemplateNoGain(context: MethodDevelopmentContext, templateId: MethodExperimentTemplateId): number {
  const localAttempts: Array<{
    outcome:
      | typeof CAUSAL_TEACHER_DECISIONS[number]
      | "passed"
      | "failed";
  }> = context.history.filter((item) => item.templateId === templateId);
  const publicVersionAttempts = context.codeVersionHistory?.records
    .filter((item) => item.method?.templateId === templateId) ?? [];
  const trailing = (
    attempts: ReadonlyArray<{
      outcome:
        | typeof CAUSAL_TEACHER_DECISIONS[number]
        | "passed"
        | "failed";
    }>,
  ): number => {
    let count = 0;
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      if (["selected_successor", "eligible_ranked_lower"].includes(
        attempts[index].outcome,
      )) break;
      count += 1;
    }
    return count;
  };
  // The public and campaign-local views can overlap, but either can also
  // contain legacy attempts absent from the other. Taking the maximum keeps
  // exhaustion fail-closed without double-counting a duplicated round.
  return Math.max(
    trailing(localAttempts),
    trailing(publicVersionAttempts),
  );
}

function feasibleTemplates(payload: ValidatedMethodDeveloperPayload): MethodExperimentTemplate[] {
  return payload.registry.templates.filter((template) =>
    // A saturated family forbids another same-mechanism retry, not a
    // materially novel predictor/source/router/calibrator/pipeline repair.
    // Exact template exhaustion remains fail-closed through method history.
    trailingTemplateNoGain(payload.context, template.templateId) < 2);
}

function hasAction(feedback: readonly OptimizationCausalTeacherFeedback[], action: CausalAction): boolean {
  return feedback.some((item) => item.prioritizedActions.includes(action));
}

function hasHistoricalAction(
  context: MethodDevelopmentContext,
  action: CausalAction,
): boolean {
  const history = context.codeVersionHistory;
  return history?.records.some(
    (item) => item.teacher?.prioritizedActions.includes(action),
  )
    || history?.retrospectiveRecords?.some(
      (item) => item.prioritizedActions.includes(action),
    )
    || false;
}

function hasTriggeredFalsifier(
  feedback: readonly OptimizationCausalTeacherFeedback[],
  code: typeof CAUSAL_FALSIFIER_CODES[number],
): boolean {
  return feedback.some((item) => item.falsifierResults.some((result) =>
    result.code === code && result.status === "triggered"));
}

function rationaleForTemplate(
  templateId: MethodExperimentTemplateId,
  payload: ValidatedMethodDeveloperPayload,
): MethodRationaleCode[] {
  const rationales: MethodRationaleCode[] = [PRIMARY_RATIONALE[templateId]];
  if (payload.feedback.some((item) =>
    item.consecutiveSameMechanismNoGain >= 2 || item.forbiddenExhaustedMechanisms.length > 0)) {
    rationales.push("switch_saturated_mechanism");
  }
  if (payload.researchCards.some((card) => card.supportedTemplateIds.includes(templateId))) {
    rationales.push("public_method_support");
  }
  return METHOD_RATIONALE_CODES.filter((code) => rationales.includes(code));
}

export function buildDeterministicMethodSelection(input: {
  feedback: unknown;
  context: unknown;
  researchCards: unknown;
  registry: unknown;
  maxSelections: MethodDeveloperSelectionBudget;
}): MethodDeveloperSelection {
  const payload = validateMethodDeveloperPayload({
    feedback: input.feedback,
    context: input.context,
    researchCards: input.researchCards,
    registry: input.registry,
  });
  const maxSelections = boundedMaxSelections(input.maxSelections);
  const feasible = feasibleTemplates(payload);
  const score = new Map<MethodExperimentTemplateId, number>(feasible.map((template) => [template.templateId, 0]));
  const add = (templateId: MethodExperimentTemplateId, points: number): void => {
    if (score.has(templateId)) score.set(templateId, score.get(templateId)! + points);
  };

  if (hasTriggeredFalsifier(payload.feedback, "pipeline_invariant_violation")
    || payload.feedback.some((item) => item.pipelineInvariant !== "not_applicable" && item.pipelineInvariant !== "satisfied")
    || hasAction(payload.feedback, "repair_pipeline_invariant")
    || hasHistoricalAction(payload.context, "repair_pipeline_invariant")) {
    add("repair_learned_channel_pipeline", 100);
  }
  if (hasTriggeredFalsifier(payload.feedback, "populated_aspect_regression")
    || payload.feedback.some((item) => item.mechanismVerdict === "cross_aspect_interference")
    || hasAction(payload.feedback, "add_new_router")
    || hasAction(payload.feedback, "isolate_effective_aspect_path")
    || hasHistoricalAction(payload.context, "add_new_router")
    || hasHistoricalAction(payload.context, "isolate_effective_aspect_path")) {
    add("route_learned_signal_by_aspect", 80);
  }
  if (hasTriggeredFalsifier(payload.feedback, "precision_recall_tradeoff")
    || payload.feedback.some((item) => item.mechanismVerdict === "localized_gain_precision_tradeoff")
    || hasAction(payload.feedback, "add_new_calibrator")
    || hasHistoricalAction(payload.context, "add_new_calibrator")) {
    add("calibrate_sources_grouped_oof_by_aspect", 90);
  }
  if (hasTriggeredFalsifier(payload.feedback, "method_channel_inactive")
    || hasAction(payload.feedback, "activate_method_channel")
    || hasHistoricalAction(payload.context, "activate_method_channel")
    || payload.feedback.some((item) => item.activationBand === "inactive")) {
    add("compare_mdeepfri_gcn_vs_cnn", 50);
  }
  if (hasTriggeredFalsifier(payload.feedback, "no_material_overall_gain")
    || hasAction(payload.feedback, "change_predictor_or_information_source")
    || hasHistoricalAction(
      payload.context,
      "change_predictor_or_information_source",
    )
    || payload.feedback.some((item) => ["no_material_effect", "general_regression"].includes(item.mechanismVerdict))) {
    add("add_ontology_decoder_source", 60);
    add("compare_mdeepfri_gcn_vs_cnn", 55);
  }
  for (const card of payload.researchCards) {
    for (const templateId of card.supportedTemplateIds) add(templateId, 5);
  }
  const lastCodeVersion = payload.context.codeVersionHistory?.records
    .filter((item) => item.method?.templateId != null)
    .at(-1);
  const rejectedTemplates = new Set<MethodExperimentTemplateId>();
  if (lastCodeVersion?.method?.templateId && [
      "reject_no_gain",
      "reject_aspect_guardrail",
      "reject_falsifier",
      "failed",
    ].includes(lastCodeVersion.outcome)) {
    rejectedTemplates.add(lastCodeVersion.method.templateId);
  }
  const lastLocal = payload.context.history.at(-1);
  if (lastLocal && [
      "reject_no_gain",
      "reject_aspect_guardrail",
      "reject_falsifier",
    ].includes(lastLocal.outcome)) {
    rejectedTemplates.add(lastLocal.templateId);
  }
  for (const templateId of rejectedTemplates) {
    add(templateId, -25);
  }

  const selected = feasible
    .filter((template) => (score.get(template.templateId) ?? 0) > 0)
    .sort((left, right) => {
      const difference = (score.get(right.templateId) ?? 0) - (score.get(left.templateId) ?? 0);
      if (difference !== 0) return difference;
      return METHOD_EXPERIMENT_TEMPLATE_IDS.indexOf(left.templateId)
        - METHOD_EXPERIMENT_TEMPLATE_IDS.indexOf(right.templateId);
    })
    .slice(0, maxSelections);
  return {
    selections: selected.map((template) => ({
      templateId: template.templateId,
      rationaleCodes: rationaleForTemplate(template.templateId, payload),
    })),
  };
}

function validateSelection(
  selection: unknown,
  payload: ValidatedMethodDeveloperPayload,
  maxSelections: number,
): MethodDeveloperSelection {
  if (!isRecord(selection)) throw new Error("method selection must be an object");
  exactKeys(selection, ["selections"], "method selection");
  if (!Array.isArray(selection.selections) || selection.selections.length > maxSelections) {
    throw new Error("method selection exceeds the selection budget");
  }
  const feasible = new Set(feasibleTemplates(payload).map((item) => item.templateId));
  const seen = new Set<string>();
  const selections = selection.selections.map((raw, index): MethodDeveloperSelection["selections"][number] => {
    if (!isRecord(raw)) throw new Error(`method selection ${index} must be an object`);
    exactKeys(raw, ["templateId", "rationaleCodes"], `method selection ${index}`);
    enumValue(raw.templateId, METHOD_EXPERIMENT_TEMPLATE_IDS, `method selection ${index}.templateId`);
    if (!feasible.has(raw.templateId)) {
      throw new Error(`method selection ${raw.templateId} is saturated, forbidden, or unregistered`);
    }
    if (seen.has(raw.templateId)) throw new Error("method selection repeats a template");
    seen.add(raw.templateId);
    const rationaleCodes = uniqueEnumArray(
      raw.rationaleCodes, METHOD_RATIONALE_CODES, `method selection ${index}.rationaleCodes`, 3,
    );
    if (!rationaleCodes.includes(PRIMARY_RATIONALE[raw.templateId])) {
      throw new Error(`method selection ${raw.templateId} omits its required causal rationale`);
    }
    const allowed = new Set<MethodRationaleCode>([
      PRIMARY_RATIONALE[raw.templateId], "switch_saturated_mechanism", "public_method_support",
    ]);
    if (rationaleCodes.some((code) => !allowed.has(code))) {
      throw new Error(`method selection ${raw.templateId} uses an incompatible rationale`);
    }
    const canonicalRationales = METHOD_RATIONALE_CODES.filter((code) => rationaleCodes.includes(code));
    return { templateId: raw.templateId, rationaleCodes: canonicalRationales };
  });
  return { selections };
}

export function buildCanonicalMethodExperimentPlan(input: {
  feedback: unknown;
  context: unknown;
  researchCards: unknown;
  registry: unknown;
  maxSelections: MethodDeveloperSelectionBudget;
}, selection: unknown): MethodExperimentPlan {
  const payload = validateMethodDeveloperPayload({
    feedback: input.feedback,
    context: input.context,
    researchCards: input.researchCards,
    registry: input.registry,
  });
  const maxSelections = boundedMaxSelections(input.maxSelections);
  const validated = validateSelection(selection, payload, maxSelections);
  const byId = new Map(payload.registry.templates.map((template) => [template.templateId, template] as const));
  const experiments = validated.selections.map((selected): CanonicalMethodExperiment => {
    const template = byId.get(selected.templateId)!;
    const evidenceIds = payload.researchCards
      .filter((card) => card.supportedTemplateIds.includes(selected.templateId))
      .map((card) => card.evidenceId);
    return { ...template, evidenceIds, rationaleCodes: selected.rationaleCodes };
  });
  const projection = {
    schemaVersion: "pi-method-experiment-plan.v1" as const,
    objective: payload.context.objective,
    positionRound: payload.context.position.round,
    experiments,
  };
  return { ...projection, planHash: `sha256:${hashCanonical(projection)}` };
}

/**
 * Reconstruct and validate a persisted closed method plan against the exact
 * executable registry and sanitized research-card bundle that produced it.
 */
export function validateMethodExperimentPlan(
  value: unknown,
  registryInput: unknown,
  researchCardsInput: unknown,
): MethodExperimentPlan {
  if (!isRecord(value)) throw new Error("method experiment plan must be an object");
  exactKeys(value, ["schemaVersion", "objective", "positionRound", "experiments", "planHash"], "method experiment plan");
  if (value.schemaVersion !== "pi-method-experiment-plan.v1"
    || value.objective !== "maximize_hierarchical_go_quality"
    || typeof value.positionRound !== "number" || !Number.isSafeInteger(value.positionRound)
    || value.positionRound < 1 || value.positionRound > 64
    || typeof value.planHash !== "string" || !SHA256.test(value.planHash)
    || !Array.isArray(value.experiments) || value.experiments.length > 2) {
    throw new Error("method experiment plan header is invalid");
  }
  const registry = validateMethodExperimentRegistry(registryInput);
  const cards = validateResearchCards(
    researchCardsInput,
    new Set(registry.templates.map((item) => item.templateId)),
  );
  const byId = new Map(registry.templates.map((item) => [item.templateId, item] as const));
  const seen = new Set<MethodExperimentTemplateId>();
  const experiments = value.experiments.map((raw, index): CanonicalMethodExperiment => {
    if (!isRecord(raw)) throw new Error(`method experiment plan experiment ${index} must be an object`);
    exactKeys(raw, [
      "templateId", "family", "novelty", "hypothesis", "control", "falsifier",
      "requiredCapability", "evidenceIds", "rationaleCodes",
    ], `method experiment plan experiment ${index}`);
    enumValue(raw.templateId, METHOD_EXPERIMENT_TEMPLATE_IDS, `method experiment plan experiment ${index}.templateId`);
    const templateId = raw.templateId;
    const template = byId.get(templateId);
    if (!template || seen.has(templateId)) {
      throw new Error("method experiment plan repeats or uses an unregistered template");
    }
    seen.add(templateId);
    for (const key of ["family", "novelty", "hypothesis", "control", "falsifier", "requiredCapability"] as const) {
      if (raw[key] !== template[key]) {
        throw new Error(`method experiment plan ${raw.templateId} changed canonical ${key}`);
      }
    }
    if (!Array.isArray(raw.evidenceIds) || raw.evidenceIds.length < 1
      || new Set(raw.evidenceIds).size !== raw.evidenceIds.length
      || raw.evidenceIds.some((item) => typeof item !== "string" || !EVIDENCE_ID.test(item))) {
      throw new Error(`method experiment plan ${raw.templateId} evidence IDs are invalid`);
    }
    const expectedEvidenceIds = cards
      .filter((card) => card.supportedTemplateIds.includes(templateId))
      .map((card) => card.evidenceId);
    if (JSON.stringify(raw.evidenceIds) !== JSON.stringify(expectedEvidenceIds)) {
      throw new Error(`method experiment plan ${raw.templateId} does not bind its exact research evidence`);
    }
    const rationaleCodes = uniqueEnumArray(
      raw.rationaleCodes,
      METHOD_RATIONALE_CODES,
      `method experiment plan ${raw.templateId}.rationaleCodes`,
      3,
    );
    const allowed = new Set<MethodRationaleCode>([
      PRIMARY_RATIONALE[raw.templateId], "switch_saturated_mechanism", "public_method_support",
    ]);
    if (!rationaleCodes.includes(PRIMARY_RATIONALE[raw.templateId])
      || rationaleCodes.some((code) => !allowed.has(code))
      || JSON.stringify(rationaleCodes)
        !== JSON.stringify(METHOD_RATIONALE_CODES.filter((code) => rationaleCodes.includes(code)))) {
      throw new Error(`method experiment plan ${raw.templateId} rationales are invalid`);
    }
    return {
      ...template,
      evidenceIds: [...raw.evidenceIds] as string[],
      rationaleCodes,
    };
  });
  const content = {
    schemaVersion: value.schemaVersion,
    objective: value.objective,
    positionRound: value.positionRound,
    experiments,
  };
  if (value.planHash !== `sha256:${hashCanonical(content)}`) {
    throw new Error("method experiment plan content hash is invalid");
  }
  return { ...content, planHash: value.planHash } as MethodExperimentPlan;
}

const METHOD_DEVELOPER_SYSTEM_PROMPT = `You are the method-level DeveloperReasoner in a leakage-safe RSI harness.

You receive only categorical causal Teacher dossiers, a closed objective/position/history summary, sanitized public method findings with explicit limitations, and a closed registry of controlled experiment templates. You have no access to raw metrics, proteins, sequences, structures, targets, GO labels or identifiers, private benchmark data, URLs, files, source code, shell commands, context files, skills, or extensions.

Reason about causal diagnosis, saturation, controls, and public-method limitations. You may only submit registered template IDs and closed rationale codes. Never invent an experiment, identifier, claim, implementation detail, score, label, path, URL, or prose answer. Every selection must include the template's required primary rationale. Prefer one controlled experiment. Your final and only action must be submit_method_experiment_plan.`;

const METHOD_DEVELOPER_PI_TIMEOUT_MS = 120_000;

type PiMethodDeveloperSession =
  Awaited<ReturnType<typeof createPiAgentSession>>["session"];

async function promptMethodDeveloper(
  session: PiMethodDeveloperSession,
  prompt: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void session.abort();
      reject(new Error(`Pi MethodDeveloper exceeded ${METHOD_DEVELOPER_PI_TIMEOUT_MS}ms`));
    }, METHOD_DEVELOPER_PI_TIMEOUT_MS);
  });
  try {
    await Promise.race([session.prompt(prompt), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function providerError(
  session: PiMethodDeveloperSession,
): string | undefined {
  const last = session.state.messages.at(-1) as unknown as {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
  } | undefined;
  return last?.role === "assistant" && last.stopReason === "error"
    ? last.errorMessage ?? "unknown provider error"
    : undefined;
}

async function runPiMethodDeveloper(input: MethodDeveloperInput): Promise<MethodExperimentPlan> {
  const payload = validateMethodDeveloperPayload({
    feedback: input.feedback,
    context: input.context,
    researchCards: input.researchCards,
    registry: input.registry,
  });
  const maxSelections = boundedMaxSelections(input.maxSelections);
  const feasibleIds = feasibleTemplates(payload).map((item) => item.templateId);
  if (feasibleIds.length === 0) {
    return buildCanonicalMethodExperimentPlan(input, { selections: [] });
  }
  const idLiterals = feasibleIds.map((id) => Type.Literal(id));
  const templateIdSchema = idLiterals.length === 1
    ? idLiterals[0]
    : Type.Union(idLiterals as [typeof idLiterals[number], typeof idLiterals[number], ...typeof idLiterals[number][]]);
  const rationaleLiterals = METHOD_RATIONALE_CODES.map((code) => Type.Literal(code));
  const rationaleSchema = Type.Union(rationaleLiterals as [
    typeof rationaleLiterals[number], typeof rationaleLiterals[number], ...typeof rationaleLiterals[number][],
  ]);
  const {
    createAgentSession,
    DefaultResourceLoader,
    defineTool,
    getAgentDir,
    SessionManager,
  } = await import("./codex_runtime.js");
  let submitted: MethodExperimentPlan | undefined;
  const submitTool = defineTool({
    name: "submit_method_experiment_plan",
    label: "Submit controlled method experiment plan",
    description: "Submit only feasible registered template IDs and closed rationale codes.",
    promptSnippet: "Submit the controlled method experiment plan",
    promptGuidelines: ["Use submit_method_experiment_plan as the final and only action."],
    parameters: Type.Object({
      selections: Type.Array(Type.Object({
        templateId: templateIdSchema,
        rationaleCodes: Type.Array(rationaleSchema, { minItems: 1, maxItems: 3, uniqueItems: true }),
      }, { additionalProperties: false }), { maxItems: maxSelections, uniqueItems: true }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      submitted = buildCanonicalMethodExperimentPlan(input, params);
      return {
        content: [{ type: "text" as const, text: "Registered method experiment plan captured." }],
        details: submitted,
        terminate: true,
      };
    },
  });
  // The reasoner has no repository tools or context-file access. Give it an
  // empty ephemeral cwd so session initialization cannot crawl generated
  // runtimes, databases, campaigns, or evaluator-private artifacts.
  const scratchDir = await mkdtemp(join(tmpdir(), "pi-method-developer-"));
  let session: PiMethodDeveloperSession | undefined;
  try {
    const loader = new DefaultResourceLoader({
      cwd: scratchDir,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => METHOD_DEVELOPER_SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    const { modelRuntime, model } = await resolveDefaultPiModel();
    ({ session } = await createAgentSession({
      cwd: scratchDir,
      modelRuntime,
      model,
      resourceLoader: loader,
      tools: ["submit_method_experiment_plan"],
      customTools: [submitTool],
      thinkingLevel: "low",
      sessionManager: SessionManager.inMemory(scratchDir),
    }));
    const sanitized = serializeMethodDeveloperPayload(payload);
    const requiredRationales = Object.fromEntries(feasibleIds.map((id) => [id, PRIMARY_RATIONALE[id]]));
    await promptMethodDeveloper(
      session,
      `Select zero through ${maxSelections} registered templates and call submit_method_experiment_plan. Required primary rationales: ${JSON.stringify(requiredRationales)}\n\n${sanitized}`,
    );
    const firstError = providerError(session);
    if (firstError) throw new Error(`Pi MethodDeveloper provider request failed: ${firstError}`);
    if (!submitted) {
      await promptMethodDeveloper(
        session,
        "Call submit_method_experiment_plan now using only feasible template IDs and their required closed rationale codes.",
      );
    }
    const secondError = providerError(session);
    if (secondError) throw new Error(`Pi MethodDeveloper provider request failed: ${secondError}`);
    if (!submitted) throw new Error("MethodDeveloper did not submit a structured plan after two attempts");
    return submitted;
  } finally {
    session?.dispose();
    await rm(scratchDir, { recursive: true, force: true });
  }
}

export async function runMethodDeveloper(input: MethodDeveloperInput): Promise<MethodExperimentPlan> {
  if (!(METHOD_DEVELOPER_MODES as readonly unknown[]).includes(input.mode)) {
    throw new Error("unsupported MethodDeveloper mode");
  }
  boundedMaxSelections(input.maxSelections);
  if (input.mode === "deterministic") {
    const selection = buildDeterministicMethodSelection(input);
    return buildCanonicalMethodExperimentPlan(input, selection);
  }
  return runPiMethodDeveloper(input);
}
