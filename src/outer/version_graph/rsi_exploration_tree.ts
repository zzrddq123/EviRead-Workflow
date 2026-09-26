import { createHash } from "node:crypto";

import { hashCanonical } from "../../hash.js";
import type {
  RsiDecisionAction,
  RsiEvaluationPublicSummary,
  RsiEvaluationResultKind,
  RsiVersionBinding,
} from "./rsi_version_graph.js";

export const RSI_DEVELOPER_EXPLORATION_SCHEMA =
  "pi-rsi-developer-exploration.v1" as const;
export const RSI_EVALUATION_ANALYSIS_SCHEMA =
  "pi-rsi-evaluation-analysis.v1" as const;
export const RSI_NEXT_OPTIMIZATION_PLAN_SPEC_V1_SCHEMA =
  "pi-rsi-next-optimization-plan-spec.v1" as const;
export const RSI_NEXT_OPTIMIZATION_PLAN_SPEC_SCHEMA =
  "pi-rsi-next-optimization-plan-spec.v2" as const;
export const RSI_NEXT_OPTIMIZATION_PLAN_SCHEMA =
  "pi-rsi-next-optimization-plan.v1" as const;
export const RSI_EXPLORATION_CLAIM_BOUNDARY =
  "Developer-visible aggregate evaluation analysis and pre-implementation plan only; no gold GO labels, target identities, sequences, per-protein errors, evaluator-private paths, or evaluator-private artifacts." as const;

export const RSI_EXPLORATION_PROBLEM_CODES = [
  "candidate_recall_risk",
  "precision_risk",
  "aspect_tradeoff_risk",
  "score_calibration_risk",
  "source_correlation_risk",
  "pipeline_activation_risk",
  "method_saturation_risk",
  "evidence_coverage_risk",
  "ontology_consistency_risk",
] as const;
export type RsiExplorationProblemCode =
  typeof RSI_EXPLORATION_PROBLEM_CODES[number];

export const RSI_EXPLORATION_COMPONENTS = [
  "candidate_generation",
  "evidence_acquisition",
  "external_tool_fusion",
  "ontology_reasoning",
  "aspect_routing",
  "score_calibration",
  "go_selection",
  "pipeline",
] as const;
export type RsiExplorationComponent =
  typeof RSI_EXPLORATION_COMPONENTS[number];

export type RsiExpectedEffect = "improve" | "hold" | "not_targeted";
type RsiAdaptiveEvaluationPublicSummary = Extract<
  RsiEvaluationPublicSummary,
  { kind: "adaptive_protein_function" }
>;

export interface RsiExplorationResearchCard {
  evidenceId: string;
  finding: string;
  limitations: string[];
  supportedComponents: RsiExplorationComponent[];
}

/**
 * Minimal, dependency-free view of an outer-adaptive proposal needed to
 * prove that the executable experiment is the one authorized by a Developer
 * exploration.  Keeping this assertion beside the exploration contract lets
 * plan construction, strict execution, and StateRoot replay use one rule.
 */
export interface RsiExplorationAdaptiveProposalBinding {
  hypothesis: string;
  researchEvidenceIds: readonly string[];
  experiment: {
    family: string;
    requiredCapability: string;
    challenger: {
      capabilityId: string;
    };
    changeSummary: string;
  };
}

export interface RsiExplorationPlanBinding {
  hypothesis: string;
  plannedChangeSummary: string;
  experiment: {
    component: RsiExplorationComponent;
    requiredCapabilities: readonly string[];
  };
  researchCards: readonly Pick<
    RsiExplorationResearchCard,
    "evidenceId" | "supportedComponents"
  >[];
}

const EXPLORATION_COMPONENT_FAMILIES:
Readonly<Record<RsiExplorationComponent, readonly string[]>> = {
  candidate_generation: [
    "candidate_sources",
    "external_predictor",
    "ontology_reasoning",
  ],
  evidence_acquisition: [
    "candidate_sources",
    "external_predictor",
    "ontology_reasoning",
  ],
  external_tool_fusion: ["modality_fusion", "external_predictor"],
  ontology_reasoning: ["ontology_reasoning"],
  aspect_routing: ["aspect_router"],
  score_calibration: ["score_calibration"],
  go_selection: ["selection_policy", "ontology_reasoning"],
  pipeline: ["pipeline"],
};

export function assertRsiExplorationAuthorizesAdaptiveProposal(
  proposal: RsiExplorationAdaptiveProposalBinding,
  exploration: RsiExplorationPlanBinding,
): void {
  if (proposal.hypothesis !== exploration.hypothesis) {
    throw new Error(
      "versioned adaptive proposal hypothesis does not match the bound Developer exploration",
    );
  }
  if (proposal.experiment.changeSummary
      !== exploration.plannedChangeSummary) {
    throw new Error(
      "versioned adaptive proposal change summary does not match the bound Developer exploration",
    );
  }
  if (!EXPLORATION_COMPONENT_FAMILIES[
    exploration.experiment.component
  ].includes(proposal.experiment.family)) {
    throw new Error(
      "versioned adaptive proposal family does not match the bound Developer exploration component",
    );
  }
  if (proposal.experiment.challenger.capabilityId
      !== proposal.experiment.requiredCapability
    || !exploration.experiment.requiredCapabilities.includes(
      proposal.experiment.requiredCapability,
    )) {
    throw new Error(
      "versioned adaptive proposal capability does not match the bound Developer exploration",
    );
  }
  const explorationEvidenceIds = exploration.researchCards.map(
    (card) => card.evidenceId,
  );
  if (JSON.stringify(proposal.researchEvidenceIds)
      !== JSON.stringify(explorationEvidenceIds)
    || exploration.researchCards.some((card) =>
      !card.supportedComponents.includes(
        exploration.experiment.component,
      ))) {
    throw new Error(
      "versioned adaptive proposal research evidence does not match the bound Developer exploration",
    );
  }
}

/**
 * This is the only caller-authored input to the pre-code reflection step.
 * It deliberately has no sourceCommit, implementationHash, testReceiptHash,
 * prediction hash, GO label, protein identifier, or evaluator-private field.
 */
export interface RsiNextOptimizationPlanSpec extends Record<string, unknown> {
  schemaVersion:
    | typeof RSI_NEXT_OPTIMIZATION_PLAN_SPEC_V1_SCHEMA
    | typeof RSI_NEXT_OPTIMIZATION_PLAN_SPEC_SCHEMA;
  /**
   * Required by the v2 JSON schema. A v1 plan omits this field and
   * deterministically defaults to the selected version at its bound history
   * prefix.
   */
  baseVersionId?: string;
  action: "proceed" | "stop";
  plannedVersionId: string | null;
  problemAssessment: string;
  problemCodes: RsiExplorationProblemCode[];
  hypothesis: string;
  plannedChangeSummary: string;
  codeChangeTargets: string[];
  controls: string[];
  expectedEffects: {
    overall: RsiExpectedEffect;
    molecularFunction: RsiExpectedEffect;
    biologicalProcess: RsiExpectedEffect;
    cellularComponent: RsiExpectedEffect;
  };
  experiment: {
    component: RsiExplorationComponent;
    strategy: string;
    requiredCapabilities: string[];
    falsifiers: string[];
  };
  researchCards: RsiExplorationResearchCard[];
  rollbackCondition: string;
  claimBoundary: typeof RSI_EXPLORATION_CLAIM_BOUNDARY;
  canonicalHash: string;
}

export interface RsiEvaluationAnalysis extends Record<string, unknown> {
  schemaVersion: typeof RSI_EVALUATION_ANALYSIS_SCHEMA;
  sourceVersion: {
    versionId: string;
    parentVersionId: string | null;
    sourceCommit: string;
    sourceTree: string;
    manifestHash: string;
  };
  evaluation: {
    evaluationId: string;
    resultKind: RsiEvaluationResultKind;
    publicationMode: "prospective" | "retrospective_legacy";
    protocolId: string;
    protocolHash: string;
    proteinEvaluation: boolean;
  };
  publicSummary: RsiEvaluationPublicSummary;
  decision: {
    decisionId: string;
    action: RsiDecisionAction;
    selectedVersionId: string;
    rationale: string;
  };
  bindings: {
    openingHash: string;
    resultHash: string;
    publicationHash: string;
    decisionHash: string;
    stateRootPublicManifestHash: string | null;
  };
  claimBoundary: string;
  suppressionPolicy:
    "aggregate_and_closed_teacher_projection_only_no_private_or_per_protein_material";
  canonicalHash: string;
}

export interface RsiNextOptimizationPlan extends Record<string, unknown> {
  schemaVersion: typeof RSI_NEXT_OPTIMIZATION_PLAN_SCHEMA;
  sourceVersionId: string;
  sourceEvaluationId: string;
  baseVersionId: string;
  history: {
    contextHash: string;
    eventSequence: number;
    eventManifestHash: string;
    selectedVersionId: string;
  };
  evaluationAnalysisHash: string;
  teacherDistillation: {
    proteinEvaluation: boolean;
    hypothesisVerdict:
      RsiAdaptiveEvaluationPublicSummary["teacher"]["hypothesisVerdict"]
      | null;
    mechanismVerdict:
      RsiAdaptiveEvaluationPublicSummary["teacher"]["mechanismVerdict"]
      | null;
    diagnoses:
      RsiAdaptiveEvaluationPublicSummary["teacher"]["diagnoses"];
    prioritizedActions:
      RsiAdaptiveEvaluationPublicSummary["teacher"]["prioritizedActions"];
  };
  action: "proceed" | "stop";
  plannedVersionId: string | null;
  problemAssessment: string;
  problemCodes: RsiExplorationProblemCode[];
  hypothesis: string;
  plannedChangeSummary: string;
  codeChangeTargets: string[];
  controls: string[];
  expectedEffects: RsiNextOptimizationPlanSpec["expectedEffects"];
  experiment: RsiNextOptimizationPlanSpec["experiment"];
  researchCardBundleHash: string;
  researchCards: RsiExplorationResearchCard[];
  rollbackCondition: string;
  claimBoundary: typeof RSI_EXPLORATION_CLAIM_BOUNDARY;
  canonicalHash: string;
}

export interface RsiExplorationArtifactBinding {
  relativePath: string;
  sha256: string;
  size: number;
}

export interface RsiDeveloperExplorationManifest
  extends Record<string, unknown> {
  schemaVersion: typeof RSI_DEVELOPER_EXPLORATION_SCHEMA;
  explorationId: string;
  tagRef: string;
  sourceVersion: RsiVersionBinding;
  baseVersion: RsiVersionBinding;
  evaluation: {
    evaluationId: string;
    openingHash: string;
    resultHash: string;
    publicationHash: string;
    publicationTagObjectId: string;
    decisionId: string;
    decisionHash: string;
    decisionTagObjectId: string;
    stateRootPublicManifestHash: string | null;
  };
  historyPrefix: {
    schemaVersion:
      | "pi-rsi-developer-history-context.v1"
      | "pi-rsi-developer-history-context.v2"
      | "pi-rsi-developer-history-context.v3"
      | "pi-rsi-developer-history-context.v4";
    contextHash: string;
    eventSequence: number;
    eventManifestHash: string;
    selectedVersionId: string;
  };
  evaluationAnalysis: RsiEvaluationAnalysis;
  nextOptimizationPlan: RsiNextOptimizationPlan;
  artifacts: {
    evaluationAnalysisMarkdown: RsiExplorationArtifactBinding;
    nextOptimizationPlanMarkdown: RsiExplorationArtifactBinding;
  };
  policies: {
    authority:
      "immutable_structured_tag_and_event_markdown_is_deterministic_view_v1";
    planningOrder:
      "terminal_evaluation_then_reflection_then_child_version_registration_v1";
    privacy:
      "closed_public_projection_no_protected_material_v1";
  };
  claimBoundary: typeof RSI_EXPLORATION_CLAIM_BOUNDARY;
  canonicalHash: string;
}

function withCanonicalHash<T extends Record<string, unknown>>(
  value: T,
): T & { canonicalHash: string } {
  return { ...value, canonicalHash: hashCanonical(value) };
}

export function buildRsiEvaluationAnalysis(input: {
  sourceVersion: {
    versionId: string;
    parentVersionId: string | null;
    sourceCommit: string;
    sourceTree: string;
    manifestHash: string;
  };
  evaluationId: string;
  resultKind: RsiEvaluationResultKind;
  publicationMode: "prospective" | "retrospective_legacy";
  protocolId: string;
  protocolHash: string;
  publicSummary: RsiEvaluationPublicSummary;
  decision: {
    decisionId: string;
    action: RsiDecisionAction;
    selectedVersionId: string;
    rationale: string;
  };
  bindings: RsiEvaluationAnalysis["bindings"];
  claimBoundary: string;
}): RsiEvaluationAnalysis {
  return withCanonicalHash({
    schemaVersion: RSI_EVALUATION_ANALYSIS_SCHEMA,
    sourceVersion: structuredClone(input.sourceVersion),
    evaluation: {
      evaluationId: input.evaluationId,
      resultKind: input.resultKind,
      publicationMode: input.publicationMode,
      protocolId: input.protocolId,
      protocolHash: input.protocolHash,
      proteinEvaluation:
        input.publicSummary.kind === "adaptive_protein_function",
    },
    publicSummary: structuredClone(input.publicSummary),
    decision: structuredClone(input.decision),
    bindings: structuredClone(input.bindings),
    claimBoundary: input.claimBoundary,
    suppressionPolicy:
      "aggregate_and_closed_teacher_projection_only_no_private_or_per_protein_material" as const,
  }) as RsiEvaluationAnalysis;
}

function sortedResearchCards(
  cards: readonly RsiExplorationResearchCard[],
): RsiExplorationResearchCard[] {
  return [...cards]
    .map((card) => ({
      evidenceId: card.evidenceId,
      finding: card.finding,
      limitations: [...card.limitations],
      supportedComponents: [...card.supportedComponents].sort(),
    }))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
}

export function buildRsiNextOptimizationPlan(input: {
  spec: RsiNextOptimizationPlanSpec;
  analysis: RsiEvaluationAnalysis;
  baseVersionId: string;
  history: RsiNextOptimizationPlan["history"];
}): RsiNextOptimizationPlan {
  const summary = input.analysis.publicSummary;
  const teacher = summary.kind === "adaptive_protein_function"
    ? {
      proteinEvaluation: true,
      hypothesisVerdict: summary.teacher.hypothesisVerdict,
      mechanismVerdict: summary.teacher.mechanismVerdict,
      diagnoses: [...summary.teacher.diagnoses],
      prioritizedActions: [...summary.teacher.prioritizedActions],
    }
    : {
      proteinEvaluation: false,
      hypothesisVerdict: null,
      mechanismVerdict: null,
      diagnoses: [],
      prioritizedActions: [],
    };
  const researchCards = sortedResearchCards(input.spec.researchCards);
  return withCanonicalHash({
    schemaVersion: RSI_NEXT_OPTIMIZATION_PLAN_SCHEMA,
    sourceVersionId: input.analysis.sourceVersion.versionId,
    sourceEvaluationId: input.analysis.evaluation.evaluationId,
    baseVersionId: input.baseVersionId,
    history: structuredClone(input.history),
    evaluationAnalysisHash: input.analysis.canonicalHash,
    teacherDistillation: teacher,
    action: input.spec.action,
    plannedVersionId: input.spec.plannedVersionId,
    problemAssessment: input.spec.problemAssessment,
    problemCodes: [...input.spec.problemCodes],
    hypothesis: input.spec.hypothesis,
    plannedChangeSummary: input.spec.plannedChangeSummary,
    codeChangeTargets: [...input.spec.codeChangeTargets],
    controls: [...input.spec.controls],
    expectedEffects: structuredClone(input.spec.expectedEffects),
    experiment: {
      component: input.spec.experiment.component,
      strategy: input.spec.experiment.strategy,
      requiredCapabilities: [...input.spec.experiment.requiredCapabilities],
      falsifiers: [...input.spec.experiment.falsifiers],
    },
    researchCardBundleHash: hashCanonical(researchCards),
    researchCards,
    rollbackCondition: input.spec.rollbackCondition,
    claimBoundary: RSI_EXPLORATION_CLAIM_BOUNDARY,
  }) as RsiNextOptimizationPlan;
}

function markdownText(value: string): string {
  return value.replace(/[\\`*_[\]<>|]/g, "\\$&");
}

function metric(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function bulletValues(values: readonly string[]): string {
  return values.length
    ? values.map((value) => `  - ${markdownText(value)}`).join("\n")
    : "  - none";
}

export function renderRsiEvaluationAnalysisMarkdown(
  analysis: RsiEvaluationAnalysis,
): string {
  const lines = [
    "# Evaluation results and analysis",
    "",
    `- Code version: \`${analysis.sourceVersion.versionId}\``,
    `- Parent version: \`${analysis.sourceVersion.parentVersionId ?? "none"}\``,
    `- Source commit: \`${analysis.sourceVersion.sourceCommit}\``,
    `- Evaluation: \`${analysis.evaluation.evaluationId}\``,
    `- Evidence kind: \`${analysis.evaluation.resultKind}\``,
    `- Protein evaluation: ${analysis.evaluation.proteinEvaluation ? "yes" : "no"}`,
    `- Protocol: \`${analysis.evaluation.protocolId}\` / \`${analysis.evaluation.protocolHash}\``,
    `- Analysis hash: \`${analysis.canonicalHash}\``,
    "",
    "## Aggregate evaluation",
    "",
  ];
  const summary = analysis.publicSummary;
  if (summary.kind === "adaptive_protein_function") {
    lines.push(
      `- Cohort role: \`${summary.cohort.role}\``,
      `- Protein count: ${summary.cohort.caseCount}`,
      `- Interpretation: \`${summary.metricInterpretation}\``,
      `- Gate outcome: \`${summary.challenger.decision}\``,
      `- Overall Fmax: ${metric(summary.control.metrics.overall.fmax)} → ${metric(summary.challenger.metrics.overall.fmax)}`,
      `- MF Fmax: ${metric(summary.control.metrics.aspects.molecular_function.fmax)} → ${metric(summary.challenger.metrics.aspects.molecular_function.fmax)}`,
      `- BP Fmax: ${metric(summary.control.metrics.aspects.biological_process.fmax)} → ${metric(summary.challenger.metrics.aspects.biological_process.fmax)}`,
      `- CC Fmax: ${metric(summary.control.metrics.aspects.cellular_component.fmax)} → ${metric(summary.challenger.metrics.aspects.cellular_component.fmax)}`,
      `- Overall Fmax gain: ${summary.challenger.overallFmaxGain}`,
      `- Maximum populated-aspect Fmax drop: ${summary.challenger.maximumPopulatedAspectFmaxDrop}`,
      "",
      "## Evaluator / Teacher analysis",
      "",
      `- Hypothesis verdict: \`${summary.teacher.hypothesisVerdict}\``,
      `- Mechanism verdict: \`${summary.teacher.mechanismVerdict}\``,
      "- Diagnoses:",
      bulletValues(summary.teacher.diagnoses),
      "- Prioritized actions:",
      bulletValues(summary.teacher.prioritizedActions),
      "- External evidence IDs:",
      bulletValues(summary.method.externalEvidenceIds),
      `- Evaluated hypothesis: ${markdownText(summary.method.hypothesis)}`,
      `- Evaluated change: ${markdownText(summary.method.changeSummary)}`,
    );
  } else {
    lines.push(
      "- This record is not a protein-function evaluation.",
      `- Summary: ${markdownText(summary.summary)}`,
      `- Checks: ${summary.checks.map(
        (item) => `\`${item.checkId}:${item.status}\``,
      ).join(", ")}`,
      `- Artifact claim boundary: ${markdownText(summary.artifactClaimBoundary)}`,
      "",
      "## Evaluator / Teacher analysis",
      "",
      "- No protein-level Teacher diagnosis exists for this software/frozen-replay record.",
    );
  }
  lines.push(
    "",
    "## Branch decision",
    "",
    `- Decision: \`${analysis.decision.decisionId}\` / \`${analysis.decision.action}\``,
    `- Selected base version: \`${analysis.decision.selectedVersionId}\``,
    `- Rationale: ${markdownText(analysis.decision.rationale)}`,
    "",
    "## Public bindings and information boundary",
    "",
    `- Opening hash: \`${analysis.bindings.openingHash}\``,
    `- Result hash: \`${analysis.bindings.resultHash}\``,
    `- Publication hash: \`${analysis.bindings.publicationHash}\``,
    `- Decision hash: \`${analysis.bindings.decisionHash}\``,
    `- StateRoot public manifest hash: \`${analysis.bindings.stateRootPublicManifestHash ?? "not-applicable"}\``,
    `- Claim boundary: ${markdownText(analysis.claimBoundary)}`,
    "- Suppressed by design: gold GO labels, target/case identities, sequences, per-protein errors, evaluator-private paths, and evaluator-private artifacts.",
    "",
  );
  return lines.join("\n");
}

export function renderRsiNextOptimizationPlanMarkdown(
  plan: RsiNextOptimizationPlan,
): string {
  const lines = [
    "# Next optimization plan",
    "",
    `- Reflection source version: \`${plan.sourceVersionId}\``,
    `- Reflection source evaluation: \`${plan.sourceEvaluationId}\``,
    `- Selected base version for the next child: \`${plan.baseVersionId}\``,
    `- Action: \`${plan.action}\``,
    `- Planned child version: \`${plan.plannedVersionId ?? "none"}\``,
    `- Evaluation-analysis hash: \`${plan.evaluationAnalysisHash}\``,
    `- Developer-history hash: \`${plan.history.contextHash}\``,
    `- Developer-history event head: ${plan.history.eventSequence} / \`${plan.history.eventManifestHash}\``,
    `- Plan hash: \`${plan.canonicalHash}\``,
    "",
    "## Distilled evaluation feedback",
    "",
    `- Protein evaluation available: ${plan.teacherDistillation.proteinEvaluation ? "yes" : "no"}`,
    `- Hypothesis verdict: \`${plan.teacherDistillation.hypothesisVerdict ?? "not-applicable"}\``,
    `- Mechanism verdict: \`${plan.teacherDistillation.mechanismVerdict ?? "not-applicable"}\``,
    "- Diagnoses:",
    bulletValues(plan.teacherDistillation.diagnoses),
    "- Prioritized actions:",
    bulletValues(plan.teacherDistillation.prioritizedActions),
    "",
    "## Developer judgment",
    "",
    `- Problem assessment: ${markdownText(plan.problemAssessment)}`,
    `- Problem codes: ${plan.problemCodes.map((item) => `\`${item}\``).join(", ")}`,
    `- Hypothesis: ${markdownText(plan.hypothesis)}`,
    `- Planned change: ${markdownText(plan.plannedChangeSummary)}`,
    "- Code/change targets:",
    bulletValues(plan.codeChangeTargets),
    "- Controls held fixed:",
    bulletValues(plan.controls),
    "",
    "## Controlled experiment",
    "",
    `- Component: \`${plan.experiment.component}\``,
    `- Strategy: ${markdownText(plan.experiment.strategy)}`,
    "- Required capabilities:",
    bulletValues(plan.experiment.requiredCapabilities),
    "- Falsifiers:",
    bulletValues(plan.experiment.falsifiers),
    `- Rollback condition: ${markdownText(plan.rollbackCondition)}`,
    "",
    "## Expected effects",
    "",
    `- Overall: \`${plan.expectedEffects.overall}\``,
    `- MF: \`${plan.expectedEffects.molecularFunction}\``,
    `- BP: \`${plan.expectedEffects.biologicalProcess}\``,
    `- CC: \`${plan.expectedEffects.cellularComponent}\``,
    "",
    "## External research cards",
    "",
    `- Research-card bundle hash: \`${plan.researchCardBundleHash}\``,
  ];
  if (plan.researchCards.length === 0) {
    lines.push("- none");
  } else {
    for (const card of plan.researchCards) {
      lines.push(
        `- \`${card.evidenceId}\`: ${markdownText(card.finding)}`,
        `  - Supported components: ${card.supportedComponents.map(
          (item) => `\`${item}\``,
        ).join(", ")}`,
        `  - Limitations: ${card.limitations.map(markdownText).join("; ")}`,
      );
    }
  }
  lines.push(
    "",
    "## Claim boundary",
    "",
    markdownText(plan.claimBoundary),
    "",
  );
  return lines.join("\n");
}

export function explorationArtifactBinding(
  relativePath: string,
  content: string,
): RsiExplorationArtifactBinding {
  const bytes = Buffer.from(content, "utf8");
  return {
    relativePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}
