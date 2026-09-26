import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import { PROJECT_ROOT } from "../../config.js";
import {
  canonicalJson,
  hashCanonical,
} from "../../hash.js";
import {
  CAUSAL_ACTIONS,
  CAUSAL_DIAGNOSES,
  type CausalAction,
  type CausalDiagnosis,
  type CausalTeacherFamily,
  type OptimizationCausalTeacherFeedback,
} from "../../outer_causal_teacher.js";
import type {
  MethodExperimentTemplateId,
} from "../../outer_method_developer.js";
import {
  RSI_DEVELOPER_EXPLORATION_SCHEMA,
  RSI_EXPLORATION_CLAIM_BOUNDARY,
  RSI_EXPLORATION_COMPONENTS,
  RSI_NEXT_OPTIMIZATION_PLAN_SPEC_SCHEMA,
  RSI_NEXT_OPTIMIZATION_PLAN_SPEC_V1_SCHEMA,
  assertRsiExplorationAuthorizesAdaptiveProposal,
  buildRsiEvaluationAnalysis,
  buildRsiNextOptimizationPlan,
  explorationArtifactBinding,
  renderRsiEvaluationAnalysisMarkdown,
  renderRsiNextOptimizationPlanMarkdown,
  type RsiDeveloperExplorationManifest,
  type RsiExplorationComponent,
  type RsiExplorationProblemCode,
  type RsiExplorationResearchCard,
  type RsiExpectedEffect,
  type RsiNextOptimizationPlanSpec,
} from "./rsi_exploration_tree.js";

const execFileAsync = promisify(execFile);
const HASH = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_PREFIX = "refs/tags/rsi/version/";
const EVALUATION_PREFIX = "refs/tags/rsi/evaluation/";
const DECISION_PREFIX = "refs/tags/rsi/decision/";
const EXPLORATION_PREFIX = "refs/tags/rsi/exploration/";
const EPOCH_RESUME_PREFIX = "refs/tags/rsi/epoch-resume/";
const RETROSPECTIVE_PREFIX = "refs/tags/rsi/retrospective/";
const RETROSPECTIVE_INCUMBENT_PREFIX =
  "refs/tags/rsi/retrospective-incumbent/";
const EVENT_PREFIX = "refs/tags/rsi/event/";
const RSI_TAG_PREFIX = "refs/tags/rsi/";
const PUBLIC_SENSITIVE_VALUE =
  /(?:evaluator_private|private_manifest|(?:^|[^A-Z0-9])ANON[_-]|(?:^|[^A-Z0-9])CASE[_-]|GO(?:[:_-])?\d{7})/i;
const PUBLIC_ACCESSION =
  /(?:^|[^A-Z0-9])(?:(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-\d+)?|(?:NP|XP|WP|YP|NM|XM|NR)_\d+(?:\.\d+)?|ENS(?:P|T|G)\d{9,}(?:\.\d+)?|[A-Z]{1,6}_?\d{5,12}(?:\.\d+)?|[1-9](?:[A-Z][A-Z0-9]{2}|[0-9][A-Z][A-Z0-9]|[A-Z0-9]{2}[A-Z]))(?=$|[^A-Z0-9])/i;
const PUBLIC_URL_OR_ABSOLUTE_PATH =
  /(?:https?|file|s3|gs):\/\/|data:[^,\s]+,|(?:^|[\s("'`=:])(?:\/(?!\/)[^\s"'`]+|~\/[^\s"'`]+|[A-Za-z]:[\\/][^\s"'`]+|\\\\[^\\\s]+\\[^\\\s]+|\/\/[^/\s]+\/[^\s]+)/i;
const PUBLIC_ENCODED_PAYLOAD =
  /(?:^|[^A-Za-z0-9+/])(?:[A-Za-z0-9+/]{96,}={0,2})(?=$|[^A-Za-z0-9+/=])/;
const PUBLIC_OBFUSCATED_GO_ID =
  /(?:^|[^A-Z0-9])(?:G[\s._-]*O|Gene[\s._-]+Ontology)(?:[\s._:-]*\d){7}(?![\s._:-]*\d)/i;
const PUBLIC_DESCRIBED_GO_ID =
  /(?:^|[^A-Z0-9])(?:G[\s._-]*O|Gene[\s._-]+Ontology)(?=$|[^A-Z0-9]).{0,24}(?:^|[^0-9])\d{7}(?!\d)/i;
const PUBLIC_RELATIVE_PRIVATE_PATH =
  /(?:^|[\\/\s("'`=:])\.*(?:evaluator(?:[_-]?private)?|private(?:[_-]?(?:artifacts?|state|data))?|gold(?:[_-]?(?:bundles?|cases?|labels?))?)[\\/][^\s"'`]+/i;
const PUBLIC_PROTEIN_SEQUENCE =
  /(?:^|[^A-Z])(?:[ACDEFGHIKLMNPQRSTVWYBXZ]{30,})(?=$|[^A-Z])/i;
const PUBLIC_UNSAFE_TEXT_LAYOUT =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u;
const PUBLIC_SENSITIVE_KEY =
  /^(?:accessions?|protein_?ids?|case_?ids?|sequences|seq|(?:protein|amino_?acid|raw)_?sequences?|gold(?:_?(?:terms?|labels?))?|labels?|private_?(?:manifest|path|data)?|paths?|files?|urls?)$/i;

function containsSegmentedProteinSequence(value: string): boolean {
  const pattern =
    /(?:^|[^A-Za-z])((?:[ACDEFGHIKLMNPQRSTVWYBXZ]{3,}[\s,;|\/.-]+){2,}[ACDEFGHIKLMNPQRSTVWYBXZ]{3,})(?=$|[^A-Za-z])/gi;
  for (const match of value.matchAll(pattern)) {
    const candidate = match[1]!;
    const chunks = candidate.match(/[A-Za-z]{3,}/g) ?? [];
    const length = chunks.reduce(
      (total, chunk) => total + chunk.length,
      0,
    );
    const chunkLengths = chunks.map((chunk) => chunk.length);
    if (length >= 30
      && (chunks.length >= 6
        || Math.max(...chunkLengths)
          - Math.min(...chunkLengths) <= 1)) {
      return true;
    }
  }
  return false;
}

const LEGACY_ROOT_VERSION_ID = "v0001";
const LEGACY_ROOT_VERSION_MANIFEST_HASH =
  "b7fbccced2d0330e2c59d6bb3036f6768d0b38bfebfdd67aaba6d6978cacc025";
const LEGACY_ROOT_VERSION_TAG_OBJECT_ID =
  "04cdf7a6120588b17078759ceb130d5a1023fe0f";
const LEGACY_ROOT_SOURCE_COMMIT =
  "ed852cb5c495a1b7049513fbc7c387ef9e11564c";
const LEGACY_EVALUATION_ID = "verify-v0001";
const LEGACY_OPENING_MANIFEST_HASH =
  "e28bf7ee6d6f6a6464dc56c5c446ad5699d558069f6d243e71b4367cecc6e02a";
const LEGACY_OPENING_TAG_OBJECT_ID =
  "996950b917c4f1d8e5c3aba4c7a6cec3ec809c7e";
const LEGACY_RESULT_MANIFEST_HASH =
  "97e84dfc1de6e78f5ce2c717dec4e825ba181617620fb92633ece9da9f6d7233";
const LEGACY_RESULT_TAG_OBJECT_ID =
  "09c71569e4f4198d294083a7d35f017176bc6b8a";
const LEGACY_RESULT_ARTIFACT_HASH =
  "76dcd0435a0a3b843efb1d5ea006018815318b70e3e04893fbe0cf7a86065e78";
const LEGACY_DECISION_ID = "select-v0001";
const LEGACY_DECISION_MANIFEST_HASH =
  "26ecd83a4244b2f8f4be3901325cb7fb553fc878c4e6fcac545c8a9cca47f3b1";
const LEGACY_DECISION_TAG_OBJECT_ID =
  "0eb2402881072a9665717e0cc1b9e13d41c5ac4b";
const LEGACY_PUBLICATION_MANIFEST_HASH =
  "6a12571b7bfd69bbc866e15a7fe6945dca81cfbbc57755d8c2326d4b87e8b657";
const LEGACY_SOFTWARE_CLAIM_BOUNDARY =
  "Software, lineage, and repository-integrity verification only; no protein-function performance claim";
const RSI_CODE_VERSION_QUALITY_PROTOCOL_ID =
  "rsi-code-version-quality-v1";
const RSI_CODE_VERSION_QUALITY_PROTOCOL_HASH =
  "08e34a4d905066b2de233b701aacae4a4daaae65a492520de12a47cd9f6faab0";
const RSI_Z55_FROZEN_REPLAY_PROTOCOL_ID =
  "z55-prospective20-mf-consensus-v1" as const;
const RSI_Z55_FROZEN_REPLAY_PROTOCOL_HASH =
  "b64d0d560e8222f8ad0f09a13ba2d71453746f668bf9fceee0551e9b333b501e";
const RSI_Z55_FROZEN_REPLAY_RECEIPT_SCHEMA =
  "pi-deepgoplus-hybrid-rsi-public-summary.v1" as const;
const RSI_Z55_FROZEN_REPLAY_SUITE_ID =
  "bioreason-pro-z55-prospective20" as const;
const RSI_Z55_CANDIDATE_PRECOMMIT_PATH =
  "protocols/z55-prospective20-v0002.json" as const;
const RSI_Z55_CANDIDATE_PRECOMMIT_CANONICAL_HASH =
  "fe47493104ff9a236e8fce5fd34aac42d84f7e6b345f93eca291c8174ef49830";
const RSI_Z55_CANDIDATE_GENOME_PATH =
  "genomes/development-z55-prospective-mf-consensus.json" as const;
const RSI_Z55_CANDIDATE_GENOME_HASH =
  "ad34fbe9bcf993d9a2353d6485734dd182128887b659f3fdfe0cea851a1892c0";
const RSI_Z55_CANDIDATE_GENOME_FILE_SHA256 =
  "446bbe4d10e2789cc6257a6599c6c0539a17ad0625f53229d1cc6936cf9c3f83";
const RSI_Z55_CONTROL_GENOME_HASH =
  "3f36e088c3eaa654a16a2f8ef0340421a75869ad64fac903be89d1ea6854af03";
const RSI_Z55_CONTROL_GENOME_PATH =
  "genomes/development-v11-causal-budget.json" as const;
const RSI_Z55_CONTROL_GENOME_FILE_SHA256 =
  "d40e768fd2702bb17d68dc7b78e40bcf1f109d601a35c715a08b4c86f939a718";
const RSI_Z55_CANDIDATE_VARIANT_ID =
  "g3_consensus_rerank_mf_scale_1_floor_0_35_top_10" as const;
const RSI_Z55_DEEPGOPLUS_METHOD_HASH =
  "b9090c140adbaeef96a97ae0b98dd1eba5edc23f4d333a159e4ec94dc46a5bbc";
const RSI_Z55_ONTOLOGY_SHA256 =
  "c72fc198a86983d55e43aac585d1ffdbeb6e3601475b3f18b6045acdc0a0734c";
const RSI_Z55_BASELINE_ACQUISITION_SCHEMA =
  "pi-prospective20-baseline-acquisition-binding.v1" as const;
const RSI_Z55_FROZEN_REPLAY_CHECK_IDS = [
  "selection_overall_fmax_gain_positive",
  "selection_molecular_function_fmax_gain_positive",
  "selection_bp_cc_predictions_unchanged",
  "selection_query_like_predictions_unchanged",
  "finalist_selection_decision_coherent",
  "test_result_present",
] as const;
const RSI_Z55_V0002_PRE_GOLD_VERSION_ID = "v0002" as const;
const RSI_Z55_V0002_PRE_GOLD_SOURCE_COMMIT =
  "924220f99ce354c68192f4dd19a1c3f77ba1018a";
const RSI_Z55_V0002_PRE_GOLD_VERSION_MANIFEST_HASH =
  "c6dc5963717d55c4684ebeee73f042b625d9e6699f4ca308d275313930d8e92e";
const RSI_Z55_V0002_PRE_GOLD_VERSION_TAG_OBJECT_ID =
  "9ea480a31a8836f7000ea25b703d014c4f0d7a16";
const RSI_Z55_V0002_PRE_GOLD_EVALUATION_ID =
  "z55-v0002-prospective20" as const;
const RSI_Z55_V0002_PRE_GOLD_OPENING_MANIFEST_HASH =
  "9442482c6a2e0e40ba0eedb3311d942b792b6f28bda20b91b909388c31b9c283";
const RSI_Z55_V0002_PRE_GOLD_OPENING_TAG_OBJECT_ID =
  "23d87139d7f6ab3768ccd09b32881b37421fe186";
const RSI_Z55_V0002_PRE_GOLD_RESULT_MANIFEST_HASH =
  "da1272f78d9077287d574a547224c634ac887370e4d083db8965ae72c794f4e3";
const RSI_Z55_V0002_PRE_GOLD_RESULT_TAG_OBJECT_ID =
  "e747cf912bd3d5705731d63d2d9251f1661d020d";
const RSI_Z55_V0002_PRE_GOLD_RESULT_ARTIFACT_HASH =
  "6020e67dd5f1902a4376ede51b18b5204e39a7fcc84569f7f3006a15a2562225";
const RSI_Z55_V0002_PRE_GOLD_RESULT_PUBLIC_SUMMARY_HASH =
  "b465f3b784ccc634c132a85f6732f2d919c23028fdf2e1ccb1695c8ceee67e23";
const RSI_Z55_V0002_PRE_GOLD_PUBLICATION_MANIFEST_HASH =
  "e9d6ea5d25e16490c328d4d27ce27e8e74fbba9ad82d487203dda5c2124efab2";
const RSI_Z55_V0002_PRE_GOLD_PUBLICATION_TAG_OBJECT_ID =
  "aa6e47df13a5a68ae9a745577118f36e4d610c30";
const RSI_Z55_V0002_PRE_GOLD_DECISION_ID =
  "backtrack-v0002-pre-gold-contract-failure" as const;
const RSI_Z55_V0002_PRE_GOLD_DECISION_MANIFEST_HASH =
  "777d133c3c21c340a3fe8165fe74f6b2b0560218a9e7f159cd54d4562ae4750e";
const RSI_Z55_V0002_PRE_GOLD_DECISION_TAG_OBJECT_ID =
  "66b8ef940af05606b4ed1de0bb1537ba26f6357f";
const RSI_Z55_V0002_PRE_GOLD_CLAIM_BOUNDARY =
  "v0002 stopped before candidate scoring or private role-gold opening because the local acquisition receipt validator rejected the protocol-authorized sequence-only case; this is a label-independent software-contract failure, not protein-performance evidence." as const;
const RSI_Z55_V0002_PRE_GOLD_SUMMARY =
  "Hash-verified software_verification artifact: 2 passed, 1 failed, and 1 not applicable." as const;
const RSI_Z55_V0002_PRE_GOLD_CHECKS = [
  { checkId: "fixed-cohort-preparation", status: "passed" },
  { checkId: "baseline-full-recompute", status: "passed" },
  { checkId: "sequence-only-acquisition-receipt", status: "failed" },
  { checkId: "candidate-scoring", status: "not_applicable" },
] as const;
const RSI_Z55_V0002_PRE_GOLD_DECISION_RATIONALE =
  "v0002 reached a label-independent acquisition-receipt contract failure before candidate scoring; restore v0001 while preserving the frozen cohort and apply a bounded sequence-only validation fix in a new code version." as const;
const RSI_REQUIRED_PREFLIGHT_CHECK_IDS = [
  "typescript_typecheck",
  "typescript_tests",
  "python_tests",
  "production_build",
  "committed_diff_check",
] as const;
const RSI_IGNORED_EXECUTION_ROOTS = [
  "src",
  "schemas",
  "python",
  "bootstrap",
  "protocols",
  "scripts",
  ".github",
  ".pi",
  "pi-agent",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "Dockerfile.client",
] as const;

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const RSI_CODE_VERSION_SCHEMA = "pi-rsi-code-version.v1" as const;
export const RSI_CODE_EVALUATION_OPENING_SCHEMA =
  "pi-rsi-code-evaluation-opening.v1" as const;
export const RSI_CODE_EVALUATION_RESULT_SCHEMA =
  "pi-rsi-code-evaluation-result.v1" as const;
export const RSI_CODE_EVALUATION_PUBLICATION_SCHEMA =
  "pi-rsi-code-evaluation-publication.v1" as const;
export const RSI_CODE_DECISION_SCHEMA = "pi-rsi-code-decision.v1" as const;
export const RSI_CODE_EVENT_SCHEMA = "pi-rsi-code-event.v1" as const;
export const RSI_EPOCH_RESUME_SPEC_SCHEMA =
  "pi-rsi-epoch-resume-spec.v1" as const;
export const RSI_EPOCH_RESUME_SCHEMA = "pi-rsi-epoch-resume.v1" as const;
export const RSI_EPOCH_RESUME_CLAIM_BOUNDARY =
  "Epoch resumption authorizes a planned code candidate only; it does not change formal selection, promote a version, or make retrospective evidence prospective." as const;
export const RSI_DEVELOPER_HISTORY_CONTEXT_SCHEMA =
  "pi-rsi-developer-history-context.v1" as const;
export const RSI_DEVELOPER_HISTORY_CONTEXT_V2_SCHEMA =
  "pi-rsi-developer-history-context.v2" as const;
export const RSI_RETROSPECTIVE_EXPERIMENT_SCHEMA =
  "pi-rsi-retrospective-experiment.v1" as const;
export const RSI_RETROSPECTIVE_RECEIPT_SCHEMA =
  "pi-rsi-retrospective-experiment-receipt.v1" as const;
export const RSI_RETROSPECTIVE_CLAIM_BOUNDARY =
  "Retrospective post-hoc aggregate observation only; not a prospectively registered RSI code version or evaluation, not eligible to update formal selection, and not evidence for promotion." as const;
export const RSI_RETROSPECTIVE_INCUMBENT_SPEC_SCHEMA =
  "pi-rsi-retrospective-incumbent-spec.v1" as const;
export const RSI_RETROSPECTIVE_INCUMBENT_SCHEMA =
  "pi-rsi-retrospective-incumbent.v1" as const;
export const RSI_RETROSPECTIVE_INCUMBENT_CLAIM_BOUNDARY =
  "Retrospective incumbent adoption changes the operational development baseline only; formal prospective selection remains unchanged, the adopted version remains prospectively unevaluated, and all future promotion claims require a fresh prospective opening." as const;
export const RSI_DEVELOPER_HISTORY_CONTEXT_V3_SCHEMA =
  "pi-rsi-developer-history-context.v3" as const;
export const RSI_DEVELOPER_HISTORY_CONTEXT_V4_SCHEMA =
  "pi-rsi-developer-history-context.v4" as const;

export type RsiEvaluationResultKind =
  | "adaptive_development"
  | "software_verification"
  | "frozen_replay";
export type RsiDecisionAction = "continue" | "backtrack" | "retain";
export type RsiCodeEventKind =
  | "version"
  | "evaluation_opening"
  | "evaluation_result"
  | "evaluation_publication"
  | "decision"
  | "developer_exploration"
  | "epoch_resume"
  | "retrospective_experiment"
  | "retrospective_incumbent";

export interface RsiVersionBinding {
  versionId: string;
  manifestHash: string;
  sourceCommit: string;
  tagObjectId: string;
}

export interface RsiRetrospectiveObservation {
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
}

export interface RsiRetrospectiveExperimentReceipt
  extends Record<string, unknown> {
  schemaVersion: typeof RSI_RETROSPECTIVE_RECEIPT_SCHEMA;
  recordId: string;
  evaluatedCommit: string;
  changeSummary: string;
  hypothesis: string;
  component: RsiExplorationComponent;
  observations: RsiRetrospectiveObservation[];
  diagnoses: CausalDiagnosis[];
  prioritizedActions: CausalAction[];
  localGateOutcome:
    | "retain_experiment_control"
    | "prefer_experiment_candidate"
    | "inconclusive";
  claimBoundary: typeof RSI_RETROSPECTIVE_CLAIM_BOUNDARY;
  canonicalHash: string;
}

export interface RsiRetrospectiveExperimentManifest
  extends Record<string, unknown> {
  schemaVersion: typeof RSI_RETROSPECTIVE_EXPERIMENT_SCHEMA;
  recordId: string;
  tagRef: string;
  recordCommit: {
    sourceCommit: string;
    sourceTree: string;
  };
  evaluatedSource: {
    sourceCommit: string;
    sourceTree: string;
  };
  receipt: {
    relativePath: string;
    blobObjectId: string;
    fileSha256: string;
    canonicalHash: string;
    size: number;
  };
  formalSelection: {
    selectedVersion: RsiVersionBinding;
    eventSequence: number;
    eventManifestHash: string;
    formalDecisionMutation: null;
  };
  experiment: {
    changeSummary: string;
    hypothesis: string;
    component: RsiExplorationComponent;
    observations: RsiRetrospectiveObservation[];
    diagnoses: CausalDiagnosis[];
    prioritizedActions: CausalAction[];
    localGateOutcome:
      | "retain_experiment_control"
      | "prefer_experiment_candidate"
      | "inconclusive";
  };
  archive: {
    archiveSealHash: string;
    publicManifestHash: string;
  };
  policies: {
    evidenceTiming:
      "retrospective_post_hoc_without_pre_evaluation_opening";
    graphRole: "knowledge_only_not_a_code_version_node";
    selectionEligibility:
      "ineligible_never_updates_selected_version";
    promotionEligibility: "ineligible_not_prospective_evidence";
    artifactRetention: "external_hash_bound_archive_required";
  };
  claimBoundary: typeof RSI_RETROSPECTIVE_CLAIM_BOUNDARY;
  canonicalHash: string;
}

export interface RsiRetrospectiveIncumbentSpec
  extends Record<string, unknown> {
  schemaVersion: typeof RSI_RETROSPECTIVE_INCUMBENT_SPEC_SCHEMA;
  adoptionId: string;
  incumbentVersionId: string;
  plannedVersionId: string;
  reason: string;
  hypothesis: string;
  plannedChangeSummary: string;
  codeChangeTargets: string[];
  controls: string[];
  verificationRequirements: string[];
  evidence: {
    suiteId: string;
    reportPath: string;
    reportSha256: string;
    cohort: {
      development: 40;
      calibration: 20;
      selection: 20;
      test: 20;
      total: 100;
    };
    metric: "hierarchical_protein_centric_fmax_v1";
    selectedVariantId: string;
    selectionOverallFmax: {
      baseline: number;
      candidate: number;
      candidateMinusBaseline: number;
    };
    testOverallFmax: {
      baseline: number;
      candidate: number;
      candidateMinusBaseline: number;
    };
    artifactCanonicalHashes: {
      opening: string;
      finalist: string;
      testOpening: string;
      publicSummary: string;
    };
    claimBoundary: string;
  };
  evaluationPolicy:
    "fresh_prospective_opening_required_for_future_candidate_v1";
  retrospectiveEvidencePolicy:
    "development_signal_never_formal_promotion_evidence_v1";
  claimBoundary: typeof RSI_RETROSPECTIVE_INCUMBENT_CLAIM_BOUNDARY;
  canonicalHash: string;
}

export interface RsiRetrospectiveIncumbentManifest
  extends Record<string, unknown> {
  schemaVersion: typeof RSI_RETROSPECTIVE_INCUMBENT_SCHEMA;
  adoptionId: string;
  tagRef: string;
  recordCommit: {
    sourceCommit: string;
    sourceTree: string;
  };
  historyPrefix: {
    eventSequence: number;
    eventManifestHash: string;
    selectedVersionId: string;
    operationalIncumbentVersionId: string;
  };
  formalSelection: {
    selectedVersion: RsiVersionBinding;
    formalDecisionMutation: null;
  };
  incumbentVersion: RsiVersionBinding;
  evidence: RsiRetrospectiveIncumbentSpec["evidence"] & {
    reportBlobObjectId: string;
  };
  nextCandidate: {
    schemaVersion: typeof RSI_RETROSPECTIVE_INCUMBENT_SPEC_SCHEMA;
    plannedVersionId: string;
    reason: string;
    hypothesis: string;
    plannedChangeSummary: string;
    codeChangeTargets: string[];
    controls: string[];
    verificationRequirements: string[];
    evaluationPolicy:
      "fresh_prospective_opening_required_for_future_candidate_v1";
    retrospectiveEvidencePolicy:
      "development_signal_never_formal_promotion_evidence_v1";
    planHash: string;
  };
  policies: {
    authority: "immutable_annotated_tag_and_serial_event_v1";
    operationalRole: "developer_and_runtime_incumbent_v1";
    formalSelection: "unchanged_until_prospective_decision_v1";
    evidenceTiming:
      "retrospective_preexisting_development_and_procedural_holdout_v1";
    promotionEligibility:
      "ineligible_retrospective_evidence_never_promotes_v1";
    candidateOrder:
      "incumbent_plan_before_candidate_commit_and_registration_v1";
  };
  claimBoundary: typeof RSI_RETROSPECTIVE_INCUMBENT_CLAIM_BOUNDARY;
  canonicalHash: string;
}

export interface RsiEpochResumeSpec extends Record<string, unknown> {
  schemaVersion: typeof RSI_EPOCH_RESUME_SPEC_SCHEMA;
  epochId: string;
  baseVersionId: string;
  plannedVersionId: string;
  reason: string;
  hypothesis: string;
  plannedChangeSummary: string;
  codeChangeTargets: string[];
  controls: string[];
  verificationRequirements: string[];
  evaluationPolicy:
    "fresh_prospective_opening_required_before_private_evaluation_v1";
  retrospectiveEvidencePolicy:
    "knowledge_only_never_promotion_eligible_v1";
  claimBoundary: typeof RSI_EPOCH_RESUME_CLAIM_BOUNDARY;
  canonicalHash: string;
}

export interface RsiEpochResumeManifest extends Record<string, unknown> {
  schemaVersion: typeof RSI_EPOCH_RESUME_SCHEMA;
  resumeId: string;
  tagRef: string;
  terminalStop: {
    explorationId: string;
    manifestHash: string;
    tagObjectId: string;
    eventSequence: number;
    eventManifestHash: string;
  };
  historyPrefix: {
    eventSequence: number;
    eventManifestHash: string;
    selectedVersionId: string;
  };
  selectedVersion: RsiVersionBinding;
  baseVersion: RsiVersionBinding;
  nextEpoch: {
    schemaVersion: typeof RSI_EPOCH_RESUME_SPEC_SCHEMA;
    epochId: string;
    plannedVersionId: string;
    reason: string;
    hypothesis: string;
    plannedChangeSummary: string;
    codeChangeTargets: string[];
    controls: string[];
    verificationRequirements: string[];
    evaluationPolicy:
      "fresh_prospective_opening_required_before_private_evaluation_v1";
    retrospectiveEvidencePolicy:
      "knowledge_only_never_promotion_eligible_v1";
    planHash: string;
  };
  policies: {
    authority: "immutable_annotated_tag_and_serial_event_v1";
    resumption: "explicit_append_only_new_epoch_after_terminal_stop_v1";
    selection: "unchanged_until_prospective_decision_v1";
    candidateOrder:
      "resume_plan_before_candidate_commit_and_registration_v1";
  };
  claimBoundary: typeof RSI_EPOCH_RESUME_CLAIM_BOUNDARY;
  canonicalHash: string;
}

export interface RsiCodeVersionManifest extends Record<string, unknown> {
  schemaVersion: typeof RSI_CODE_VERSION_SCHEMA;
  versionId: string;
  tagRef: string;
  sourceCommit: string;
  sourceTree: string;
  parent: RsiVersionBinding | null;
  change: {
    summary: string;
    hypothesis: string;
  };
  verification: {
    receiptSha256: string;
    receiptSize: number;
  };
  developmentContext?: {
    schemaVersion:
      | typeof RSI_DEVELOPER_HISTORY_CONTEXT_SCHEMA
      | typeof RSI_DEVELOPER_HISTORY_CONTEXT_V2_SCHEMA
      | typeof RSI_DEVELOPER_HISTORY_CONTEXT_V3_SCHEMA
      | typeof RSI_DEVELOPER_HISTORY_CONTEXT_V4_SCHEMA;
    contextHash: string;
    eventSequence: number;
    eventManifestHash: string;
    selectedVersionId: string;
  } | null;
  developmentPlan?:
    | {
      schemaVersion: typeof RSI_DEVELOPER_EXPLORATION_SCHEMA;
      explorationId: string;
      manifestHash: string;
      tagObjectId: string;
      sourceVersionId: string;
      baseVersionId: string;
      plannedVersionId: string;
      evaluationAnalysisHash: string;
      planHash: string;
    }
    | {
      schemaVersion: typeof RSI_EPOCH_RESUME_SCHEMA;
      resumeId: string;
      manifestHash: string;
      tagObjectId: string;
      terminalExplorationId: string;
      baseVersionId: string;
      plannedVersionId: string;
      planHash: string;
    }
    | {
      schemaVersion: typeof RSI_RETROSPECTIVE_INCUMBENT_SCHEMA;
      adoptionId: string;
      manifestHash: string;
      tagObjectId: string;
      baseVersionId: string;
      plannedVersionId: string;
      planHash: string;
    };
  policies: {
    identity: "annotated_git_tag_exact_commit_v1";
    topology: "single_parent_no_merge_between_versions_v1";
    evaluation: "remote_version_tag_before_evaluation_v1";
  };
  canonicalHash: string;
}

export interface RsiEvaluationOpeningManifest extends Record<string, unknown> {
  schemaVersion: typeof RSI_CODE_EVALUATION_OPENING_SCHEMA;
  evaluationId: string;
  tagRef: string;
  version: RsiVersionBinding;
  protocol: {
    protocolId: string;
    protocolHash: string;
  };
  state: "opened_before_private_evaluation";
  canonicalHash: string;
}

export interface RsiEvaluationResultManifest extends Record<string, unknown> {
  schemaVersion: typeof RSI_CODE_EVALUATION_RESULT_SCHEMA;
  evaluationId: string;
  tagRef: string;
  openingHash: string;
  version: RsiVersionBinding;
  result: {
    kind: RsiEvaluationResultKind;
    artifactHash: string;
    publicSummaryHash?: string;
  };
  stateRoot: {
    archiveSealHash: string;
    publicManifestHash: string;
  } | null;
  claimBoundary: string;
  state: "completed";
  canonicalHash: string;
}

export interface RsiMetricScope {
  evaluable: boolean;
  proteinCount: number;
  fmax: number | null;
  precisionAtFmax: number | null;
  recallAtFmax: number | null;
  coverageAtFmax: number | null;
  aupr: number | null;
  smin: number | null;
}

export interface RsiMetricSummary {
  overall: RsiMetricScope;
  aspects: {
    molecular_function: RsiMetricScope;
    biological_process: RsiMetricScope;
    cellular_component: RsiMetricScope;
  };
}

export type RsiAdaptiveDecision =
  | "selected_successor"
  | "reject_no_gain"
  | "reject_aspect_guardrail"
  | "reject_falsifier";

export interface RsiAdaptivePublicSummary extends Record<string, unknown> {
  kind: "adaptive_protein_function";
  campaignId: string;
  round: number;
  cohort: {
    role: "adaptive_development";
    caseCount: number;
    cohortHash: string;
  };
  metricInterpretation: "in_sample_descriptive_only";
  sourceDocuments: {
    proposalHash: string;
    feedbackHash: string;
    outcomeHash: string;
    developerPlanHash: string | null;
    codeVersionHistoryHash: string | null;
    researchCardBundleHash: string;
  };
  control: {
    metrics: RsiMetricSummary;
  };
  challenger: {
    metrics: RsiMetricSummary;
    pairedDelta: Record<string, unknown>;
    overallFmaxGain: number;
    maximumPopulatedAspectFmaxDrop: number;
    decision: RsiAdaptiveDecision;
  };
  teacher: {
    hypothesisVerdict:
      OptimizationCausalTeacherFeedback["hypothesisVerdict"];
    mechanismVerdict:
      OptimizationCausalTeacherFeedback["mechanismVerdict"];
    diagnoses: OptimizationCausalTeacherFeedback["diagnoses"];
    prioritizedActions:
      OptimizationCausalTeacherFeedback["prioritizedActions"];
  };
  method: {
    templateId: MethodExperimentTemplateId | null;
    family: CausalTeacherFamily | null;
    hypothesis: string;
    changeSummary: string;
    externalEvidenceIds: string[];
  };
}

interface RsiNonAdaptivePublicSummaryBase extends Record<string, unknown> {
  summary: string;
  artifactClaimBoundary: string;
  checks: Array<{
    checkId: string;
    status: "passed" | "failed" | "not_applicable";
  }>;
  teacher: null;
}

export interface RsiGenericPublicSummary
  extends RsiNonAdaptivePublicSummaryBase {
  kind: "software_verification";
}

export interface RsiFrozenReplayEvidenceBinding
  extends Record<string, unknown> {
  receiptSchemaVersion: typeof RSI_Z55_FROZEN_REPLAY_RECEIPT_SCHEMA;
  receiptCanonicalHash: string;
  protocolId: typeof RSI_Z55_FROZEN_REPLAY_PROTOCOL_ID;
  protocolHash: string;
  formalOpeningHash: string;
  formalOpeningTagObjectId: string;
  finalistHash: string;
  baselineBatchCanonicalHash: string;
  baselineAcquisitionCanonicalHash: string;
  baselineAcquisition: RsiFrozenReplayBaselineAcquisitionBinding;
  prospective20PrivateEvidenceAudit:
    RsiFrozenReplayPrivateEvidenceAudit;
  liveReplayCanonicalHash: string;
  controlPredictionHash: string;
  candidatePredictionHash: string;
  selectionDecision: "promote_candidate" | "retain_baseline";
  selectedVariantId:
    | typeof RSI_Z55_CANDIDATE_VARIANT_ID
    | "agent_baseline";
  candidateVariantId: typeof RSI_Z55_CANDIDATE_VARIANT_ID;
  candidateGenomeHash: string;
  controlGenomeHash: string;
  deepGoPlusMethodHash: string;
  ontologySha256: string;
}

export interface RsiFrozenReplayPrivateEvidenceAudit
  extends Record<string, unknown> {
  samplingReceiptHash: string;
  homologyAuditHash: string;
  excludedPriorSuiteCount: 8;
  excludedPriorIdentityCount: 122;
  matchedSourceRecordCount: 122;
  selectedPairCount: 190;
  sharedInterproPairCount: 0;
  pairsAtOrAboveKmerThreshold: 0;
}

export interface RsiFrozenReplayBaselineAcquisitionBinding
  extends Record<string, unknown> {
  schemaVersion: typeof RSI_Z55_BASELINE_ACQUISITION_SCHEMA;
  suiteId: typeof RSI_Z55_FROZEN_REPLAY_SUITE_ID;
  publicManifestHash: string;
  privateExclusionsHash: string;
  genomeHash: string;
  ontologySha256: string;
  batchManifestHash: string;
  planHash: string;
  planFileSha256: string;
  receiptHash: string;
  receiptFileSha256: string;
  sourceManifestHash: string;
  sourceManifestFileSha256: string;
  executionScope: "portable_remote" | "developer_local_snapshot";
  sourceKind: "remote_exact_cache" | "local_content_snapshot";
  acquisitionEpochId: string;
  status: "completed";
  caseCount: 20;
  completedCaseCount: 20;
  canonicalHash: string;
}

export interface RsiFrozenReplayPublicSummary
  extends RsiNonAdaptivePublicSummaryBase {
  kind: "frozen_replay";
  evidenceBinding: RsiFrozenReplayEvidenceBinding;
}

type RsiNonAdaptivePublicSummary =
  | RsiGenericPublicSummary
  | RsiFrozenReplayPublicSummary;

export type RsiEvaluationPublicSummary =
  | RsiAdaptivePublicSummary
  | RsiNonAdaptivePublicSummary;

export interface RsiEvaluationPublicationManifest extends Record<string, unknown> {
  schemaVersion: typeof RSI_CODE_EVALUATION_PUBLICATION_SCHEMA;
  evaluationId: string;
  tagRef: string;
  version: RsiVersionBinding;
  opening: {
    manifestHash: string;
    tagObjectId: string;
    protocolId: string;
    protocolHash: string;
  };
  result: {
    manifestHash: string;
    tagObjectId: string;
    kind: RsiEvaluationResultKind;
    artifactHash: string;
    stateRootPublicManifestHash: string | null;
  };
  publicationMode: "prospective" | "retrospective_legacy";
  publicSummary: RsiEvaluationPublicSummary;
  claimBoundary: string;
  canonicalHash: string;
}

export interface RsiDecisionManifest extends Record<string, unknown> {
  schemaVersion: typeof RSI_CODE_DECISION_SCHEMA;
  decisionId: string;
  tagRef: string;
  previousDecision: {
    decisionId: string;
    manifestHash: string;
  } | null;
  evaluation: {
    evaluationId: string;
    resultManifestHash: string;
    publicationManifestHash?: string;
  };
  selectionBefore: RsiVersionBinding;
  candidateVersion: RsiVersionBinding;
  selectedVersion: RsiVersionBinding;
  action: RsiDecisionAction;
  rationale: string;
  canonicalHash: string;
}

export interface RsiCodeEventManifest extends Record<string, unknown> {
  schemaVersion: typeof RSI_CODE_EVENT_SCHEMA;
  sequence: number;
  tagRef: string;
  previousEvent: {
    sequence: number;
    manifestHash: string;
    tagObjectId: string;
  } | null;
  mutation: {
    kind: RsiCodeEventKind;
    ref: string;
    manifestHash: string;
    tagObjectId: string;
  };
  canonicalHash: string;
}

export interface TaggedManifest<T> {
  ref: string;
  tagObjectId: string;
  targetCommit: string;
  manifest: T;
}

export interface RsiVersionGraph {
  repositoryRoot: string;
  versions: TaggedManifest<RsiCodeVersionManifest>[];
  evaluationOpenings: TaggedManifest<RsiEvaluationOpeningManifest>[];
  evaluationResults: TaggedManifest<RsiEvaluationResultManifest>[];
  evaluationPublications: TaggedManifest<RsiEvaluationPublicationManifest>[];
  decisions: TaggedManifest<RsiDecisionManifest>[];
  developerExplorations: TaggedManifest<RsiDeveloperExplorationManifest>[];
  epochResumes: TaggedManifest<RsiEpochResumeManifest>[];
  retrospectiveExperiments:
    TaggedManifest<RsiRetrospectiveExperimentManifest>[];
  retrospectiveIncumbents:
    TaggedManifest<RsiRetrospectiveIncumbentManifest>[];
  events: TaggedManifest<RsiCodeEventManifest>[];
  rootVersionId: string | null;
  selectedVersionId: string | null;
  operationalIncumbentVersionId: string | null;
  currentBestVersionId: string | null;
  decisionHeadId: string | null;
  incompleteEvaluationIds: string[];
  unpublishedEvaluationIds: string[];
  undecidedEvaluationIds: string[];
  unevaluatedVersionIds: string[];
  unresolvedVersionIds: string[];
  retrospectivelyAdoptedVersionIds: string[];
  proteinEvaluationIncompleteVersionIds: string[];
  unreflectedTerminalVersionIds: string[];
  readyForNextVersion: boolean;
  historyComplete: boolean;
  evaluationComplete: boolean;
  paperComplete: boolean;
}

export interface RsiDeveloperHistoryRecord {
  eventSequence: number;
  versionId: string;
  parentVersionId: string | null;
  evaluationId: string;
  resultKind: RsiEvaluationResultKind;
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
  outcome: RsiAdaptiveDecision | "passed" | "failed";
  teacher: {
    hypothesisVerdict:
      OptimizationCausalTeacherFeedback["hypothesisVerdict"];
    mechanismVerdict:
      OptimizationCausalTeacherFeedback["mechanismVerdict"];
    diagnoses: OptimizationCausalTeacherFeedback["diagnoses"];
    prioritizedActions: CausalAction[];
  } | null;
  decision: {
    action: RsiDecisionAction;
    selectedVersionId: string;
    rationale: string;
  } | null;
  publicationHash: string;
  claimBoundary: string;
}

interface RsiDeveloperHistoryContextBase extends Record<string, unknown> {
  graphHead: {
    eventSequence: number;
    eventManifestHash: string;
    selectedVersionId: string;
  };
  records: RsiDeveloperHistoryRecord[];
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
    teacherDistillation:
      RsiDeveloperExplorationManifest["nextOptimizationPlan"]["teacherDistillation"];
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
  canonicalHash: string;
}

export interface RsiDeveloperHistoryContextV1
  extends RsiDeveloperHistoryContextBase {
  schemaVersion: typeof RSI_DEVELOPER_HISTORY_CONTEXT_SCHEMA;
}

export interface RsiDeveloperHistoryRetrospectiveRecord {
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
  observations: RsiRetrospectiveObservation[];
  diagnoses: CausalDiagnosis[];
  prioritizedActions: CausalAction[];
  localGateOutcome:
    | "retain_experiment_control"
    | "prefer_experiment_candidate"
    | "inconclusive";
  archiveSealHash: string;
  archivePublicManifestHash: string;
  evidenceTiming:
    "retrospective_post_hoc_without_pre_evaluation_opening";
  selectionEligibility: "ineligible_never_updates_selected_version";
  promotionEligibility: "ineligible_not_prospective_evidence";
  claimBoundary: typeof RSI_RETROSPECTIVE_CLAIM_BOUNDARY;
}

export interface RsiDeveloperHistoryContextV2
  extends RsiDeveloperHistoryContextBase {
  schemaVersion: typeof RSI_DEVELOPER_HISTORY_CONTEXT_V2_SCHEMA;
  retrospectiveRecords: RsiDeveloperHistoryRetrospectiveRecord[];
}

export interface RsiDeveloperHistoryRetrospectiveIncumbentRecord {
  eventSequence: number;
  adoptionId: string;
  manifestHash: string;
  selectedVersionId: string;
  operationalIncumbentVersionId: string;
  evidence: RsiRetrospectiveIncumbentManifest["evidence"];
  plannedVersionId: string;
  planHash: string;
  claimBoundary: typeof RSI_RETROSPECTIVE_INCUMBENT_CLAIM_BOUNDARY;
}

export interface RsiDeveloperHistoryContextV3
  extends RsiDeveloperHistoryContextBase {
  schemaVersion: typeof RSI_DEVELOPER_HISTORY_CONTEXT_V3_SCHEMA;
  retrospectiveRecords: RsiDeveloperHistoryRetrospectiveRecord[];
  retrospectiveIncumbents:
    RsiDeveloperHistoryRetrospectiveIncumbentRecord[];
  operationalIncumbentVersionId: string;
}

export interface RsiDeveloperHistoryContextV4
  extends RsiDeveloperHistoryContextBase {
  schemaVersion: typeof RSI_DEVELOPER_HISTORY_CONTEXT_V4_SCHEMA;
  retrospectiveRecords: RsiDeveloperHistoryRetrospectiveRecord[];
  retrospectiveIncumbents:
    RsiDeveloperHistoryRetrospectiveIncumbentRecord[];
  /**
   * Canonical default base for the next plan. This is deliberately separate
   * from the last formal prospective selection retained for audit.
   */
  currentBestVersionId: string;
  lastProspectivelySelectedVersionId: string;
}

export type RsiDeveloperHistoryContext =
  | RsiDeveloperHistoryContextV1
  | RsiDeveloperHistoryContextV2
  | RsiDeveloperHistoryContextV3
  | RsiDeveloperHistoryContextV4;

export interface RegisterRsiVersionInput {
  repositoryRoot: string;
  versionId: string;
  parentVersionId?: string;
  changeSummary: string;
  hypothesis: string;
  verificationReceiptPath: string;
  developerContextPath?: string;
  developerExplorationId?: string;
  epochResumeId?: string;
  retrospectiveIncumbentId?: string;
  remote: string;
}

export interface RecordRsiDeveloperExplorationInput {
  repositoryRoot: string;
  explorationId: string;
  planSpecPath: string;
  remote: string;
}

export interface RecordRsiEpochResumeInput {
  repositoryRoot: string;
  resumeId: string;
  specPath: string;
  remote: string;
}

export interface RecordRsiRetrospectiveExperimentInput {
  repositoryRoot: string;
  recordId: string;
  receiptPath: string;
  archiveSealHash: string;
  archivePublicManifestHash: string;
  remote: string;
}

export interface RecordRsiRetrospectiveIncumbentInput {
  repositoryRoot: string;
  adoptionId: string;
  specPath: string;
  remote: string;
}

export interface OpenRsiEvaluationInput {
  repositoryRoot: string;
  versionId: string;
  evaluationId: string;
  protocolId: string;
  protocolHash: string;
  remote: string;
}

export interface CompleteRsiEvaluationInput {
  repositoryRoot: string;
  evaluationId: string;
  resultKind: RsiEvaluationResultKind;
  resultArtifactHash: string;
  stateRoot?: {
    archiveDir: string;
  };
  claimBoundary: string;
  remote: string;
}

interface WriteRsiEvaluationResultInput
  extends Omit<CompleteRsiEvaluationInput, "stateRoot"> {
  stateRoot: RsiEvaluationResultManifest["stateRoot"];
  publicSummary: RsiEvaluationPublicSummary;
}

export interface PublishRsiEvaluationInput {
  repositoryRoot: string;
  evaluationId: string;
  publicationMode: "prospective" | "retrospective_legacy";
  publicSummary: RsiEvaluationPublicSummary;
  claimBoundary: string;
  remote: string;
}

export interface OpenRsiEvaluationRequirement {
  repositoryRoot: string;
  versionId: string;
  evaluationId: string;
  protocolId?: string;
  protocolHash?: string;
  remote: string;
}

export interface RecordRsiDecisionInput {
  repositoryRoot: string;
  decisionId: string;
  evaluationId: string;
  action: RsiDecisionAction;
  selectedVersionId: string;
  rationale: string;
  remote: string;
}

function assertId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) {
    throw new Error(`${label} must match ${SAFE_ID}`);
  }
  return value;
}

function assertHash(value: string, label: string): string {
  if (!HASH.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash`);
  return value;
}

function assertOid(value: string, label: string): string {
  if (!OID.test(value)) throw new Error(`${label} must be a full Git object ID`);
  return value;
}

function assertText(value: string, label: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 1000) {
    throw new Error(`${label} must be trimmed and contain 1-1000 characters`);
  }
  return value;
}

function withCanonicalHash<T extends Record<string, unknown>>(
  content: T,
): T & { canonicalHash: string } {
  return { ...content, canonicalHash: hashCanonical(content) };
}

function withoutCanonicalHash(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const { canonicalHash: _canonicalHash, ...content } = value;
  return content;
}

function exactRetrospectiveKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(compareAscii);
  const canonicalExpected = [...expected].sort(compareAscii);
  if (canonicalJson(actual) !== canonicalJson(canonicalExpected)) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function parseRetrospectiveReceipt(
  value: unknown,
  label: string,
): RsiRetrospectiveExperimentReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  exactRetrospectiveKeys(record, [
    "schemaVersion",
    "recordId",
    "evaluatedCommit",
    "changeSummary",
    "hypothesis",
    "component",
    "observations",
    "diagnoses",
    "prioritizedActions",
    "localGateOutcome",
    "claimBoundary",
    "canonicalHash",
  ], label);
  if (record.schemaVersion !== RSI_RETROSPECTIVE_RECEIPT_SCHEMA) {
    throw new Error(`${label} has an unsupported schemaVersion`);
  }
  for (const field of [
    "recordId",
    "evaluatedCommit",
    "changeSummary",
    "hypothesis",
  ] as const) {
    if (typeof record[field] !== "string") {
      throw new Error(`${label} ${field} must be a string`);
    }
  }
  const recordId = assertId(record.recordId as string, `${label} recordId`);
  const evaluatedCommit = assertOid(
    record.evaluatedCommit as string,
    `${label} evaluatedCommit`,
  );
  const changeSummary = assertText(
    record.changeSummary as string,
    `${label} changeSummary`,
  );
  const hypothesis = assertText(
    record.hypothesis as string,
    `${label} hypothesis`,
  );
  if (!(RSI_EXPLORATION_COMPONENTS as readonly unknown[]).includes(
    record.component,
  )) {
    throw new Error(`${label} component is unsupported`);
  }
  if (!Array.isArray(record.observations)
    || record.observations.length < 1
    || record.observations.length > 32) {
    throw new Error(`${label} observations must contain 1-32 items`);
  }
  const seenObservationIds = new Set<string>();
  const cohortRoles = new Set([
    "development",
    "calibration",
    "development_calibration",
    "selection",
    "test",
    "all_descriptive",
  ]);
  const interpretations = new Set([
    "development_signal",
    "selection_gate",
    "descriptive_only",
  ]);
  const observations = record.observations.map(
    (raw, index): RsiRetrospectiveObservation => {
      const observationLabel = `${label} observations[${index}]`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`${observationLabel} must be an object`);
      }
      const observation = raw as Record<string, unknown>;
      exactRetrospectiveKeys(observation, [
        "observationId",
        "cohortRole",
        "metric",
        "baseline",
        "candidate",
        "candidateMinusBaseline",
        "interpretation",
      ], observationLabel);
      if (typeof observation.observationId !== "string") {
        throw new Error(`${observationLabel} observationId must be a string`);
      }
      const observationId = assertId(
        observation.observationId,
        `${observationLabel} observationId`,
      );
      if (seenObservationIds.has(observationId)) {
        throw new Error(`${label} repeats an observation ID`);
      }
      seenObservationIds.add(observationId);
      if (!cohortRoles.has(String(observation.cohortRole))
        || observation.metric !== "fmax"
        || !interpretations.has(String(observation.interpretation))) {
        throw new Error(`${observationLabel} uses an unsupported closed value`);
      }
      for (const field of [
        "baseline",
        "candidate",
        "candidateMinusBaseline",
      ] as const) {
        if (typeof observation[field] !== "number"
          || !Number.isFinite(observation[field])) {
          throw new Error(`${observationLabel} ${field} must be finite`);
        }
      }
      const baseline = observation.baseline as number;
      const candidate = observation.candidate as number;
      const delta = observation.candidateMinusBaseline as number;
      if (baseline < 0 || baseline > 1
        || candidate < 0 || candidate > 1
        || delta < -1 || delta > 1
        || Math.abs(candidate - baseline - delta) > 1e-12) {
        throw new Error(
          `${observationLabel} has inconsistent bounded Fmax values`,
        );
      }
      return {
        observationId,
        cohortRole:
          observation.cohortRole as RsiRetrospectiveObservation["cohortRole"],
        metric: "fmax",
        baseline,
        candidate,
        candidateMinusBaseline: delta,
        interpretation:
          observation.interpretation as
            RsiRetrospectiveObservation["interpretation"],
      };
    },
  );
  const closedArray = <T extends string>(
    raw: unknown,
    allowed: readonly T[],
    field: string,
  ): T[] => {
    if (!Array.isArray(raw) || raw.length > 32
      || new Set(raw).size !== raw.length
      || raw.some((item) => !allowed.includes(item as T))) {
      throw new Error(`${label} ${field} is not a closed unique array`);
    }
    const canonical = allowed.filter((item) => raw.includes(item));
    if (canonicalJson(raw) !== canonicalJson(canonical)) {
      throw new Error(`${label} ${field} is not canonically ordered`);
    }
    return [...canonical];
  };
  const diagnoses = closedArray(
    record.diagnoses,
    CAUSAL_DIAGNOSES,
    "diagnoses",
  );
  const prioritizedActions = closedArray(
    record.prioritizedActions,
    CAUSAL_ACTIONS,
    "prioritizedActions",
  );
  if (![
    "retain_experiment_control",
    "prefer_experiment_candidate",
    "inconclusive",
  ].includes(String(record.localGateOutcome))) {
    throw new Error(`${label} localGateOutcome is unsupported`);
  }
  if (record.claimBoundary !== RSI_RETROSPECTIVE_CLAIM_BOUNDARY) {
    throw new Error(`${label} claimBoundary is invalid`);
  }
  if (typeof record.canonicalHash !== "string"
    || record.canonicalHash
      !== hashCanonical(withoutCanonicalHash(record))) {
    throw new Error(`${label} canonical hash is invalid`);
  }
  assertPublicManifest(record, label);
  return {
    schemaVersion: RSI_RETROSPECTIVE_RECEIPT_SCHEMA,
    recordId,
    evaluatedCommit,
    changeSummary,
    hypothesis,
    component: record.component as RsiExplorationComponent,
    observations,
    diagnoses,
    prioritizedActions,
    localGateOutcome:
      record.localGateOutcome as
        RsiRetrospectiveExperimentReceipt["localGateOutcome"],
    claimBoundary: RSI_RETROSPECTIVE_CLAIM_BOUNDARY,
    canonicalHash: record.canonicalHash,
  };
}

function assertPublicManifest(value: unknown, label: string): void {
  const visit = (current: unknown, path: string): void => {
    if (typeof current === "string") {
      const normalized = current.normalize("NFKC");
      if (PUBLIC_SENSITIVE_VALUE.test(normalized)
        || PUBLIC_ACCESSION.test(normalized)
        || PUBLIC_URL_OR_ABSOLUTE_PATH.test(normalized)
        || PUBLIC_ENCODED_PAYLOAD.test(normalized)
        || PUBLIC_OBFUSCATED_GO_ID.test(normalized)
        || PUBLIC_DESCRIBED_GO_ID.test(normalized)
        || PUBLIC_RELATIVE_PRIVATE_PATH.test(normalized)
        || PUBLIC_UNSAFE_TEXT_LAYOUT.test(normalized)
        || (!HASH.test(normalized)
          && !OID.test(normalized)
          && (PUBLIC_PROTEIN_SEQUENCE.test(normalized)
            || containsSegmentedProteinSequence(normalized)))) {
        throw new Error(
          `${label} contains a private path, URL, biological target identifier, or protein sequence at ${path}`,
        );
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(
      current as Record<string, unknown>,
    )) {
      if (PUBLIC_SENSITIVE_KEY.test(key)) {
        throw new Error(
          `${label} contains a private-looking field at ${path}.${key}`,
        );
      }
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, "$");
}

async function assertSchema(
  filename: string,
  value: unknown,
  label: string,
  scanPublic = true,
): Promise<void> {
  const schemaDirectory = join(PROJECT_ROOT, "schemas");
  const schema = JSON.parse(await readFile(
    join(schemaDirectory, filename),
    "utf8",
  )) as TSchema;
  const context: Record<PropertyKey, TSchema> = {};
  for (const dependencyFilename of [
    "rsi_code_evaluation_publication.schema.json",
    "rsi_evaluation_analysis.schema.json",
    "rsi_next_optimization_plan.schema.json",
    "rsi_developer_exploration.schema.json",
  ]) {
    const dependency = JSON.parse(await readFile(
      join(schemaDirectory, dependencyFilename),
      "utf8",
    )) as TSchema & {
      $id?: string;
      $defs?: Record<string, TSchema>;
    };
    if (dependency.$id) context[dependency.$id] = dependency;
    if (dependencyFilename ===
        "rsi_code_evaluation_publication.schema.json"
      && dependency.$id && dependency.$defs) {
      for (const definition of [
        "adaptivePublicSummary",
        "genericPublicSummary",
      ]) {
        const target = dependency.$defs[definition];
        if (!target) continue;
        const reference = `${dependency.$id}#/$defs/${definition}`;
        context[reference] = {
          ...target,
          $id: reference,
          $defs: dependency.$defs,
        } as TSchema;
      }
    }
  }
  if (!Value.Check(context, schema, value)) {
    throw new Error(`${label} does not satisfy ${filename}`);
  }
  const record = value as Record<string, unknown>;
  if (record.canonicalHash !== hashCanonical(withoutCanonicalHash(record))) {
    throw new Error(`${label} canonical hash is invalid`);
  }
  if (scanPublic) assertPublicManifest(value, label);
}

async function assertEvaluationPublicSummarySchema(
  summary: RsiEvaluationPublicSummary,
  label: string,
): Promise<void> {
  const hash = "0".repeat(64);
  const oid = "0".repeat(40);
  const adaptive = summary.kind === "adaptive_protein_function";
  const probe = withCanonicalHash({
    schemaVersion: RSI_CODE_EVALUATION_PUBLICATION_SCHEMA,
    evaluationId: "summary-validation",
    tagRef:
      "refs/tags/rsi/evaluation/summary-validation/publication",
    version: {
      versionId: "summary-validation",
      manifestHash: hash,
      sourceCommit: oid,
      tagObjectId: oid,
    },
    opening: {
      manifestHash: hash,
      tagObjectId: oid,
      protocolId: "summary-validation",
      protocolHash: hash,
    },
    result: {
      manifestHash: hash,
      tagObjectId: oid,
      kind: adaptive ? "adaptive_development" : summary.kind,
      artifactHash: hash,
      stateRootPublicManifestHash: adaptive ? hash : null,
    },
    publicationMode: "prospective" as const,
    publicSummary: structuredClone(summary),
    claimBoundary: "Public-summary schema validation probe.",
  });
  await assertSchema(
    "rsi_code_evaluation_publication.schema.json",
    probe,
    label,
  );
}

async function git(
  repositoryRoot: string,
  args: string[],
): Promise<string> {
  try {
    const environment = { ...process.env };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_REPLACE_REF_BASE",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
      "GIT_CEILING_DIRECTORIES",
    ]) {
      delete environment[key];
    }
    const result = await execFileAsync(
      "git",
      [
        "-C",
        repositoryRoot,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...environment,
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
    return result.stdout.trim();
  } catch (error) {
    const detail = error as Error & { stderr?: string };
    const stderr = detail.stderr?.trim();
    throw new Error(
      `git ${args[0] ?? ""} failed${stderr ? `: ${stderr}` : `: ${detail.message}`}`,
    );
  }
}

async function gitBlobBytes(
  repositoryRoot: string,
  objectId: string,
): Promise<Buffer> {
  const environment = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_REPLACE_REF_BASE",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_CEILING_DIRECTORIES",
  ]) {
    delete environment[key];
  }
  try {
    const result = await execFileAsync(
      "git",
      [
        "-C",
        repositoryRoot,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.hooksPath=/dev/null",
        "cat-file",
        "blob",
        assertOid(objectId, "Git blob object"),
      ],
      {
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...environment,
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
    return result.stdout;
  } catch (error) {
    const detail = error as Error & { stderr?: Buffer };
    const stderr = detail.stderr?.toString("utf8").trim();
    throw new Error(
      `git cat-file failed${stderr ? `: ${stderr}` : `: ${detail.message}`}`,
    );
  }
}

async function gitSucceeds(
  repositoryRoot: string,
  args: string[],
): Promise<boolean> {
  try {
    const environment = { ...process.env };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_REPLACE_REF_BASE",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
      "GIT_CEILING_DIRECTORIES",
    ]) {
      delete environment[key];
    }
    await execFileAsync(
      "git",
      [
        "-C",
        repositoryRoot,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...environment,
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function canonicalRepositoryRoot(input: string): Promise<string> {
  const requested = await realpath(resolve(input));
  const topLevel = await realpath(await git(requested, [
    "rev-parse",
    "--show-toplevel",
  ]));
  if (requested !== topLevel) {
    throw new Error("RSI version operation must run at the canonical Git worktree top-level");
  }
  const replacementRefs = await git(requested, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/replace/",
  ]);
  if (replacementRefs !== "") {
    throw new Error("RSI version operation rejects Git replacement refs");
  }
  const commonDirRaw = await git(requested, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const commonDir = await realpath(
    isAbsolute(commonDirRaw)
      ? commonDirRaw
      : resolve(requested, commonDirRaw),
  );
  const graftsPath = join(commonDir, "info", "grafts");
  try {
    const grafts = await lstat(graftsPath);
    if (!grafts.isFile() || grafts.isSymbolicLink() || grafts.size > 0) {
      throw new Error("RSI version operation rejects Git grafts");
    }
  } catch (error) {
    const detail = error as NodeJS.ErrnoException;
    if (detail.code !== "ENOENT") throw error;
  }
  if (await git(requested, [
    "rev-parse",
    "--is-shallow-repository",
  ]) !== "false") {
    throw new Error("RSI version operation rejects shallow repositories");
  }
  return requested;
}

async function inspectCleanHead(repositoryRoot: string): Promise<{
  sourceCommit: string;
  sourceTree: string;
}> {
  const indexFlags = await git(repositoryRoot, [
    "ls-files",
    "-v",
    "-z",
  ]);
  for (const entry of indexFlags.split("\0")) {
    if (entry === "") continue;
    const marker = entry[0]!;
    if (marker === "S" || marker === marker.toLowerCase()) {
      throw new Error(
        "RSI version operation rejects assume-unchanged and skip-worktree index flags",
      );
    }
  }
  if (!await gitSucceeds(repositoryRoot, [
      "diff-index",
      "--cached",
      "--quiet",
      "HEAD",
      "--",
    ])) {
    throw new Error(
      "RSI version operation requires tracked worktree and index bytes to match HEAD",
    );
  }
  const sourceCommit = assertOid(
    await git(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
    "HEAD",
  );
  const sourceTree = assertOid(
    await git(repositoryRoot, ["rev-parse", "--verify", "HEAD^{tree}"]),
    "HEAD tree",
  );
  const objectFormat = await git(repositoryRoot, [
    "rev-parse",
    "--show-object-format",
  ]);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error("RSI version operation encountered an unsupported Git object format");
  }
  const tree = await git(repositoryRoot, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    sourceCommit,
  ]);
  for (const entry of tree.split("\0")) {
    if (entry === "") continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) {
      throw new Error("RSI version operation encountered an invalid Git tree entry");
    }
    const [mode, type, objectId] = entry.slice(0, tab).split(" ");
    const trackedPath = entry.slice(tab + 1);
    const absolutePath = resolve(repositoryRoot, trackedPath);
    if (!isInsideOrEqual(absolutePath, repositoryRoot)) {
      throw new Error("RSI version operation encountered an unsafe tracked path");
    }
    if (mode === "160000" || type === "commit") {
      throw new Error(
        "RSI version operation rejects Git submodules because their worktree bytes are not frozen by the parent tree",
      );
    }
    let bytes: Buffer;
    if (mode === "120000") {
      throw new Error(
        `RSI version operation rejects tracked symlinks: ${trackedPath}`,
      );
    } else if (mode === "100644" || mode === "100755") {
      const file = await stableRegularFile(
        absolutePath,
        0,
        256 * 1024 * 1024,
        `RSI tracked file ${trackedPath}`,
      );
      bytes = file.bytes;
      const executable = (file.mode & 0o111) !== 0;
      if (executable !== (mode === "100755")) {
        throw new Error(
          `RSI tracked executable mode does not match HEAD: ${trackedPath}`,
        );
      }
    } else {
      throw new Error(
        `RSI version operation rejects unsupported Git mode ${mode}: ${trackedPath}`,
      );
    }
    const header = Buffer.from(`blob ${bytes.length}\0`, "utf8");
    const rawObjectId = createHash(objectFormat)
      .update(header)
      .update(bytes)
      .digest("hex");
    if (type !== "blob" || rawObjectId !== objectId) {
      throw new Error(
        `RSI tracked raw worktree bytes do not match HEAD: ${trackedPath}`,
      );
    }
  }
  const untracked = await git(repositoryRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (untracked !== "") {
    throw new Error(
      "RSI version operation requires a clean index, worktree, and non-ignored untracked set",
    );
  }
  const ignoredExecutionFiles = await git(repositoryRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
    "--",
    ...RSI_IGNORED_EXECUTION_ROOTS,
  ]);
  if (ignoredExecutionFiles !== "") {
    throw new Error(
      "RSI version operation rejects ignored untracked files in executable or schema roots",
    );
  }
  return {
    sourceCommit,
    sourceTree,
  };
}

function isInsideOrEqual(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

async function stableRegularFile(
  pathInput: string,
  minimumBytes: number,
  maximumBytes: number,
  label: string,
): Promise<{
  path: string;
  sha256: string;
  size: number;
  mode: number;
  bytes: Buffer;
}> {
  const path = resolve(pathInput);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (before.size < minimumBytes || before.size > maximumBytes) {
    throw new Error(`${label} has an invalid size`);
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()
      || before.dev !== opened.dev
      || before.ino !== opened.ino
      || before.size !== opened.size
      || before.mtimeMs !== opened.mtimeMs
      || before.ctimeMs !== opened.ctimeMs) {
      throw new Error(`${label} changed before its secure file descriptor opened`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile()
      || opened.dev !== after.dev
      || opened.ino !== after.ino
      || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs
      || opened.ctimeMs !== after.ctimeMs
      || bytes.length !== opened.size) {
      throw new Error(`${label} changed while it was being hashed`);
    }
    return {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: opened.size,
      mode: opened.mode,
      bytes,
    };
  } finally {
    await handle.close();
  }
}

async function stableFile(pathInput: string, maximumBytes = 16 * 1024 * 1024): Promise<{
  path: string;
  sha256: string;
  size: number;
  bytes: Buffer;
}> {
  return await stableRegularFile(
    pathInput,
    1,
    maximumBytes,
    "RSI receipt/protocol input",
  );
}

function versionRef(versionId: string): string {
  return `${VERSION_PREFIX}${assertId(versionId, "version ID")}`;
}

function evaluationOpeningRef(evaluationId: string): string {
  return `${EVALUATION_PREFIX}${assertId(evaluationId, "evaluation ID")}/opening`;
}

function evaluationResultRef(evaluationId: string): string {
  return `${EVALUATION_PREFIX}${assertId(evaluationId, "evaluation ID")}/result`;
}

function evaluationPublicationRef(evaluationId: string): string {
  return `${EVALUATION_PREFIX}${assertId(evaluationId, "evaluation ID")}/publication`;
}

function decisionRef(decisionId: string): string {
  return `${DECISION_PREFIX}${assertId(decisionId, "decision ID")}`;
}

function explorationRef(explorationId: string): string {
  return `${EXPLORATION_PREFIX}${assertId(
    explorationId,
    "Developer exploration ID",
  )}`;
}

function epochResumeRef(resumeId: string): string {
  return `${EPOCH_RESUME_PREFIX}${assertId(
    resumeId,
    "epoch resume ID",
  )}`;
}

function retrospectiveRef(recordId: string): string {
  return `${RETROSPECTIVE_PREFIX}${assertId(
    recordId,
    "retrospective experiment ID",
  )}`;
}

function retrospectiveIncumbentRef(adoptionId: string): string {
  return `${RETROSPECTIVE_INCUMBENT_PREFIX}${assertId(
    adoptionId,
    "retrospective incumbent adoption ID",
  )}`;
}

function eventRef(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 99_999_999) {
    throw new Error("RSI graph event sequence is invalid");
  }
  return `${EVENT_PREFIX}${String(sequence).padStart(8, "0")}`;
}

async function listRefs(repositoryRoot: string, prefix: string): Promise<string[]> {
  const output = await git(repositoryRoot, [
    "for-each-ref",
    "--format=%(refname)",
    prefix,
  ]);
  if (!output) return [];
  return output.split("\n").map((item) => item.trim()).filter(Boolean).sort();
}

async function listedWorktreeRoots(repositoryRoot: string): Promise<string[]> {
  const output = await git(repositoryRoot, ["worktree", "list", "--porcelain"]);
  const roots: string[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      roots.push(await realpath(line.slice("worktree ".length)));
    }
  }
  return roots;
}

function tagShortName(ref: string): string {
  if (!ref.startsWith("refs/tags/")) throw new Error(`not a tag ref: ${ref}`);
  return ref.slice("refs/tags/".length);
}

async function readAnnotatedTag<T>(
  repositoryRoot: string,
  ref: string,
  schemaFilename: string,
  label: string,
): Promise<TaggedManifest<T>> {
  const tagObjectId = assertOid(
    await git(repositoryRoot, ["rev-parse", "--verify", ref]),
    `${label} tag object`,
  );
  const objectType = await git(repositoryRoot, ["cat-file", "-t", tagObjectId]);
  if (objectType !== "tag") {
    throw new Error(`${label} must use an annotated tag, not a lightweight tag`);
  }
  const raw = await git(repositoryRoot, ["cat-file", "-p", tagObjectId]);
  const separator = raw.indexOf("\n\n");
  if (separator < 0) throw new Error(`${label} annotated tag has no canonical payload`);
  const header = raw.slice(0, separator).split("\n");
  const message = raw.slice(separator + 2).trim();
  const objectLine = header.find((line) => line.startsWith("object "));
  const typeLine = header.find((line) => line.startsWith("type "));
  const tagLine = header.find((line) => line.startsWith("tag "));
  if (!objectLine || typeLine !== "type commit"
    || tagLine !== `tag ${tagShortName(ref)}`) {
    throw new Error(`${label} annotated tag header is invalid`);
  }
  const targetCommit = assertOid(objectLine.slice("object ".length), `${label} target`);
  const peeled = assertOid(
    await git(repositoryRoot, ["rev-parse", "--verify", `${ref}^{commit}`]),
    `${label} peeled commit`,
  );
  if (peeled !== targetCommit) throw new Error(`${label} annotated tag target is inconsistent`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(message);
  } catch {
    throw new Error(`${label} annotated tag payload is not JSON`);
  }
  await assertSchema(schemaFilename, manifest, label);
  if (canonicalJson(manifest) !== message) {
    throw new Error(`${label} annotated tag payload is not canonical JSON`);
  }
  const tagRef = (manifest as { tagRef?: unknown }).tagRef;
  if (tagRef !== ref) throw new Error(`${label} payload does not bind its tag ref`);
  return {
    ref,
    tagObjectId,
    targetCommit,
    manifest: manifest as T,
  };
}

async function createAnnotatedTag<T extends Record<string, unknown>>(
  repositoryRoot: string,
  ref: string,
  targetCommit: string,
  manifest: T,
): Promise<TaggedManifest<T>> {
  if (await gitSucceeds(repositoryRoot, ["show-ref", "--verify", "--quiet", ref])) {
    throw new Error(`RSI immutable tag already exists: ${ref}`);
  }
  const temporary = await mkdtemp(join(await realpath(tmpdir()), "pi-rsi-tag-"));
  const messagePath = join(temporary, "message.json");
  try {
    await writeFile(messagePath, `${canonicalJson(manifest)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await git(repositoryRoot, [
      "tag",
      "--annotate",
      "--no-sign",
      "--file",
      messagePath,
      tagShortName(ref),
      targetCommit,
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return {
    ref,
    tagObjectId: assertOid(
      await git(repositoryRoot, ["rev-parse", "--verify", ref]),
      "created tag object",
    ),
    targetCommit,
    manifest,
  };
}

async function localRefMap(
  repositoryRoot: string,
  prefix: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const ref of await listRefs(repositoryRoot, prefix)) {
    result.set(ref, assertOid(
      await git(repositoryRoot, ["rev-parse", "--verify", ref]),
      `local ${ref}`,
    ));
  }
  return result;
}

async function remoteRefMap(
  repositoryRoot: string,
  remote: string,
  prefix: string,
): Promise<Map<string, string>> {
  assertId(remote, "remote name");
  const remoteUrl = await git(repositoryRoot, [
    "remote",
    "get-url",
    remote,
  ]);
  if (remoteUrl.startsWith("ext::") || remoteUrl.startsWith("-")) {
    throw new Error("RSI version operation rejects unsafe Git remote helpers");
  }
  const output = await git(repositoryRoot, [
    "ls-remote",
    "--refs",
    remote,
    `${prefix}*`,
  ]);
  const result = new Map<string, string>();
  for (const line of output.split("\n").filter(Boolean)) {
    const [objectId, ref] = line.split(/\s+/);
    if (!ref.startsWith(prefix) || result.has(ref)) {
      throw new Error(`remote ${remote} returned an invalid or duplicate RSI ref`);
    }
    result.set(ref, assertOid(objectId, `remote ${ref}`));
  }
  return result;
}

async function assertRemoteNamespace(
  repositoryRoot: string,
  remote: string,
): Promise<void> {
  const local = [...(await localRefMap(repositoryRoot, RSI_TAG_PREFIX)).entries()]
    .sort(([left], [right]) => compareAscii(left, right));
  const published = [...(await remoteRefMap(
    repositoryRoot,
    remote,
    RSI_TAG_PREFIX,
  )).entries()].sort(([left], [right]) => compareAscii(left, right));
  if (canonicalJson(local) !== canonicalJson(published)) {
    throw new Error(
      `remote ${remote} RSI namespace differs from the local immutable graph; fetch the complete refs/tags/rsi/* namespace before continuing`,
    );
  }
}

async function publishGraphEvent<T extends Record<string, unknown> & {
  canonicalHash: string;
}>(
  repositoryRoot: string,
  remote: string,
  graph: RsiVersionGraph,
  mutation: TaggedManifest<T>,
  kind: RsiCodeEventKind,
): Promise<TaggedManifest<RsiCodeEventManifest>> {
  const sequence = graph.events.length + 1;
  const previous = graph.events.at(-1);
  const ref = eventRef(sequence);
  const manifest = withCanonicalHash({
    schemaVersion: RSI_CODE_EVENT_SCHEMA,
    sequence,
    tagRef: ref,
    previousEvent: previous
      ? {
        sequence: previous.manifest.sequence,
        manifestHash: previous.manifest.canonicalHash,
        tagObjectId: previous.tagObjectId,
      }
      : null,
    mutation: {
      kind,
      ref: mutation.ref,
      manifestHash: mutation.manifest.canonicalHash,
      tagObjectId: mutation.tagObjectId,
    },
  }) as RsiCodeEventManifest;
  let event: TaggedManifest<RsiCodeEventManifest>;
  try {
    await assertSchema("rsi_code_event.schema.json", manifest, "RSI graph event");
    event = await createAnnotatedTag(
      repositoryRoot,
      ref,
      mutation.targetCommit,
      manifest,
    );
  } catch (error) {
    await gitSucceeds(repositoryRoot, [
      "update-ref",
      "-d",
      mutation.ref,
      mutation.tagObjectId,
    ]);
    throw error;
  }
  try {
    // Validate the candidate mutation and event as one complete local graph
    // before either ref can reach the immutable remote namespace. Command-
    // level preconditions are intentionally not the final authority: this
    // catches every causality rule, including stop/proceed exploration
    // terminality, even when a new operation forgets a bespoke guard.
    await inspectRsiVersionGraph(repositoryRoot);
  } catch (error) {
    await gitSucceeds(repositoryRoot, [
      "update-ref",
      "-d",
      event.ref,
      event.tagObjectId,
    ]);
    await gitSucceeds(repositoryRoot, [
      "update-ref",
      "-d",
      mutation.ref,
      mutation.tagObjectId,
    ]);
    throw error;
  }
  assertId(remote, "remote name");
  try {
    await git(repositoryRoot, [
      "push",
      "--no-verify",
      "--atomic",
      "--porcelain",
      remote,
      `${mutation.ref}:${mutation.ref}`,
      `${event.ref}:${event.ref}`,
    ]);
  } catch (error) {
    const published = await remoteRefMap(
      repositoryRoot,
      remote,
      RSI_TAG_PREFIX,
    ).catch(() => null);
    const mutationPublished =
      published?.get(mutation.ref) === mutation.tagObjectId;
    const eventPublished = published?.get(event.ref) === event.tagObjectId;
    if (!mutationPublished || !eventPublished) {
      if (published && !mutationPublished && !eventPublished) {
        await gitSucceeds(repositoryRoot, [
          "update-ref",
          "-d",
          event.ref,
          event.tagObjectId,
        ]);
        await gitSucceeds(repositoryRoot, [
          "update-ref",
          "-d",
          mutation.ref,
          mutation.tagObjectId,
        ]);
      }
      throw error;
    }
  }
  await assertRemoteNamespace(repositoryRoot, remote);
  return event;
}

function versionBinding(
  tagged: TaggedManifest<RsiCodeVersionManifest>,
): RsiVersionBinding {
  return {
    versionId: tagged.manifest.versionId,
    manifestHash: tagged.manifest.canonicalHash,
    sourceCommit: tagged.manifest.sourceCommit,
    tagObjectId: tagged.tagObjectId,
  };
}

function sameVersionBinding(
  actual: RsiVersionBinding,
  expected: RsiVersionBinding,
): boolean {
  return canonicalJson(actual) === canonicalJson(expected);
}

function isExactGrandfatheredLegacyResult(
  version: TaggedManifest<RsiCodeVersionManifest> | undefined,
  opening: TaggedManifest<RsiEvaluationOpeningManifest> | undefined,
  result: TaggedManifest<RsiEvaluationResultManifest> | undefined,
): boolean {
  return version?.manifest.parent === null
    && version.manifest.versionId === LEGACY_ROOT_VERSION_ID
    && version.manifest.canonicalHash === LEGACY_ROOT_VERSION_MANIFEST_HASH
    && version.tagObjectId === LEGACY_ROOT_VERSION_TAG_OBJECT_ID
    && opening?.manifest.evaluationId === LEGACY_EVALUATION_ID
    && opening.manifest.canonicalHash === LEGACY_OPENING_MANIFEST_HASH
    && opening.tagObjectId === LEGACY_OPENING_TAG_OBJECT_ID
    && result?.manifest.evaluationId === LEGACY_EVALUATION_ID
    && result.manifest.canonicalHash === LEGACY_RESULT_MANIFEST_HASH
    && result.tagObjectId === LEGACY_RESULT_TAG_OBJECT_ID
    && result.manifest.result.kind === "software_verification"
    && result.manifest.result.artifactHash === LEGACY_RESULT_ARTIFACT_HASH
    && result.manifest.stateRoot === null
    && result.manifest.claimBoundary === LEGACY_SOFTWARE_CLAIM_BOUNDARY;
}

function isExactGrandfatheredLegacyBaseline(
  version: TaggedManifest<RsiCodeVersionManifest> | undefined,
  opening: TaggedManifest<RsiEvaluationOpeningManifest> | undefined,
  result: TaggedManifest<RsiEvaluationResultManifest> | undefined,
  decision: TaggedManifest<RsiDecisionManifest> | undefined,
): boolean {
  return isExactGrandfatheredLegacyResult(version, opening, result)
    && decision?.manifest.decisionId === LEGACY_DECISION_ID
    && decision.manifest.evaluation.evaluationId === LEGACY_EVALUATION_ID
    && decision.manifest.canonicalHash === LEGACY_DECISION_MANIFEST_HASH
    && decision.tagObjectId === LEGACY_DECISION_TAG_OBJECT_ID;
}

function isExactGrandfatheredLegacyPublication(
  version: TaggedManifest<RsiCodeVersionManifest> | undefined,
  opening: TaggedManifest<RsiEvaluationOpeningManifest> | undefined,
  result: TaggedManifest<RsiEvaluationResultManifest> | undefined,
  decision: TaggedManifest<RsiDecisionManifest> | undefined,
  publication: TaggedManifest<RsiEvaluationPublicationManifest>,
): boolean {
  return isExactGrandfatheredLegacyBaseline(
    version,
    opening,
    result,
    decision,
  )
    && publication.manifest.publicationMode === "retrospective_legacy"
    && publication.manifest.canonicalHash
      === LEGACY_PUBLICATION_MANIFEST_HASH;
}

async function isAncestor(
  repositoryRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return await gitSucceeds(repositoryRoot, [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
}

async function assertLinearVersionEdge(
  repositoryRoot: string,
  parent: TaggedManifest<RsiCodeVersionManifest>,
  child: TaggedManifest<RsiCodeVersionManifest> | {
    targetCommit: string;
  },
): Promise<void> {
  if (parent.targetCommit === child.targetCommit
    || !await isAncestor(repositoryRoot, parent.targetCommit, child.targetCommit)) {
    throw new Error("RSI code-version parent must be a strict Git ancestor of its child");
  }
  const mergeCommits = await git(repositoryRoot, [
    "rev-list",
    "--min-parents=2",
    `${parent.targetCommit}..${child.targetCommit}`,
  ]);
  if (mergeCommits !== "") {
    throw new Error("RSI code-version edge must not contain merge commits");
  }
}

function byVersionId(
  graph: RsiVersionGraph,
  versionId: string,
): TaggedManifest<RsiCodeVersionManifest> {
  const tagged = graph.versions.find((item) => item.manifest.versionId === versionId);
  if (!tagged) throw new Error(`unknown RSI code version: ${versionId}`);
  return tagged;
}

function resultByEvaluationId(
  graph: RsiVersionGraph,
  evaluationId: string,
): TaggedManifest<RsiEvaluationResultManifest> {
  const tagged = graph.evaluationResults.find(
    (item) => item.manifest.evaluationId === evaluationId,
  );
  if (!tagged) throw new Error(`evaluation has no completed result: ${evaluationId}`);
  return tagged;
}

function versionByCommit(
  graph: RsiVersionGraph,
  sourceCommit: string,
): TaggedManifest<RsiCodeVersionManifest> {
  const matches = graph.versions.filter(
    (item) => item.manifest.sourceCommit === sourceCommit,
  );
  if (matches.length !== 1) {
    throw new Error(`expected exactly one RSI code version for commit ${sourceCommit}`);
  }
  return matches[0];
}

async function readVersionTags(
  repositoryRoot: string,
): Promise<TaggedManifest<RsiCodeVersionManifest>[]> {
  const tagged = await Promise.all(
    (await listRefs(repositoryRoot, VERSION_PREFIX)).map(async (ref) => {
      const versionId = ref.slice(VERSION_PREFIX.length);
      assertId(versionId, "version tag ID");
      const item = await readAnnotatedTag<RsiCodeVersionManifest>(
        repositoryRoot,
        ref,
        "rsi_code_version.schema.json",
        `RSI code version ${versionId}`,
      );
      if (item.manifest.versionId !== versionId
        || item.manifest.sourceCommit !== item.targetCommit) {
        throw new Error(`RSI code version tag ${versionId} has inconsistent identity`);
      }
      return item;
    }),
  );
  return tagged.sort((a, b) =>
    compareAscii(a.manifest.versionId, b.manifest.versionId));
}

async function readEvaluationTags(repositoryRoot: string): Promise<{
  openings: TaggedManifest<RsiEvaluationOpeningManifest>[];
  results: TaggedManifest<RsiEvaluationResultManifest>[];
  publications: TaggedManifest<RsiEvaluationPublicationManifest>[];
}> {
  const refs = await listRefs(repositoryRoot, EVALUATION_PREFIX);
  const openings: TaggedManifest<RsiEvaluationOpeningManifest>[] = [];
  const results: TaggedManifest<RsiEvaluationResultManifest>[] = [];
  const publications: TaggedManifest<RsiEvaluationPublicationManifest>[] = [];
  for (const ref of refs) {
    const suffix = ref.slice(EVALUATION_PREFIX.length);
    const match =
      /^([a-z0-9][a-z0-9._-]{0,63})\/(opening|result|publication)$/.exec(suffix);
    if (!match) throw new Error(`unknown RSI evaluation tag path: ${ref}`);
    const [, evaluationId, kind] = match;
    if (kind === "opening") {
      const tagged = await readAnnotatedTag<RsiEvaluationOpeningManifest>(
        repositoryRoot,
        ref,
        "rsi_code_evaluation_opening.schema.json",
        `RSI evaluation opening ${evaluationId}`,
      );
      if (tagged.manifest.evaluationId !== evaluationId) {
        throw new Error(`RSI evaluation opening ${evaluationId} has inconsistent identity`);
      }
      openings.push(tagged);
    } else if (kind === "result") {
      const tagged = await readAnnotatedTag<RsiEvaluationResultManifest>(
        repositoryRoot,
        ref,
        "rsi_code_evaluation_result.schema.json",
        `RSI evaluation result ${evaluationId}`,
      );
      if (tagged.manifest.evaluationId !== evaluationId) {
        throw new Error(`RSI evaluation result ${evaluationId} has inconsistent identity`);
      }
      results.push(tagged);
    } else {
      const tagged = await readAnnotatedTag<RsiEvaluationPublicationManifest>(
        repositoryRoot,
        ref,
        "rsi_code_evaluation_publication.schema.json",
        `RSI evaluation publication ${evaluationId}`,
      );
      if (tagged.manifest.evaluationId !== evaluationId) {
        throw new Error(
          `RSI evaluation publication ${evaluationId} has inconsistent identity`,
        );
      }
      publications.push(tagged);
    }
  }
  return {
    openings: openings.sort((a, b) =>
      compareAscii(a.manifest.evaluationId, b.manifest.evaluationId)),
    results: results.sort((a, b) =>
      compareAscii(a.manifest.evaluationId, b.manifest.evaluationId)),
    publications: publications.sort((a, b) =>
      compareAscii(a.manifest.evaluationId, b.manifest.evaluationId)),
  };
}

async function readDecisionTags(
  repositoryRoot: string,
): Promise<TaggedManifest<RsiDecisionManifest>[]> {
  const tagged = await Promise.all(
    (await listRefs(repositoryRoot, DECISION_PREFIX)).map(async (ref) => {
      const decisionId = ref.slice(DECISION_PREFIX.length);
      assertId(decisionId, "decision tag ID");
      const item = await readAnnotatedTag<RsiDecisionManifest>(
        repositoryRoot,
        ref,
        "rsi_code_decision.schema.json",
        `RSI decision ${decisionId}`,
      );
      if (item.manifest.decisionId !== decisionId) {
        throw new Error(`RSI decision ${decisionId} has inconsistent identity`);
      }
      return item;
    }),
  );
  return tagged.sort((a, b) =>
    compareAscii(a.manifest.decisionId, b.manifest.decisionId));
}

async function readDeveloperExplorationTags(
  repositoryRoot: string,
): Promise<TaggedManifest<RsiDeveloperExplorationManifest>[]> {
  const tagged = await Promise.all(
    (await listRefs(repositoryRoot, EXPLORATION_PREFIX)).map(async (ref) => {
      const explorationId = ref.slice(EXPLORATION_PREFIX.length);
      assertId(explorationId, "Developer exploration tag ID");
      const item = await readAnnotatedTag<RsiDeveloperExplorationManifest>(
        repositoryRoot,
        ref,
        "rsi_developer_exploration.schema.json",
        `RSI Developer exploration ${explorationId}`,
      );
      if (item.manifest.explorationId !== explorationId) {
        throw new Error(
          `RSI Developer exploration ${explorationId} has inconsistent identity`,
        );
      }
      await assertSchema(
        "rsi_evaluation_analysis.schema.json",
        item.manifest.evaluationAnalysis,
        `RSI Developer exploration ${explorationId} evaluation analysis`,
      );
      await assertSchema(
        "rsi_next_optimization_plan.schema.json",
        item.manifest.nextOptimizationPlan,
        `RSI Developer exploration ${explorationId} next optimization plan`,
      );
      const analysisMarkdown = renderRsiEvaluationAnalysisMarkdown(
        item.manifest.evaluationAnalysis,
      );
      const planMarkdown = renderRsiNextOptimizationPlanMarkdown(
        item.manifest.nextOptimizationPlan,
      );
      const expectedAnalysis = explorationArtifactBinding(
        `versions/${item.manifest.sourceVersion.versionId}/evaluation_analysis.md`,
        analysisMarkdown,
      );
      const expectedPlan = explorationArtifactBinding(
        `versions/${item.manifest.sourceVersion.versionId}/next_optimization_plan.md`,
        planMarkdown,
      );
      if (canonicalJson(item.manifest.artifacts)
        !== canonicalJson({
          evaluationAnalysisMarkdown: expectedAnalysis,
          nextOptimizationPlanMarkdown: expectedPlan,
        })) {
        throw new Error(
          `RSI Developer exploration ${explorationId} has invalid deterministic Markdown bindings`,
        );
      }
      return item;
    }),
  );
  return tagged.sort((left, right) =>
    compareAscii(left.manifest.explorationId, right.manifest.explorationId));
}

async function readEpochResumeTags(
  repositoryRoot: string,
): Promise<TaggedManifest<RsiEpochResumeManifest>[]> {
  const tagged = await Promise.all(
    (await listRefs(repositoryRoot, EPOCH_RESUME_PREFIX)).map(
      async (ref) => {
        const resumeId = ref.slice(EPOCH_RESUME_PREFIX.length);
        assertId(resumeId, "epoch resume tag ID");
        const item = await readAnnotatedTag<RsiEpochResumeManifest>(
          repositoryRoot,
          ref,
          "rsi_epoch_resume.schema.json",
          `RSI epoch resume ${resumeId}`,
        );
        if (item.manifest.resumeId !== resumeId) {
          throw new Error(
            `RSI epoch resume ${resumeId} has inconsistent identity`,
          );
        }
        return item;
      },
    ),
  );
  return tagged.sort((left, right) =>
    compareAscii(left.manifest.resumeId, right.manifest.resumeId));
}

async function readRetrospectiveExperimentTags(
  repositoryRoot: string,
): Promise<TaggedManifest<RsiRetrospectiveExperimentManifest>[]> {
  const tagged = await Promise.all(
    (await listRefs(repositoryRoot, RETROSPECTIVE_PREFIX)).map(
      async (ref) => {
        const recordId = ref.slice(RETROSPECTIVE_PREFIX.length);
        assertId(recordId, "retrospective experiment tag ID");
        const item =
          await readAnnotatedTag<RsiRetrospectiveExperimentManifest>(
            repositoryRoot,
            ref,
            "rsi_retrospective_experiment.schema.json",
            `RSI retrospective experiment ${recordId}`,
          );
        if (item.manifest.recordId !== recordId
          || item.manifest.recordCommit.sourceCommit
            !== item.targetCommit) {
          throw new Error(
            `RSI retrospective experiment ${recordId} has inconsistent identity`,
          );
        }
        const recordTree = assertOid(
          await git(repositoryRoot, [
            "rev-parse",
            "--verify",
            `${item.targetCommit}^{tree}`,
          ]),
          "retrospective record tree",
        );
        const evaluatedTree = assertOid(
          await git(repositoryRoot, [
            "rev-parse",
            "--verify",
            `${item.manifest.evaluatedSource.sourceCommit}^{tree}`,
          ]),
          "retrospective evaluated source tree",
        );
        if (recordTree !== item.manifest.recordCommit.sourceTree
          || evaluatedTree !== item.manifest.evaluatedSource.sourceTree
          || !await isAncestor(
            repositoryRoot,
            item.manifest.evaluatedSource.sourceCommit,
            item.targetCommit,
          )) {
          throw new Error(
            `RSI retrospective experiment ${recordId} has invalid source bindings`,
          );
        }
        const receiptPath = item.manifest.receipt.relativePath;
        const expectedBlob = assertOid(
          await git(repositoryRoot, [
            "rev-parse",
            "--verify",
            `${item.targetCommit}:${receiptPath}`,
          ]),
          "retrospective receipt blob",
        );
        const receiptBytes = await gitBlobBytes(
          repositoryRoot,
          expectedBlob,
        );
        let receipt: unknown;
        try {
          receipt = JSON.parse(receiptBytes.toString("utf8")) as unknown;
        } catch {
          throw new Error(
            `RSI retrospective experiment ${recordId} receipt is not JSON`,
          );
        }
        const parsed = parseRetrospectiveReceipt(
          receipt,
          `RSI retrospective experiment ${recordId} receipt`,
        );
        if (expectedBlob !== item.manifest.receipt.blobObjectId
          || createHash("sha256").update(receiptBytes).digest("hex")
            !== item.manifest.receipt.fileSha256
          || receiptBytes.length !== item.manifest.receipt.size
          || parsed.canonicalHash !== item.manifest.receipt.canonicalHash
          || parsed.recordId !== item.manifest.recordId
          || parsed.evaluatedCommit
            !== item.manifest.evaluatedSource.sourceCommit
          || canonicalJson({
            changeSummary: parsed.changeSummary,
            hypothesis: parsed.hypothesis,
            component: parsed.component,
            observations: parsed.observations,
            diagnoses: parsed.diagnoses,
            prioritizedActions: parsed.prioritizedActions,
            localGateOutcome: parsed.localGateOutcome,
          }) !== canonicalJson(item.manifest.experiment)
          || parsed.claimBoundary !== item.manifest.claimBoundary) {
          throw new Error(
            `RSI retrospective experiment ${recordId} receipt binding is invalid`,
          );
        }
        return item;
      },
    ),
  );
  return tagged.sort((left, right) =>
    compareAscii(left.manifest.recordId, right.manifest.recordId));
}

function assertRetrospectiveIncumbentEvidence(
  evidence: RsiRetrospectiveIncumbentSpec["evidence"],
  label: string,
): void {
  for (const [name, comparison] of [
    ["selectionOverallFmax", evidence.selectionOverallFmax],
    ["testOverallFmax", evidence.testOverallFmax],
  ] as const) {
    const expected = comparison.candidate - comparison.baseline;
    if (Math.abs(comparison.candidateMinusBaseline - expected) > 1e-9) {
      throw new Error(
        `${label} ${name} delta does not equal candidate minus baseline`,
      );
    }
  }
  if (evidence.claimBoundary
      !== "Priority100 development/regression evidence with one procedural holdout; not a temporal blind benchmark or publication-grade generalization claim.") {
    throw new Error(
      `${label} must preserve the Priority100 retrospective claim boundary`,
    );
  }
}

async function readRetrospectiveIncumbentTags(
  repositoryRoot: string,
): Promise<TaggedManifest<RsiRetrospectiveIncumbentManifest>[]> {
  const tagged = await Promise.all(
    (await listRefs(repositoryRoot, RETROSPECTIVE_INCUMBENT_PREFIX)).map(
      async (ref) => {
        const adoptionId = ref.slice(
          RETROSPECTIVE_INCUMBENT_PREFIX.length,
        );
        assertId(adoptionId, "retrospective incumbent adoption tag ID");
        const item =
          await readAnnotatedTag<RsiRetrospectiveIncumbentManifest>(
            repositoryRoot,
            ref,
            "rsi_retrospective_incumbent.schema.json",
            `RSI retrospective incumbent adoption ${adoptionId}`,
          );
        if (item.manifest.adoptionId !== adoptionId
          || item.manifest.recordCommit.sourceCommit
            !== item.targetCommit) {
          throw new Error(
            `RSI retrospective incumbent adoption ${adoptionId} has inconsistent identity`,
          );
        }
        const recordTree = assertOid(
          await git(repositoryRoot, [
            "rev-parse",
            "--verify",
            `${item.targetCommit}^{tree}`,
          ]),
          "retrospective incumbent record tree",
        );
        const reportBlob = assertOid(
          await git(repositoryRoot, [
            "rev-parse",
            "--verify",
            `${item.targetCommit}:${item.manifest.evidence.reportPath}`,
          ]),
          "retrospective incumbent report blob",
        );
        const reportBytes = await gitBlobBytes(repositoryRoot, reportBlob);
        if (recordTree !== item.manifest.recordCommit.sourceTree
          || reportBlob !== item.manifest.evidence.reportBlobObjectId
          || createHash("sha256").update(reportBytes).digest("hex")
            !== item.manifest.evidence.reportSha256
          || !await isAncestor(
            repositoryRoot,
            item.manifest.incumbentVersion.sourceCommit,
            item.targetCommit,
          )) {
          throw new Error(
            `RSI retrospective incumbent adoption ${adoptionId} has invalid record or report bindings`,
          );
        }
        assertRetrospectiveIncumbentEvidence(
          item.manifest.evidence,
          `RSI retrospective incumbent adoption ${adoptionId}`,
        );
        return item;
      },
    ),
  );
  return tagged.sort((left, right) =>
    compareAscii(left.manifest.adoptionId, right.manifest.adoptionId));
}

async function readEventTags(
  repositoryRoot: string,
): Promise<TaggedManifest<RsiCodeEventManifest>[]> {
  const tagged = await Promise.all(
    (await listRefs(repositoryRoot, EVENT_PREFIX)).map(async (ref) => {
      const suffix = ref.slice(EVENT_PREFIX.length);
      if (!/^\d{8}$/.test(suffix)) {
        throw new Error(`unknown RSI graph event tag path: ${ref}`);
      }
      const sequence = Number(suffix);
      const item = await readAnnotatedTag<RsiCodeEventManifest>(
        repositoryRoot,
        ref,
        "rsi_code_event.schema.json",
        `RSI graph event ${suffix}`,
      );
      if (item.manifest.sequence !== sequence || item.ref !== eventRef(sequence)) {
        throw new Error(`RSI graph event ${suffix} has inconsistent identity`);
      }
      return item;
    }),
  );
  return tagged.sort((left, right) =>
    left.manifest.sequence - right.manifest.sequence);
}

function mutationKind(ref: string): RsiCodeEventKind {
  if (ref.startsWith(VERSION_PREFIX)) return "version";
  if (ref.startsWith(EVALUATION_PREFIX) && ref.endsWith("/opening")) {
    return "evaluation_opening";
  }
  if (ref.startsWith(EVALUATION_PREFIX) && ref.endsWith("/result")) {
    return "evaluation_result";
  }
  if (ref.startsWith(EVALUATION_PREFIX) && ref.endsWith("/publication")) {
    return "evaluation_publication";
  }
  if (ref.startsWith(DECISION_PREFIX)) return "decision";
  if (ref.startsWith(EXPLORATION_PREFIX)) return "developer_exploration";
  if (ref.startsWith(EPOCH_RESUME_PREFIX)) return "epoch_resume";
  if (ref.startsWith(RETROSPECTIVE_PREFIX)) {
    return "retrospective_experiment";
  }
  if (ref.startsWith(RETROSPECTIVE_INCUMBENT_PREFIX)) {
    return "retrospective_incumbent";
  }
  throw new Error(`unknown RSI semantic mutation ref: ${ref}`);
}

function verifyEvents(
  versions: TaggedManifest<RsiCodeVersionManifest>[],
  openings: TaggedManifest<RsiEvaluationOpeningManifest>[],
  results: TaggedManifest<RsiEvaluationResultManifest>[],
  publications: TaggedManifest<RsiEvaluationPublicationManifest>[],
  decisions: TaggedManifest<RsiDecisionManifest>[],
  explorations: TaggedManifest<RsiDeveloperExplorationManifest>[],
  epochResumes: TaggedManifest<RsiEpochResumeManifest>[],
  retrospectives: TaggedManifest<RsiRetrospectiveExperimentManifest>[],
  retrospectiveIncumbents:
    TaggedManifest<RsiRetrospectiveIncumbentManifest>[],
  events: TaggedManifest<RsiCodeEventManifest>[],
): void {
  const mutations: Array<TaggedManifest<Record<string, unknown> & {
    canonicalHash: string;
  }>> = [
    ...versions,
    ...openings,
    ...results,
    ...publications,
    ...decisions,
    ...explorations,
    ...epochResumes,
    ...retrospectives,
    ...retrospectiveIncumbents,
  ];
  const mutationMap = new Map(mutations.map((item) => [item.ref, item]));
  if (mutationMap.size !== mutations.length || events.length !== mutations.length) {
    throw new Error("every RSI semantic tag must have exactly one serialized graph event");
  }
  let previous: TaggedManifest<RsiCodeEventManifest> | undefined;
  const seenMutations = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.manifest.sequence !== index + 1
      || event.ref !== eventRef(index + 1)) {
      throw new Error("RSI graph event slots must be contiguous from 00000001");
    }
    const expectedPrevious = previous
      ? {
        sequence: previous.manifest.sequence,
        manifestHash: previous.manifest.canonicalHash,
        tagObjectId: previous.tagObjectId,
      }
      : null;
    if (canonicalJson(event.manifest.previousEvent)
      !== canonicalJson(expectedPrevious)) {
      throw new Error(`RSI graph event ${event.manifest.sequence} breaks the event hash chain`);
    }
    const mutation = mutationMap.get(event.manifest.mutation.ref);
    if (!mutation
      || seenMutations.has(mutation.ref)
      || event.manifest.mutation.kind !== mutationKind(mutation.ref)
      || event.manifest.mutation.manifestHash !== mutation.manifest.canonicalHash
      || event.manifest.mutation.tagObjectId !== mutation.tagObjectId
      || event.targetCommit !== mutation.targetCommit) {
      throw new Error(`RSI graph event ${event.manifest.sequence} has an invalid mutation binding`);
    }
    seenMutations.add(mutation.ref);
    previous = event;
  }
  if (seenMutations.size !== mutations.length) {
    throw new Error("RSI graph event chain does not cover every semantic tag");
  }
  const sequenceByRef = new Map(
    events.map((event) => [
      event.manifest.mutation.ref,
      event.manifest.sequence,
    ] as const),
  );
  const before = (dependencyRef: string, dependentRef: string): void => {
    const dependency = sequenceByRef.get(dependencyRef);
    const dependent = sequenceByRef.get(dependentRef);
    if (dependency === undefined || dependent === undefined
      || dependency >= dependent) {
      throw new Error(
        `RSI graph event dependency order is invalid: ${dependencyRef} must precede ${dependentRef}`,
      );
    }
  };
  const versionRefs = new Map(
    versions.map((version) => [
      version.manifest.versionId,
      version.ref,
    ] as const),
  );
  for (const version of versions) {
    if (version.manifest.parent) {
      before(
        versionRefs.get(version.manifest.parent.versionId)!,
        version.ref,
      );
    }
  }
  const openingRefs = new Map(
    openings.map((opening) => [
      opening.manifest.evaluationId,
      opening.ref,
    ] as const),
  );
  const resultRefs = new Map(
    results.map((result) => [
      result.manifest.evaluationId,
      result.ref,
    ] as const),
  );
  const publicationRefs = new Map(
    publications.map((publication) => [
      publication.manifest.evaluationId,
      publication.ref,
    ] as const),
  );
  for (const opening of openings) {
    before(
      versionRefs.get(opening.manifest.version.versionId)!,
      opening.ref,
    );
  }
  for (const result of results) {
    before(openingRefs.get(result.manifest.evaluationId)!, result.ref);
  }
  for (const publication of publications) {
    before(resultRefs.get(publication.manifest.evaluationId)!, publication.ref);
  }
  const decisionRefs = new Map(
    decisions.map((decision) => [
      decision.manifest.decisionId,
      decision.ref,
    ] as const),
  );
  for (const decision of decisions) {
    before(
      resultRefs.get(decision.manifest.evaluation.evaluationId)!,
      decision.ref,
    );
    before(
      versionRefs.get(decision.manifest.candidateVersion.versionId)!,
      decision.ref,
    );
    before(
      versionRefs.get(decision.manifest.selectedVersion.versionId)!,
      decision.ref,
    );
    if (decision.manifest.previousDecision) {
      before(
        decisionRefs.get(decision.manifest.previousDecision.decisionId)!,
        decision.ref,
      );
    }
    const publicationRef = publicationRefs.get(
      decision.manifest.evaluation.evaluationId,
    );
    if (publicationRef) {
      const publication = publications.find(
        (item) => item.ref === publicationRef,
      )!;
      if (publication.manifest.publicationMode === "prospective") {
        before(publicationRef, decision.ref);
      } else {
        before(decision.ref, publicationRef);
      }
    }
  }
  const explorationRefs = new Map(
    explorations.map((exploration) => [
      exploration.manifest.explorationId,
      exploration.ref,
    ] as const),
  );
  for (const exploration of explorations) {
    const publicationRef = publicationRefs.get(
      exploration.manifest.evaluation.evaluationId,
    );
    const decision = decisions.find((item) =>
      item.manifest.decisionId
        === exploration.manifest.evaluation.decisionId);
    if (!publicationRef || !decision) {
      throw new Error(
        "RSI Developer exploration lacks its publication or decision dependency",
      );
    }
    before(publicationRef, exploration.ref);
    before(decision.ref, exploration.ref);
  }
  const epochResumeRefs = new Map(
    epochResumes.map((resume) => [
      resume.manifest.resumeId,
      resume.ref,
    ] as const),
  );
  for (const resume of epochResumes) {
    const explorationRefValue = explorationRefs.get(
      resume.manifest.terminalStop.explorationId,
    );
    const baseVersionRef = versionRefs.get(
      resume.manifest.baseVersion.versionId,
    );
    if (!explorationRefValue || !baseVersionRef) {
      throw new Error(
        `RSI epoch resume ${resume.manifest.resumeId} lacks its stop or base dependency`,
      );
    }
    before(explorationRefValue, resume.ref);
    before(baseVersionRef, resume.ref);
  }
  const retrospectiveIncumbentRefs = new Map(
    retrospectiveIncumbents.map((adoption) => [
      adoption.manifest.adoptionId,
      adoption.ref,
    ] as const),
  );
  for (const adoption of retrospectiveIncumbents) {
    const baseVersionRef = versionRefs.get(
      adoption.manifest.incumbentVersion.versionId,
    );
    if (!baseVersionRef) {
      throw new Error(
        `RSI retrospective incumbent adoption ${adoption.manifest.adoptionId} lacks its incumbent version`,
      );
    }
    before(baseVersionRef, adoption.ref);
  }
  for (const version of versions) {
    if (!version.manifest.developmentPlan) continue;
    const plan = version.manifest.developmentPlan;
    const ref = plan.schemaVersion
        === RSI_DEVELOPER_EXPLORATION_SCHEMA
      ? explorationRefs.get(
        plan.explorationId,
      )
      : plan.schemaVersion === RSI_EPOCH_RESUME_SCHEMA
        ? epochResumeRefs.get(plan.resumeId)
        : retrospectiveIncumbentRefs.get(plan.adoptionId);
    if (!ref) {
      throw new Error(
        `RSI version ${version.manifest.versionId} binds an unknown development plan`,
      );
    }
    before(ref, version.ref);
  }
  for (const retrospective of retrospectives) {
    const event = events.find(
      (item) => item.manifest.mutation.ref === retrospective.ref,
    );
    if (!event?.manifest.previousEvent
      || retrospective.manifest.formalSelection.eventSequence
        !== event.manifest.previousEvent.sequence
      || retrospective.manifest.formalSelection.eventManifestHash
        !== event.manifest.previousEvent.manifestHash) {
      throw new Error(
        `RSI retrospective experiment ${retrospective.manifest.recordId} has a stale graph-head binding`,
      );
    }
  }
  for (const adoption of retrospectiveIncumbents) {
    const event = events.find(
      (item) => item.manifest.mutation.ref === adoption.ref,
    );
    if (!event?.manifest.previousEvent
      || adoption.manifest.historyPrefix.eventSequence
        !== event.manifest.previousEvent.sequence
      || adoption.manifest.historyPrefix.eventManifestHash
        !== event.manifest.previousEvent.manifestHash) {
      throw new Error(
        `RSI retrospective incumbent adoption ${adoption.manifest.adoptionId} has a stale graph-head binding`,
      );
    }
  }
}

async function verifyVersionTopology(
  repositoryRoot: string,
  versions: TaggedManifest<RsiCodeVersionManifest>[],
): Promise<string | null> {
  if (versions.length === 0) return null;
  const ids = new Map<string, TaggedManifest<RsiCodeVersionManifest>>();
  const commits = new Set<string>();
  for (const version of versions) {
    if (ids.has(version.manifest.versionId)) {
      throw new Error(`duplicate RSI version ID: ${version.manifest.versionId}`);
    }
    if (commits.has(version.manifest.sourceCommit)) {
      throw new Error(`one Git commit cannot represent two RSI code versions`);
    }
    ids.set(version.manifest.versionId, version);
    commits.add(version.manifest.sourceCommit);
    const actualTree = assertOid(
      await git(repositoryRoot, [
        "rev-parse",
        "--verify",
        `${version.manifest.sourceCommit}^{tree}`,
      ]),
      "version tree",
    );
    if (actualTree !== version.manifest.sourceTree) {
      throw new Error(`RSI version ${version.manifest.versionId} source tree is invalid`);
    }
  }
  const roots = versions.filter((item) => item.manifest.parent === null);
  if (roots.length !== 1) throw new Error("RSI code-version graph must have exactly one root");
  for (const child of versions) {
    const parentBinding = child.manifest.parent;
    if (!parentBinding) continue;
    const parent = ids.get(parentBinding.versionId);
    if (!parent || !sameVersionBinding(parentBinding, versionBinding(parent))) {
      throw new Error(`RSI version ${child.manifest.versionId} has an invalid parent binding`);
    }
    await assertLinearVersionEdge(repositoryRoot, parent, child);
    for (const intermediate of versions) {
      if (intermediate === parent || intermediate === child) continue;
      if (await isAncestor(repositoryRoot, parent.targetCommit, intermediate.targetCommit)
        && await isAncestor(repositoryRoot, intermediate.targetCommit, child.targetCommit)) {
        throw new Error(
          `RSI version ${child.manifest.versionId} skips registered intermediate version ${intermediate.manifest.versionId}`,
        );
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (versionId: string): void => {
    if (visiting.has(versionId)) throw new Error("RSI code-version graph contains a cycle");
    if (visited.has(versionId)) return;
    visiting.add(versionId);
    const parent = ids.get(versionId)?.manifest.parent?.versionId;
    if (parent) walk(parent);
    visiting.delete(versionId);
    visited.add(versionId);
  };
  for (const version of versions) walk(version.manifest.versionId);
  return roots[0].manifest.versionId;
}

async function verifyEvaluations(
  versions: TaggedManifest<RsiCodeVersionManifest>[],
  openings: TaggedManifest<RsiEvaluationOpeningManifest>[],
  results: TaggedManifest<RsiEvaluationResultManifest>[],
): Promise<string[]> {
  const versionMap = new Map(
    versions.map((item) => [item.manifest.versionId, item] as const),
  );
  const openingMap = new Map<string, TaggedManifest<RsiEvaluationOpeningManifest>>();
  for (const opening of openings) {
    if (openingMap.has(opening.manifest.evaluationId)) {
      throw new Error(`duplicate RSI evaluation opening: ${opening.manifest.evaluationId}`);
    }
    const version = versionMap.get(opening.manifest.version.versionId);
    if (!version || !sameVersionBinding(opening.manifest.version, versionBinding(version))
      || opening.targetCommit !== version.targetCommit) {
      throw new Error(`RSI evaluation opening ${opening.manifest.evaluationId} has an invalid version binding`);
    }
    openingMap.set(opening.manifest.evaluationId, opening);
  }
  const resultIds = new Set<string>();
  for (const result of results) {
    if (resultIds.has(result.manifest.evaluationId)) {
      throw new Error(`duplicate RSI evaluation result: ${result.manifest.evaluationId}`);
    }
    resultIds.add(result.manifest.evaluationId);
    const opening = openingMap.get(result.manifest.evaluationId);
    if (!opening || result.manifest.openingHash !== opening.manifest.canonicalHash
      || !sameVersionBinding(result.manifest.version, opening.manifest.version)
      || result.targetCommit !== opening.targetCommit) {
      throw new Error(`RSI evaluation result ${result.manifest.evaluationId} is not bound to its opening`);
    }
    const version = versionMap.get(result.manifest.version.versionId);
    if ((result.manifest.result.kind === "adaptive_development")
      !== (result.manifest.stateRoot !== null)) {
      throw new Error(
        "an RSI evaluation result must bind a StateRoot if and only if it is adaptive",
      );
    }
    if (result.manifest.result.publicSummaryHash === undefined
      && !isExactGrandfatheredLegacyResult(version, opening, result)) {
      throw new Error(
        "every non-legacy RSI result must bind its canonical public summary hash",
      );
    }
  }
  return [...openingMap.keys()].filter((id) => !resultIds.has(id)).sort();
}

function eventSequenceForRef(
  events: readonly TaggedManifest<RsiCodeEventManifest>[],
  ref: string,
): number {
  const event = events.find((item) => item.manifest.mutation.ref === ref);
  if (!event) throw new Error(`RSI graph event chain does not contain ${ref}`);
  return event.manifest.sequence;
}

function verifyPublications(
  versions: TaggedManifest<RsiCodeVersionManifest>[],
  openings: TaggedManifest<RsiEvaluationOpeningManifest>[],
  results: TaggedManifest<RsiEvaluationResultManifest>[],
  publications: TaggedManifest<RsiEvaluationPublicationManifest>[],
  decisions: TaggedManifest<RsiDecisionManifest>[],
  events: TaggedManifest<RsiCodeEventManifest>[],
): string[] {
  const versionMap = new Map(
    versions.map((item) => [item.manifest.versionId, item] as const),
  );
  const openingMap = new Map(
    openings.map((item) => [item.manifest.evaluationId, item] as const),
  );
  const resultMap = new Map(
    results.map((item) => [item.manifest.evaluationId, item] as const),
  );
  const decisionMap = new Map(
    decisions.map((item) => [item.manifest.evaluation.evaluationId, item] as const),
  );
  const publicationIds = new Set<string>();
  for (const publication of publications) {
    const evaluationId = publication.manifest.evaluationId;
    if (publicationIds.has(evaluationId)) {
      throw new Error(`duplicate RSI evaluation publication: ${evaluationId}`);
    }
    publicationIds.add(evaluationId);
    const opening = openingMap.get(evaluationId);
    const result = resultMap.get(evaluationId);
    const version = versionMap.get(
      publication.manifest.version.versionId,
    );
    const decision = decisionMap.get(evaluationId);
    if (!opening || !result
      || publication.targetCommit !== result.targetCommit
      || !sameVersionBinding(publication.manifest.version, result.manifest.version)
      || publication.manifest.opening.manifestHash !== opening.manifest.canonicalHash
      || publication.manifest.opening.tagObjectId !== opening.tagObjectId
      || publication.manifest.opening.protocolId !== opening.manifest.protocol.protocolId
      || publication.manifest.opening.protocolHash !== opening.manifest.protocol.protocolHash
      || publication.manifest.result.manifestHash !== result.manifest.canonicalHash
      || publication.manifest.result.tagObjectId !== result.tagObjectId
      || publication.manifest.result.kind !== result.manifest.result.kind
      || publication.manifest.result.artifactHash !== result.manifest.result.artifactHash
      || publication.manifest.result.stateRootPublicManifestHash
        !== (result.manifest.stateRoot?.publicManifestHash ?? null)
      || publication.manifest.claimBoundary
        !== result.manifest.claimBoundary) {
      throw new Error(
        `RSI evaluation publication ${evaluationId} is not bound to its exact opening and result`,
      );
    }
    if (publication.manifest.publicationMode === "retrospective_legacy"
      && !isExactGrandfatheredLegacyPublication(
        version,
        opening,
        result,
        decision,
        publication,
      )) {
      throw new Error(
        "retrospective legacy publication is restricted to the exact pre-contract v0001 software baseline",
      );
    }
    const summary = publication.manifest.publicSummary;
    if ((result.manifest.result.kind === "adaptive_development"
      && summary.kind !== "adaptive_protein_function")
      || (result.manifest.result.kind !== "adaptive_development"
        && summary.kind !== result.manifest.result.kind)) {
      throw new Error(
        `RSI evaluation publication ${evaluationId} has a mismatched public summary kind`,
      );
    }
    const summaryHash = hashCanonical(summary);
    if (result.manifest.result.publicSummaryHash !== undefined) {
      if (result.manifest.result.publicSummaryHash !== summaryHash) {
        throw new Error(
          `RSI evaluation publication ${evaluationId} does not match its result-bound public summary hash`,
        );
      }
    } else if (!isExactGrandfatheredLegacyPublication(
      version,
      opening,
      result,
      decision,
      publication,
    )) {
      throw new Error(
        `RSI evaluation publication ${evaluationId} has no result-bound public summary hash`,
      );
    }
    if (summary.kind === "adaptive_protein_function") {
      if (summary.sourceDocuments.outcomeHash
        !== result.manifest.result.artifactHash) {
        throw new Error(
          `RSI adaptive publication ${evaluationId} does not bind its exact outcome`,
        );
      }
      if (!version) {
        throw new Error(
          `RSI evaluation publication ${evaluationId} refers to an unknown code version`,
        );
      }
      if (version.manifest.parent) {
        if (!version.manifest.developmentContext
          || summary.sourceDocuments.developerPlanHash === null
          || summary.sourceDocuments.codeVersionHistoryHash
            !== version.manifest.developmentContext.contextHash) {
          throw new Error(
            `RSI adaptive publication ${evaluationId} does not bind the exact Developer history`,
          );
        }
      } else if (summary.sourceDocuments.codeVersionHistoryHash !== null) {
        throw new Error(
          `RSI root adaptive publication ${evaluationId} claims an impossible prior history`,
        );
      }
      if (summary.method.hypothesis !== version.manifest.change.hypothesis
        || summary.method.changeSummary !== version.manifest.change.summary) {
        throw new Error(
          `RSI adaptive publication ${evaluationId} contradicts its registered version change`,
        );
      }
    } else {
      const checkIds = new Set(summary.checks.map((check) => check.checkId));
      if (checkIds.size !== summary.checks.length
        || !summary.checks.some((check) => check.status === "passed")) {
        throw new Error(
          `RSI generic publication ${evaluationId} requires unique checks and at least one executed pass`,
        );
      }
      if (publication.manifest.publicationMode === "prospective"
        && summary.artifactClaimBoundary
          !== publication.manifest.claimBoundary) {
        throw new Error(
          `RSI generic publication ${evaluationId} has inconsistent claim boundaries`,
        );
      }
      if (summary.kind === "frozen_replay"
        && prospectiveFrozenReplayPassState(publication) === null) {
        throw new Error(
          `RSI frozen_replay publication ${evaluationId} does not carry the closed prospective Z55 evidence binding`,
        );
      }
    }
    const resultSequence = eventSequenceForRef(events, result.ref);
    const publicationSequence = eventSequenceForRef(events, publication.ref);
    if (publicationSequence <= resultSequence) {
      throw new Error("RSI evaluation publication must follow its immutable result");
    }
    const decisionSequence = decision
      ? eventSequenceForRef(events, decision.ref)
      : null;
    if (publication.manifest.publicationMode === "prospective") {
      if (decisionSequence !== null && publicationSequence >= decisionSequence) {
        throw new Error(
          "prospective RSI evaluation publication must precede its decision",
        );
      }
    } else if (decisionSequence === null || publicationSequence <= decisionSequence) {
      throw new Error(
        "retrospective legacy publication must append after an existing decision",
      );
    }
  }
  return results
    .map((item) => item.manifest.evaluationId)
    .filter((id) => !publicationIds.has(id))
    .sort();
}

function evaluationAnalysisFor(
  version: TaggedManifest<RsiCodeVersionManifest>,
  opening: TaggedManifest<RsiEvaluationOpeningManifest>,
  result: TaggedManifest<RsiEvaluationResultManifest>,
  publication: TaggedManifest<RsiEvaluationPublicationManifest>,
  decision: TaggedManifest<RsiDecisionManifest>,
) {
  return buildRsiEvaluationAnalysis({
    sourceVersion: {
      versionId: version.manifest.versionId,
      parentVersionId: version.manifest.parent?.versionId ?? null,
      sourceCommit: version.manifest.sourceCommit,
      sourceTree: version.manifest.sourceTree,
      manifestHash: version.manifest.canonicalHash,
    },
    evaluationId: publication.manifest.evaluationId,
    resultKind: publication.manifest.result.kind,
    publicationMode: publication.manifest.publicationMode,
    protocolId: publication.manifest.opening.protocolId,
    protocolHash: publication.manifest.opening.protocolHash,
    publicSummary: publication.manifest.publicSummary,
    decision: {
      decisionId: decision.manifest.decisionId,
      action: decision.manifest.action,
      selectedVersionId: decision.manifest.selectedVersion.versionId,
      rationale: decision.manifest.rationale,
    },
    bindings: {
      openingHash: opening.manifest.canonicalHash,
      resultHash: result.manifest.canonicalHash,
      publicationHash: publication.manifest.canonicalHash,
      decisionHash: decision.manifest.canonicalHash,
      stateRootPublicManifestHash:
        result.manifest.stateRoot?.publicManifestHash ?? null,
    },
    claimBoundary: publication.manifest.claimBoundary,
  });
}

function nextPlanSpecFromCanonical(
  plan: RsiDeveloperExplorationManifest["nextOptimizationPlan"],
): RsiNextOptimizationPlanSpec {
  return withCanonicalHash({
    schemaVersion: RSI_NEXT_OPTIMIZATION_PLAN_SPEC_SCHEMA,
    baseVersionId: plan.baseVersionId,
    action: plan.action,
    plannedVersionId: plan.plannedVersionId,
    problemAssessment: plan.problemAssessment,
    problemCodes: [...plan.problemCodes],
    hypothesis: plan.hypothesis,
    plannedChangeSummary: plan.plannedChangeSummary,
    codeChangeTargets: [...plan.codeChangeTargets],
    controls: [...plan.controls],
    expectedEffects: structuredClone(plan.expectedEffects),
    experiment: {
      component: plan.experiment.component,
      strategy: plan.experiment.strategy,
      requiredCapabilities: [...plan.experiment.requiredCapabilities],
      falsifiers: [...plan.experiment.falsifiers],
    },
    researchCards: plan.researchCards.map((card) => ({
      evidenceId: card.evidenceId,
      finding: card.finding,
      limitations: [...card.limitations],
      supportedComponents: [...card.supportedComponents],
    })),
    rollbackCondition: plan.rollbackCondition,
    claimBoundary: RSI_EXPLORATION_CLAIM_BOUNDARY,
  }) as RsiNextOptimizationPlanSpec;
}

function verifyDeveloperExplorations(
  graph: Pick<
    RsiVersionGraph,
    | "versions"
    | "evaluationOpenings"
    | "evaluationResults"
    | "evaluationPublications"
    | "decisions"
    | "developerExplorations"
    | "epochResumes"
    | "retrospectiveExperiments"
    | "retrospectiveIncumbents"
    | "events"
    | "rootVersionId"
  >,
): void {
  const versions = new Map(
    graph.versions.map((item) => [item.manifest.versionId, item] as const),
  );
  const openings = new Map(
    graph.evaluationOpenings.map(
      (item) => [item.manifest.evaluationId, item] as const,
    ),
  );
  const results = new Map(
    graph.evaluationResults.map(
      (item) => [item.manifest.evaluationId, item] as const,
    ),
  );
  const publications = new Map(
    graph.evaluationPublications.map(
      (item) => [item.manifest.evaluationId, item] as const,
    ),
  );
  const decisions = new Map(
    graph.decisions.map(
      (item) => [item.manifest.evaluation.evaluationId, item] as const,
    ),
  );
  const seenEvaluationIds = new Set<string>();
  const seenPlannedVersionIds = new Set<string>();
  for (const exploration of graph.developerExplorations) {
    const manifest = exploration.manifest;
    const evaluationId = manifest.evaluation.evaluationId;
    if (seenEvaluationIds.has(evaluationId)) {
      throw new Error(
        `RSI evaluation ${evaluationId} has more than one Developer exploration`,
      );
    }
    seenEvaluationIds.add(evaluationId);
    const opening = openings.get(evaluationId);
    const result = results.get(evaluationId);
    const publication = publications.get(evaluationId);
    const decision = decisions.get(evaluationId);
    const sourceVersion = versions.get(manifest.sourceVersion.versionId);
    const baseVersion = versions.get(manifest.baseVersion.versionId);
    if (!opening || !result || !publication || !decision
      || !sourceVersion || !baseVersion
      || !sameVersionBinding(
        manifest.sourceVersion,
        versionBinding(sourceVersion),
      )
      || !sameVersionBinding(
        manifest.baseVersion,
        versionBinding(baseVersion),
      )
      || !sameVersionBinding(
        manifest.sourceVersion,
        publication.manifest.version,
      )
      || exploration.targetCommit !== sourceVersion.targetCommit
      || manifest.evaluation.openingHash
        !== opening.manifest.canonicalHash
      || manifest.evaluation.resultHash
        !== result.manifest.canonicalHash
      || manifest.evaluation.publicationHash
        !== publication.manifest.canonicalHash
      || manifest.evaluation.publicationTagObjectId
        !== publication.tagObjectId
      || manifest.evaluation.decisionId
        !== decision.manifest.decisionId
      || manifest.evaluation.decisionHash
        !== decision.manifest.canonicalHash
      || manifest.evaluation.decisionTagObjectId
        !== decision.tagObjectId
      || manifest.evaluation.stateRootPublicManifestHash
        !== (result.manifest.stateRoot?.publicManifestHash ?? null)) {
      throw new Error(
        `RSI Developer exploration ${manifest.explorationId} has an invalid terminal evaluation binding`,
      );
    }
    const legacy = isExactGrandfatheredLegacyPublication(
      sourceVersion,
      opening,
      result,
      decision,
      publication,
    );
    if (publication.manifest.publicSummary.kind
        !== "adaptive_protein_function"
      && !isProspectiveFrozenReplayTerminal(
        publication,
        decision,
      )
      && !isApprovedTerminalPreflightRejection(
        publication,
        opening,
        result,
        decision,
      )
      && !legacy) {
      throw new Error(
        "RSI Developer exploration requires a terminal prospective adaptive/frozen-replay evaluation, approved failed quality preflight, or exact grandfathered root",
      );
    }
    const event = graph.events.find(
      (item) => item.manifest.mutation.ref === exploration.ref,
    );
    if (!event?.manifest.previousEvent
      || event.manifest.previousEvent.sequence
        !== manifest.historyPrefix.eventSequence
      || event.manifest.previousEvent.manifestHash
        !== manifest.historyPrefix.eventManifestHash) {
      throw new Error(
        `RSI Developer exploration ${manifest.explorationId} has a stale history-event binding`,
      );
    }
    const history = buildDeveloperHistoryContextFromGraph(
      graph,
      manifest.historyPrefix.eventSequence,
    );
    const baseVersionEventSequence = eventSequenceForRef(
      graph.events,
      baseVersion.ref,
    );
    if (manifest.historyPrefix.schemaVersion !== history.schemaVersion
      || manifest.historyPrefix.contextHash !== history.canonicalHash
      || manifest.historyPrefix.eventManifestHash
        !== history.graphHead.eventManifestHash
      || manifest.historyPrefix.selectedVersionId
        !== history.graphHead.selectedVersionId
      || baseVersionEventSequence > manifest.historyPrefix.eventSequence) {
      throw new Error(
        `RSI Developer exploration ${manifest.explorationId} did not use the exact public history and a registered historical base`,
      );
    }
    const expectedAnalysis = evaluationAnalysisFor(
      sourceVersion,
      opening,
      result,
      publication,
      decision,
    );
    if (canonicalJson(manifest.evaluationAnalysis)
      !== canonicalJson(expectedAnalysis)) {
      throw new Error(
        `RSI Developer exploration ${manifest.explorationId} evaluation analysis is not the deterministic public projection`,
      );
    }
    const expectedPlan = buildRsiNextOptimizationPlan({
      spec: nextPlanSpecFromCanonical(manifest.nextOptimizationPlan),
      analysis: expectedAnalysis,
      baseVersionId: baseVersion.manifest.versionId,
      history: {
        contextHash: history.canonicalHash,
        eventSequence: history.graphHead.eventSequence,
        eventManifestHash: history.graphHead.eventManifestHash,
        selectedVersionId: history.graphHead.selectedVersionId,
      },
    });
    if (canonicalJson(manifest.nextOptimizationPlan)
      !== canonicalJson(expectedPlan)) {
      throw new Error(
        `RSI Developer exploration ${manifest.explorationId} next plan is not canonical`,
      );
    }
    const plannedVersionId = manifest.nextOptimizationPlan.plannedVersionId;
    if (manifest.nextOptimizationPlan.action === "proceed") {
      const plannedVersion = plannedVersionId
        ? versions.get(plannedVersionId)
        : undefined;
      if (!plannedVersionId || seenPlannedVersionIds.has(plannedVersionId)
        || (plannedVersion
          && (plannedVersion.manifest.developmentPlan?.schemaVersion
              !== RSI_DEVELOPER_EXPLORATION_SCHEMA
            || plannedVersion.manifest.developmentPlan.explorationId
              !== manifest.explorationId))) {
        throw new Error(
          "RSI Developer exploration planned version must be new and unique",
        );
      }
      seenPlannedVersionIds.add(plannedVersionId);
    } else if (plannedVersionId !== null) {
      throw new Error("a stop plan cannot name a planned version");
    }
  }
}

function epochResumeSpecFromManifest(
  manifest: RsiEpochResumeManifest,
): RsiEpochResumeSpec {
  return withCanonicalHash({
    schemaVersion: RSI_EPOCH_RESUME_SPEC_SCHEMA,
    epochId: manifest.nextEpoch.epochId,
    baseVersionId: manifest.baseVersion.versionId,
    plannedVersionId: manifest.nextEpoch.plannedVersionId,
    reason: manifest.nextEpoch.reason,
    hypothesis: manifest.nextEpoch.hypothesis,
    plannedChangeSummary: manifest.nextEpoch.plannedChangeSummary,
    codeChangeTargets: [...manifest.nextEpoch.codeChangeTargets],
    controls: [...manifest.nextEpoch.controls],
    verificationRequirements: [
      ...manifest.nextEpoch.verificationRequirements,
    ],
    evaluationPolicy: manifest.nextEpoch.evaluationPolicy,
    retrospectiveEvidencePolicy:
      manifest.nextEpoch.retrospectiveEvidencePolicy,
    claimBoundary: RSI_EPOCH_RESUME_CLAIM_BOUNDARY,
  }) as RsiEpochResumeSpec;
}

function verifyEpochResumes(
  graph: Pick<
    RsiVersionGraph,
    | "versions"
    | "decisions"
    | "developerExplorations"
    | "epochResumes"
    | "events"
    | "rootVersionId"
  >,
): void {
  if (!graph.rootVersionId && graph.epochResumes.length > 0) {
    throw new Error("RSI epoch resume exists without a root version");
  }
  const versions = new Map(
    graph.versions.map((item) => [item.manifest.versionId, item] as const),
  );
  const explorations = new Map(
    graph.developerExplorations.map(
      (item) => [item.manifest.explorationId, item] as const,
    ),
  );
  const seenStops = new Set<string>();
  const seenEpochs = new Set<string>();
  const seenPlannedVersions = new Set<string>();
  for (const resume of graph.epochResumes) {
    const manifest = resume.manifest;
    const stop = explorations.get(
      manifest.terminalStop.explorationId,
    );
    const base = versions.get(manifest.baseVersion.versionId);
    const event = graph.events.find(
      (item) => item.manifest.mutation.ref === resume.ref,
    );
    const stopEvent = stop
      ? graph.events.find(
        (item) => item.manifest.mutation.ref === stop.ref,
      )
      : undefined;
    const selectedVersionId = graph.rootVersionId && stopEvent
      ? selectedVersionAt(
        graph.rootVersionId,
        graph.decisions,
        graph.events,
        stopEvent.manifest.sequence,
      )
      : null;
    const selected = selectedVersionId
      ? versions.get(selectedVersionId)
      : undefined;
    const reconstructedSpec = epochResumeSpecFromManifest(manifest);
    const plannedVersion = versions.get(
      manifest.nextEpoch.plannedVersionId,
    );
    if (!stop || stop.manifest.nextOptimizationPlan.action !== "stop"
      || !base || !selected || !event || !stopEvent
      || seenStops.has(stop.manifest.explorationId)
      || seenEpochs.has(manifest.nextEpoch.epochId)
      || seenPlannedVersions.has(manifest.nextEpoch.plannedVersionId)
      || !sameVersionBinding(manifest.baseVersion, versionBinding(base))
      || !sameVersionBinding(
        manifest.selectedVersion,
        versionBinding(selected),
      )
      || resume.targetCommit !== base.targetCommit
      || manifest.terminalStop.manifestHash
        !== stop.manifest.canonicalHash
      || manifest.terminalStop.tagObjectId !== stop.tagObjectId
      || manifest.terminalStop.eventSequence
        !== stopEvent.manifest.sequence
      || manifest.terminalStop.eventManifestHash
        !== stopEvent.manifest.canonicalHash
      || manifest.historyPrefix.eventSequence
        !== stopEvent.manifest.sequence
      || manifest.historyPrefix.eventManifestHash
        !== stopEvent.manifest.canonicalHash
      || manifest.historyPrefix.selectedVersionId !== selectedVersionId
      || event.manifest.previousEvent?.sequence
        !== stopEvent.manifest.sequence
      || event.manifest.previousEvent?.manifestHash
        !== stopEvent.manifest.canonicalHash
      || event.manifest.previousEvent?.tagObjectId
        !== stopEvent.tagObjectId
      || manifest.nextEpoch.planHash
        !== reconstructedSpec.canonicalHash
      || (plannedVersion
        && (plannedVersion.manifest.developmentPlan?.schemaVersion
            !== RSI_EPOCH_RESUME_SCHEMA
          || plannedVersion.manifest.developmentPlan.resumeId
            !== manifest.resumeId))) {
      throw new Error(
        `RSI epoch resume ${manifest.resumeId} has an invalid terminal, history, selection, base, or plan binding`,
      );
    }
    assertPublicManifest(manifest, `RSI epoch resume ${manifest.resumeId}`);
    seenStops.add(stop.manifest.explorationId);
    seenEpochs.add(manifest.nextEpoch.epochId);
    seenPlannedVersions.add(manifest.nextEpoch.plannedVersionId);
  }
}

function retrospectiveIncumbentSpecFromManifest(
  manifest: RsiRetrospectiveIncumbentManifest,
): RsiRetrospectiveIncumbentSpec {
  const {
    reportBlobObjectId: _reportBlobObjectId,
    ...evidence
  } = manifest.evidence;
  return withCanonicalHash({
    schemaVersion: RSI_RETROSPECTIVE_INCUMBENT_SPEC_SCHEMA,
    adoptionId: manifest.adoptionId,
    incumbentVersionId: manifest.incumbentVersion.versionId,
    plannedVersionId: manifest.nextCandidate.plannedVersionId,
    reason: manifest.nextCandidate.reason,
    hypothesis: manifest.nextCandidate.hypothesis,
    plannedChangeSummary:
      manifest.nextCandidate.plannedChangeSummary,
    codeChangeTargets: [...manifest.nextCandidate.codeChangeTargets],
    controls: [...manifest.nextCandidate.controls],
    verificationRequirements: [
      ...manifest.nextCandidate.verificationRequirements,
    ],
    evidence: structuredClone(evidence),
    evaluationPolicy: manifest.nextCandidate.evaluationPolicy,
    retrospectiveEvidencePolicy:
      manifest.nextCandidate.retrospectiveEvidencePolicy,
    claimBoundary: RSI_RETROSPECTIVE_INCUMBENT_CLAIM_BOUNDARY,
  }) as RsiRetrospectiveIncumbentSpec;
}

function verifyRetrospectiveIncumbents(
  graph: Pick<
    RsiVersionGraph,
    | "versions"
    | "decisions"
    | "retrospectiveIncumbents"
    | "events"
    | "rootVersionId"
  >,
): void {
  if (!graph.rootVersionId && graph.retrospectiveIncumbents.length > 0) {
    throw new Error(
      "RSI retrospective incumbent adoption exists without a root version",
    );
  }
  const versions = new Map(
    graph.versions.map((item) => [item.manifest.versionId, item] as const),
  );
  const seenVersionIds = new Set<string>();
  const seenAdoptionIds = new Set<string>();
  const seenPlannedVersionIds = new Set<string>();
  for (const adoption of graph.retrospectiveIncumbents) {
    const manifest = adoption.manifest;
    const incumbent = versions.get(
      manifest.incumbentVersion.versionId,
    );
    const event = graph.events.find(
      (item) => item.manifest.mutation.ref === adoption.ref,
    );
    const incumbentEvent = incumbent
      ? graph.events.find(
        (item) => item.manifest.mutation.ref === incumbent.ref,
      )
      : undefined;
    const selectedVersionId = graph.rootVersionId && event
      ? selectedVersionAt(
        graph.rootVersionId,
        graph.decisions,
        graph.events,
        event.manifest.sequence - 1,
      )
      : null;
    const selected = selectedVersionId
      ? versions.get(selectedVersionId)
      : undefined;
    const reconstructed =
      retrospectiveIncumbentSpecFromManifest(manifest);
    const planned = versions.get(
      manifest.nextCandidate.plannedVersionId,
    );
    if (!incumbent || !event || !incumbentEvent || !selected
      || seenVersionIds.has(incumbent.manifest.versionId)
      || seenAdoptionIds.has(manifest.adoptionId)
      || seenPlannedVersionIds.has(
        manifest.nextCandidate.plannedVersionId,
      )
      || !sameVersionBinding(
        manifest.incumbentVersion,
        versionBinding(incumbent),
      )
      || !sameVersionBinding(
        manifest.formalSelection.selectedVersion,
        versionBinding(selected),
      )
      || manifest.formalSelection.formalDecisionMutation !== null
      || manifest.historyPrefix.eventSequence
        !== incumbentEvent.manifest.sequence
      || manifest.historyPrefix.eventManifestHash
        !== incumbentEvent.manifest.canonicalHash
      || manifest.historyPrefix.selectedVersionId
        !== selectedVersionId
      || manifest.historyPrefix.operationalIncumbentVersionId
        !== incumbent.manifest.versionId
      || event.manifest.previousEvent?.sequence
        !== incumbentEvent.manifest.sequence
      || event.manifest.previousEvent?.manifestHash
        !== incumbentEvent.manifest.canonicalHash
      || event.manifest.previousEvent?.tagObjectId
        !== incumbentEvent.tagObjectId
      || manifest.nextCandidate.planHash
        !== reconstructed.canonicalHash
      || (planned
        && (planned.manifest.developmentPlan?.schemaVersion
            !== RSI_RETROSPECTIVE_INCUMBENT_SCHEMA
          || planned.manifest.developmentPlan.adoptionId
            !== manifest.adoptionId))) {
      throw new Error(
        `RSI retrospective incumbent adoption ${manifest.adoptionId} has an invalid history, selection, incumbent, evidence, or plan binding`,
      );
    }
    assertPublicManifest(
      manifest,
      `RSI retrospective incumbent adoption ${manifest.adoptionId}`,
    );
    seenVersionIds.add(incumbent.manifest.versionId);
    seenAdoptionIds.add(manifest.adoptionId);
    seenPlannedVersionIds.add(
      manifest.nextCandidate.plannedVersionId,
    );
  }
}

function verifyEvaluationLifecycle(
  openings: readonly TaggedManifest<RsiEvaluationOpeningManifest>[],
  publications: readonly TaggedManifest<RsiEvaluationPublicationManifest>[],
  decisions: readonly TaggedManifest<RsiDecisionManifest>[],
  events: readonly TaggedManifest<RsiCodeEventManifest>[],
): void {
  const publicationMap = new Map(
    publications.map((item) => [item.manifest.evaluationId, item] as const),
  );
  const decisionMap = new Map(
    decisions.map((item) => [
      item.manifest.evaluation.evaluationId,
      item,
    ] as const),
  );
  const byVersion = new Map<
    string,
    TaggedManifest<RsiEvaluationOpeningManifest>[]
  >();
  for (const opening of openings) {
    const versionId = opening.manifest.version.versionId;
    const items = byVersion.get(versionId) ?? [];
    items.push(opening);
    byVersion.set(versionId, items);
  }
  for (const [versionId, items] of byVersion) {
    items.sort((left, right) =>
      eventSequenceForRef(events, left.ref)
      - eventSequenceForRef(events, right.ref));
    for (let index = 0; index < items.length - 1; index += 1) {
      const prior = items[index]!;
      const next = items[index + 1]!;
      const decision = decisionMap.get(prior.manifest.evaluationId);
      if (!decision
        || eventSequenceForRef(events, decision.ref)
          >= eventSequenceForRef(events, next.ref)) {
        throw new Error(
          `RSI version ${versionId} contains overlapping evaluations`,
        );
      }
      const publication = publicationMap.get(prior.manifest.evaluationId);
      if (decision.manifest.action !== "continue"
        || publication?.manifest.publicSummary.kind
          === "adaptive_protein_function"
        || isProspectiveFrozenReplayTerminal(
          publication,
          decision,
        )) {
        throw new Error(
          `RSI version ${versionId} was evaluated again after a terminal evaluation`,
        );
      }
    }
  }
}

function verifyEventCausality(
  versions: readonly TaggedManifest<RsiCodeVersionManifest>[],
  openings: readonly TaggedManifest<RsiEvaluationOpeningManifest>[],
  results: readonly TaggedManifest<RsiEvaluationResultManifest>[],
  publications:
    readonly TaggedManifest<RsiEvaluationPublicationManifest>[],
  decisions: readonly TaggedManifest<RsiDecisionManifest>[],
  explorations:
    readonly TaggedManifest<RsiDeveloperExplorationManifest>[],
  epochResumes:
    readonly TaggedManifest<RsiEpochResumeManifest>[],
  retrospectives:
    readonly TaggedManifest<RsiRetrospectiveExperimentManifest>[],
  retrospectiveIncumbents:
    readonly TaggedManifest<RsiRetrospectiveIncumbentManifest>[],
  events: readonly TaggedManifest<RsiCodeEventManifest>[],
): void {
  const versionByRef = new Map(
    versions.map((item) => [item.ref, item] as const),
  );
  const openingByRef = new Map(
    openings.map((item) => [item.ref, item] as const),
  );
  const resultByRef = new Map(
    results.map((item) => [item.ref, item] as const),
  );
  const publicationByRef = new Map(
    publications.map((item) => [item.ref, item] as const),
  );
  const decisionByRef = new Map(
    decisions.map((item) => [item.ref, item] as const),
  );
  const explorationByRef = new Map(
    explorations.map((item) => [item.ref, item] as const),
  );
  const epochResumeByRef = new Map(
    epochResumes.map((item) => [item.ref, item] as const),
  );
  const retrospectiveByRef = new Map(
    retrospectives.map((item) => [item.ref, item] as const),
  );
  const retrospectiveIncumbentByRef = new Map(
    retrospectiveIncumbents.map((item) => [item.ref, item] as const),
  );
  const versionById = new Map(
    versions.map((item) => [item.manifest.versionId, item] as const),
  );
  const openingById = new Map(
    openings.map((item) => [item.manifest.evaluationId, item] as const),
  );
  const resultById = new Map(
    results.map((item) => [item.manifest.evaluationId, item] as const),
  );
  const publicationById = new Map(
    publications.map((item) => [item.manifest.evaluationId, item] as const),
  );
  const decisionByEvaluationId = new Map(
    decisions.map((item) => [
      item.manifest.evaluation.evaluationId,
      item,
    ] as const),
  );
  const seenVersionIds = new Set<string>();
  const seenResultIds = new Set<string>();
  const seenPublicationIds = new Set<string>();
  const seenDecisionIds = new Set<string>();
  const adoptedVersionIds = new Set<string>();
  const evaluationIdsByVersion = new Map<string, string[]>();
  let selectedVersionId: string | null = null;
  let operationalIncumbentVersionId: string | null = null;
  let active: {
    evaluationId: string;
    stage: "opened" | "result" | "published" | "legacy_decided";
  } | null = null;
  let latestTerminalEvaluationId: string | null = null;
  let pendingExploration:
    TaggedManifest<RsiDeveloperExplorationManifest> | null = null;
  let pendingEpochResume:
    TaggedManifest<RsiEpochResumeManifest> | null = null;
  let pendingRetrospectiveIncumbent:
    TaggedManifest<RsiRetrospectiveIncumbentManifest> | null = null;

  const prefixIsPaperComplete = (): boolean => {
    for (const versionId of seenVersionIds) {
      const evaluationIds = evaluationIdsByVersion.get(versionId) ?? [];
      if (evaluationIds.length === 0
        && adoptedVersionIds.has(versionId)) {
        continue;
      }
      if (evaluationIds.length === 0
        || evaluationIds.some((evaluationId) =>
          !seenResultIds.has(evaluationId)
          || !seenPublicationIds.has(evaluationId)
          || !seenDecisionIds.has(evaluationId))) {
        return false;
      }
      const version = versionById.get(versionId)!;
      const qualifying = evaluationIds.some((evaluationId) => {
        const opening = openingById.get(evaluationId);
        const result = resultById.get(evaluationId);
        const publication = publicationById.get(evaluationId);
        const decision = decisionByEvaluationId.get(evaluationId);
        if (!opening || !result || !publication || !decision
          || !seenPublicationIds.has(evaluationId)
          || !seenDecisionIds.has(evaluationId)) {
          return false;
        }
        return (publication.manifest.publicationMode === "prospective"
            && publication.manifest.publicSummary.kind
              === "adaptive_protein_function")
          || isProspectiveFrozenReplayTerminal(
            publication,
            decision,
          )
          || isApprovedTerminalPreflightRejection(
            publication,
            opening,
            result,
            decision,
          )
          || isExactGrandfatheredLegacyPublication(
            version,
            opening,
            result,
            decision,
            publication,
          );
      });
      if (!qualifying) return false;
    }
    return seenVersionIds.size > 0;
  };

  for (const event of events) {
    const ref = event.manifest.mutation.ref;
    if (pendingExploration
      && ((pendingExploration.manifest.nextOptimizationPlan.action
          === "proceed"
        && event.manifest.mutation.kind !== "version")
      || (pendingExploration.manifest.nextOptimizationPlan.action
          === "stop"
        && event.manifest.mutation.kind !== "epoch_resume"))) {
      throw new Error(
        pendingExploration.manifest.nextOptimizationPlan.action === "stop"
          ? "a terminal stop may only be followed by an explicit epoch resume"
          : "a proceed exploration must be followed by its planned child version",
      );
    }
    if (pendingEpochResume
      && event.manifest.mutation.kind !== "version") {
      throw new Error(
        "an epoch resume must be followed by its planned child version",
      );
    }
    if (pendingRetrospectiveIncumbent
      && event.manifest.mutation.kind !== "version") {
      throw new Error(
        "a retrospective incumbent adoption must be followed by its planned child version",
      );
    }
    switch (event.manifest.mutation.kind) {
      case "version": {
        const version = versionByRef.get(ref);
        if (!version) throw new Error("RSI event replay lost a version mutation");
        if (seenVersionIds.size === 0) {
          if (version.manifest.parent !== null || selectedVersionId !== null) {
            throw new Error("RSI event replay requires the root version first");
          }
          selectedVersionId = version.manifest.versionId;
          operationalIncumbentVersionId = version.manifest.versionId;
        } else {
          if (active !== null || !prefixIsPaperComplete()) {
            throw new Error(
              `RSI version ${version.manifest.versionId} was registered before the prior public iteration was paper-complete`,
            );
          }
          if (!version.manifest.parent
            || !version.manifest.developmentContext) {
            throw new Error(
              `RSI version ${version.manifest.versionId} omitted its historical base or completed-prefix context`,
            );
          }
          const plan = version.manifest.developmentPlan;
          const consumesExploration = plan?.schemaVersion
              === RSI_DEVELOPER_EXPLORATION_SCHEMA
            && pendingExploration !== null
            && plan.explorationId
              === pendingExploration.manifest.explorationId
            && version.manifest.versionId
              === pendingExploration.manifest.nextOptimizationPlan
                .plannedVersionId
            && version.manifest.parent.versionId
              === pendingExploration.manifest.baseVersion.versionId;
          const consumesEpochResume = plan?.schemaVersion
              === RSI_EPOCH_RESUME_SCHEMA
            && pendingEpochResume !== null
            && plan.resumeId === pendingEpochResume.manifest.resumeId
            && version.manifest.versionId
              === pendingEpochResume.manifest.nextEpoch.plannedVersionId
            && version.manifest.parent.versionId
              === pendingEpochResume.manifest.baseVersion.versionId;
          const consumesRetrospectiveIncumbent =
            plan?.schemaVersion === RSI_RETROSPECTIVE_INCUMBENT_SCHEMA
            && pendingRetrospectiveIncumbent !== null
            && plan.adoptionId
              === pendingRetrospectiveIncumbent.manifest.adoptionId
            && version.manifest.versionId
              === pendingRetrospectiveIncumbent.manifest.nextCandidate
                .plannedVersionId
            && version.manifest.parent.versionId
              === pendingRetrospectiveIncumbent.manifest.incumbentVersion
                .versionId;
          if (!consumesExploration && !consumesEpochResume
            && !consumesRetrospectiveIncumbent) {
            throw new Error(
              `RSI version ${version.manifest.versionId} did not immediately consume its immutable pre-code plan`,
            );
          }
        }
        pendingExploration = null;
        pendingEpochResume = null;
        pendingRetrospectiveIncumbent = null;
        latestTerminalEvaluationId = null;
        seenVersionIds.add(version.manifest.versionId);
        break;
      }
      case "evaluation_opening": {
        const opening = openingByRef.get(ref);
        if (!opening) {
          throw new Error("RSI event replay lost an evaluation opening");
        }
        if (active !== null) {
          throw new Error(
            "RSI event history contains overlapping evaluations across versions",
          );
        }
        const versionId = opening.manifest.version.versionId;
        const version = versionById.get(versionId);
        if (!version || !seenVersionIds.has(versionId)) {
          throw new Error("RSI evaluation opened before its version existed");
        }
        const unevaluated = [...seenVersionIds].filter(
          (id) => (evaluationIdsByVersion.get(id) ?? []).length === 0
            && !adoptedVersionIds.has(id),
        );
        if (unevaluated.length > 0
          && (unevaluated.length !== 1 || unevaluated[0] !== versionId)) {
          throw new Error(
            "RSI evaluation did not cover the sole unevaluated version at its event prefix",
          );
        }
        if (unevaluated.length === 0
          && versionId !== selectedVersionId) {
          throw new Error(
            "a repeat RSI evaluation must use the selected version at its event prefix",
          );
        }
        const priorEvaluationIds =
          evaluationIdsByVersion.get(versionId) ?? [];
        if (priorEvaluationIds.some((evaluationId) => {
          const publication = publicationById.get(evaluationId);
          const decision = decisionByEvaluationId.get(evaluationId);
          return (seenPublicationIds.has(evaluationId)
              && publication?.manifest.publicSummary.kind
                === "adaptive_protein_function")
            || (seenDecisionIds.has(evaluationId)
              && isProspectiveFrozenReplayTerminal(
                publication,
                decision,
              ))
            || (seenDecisionIds.has(evaluationId)
              && decision?.manifest.action !== "continue");
        })) {
          throw new Error(
            `RSI version ${versionId} was evaluated after a terminal result`,
          );
        }
        evaluationIdsByVersion.set(versionId, [
          ...priorEvaluationIds,
          opening.manifest.evaluationId,
        ]);
        active = {
          evaluationId: opening.manifest.evaluationId,
          stage: "opened",
        };
        break;
      }
      case "evaluation_result": {
        const result = resultByRef.get(ref);
        if (!result
          || active?.evaluationId !== result.manifest.evaluationId
          || active.stage !== "opened") {
          throw new Error(
            "RSI evaluation result was not the next mutation for its active opening",
          );
        }
        seenResultIds.add(result.manifest.evaluationId);
        active.stage = "result";
        break;
      }
      case "evaluation_publication": {
        const publication = publicationByRef.get(ref);
        if (!publication
          || active?.evaluationId !== publication.manifest.evaluationId) {
          throw new Error(
            "RSI evaluation publication was not part of the active evaluation",
          );
        }
        if (publication.manifest.publicationMode === "prospective") {
          if (active.stage !== "result") {
            throw new Error(
              "prospective RSI publication must immediately follow its result before decision",
            );
          }
          active.stage = "published";
        } else {
          if (active.stage !== "legacy_decided") {
            throw new Error(
              "retrospective legacy publication must close its pre-contract decision",
            );
          }
          latestTerminalEvaluationId = publication.manifest.evaluationId;
          active = null;
        }
        seenPublicationIds.add(publication.manifest.evaluationId);
        break;
      }
      case "decision": {
        const decision = decisionByRef.get(ref);
        if (!decision
          || active?.evaluationId
            !== decision.manifest.evaluation.evaluationId) {
          throw new Error(
            "RSI decision was not part of the active evaluation",
          );
        }
        const evaluationId: string = active.evaluationId;
        const opening = openingById.get(evaluationId);
        const result = resultById.get(evaluationId);
        const version = result
          ? versionById.get(result.manifest.version.versionId)
          : undefined;
        const legacy: boolean = active.stage === "result"
          && isExactGrandfatheredLegacyBaseline(
            version,
            opening,
            result,
            decision,
          );
        if (active.stage !== "published" && !legacy) {
          throw new Error(
            "RSI decision requires a prospective publication at its event prefix",
          );
        }
        if (decision.manifest.selectionBefore.versionId
          !== selectedVersionId) {
          throw new Error(
            "RSI decision used a stale selected version at its event prefix",
          );
        }
        seenDecisionIds.add(evaluationId);
        selectedVersionId = decision.manifest.selectedVersion.versionId;
        if (decision.manifest.action === "continue") {
          operationalIncumbentVersionId =
            decision.manifest.selectedVersion.versionId;
        }
        const publication = publicationById.get(evaluationId);
        if (publication
          && (publication.manifest.publicSummary.kind
              === "adaptive_protein_function"
            || isProspectiveFrozenReplayTerminal(
              publication,
              decision,
            )
            || isApprovedTerminalPreflightRejection(
              publication,
              opening,
              result,
              decision,
            ))) {
          latestTerminalEvaluationId = evaluationId;
        }
        active = legacy
          ? { evaluationId, stage: "legacy_decided" }
          : null;
        break;
      }
      case "developer_exploration": {
        const exploration = explorationByRef.get(ref);
        if (!exploration || active !== null || pendingExploration !== null
          || pendingEpochResume !== null
          || pendingRetrospectiveIncumbent !== null) {
          throw new Error(
            "RSI Developer exploration was not appended at a closed evaluation boundary",
          );
        }
        const evaluationId = exploration.manifest.evaluation.evaluationId;
        if (latestTerminalEvaluationId !== evaluationId) {
          throw new Error(
            "RSI Developer exploration did not reflect the latest terminal evaluation",
          );
        }
        if (!seenVersionIds.has(
          exploration.manifest.baseVersion.versionId,
        )) {
          throw new Error(
            "RSI Developer exploration used a base version outside its history prefix",
          );
        }
        pendingExploration = exploration;
        break;
      }
      case "epoch_resume": {
        const resume = epochResumeByRef.get(ref);
        if (!resume || active !== null || pendingEpochResume !== null
          || pendingRetrospectiveIncumbent !== null
          || pendingExploration?.manifest.nextOptimizationPlan.action
            !== "stop"
          || resume.manifest.terminalStop.explorationId
            !== pendingExploration.manifest.explorationId
          || !seenVersionIds.has(
            resume.manifest.baseVersion.versionId,
          )
          || resume.manifest.historyPrefix.selectedVersionId
            !== selectedVersionId) {
          throw new Error(
            "RSI epoch resume did not consume the exact terminal stop at a closed history boundary",
          );
        }
        pendingExploration = null;
        pendingEpochResume = resume;
        break;
      }
      case "retrospective_experiment": {
        const retrospective = retrospectiveByRef.get(ref);
        const selected = selectedVersionId
          ? versionById.get(selectedVersionId)
          : undefined;
        if (!retrospective || active !== null
          || pendingExploration !== null
          || pendingEpochResume !== null
          || pendingRetrospectiveIncumbent !== null
          || latestTerminalEvaluationId === null
          || !selected
          || !sameVersionBinding(
            retrospective.manifest.formalSelection.selectedVersion,
            versionBinding(selected),
          )) {
          throw new Error(
            "RSI retrospective experiment must append at an unreflected terminal boundary and bind the unchanged formal selection",
          );
        }
        // A retrospective record contributes knowledge only. In particular,
        // it never changes selectedVersionId, the decision chain, the active
        // evaluation, or which terminal evaluation awaits reflection.
        break;
      }
      case "retrospective_incumbent": {
        const adoption = retrospectiveIncumbentByRef.get(ref);
        const selected = selectedVersionId
          ? versionById.get(selectedVersionId)
          : undefined;
        const incumbent = adoption
          ? versionById.get(
            adoption.manifest.incumbentVersion.versionId,
          )
          : undefined;
        const unresolved = [...seenVersionIds].filter(
          (id) => (evaluationIdsByVersion.get(id) ?? []).length === 0
            && !adoptedVersionIds.has(id),
        );
        if (!adoption || active !== null
          || pendingExploration !== null
          || pendingEpochResume !== null
          || pendingRetrospectiveIncumbent !== null
          || !selected || !incumbent
          || unresolved.length !== 1
          || unresolved[0] !== incumbent.manifest.versionId
          || adoptedVersionIds.has(incumbent.manifest.versionId)
          || !sameVersionBinding(
            adoption.manifest.formalSelection.selectedVersion,
            versionBinding(selected),
          )
          || !sameVersionBinding(
            adoption.manifest.incumbentVersion,
            versionBinding(incumbent),
          )
          || adoption.manifest.historyPrefix.selectedVersionId
            !== selectedVersionId
          || adoption.manifest.historyPrefix
            .operationalIncumbentVersionId
            !== incumbent.manifest.versionId
          || event.manifest.previousEvent?.manifestHash
            !== events.find((candidate) =>
              candidate.manifest.mutation.ref === incumbent.ref)
              ?.manifest.canonicalHash) {
          throw new Error(
            "RSI retrospective incumbent adoption must consume the sole unevaluated latest version while preserving formal selection",
          );
        }
        adoptedVersionIds.add(incumbent.manifest.versionId);
        operationalIncumbentVersionId = incumbent.manifest.versionId;
        pendingRetrospectiveIncumbent = adoption;
        break;
      }
    }
  }
  if (operationalIncumbentVersionId === null
    && selectedVersionId !== null) {
    throw new Error("RSI event replay lost its operational incumbent");
  }
}

function genericSummaryPassed(summary: RsiNonAdaptivePublicSummary): boolean {
  return summary.checks.some((check) => check.status === "passed")
    && summary.checks.every((check) => check.status !== "failed");
}

function prospectiveFrozenReplayPassState(
  publication:
    | TaggedManifest<RsiEvaluationPublicationManifest>
    | undefined,
): boolean | null {
  if (!publication
    || publication.manifest.publicationMode !== "prospective"
    || publication.manifest.result.kind !== "frozen_replay"
    || publication.manifest.publicSummary.kind !== "frozen_replay") {
    return null;
  }
  const summary = publication.manifest.publicSummary;
  const evidence = summary.evidenceBinding;
  const acquisition = evidence.baselineAcquisition;
  const privateAudit = evidence.prospective20PrivateEvidenceAudit;
  const checks = summary.checks;
  if (publication.manifest.opening.protocolId
      !== RSI_Z55_FROZEN_REPLAY_PROTOCOL_ID
    || publication.manifest.opening.protocolHash
      !== RSI_Z55_FROZEN_REPLAY_PROTOCOL_HASH
    || evidence.receiptSchemaVersion
      !== RSI_Z55_FROZEN_REPLAY_RECEIPT_SCHEMA
    || !HASH.test(evidence.receiptCanonicalHash)
    || evidence.protocolId !== publication.manifest.opening.protocolId
    || evidence.protocolHash !== publication.manifest.opening.protocolHash
    || evidence.formalOpeningHash
      !== publication.manifest.opening.manifestHash
    || evidence.formalOpeningTagObjectId
      !== publication.manifest.opening.tagObjectId
    || !HASH.test(evidence.finalistHash)
    || !HASH.test(evidence.baselineBatchCanonicalHash)
    || !HASH.test(evidence.baselineAcquisitionCanonicalHash)
    || acquisition.schemaVersion !== RSI_Z55_BASELINE_ACQUISITION_SCHEMA
    || acquisition.suiteId !== RSI_Z55_FROZEN_REPLAY_SUITE_ID
    || acquisition.genomeHash !== RSI_Z55_CONTROL_GENOME_HASH
    || acquisition.ontologySha256 !== RSI_Z55_ONTOLOGY_SHA256
    || acquisition.batchManifestHash
      !== evidence.baselineBatchCanonicalHash
    || acquisition.canonicalHash
      !== evidence.baselineAcquisitionCanonicalHash
    || acquisition.canonicalHash
      !== hashCanonical(withoutCanonicalHash(acquisition))
    || !((acquisition.executionScope === "portable_remote"
        && acquisition.sourceKind === "remote_exact_cache")
      || (acquisition.executionScope === "developer_local_snapshot"
        && acquisition.sourceKind === "local_content_snapshot"))
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(
      acquisition.acquisitionEpochId,
    )
    || acquisition.status !== "completed"
    || acquisition.caseCount !== 20
    || acquisition.completedCaseCount !== 20
    || !HASH.test(privateAudit.samplingReceiptHash)
    || !HASH.test(privateAudit.homologyAuditHash)
    || privateAudit.excludedPriorSuiteCount !== 8
    || privateAudit.excludedPriorIdentityCount !== 122
    || privateAudit.matchedSourceRecordCount !== 122
    || privateAudit.selectedPairCount !== 190
    || privateAudit.sharedInterproPairCount !== 0
    || privateAudit.pairsAtOrAboveKmerThreshold !== 0
    || !HASH.test(evidence.liveReplayCanonicalHash)
    || !HASH.test(evidence.controlPredictionHash)
    || !HASH.test(evidence.candidatePredictionHash)
    || evidence.candidateVariantId !== RSI_Z55_CANDIDATE_VARIANT_ID
    || evidence.candidateGenomeHash !== RSI_Z55_CANDIDATE_GENOME_HASH
    || evidence.controlGenomeHash !== RSI_Z55_CONTROL_GENOME_HASH
    || evidence.deepGoPlusMethodHash !== RSI_Z55_DEEPGOPLUS_METHOD_HASH
    || evidence.ontologySha256 !== RSI_Z55_ONTOLOGY_SHA256
    || checks.length !== RSI_Z55_FROZEN_REPLAY_CHECK_IDS.length
    || checks.some((check, index) =>
      check.checkId !== RSI_Z55_FROZEN_REPLAY_CHECK_IDS[index]
      || (check.status !== "passed" && check.status !== "failed"))
    || checks[4]?.status !== "passed"
    || checks[5]?.status !== "passed") {
    return null;
  }
  const passed = checks.slice(0, 4).every(
    (check) => check.status === "passed",
  );
  if (evidence.selectionDecision
      !== (passed ? "promote_candidate" : "retain_baseline")
    || evidence.selectedVariantId
      !== (passed ? RSI_Z55_CANDIDATE_VARIANT_ID : "agent_baseline")) {
    return null;
  }
  return passed;
}

function isProspectiveFrozenReplayTerminal(
  publication:
    | TaggedManifest<RsiEvaluationPublicationManifest>
    | undefined,
  decision:
    | TaggedManifest<RsiDecisionManifest>
    | undefined,
): boolean {
  if (!publication || !decision
    || publication.manifest.publicationMode !== "prospective"
    || publication.manifest.result.kind !== "frozen_replay"
    || publication.manifest.publicSummary.kind !== "frozen_replay"
    || decision.manifest.evaluation.evaluationId
      !== publication.manifest.evaluationId
    || decision.manifest.evaluation.publicationManifestHash
      !== publication.manifest.canonicalHash) {
    return false;
  }
  const passed = prospectiveFrozenReplayPassState(publication);
  if (passed === true) return decision.manifest.action === "continue";
  return passed === false
    && (decision.manifest.action === "backtrack"
      || decision.manifest.action === "retain");
}

/**
 * One immutable compatibility bridge for the already-published Z-55 v0002
 * pre-gold failure. This is deliberately a full object fingerprint rather
 * than a general class of acquisition or software failures: future failures
 * must use a protocol that represents their terminal semantics prospectively.
 */
export function isExactZ55V0002PreGoldContractFailure(
  publication:
    | TaggedManifest<RsiEvaluationPublicationManifest>
    | undefined,
  opening:
    | TaggedManifest<RsiEvaluationOpeningManifest>
    | undefined,
  result:
    | TaggedManifest<RsiEvaluationResultManifest>
    | undefined,
  decision:
    | TaggedManifest<RsiDecisionManifest>
    | undefined,
): boolean {
  if (!publication || !opening || !result || !decision) return false;
  const candidateBinding = {
    versionId: RSI_Z55_V0002_PRE_GOLD_VERSION_ID,
    manifestHash: RSI_Z55_V0002_PRE_GOLD_VERSION_MANIFEST_HASH,
    sourceCommit: RSI_Z55_V0002_PRE_GOLD_SOURCE_COMMIT,
    tagObjectId: RSI_Z55_V0002_PRE_GOLD_VERSION_TAG_OBJECT_ID,
  };
  const rootBinding = {
    versionId: LEGACY_ROOT_VERSION_ID,
    manifestHash: LEGACY_ROOT_VERSION_MANIFEST_HASH,
    sourceCommit: LEGACY_ROOT_SOURCE_COMMIT,
    tagObjectId: LEGACY_ROOT_VERSION_TAG_OBJECT_ID,
  };
  const summary = publication.manifest.publicSummary;
  return opening.ref
      === `refs/tags/rsi/evaluation/${
        RSI_Z55_V0002_PRE_GOLD_EVALUATION_ID
      }/opening`
    && opening.tagObjectId
      === RSI_Z55_V0002_PRE_GOLD_OPENING_TAG_OBJECT_ID
    && opening.targetCommit === RSI_Z55_V0002_PRE_GOLD_SOURCE_COMMIT
    && opening.manifest.schemaVersion
      === RSI_CODE_EVALUATION_OPENING_SCHEMA
    && opening.manifest.evaluationId
      === RSI_Z55_V0002_PRE_GOLD_EVALUATION_ID
    && opening.manifest.tagRef === opening.ref
    && opening.manifest.canonicalHash
      === RSI_Z55_V0002_PRE_GOLD_OPENING_MANIFEST_HASH
    && sameVersionBinding(opening.manifest.version, candidateBinding)
    && opening.manifest.protocol.protocolId
      === RSI_Z55_FROZEN_REPLAY_PROTOCOL_ID
    && opening.manifest.protocol.protocolHash
      === RSI_Z55_FROZEN_REPLAY_PROTOCOL_HASH
    && opening.manifest.state === "opened_before_private_evaluation"
    && result.ref
      === `refs/tags/rsi/evaluation/${
        RSI_Z55_V0002_PRE_GOLD_EVALUATION_ID
      }/result`
    && result.tagObjectId === RSI_Z55_V0002_PRE_GOLD_RESULT_TAG_OBJECT_ID
    && result.targetCommit === RSI_Z55_V0002_PRE_GOLD_SOURCE_COMMIT
    && result.manifest.schemaVersion === RSI_CODE_EVALUATION_RESULT_SCHEMA
    && result.manifest.evaluationId
      === RSI_Z55_V0002_PRE_GOLD_EVALUATION_ID
    && result.manifest.tagRef === result.ref
    && result.manifest.canonicalHash
      === RSI_Z55_V0002_PRE_GOLD_RESULT_MANIFEST_HASH
    && result.manifest.openingHash
      === RSI_Z55_V0002_PRE_GOLD_OPENING_MANIFEST_HASH
    && sameVersionBinding(result.manifest.version, candidateBinding)
    && result.manifest.result.kind === "software_verification"
    && result.manifest.result.artifactHash
      === RSI_Z55_V0002_PRE_GOLD_RESULT_ARTIFACT_HASH
    && result.manifest.result.publicSummaryHash
      === RSI_Z55_V0002_PRE_GOLD_RESULT_PUBLIC_SUMMARY_HASH
    && result.manifest.stateRoot === null
    && result.manifest.claimBoundary
      === RSI_Z55_V0002_PRE_GOLD_CLAIM_BOUNDARY
    && result.manifest.state === "completed"
    && publication.ref
      === `refs/tags/rsi/evaluation/${
        RSI_Z55_V0002_PRE_GOLD_EVALUATION_ID
      }/publication`
    && publication.tagObjectId
      === RSI_Z55_V0002_PRE_GOLD_PUBLICATION_TAG_OBJECT_ID
    && publication.targetCommit === RSI_Z55_V0002_PRE_GOLD_SOURCE_COMMIT
    && publication.manifest.schemaVersion
      === RSI_CODE_EVALUATION_PUBLICATION_SCHEMA
    && publication.manifest.evaluationId
      === RSI_Z55_V0002_PRE_GOLD_EVALUATION_ID
    && publication.manifest.tagRef === publication.ref
    && publication.manifest.canonicalHash
      === RSI_Z55_V0002_PRE_GOLD_PUBLICATION_MANIFEST_HASH
    && sameVersionBinding(publication.manifest.version, candidateBinding)
    && publication.manifest.opening.manifestHash
      === RSI_Z55_V0002_PRE_GOLD_OPENING_MANIFEST_HASH
    && publication.manifest.opening.tagObjectId
      === RSI_Z55_V0002_PRE_GOLD_OPENING_TAG_OBJECT_ID
    && publication.manifest.opening.protocolId
      === RSI_Z55_FROZEN_REPLAY_PROTOCOL_ID
    && publication.manifest.opening.protocolHash
      === RSI_Z55_FROZEN_REPLAY_PROTOCOL_HASH
    && publication.manifest.result.manifestHash
      === RSI_Z55_V0002_PRE_GOLD_RESULT_MANIFEST_HASH
    && publication.manifest.result.tagObjectId
      === RSI_Z55_V0002_PRE_GOLD_RESULT_TAG_OBJECT_ID
    && publication.manifest.result.kind === "software_verification"
    && publication.manifest.result.artifactHash
      === RSI_Z55_V0002_PRE_GOLD_RESULT_ARTIFACT_HASH
    && publication.manifest.result.stateRootPublicManifestHash === null
    && publication.manifest.publicationMode === "prospective"
    && publication.manifest.claimBoundary
      === RSI_Z55_V0002_PRE_GOLD_CLAIM_BOUNDARY
    && summary.kind === "software_verification"
    && summary.summary === RSI_Z55_V0002_PRE_GOLD_SUMMARY
    && summary.artifactClaimBoundary
      === RSI_Z55_V0002_PRE_GOLD_CLAIM_BOUNDARY
    && canonicalJson(summary.checks)
      === canonicalJson(RSI_Z55_V0002_PRE_GOLD_CHECKS)
    && summary.teacher === null
    && decision.ref
      === `refs/tags/rsi/decision/${
        RSI_Z55_V0002_PRE_GOLD_DECISION_ID
      }`
    && decision.tagObjectId
      === RSI_Z55_V0002_PRE_GOLD_DECISION_TAG_OBJECT_ID
    && decision.targetCommit === LEGACY_ROOT_SOURCE_COMMIT
    && decision.manifest.schemaVersion === RSI_CODE_DECISION_SCHEMA
    && decision.manifest.decisionId
      === RSI_Z55_V0002_PRE_GOLD_DECISION_ID
    && decision.manifest.tagRef === decision.ref
    && decision.manifest.canonicalHash
      === RSI_Z55_V0002_PRE_GOLD_DECISION_MANIFEST_HASH
    && decision.manifest.previousDecision?.decisionId === LEGACY_DECISION_ID
    && decision.manifest.previousDecision?.manifestHash
      === LEGACY_DECISION_MANIFEST_HASH
    && decision.manifest.evaluation.evaluationId
      === RSI_Z55_V0002_PRE_GOLD_EVALUATION_ID
    && decision.manifest.evaluation.resultManifestHash
      === RSI_Z55_V0002_PRE_GOLD_RESULT_MANIFEST_HASH
    && decision.manifest.evaluation.publicationManifestHash
      === RSI_Z55_V0002_PRE_GOLD_PUBLICATION_MANIFEST_HASH
    && sameVersionBinding(
      decision.manifest.selectionBefore,
      rootBinding,
    )
    && sameVersionBinding(
      decision.manifest.candidateVersion,
      candidateBinding,
    )
    && sameVersionBinding(decision.manifest.selectedVersion, rootBinding)
    && decision.manifest.action === "backtrack"
    && decision.manifest.rationale
      === RSI_Z55_V0002_PRE_GOLD_DECISION_RATIONALE;
}

function isApprovedTerminalPreflightRejection(
  publication:
    | TaggedManifest<RsiEvaluationPublicationManifest>
    | undefined,
  opening:
    | TaggedManifest<RsiEvaluationOpeningManifest>
    | undefined,
  result:
    | TaggedManifest<RsiEvaluationResultManifest>
    | undefined,
  decision:
    | TaggedManifest<RsiDecisionManifest>
    | undefined,
): boolean {
  if (isExactZ55V0002PreGoldContractFailure(
    publication,
    opening,
    result,
    decision,
  )) {
    return true;
  }
  if (!publication || !opening || !decision
    || publication.manifest.publicationMode !== "prospective"
    || publication.manifest.publicSummary.kind !== "software_verification"
    || genericSummaryPassed(publication.manifest.publicSummary)
    || opening.manifest.protocol.protocolId
      !== RSI_CODE_VERSION_QUALITY_PROTOCOL_ID
    || opening.manifest.protocol.protocolHash
      !== RSI_CODE_VERSION_QUALITY_PROTOCOL_HASH
    || decision.manifest.action === "continue") {
    return false;
  }
  const checks = new Map(
    publication.manifest.publicSummary.checks.map(
      (check) => [check.checkId, check.status] as const,
    ),
  );
  return RSI_REQUIRED_PREFLIGHT_CHECK_IDS.every((checkId) => {
    const status = checks.get(checkId);
    return status === "passed" || status === "failed";
  }) && RSI_REQUIRED_PREFLIGHT_CHECK_IDS.some(
    (checkId) => checks.get(checkId) === "failed",
  );
}

function assertEvaluationDecisionSemantics(
  publication: TaggedManifest<RsiEvaluationPublicationManifest>,
  before: TaggedManifest<RsiCodeVersionManifest>,
  candidate: TaggedManifest<RsiCodeVersionManifest>,
  selected: TaggedManifest<RsiCodeVersionManifest>,
  action: RsiDecisionAction,
): void {
  const summary = publication.manifest.publicSummary;
  const retainedSelectionBefore = action === "retain"
    && selected.manifest.versionId === before.manifest.versionId;
  if (summary.kind !== "adaptive_protein_function") {
    if (summary.kind === "frozen_replay") {
      const frozenReplayPassed =
        prospectiveFrozenReplayPassState(publication);
      if (frozenReplayPassed === null) {
        throw new Error(
          "frozen_replay decision requires the closed prospective Z55 evidence binding",
        );
      }
      if (frozenReplayPassed) {
        if (action !== "continue"
          || selected.manifest.versionId !== candidate.manifest.versionId) {
          throw new Error(
            "passed frozen_replay selection requires continue on the evaluated candidate",
          );
        }
        return;
      }
      if (!candidate.manifest.parent) {
        if (!retainedSelectionBefore
          || selected.manifest.versionId !== candidate.manifest.versionId) {
          throw new Error(
            "failed frozen_replay root selection requires retain",
          );
        }
        return;
      }
      if (retainedSelectionBefore) return;
      if (action !== "backtrack"
        || selected.manifest.versionId === candidate.manifest.versionId) {
        throw new Error(
          "failed frozen_replay selection requires backtrack to a previously selected strict ancestor or retain of selectionBefore",
        );
      }
      return;
    }
    const passed = genericSummaryPassed(summary);
    if (passed) {
      if (action !== "continue"
        || selected.manifest.versionId !== candidate.manifest.versionId) {
        throw new Error(
          "passed non-adaptive evaluation requires continue on the evaluated candidate",
        );
      }
      return;
    }
    if (!candidate.manifest.parent) {
      if (!retainedSelectionBefore
        || selected.manifest.versionId !== candidate.manifest.versionId) {
        throw new Error(
          "failed non-adaptive root evaluation requires retain",
        );
      }
      return;
    }
    if (retainedSelectionBefore) return;
    if (action !== "backtrack"
      || selected.manifest.versionId === candidate.manifest.versionId) {
      throw new Error(
        "failed non-adaptive candidate requires backtrack to a previously selected strict ancestor or retain of selectionBefore",
      );
    }
    return;
  }
  if (summary.challenger.decision === "selected_successor") {
    if (action !== "continue"
      || selected.manifest.versionId !== candidate.manifest.versionId) {
      throw new Error(
        "selected_successor adaptive outcome requires continue on the evaluated candidate",
      );
    }
    return;
  }
  if (!candidate.manifest.parent) {
    if (!retainedSelectionBefore
      || selected.manifest.versionId !== candidate.manifest.versionId) {
      throw new Error(
        "rejected adaptive root evaluation requires retain",
      );
    }
    return;
  }
  if (retainedSelectionBefore) return;
  if (action !== "backtrack"
    || !candidate.manifest.parent
    || selected.manifest.versionId === candidate.manifest.versionId) {
    throw new Error(
      "rejected adaptive candidate requires backtrack to a previously selected strict ancestor or retain of selectionBefore",
    );
  }
}

function selectedVersionAt(
  rootVersionId: string,
  decisions: readonly TaggedManifest<RsiDecisionManifest>[],
  events: readonly TaggedManifest<RsiCodeEventManifest>[],
  throughEventSequence: number,
): string {
  let selected = rootVersionId;
  const ordered = decisions
    .map((decision) => ({
      decision,
      sequence: eventSequenceForRef(events, decision.ref),
    }))
    .filter((item) => item.sequence <= throughEventSequence)
    .sort((left, right) => left.sequence - right.sequence);
  for (const item of ordered) {
    selected = item.decision.manifest.selectedVersion.versionId;
  }
  return selected;
}

function operationalIncumbentVersionAt(
  rootVersionId: string,
  decisions: readonly TaggedManifest<RsiDecisionManifest>[],
  retrospectiveIncumbents:
    readonly TaggedManifest<RsiRetrospectiveIncumbentManifest>[],
  events: readonly TaggedManifest<RsiCodeEventManifest>[],
  throughEventSequence: number,
): string {
  let incumbent = rootVersionId;
  for (const event of events) {
    if (event.manifest.sequence > throughEventSequence) break;
    if (event.manifest.mutation.kind === "decision") {
      const decision = decisions.find((item) =>
        item.ref === event.manifest.mutation.ref);
      if (decision?.manifest.action === "continue") {
        incumbent = decision.manifest.selectedVersion.versionId;
      }
    } else if (event.manifest.mutation.kind
        === "retrospective_incumbent") {
      const adoption = retrospectiveIncumbents.find((item) =>
        item.ref === event.manifest.mutation.ref);
      if (adoption) {
        incumbent = adoption.manifest.incumbentVersion.versionId;
      }
    }
  }
  return incumbent;
}

function buildDeveloperHistoryContextFromGraph(
  graph: Pick<
    RsiVersionGraph,
    | "versions"
    | "evaluationPublications"
    | "decisions"
    | "developerExplorations"
    | "epochResumes"
    | "retrospectiveExperiments"
    | "retrospectiveIncumbents"
    | "events"
    | "rootVersionId"
  >,
  throughEventSequence = graph.events.at(-1)?.manifest.sequence ?? 0,
): RsiDeveloperHistoryContext {
  if (!graph.rootVersionId || throughEventSequence < 1) {
    throw new Error("RSI Developer history requires a non-empty version graph");
  }
  const head = graph.events.find(
    (item) => item.manifest.sequence === throughEventSequence,
  );
  if (!head) throw new Error("RSI Developer history event head does not exist");
  const versions = new Map(
    graph.versions.map((item) => [item.manifest.versionId, item] as const),
  );
  const decisions = new Map(
    graph.decisions
      .filter((item) =>
        eventSequenceForRef(graph.events, item.ref) <= throughEventSequence)
      .map((item) => [item.manifest.evaluation.evaluationId, item] as const),
  );
  const records = graph.evaluationPublications
    .map((publication) => ({
      publication,
      sequence: eventSequenceForRef(graph.events, publication.ref),
    }))
    .filter((item) => item.sequence <= throughEventSequence)
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ publication, sequence }): RsiDeveloperHistoryRecord => {
      const version = versions.get(publication.manifest.version.versionId);
      if (!version) throw new Error("RSI publication refers to an unknown version");
      const summary = publication.manifest.publicSummary;
      const decision = decisions.get(publication.manifest.evaluationId);
      const adaptive = summary.kind === "adaptive_protein_function";
      return {
        eventSequence: sequence,
        versionId: version.manifest.versionId,
        parentVersionId: version.manifest.parent?.versionId ?? null,
        evaluationId: publication.manifest.evaluationId,
        resultKind: publication.manifest.result.kind,
        changeSummary: version.manifest.change.summary,
        hypothesis: version.manifest.change.hypothesis,
        method: adaptive
          ? {
            templateId: summary.method.templateId,
            family: summary.method.family,
            externalEvidenceIds: [...summary.method.externalEvidenceIds],
          }
          : null,
        metrics: adaptive
          ? {
            controlFmax: {
              overall: summary.control.metrics.overall.fmax,
              molecularFunction:
                summary.control.metrics.aspects.molecular_function.fmax,
              biologicalProcess:
                summary.control.metrics.aspects.biological_process.fmax,
              cellularComponent:
                summary.control.metrics.aspects.cellular_component.fmax,
            },
            challengerFmax: {
              overall: summary.challenger.metrics.overall.fmax,
              molecularFunction:
                summary.challenger.metrics.aspects.molecular_function.fmax,
              biologicalProcess:
                summary.challenger.metrics.aspects.biological_process.fmax,
              cellularComponent:
                summary.challenger.metrics.aspects.cellular_component.fmax,
            },
            overallFmaxGain: summary.challenger.overallFmaxGain,
            maximumPopulatedAspectFmaxDrop:
              summary.challenger.maximumPopulatedAspectFmaxDrop,
          }
          : null,
        outcome: adaptive
          ? summary.challenger.decision
          : genericSummaryPassed(summary)
            ? "passed"
            : "failed",
        teacher: adaptive
          ? {
            hypothesisVerdict: summary.teacher.hypothesisVerdict,
            mechanismVerdict: summary.teacher.mechanismVerdict,
            diagnoses: [...summary.teacher.diagnoses],
            prioritizedActions: [...summary.teacher.prioritizedActions],
          }
          : null,
        decision: decision
          ? {
            action: decision.manifest.action,
            selectedVersionId: decision.manifest.selectedVersion.versionId,
            rationale: decision.manifest.rationale,
          }
          : null,
        publicationHash: publication.manifest.canonicalHash,
        claimBoundary: publication.manifest.claimBoundary,
      };
    });
  const explorations = graph.developerExplorations
    .map((exploration) => ({
      exploration,
      sequence: eventSequenceForRef(graph.events, exploration.ref),
    }))
    .filter((item) => item.sequence <= throughEventSequence)
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ exploration, sequence }) => {
      const plan = exploration.manifest.nextOptimizationPlan;
      return {
        eventSequence: sequence,
        explorationId: exploration.manifest.explorationId,
        sourceVersionId: plan.sourceVersionId,
        sourceEvaluationId: plan.sourceEvaluationId,
        baseVersionId: plan.baseVersionId,
        manifestHash: exploration.manifest.canonicalHash,
        evaluationAnalysisHash: plan.evaluationAnalysisHash,
        planHash: plan.canonicalHash,
        action: plan.action,
        plannedVersionId: plan.plannedVersionId,
        teacherDistillation:
          structuredClone(plan.teacherDistillation),
        problemAssessment: plan.problemAssessment,
        problemCodes: [...plan.problemCodes],
        hypothesis: plan.hypothesis,
        plannedChangeSummary: plan.plannedChangeSummary,
        codeChangeTargets: [...plan.codeChangeTargets],
        controls: [...plan.controls],
        expectedEffects: structuredClone(plan.expectedEffects),
        experiment: structuredClone(plan.experiment),
        researchCardBundleHash: plan.researchCardBundleHash,
        researchCards: structuredClone(plan.researchCards),
        rollbackCondition: plan.rollbackCondition,
        claimBoundary: plan.claimBoundary,
      };
    });
  const retrospectiveRecords = graph.retrospectiveExperiments
    .map((retrospective) => ({
      retrospective,
      sequence: eventSequenceForRef(graph.events, retrospective.ref),
    }))
    .filter((item) => item.sequence <= throughEventSequence)
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ retrospective, sequence }):
      RsiDeveloperHistoryRetrospectiveRecord => ({
      eventSequence: sequence,
      recordId: retrospective.manifest.recordId,
      manifestHash: retrospective.manifest.canonicalHash,
      evaluatedSource:
        structuredClone(retrospective.manifest.evaluatedSource),
      receipt: {
        relativePath: retrospective.manifest.receipt.relativePath,
        blobObjectId: retrospective.manifest.receipt.blobObjectId,
        fileSha256: retrospective.manifest.receipt.fileSha256,
        canonicalHash: retrospective.manifest.receipt.canonicalHash,
      },
      formalSelectedVersionId:
        retrospective.manifest.formalSelection.selectedVersion.versionId,
      changeSummary: retrospective.manifest.experiment.changeSummary,
      hypothesis: retrospective.manifest.experiment.hypothesis,
      component: retrospective.manifest.experiment.component,
      observations:
        structuredClone(retrospective.manifest.experiment.observations),
      diagnoses: [...retrospective.manifest.experiment.diagnoses],
      prioritizedActions:
        [...retrospective.manifest.experiment.prioritizedActions],
      localGateOutcome:
        retrospective.manifest.experiment.localGateOutcome,
      archiveSealHash: retrospective.manifest.archive.archiveSealHash,
      archivePublicManifestHash:
        retrospective.manifest.archive.publicManifestHash,
      evidenceTiming: retrospective.manifest.policies.evidenceTiming,
      selectionEligibility:
        retrospective.manifest.policies.selectionEligibility,
      promotionEligibility:
        retrospective.manifest.policies.promotionEligibility,
      claimBoundary: retrospective.manifest.claimBoundary,
    }));
  const retrospectiveIncumbents = graph.retrospectiveIncumbents
    .map((adoption) => ({
      adoption,
      sequence: eventSequenceForRef(graph.events, adoption.ref),
    }))
    .filter((item) => item.sequence <= throughEventSequence)
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ adoption, sequence }):
      RsiDeveloperHistoryRetrospectiveIncumbentRecord => ({
      eventSequence: sequence,
      adoptionId: adoption.manifest.adoptionId,
      manifestHash: adoption.manifest.canonicalHash,
      selectedVersionId:
        adoption.manifest.formalSelection.selectedVersion.versionId,
      operationalIncumbentVersionId:
        adoption.manifest.incumbentVersion.versionId,
      evidence: structuredClone(adoption.manifest.evidence),
      plannedVersionId:
        adoption.manifest.nextCandidate.plannedVersionId,
      planHash: adoption.manifest.nextCandidate.planHash,
      claimBoundary: adoption.manifest.claimBoundary,
    }));
  const operationalIncumbentVersionId =
    operationalIncumbentVersionAt(
      graph.rootVersionId,
      graph.decisions,
      graph.retrospectiveIncumbents,
      graph.events,
      throughEventSequence,
    );
  const lastProspectivelySelectedVersionId = selectedVersionAt(
    graph.rootVersionId,
    graph.decisions,
    graph.events,
    throughEventSequence,
  );
  const common = {
    graphHead: {
      eventSequence: throughEventSequence,
      eventManifestHash: head.manifest.canonicalHash,
      selectedVersionId: lastProspectivelySelectedVersionId,
    },
    records,
    explorations,
  };
  return retrospectiveIncumbents.length > 0
    ? withCanonicalHash({
      schemaVersion: RSI_DEVELOPER_HISTORY_CONTEXT_V4_SCHEMA,
      ...common,
      retrospectiveRecords,
      retrospectiveIncumbents,
      currentBestVersionId: operationalIncumbentVersionId,
      lastProspectivelySelectedVersionId,
    }) as RsiDeveloperHistoryContextV4
    : retrospectiveRecords.length === 0
    ? withCanonicalHash({
      schemaVersion: RSI_DEVELOPER_HISTORY_CONTEXT_SCHEMA,
      ...common,
    }) as RsiDeveloperHistoryContextV1
    : withCanonicalHash({
      schemaVersion: RSI_DEVELOPER_HISTORY_CONTEXT_V2_SCHEMA,
      ...common,
      retrospectiveRecords,
    }) as RsiDeveloperHistoryContextV2;
}

function verifyVersionDevelopmentContexts(
  graph: Pick<
    RsiVersionGraph,
    | "versions"
    | "evaluationPublications"
    | "decisions"
    | "developerExplorations"
    | "epochResumes"
    | "retrospectiveExperiments"
    | "retrospectiveIncumbents"
    | "events"
    | "rootVersionId"
  >,
): void {
  for (const version of graph.versions) {
    if (!version.manifest.parent) {
      if (version.manifest.developmentContext !== undefined
        && version.manifest.developmentContext !== null) {
        throw new Error(
          `RSI root version ${version.manifest.versionId} cannot claim a prior Developer history`,
        );
      }
      if (version.manifest.developmentPlan !== undefined) {
        throw new Error(
          `RSI root version ${version.manifest.versionId} cannot claim a prior Developer exploration`,
        );
      }
      continue;
    }
    const binding = version.manifest.developmentContext;
    if (!binding) {
      throw new Error(
        `RSI non-root version ${version.manifest.versionId} omits its Developer history`,
      );
    }
    const versionEvent = graph.events.find(
      (item) => item.manifest.mutation.ref === version.ref,
    );
    if (!versionEvent?.manifest.previousEvent
      || versionEvent.manifest.previousEvent.sequence !== binding.eventSequence
      || versionEvent.manifest.previousEvent.manifestHash
        !== binding.eventManifestHash) {
      throw new Error(
        `RSI version ${version.manifest.versionId} has a stale Developer-history event binding`,
      );
    }
    const context = buildDeveloperHistoryContextFromGraph(
      graph,
      binding.eventSequence,
    );
    if (binding.schemaVersion !== context.schemaVersion
      || binding.contextHash !== context.canonicalHash
      || binding.eventManifestHash !== context.graphHead.eventManifestHash
      || binding.selectedVersionId !== context.graphHead.selectedVersionId) {
      throw new Error(
        `RSI version ${version.manifest.versionId} was not developed from the exact complete public history`,
      );
    }
    const planBinding = version.manifest.developmentPlan;
    if (!planBinding) {
      throw new Error(
        `RSI non-root version ${version.manifest.versionId} omits its pre-code development plan`,
      );
    }
    if (planBinding.schemaVersion === RSI_DEVELOPER_EXPLORATION_SCHEMA) {
      const exploration = graph.developerExplorations.find((item) =>
        item.manifest.explorationId === planBinding.explorationId);
      if (!exploration
        || versionEvent.manifest.previousEvent.manifestHash
          !== graph.events.find(
            (item) => item.manifest.mutation.ref === exploration.ref,
          )?.manifest.canonicalHash
        || planBinding.manifestHash !== exploration.manifest.canonicalHash
        || planBinding.tagObjectId !== exploration.tagObjectId
        || planBinding.sourceVersionId
          !== exploration.manifest.sourceVersion.versionId
        || planBinding.baseVersionId
          !== exploration.manifest.baseVersion.versionId
        || planBinding.plannedVersionId !== version.manifest.versionId
        || planBinding.plannedVersionId
          !== exploration.manifest.nextOptimizationPlan.plannedVersionId
        || planBinding.evaluationAnalysisHash
          !== exploration.manifest.evaluationAnalysis.canonicalHash
        || planBinding.planHash
          !== exploration.manifest.nextOptimizationPlan.canonicalHash
        || exploration.manifest.nextOptimizationPlan.action !== "proceed"
        || exploration.manifest.baseVersion.versionId
          !== version.manifest.parent.versionId
        || exploration.manifest.nextOptimizationPlan.hypothesis
          !== version.manifest.change.hypothesis
        || exploration.manifest.nextOptimizationPlan.plannedChangeSummary
          !== version.manifest.change.summary) {
        throw new Error(
          `RSI version ${version.manifest.versionId} does not bind the exact immediately preceding pre-code Developer plan`,
        );
      }
    } else if (planBinding.schemaVersion === RSI_EPOCH_RESUME_SCHEMA) {
      const resume = graph.epochResumes.find((item) =>
        item.manifest.resumeId === planBinding.resumeId);
      if (!resume
        || versionEvent.manifest.previousEvent.manifestHash
          !== graph.events.find(
            (item) => item.manifest.mutation.ref === resume.ref,
          )?.manifest.canonicalHash
        || planBinding.manifestHash !== resume.manifest.canonicalHash
        || planBinding.tagObjectId !== resume.tagObjectId
        || planBinding.terminalExplorationId
          !== resume.manifest.terminalStop.explorationId
        || planBinding.baseVersionId
          !== resume.manifest.baseVersion.versionId
        || planBinding.plannedVersionId !== version.manifest.versionId
        || planBinding.plannedVersionId
          !== resume.manifest.nextEpoch.plannedVersionId
        || planBinding.planHash !== resume.manifest.nextEpoch.planHash
        || resume.manifest.baseVersion.versionId
          !== version.manifest.parent.versionId
        || resume.manifest.nextEpoch.hypothesis
          !== version.manifest.change.hypothesis
        || resume.manifest.nextEpoch.plannedChangeSummary
          !== version.manifest.change.summary) {
        throw new Error(
          `RSI version ${version.manifest.versionId} does not bind the exact immediately preceding epoch-resume plan`,
        );
      }
    } else {
      const adoption = graph.retrospectiveIncumbents.find((item) =>
        item.manifest.adoptionId === planBinding.adoptionId);
      if (!adoption
        || versionEvent.manifest.previousEvent.manifestHash
          !== graph.events.find(
            (item) => item.manifest.mutation.ref === adoption.ref,
          )?.manifest.canonicalHash
        || planBinding.manifestHash !== adoption.manifest.canonicalHash
        || planBinding.tagObjectId !== adoption.tagObjectId
        || planBinding.baseVersionId
          !== adoption.manifest.incumbentVersion.versionId
        || planBinding.plannedVersionId !== version.manifest.versionId
        || planBinding.plannedVersionId
          !== adoption.manifest.nextCandidate.plannedVersionId
        || planBinding.planHash
          !== adoption.manifest.nextCandidate.planHash
        || adoption.manifest.incumbentVersion.versionId
          !== version.manifest.parent.versionId
        || adoption.manifest.nextCandidate.hypothesis
          !== version.manifest.change.hypothesis
        || adoption.manifest.nextCandidate.plannedChangeSummary
          !== version.manifest.change.summary) {
        throw new Error(
          `RSI version ${version.manifest.versionId} does not bind the exact immediately preceding retrospective-incumbent plan`,
        );
      }
    }
  }
}

async function verifyDecisions(
  repositoryRoot: string,
  versions: TaggedManifest<RsiCodeVersionManifest>[],
  openings: TaggedManifest<RsiEvaluationOpeningManifest>[],
  results: TaggedManifest<RsiEvaluationResultManifest>[],
  publications: TaggedManifest<RsiEvaluationPublicationManifest>[],
  decisions: TaggedManifest<RsiDecisionManifest>[],
  rootVersionId: string | null,
): Promise<{
  selectedVersionId: string | null;
  decisionHeadId: string | null;
}> {
  if (versions.length === 0) {
    if (decisions.length > 0) throw new Error("RSI decisions exist without code versions");
    return { selectedVersionId: null, decisionHeadId: null };
  }
  const versionMap = new Map(
    versions.map((item) => [item.manifest.versionId, item] as const),
  );
  const resultMap = new Map(
    results.map((item) => [item.manifest.evaluationId, item] as const),
  );
  const openingMap = new Map(
    openings.map((item) => [item.manifest.evaluationId, item] as const),
  );
  const publicationMap = new Map(
    publications.map((item) => [item.manifest.evaluationId, item] as const),
  );
  if (decisions.length === 0) {
    return { selectedVersionId: rootVersionId, decisionHeadId: null };
  }
  const decisionMap = new Map(
    decisions.map((item) => [item.manifest.decisionId, item] as const),
  );
  if (decisionMap.size !== decisions.length) throw new Error("duplicate RSI decision ID");
  const referenced = new Set<string>();
  const roots: TaggedManifest<RsiDecisionManifest>[] = [];
  const evaluationIds = new Set<string>();
  for (const decision of decisions) {
    const previous = decision.manifest.previousDecision;
    if (previous) {
      const prior = decisionMap.get(previous.decisionId);
      if (!prior || prior.manifest.canonicalHash !== previous.manifestHash) {
        throw new Error(`RSI decision ${decision.manifest.decisionId} has an invalid previous binding`);
      }
      referenced.add(previous.decisionId);
    } else {
      roots.push(decision);
    }
    const result = resultMap.get(decision.manifest.evaluation.evaluationId);
    if (!result
      || result.manifest.canonicalHash !== decision.manifest.evaluation.resultManifestHash) {
      throw new Error(`RSI decision ${decision.manifest.decisionId} has no exact completed evaluation`);
    }
    const publicationHash =
      decision.manifest.evaluation.publicationManifestHash;
    const publication = publicationMap.get(result.manifest.evaluationId);
    const legacyWithoutDecisionBinding = isExactGrandfatheredLegacyBaseline(
      versionMap.get(result.manifest.version.versionId),
      openingMap.get(result.manifest.evaluationId),
      result,
      decision,
    );
    if (!publication && !legacyWithoutDecisionBinding) {
      throw new Error(
        `RSI decision ${decision.manifest.decisionId} has no immutable evaluation publication`,
      );
    }
    if (publication && !legacyWithoutDecisionBinding
      && publicationHash === undefined) {
      throw new Error(
        `RSI decision ${decision.manifest.decisionId} omits its required publication binding`,
      );
    }
    if (publicationHash !== undefined
      && publication?.manifest.canonicalHash !== publicationHash) {
      throw new Error(
        `RSI decision ${decision.manifest.decisionId} has an invalid publication binding`,
      );
    }
    if (evaluationIds.has(result.manifest.evaluationId)) {
      throw new Error(`one RSI evaluation cannot receive two terminal decisions`);
    }
    evaluationIds.add(result.manifest.evaluationId);
    const before = versionMap.get(decision.manifest.selectionBefore.versionId);
    const candidate = versionMap.get(decision.manifest.candidateVersion.versionId);
    const selected = versionMap.get(decision.manifest.selectedVersion.versionId);
    if (!before || !candidate || !selected
      || !sameVersionBinding(decision.manifest.selectionBefore, versionBinding(before))
      || !sameVersionBinding(decision.manifest.candidateVersion, versionBinding(candidate))
      || !sameVersionBinding(decision.manifest.selectedVersion, versionBinding(selected))
      || !sameVersionBinding(result.manifest.version, versionBinding(candidate))
      || decision.targetCommit !== selected.targetCommit) {
      throw new Error(`RSI decision ${decision.manifest.decisionId} has an invalid version binding`);
    }
    if (decision.manifest.action === "continue") {
      if (selected !== candidate) {
        throw new Error("continue decision must select the evaluated candidate");
      }
    } else if (decision.manifest.action === "backtrack") {
      if (selected === candidate
        || !await isAncestor(repositoryRoot, selected.targetCommit, candidate.targetCommit)) {
        throw new Error("backtrack decision must select a strict ancestor of the candidate");
      }
    } else if (selected !== before) {
      throw new Error(
        "retain decision must keep selectionBefore while preserving the evaluated candidate",
      );
    }
    if (publication) {
      assertEvaluationDecisionSemantics(
        publication,
        before,
        candidate,
        selected,
        decision.manifest.action,
      );
    }
  }
  if (roots.length !== 1) throw new Error("RSI decision log must have exactly one root");
  const heads = decisions.filter((item) => !referenced.has(item.manifest.decisionId));
  if (heads.length !== 1) throw new Error("RSI decision log must have exactly one head");
  let cursor: TaggedManifest<RsiDecisionManifest> | undefined = heads[0];
  const walked = new Set<string>();
  const previouslySelected = new Set<string>();
  if (rootVersionId) previouslySelected.add(rootVersionId);
  while (cursor) {
    if (walked.has(cursor.manifest.decisionId)) {
      throw new Error("RSI decision log contains a cycle");
    }
    walked.add(cursor.manifest.decisionId);
    const previousId: string | undefined =
      cursor.manifest.previousDecision?.decisionId;
    cursor = previousId ? decisionMap.get(previousId) : undefined;
  }
  if (walked.size !== decisions.length) throw new Error("RSI decision log is disconnected");
  const ordered: TaggedManifest<RsiDecisionManifest>[] = [];
  cursor = heads[0];
  while (cursor) {
    ordered.push(cursor);
    const previousId: string | undefined =
      cursor.manifest.previousDecision?.decisionId;
    cursor = previousId ? decisionMap.get(previousId) : undefined;
  }
  ordered.reverse();
  let selectedId = rootVersionId!;
  for (const decision of ordered) {
    if (decision.manifest.selectionBefore.versionId !== selectedId) {
      throw new Error(`RSI decision ${decision.manifest.decisionId} uses a stale selected version`);
    }
    if (decision.manifest.action === "backtrack"
      && !previouslySelected.has(decision.manifest.selectedVersion.versionId)) {
      throw new Error("RSI backtrack target was never a selected historical version");
    }
    selectedId = decision.manifest.selectedVersion.versionId;
    previouslySelected.add(selectedId);
  }
  return {
    selectedVersionId: selectedId,
    decisionHeadId: heads[0].manifest.decisionId,
  };
}

export async function inspectRsiVersionGraph(
  repositoryRootInput: string,
  remote?: string,
): Promise<RsiVersionGraph> {
  const repositoryRoot = await canonicalRepositoryRoot(repositoryRootInput);
  if (remote) await assertRemoteNamespace(repositoryRoot, remote);
  const versions = await readVersionTags(repositoryRoot);
  const { openings, results, publications } =
    await readEvaluationTags(repositoryRoot);
  const decisions = await readDecisionTags(repositoryRoot);
  const developerExplorations =
    await readDeveloperExplorationTags(repositoryRoot);
  const epochResumes = await readEpochResumeTags(repositoryRoot);
  const retrospectiveExperiments =
    await readRetrospectiveExperimentTags(repositoryRoot);
  const retrospectiveIncumbents =
    await readRetrospectiveIncumbentTags(repositoryRoot);
  const events = await readEventTags(repositoryRoot);
  const recognizedRefs = new Set([
    ...versions.map((item) => item.ref),
    ...openings.map((item) => item.ref),
    ...results.map((item) => item.ref),
    ...publications.map((item) => item.ref),
    ...decisions.map((item) => item.ref),
    ...developerExplorations.map((item) => item.ref),
    ...epochResumes.map((item) => item.ref),
    ...retrospectiveExperiments.map((item) => item.ref),
    ...retrospectiveIncumbents.map((item) => item.ref),
    ...events.map((item) => item.ref),
  ]);
  const allRefs = await listRefs(repositoryRoot, RSI_TAG_PREFIX);
  if (recognizedRefs.size !== allRefs.length
    || allRefs.some((ref) => !recognizedRefs.has(ref))) {
    throw new Error("RSI namespace contains an unknown or duplicate graph ref");
  }
  const rootVersionId = await verifyVersionTopology(repositoryRoot, versions);
  const incompleteEvaluationIds = await verifyEvaluations(
    versions,
    openings,
    results,
  );
  const { selectedVersionId, decisionHeadId } = await verifyDecisions(
    repositoryRoot,
    versions,
    openings,
    results,
    publications,
    decisions,
    rootVersionId,
  );
  verifyEvents(
    versions,
    openings,
    results,
    publications,
    decisions,
    developerExplorations,
    epochResumes,
    retrospectiveExperiments,
    retrospectiveIncumbents,
    events,
  );
  const unpublishedEvaluationIds = verifyPublications(
    versions,
    openings,
    results,
    publications,
    decisions,
    events,
  );
  verifyEvaluationLifecycle(
    openings,
    publications,
    decisions,
    events,
  );
  verifyEventCausality(
    versions,
    openings,
    results,
    publications,
    decisions,
    developerExplorations,
    epochResumes,
    retrospectiveExperiments,
    retrospectiveIncumbents,
    events,
  );
  const decidedEvaluationIds = new Set(
    decisions.map((item) => item.manifest.evaluation.evaluationId),
  );
  const undecidedEvaluationIds = results
    .map((item) => item.manifest.evaluationId)
    .filter((id) => !decidedEvaluationIds.has(id))
    .sort();
  const openedVersionIds = new Set(
    openings.map((item) => item.manifest.version.versionId),
  );
  const unevaluatedVersionIds = versions
    .map((item) => item.manifest.versionId)
    .filter((id) => !openedVersionIds.has(id))
    .sort();
  const retrospectivelyAdoptedVersionIds = retrospectiveIncumbents
    .map((item) => item.manifest.incumbentVersion.versionId)
    .sort(compareAscii);
  const adoptedVersionIds = new Set(retrospectivelyAdoptedVersionIds);
  const unresolvedVersionIds = unevaluatedVersionIds
    .filter((versionId) => !adoptedVersionIds.has(versionId))
    .sort(compareAscii);
  const historyComplete = versions.length > 0
    && rootVersionId !== null
    && selectedVersionId !== null
    && events.length > 0
    && incompleteEvaluationIds.length === 0
    && unpublishedEvaluationIds.length === 0
    && undecidedEvaluationIds.length === 0
    && unevaluatedVersionIds.length === 0
    && versions.every((item) =>
      item.manifest.parent === null
      || (item.manifest.developmentContext !== undefined
        && item.manifest.developmentContext !== null
        && item.manifest.developmentPlan !== undefined));
  const proteinEvaluationIncompleteVersionIds = versions
    .filter((version) => {
      const versionPublications = publications.filter((publication) =>
        publication.manifest.version.versionId
          === version.manifest.versionId);
      const hasProspectiveTerminalEvaluation = versionPublications.some(
        (publication) => {
          const decision = decisions.find((item) =>
            item.manifest.evaluation.evaluationId
              === publication.manifest.evaluationId);
          return (publication.manifest.publicationMode === "prospective"
              && publication.manifest.publicSummary.kind
                === "adaptive_protein_function")
            || isProspectiveFrozenReplayTerminal(
              publication,
              decision,
            );
        },
      );
      const hasTerminalPreflightRejection = versionPublications.some(
        (publication) => {
          const evaluationId = publication.manifest.evaluationId;
          const opening = openings.find((item) =>
            item.manifest.evaluationId === evaluationId);
          const result = results.find((item) =>
            item.manifest.evaluationId === evaluationId);
          const decision = decisions.find((item) =>
            item.manifest.evaluation.evaluationId
              === evaluationId);
          return isApprovedTerminalPreflightRejection(
            publication,
            opening,
            result,
            decision,
          );
        },
      );
      const isGrandfatheredLegacyRoot = versionPublications.some(
        (publication) => {
          if (publication.manifest.publicationMode
            !== "retrospective_legacy") return false;
          const evaluationId = publication.manifest.evaluationId;
          return isExactGrandfatheredLegacyPublication(
            version,
            openings.find((item) =>
              item.manifest.evaluationId === evaluationId),
            results.find((item) =>
              item.manifest.evaluationId === evaluationId),
            decisions.find((item) =>
              item.manifest.evaluation.evaluationId === evaluationId),
            publication,
          );
        },
      );
      return !hasProspectiveTerminalEvaluation
        && !hasTerminalPreflightRejection
        && !isGrandfatheredLegacyRoot;
    })
    .map((item) => item.manifest.versionId)
    .sort();
  const unreflectedTerminalVersionIds = publications
    .filter((publication) => {
      const evaluationId = publication.manifest.evaluationId;
      const opening = openings.find((item) =>
        item.manifest.evaluationId === evaluationId);
      const decision = decisions.find((item) =>
        item.manifest.evaluation.evaluationId === evaluationId);
      const version = versions.find((item) =>
        item.manifest.versionId
          === publication.manifest.version.versionId);
      const terminal = publication.manifest.publicSummary.kind
          === "adaptive_protein_function"
        || isProspectiveFrozenReplayTerminal(
          publication,
          decision,
        )
        || isApprovedTerminalPreflightRejection(
          publication,
          opening,
          results.find((item) =>
            item.manifest.evaluationId === evaluationId),
          decision,
        )
        || isExactGrandfatheredLegacyPublication(
          version,
          opening,
          results.find((item) =>
            item.manifest.evaluationId === evaluationId),
          decision,
          publication,
        );
      return terminal && !developerExplorations.some((item) =>
        item.manifest.evaluation.evaluationId === evaluationId);
    })
    .map((item) => item.manifest.version.versionId)
    .sort();
  const evaluationComplete = historyComplete
    && proteinEvaluationIncompleteVersionIds.length === 0;
  const graph: RsiVersionGraph = {
    repositoryRoot,
    versions,
    evaluationOpenings: openings,
    evaluationResults: results,
    evaluationPublications: publications,
    decisions,
    developerExplorations,
    epochResumes,
    retrospectiveExperiments,
    retrospectiveIncumbents,
    events,
    rootVersionId,
    selectedVersionId,
    operationalIncumbentVersionId: null,
    currentBestVersionId: null,
    decisionHeadId,
    incompleteEvaluationIds,
    unpublishedEvaluationIds,
    undecidedEvaluationIds,
    unevaluatedVersionIds,
    unresolvedVersionIds,
    retrospectivelyAdoptedVersionIds,
    proteinEvaluationIncompleteVersionIds,
    unreflectedTerminalVersionIds,
    readyForNextVersion: false,
    historyComplete,
    evaluationComplete,
    paperComplete: evaluationComplete
      && unreflectedTerminalVersionIds.length === 0,
  };
  let operationalIncumbentVersionId = rootVersionId;
  for (const event of events) {
    if (event.manifest.mutation.kind === "decision") {
      const decision = decisions.find((item) =>
        item.ref === event.manifest.mutation.ref);
      if (decision?.manifest.action === "continue") {
        operationalIncumbentVersionId =
          decision.manifest.selectedVersion.versionId;
      }
    } else if (event.manifest.mutation.kind
        === "retrospective_incumbent") {
      const adoption = retrospectiveIncumbents.find((item) =>
        item.ref === event.manifest.mutation.ref);
      if (adoption) {
        operationalIncumbentVersionId =
          adoption.manifest.incumbentVersion.versionId;
      }
    }
  }
  graph.operationalIncumbentVersionId =
    operationalIncumbentVersionId;
  graph.currentBestVersionId = operationalIncumbentVersionId;
  graph.readyForNextVersion =
    (
      (graph.events.at(-1)?.manifest.mutation.kind
        === "developer_exploration"
        && graph.paperComplete
        && developerExplorations.some((item) =>
          item.ref === graph.events.at(-1)?.manifest.mutation.ref
          && item.manifest.nextOptimizationPlan.action === "proceed"))
      || (graph.events.at(-1)?.manifest.mutation.kind === "epoch_resume"
        && graph.paperComplete
        && epochResumes.some((item) =>
          item.ref === graph.events.at(-1)?.manifest.mutation.ref))
      || (graph.events.at(-1)?.manifest.mutation.kind
          === "retrospective_incumbent"
        && unresolvedVersionIds.length === 0
        && retrospectiveIncumbents.some((item) =>
          item.ref === graph.events.at(-1)?.manifest.mutation.ref))
    );
  verifyDeveloperExplorations(graph);
  verifyEpochResumes(graph);
  verifyRetrospectiveIncumbents(graph);
  verifyVersionDevelopmentContexts(graph);
  return graph;
}

export async function registerRsiCodeVersion(
  input: RegisterRsiVersionInput,
): Promise<TaggedManifest<RsiCodeVersionManifest>> {
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  const head = await inspectCleanHead(repositoryRoot);
  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  const versionId = assertId(input.versionId, "version ID");
  if (graph.versions.some((item) => item.manifest.versionId === versionId)) {
    throw new Error(`RSI version ID already exists: ${versionId}`);
  }
  if (graph.versions.some((item) => item.manifest.sourceCommit === head.sourceCommit)) {
    throw new Error("current Git commit is already registered as an RSI code version");
  }
  let parent: TaggedManifest<RsiCodeVersionManifest> | undefined;
  let developmentContext:
    RsiCodeVersionManifest["developmentContext"] = null;
  let developmentPlan:
    RsiCodeVersionManifest["developmentPlan"] | undefined;
  const changeSummary = assertText(input.changeSummary, "change summary");
  const hypothesis = assertText(input.hypothesis, "hypothesis");
  if (graph.versions.length === 0) {
    if (input.parentVersionId !== undefined) {
      throw new Error("the first RSI code version must be a root without --parent-version");
    }
    if (input.developerContextPath !== undefined) {
      throw new Error("the root RSI code version must not declare Developer history");
    }
    if (input.developerExplorationId !== undefined) {
      throw new Error(
        "the root RSI code version must not declare a Developer exploration",
      );
    }
    if (input.epochResumeId !== undefined) {
      throw new Error(
        "the root RSI code version must not declare an epoch resume",
      );
    }
    if (input.retrospectiveIncumbentId !== undefined) {
      throw new Error(
        "the root RSI code version must not declare a retrospective incumbent adoption",
      );
    }
  } else {
    if (!input.parentVersionId) throw new Error("non-root RSI code version requires a parent version");
    parent = byVersionId(graph, assertId(input.parentVersionId, "parent version ID"));
    await assertLinearVersionEdge(repositoryRoot, parent, {
      targetCommit: head.sourceCommit,
    });
    const latestIsRetrospectiveIncumbent =
      graph.events.at(-1)?.manifest.mutation.kind
        === "retrospective_incumbent";
    if (!graph.paperComplete && !latestIsRetrospectiveIncumbent) {
      throw new Error(
        "new RSI code version requires a paper-complete history or the exact latest retrospective-incumbent bridge",
      );
    }
    if (Number(input.developerExplorationId !== undefined)
        + Number(input.epochResumeId !== undefined)
        + Number(input.retrospectiveIncumbentId !== undefined) !== 1) {
      throw new Error(
        "non-root RSI code version requires exactly one exact pre-code --developer-exploration, --epoch-resume, or --retrospective-incumbent",
      );
    }
    if (!graph.readyForNextVersion) {
      throw new Error(
        "non-root RSI code version requires the latest graph mutation to be a proceed Developer exploration or epoch resume",
      );
    }
    let exploration:
      TaggedManifest<RsiDeveloperExplorationManifest> | undefined;
    let epochResume:
      TaggedManifest<RsiEpochResumeManifest> | undefined;
    let retrospectiveIncumbent:
      TaggedManifest<RsiRetrospectiveIncumbentManifest> | undefined;
    if (input.developerExplorationId !== undefined) {
      const explorationId = assertId(
        input.developerExplorationId,
        "Developer exploration ID",
      );
      exploration = graph.developerExplorations.find((item) =>
        item.manifest.explorationId === explorationId);
      if (!exploration
        || graph.events.at(-1)?.manifest.mutation.ref !== exploration.ref
        || exploration.manifest.nextOptimizationPlan.action !== "proceed"
        || exploration.manifest.nextOptimizationPlan.plannedVersionId
          !== versionId
        || exploration.manifest.baseVersion.versionId
          !== parent.manifest.versionId
        || exploration.manifest.nextOptimizationPlan.hypothesis
          !== hypothesis
        || exploration.manifest.nextOptimizationPlan.plannedChangeSummary
          !== changeSummary) {
        throw new Error(
          "new RSI code version does not match the latest immutable pre-code Developer plan",
        );
      }
    } else if (input.epochResumeId !== undefined) {
      const resumeId = assertId(
        input.epochResumeId!,
        "epoch resume ID",
      );
      epochResume = graph.epochResumes.find((item) =>
        item.manifest.resumeId === resumeId);
      if (!epochResume
        || graph.events.at(-1)?.manifest.mutation.ref !== epochResume.ref
        || epochResume.manifest.nextEpoch.plannedVersionId !== versionId
        || epochResume.manifest.baseVersion.versionId
          !== parent.manifest.versionId
        || epochResume.manifest.nextEpoch.hypothesis !== hypothesis
        || epochResume.manifest.nextEpoch.plannedChangeSummary
          !== changeSummary) {
        throw new Error(
          "new RSI code version does not match the latest immutable epoch-resume plan",
        );
      }
    } else {
      const adoptionId = assertId(
        input.retrospectiveIncumbentId!,
        "retrospective incumbent adoption ID",
      );
      retrospectiveIncumbent = graph.retrospectiveIncumbents.find(
        (item) => item.manifest.adoptionId === adoptionId,
      );
      if (!retrospectiveIncumbent
        || graph.events.at(-1)?.manifest.mutation.ref
          !== retrospectiveIncumbent.ref
        || retrospectiveIncumbent.manifest.nextCandidate
          .plannedVersionId !== versionId
        || retrospectiveIncumbent.manifest.incumbentVersion.versionId
          !== parent.manifest.versionId
        || retrospectiveIncumbent.manifest.nextCandidate.hypothesis
          !== hypothesis
        || retrospectiveIncumbent.manifest.nextCandidate
          .plannedChangeSummary !== changeSummary) {
        throw new Error(
          "new RSI code version does not match the latest immutable retrospective-incumbent plan",
        );
      }
    }
    if (!input.developerContextPath) {
      throw new Error(
        "non-root RSI code version requires an exact --developer-context history artifact",
      );
    }
    const contextFile = await stableFile(input.developerContextPath);
    let contextValue: unknown;
    try {
      contextValue = JSON.parse(contextFile.bytes.toString("utf8")) as unknown;
    } catch {
      throw new Error("RSI Developer history context is not valid JSON");
    }
    const expectedContext = buildDeveloperHistoryContextFromGraph(graph);
    if (canonicalJson(contextValue) !== canonicalJson(expectedContext)) {
      throw new Error(
        "RSI Developer history context is stale or does not match the complete public graph",
      );
    }
    assertPublicManifest(contextValue, "RSI Developer history context");
    developmentContext = {
      schemaVersion: expectedContext.schemaVersion,
      contextHash: expectedContext.canonicalHash,
      eventSequence: expectedContext.graphHead.eventSequence,
      eventManifestHash: expectedContext.graphHead.eventManifestHash,
      selectedVersionId: expectedContext.graphHead.selectedVersionId,
    };
    developmentPlan = exploration
      ? {
        schemaVersion: exploration.manifest.schemaVersion,
        explorationId: exploration.manifest.explorationId,
        manifestHash: exploration.manifest.canonicalHash,
        tagObjectId: exploration.tagObjectId,
        sourceVersionId: exploration.manifest.sourceVersion.versionId,
        baseVersionId: exploration.manifest.baseVersion.versionId,
        plannedVersionId: versionId,
        evaluationAnalysisHash:
          exploration.manifest.evaluationAnalysis.canonicalHash,
        planHash: exploration.manifest.nextOptimizationPlan.canonicalHash,
      }
      : epochResume
        ? {
        schemaVersion: epochResume!.manifest.schemaVersion,
        resumeId: epochResume!.manifest.resumeId,
        manifestHash: epochResume!.manifest.canonicalHash,
        tagObjectId: epochResume!.tagObjectId,
        terminalExplorationId:
          epochResume!.manifest.terminalStop.explorationId,
        baseVersionId: epochResume!.manifest.baseVersion.versionId,
        plannedVersionId: versionId,
        planHash: epochResume!.manifest.nextEpoch.planHash,
      }
        : {
        schemaVersion: retrospectiveIncumbent!.manifest.schemaVersion,
        adoptionId: retrospectiveIncumbent!.manifest.adoptionId,
        manifestHash: retrospectiveIncumbent!.manifest.canonicalHash,
        tagObjectId: retrospectiveIncumbent!.tagObjectId,
        baseVersionId:
          retrospectiveIncumbent!.manifest.incumbentVersion.versionId,
        plannedVersionId: versionId,
        planHash:
          retrospectiveIncumbent!.manifest.nextCandidate.planHash,
      };
  }
  const verification = await stableFile(input.verificationReceiptPath);
  const ref = versionRef(versionId);
  const manifest = withCanonicalHash({
    schemaVersion: RSI_CODE_VERSION_SCHEMA,
    versionId,
    tagRef: ref,
    sourceCommit: head.sourceCommit,
    sourceTree: head.sourceTree,
    parent: parent ? versionBinding(parent) : null,
    change: {
      summary: changeSummary,
      hypothesis,
    },
    verification: {
      receiptSha256: verification.sha256,
      receiptSize: verification.size,
    },
    developmentContext,
    ...(developmentPlan ? { developmentPlan } : {}),
    policies: {
      identity: "annotated_git_tag_exact_commit_v1" as const,
      topology: "single_parent_no_merge_between_versions_v1" as const,
      evaluation: "remote_version_tag_before_evaluation_v1" as const,
    },
  }) as RsiCodeVersionManifest;
  await assertSchema("rsi_code_version.schema.json", manifest, "RSI code version");
  const created = await createAnnotatedTag(
    repositoryRoot,
    ref,
    head.sourceCommit,
    manifest,
  );
  await publishGraphEvent(
    repositoryRoot,
    input.remote,
    graph,
    created,
    "version",
  );
  const verified = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  return byVersionId(verified, created.manifest.versionId);
}

export async function openRsiEvaluation(
  input: OpenRsiEvaluationInput,
): Promise<TaggedManifest<RsiEvaluationOpeningManifest>> {
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  const head = await inspectCleanHead(repositoryRoot);
  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  const version = byVersionId(graph, assertId(input.versionId, "version ID"));
  if (graph.incompleteEvaluationIds.length > 0
    || graph.unpublishedEvaluationIds.length > 0
    || graph.undecidedEvaluationIds.length > 0) {
    throw new Error(
      "a new RSI evaluation cannot open while a prior evaluation is incomplete, unpublished, or undecided",
    );
  }
  const priorEvaluationIds = new Set(
    graph.evaluationOpenings
      .filter((item) =>
        item.manifest.version.versionId === version.manifest.versionId)
      .map((item) => item.manifest.evaluationId),
  );
  if (graph.evaluationPublications.some((item) =>
    priorEvaluationIds.has(item.manifest.evaluationId)
      && (item.manifest.publicSummary.kind
          === "adaptive_protein_function"
        || isProspectiveFrozenReplayTerminal(
          item,
          graph.decisions.find((decision) =>
            decision.manifest.evaluation.evaluationId
              === item.manifest.evaluationId),
        )))
    || graph.decisions.some((item) =>
      priorEvaluationIds.has(item.manifest.evaluation.evaluationId)
        && item.manifest.action !== "continue")) {
    throw new Error(
      "an RSI version cannot be evaluated again after a terminal evaluation",
    );
  }
  if (graph.unresolvedVersionIds.length > 0
    && (graph.unresolvedVersionIds.length !== 1
      || graph.unresolvedVersionIds[0] !== version.manifest.versionId)) {
    throw new Error(
      "the next RSI evaluation must cover the sole unevaluated code version",
    );
  }
  if (graph.unresolvedVersionIds.length === 0
    && version.manifest.versionId !== graph.selectedVersionId) {
    throw new Error(
      "a repeat RSI evaluation must use the currently selected version",
    );
  }
  if (head.sourceCommit !== version.targetCommit) {
    throw new Error("evaluation must run from the exact frozen RSI code-version commit");
  }
  const evaluationId = assertId(input.evaluationId, "evaluation ID");
  if (graph.evaluationOpenings.some((item) =>
    item.manifest.evaluationId === evaluationId)
    || graph.evaluationResults.some((item) =>
      item.manifest.evaluationId === evaluationId)) {
    throw new Error(`RSI evaluation ID already exists: ${evaluationId}`);
  }
  const ref = evaluationOpeningRef(evaluationId);
  const manifest = withCanonicalHash({
    schemaVersion: RSI_CODE_EVALUATION_OPENING_SCHEMA,
    evaluationId,
    tagRef: ref,
    version: versionBinding(version),
    protocol: {
      protocolId: assertId(input.protocolId, "protocol ID"),
      protocolHash: assertHash(input.protocolHash, "protocol hash"),
    },
    state: "opened_before_private_evaluation" as const,
  }) as RsiEvaluationOpeningManifest;
  await assertSchema(
    "rsi_code_evaluation_opening.schema.json",
    manifest,
    "RSI evaluation opening",
  );
  const created = await createAnnotatedTag(
    repositoryRoot,
    ref,
    version.targetCommit,
    manifest,
  );
  await publishGraphEvent(
    repositoryRoot,
    input.remote,
    graph,
    created,
    "evaluation_opening",
  );
  const verified = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  return verified.evaluationOpenings.find(
    (item) => item.manifest.evaluationId === evaluationId,
  )!;
}

export async function requireOpenRsiEvaluation(
  input: OpenRsiEvaluationRequirement,
): Promise<{
  graph: RsiVersionGraph;
  version: TaggedManifest<RsiCodeVersionManifest>;
  opening: TaggedManifest<RsiEvaluationOpeningManifest>;
}> {
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  const head = await inspectCleanHead(repositoryRoot);
  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  const version = byVersionId(graph, assertId(input.versionId, "version ID"));
  const evaluationId = assertId(input.evaluationId, "evaluation ID");
  const opening = graph.evaluationOpenings.find(
    (item) => item.manifest.evaluationId === evaluationId,
  );
  if (!opening
    || !sameVersionBinding(opening.manifest.version, versionBinding(version))) {
    throw new Error("RSI evaluation opening does not bind the declared code version");
  }
  if ((input.protocolId !== undefined
    && opening.manifest.protocol.protocolId
      !== assertId(input.protocolId, "protocol ID"))
    || (input.protocolHash !== undefined
      && opening.manifest.protocol.protocolHash
        !== assertHash(input.protocolHash, "protocol hash"))) {
    throw new Error("RSI evaluation opening does not bind the expected protocol");
  }
  if (graph.evaluationResults.some((item) =>
    item.manifest.evaluationId === evaluationId)) {
    throw new Error("RSI evaluation is already complete and cannot be reopened");
  }
  if (head.sourceCommit !== version.targetCommit) {
    throw new Error("evaluation must run from the exact frozen RSI code-version commit");
  }
  return { graph, version, opening };
}

export async function openRsiEvaluationFromProtocolFile(
  input: Omit<OpenRsiEvaluationInput, "protocolHash"> & {
    protocolPath: string;
  },
): Promise<TaggedManifest<RsiEvaluationOpeningManifest>> {
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  const protocol = await stableFile(input.protocolPath);
  if (!isInsideOrEqual(protocol.path, repositoryRoot)) {
    throw new Error("RSI evaluation protocol file must be tracked inside the code version");
  }
  const protocolRelative = relative(repositoryRoot, protocol.path);
  if (!await gitSucceeds(repositoryRoot, [
    "ls-files",
    "--error-unmatch",
    "--",
    protocolRelative,
  ])) {
    throw new Error("RSI evaluation protocol file must be tracked by Git");
  }
  return await openRsiEvaluation({
    ...input,
    repositoryRoot,
    protocolHash: protocol.sha256,
  });
}

async function writeRsiEvaluationResult(
  input: WriteRsiEvaluationResultInput,
): Promise<TaggedManifest<RsiEvaluationResultManifest>> {
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  const head = await inspectCleanHead(repositoryRoot);
  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  const evaluationId = assertId(input.evaluationId, "evaluation ID");
  const opening = graph.evaluationOpenings.find(
    (item) => item.manifest.evaluationId === evaluationId,
  );
  if (!opening) throw new Error(`unknown RSI evaluation opening: ${evaluationId}`);
  if (graph.evaluationResults.some((item) =>
    item.manifest.evaluationId === evaluationId)) {
    throw new Error(`RSI evaluation already has an immutable result: ${evaluationId}`);
  }
  if (head.sourceCommit !== opening.targetCommit) {
    throw new Error("evaluation result must be recorded from the exact frozen version commit");
  }
  if ((input.resultKind === "adaptive_development")
    !== (input.stateRoot !== null)) {
    throw new Error(
      "an RSI result must bind a StateRoot if and only if it is adaptive development",
    );
  }
  if ((input.resultKind === "adaptive_development"
    && input.publicSummary.kind !== "adaptive_protein_function")
    || (input.resultKind !== "adaptive_development"
      && input.publicSummary.kind !== input.resultKind)) {
    throw new Error(
      "RSI result public summary kind does not match its result kind",
    );
  }
  assertPublicManifest(input.publicSummary, "RSI evaluation public summary");
  await assertEvaluationPublicSummarySchema(
    input.publicSummary,
    "RSI evaluation public summary",
  );
  const publicSummaryHash = hashCanonical(input.publicSummary);
  const resultArtifactHash = assertHash(
    input.resultArtifactHash,
    "result artifact hash",
  );
  const ref = evaluationResultRef(evaluationId);
  const manifest = withCanonicalHash({
    schemaVersion: RSI_CODE_EVALUATION_RESULT_SCHEMA,
    evaluationId,
    tagRef: ref,
    openingHash: opening.manifest.canonicalHash,
    version: opening.manifest.version,
    result: {
      kind: input.resultKind,
      artifactHash: resultArtifactHash,
      publicSummaryHash,
    },
    stateRoot: input.stateRoot
      ? structuredClone(input.stateRoot)
      : null,
    claimBoundary: assertText(input.claimBoundary, "claim boundary"),
    state: "completed" as const,
  }) as RsiEvaluationResultManifest;
  await assertSchema(
    "rsi_code_evaluation_result.schema.json",
    manifest,
    "RSI evaluation result",
  );
  const created = await createAnnotatedTag(
    repositoryRoot,
    ref,
    opening.targetCommit,
    manifest,
  );
  await publishGraphEvent(
    repositoryRoot,
    input.remote,
    graph,
    created,
    "evaluation_result",
  );
  const verified = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  return resultByEvaluationId(verified, evaluationId);
}

function parsePublicResultArtifact(
  bytes: Buffer,
  label: string,
): Record<string, unknown> {
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${label} must be an object`);
  }
  return document as Record<string, unknown>;
}

function frozenReplayRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function frozenReplayFiniteNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum) {
    throw new Error(
      `${label} must be a finite number between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function frozenReplayScopeFmax(
  value: unknown,
  label: string,
): number | null {
  const scope = frozenReplayRecord(value, label);
  exactRetrospectiveKeys(scope, [
    "evaluable",
    "proteinCount",
    "fmax",
    "threshold",
    "precision",
    "recall",
    "coverage",
  ], label);
  if (typeof scope.evaluable !== "boolean"
    || !Number.isInteger(scope.proteinCount)
    || (scope.proteinCount as number) < 0
    || (scope.proteinCount as number) > 100_000) {
    throw new Error(`${label} has an invalid evaluability binding`);
  }
  const metricFields = [
    "fmax",
    "threshold",
    "precision",
    "recall",
    "coverage",
  ] as const;
  if (!scope.evaluable) {
    if (metricFields.some((field) => scope[field] !== null)) {
      throw new Error(`${label} has metrics for a non-evaluable scope`);
    }
    return null;
  }
  if ((scope.proteinCount as number) < 1) {
    throw new Error(`${label} is evaluable without a protein`);
  }
  for (const field of metricFields) {
    frozenReplayFiniteNumber(scope[field], `${label}.${field}`, 0, 1);
  }
  return scope.fmax as number;
}

function frozenReplayEvaluationFmax(
  value: unknown,
  label: string,
): {
  overall: number | null;
  molecularFunction: number | null;
} {
  const evaluation = frozenReplayRecord(value, label);
  exactRetrospectiveKeys(evaluation, ["overall", "aspects"], label);
  const aspects = frozenReplayRecord(
    evaluation.aspects,
    `${label}.aspects`,
  );
  exactRetrospectiveKeys(aspects, [
    "molecular_function",
    "biological_process",
    "cellular_component",
  ], `${label}.aspects`);
  const overall = frozenReplayScopeFmax(
    evaluation.overall,
    `${label}.overall`,
  );
  const molecularFunction = frozenReplayScopeFmax(
    aspects.molecular_function,
    `${label}.aspects.molecular_function`,
  );
  frozenReplayScopeFmax(
    aspects.biological_process,
    `${label}.aspects.biological_process`,
  );
  frozenReplayScopeFmax(
    aspects.cellular_component,
    `${label}.aspects.cellular_component`,
  );
  return { overall, molecularFunction };
}

function sameFiniteDelta(
  baseline: number,
  candidate: number,
  delta: number,
): boolean {
  return Math.abs(candidate - baseline - delta) <= 1e-12;
}

function deriveProspectiveFrozenReplayPublicSummary(
  record: Record<string, unknown>,
  expected: {
    evaluationId: string;
    versionId: string;
    candidateCommit: string;
    claimBoundary: string;
    protocolId: string;
    protocolHash: string;
    openingHash: string;
    openingTagObjectId: string;
  },
): RsiFrozenReplayPublicSummary {
  const label = "prospective frozen-replay detailed receipt";
  if (record.schemaVersion !== RSI_Z55_FROZEN_REPLAY_RECEIPT_SCHEMA
    || record.suiteId !== RSI_Z55_FROZEN_REPLAY_SUITE_ID
    || record.suiteProfile !== "prospective20") {
    throw new Error(
      "frozen_replay requires the detailed prospective20 Z55 evaluator receipt",
    );
  }
  exactRetrospectiveKeys(record, [
    "schemaVersion",
    "suiteId",
    "suiteProfile",
    "openingHash",
    "finalistHash",
    "sourceCommit",
    "baselineBatchCanonicalHash",
    "prospectiveLiveReplayHash",
    "ontologySha256",
    "deepGoPlusMethodHash",
    "deepGoPlusPredictionSetHash",
    "componentPolicy",
    "diamondAudit",
    "exactTrainingMatchAudit",
    "nearExactTrainingMatchAudit",
    "random20PrivateEvidenceAudit",
    "prospective20PrivateEvidenceAudit",
    "prospectiveCandidateBinding",
    "rounds",
    "test",
    "all20Descriptive",
    "goldProjection",
    "finalVariant",
    "claimBoundary",
    "canonicalHash",
  ], label);
  if (typeof record.canonicalHash !== "string"
    || record.canonicalHash
      !== hashCanonical(withoutCanonicalHash(record))) {
    throw new Error("prospective frozen-replay receipt canonical hash is invalid");
  }
  assertPublicManifest(record, label);
  if (expected.protocolId !== RSI_Z55_FROZEN_REPLAY_PROTOCOL_ID) {
    throw new Error(
      `frozen_replay requires formal protocol ${RSI_Z55_FROZEN_REPLAY_PROTOCOL_ID}`,
    );
  }
  if (expected.protocolHash !== RSI_Z55_FROZEN_REPLAY_PROTOCOL_HASH) {
    throw new Error(
      "frozen_replay formal protocol hash does not match the tracked Z55 precommit",
    );
  }
  if (record.sourceCommit !== expected.candidateCommit) {
    throw new Error(
      "prospective frozen-replay receipt sourceCommit does not match the candidate version",
    );
  }
  assertOid(
    String(record.sourceCommit ?? ""),
    "prospective frozen-replay receipt sourceCommit",
  );
  if (record.claimBoundary !== expected.claimBoundary) {
    throw new Error(
      "prospective frozen-replay receipt claim boundary does not match its immutable result",
    );
  }
  const openingHash = assertHash(
    String(record.openingHash ?? ""),
    "prospective frozen-replay evaluator opening hash",
  );
  const finalistHash = assertHash(
    String(record.finalistHash ?? ""),
    "prospective frozen-replay finalist hash",
  );
  const baselineBatchCanonicalHash = assertHash(
    String(record.baselineBatchCanonicalHash ?? ""),
    "prospective frozen-replay baseline batch canonical hash",
  );
  const prospectiveLiveReplayHash = assertHash(
    String(record.prospectiveLiveReplayHash ?? ""),
    "prospective frozen-replay live replay hash",
  );
  const deepGoPlusPredictionSetHash = assertHash(
    String(record.deepGoPlusPredictionSetHash ?? ""),
    "prospective frozen-replay prediction-set hash",
  );
  if (deepGoPlusPredictionSetHash.length !== 64
    || record.componentPolicy
      !== "one_correlated_full_hybrid_prior_not_independent_cnn_diamond_votes"
    || record.random20PrivateEvidenceAudit !== null) {
    throw new Error(
      "prospective frozen-replay receipt has an invalid evaluator binding",
    );
  }
  for (const [field, fieldLabel] of [
    ["diamondAudit", "DIAMOND audit"],
    ["exactTrainingMatchAudit", "exact-match audit"],
    ["nearExactTrainingMatchAudit", "near-exact audit"],
    ["prospective20PrivateEvidenceAudit", "prospective20 private-evidence audit"],
    ["all20Descriptive", "all20 descriptive result"],
    ["goldProjection", "gold projection"],
  ] as const) {
    frozenReplayRecord(record[field], `${label} ${fieldLabel}`);
  }
  const prospective20PrivateEvidenceAudit = frozenReplayRecord(
    record.prospective20PrivateEvidenceAudit,
    `${label} prospective20 private-evidence audit`,
  );
  exactRetrospectiveKeys(prospective20PrivateEvidenceAudit, [
    "samplingReceiptHash",
    "homologyAuditHash",
    "excludedPriorSuiteCount",
    "excludedPriorIdentityCount",
    "matchedSourceRecordCount",
    "selectedPairCount",
    "sharedInterproPairCount",
    "pairsAtOrAboveKmerThreshold",
  ], `${label} prospective20 private-evidence audit`);
  assertHash(
    String(prospective20PrivateEvidenceAudit.samplingReceiptHash ?? ""),
    "prospective frozen-replay sampling receipt hash",
  );
  assertHash(
    String(prospective20PrivateEvidenceAudit.homologyAuditHash ?? ""),
    "prospective frozen-replay homology audit hash",
  );
  if (prospective20PrivateEvidenceAudit.excludedPriorSuiteCount !== 8
    || prospective20PrivateEvidenceAudit.excludedPriorIdentityCount !== 122
    || prospective20PrivateEvidenceAudit.matchedSourceRecordCount !== 122
    || prospective20PrivateEvidenceAudit.selectedPairCount !== 190
    || prospective20PrivateEvidenceAudit.sharedInterproPairCount !== 0
    || prospective20PrivateEvidenceAudit.pairsAtOrAboveKmerThreshold !== 0) {
    throw new Error(
      "prospective frozen-replay private-evidence audit is not the closed Z55 cohort",
    );
  }

  const binding = frozenReplayRecord(
    record.prospectiveCandidateBinding,
    `${label} candidate binding`,
  );
  exactRetrospectiveKeys(binding, [
    "candidatePrecommitPath",
    "candidatePrecommitCanonicalHash",
    "candidatePrecommitFileSha256",
    "candidateGenomePath",
    "candidateGenomeHash",
    "candidateGenomeFileSha256",
    "controlGenomePath",
    "controlGenomeHash",
    "controlGenomeFileSha256",
    "variantId",
    "methodHash",
    "ontologySha256",
    "rsiEvaluationOpening",
    "liveReplay",
    "baselineAcquisition",
  ], `${label} candidate binding`);
  const candidatePrecommitFileSha256 = assertHash(
    String(binding.candidatePrecommitFileSha256 ?? ""),
    "prospective frozen-replay tracked candidate-precommit hash",
  );
  const candidateGenomeHash = assertHash(
    String(binding.candidateGenomeHash ?? ""),
    "prospective frozen-replay candidate genome hash",
  );
  const controlGenomeHash = assertHash(
    String(binding.controlGenomeHash ?? ""),
    "prospective frozen-replay control genome hash",
  );
  const methodHash = assertHash(
    String(binding.methodHash ?? ""),
    "prospective frozen-replay method hash",
  );
  const ontologySha256 = assertHash(
    String(binding.ontologySha256 ?? ""),
    "prospective frozen-replay ontology hash",
  );
  if (binding.candidatePrecommitPath !== RSI_Z55_CANDIDATE_PRECOMMIT_PATH
    || binding.candidatePrecommitCanonicalHash
      !== RSI_Z55_CANDIDATE_PRECOMMIT_CANONICAL_HASH
    || candidatePrecommitFileSha256 !== expected.protocolHash
    || binding.candidateGenomePath !== RSI_Z55_CANDIDATE_GENOME_PATH
    || candidateGenomeHash !== RSI_Z55_CANDIDATE_GENOME_HASH
    || binding.candidateGenomeFileSha256
      !== RSI_Z55_CANDIDATE_GENOME_FILE_SHA256
    || binding.controlGenomePath !== RSI_Z55_CONTROL_GENOME_PATH
    || controlGenomeHash !== RSI_Z55_CONTROL_GENOME_HASH
    || binding.controlGenomeFileSha256
      !== RSI_Z55_CONTROL_GENOME_FILE_SHA256
    || binding.variantId !== RSI_Z55_CANDIDATE_VARIANT_ID
    || methodHash !== RSI_Z55_DEEPGOPLUS_METHOD_HASH
    || ontologySha256 !== RSI_Z55_ONTOLOGY_SHA256
    || record.deepGoPlusMethodHash !== methodHash
    || record.ontologySha256 !== ontologySha256) {
    throw new Error(
      "prospective frozen-replay candidate/control/method/ontology binding is invalid",
    );
  }
  const baselineAcquisition = frozenReplayRecord(
    binding.baselineAcquisition,
    `${label} baseline acquisition binding`,
  );
  exactRetrospectiveKeys(baselineAcquisition, [
    "schemaVersion",
    "suiteId",
    "publicManifestHash",
    "privateExclusionsHash",
    "genomeHash",
    "ontologySha256",
    "batchManifestHash",
    "planHash",
    "planFileSha256",
    "receiptHash",
    "receiptFileSha256",
    "sourceManifestHash",
    "sourceManifestFileSha256",
    "executionScope",
    "sourceKind",
    "acquisitionEpochId",
    "status",
    "caseCount",
    "completedCaseCount",
    "canonicalHash",
  ], `${label} baseline acquisition binding`);
  const acquisitionHashFields = [
    "publicManifestHash",
    "privateExclusionsHash",
    "genomeHash",
    "ontologySha256",
    "batchManifestHash",
    "planHash",
    "planFileSha256",
    "receiptHash",
    "receiptFileSha256",
    "sourceManifestHash",
    "sourceManifestFileSha256",
    "canonicalHash",
  ] as const;
  for (const field of acquisitionHashFields) {
    assertHash(
      String(baselineAcquisition[field] ?? ""),
      `prospective frozen-replay baseline acquisition ${field}`,
    );
  }
  if (baselineAcquisition.schemaVersion
      !== RSI_Z55_BASELINE_ACQUISITION_SCHEMA
    || baselineAcquisition.suiteId !== RSI_Z55_FROZEN_REPLAY_SUITE_ID
    || baselineAcquisition.genomeHash !== controlGenomeHash
    || baselineAcquisition.ontologySha256 !== ontologySha256
    || baselineAcquisition.batchManifestHash
      !== baselineBatchCanonicalHash
    || !((baselineAcquisition.executionScope === "portable_remote"
        && baselineAcquisition.sourceKind === "remote_exact_cache")
      || (baselineAcquisition.executionScope
          === "developer_local_snapshot"
        && baselineAcquisition.sourceKind
          === "local_content_snapshot"))
    || baselineAcquisition.status !== "completed"
    || baselineAcquisition.caseCount !== 20
    || baselineAcquisition.completedCaseCount !== 20
    || baselineAcquisition.canonicalHash
      !== hashCanonical(withoutCanonicalHash(baselineAcquisition))) {
    throw new Error(
      "prospective frozen-replay baseline acquisition binding is invalid",
    );
  }
  if (typeof baselineAcquisition.acquisitionEpochId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(
      baselineAcquisition.acquisitionEpochId,
    )) {
    throw new Error(
      "prospective frozen-replay acquisition epoch ID is invalid",
    );
  }
  const baselineAcquisitionCanonicalHash =
    baselineAcquisition.canonicalHash as string;
  const rsiEvaluationOpening = frozenReplayRecord(
    binding.rsiEvaluationOpening,
    `${label} formal RSI opening binding`,
  );
  exactRetrospectiveKeys(rsiEvaluationOpening, [
    "versionId",
    "evaluationId",
    "protocolId",
    "protocolHash",
    "openingHash",
    "openingTagObjectId",
    "sourceCommit",
  ], `${label} formal RSI opening binding`);
  if (rsiEvaluationOpening.versionId !== expected.versionId
    || rsiEvaluationOpening.evaluationId !== expected.evaluationId
    || rsiEvaluationOpening.protocolId !== expected.protocolId
    || rsiEvaluationOpening.protocolHash !== expected.protocolHash
    || rsiEvaluationOpening.openingHash !== expected.openingHash
    || rsiEvaluationOpening.openingTagObjectId
      !== expected.openingTagObjectId
    || rsiEvaluationOpening.sourceCommit !== expected.candidateCommit) {
    throw new Error(
      "prospective frozen-replay receipt does not bind the exact formal RSI opening",
    );
  }
  assertHash(
    String(rsiEvaluationOpening.openingHash ?? ""),
    "prospective frozen-replay formal opening hash",
  );
  assertOid(
    String(rsiEvaluationOpening.openingTagObjectId ?? ""),
    "prospective frozen-replay formal opening tag object",
  );
  const liveReplay = frozenReplayRecord(
    binding.liveReplay,
    `${label} live replay binding`,
  );
  exactRetrospectiveKeys(liveReplay, [
    "canonicalHash",
    "baselineBatchHash",
    "controlPredictionHash",
    "candidatePredictionHash",
  ], `${label} live replay binding`);
  const liveReplayCanonicalHash = assertHash(
    String(liveReplay.canonicalHash ?? ""),
    "prospective frozen-replay live replay canonical hash",
  );
  const liveReplayBaselineBatchHash = assertHash(
    String(liveReplay.baselineBatchHash ?? ""),
    "prospective frozen-replay live replay baseline batch hash",
  );
  const controlPredictionHash = assertHash(
    String(liveReplay.controlPredictionHash ?? ""),
    "prospective frozen-replay control prediction hash",
  );
  const candidatePredictionHash = assertHash(
    String(liveReplay.candidatePredictionHash ?? ""),
    "prospective frozen-replay candidate prediction hash",
  );
  if (record.prospectiveLiveReplayHash !== liveReplayCanonicalHash
    || record.baselineBatchCanonicalHash !== liveReplayBaselineBatchHash) {
    throw new Error(
      "prospective frozen-replay live replay/baseline batch binding is invalid",
    );
  }

  if (!Array.isArray(record.rounds) || record.rounds.length !== 3) {
    throw new Error(
      "prospective frozen-replay receipt requires exactly three evaluator rounds",
    );
  }
  const development = frozenReplayRecord(record.rounds[0], `${label} round 1`);
  exactRetrospectiveKeys(development, [
    "round",
    "role",
    "hypothesis",
    "familyBest",
  ], `${label} round 1`);
  if (development.round !== 1
    || development.role !== "development"
    || typeof development.hypothesis !== "string"
    || development.hypothesis.length < 1
    || !Array.isArray(development.familyBest)
    || development.familyBest.length !== 2) {
    throw new Error("prospective frozen-replay development round is invalid");
  }
  const expectedDevelopmentFamilies = [{
    family: "g0_standalone_full_hybrid",
    variantId: "g0_standalone_full_hybrid",
  }, {
    family: "g3_consensus_rerank",
    variantId: RSI_Z55_CANDIDATE_VARIANT_ID,
  }] as const;
  for (const [index, expectedFamily] of
    expectedDevelopmentFamilies.entries()) {
    const item = frozenReplayRecord(
      development.familyBest[index],
      `${label} round 1 family ${index + 1}`,
    );
    exactRetrospectiveKeys(item, [
      "family",
      "variantId",
      "evaluation",
    ], `${label} round 1 family ${index + 1}`);
    if (item.family !== expectedFamily.family
      || item.variantId !== expectedFamily.variantId) {
      throw new Error(
        "prospective frozen-replay development round does not report the closed controls and candidate",
      );
    }
    frozenReplayEvaluationFmax(
      item.evaluation,
      `${label} round 1 family ${index + 1} evaluation`,
    );
  }

  const calibration = frozenReplayRecord(record.rounds[1], `${label} round 2`);
  exactRetrospectiveKeys(calibration, [
    "round",
    "role",
    "hypothesis",
    "winner",
    "maximumPopulatedAspectDrop",
    "baseline",
    "candidate",
  ], `${label} round 2`);
  if (calibration.round !== 2
    || calibration.role !== "development_plus_calibration"
    || calibration.winner !== RSI_Z55_CANDIDATE_VARIANT_ID
    || typeof calibration.hypothesis !== "string"
    || calibration.hypothesis.length < 1) {
    throw new Error(
      "prospective frozen-replay calibration round does not bind the precommitted candidate",
    );
  }
  frozenReplayFiniteNumber(
    calibration.maximumPopulatedAspectDrop,
    `${label} round 2 maximum aspect drop`,
    0,
    1,
  );
  frozenReplayEvaluationFmax(calibration.baseline, `${label} round 2 baseline`);
  frozenReplayEvaluationFmax(calibration.candidate, `${label} round 2 candidate`);

  const selection = frozenReplayRecord(record.rounds[2], `${label} round 3`);
  exactRetrospectiveKeys(selection, [
    "round",
    "role",
    "hypothesis",
    "decision",
    "baseline",
    "candidate",
    "overallFmaxGain",
    "molecularFunctionFmaxGain",
    "maximumPopulatedAspectDrop",
    "nonTargetPredictionsUnchanged",
    "queryLikePredictionsUnchanged",
  ], `${label} round 3`);
  if (selection.round !== 3
    || selection.role !== "selection"
    || typeof selection.hypothesis !== "string"
    || selection.hypothesis.length < 1
    || (selection.decision !== "promote_candidate"
      && selection.decision !== "retain_baseline")
    || typeof selection.nonTargetPredictionsUnchanged !== "boolean"
    || typeof selection.queryLikePredictionsUnchanged !== "boolean") {
    throw new Error("prospective frozen-replay selection round is invalid");
  }
  const selectionBaseline = frozenReplayEvaluationFmax(
    selection.baseline,
    `${label} selection baseline`,
  );
  const selectionCandidate = frozenReplayEvaluationFmax(
    selection.candidate,
    `${label} selection candidate`,
  );
  if (selectionBaseline.overall === null
    || selectionCandidate.overall === null) {
    throw new Error(
      "prospective frozen-replay selection result is not evaluable",
    );
  }
  const overallFmaxGain = frozenReplayFiniteNumber(
    selection.overallFmaxGain,
    `${label} selection overall Fmax gain`,
    -1,
    1,
  );
  if (!sameFiniteDelta(
    selectionBaseline.overall,
    selectionCandidate.overall,
    overallFmaxGain,
  )) {
    throw new Error(
      "prospective frozen-replay selection overall gain is incoherent",
    );
  }
  let molecularFunctionFmaxGain: number | null = null;
  if (selection.molecularFunctionFmaxGain !== null) {
    molecularFunctionFmaxGain = frozenReplayFiniteNumber(
      selection.molecularFunctionFmaxGain,
      `${label} selection MF Fmax gain`,
      -1,
      1,
    );
  }
  if ((selectionBaseline.molecularFunction === null
      || selectionCandidate.molecularFunction === null)
    !== (molecularFunctionFmaxGain === null)
    || (molecularFunctionFmaxGain !== null
      && !sameFiniteDelta(
        selectionBaseline.molecularFunction!,
        selectionCandidate.molecularFunction!,
        molecularFunctionFmaxGain,
      ))) {
    throw new Error(
      "prospective frozen-replay selection MF gain is incoherent",
    );
  }
  const maximumPopulatedAspectDrop = frozenReplayFiniteNumber(
    selection.maximumPopulatedAspectDrop,
    `${label} selection maximum aspect drop`,
    0,
    1,
  );
  const nonTargetPredictionsUnchanged =
    selection.nonTargetPredictionsUnchanged as boolean;
  const queryLikePredictionsUnchanged =
    selection.queryLikePredictionsUnchanged as boolean;
  const selectionPassed = overallFmaxGain > 0
    && molecularFunctionFmaxGain !== null
    && molecularFunctionFmaxGain > 0
    && nonTargetPredictionsUnchanged
    && queryLikePredictionsUnchanged;
  const selectionDecision =
    selection.decision as "promote_candidate" | "retain_baseline";
  if (selectionDecision
      !== (selectionPassed ? "promote_candidate" : "retain_baseline")) {
    throw new Error(
      "prospective frozen-replay finalist/selection decision is incoherent",
    );
  }

  const finalVariant = frozenReplayRecord(
    record.finalVariant,
    `${label} final variant`,
  );
  exactRetrospectiveKeys(finalVariant, [
    "variantId",
    "family",
    "scale",
    "floor",
    "topK",
    "aspects",
    "predictionHash",
  ], `${label} final variant`);
  const selectedVariantId = selectionPassed
    ? RSI_Z55_CANDIDATE_VARIANT_ID
    : "agent_baseline" as const;
  const selectedPredictionHash = assertHash(
    String(finalVariant.predictionHash ?? ""),
    "prospective frozen-replay finalist prediction hash",
  );
  const candidateVariantSelected =
    finalVariant.variantId === RSI_Z55_CANDIDATE_VARIANT_ID
    && finalVariant.family === "g3_consensus_rerank"
    && finalVariant.scale === 1
    && finalVariant.floor === 0.35
    && finalVariant.topK === 10
    && canonicalJson(finalVariant.aspects)
      === canonicalJson(["molecular_function"]);
  const baselineSelected =
    finalVariant.variantId === "agent_baseline"
    && finalVariant.family === "baseline"
    && finalVariant.scale === 0
    && finalVariant.floor === null
    && finalVariant.topK === null
    && canonicalJson(finalVariant.aspects) === canonicalJson([]);
  if ((selectionPassed && !candidateVariantSelected)
    || (!selectionPassed && !baselineSelected)
    || selectedPredictionHash
      !== (selectionPassed
        ? candidatePredictionHash
        : controlPredictionHash)) {
    throw new Error(
      "prospective frozen-replay final variant contradicts its selection decision",
    );
  }
  const expectedFinalistHash = hashCanonical({
    schemaVersion: "pi-deepgoplus-hybrid-rsi-finalist.v1",
    openingHash,
    selectedVariantId,
    selectedPredictionHash,
    selectionDecision,
    selectionGain: overallFmaxGain,
    selectionMfGain: molecularFunctionFmaxGain,
    maximumPopulatedAspectDrop,
    nonTargetPredictionsUnchanged,
    queryLikePredictionsUnchanged,
  });
  if (finalistHash !== expectedFinalistHash) {
    throw new Error(
      "prospective frozen-replay finalist hash is not reproducible from the selection round",
    );
  }

  const test = frozenReplayRecord(record.test, `${label} test result`);
  exactRetrospectiveKeys(test, [
    "baseline",
    "finalist",
    "overallFmaxGain",
  ], `${label} test result`);
  const testBaseline = frozenReplayEvaluationFmax(
    test.baseline,
    `${label} test baseline`,
  );
  const testFinalist = frozenReplayEvaluationFmax(
    test.finalist,
    `${label} test finalist`,
  );
  const testOverallFmaxGain = frozenReplayFiniteNumber(
    test.overallFmaxGain,
    `${label} test overall Fmax gain`,
    -1,
    1,
  );
  if (testBaseline.overall === null
    || testFinalist.overall === null
    || !sameFiniteDelta(
      testBaseline.overall,
      testFinalist.overall,
      testOverallFmaxGain,
    )) {
    throw new Error(
      "prospective frozen-replay test result is absent or incoherent",
    );
  }

  const checks: RsiFrozenReplayPublicSummary["checks"] = [
    {
      checkId: RSI_Z55_FROZEN_REPLAY_CHECK_IDS[0],
      status: overallFmaxGain > 0 ? "passed" : "failed",
    },
    {
      checkId: RSI_Z55_FROZEN_REPLAY_CHECK_IDS[1],
      status: molecularFunctionFmaxGain !== null
          && molecularFunctionFmaxGain > 0
        ? "passed"
        : "failed",
    },
    {
      checkId: RSI_Z55_FROZEN_REPLAY_CHECK_IDS[2],
      status: nonTargetPredictionsUnchanged ? "passed" : "failed",
    },
    {
      checkId: RSI_Z55_FROZEN_REPLAY_CHECK_IDS[3],
      status: queryLikePredictionsUnchanged ? "passed" : "failed",
    },
    {
      checkId: RSI_Z55_FROZEN_REPLAY_CHECK_IDS[4],
      status: "passed",
    },
    {
      checkId: RSI_Z55_FROZEN_REPLAY_CHECK_IDS[5],
      status: "passed",
    },
  ];
  const passedCount = checks.filter((check) => check.status === "passed").length;
  const failedCount = checks.length - passedCount;
  return {
    kind: "frozen_replay",
    summary:
      `Hash-verified prospective Z55 frozen replay: `
      + `${passedCount} closed checks passed and ${failedCount} failed.`,
    artifactClaimBoundary: expected.claimBoundary,
    checks,
    evidenceBinding: {
      receiptSchemaVersion: RSI_Z55_FROZEN_REPLAY_RECEIPT_SCHEMA,
      receiptCanonicalHash: record.canonicalHash,
      protocolId: RSI_Z55_FROZEN_REPLAY_PROTOCOL_ID,
      protocolHash: candidatePrecommitFileSha256,
      formalOpeningHash: expected.openingHash,
      formalOpeningTagObjectId: expected.openingTagObjectId,
      finalistHash,
      baselineBatchCanonicalHash,
      baselineAcquisitionCanonicalHash,
      baselineAcquisition:
        structuredClone(baselineAcquisition) as
          RsiFrozenReplayBaselineAcquisitionBinding,
      prospective20PrivateEvidenceAudit:
        structuredClone(prospective20PrivateEvidenceAudit) as
          RsiFrozenReplayPrivateEvidenceAudit,
      liveReplayCanonicalHash: prospectiveLiveReplayHash,
      controlPredictionHash,
      candidatePredictionHash,
      selectionDecision,
      selectedVariantId,
      candidateVariantId: RSI_Z55_CANDIDATE_VARIANT_ID,
      candidateGenomeHash,
      controlGenomeHash,
      deepGoPlusMethodHash: methodHash,
      ontologySha256,
    },
    teacher: null,
  };
}

function deriveGenericPublicSummary(
  record: Record<string, unknown>,
  expected: {
    evaluationId: string;
    versionId: string;
    candidateCommit: string;
    resultKind: Exclude<RsiEvaluationResultKind, "adaptive_development">;
    claimBoundary: string;
    protocolId: string;
    protocolHash: string;
    openingHash: string;
    openingTagObjectId: string;
  },
  publicationMode: "prospective" | "retrospective_legacy",
): RsiNonAdaptivePublicSummary {
  if (expected.resultKind === "frozen_replay") {
    if (publicationMode !== "prospective") {
      throw new Error(
        "frozen_replay is only valid as a prospective detailed Z55 receipt",
      );
    }
    return deriveProspectiveFrozenReplayPublicSummary(record, expected);
  }
  assertPublicManifest(record, "non-adaptive result artifact");
  const prospective = publicationMode === "prospective";
  if (prospective) {
    const expectedKeys = new Set([
      "schemaVersion",
      "evaluationId",
      "candidateCommit",
      "resultKind",
      "claimBoundary",
      "checks",
      "outcome",
    ]);
    if (record.schemaVersion !== "pi-rsi-generic-public-result.v1"
      || Object.keys(record).length !== expectedKeys.size
      || Object.keys(record).some((key) => !expectedKeys.has(key))) {
      throw new Error(
        "prospective non-adaptive result artifact must use the closed pi-rsi-generic-public-result.v1 contract",
      );
    }
  } else if (typeof record.schemaVersion !== "string"
    || record.schemaVersion.trim() !== record.schemaVersion
    || record.schemaVersion.length < 1
    || record.schemaVersion.length > 128) {
    throw new Error(
      "retrospective non-adaptive result artifact requires a bounded schemaVersion",
    );
  }
  if (record.evaluationId !== expected.evaluationId) {
    throw new Error(
      "non-adaptive result artifact evaluationId does not match its immutable opening",
    );
  }
  if (record.candidateCommit !== expected.candidateCommit) {
    throw new Error(
      "non-adaptive result artifact candidateCommit does not match its immutable code version",
    );
  }
  if ((prospective || record.resultKind !== undefined)
    && record.resultKind !== expected.resultKind) {
    throw new Error(
      "non-adaptive result artifact resultKind does not match its declared result",
    );
  }
  const artifactClaimBoundary = assertText(
    String(record.claimBoundary ?? ""),
    "non-adaptive result artifact claim boundary",
  );
  if (prospective && artifactClaimBoundary !== expected.claimBoundary) {
    throw new Error(
      "non-adaptive result artifact claim boundary does not match its immutable result",
    );
  }
  if (!Array.isArray(record.checks)) {
    throw new Error(
      "non-adaptive result artifact requires a public checks array",
    );
  }
  const checkIds = new Set<string>();
  const checks: RsiNonAdaptivePublicSummary["checks"] = [];
  for (const [index, check] of record.checks.entries()) {
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      throw new Error(`non-adaptive result check ${index} is invalid`);
    }
    const value = check as Record<string, unknown>;
    if (prospective
      && (Object.keys(value).length !== 2
        || !Object.hasOwn(value, "checkId")
        || !Object.hasOwn(value, "status"))) {
      throw new Error(
        `prospective non-adaptive result check ${index} must use the closed check contract`,
      );
    }
    if (value.status !== "passed"
      && value.status !== "failed"
      && value.status !== "not_applicable") {
      throw new Error(
        `non-adaptive result check ${index} has an unsupported status`,
      );
    }
    const checkId = assertId(
      String(value.checkId ?? ""),
      `non-adaptive result check ${index} ID`,
    );
    if (checkIds.has(checkId)) {
      throw new Error("non-adaptive result artifact repeats a public check ID");
    }
    checkIds.add(checkId);
    checks.push({
      checkId,
      status: value.status,
    });
  }
  const passed = checks.filter((item) => item.status === "passed").length;
  const failed = checks.filter((item) => item.status === "failed").length;
  const notApplicable = checks.length - passed - failed;
  if (passed < 1) {
    throw new Error(
      "non-adaptive result artifact requires at least one executed passing check",
    );
  }
  if ((prospective || record.outcome !== undefined)
    && record.outcome !== (failed === 0 ? "passed" : "failed")) {
    throw new Error(
      "non-adaptive result artifact outcome contradicts its public checks",
    );
  }
  return {
    kind: "software_verification",
    summary:
      `Hash-verified ${expected.resultKind} artifact: `
      + `${passed} passed, ${failed} failed, and `
      + `${notApplicable} not applicable.`,
    artifactClaimBoundary,
    checks,
    teacher: null,
  };
}

export async function completeRsiEvaluationFromResultFile(
  input: Omit<CompleteRsiEvaluationInput, "resultArtifactHash"> & {
    resultPath: string;
  },
): Promise<TaggedManifest<RsiEvaluationResultManifest>> {
  const result = await stableFile(input.resultPath);
  if (input.resultKind !== "adaptive_development" && input.stateRoot) {
    throw new Error(
      "non-adaptive RSI results must not bind an adaptive StateRoot",
    );
  }
  if (input.resultKind === "adaptive_development") {
    const document = parsePublicResultArtifact(
      result.bytes,
      "adaptive result artifact",
    );
    await assertSchema(
      "outer_adaptive_outcome.schema.json",
      document,
      "adaptive result artifact",
      false,
    );
    const adaptiveOutcome = document as {
      canonicalHash: string;
      claimBoundary: string;
    };
    if (adaptiveOutcome.claimBoundary !== input.claimBoundary) {
      throw new Error(
        "adaptive completion claim boundary does not match the hash-verified outcome",
      );
    }
    return await completeRsiEvaluation({
      ...input,
      resultArtifactHash: adaptiveOutcome.canonicalHash,
    });
  }
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  const evaluationId = assertId(input.evaluationId, "evaluation ID");
  const opening = graph.evaluationOpenings.find(
    (item) => item.manifest.evaluationId === evaluationId,
  );
  if (!opening) {
    throw new Error(`unknown RSI evaluation opening: ${evaluationId}`);
  }
  const publicSummary = deriveGenericPublicSummary(
    parsePublicResultArtifact(result.bytes, "non-adaptive result artifact"),
    {
      evaluationId,
      versionId: opening.manifest.version.versionId,
      candidateCommit: opening.manifest.version.sourceCommit,
      resultKind: input.resultKind,
      claimBoundary: input.claimBoundary,
      protocolId: opening.manifest.protocol.protocolId,
      protocolHash: opening.manifest.protocol.protocolHash,
      openingHash: opening.manifest.canonicalHash,
      openingTagObjectId: opening.tagObjectId,
    },
    "prospective",
  );
  return await writeRsiEvaluationResult({
    ...input,
    repositoryRoot,
    resultArtifactHash: result.sha256,
    stateRoot: null,
    publicSummary,
  });
}

async function publishRsiEvaluation(
  input: PublishRsiEvaluationInput,
): Promise<TaggedManifest<RsiEvaluationPublicationManifest>> {
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  await inspectCleanHead(repositoryRoot);
  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  const evaluationId = assertId(input.evaluationId, "evaluation ID");
  if (graph.evaluationPublications.some((item) =>
    item.manifest.evaluationId === evaluationId)) {
    throw new Error(
      `RSI evaluation already has an immutable public record: ${evaluationId}`,
    );
  }
  const opening = graph.evaluationOpenings.find(
    (item) => item.manifest.evaluationId === evaluationId,
  );
  const result = graph.evaluationResults.find(
    (item) => item.manifest.evaluationId === evaluationId,
  );
  if (!opening || !result) {
    throw new Error(
      "RSI evaluation publication requires an exact completed opening and result",
    );
  }
  const priorDecision = graph.decisions.find(
    (item) => item.manifest.evaluation.evaluationId === evaluationId,
  );
  if (input.publicationMode === "prospective" && priorDecision) {
    throw new Error(
      "prospective RSI evaluation publication must be recorded before its decision",
    );
  }
  if (input.publicationMode === "retrospective_legacy" && !priorDecision) {
    throw new Error(
      "retrospective legacy publication requires an already recorded decision",
    );
  }
  if (input.publicationMode === "retrospective_legacy"
    && !isExactGrandfatheredLegacyBaseline(
      graph.versions.find((item) =>
        item.manifest.versionId === result.manifest.version.versionId),
      opening,
      result,
      priorDecision,
    )) {
    throw new Error(
      "retrospective legacy publication is restricted to the exact pre-contract v0001 software baseline",
    );
  }
  if (input.claimBoundary !== result.manifest.claimBoundary) {
    throw new Error(
      "RSI evaluation publication claim boundary must exactly match its result",
    );
  }
  if ((result.manifest.result.kind === "adaptive_development"
    && input.publicSummary.kind !== "adaptive_protein_function")
    || (result.manifest.result.kind !== "adaptive_development"
      && input.publicSummary.kind !== result.manifest.result.kind)) {
    throw new Error(
      "RSI evaluation publication summary kind does not match its result",
    );
  }
  assertPublicManifest(input.publicSummary, "RSI evaluation public summary");
  const publicSummaryHash = hashCanonical(input.publicSummary);
  if (result.manifest.result.publicSummaryHash !== undefined) {
    if (result.manifest.result.publicSummaryHash !== publicSummaryHash) {
      throw new Error(
        "RSI evaluation publication does not match the public summary committed by its immutable result",
      );
    }
  } else if (input.publicationMode !== "retrospective_legacy"
    || !isExactGrandfatheredLegacyBaseline(
      graph.versions.find((item) =>
        item.manifest.versionId === result.manifest.version.versionId),
      opening,
      result,
      priorDecision,
    )) {
    throw new Error(
      "only the exact v0001 legacy migration may publish a result without a public summary hash",
    );
  }
  const ref = evaluationPublicationRef(evaluationId);
  const manifest = withCanonicalHash({
    schemaVersion: RSI_CODE_EVALUATION_PUBLICATION_SCHEMA,
    evaluationId,
    tagRef: ref,
    version: result.manifest.version,
    opening: {
      manifestHash: opening.manifest.canonicalHash,
      tagObjectId: opening.tagObjectId,
      protocolId: opening.manifest.protocol.protocolId,
      protocolHash: opening.manifest.protocol.protocolHash,
    },
    result: {
      manifestHash: result.manifest.canonicalHash,
      tagObjectId: result.tagObjectId,
      kind: result.manifest.result.kind,
      artifactHash: result.manifest.result.artifactHash,
      stateRootPublicManifestHash:
        result.manifest.stateRoot?.publicManifestHash ?? null,
    },
    publicationMode: input.publicationMode,
    publicSummary: structuredClone(input.publicSummary),
    claimBoundary: assertText(input.claimBoundary, "claim boundary"),
  }) as RsiEvaluationPublicationManifest;
  if (input.publicationMode === "retrospective_legacy"
    && manifest.canonicalHash !== LEGACY_PUBLICATION_MANIFEST_HASH) {
    throw new Error(
      "retrospective legacy publication content does not match the exact audited v0001 migration",
    );
  }
  await assertSchema(
    "rsi_code_evaluation_publication.schema.json",
    manifest,
    "RSI evaluation publication",
  );
  const created = await createAnnotatedTag(
    repositoryRoot,
    ref,
    result.targetCommit,
    manifest,
  );
  await publishGraphEvent(
    repositoryRoot,
    input.remote,
    graph,
    created,
    "evaluation_publication",
  );
  const verified = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  return verified.evaluationPublications.find(
    (item) => item.manifest.evaluationId === evaluationId,
  )!;
}

export async function publishRsiEvaluationFromResultFile(
  input: Omit<PublishRsiEvaluationInput, "publicSummary"> & {
    resultPath: string;
  },
): Promise<TaggedManifest<RsiEvaluationPublicationManifest>> {
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  const result = resultByEvaluationId(
    graph,
    assertId(input.evaluationId, "evaluation ID"),
  );
  const opening = graph.evaluationOpenings.find(
    (item) => item.manifest.evaluationId === result.manifest.evaluationId,
  );
  if (!opening) {
    throw new Error(
      "non-adaptive publication has no immutable evaluation opening",
    );
  }
  if (result.manifest.result.kind === "adaptive_development") {
    throw new Error(
      "adaptive public summaries must be derived from a verified StateRoot",
    );
  }
  const artifact = await stableFile(input.resultPath);
  if (artifact.sha256 !== result.manifest.result.artifactHash) {
    throw new Error(
      "non-adaptive public summary source does not match the immutable result artifact hash",
    );
  }
  const publicSummary = deriveGenericPublicSummary(
    parsePublicResultArtifact(
      artifact.bytes,
      "non-adaptive RSI result artifact",
    ),
    {
      evaluationId: result.manifest.evaluationId,
      versionId: opening.manifest.version.versionId,
      candidateCommit: result.manifest.version.sourceCommit,
      resultKind: result.manifest.result.kind,
      claimBoundary: result.manifest.claimBoundary,
      protocolId: opening.manifest.protocol.protocolId,
      protocolHash: opening.manifest.protocol.protocolHash,
      openingHash: opening.manifest.canonicalHash,
      openingTagObjectId: opening.tagObjectId,
    },
    input.publicationMode,
  );
  return await publishRsiEvaluation({
    ...input,
    repositoryRoot,
    publicSummary: publicSummary as RsiEvaluationPublicSummary,
  });
}

async function readArchivedJson(
  path: string,
  schemaFilename: string,
  label: string,
): Promise<Record<string, unknown>> {
  const file = await stableFile(path);
  let value: unknown;
  try {
    value = JSON.parse(file.bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  await assertSchema(schemaFilename, value, label);
  return value as Record<string, unknown>;
}

async function deriveRsiAdaptivePublicSummaryFromStateRoot(
  input: {
    graph: RsiVersionGraph;
    opening: TaggedManifest<RsiEvaluationOpeningManifest>;
    resultArtifactHash: string;
    claimBoundary: string;
    stateRootArchiveDir: string;
    expectedStateRoot?: NonNullable<
      RsiEvaluationResultManifest["stateRoot"]
    >;
  },
): Promise<{
  publicSummary: RsiAdaptivePublicSummary;
  stateRoot: NonNullable<RsiEvaluationResultManifest["stateRoot"]>;
}> {
  const graph = input.graph;
  const opening = input.opening;
  const {
    verifyAdaptiveStateArchive,
  } = await import("../adaptive/state_archive.js");
  const initial = await verifyAdaptiveStateArchive(
    resolve(input.stateRootArchiveDir),
  );
  const snapshotParent = await mkdtemp(
    join(tmpdir(), "pi-rsi-state-snapshot-"),
  );
  try {
    const snapshot = join(snapshotParent, "archive");
    await cp(initial.archiveDir, snapshot, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const verified = await verifyAdaptiveStateArchive(snapshot);
    if (verified.sourceCommit !== initial.sourceCommit
      || verified.publicManifestHash !== initial.publicManifestHash
      || verified.archiveSealHash !== initial.archiveSealHash
      || verified.headOutcomeHash !== initial.headOutcomeHash) {
      throw new Error(
        "adaptive StateRoot changed while its immutable snapshot was created",
      );
    }
    const stateRoot = {
      archiveSealHash: verified.archiveSealHash,
      publicManifestHash: verified.publicManifestHash,
    };
    if (input.expectedStateRoot
      && canonicalJson(input.expectedStateRoot)
        !== canonicalJson(stateRoot)) {
      throw new Error(
        "verified StateRoot does not match the immutable RSI result binding",
      );
    }
    if (verified.sourceCommit !== opening.manifest.version.sourceCommit
      || verified.headOutcomeHash !== input.resultArtifactHash) {
      throw new Error(
        "verified StateRoot does not match the exact RSI adaptive result",
      );
    }
    const result = {
      manifest: {
        evaluationId: opening.manifest.evaluationId,
        version: opening.manifest.version,
        result: {
          kind: "adaptive_development" as const,
          artifactHash: input.resultArtifactHash,
        },
        stateRoot,
        claimBoundary: input.claimBoundary,
      },
    };
  if (verified.sourceCommit !== result.manifest.version.sourceCommit
    || verified.publicManifestHash
      !== result.manifest.stateRoot.publicManifestHash
    || verified.archiveSealHash !== result.manifest.stateRoot.archiveSealHash
    || verified.headOutcomeHash !== result.manifest.result.artifactHash) {
    throw new Error(
      "verified StateRoot does not match the exact RSI adaptive result",
    );
  }
  const stateDir = join(
    verified.archiveDir,
    "developer",
    "state",
    "adaptive30",
  );
  const objective = await readArchivedJson(
    join(stateDir, "objective.json"),
    "outer_adaptive_objective.schema.json",
    "archived adaptive objective",
  );
  const index = await readArchivedJson(
    join(stateDir, "index.json"),
    "outer_adaptive_index.schema.json",
    "archived adaptive index",
  ) as {
    rounds: Array<{ round: number }>;
  } & Record<string, unknown>;
  const round = index.rounds.at(-1)?.round;
  if (!Number.isSafeInteger(round) || !verified.completedRounds.includes(round!)) {
    throw new Error("verified StateRoot has no canonical head adaptive round");
  }
  const roundBinding = await readArchivedJson(
    join(stateDir, `round-${round}-binding.json`),
    "outer_adaptive_bundle_binding.schema.json",
    "archived adaptive round binding",
  );
  const expectedRsiEvaluation = {
    versionId: result.manifest.version.versionId,
    sourceCommit: result.manifest.version.sourceCommit,
    versionTagObjectId: result.manifest.version.tagObjectId,
    evaluationId: result.manifest.evaluationId,
    openingHash: opening.manifest.canonicalHash,
    openingTagObjectId: opening.tagObjectId,
    protocolId: opening.manifest.protocol.protocolId,
    protocolHash: opening.manifest.protocol.protocolHash,
  };
  if (canonicalJson(roundBinding.rsiEvaluation)
    !== canonicalJson(expectedRsiEvaluation)) {
    throw new Error(
      "adaptive StateRoot does not bind the exact code-version evaluation opening and protocol",
    );
  }
  const generationDir = join(
    stateDir,
    "generations",
    String(round).padStart(4, "0"),
  );
  const [proposal, feedback, outcome] = await Promise.all([
    readArchivedJson(
      join(generationDir, "proposal.json"),
      "outer_adaptive_proposal.schema.json",
      "archived adaptive proposal",
    ),
    readArchivedJson(
      join(generationDir, "feedback.json"),
      "outer_adaptive_feedback.schema.json",
      "archived adaptive feedback",
    ),
    readArchivedJson(
      join(generationDir, "outcome.json"),
      "outer_adaptive_outcome.schema.json",
      "archived adaptive outcome",
    ),
  ]);
  const feedbackTyped = feedback as unknown as {
    campaignId: string;
    round: number;
    proposalHash: string;
    metricInterpretation: "in_sample_descriptive_only";
    control: { metrics: RsiMetricSummary };
    challenger: {
      metrics: RsiMetricSummary;
      pairedDelta: Record<string, unknown>;
      overallFmaxGain: number;
      maximumPopulatedAspectFmaxDrop: number;
      decision: RsiAdaptiveDecision;
    };
    teacher: {
      causal: {
        hypothesisVerdict:
          OptimizationCausalTeacherFeedback["hypothesisVerdict"];
        mechanismVerdict:
          OptimizationCausalTeacherFeedback["mechanismVerdict"];
        diagnoses: OptimizationCausalTeacherFeedback["diagnoses"];
        prioritizedActions:
          OptimizationCausalTeacherFeedback["prioritizedActions"];
      };
    };
  };
  const outcomeTyped = outcome as unknown as {
    canonicalHash: string;
    campaignId: string;
    round: number;
    proposalHash: string;
    feedbackHash: string;
    claimBoundary: string;
    result: {
      decision: RsiAdaptiveDecision;
      controlDevelopmentFmax: number;
      challengerDevelopmentFmax: number;
      developmentFmaxGain: number;
    };
    knowledge: {
      hypothesis: string;
      changeSummary: string;
      authorizedByDeveloperPlanHash: string | null;
      researchCardBundleHash: string;
      externalEvidenceIds: string[];
      hypothesisVerdict:
        OptimizationCausalTeacherFeedback["hypothesisVerdict"];
      mechanismVerdict:
        OptimizationCausalTeacherFeedback["mechanismVerdict"];
      teacherDiagnoses:
        OptimizationCausalTeacherFeedback["diagnoses"];
      prioritizedActions:
        OptimizationCausalTeacherFeedback["prioritizedActions"];
    };
  };
  const proposalTyped = proposal as unknown as {
    canonicalHash: string;
    campaignId: string;
    round: number;
    parentGeneration: number;
    problemJudgment: {
      codes: string[];
    };
    hypothesis: string;
    researchCardBundleHash: string;
    researchEvidenceIds: string[];
    teacherAuthorization: {
      developerPlanHash: string;
    } | null;
    experiment: {
      templateId: MethodExperimentTemplateId;
      family: CausalTeacherFamily;
      control: {
        sourceCommit: string;
      };
      challenger: {
        sourceCommit: string;
      };
    } & Record<string, unknown>;
  };
  const objectiveTyped = objective as unknown as {
    campaignId: string;
    cohort: {
      developmentShardHash: string;
    };
  };
  if (feedbackTyped.campaignId !== verified.campaignId
    || outcomeTyped.campaignId !== verified.campaignId
    || proposalTyped.campaignId !== verified.campaignId
    || objectiveTyped.campaignId !== verified.campaignId
    || feedbackTyped.round !== round
    || outcomeTyped.round !== round
    || proposalTyped.round !== round
    || feedbackTyped.proposalHash !== proposalTyped.canonicalHash
    || outcomeTyped.proposalHash !== proposalTyped.canonicalHash
    || outcomeTyped.feedbackHash
      !== (feedback as { canonicalHash: string }).canonicalHash
    || outcomeTyped.canonicalHash !== result.manifest.result.artifactHash
    || outcomeTyped.claimBoundary !== result.manifest.claimBoundary
    || outcomeTyped.claimBoundary !== input.claimBoundary
    || outcomeTyped.result.decision !== feedbackTyped.challenger.decision
    || outcomeTyped.result.controlDevelopmentFmax
      !== feedbackTyped.control.metrics.overall.fmax
    || outcomeTyped.result.challengerDevelopmentFmax
      !== feedbackTyped.challenger.metrics.overall.fmax
    || outcomeTyped.result.developmentFmaxGain
      !== feedbackTyped.challenger.overallFmaxGain
    || outcomeTyped.knowledge.hypothesisVerdict
      !== feedbackTyped.teacher.causal.hypothesisVerdict
    || outcomeTyped.knowledge.mechanismVerdict
      !== feedbackTyped.teacher.causal.mechanismVerdict
    || canonicalJson(outcomeTyped.knowledge.teacherDiagnoses)
      !== canonicalJson(feedbackTyped.teacher.causal.diagnoses)
    || canonicalJson(outcomeTyped.knowledge.prioritizedActions)
      !== canonicalJson(feedbackTyped.teacher.causal.prioritizedActions)) {
    throw new Error(
      "adaptive publication source documents do not bind the canonical StateRoot head",
    );
  }
  const version = byVersionId(
    graph,
    result.manifest.version.versionId,
  );
  if (proposalTyped.experiment.challenger.sourceCommit
      !== version.manifest.sourceCommit
    || (version.manifest.parent
      ? proposalTyped.experiment.control.sourceCommit
        !== version.manifest.parent.sourceCommit
      : proposalTyped.experiment.control.sourceCommit
        !== version.manifest.sourceCommit)) {
    throw new Error(
      "adaptive publication proposal does not compare the exact code version against its registered parent",
    );
  }
  if (outcomeTyped.knowledge.hypothesis
      !== version.manifest.change.hypothesis
    || outcomeTyped.knowledge.changeSummary
      !== version.manifest.change.summary) {
    throw new Error(
      "adaptive outcome hypothesis and change summary must match the registered code version",
    );
  }
  let codeVersionHistoryHash: string | null = null;
  let codeVersionExploration: {
    explorationId: string;
    planHash: string;
  } | null = null;
  if (outcomeTyped.knowledge.authorizedByDeveloperPlanHash !== null) {
    const developerPlan = await readArchivedJson(
      join(generationDir, "developer_plan.json"),
      "outer_adaptive_developer_plan.schema.json",
      "archived adaptive Developer plan",
    );
    const planHash = developerPlan.canonicalHash;
    if (planHash !== outcomeTyped.knowledge.authorizedByDeveloperPlanHash) {
      throw new Error(
        "adaptive outcome does not bind the archived Developer plan",
      );
    }
    if (proposalTyped.teacherAuthorization?.developerPlanHash !== planHash) {
      throw new Error(
        "adaptive proposal does not bind the archived Developer plan",
      );
    }
    const authorizedProposalSpec = {
      schemaVersion: "pi-outer-adaptive-proposal-spec.v1",
      round: proposalTyped.round,
      problemCodes: [...proposalTyped.problemJudgment.codes],
      hypothesis: proposalTyped.hypothesis,
      researchCardBundleHash: proposalTyped.researchCardBundleHash,
      researchEvidenceIds: [...proposalTyped.researchEvidenceIds],
      experiment: structuredClone(proposalTyped.experiment),
    };
    if (canonicalJson(developerPlan.authorizedProposalSpec)
        !== canonicalJson(authorizedProposalSpec)) {
      throw new Error(
        "archived adaptive Developer plan does not authorize the exact executed proposal",
      );
    }
    const rawHistoryHash = developerPlan.codeVersionHistoryHash ?? null;
    if (rawHistoryHash !== null && typeof rawHistoryHash !== "string") {
      throw new Error(
        "archived adaptive Developer plan has an invalid code-version history hash",
      );
    }
    codeVersionHistoryHash = rawHistoryHash as string | null;
    const rawExploration = developerPlan.codeVersionExploration ?? null;
    if (rawExploration !== null) {
      if (typeof rawExploration !== "object"
        || Array.isArray(rawExploration)) {
        throw new Error(
          "archived adaptive Developer plan has an invalid code-version exploration binding",
        );
      }
      const exploration = rawExploration as Record<string, unknown>;
      if (typeof exploration.explorationId !== "string"
        || typeof exploration.planHash !== "string") {
        throw new Error(
          "archived adaptive Developer plan has an invalid code-version exploration binding",
        );
      }
      codeVersionExploration = {
        explorationId: assertId(
          exploration.explorationId,
          "archived adaptive Developer exploration ID",
        ),
        planHash: assertHash(
          exploration.planHash,
          "archived adaptive Developer exploration plan hash",
        ),
      };
    }
  }
  if (version.manifest.parent) {
    const registeredExploration = version.manifest.developmentPlan;
    const exploration = registeredExploration?.schemaVersion
        === RSI_DEVELOPER_EXPLORATION_SCHEMA
      ? graph.developerExplorations.find((item) =>
        item.manifest.explorationId
          === registeredExploration.explorationId)
      : undefined;
    if (!version.manifest.developmentContext
      || outcomeTyped.knowledge.authorizedByDeveloperPlanHash === null
      || codeVersionHistoryHash
        !== version.manifest.developmentContext.contextHash
      || !codeVersionExploration
      || !registeredExploration
      || registeredExploration.schemaVersion
        !== RSI_DEVELOPER_EXPLORATION_SCHEMA
      || !exploration
      || codeVersionExploration.explorationId
        !== registeredExploration.explorationId
      || codeVersionExploration.planHash
        !== registeredExploration.planHash
      || exploration.manifest.nextOptimizationPlan.canonicalHash
        !== registeredExploration.planHash) {
      throw new Error(
        "non-root adaptive publication must bind the exact public history and pre-code exploration consumed by its Developer plan",
      );
    }
    assertRsiExplorationAuthorizesAdaptiveProposal(
      {
        hypothesis: proposalTyped.hypothesis,
        researchEvidenceIds: proposalTyped.researchEvidenceIds,
        experiment: {
          family: proposalTyped.experiment.family,
          requiredCapability:
            String(proposalTyped.experiment.requiredCapability),
          challenger: {
            capabilityId: String(
              (proposalTyped.experiment.challenger as Record<string, unknown>)
                .capabilityId,
            ),
          },
          changeSummary: String(
            proposalTyped.experiment.changeSummary,
          ),
        },
      },
      exploration.manifest.nextOptimizationPlan,
    );
  } else if (codeVersionHistoryHash !== null
    || codeVersionExploration !== null) {
    throw new Error(
      "root adaptive publication must not claim a pre-existing code-version history or exploration",
    );
  }
  const publicSummary: RsiAdaptivePublicSummary = {
    kind: "adaptive_protein_function",
    campaignId: verified.campaignId,
    round,
    cohort: {
      role: "adaptive_development",
      caseCount: feedbackTyped.control.metrics.overall.proteinCount,
      cohortHash: objectiveTyped.cohort.developmentShardHash,
    },
    metricInterpretation: feedbackTyped.metricInterpretation,
    sourceDocuments: {
      proposalHash: proposalTyped.canonicalHash,
      feedbackHash: (feedback as { canonicalHash: string }).canonicalHash,
      outcomeHash: outcomeTyped.canonicalHash,
      developerPlanHash:
        outcomeTyped.knowledge.authorizedByDeveloperPlanHash,
      codeVersionHistoryHash,
      researchCardBundleHash:
        outcomeTyped.knowledge.researchCardBundleHash,
    },
    control: {
      metrics: structuredClone(feedbackTyped.control.metrics),
    },
    challenger: {
      metrics: structuredClone(feedbackTyped.challenger.metrics),
      pairedDelta: structuredClone(feedbackTyped.challenger.pairedDelta),
      overallFmaxGain: feedbackTyped.challenger.overallFmaxGain,
      maximumPopulatedAspectFmaxDrop:
        feedbackTyped.challenger.maximumPopulatedAspectFmaxDrop,
      decision: feedbackTyped.challenger.decision,
    },
    teacher: {
      hypothesisVerdict:
        feedbackTyped.teacher.causal.hypothesisVerdict,
      mechanismVerdict:
        feedbackTyped.teacher.causal.mechanismVerdict,
      diagnoses: [...feedbackTyped.teacher.causal.diagnoses],
      prioritizedActions: [
        ...feedbackTyped.teacher.causal.prioritizedActions,
      ],
    },
    method: {
      templateId: proposalTyped.experiment.templateId,
      family: proposalTyped.experiment.family,
      hypothesis: outcomeTyped.knowledge.hypothesis,
      changeSummary: outcomeTyped.knowledge.changeSummary,
      externalEvidenceIds: [
        ...outcomeTyped.knowledge.externalEvidenceIds,
      ],
    },
  };
    return { publicSummary, stateRoot };
  } finally {
    await rm(snapshotParent, { recursive: true, force: true });
  }
}

export async function completeRsiEvaluation(
  input: CompleteRsiEvaluationInput,
): Promise<TaggedManifest<RsiEvaluationResultManifest>> {
  if (input.resultKind !== "adaptive_development") {
    throw new Error(
      "non-adaptive RSI completion must use the hash-verified result-file entry point",
    );
  }
  if (!input.stateRoot) {
    throw new Error(
      "adaptive development result requires a verified StateRoot binding",
    );
  }
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  const evaluationId = assertId(input.evaluationId, "evaluation ID");
  const opening = graph.evaluationOpenings.find(
    (item) => item.manifest.evaluationId === evaluationId,
  );
  if (!opening) {
    throw new Error(`unknown RSI evaluation opening: ${evaluationId}`);
  }
  const resultArtifactHash = assertHash(
    input.resultArtifactHash,
    "result artifact hash",
  );
  const derived = await deriveRsiAdaptivePublicSummaryFromStateRoot({
    graph,
    opening,
    resultArtifactHash,
    claimBoundary: input.claimBoundary,
    stateRootArchiveDir: input.stateRoot.archiveDir,
  });
  return await writeRsiEvaluationResult({
    ...input,
    repositoryRoot,
    resultArtifactHash,
    stateRoot: derived.stateRoot,
    publicSummary: derived.publicSummary,
  });
}

export async function publishRsiAdaptiveEvaluationFromStateRoot(
  input: Omit<PublishRsiEvaluationInput, "publicSummary"> & {
    stateRootArchiveDir: string;
  },
): Promise<TaggedManifest<RsiEvaluationPublicationManifest>> {
  if (input.publicationMode === "retrospective_legacy") {
    throw new Error(
      "retrospective legacy publication is restricted to non-adaptive receipts; adaptive StateRoots require the prospective protocol",
    );
  }
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  const result = resultByEvaluationId(
    graph,
    assertId(input.evaluationId, "evaluation ID"),
  );
  if (result.manifest.result.kind !== "adaptive_development"
    || !result.manifest.stateRoot) {
    throw new Error(
      "StateRoot-derived publication requires an adaptive evaluation result",
    );
  }
  const opening = graph.evaluationOpenings.find(
    (item) => item.manifest.evaluationId === result.manifest.evaluationId,
  );
  if (!opening) {
    throw new Error("adaptive publication has no immutable evaluation opening");
  }
  const derived = await deriveRsiAdaptivePublicSummaryFromStateRoot({
    graph,
    opening,
    resultArtifactHash: result.manifest.result.artifactHash,
    claimBoundary: result.manifest.claimBoundary,
    stateRootArchiveDir: input.stateRootArchiveDir,
    expectedStateRoot: result.manifest.stateRoot,
  });
  return await publishRsiEvaluation({
    ...input,
    repositoryRoot,
    publicSummary: derived.publicSummary,
  });
}

export async function recordRsiDecision(
  input: RecordRsiDecisionInput,
): Promise<TaggedManifest<RsiDecisionManifest>> {
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  await inspectCleanHead(repositoryRoot);
  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  const decisionId = assertId(input.decisionId, "decision ID");
  if (graph.decisions.some((item) => item.manifest.decisionId === decisionId)) {
    throw new Error(`RSI decision ID already exists: ${decisionId}`);
  }
  const result = resultByEvaluationId(
    graph,
    assertId(input.evaluationId, "evaluation ID"),
  );
  const publication = graph.evaluationPublications.find(
    (item) => item.manifest.evaluationId === result.manifest.evaluationId,
  );
  if (!publication) {
    throw new Error(
      "RSI decision requires an immutable public evaluation record",
    );
  }
  const candidate = byVersionId(graph, result.manifest.version.versionId);
  const before = byVersionId(graph, graph.selectedVersionId!);
  const selected = byVersionId(
    graph,
    assertId(input.selectedVersionId, "selected version ID"),
  );
  if (input.action === "continue") {
    if (selected.manifest.versionId !== candidate.manifest.versionId) {
      throw new Error("continue decision must select the evaluated candidate");
    }
  } else if (input.action === "backtrack") {
    if (selected.manifest.versionId === candidate.manifest.versionId
      || !await isAncestor(repositoryRoot, selected.targetCommit, candidate.targetCommit)) {
      throw new Error("backtrack decision must select a strict ancestor");
    }
    const historicallySelected = new Set<string>([
      graph.rootVersionId!,
      ...graph.decisions.map((item) => item.manifest.selectedVersion.versionId),
    ]);
    if (!historicallySelected.has(selected.manifest.versionId)) {
      throw new Error("backtrack target has never been a selected RSI version");
    }
  } else if (selected.manifest.versionId !== before.manifest.versionId) {
    throw new Error(
      "retain decision must keep the current selected version",
    );
  }
  assertEvaluationDecisionSemantics(
    publication,
    before,
    candidate,
    selected,
    input.action,
  );
  const previous = graph.decisionHeadId
    ? graph.decisions.find((item) =>
      item.manifest.decisionId === graph.decisionHeadId)!
    : undefined;
  const ref = decisionRef(decisionId);
  const manifest = withCanonicalHash({
    schemaVersion: RSI_CODE_DECISION_SCHEMA,
    decisionId,
    tagRef: ref,
    previousDecision: previous
      ? {
        decisionId: previous.manifest.decisionId,
        manifestHash: previous.manifest.canonicalHash,
      }
      : null,
    evaluation: {
      evaluationId: result.manifest.evaluationId,
      resultManifestHash: result.manifest.canonicalHash,
      publicationManifestHash: publication.manifest.canonicalHash,
    },
    selectionBefore: versionBinding(before),
    candidateVersion: versionBinding(candidate),
    selectedVersion: versionBinding(selected),
    action: input.action,
    rationale: assertText(input.rationale, "decision rationale"),
  }) as RsiDecisionManifest;
  await assertSchema(
    "rsi_code_decision.schema.json",
    manifest,
    "RSI code decision",
  );
  const created = await createAnnotatedTag(
    repositoryRoot,
    ref,
    selected.targetCommit,
    manifest,
  );
  await publishGraphEvent(
    repositoryRoot,
    input.remote,
    graph,
    created,
    "decision",
  );
  const verified = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  return verified.decisions.find(
    (item) => item.manifest.decisionId === decisionId,
  )!;
}

export async function recordRsiRetrospectiveExperiment(
  input: RecordRsiRetrospectiveExperimentInput,
): Promise<TaggedManifest<RsiRetrospectiveExperimentManifest>> {
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  const head = await inspectCleanHead(repositoryRoot);
  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  if (!graph.evaluationComplete
    || !graph.selectedVersionId
    || graph.events.length === 0
    || graph.unreflectedTerminalVersionIds.length !== 1) {
    throw new Error(
      "RSI retrospective experiment recording requires an evaluation-complete public history at exactly one unreflected terminal boundary",
    );
  }
  const recordId = assertId(
    input.recordId,
    "retrospective experiment ID",
  );
  if (graph.retrospectiveExperiments.some((item) =>
    item.manifest.recordId === recordId)) {
    throw new Error(
      `RSI retrospective experiment ID already exists: ${recordId}`,
    );
  }

  const requestedReceipt = resolve(input.receiptPath);
  const canonicalReceipt = await realpath(requestedReceipt);
  if (canonicalReceipt !== requestedReceipt
    || !isInsideOrEqual(canonicalReceipt, repositoryRoot)
    || canonicalReceipt === repositoryRoot) {
    throw new Error(
      "RSI retrospective receipt must be a canonical regular file inside the repository",
    );
  }
  const receiptRelativePath = relative(
    repositoryRoot,
    canonicalReceipt,
  ).split(sep).join("/");
  if (!/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
    .test(receiptRelativePath)
    || receiptRelativePath.length > 512) {
    throw new Error(
      "RSI retrospective receipt path is not safe for an immutable Git binding",
    );
  }
  const receiptFile = await stableFile(canonicalReceipt);
  const receiptBlobObjectId = assertOid(
    await git(repositoryRoot, [
      "rev-parse",
      "--verify",
      `${head.sourceCommit}:${receiptRelativePath}`,
    ]),
    "retrospective receipt blob",
  );
  if (await git(repositoryRoot, [
    "cat-file",
    "-t",
    receiptBlobObjectId,
  ]) !== "blob") {
    throw new Error("RSI retrospective receipt path is not a Git blob");
  }
  const frozenReceiptBytes = await gitBlobBytes(
    repositoryRoot,
    receiptBlobObjectId,
  );
  if (!receiptFile.bytes.equals(frozenReceiptBytes)) {
    throw new Error(
      "RSI retrospective receipt bytes do not match the current HEAD tree",
    );
  }
  let receiptValue: unknown;
  try {
    receiptValue = JSON.parse(
      frozenReceiptBytes.toString("utf8"),
    ) as unknown;
  } catch {
    throw new Error("RSI retrospective receipt is not valid JSON");
  }
  const receipt = parseRetrospectiveReceipt(
    receiptValue,
    "RSI retrospective receipt",
  );
  if (receipt.recordId !== recordId) {
    throw new Error(
      "RSI retrospective receipt recordId does not match --record-id",
    );
  }
  const evaluatedCommit = assertOid(
    await git(repositoryRoot, [
      "rev-parse",
      "--verify",
      `${receipt.evaluatedCommit}^{commit}`,
    ]),
    "retrospective evaluated commit",
  );
  if (evaluatedCommit !== receipt.evaluatedCommit
    || !await isAncestor(
      repositoryRoot,
      evaluatedCommit,
      head.sourceCommit,
    )) {
    throw new Error(
      "RSI retrospective evaluated commit must be an exact ancestor of the record commit",
    );
  }
  const evaluatedTree = assertOid(
    await git(repositoryRoot, [
      "rev-parse",
      "--verify",
      `${evaluatedCommit}^{tree}`,
    ]),
    "retrospective evaluated tree",
  );
  const archiveSealHash = assertHash(
    input.archiveSealHash,
    "retrospective archive seal hash",
  );
  const archivePublicManifestHash = assertHash(
    input.archivePublicManifestHash,
    "retrospective archive public manifest hash",
  );
  const graphHead = graph.events.at(-1)!;
  const selected = byVersionId(graph, graph.selectedVersionId);
  const ref = retrospectiveRef(recordId);
  const manifest = withCanonicalHash({
    schemaVersion: RSI_RETROSPECTIVE_EXPERIMENT_SCHEMA,
    recordId,
    tagRef: ref,
    recordCommit: {
      sourceCommit: head.sourceCommit,
      sourceTree: head.sourceTree,
    },
    evaluatedSource: {
      sourceCommit: evaluatedCommit,
      sourceTree: evaluatedTree,
    },
    receipt: {
      relativePath: receiptRelativePath,
      blobObjectId: receiptBlobObjectId,
      fileSha256: receiptFile.sha256,
      canonicalHash: receipt.canonicalHash,
      size: receiptFile.size,
    },
    formalSelection: {
      selectedVersion: versionBinding(selected),
      eventSequence: graphHead.manifest.sequence,
      eventManifestHash: graphHead.manifest.canonicalHash,
      formalDecisionMutation: null,
    },
    experiment: {
      changeSummary: receipt.changeSummary,
      hypothesis: receipt.hypothesis,
      component: receipt.component,
      observations: structuredClone(receipt.observations),
      diagnoses: [...receipt.diagnoses],
      prioritizedActions: [...receipt.prioritizedActions],
      localGateOutcome: receipt.localGateOutcome,
    },
    archive: {
      archiveSealHash,
      publicManifestHash: archivePublicManifestHash,
    },
    policies: {
      evidenceTiming:
        "retrospective_post_hoc_without_pre_evaluation_opening" as const,
      graphRole: "knowledge_only_not_a_code_version_node" as const,
      selectionEligibility:
        "ineligible_never_updates_selected_version" as const,
      promotionEligibility:
        "ineligible_not_prospective_evidence" as const,
      artifactRetention:
        "external_hash_bound_archive_required" as const,
    },
    claimBoundary: RSI_RETROSPECTIVE_CLAIM_BOUNDARY,
  }) as RsiRetrospectiveExperimentManifest;
  assertPublicManifest(manifest, "RSI retrospective experiment");
  await assertSchema(
    "rsi_retrospective_experiment.schema.json",
    manifest,
    "RSI retrospective experiment",
  );
  const created = await createAnnotatedTag(
    repositoryRoot,
    ref,
    head.sourceCommit,
    manifest,
  );
  await publishGraphEvent(
    repositoryRoot,
    input.remote,
    graph,
    created,
    "retrospective_experiment",
  );
  const verified = await inspectRsiVersionGraph(
    repositoryRoot,
    input.remote,
  );
  return verified.retrospectiveExperiments.find((item) =>
    item.manifest.recordId === recordId)!;
}

export async function recordRsiDeveloperExploration(
  input: RecordRsiDeveloperExplorationInput,
): Promise<TaggedManifest<RsiDeveloperExplorationManifest>> {
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  await inspectCleanHead(repositoryRoot);
  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  if (!graph.evaluationComplete || !graph.selectedVersionId
    || graph.events.length === 0) {
    throw new Error(
      "RSI Developer exploration requires an evaluation-complete public history that is awaiting reflection",
    );
  }
  const explorationId = assertId(
    input.explorationId,
    "Developer exploration ID",
  );
  if (graph.developerExplorations.some((item) =>
    item.manifest.explorationId === explorationId)) {
    throw new Error(
      `RSI Developer exploration ID already exists: ${explorationId}`,
    );
  }
  const lastTerminalEvent = [...graph.events].reverse().find(
    (event) => event.manifest.mutation.kind
      !== "retrospective_experiment",
  );
  let decision: TaggedManifest<RsiDecisionManifest> | undefined;
  if (lastTerminalEvent?.manifest.mutation.kind === "decision") {
    decision = graph.decisions.find((item) =>
      item.ref === lastTerminalEvent.manifest.mutation.ref);
  } else if (lastTerminalEvent?.manifest.mutation.kind
      === "evaluation_publication") {
    const publication = graph.evaluationPublications.find((item) =>
      item.ref === lastTerminalEvent.manifest.mutation.ref);
    if (publication?.manifest.publicationMode === "retrospective_legacy") {
      decision = graph.decisions.find((item) =>
        item.manifest.evaluation.evaluationId
          === publication.manifest.evaluationId);
    }
  }
  if (!decision) {
    throw new Error(
      "RSI Developer exploration must follow a terminal decision (or its exact legacy publication), with only knowledge-only retrospective records in between",
    );
  }
  const evaluationId = decision.manifest.evaluation.evaluationId;
  if (graph.developerExplorations.some((item) =>
    item.manifest.evaluation.evaluationId === evaluationId)) {
    throw new Error(
      `RSI evaluation ${evaluationId} already has a Developer exploration`,
    );
  }
  const opening = graph.evaluationOpenings.find((item) =>
    item.manifest.evaluationId === evaluationId);
  const result = graph.evaluationResults.find((item) =>
    item.manifest.evaluationId === evaluationId);
  const publication = graph.evaluationPublications.find((item) =>
    item.manifest.evaluationId === evaluationId);
  const sourceVersion = result
    ? byVersionId(graph, result.manifest.version.versionId)
    : undefined;
  if (!opening || !result || !publication || !sourceVersion) {
    throw new Error(
      "RSI Developer exploration requires a clean tooling checkout and an exact completed/public evaluation",
    );
  }
  if (publication.manifest.publicSummary.kind
      !== "adaptive_protein_function"
    && !isProspectiveFrozenReplayTerminal(
      publication,
      decision,
    )
    && !isApprovedTerminalPreflightRejection(
      publication,
      opening,
      result,
      decision,
    )
    && !isExactGrandfatheredLegacyPublication(
      sourceVersion,
      opening,
      result,
      decision,
      publication,
    )) {
    throw new Error(
      "RSI Developer exploration cannot be created from a non-terminal generic evaluation",
    );
  }
  const planSpecFile = await stableFile(input.planSpecPath, 1024 * 1024);
  let planSpecValue: unknown;
  try {
    planSpecValue = JSON.parse(
      planSpecFile.bytes.toString("utf8"),
    ) as unknown;
  } catch {
    throw new Error("RSI next optimization plan spec is not valid JSON");
  }
  await assertSchema(
    "rsi_next_optimization_plan_spec.schema.json",
    planSpecValue,
    "RSI next optimization plan spec",
  );
  const planSpec = structuredClone(
    planSpecValue,
  ) as RsiNextOptimizationPlanSpec;
  const baseVersionId = planSpec.schemaVersion
      === RSI_NEXT_OPTIMIZATION_PLAN_SPEC_V1_SCHEMA
    ? graph.selectedVersionId
    : assertId(
      planSpec.baseVersionId!,
      "RSI next optimization plan base version ID",
    );
  const baseVersion = byVersionId(graph, baseVersionId);
  const historyHeadSequence = graph.events.at(-1)!.manifest.sequence;
  if (eventSequenceForRef(graph.events, baseVersion.ref)
      > historyHeadSequence) {
    throw new Error(
      "RSI next optimization plan base version is outside its public history prefix",
    );
  }
  if (new Set(planSpec.researchCards.map((item) => item.evidenceId)).size
      !== planSpec.researchCards.length) {
    throw new Error(
      "RSI next optimization plan research evidence IDs must be unique",
    );
  }
  if (planSpec.action === "proceed") {
    const plannedVersionId = assertId(
      planSpec.plannedVersionId!,
      "planned version ID",
    );
    if (graph.versions.some((item) =>
      item.manifest.versionId === plannedVersionId)
      || graph.developerExplorations.some((item) =>
        item.manifest.nextOptimizationPlan.plannedVersionId
          === plannedVersionId)) {
      throw new Error(
        `RSI planned version ID already exists: ${plannedVersionId}`,
      );
    }
  } else if (planSpec.plannedVersionId !== null) {
    throw new Error("a stop plan must not name a planned version");
  }
  const history = buildDeveloperHistoryContextFromGraph(graph);
  const analysis = evaluationAnalysisFor(
    sourceVersion,
    opening,
    result,
    publication,
    decision,
  );
  const plan = buildRsiNextOptimizationPlan({
    spec: planSpec,
    analysis,
    baseVersionId: baseVersion.manifest.versionId,
    history: {
      contextHash: history.canonicalHash,
      eventSequence: history.graphHead.eventSequence,
      eventManifestHash: history.graphHead.eventManifestHash,
      selectedVersionId: history.graphHead.selectedVersionId,
    },
  });
  assertPublicManifest(analysis, "RSI evaluation analysis");
  assertPublicManifest(plan, "RSI next optimization plan");
  await assertSchema(
    "rsi_evaluation_analysis.schema.json",
    analysis,
    "RSI evaluation analysis",
  );
  await assertSchema(
    "rsi_next_optimization_plan.schema.json",
    plan,
    "RSI next optimization plan",
  );
  const analysisMarkdown =
    renderRsiEvaluationAnalysisMarkdown(analysis);
  const planMarkdown = renderRsiNextOptimizationPlanMarkdown(plan);
  const sourceVersionId = sourceVersion.manifest.versionId;
  const ref = explorationRef(explorationId);
  const manifest = withCanonicalHash({
    schemaVersion: RSI_DEVELOPER_EXPLORATION_SCHEMA,
    explorationId,
    tagRef: ref,
    sourceVersion: versionBinding(sourceVersion),
    baseVersion: versionBinding(baseVersion),
    evaluation: {
      evaluationId,
      openingHash: opening.manifest.canonicalHash,
      resultHash: result.manifest.canonicalHash,
      publicationHash: publication.manifest.canonicalHash,
      publicationTagObjectId: publication.tagObjectId,
      decisionId: decision.manifest.decisionId,
      decisionHash: decision.manifest.canonicalHash,
      decisionTagObjectId: decision.tagObjectId,
      stateRootPublicManifestHash:
        result.manifest.stateRoot?.publicManifestHash ?? null,
    },
    historyPrefix: {
      schemaVersion: history.schemaVersion,
      contextHash: history.canonicalHash,
      eventSequence: history.graphHead.eventSequence,
      eventManifestHash: history.graphHead.eventManifestHash,
      selectedVersionId: history.graphHead.selectedVersionId,
    },
    evaluationAnalysis: analysis,
    nextOptimizationPlan: plan,
    artifacts: {
      evaluationAnalysisMarkdown: explorationArtifactBinding(
        `versions/${sourceVersionId}/evaluation_analysis.md`,
        analysisMarkdown,
      ),
      nextOptimizationPlanMarkdown: explorationArtifactBinding(
        `versions/${sourceVersionId}/next_optimization_plan.md`,
        planMarkdown,
      ),
    },
    policies: {
      authority:
        "immutable_structured_tag_and_event_markdown_is_deterministic_view_v1" as const,
      planningOrder:
        "terminal_evaluation_then_reflection_then_child_version_registration_v1" as const,
      privacy:
        "closed_public_projection_no_protected_material_v1" as const,
    },
    claimBoundary: RSI_EXPLORATION_CLAIM_BOUNDARY,
  }) as RsiDeveloperExplorationManifest;
  await assertSchema(
    "rsi_developer_exploration.schema.json",
    manifest,
    "RSI Developer exploration",
  );
  const created = await createAnnotatedTag(
    repositoryRoot,
    ref,
    sourceVersion.targetCommit,
    manifest,
  );
  await publishGraphEvent(
    repositoryRoot,
    input.remote,
    graph,
    created,
    "developer_exploration",
  );
  const verified = await inspectRsiVersionGraph(
    repositoryRoot,
    input.remote,
  );
  return verified.developerExplorations.find((item) =>
    item.manifest.explorationId === explorationId)!;
}

export async function recordRsiEpochResume(
  input: RecordRsiEpochResumeInput,
): Promise<TaggedManifest<RsiEpochResumeManifest>> {
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  await inspectCleanHead(repositoryRoot);
  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  if (!graph.paperComplete || !graph.selectedVersionId
    || graph.events.length === 0) {
    throw new Error(
      "RSI epoch resume requires a paper-complete terminal history",
    );
  }
  const resumeId = assertId(input.resumeId, "epoch resume ID");
  if (graph.epochResumes.some((item) =>
    item.manifest.resumeId === resumeId)) {
    throw new Error(`RSI epoch resume ID already exists: ${resumeId}`);
  }
  const lastEvent = graph.events.at(-1)!;
  if (lastEvent.manifest.mutation.kind !== "developer_exploration") {
    throw new Error(
      "RSI epoch resume must immediately follow a terminal stop exploration",
    );
  }
  const terminalStop = graph.developerExplorations.find((item) =>
    item.ref === lastEvent.manifest.mutation.ref);
  if (!terminalStop
    || terminalStop.manifest.nextOptimizationPlan.action !== "stop") {
    throw new Error(
      "RSI epoch resume must consume the exact latest stop exploration",
    );
  }
  const specFile = await stableFile(input.specPath, 1024 * 1024);
  let specValue: unknown;
  try {
    specValue = JSON.parse(specFile.bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("RSI epoch resume spec is not valid JSON");
  }
  await assertSchema(
    "rsi_epoch_resume_spec.schema.json",
    specValue,
    "RSI epoch resume spec",
  );
  const spec = structuredClone(specValue) as RsiEpochResumeSpec;
  if (spec.canonicalHash !== hashCanonical(withoutCanonicalHash(spec))) {
    throw new Error("RSI epoch resume spec canonical hash is invalid");
  }
  assertPublicManifest(spec, "RSI epoch resume spec");
  const baseVersionId = assertId(
    spec.baseVersionId,
    "epoch resume base version ID",
  );
  const plannedVersionId = assertId(
    spec.plannedVersionId,
    "epoch resume planned version ID",
  );
  const epochId = assertId(spec.epochId, "epoch ID");
  const baseVersion = byVersionId(graph, baseVersionId);
  const selectedVersion = byVersionId(graph, graph.selectedVersionId);
  if (graph.versions.some((item) =>
    item.manifest.versionId === plannedVersionId)
    || graph.developerExplorations.some((item) =>
      item.manifest.nextOptimizationPlan.plannedVersionId
        === plannedVersionId)
    || graph.epochResumes.some((item) =>
      item.manifest.nextEpoch.plannedVersionId === plannedVersionId)) {
    throw new Error(
      `RSI epoch resume planned version ID already exists: ${plannedVersionId}`,
    );
  }
  if (graph.epochResumes.some((item) =>
    item.manifest.nextEpoch.epochId === epochId)) {
    throw new Error(`RSI epoch ID already exists: ${epochId}`);
  }
  const ref = epochResumeRef(resumeId);
  const manifest = withCanonicalHash({
    schemaVersion: RSI_EPOCH_RESUME_SCHEMA,
    resumeId,
    tagRef: ref,
    terminalStop: {
      explorationId: terminalStop.manifest.explorationId,
      manifestHash: terminalStop.manifest.canonicalHash,
      tagObjectId: terminalStop.tagObjectId,
      eventSequence: lastEvent.manifest.sequence,
      eventManifestHash: lastEvent.manifest.canonicalHash,
    },
    historyPrefix: {
      eventSequence: lastEvent.manifest.sequence,
      eventManifestHash: lastEvent.manifest.canonicalHash,
      selectedVersionId: graph.selectedVersionId,
    },
    selectedVersion: versionBinding(selectedVersion),
    baseVersion: versionBinding(baseVersion),
    nextEpoch: {
      schemaVersion: spec.schemaVersion,
      epochId,
      plannedVersionId,
      reason: spec.reason,
      hypothesis: spec.hypothesis,
      plannedChangeSummary: spec.plannedChangeSummary,
      codeChangeTargets: [...spec.codeChangeTargets],
      controls: [...spec.controls],
      verificationRequirements: [...spec.verificationRequirements],
      evaluationPolicy: spec.evaluationPolicy,
      retrospectiveEvidencePolicy:
        spec.retrospectiveEvidencePolicy,
      planHash: spec.canonicalHash,
    },
    policies: {
      authority:
        "immutable_annotated_tag_and_serial_event_v1" as const,
      resumption:
        "explicit_append_only_new_epoch_after_terminal_stop_v1" as const,
      selection:
        "unchanged_until_prospective_decision_v1" as const,
      candidateOrder:
        "resume_plan_before_candidate_commit_and_registration_v1" as const,
    },
    claimBoundary: RSI_EPOCH_RESUME_CLAIM_BOUNDARY,
  }) as RsiEpochResumeManifest;
  assertPublicManifest(manifest, "RSI epoch resume");
  await assertSchema(
    "rsi_epoch_resume.schema.json",
    manifest,
    "RSI epoch resume",
  );
  const created = await createAnnotatedTag(
    repositoryRoot,
    ref,
    baseVersion.targetCommit,
    manifest,
  );
  await publishGraphEvent(
    repositoryRoot,
    input.remote,
    graph,
    created,
    "epoch_resume",
  );
  const verified = await inspectRsiVersionGraph(
    repositoryRoot,
    input.remote,
  );
  return verified.epochResumes.find((item) =>
    item.manifest.resumeId === resumeId)!;
}

export async function recordRsiRetrospectiveIncumbent(
  input: RecordRsiRetrospectiveIncumbentInput,
): Promise<TaggedManifest<RsiRetrospectiveIncumbentManifest>> {
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  const head = await inspectCleanHead(repositoryRoot);
  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  if (!graph.selectedVersionId || graph.events.length === 0
    || graph.incompleteEvaluationIds.length > 0
    || graph.unpublishedEvaluationIds.length > 0
    || graph.undecidedEvaluationIds.length > 0
    || graph.unresolvedVersionIds.length !== 1) {
    throw new Error(
      "RSI retrospective incumbent adoption requires one sole unresolved code version and an otherwise closed public graph",
    );
  }
  const adoptionId = assertId(
    input.adoptionId,
    "retrospective incumbent adoption ID",
  );
  if (graph.retrospectiveIncumbents.some((item) =>
    item.manifest.adoptionId === adoptionId)) {
    throw new Error(
      `RSI retrospective incumbent adoption ID already exists: ${adoptionId}`,
    );
  }
  const lastEvent = graph.events.at(-1)!;
  if (lastEvent.manifest.mutation.kind !== "version") {
    throw new Error(
      "RSI retrospective incumbent adoption must immediately follow the unresolved version registration",
    );
  }

  const specFile = await stableFile(input.specPath, 1024 * 1024);
  let specValue: unknown;
  try {
    specValue = JSON.parse(specFile.bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(
      "RSI retrospective incumbent adoption spec is not valid JSON",
    );
  }
  await assertSchema(
    "rsi_retrospective_incumbent_spec.schema.json",
    specValue,
    "RSI retrospective incumbent adoption spec",
  );
  const spec = structuredClone(
    specValue,
  ) as RsiRetrospectiveIncumbentSpec;
  if (spec.canonicalHash
      !== hashCanonical(withoutCanonicalHash(spec))) {
    throw new Error(
      "RSI retrospective incumbent adoption spec canonical hash is invalid",
    );
  }
  assertPublicManifest(
    spec,
    "RSI retrospective incumbent adoption spec",
  );
  assertRetrospectiveIncumbentEvidence(
    spec.evidence,
    "RSI retrospective incumbent adoption spec",
  );
  if (spec.adoptionId !== adoptionId) {
    throw new Error(
      "RSI retrospective incumbent adoption spec ID does not match --adoption-id",
    );
  }
  const incumbentVersionId = assertId(
    spec.incumbentVersionId,
    "retrospective incumbent version ID",
  );
  const plannedVersionId = assertId(
    spec.plannedVersionId,
    "retrospective incumbent planned version ID",
  );
  if (graph.unresolvedVersionIds[0] !== incumbentVersionId
    || lastEvent.manifest.mutation.ref !== versionRef(incumbentVersionId)
    || graph.retrospectiveIncumbents.some((item) =>
      item.manifest.incumbentVersion.versionId === incumbentVersionId)) {
    throw new Error(
      "RSI retrospective incumbent spec must name the sole unresolved latest version",
    );
  }
  if (graph.versions.some((item) =>
    item.manifest.versionId === plannedVersionId)
    || graph.developerExplorations.some((item) =>
      item.manifest.nextOptimizationPlan.plannedVersionId
        === plannedVersionId)
    || graph.epochResumes.some((item) =>
      item.manifest.nextEpoch.plannedVersionId === plannedVersionId)
    || graph.retrospectiveIncumbents.some((item) =>
      item.manifest.nextCandidate.plannedVersionId
        === plannedVersionId)) {
    throw new Error(
      `RSI retrospective incumbent planned version ID already exists: ${plannedVersionId}`,
    );
  }
  const incumbent = byVersionId(graph, incumbentVersionId);
  const selected = byVersionId(graph, graph.selectedVersionId);
  if (!await isAncestor(
    repositoryRoot,
    incumbent.targetCommit,
    head.sourceCommit,
  )) {
    throw new Error(
      "RSI retrospective incumbent record commit must descend from the adopted version",
    );
  }

  const reportPath = spec.evidence.reportPath;
  const requestedReport = resolve(repositoryRoot, reportPath);
  const canonicalReport = await realpath(requestedReport);
  if (!isInsideOrEqual(canonicalReport, repositoryRoot)
    || relative(repositoryRoot, canonicalReport).split(sep).join("/")
      !== reportPath) {
    throw new Error(
      "RSI retrospective incumbent reportPath must be a canonical repository-relative file",
    );
  }
  const reportFile = await stableFile(canonicalReport);
  const reportBlobObjectId = assertOid(
    await git(repositoryRoot, [
      "rev-parse",
      "--verify",
      `${head.sourceCommit}:${reportPath}`,
    ]),
    "retrospective incumbent report blob",
  );
  if (await git(repositoryRoot, [
    "cat-file",
    "-t",
    reportBlobObjectId,
  ]) !== "blob") {
    throw new Error(
      "RSI retrospective incumbent reportPath is not a Git blob",
    );
  }
  const frozenReport = await gitBlobBytes(
    repositoryRoot,
    reportBlobObjectId,
  );
  if (!reportFile.bytes.equals(frozenReport)
    || reportFile.sha256 !== spec.evidence.reportSha256) {
    throw new Error(
      "RSI retrospective incumbent report does not match the spec and current HEAD tree",
    );
  }

  const ref = retrospectiveIncumbentRef(adoptionId);
  const manifest = withCanonicalHash({
    schemaVersion: RSI_RETROSPECTIVE_INCUMBENT_SCHEMA,
    adoptionId,
    tagRef: ref,
    recordCommit: {
      sourceCommit: head.sourceCommit,
      sourceTree: head.sourceTree,
    },
    historyPrefix: {
      eventSequence: lastEvent.manifest.sequence,
      eventManifestHash: lastEvent.manifest.canonicalHash,
      selectedVersionId: graph.selectedVersionId,
      operationalIncumbentVersionId: incumbentVersionId,
    },
    formalSelection: {
      selectedVersion: versionBinding(selected),
      formalDecisionMutation: null,
    },
    incumbentVersion: versionBinding(incumbent),
    evidence: {
      ...structuredClone(spec.evidence),
      reportBlobObjectId,
    },
    nextCandidate: {
      schemaVersion: spec.schemaVersion,
      plannedVersionId,
      reason: spec.reason,
      hypothesis: spec.hypothesis,
      plannedChangeSummary: spec.plannedChangeSummary,
      codeChangeTargets: [...spec.codeChangeTargets],
      controls: [...spec.controls],
      verificationRequirements: [...spec.verificationRequirements],
      evaluationPolicy: spec.evaluationPolicy,
      retrospectiveEvidencePolicy:
        spec.retrospectiveEvidencePolicy,
      planHash: spec.canonicalHash,
    },
    policies: {
      authority:
        "immutable_annotated_tag_and_serial_event_v1" as const,
      operationalRole:
        "developer_and_runtime_incumbent_v1" as const,
      formalSelection:
        "unchanged_until_prospective_decision_v1" as const,
      evidenceTiming:
        "retrospective_preexisting_development_and_procedural_holdout_v1" as const,
      promotionEligibility:
        "ineligible_retrospective_evidence_never_promotes_v1" as const,
      candidateOrder:
        "incumbent_plan_before_candidate_commit_and_registration_v1" as const,
    },
    claimBoundary: RSI_RETROSPECTIVE_INCUMBENT_CLAIM_BOUNDARY,
  }) as RsiRetrospectiveIncumbentManifest;
  await assertSchema(
    "rsi_retrospective_incumbent.schema.json",
    manifest,
    "RSI retrospective incumbent adoption",
  );
  const created = await createAnnotatedTag(
    repositoryRoot,
    ref,
    head.sourceCommit,
    manifest,
  );
  await publishGraphEvent(
    repositoryRoot,
    input.remote,
    graph,
    created,
    "retrospective_incumbent",
  );
  const verified = await inspectRsiVersionGraph(
    repositoryRoot,
    input.remote,
  );
  return verified.retrospectiveIncumbents.find((item) =>
    item.manifest.adoptionId === adoptionId)!;
}

export async function createDetachedRsiWorktree(input: {
  repositoryRoot: string;
  fromVersionId: string;
  developerExplorationId: string;
  worktreePath: string;
  developerContextOutputPath?: string;
  remote: string;
}): Promise<{
  worktreePath: string;
  versionId: string;
  sourceCommit: string;
  detached: true;
  developerContextPath: string | null;
  developerContextHash: string;
  developerExplorationId: string;
  developerPlanHash: string;
}> {
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  if (!graph.paperComplete) {
    throw new Error(
      "detached RSI development requires a paper-complete history, including prospective protein/Teacher evaluation or an exact approved failed quality preflight for every non-legacy version",
    );
  }
  if (!graph.readyForNextVersion) {
    throw new Error(
      "detached RSI development requires a latest proceed Developer exploration",
    );
  }
  const explorationId = assertId(
    input.developerExplorationId,
    "Developer exploration ID",
  );
  const exploration = graph.developerExplorations.find((item) =>
    item.manifest.explorationId === explorationId);
  if (!exploration
    || graph.events.at(-1)?.manifest.mutation.ref !== exploration.ref
    || exploration.manifest.nextOptimizationPlan.action !== "proceed") {
    throw new Error(
      "detached RSI development requires the exact latest immutable pre-code plan",
    );
  }
  const planBaseVersionId =
    exploration.manifest.baseVersion.versionId;
  const assertedFromVersionId = assertId(
    input.fromVersionId,
    "source version ID",
  );
  if (assertedFromVersionId !== planBaseVersionId) {
    throw new Error(
      "--from-version is only an assertion and does not match the latest plan base",
    );
  }
  const version = byVersionId(graph, planBaseVersionId);
  const requested = resolve(input.worktreePath);
  try {
    await access(requested, constants.F_OK);
    throw new Error("detached RSI development worktree path already exists");
  } catch (error) {
    if (error instanceof Error
      && error.message === "detached RSI development worktree path already exists") {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = await realpath(dirname(requested));
  const parentStat = await stat(parent);
  if (!parentStat.isDirectory()) throw new Error("detached worktree parent is not a directory");
  const canonicalRequested = join(parent, basename(requested));
  const existingWorktrees = await listedWorktreeRoots(repositoryRoot);
  if (existingWorktrees.some((worktree) =>
    isInsideOrEqual(canonicalRequested, worktree)
    || isInsideOrEqual(worktree, canonicalRequested))) {
    throw new Error(
      "detached RSI development worktree must not overlap an existing Git worktree",
    );
  }
  await git(repositoryRoot, [
    "worktree",
    "add",
    "--detach",
    canonicalRequested,
    version.targetCommit,
  ]);
  let canonicalWorktree: string;
  try {
    canonicalWorktree = await realpath(canonicalRequested);
    const checkedOut = await git(canonicalWorktree, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);
    const symbolic = await gitSucceeds(canonicalWorktree, [
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]);
    if (canonicalWorktree !== canonicalRequested
      || checkedOut !== version.targetCommit || symbolic
      || existingWorktrees.some((worktree) =>
        isInsideOrEqual(canonicalWorktree, worktree)
        || isInsideOrEqual(worktree, canonicalWorktree))) {
      throw new Error(
        "created RSI development worktree is not an isolated detached selected version",
      );
    }
  } catch (error) {
    await gitSucceeds(repositoryRoot, [
      "worktree",
      "remove",
      "--force",
      canonicalRequested,
    ]);
    throw error;
  }
  const context = buildDeveloperHistoryContextFromGraph(graph);
  let developerContextPath: string | null = null;
  if (input.developerContextOutputPath) {
    const requestedContext = resolve(input.developerContextOutputPath);
    const contextParent = await realpath(dirname(requestedContext));
    developerContextPath = join(contextParent, basename(requestedContext));
    if (isInsideOrEqual(developerContextPath, canonicalWorktree)) {
      await gitSucceeds(repositoryRoot, [
        "worktree",
        "remove",
        "--force",
        canonicalWorktree,
      ]);
      throw new Error(
        "RSI Developer history artifact must be outside the detached worktree",
      );
    }
    try {
      await writeFile(
        developerContextPath,
        `${JSON.stringify(context, null, 2)}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        },
      );
    } catch (error) {
      await gitSucceeds(repositoryRoot, [
        "worktree",
        "remove",
        "--force",
        canonicalWorktree,
      ]);
      throw error;
    }
  }
  return {
    worktreePath: canonicalWorktree,
    versionId: version.manifest.versionId,
    sourceCommit: version.targetCommit,
    detached: true,
    developerContextPath,
    developerContextHash: context.canonicalHash,
    developerExplorationId: exploration.manifest.explorationId,
    developerPlanHash:
      exploration.manifest.nextOptimizationPlan.canonicalHash,
  };
}

export async function prepareRsiPrimaryCheckout(input: {
  repositoryRoot: string;
  developerExplorationId?: string;
  retrospectiveIncumbentId?: string;
  branchName: string;
  developerContextOutputPath: string;
  expectedFromVersionId?: string;
  remote: string;
  /**
   * Programmatic callers may add a stricter check. Throwing here is
   * fail-closed and rolls back the newly-created branch and context file.
   * The CLI deliberately does not expose this hook.
   */
  additionalPostSwitchValidation?: () => Promise<void>;
}): Promise<{
  repositoryRoot: string;
  branchName: string;
  branchRef: string;
  previousHead: string;
  previousRef: string | null;
  baseVersionId: string;
  plannedVersionId: string;
  sourceCommit: string;
  detached: false;
  developerContextPath: string;
  developerContextHash: string;
  developerExplorationId: string | null;
  retrospectiveIncumbentId: string | null;
  developerPlanHash: string;
  worktreeCountBefore: number;
  worktreeCountAfter: number;
}> {
  const repositoryRoot = await canonicalRepositoryRoot(input.repositoryRoot);
  const gitDirRaw = await git(repositoryRoot, ["rev-parse", "--git-dir"]);
  const commonDirRaw = await git(repositoryRoot, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const gitDir = await realpath(
    isAbsolute(gitDirRaw)
      ? gitDirRaw
      : resolve(repositoryRoot, gitDirRaw),
  );
  const commonDir = await realpath(
    isAbsolute(commonDirRaw)
      ? commonDirRaw
      : resolve(repositoryRoot, commonDirRaw),
  );
  const transactionLockPath = join(
    commonDir,
    "rsi-primary-prepare.lock",
  );
  let transactionLock;
  try {
    transactionLock = await open(
      transactionLockPath,
      "wx",
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `in-place RSI development is locked by another prepare transaction; if no prepare process is active, inspect and remove the stale lock at ${transactionLockPath}`,
      );
    }
    throw error;
  }
  try {
    await transactionLock.writeFile(
      `${JSON.stringify({
        pid: process.pid,
        repositoryRoot,
        operation: "rsi-version-prepare",
      })}\n`,
      "utf8",
    );
    if (gitDir !== commonDir) {
    throw new Error(
      "in-place RSI development requires the primary Git checkout, not a linked worktree",
    );
    }

  const worktreesBefore = await listedWorktreeRoots(repositoryRoot);
  if (worktreesBefore.length !== 1) {
    throw new Error(
      "in-place RSI development requires exactly one Git worktree",
    );
  }
  const head = await inspectCleanHead(repositoryRoot);
  const previousRef = await gitSucceeds(repositoryRoot, [
    "symbolic-ref",
    "--quiet",
    "HEAD",
  ])
    ? await git(repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"])
    : null;
  if (previousRef !== null && !previousRef.startsWith("refs/heads/")) {
    throw new Error(
      "in-place RSI development encountered an unsupported symbolic HEAD",
    );
  }

  const graph = await inspectRsiVersionGraph(repositoryRoot, input.remote);
  const latestKind = graph.events.at(-1)?.manifest.mutation.kind;
  if (!graph.paperComplete
    && latestKind !== "retrospective_incumbent") {
    throw new Error(
      "in-place RSI development requires a paper-complete history or the exact latest retrospective-incumbent bridge",
    );
  }
  if (!graph.readyForNextVersion) {
    throw new Error(
      "in-place RSI development requires a latest authorized pre-code plan",
    );
  }
  if (Number(input.developerExplorationId !== undefined)
      + Number(input.retrospectiveIncumbentId !== undefined) !== 1) {
    throw new Error(
      "in-place RSI development requires exactly one --developer-exploration or --retrospective-incumbent plan",
    );
  }
  const exploration = input.developerExplorationId
    ? graph.developerExplorations.find((item) =>
      item.manifest.explorationId === assertId(
        input.developerExplorationId!,
        "Developer exploration ID",
      ))
    : undefined;
  const adoption = input.retrospectiveIncumbentId
    ? graph.retrospectiveIncumbents.find((item) =>
      item.manifest.adoptionId === assertId(
        input.retrospectiveIncumbentId!,
        "retrospective incumbent adoption ID",
      ))
    : undefined;
  if ((exploration
      && (graph.events.at(-1)?.manifest.mutation.ref !== exploration.ref
        || exploration.manifest.nextOptimizationPlan.action !== "proceed"))
    || (adoption
      && graph.events.at(-1)?.manifest.mutation.ref !== adoption.ref)
    || (!exploration && !adoption)) {
    throw new Error(
      "in-place RSI development requires the exact latest immutable pre-code plan",
    );
  }
  const plannedVersionId = exploration
    ? exploration.manifest.nextOptimizationPlan.plannedVersionId
    : adoption!.manifest.nextCandidate.plannedVersionId;
  if (!plannedVersionId) {
    throw new Error(
      "in-place RSI development requires the latest plan to name a candidate version",
    );
  }
  const baseVersionId = exploration
    ? exploration.manifest.baseVersion.versionId
    : adoption!.manifest.incumbentVersion.versionId;
  const version = byVersionId(graph, baseVersionId);
  if (input.expectedFromVersionId !== undefined
    && assertId(input.expectedFromVersionId, "expected source version ID")
      !== baseVersionId) {
    throw new Error(
      "--from-version is only an assertion and does not match the latest plan base",
    );
  }

  const branchName = input.branchName;
  if (!branchName
    || !await gitSucceeds(repositoryRoot, [
      "check-ref-format",
      "--branch",
      branchName,
    ])) {
    throw new Error("in-place RSI development branch name is invalid");
  }
  const branchRef = `refs/heads/${branchName}`;
  if (await gitSucceeds(repositoryRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    branchRef,
  ])) {
    throw new Error(
      "in-place RSI development branch already exists; choose a new short-lived branch",
    );
  }

  const requestedContext = resolve(input.developerContextOutputPath);
  const contextParent = await realpath(dirname(requestedContext));
  const developerContextPath = join(
    contextParent,
    basename(requestedContext),
  );
  if ([repositoryRoot, ...worktreesBefore].some((worktree) =>
    isInsideOrEqual(developerContextPath, worktree))
    || isInsideOrEqual(developerContextPath, gitDir)
    || isInsideOrEqual(developerContextPath, commonDir)) {
    throw new Error(
      "RSI Developer history artifact must be outside every Git worktree and Git metadata directory",
    );
  }

  const context = buildDeveloperHistoryContextFromGraph(graph);
  const contextBytes = Buffer.from(
    `${JSON.stringify(context, null, 2)}\n`,
    "utf8",
  );
  const contextSha256 = createHash("sha256")
    .update(contextBytes)
    .digest("hex");
  let contextCreated = false;
  let contextIdentity: {
    dev: number;
    ino: number;
  } | null = null;
  let branchCreated = false;
  try {
    await writeFile(developerContextPath, contextBytes, {
      mode: 0o600,
      flag: "wx",
    });
    contextCreated = true;
    const createdContextStat = await lstat(developerContextPath);
    contextIdentity = {
      dev: createdContextStat.dev,
      ino: createdContextStat.ino,
    };
    await git(repositoryRoot, [
      "switch",
      "--create",
      branchName,
      version.targetCommit,
    ]);
    branchCreated = true;
    await input.additionalPostSwitchValidation?.();

    const checkedOut = await inspectCleanHead(repositoryRoot);
    const checkedOutRef = await git(repositoryRoot, [
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]);
    const currentContext = await stableRegularFile(
      developerContextPath,
      1,
      16 * 1024 * 1024,
      "RSI Developer history artifact",
    );
    const currentContextStat = await lstat(developerContextPath);
    const currentContextRealpath = await realpath(
      developerContextPath,
    );
    const worktreesAfter = await listedWorktreeRoots(repositoryRoot);
    if (checkedOut.sourceCommit !== version.targetCommit
      || checkedOut.sourceTree !== version.manifest.sourceTree
      || checkedOutRef !== branchRef
      || !currentContextStat.isFile()
      || currentContextStat.isSymbolicLink()
      || currentContextRealpath !== developerContextPath
      || contextIdentity === null
      || currentContextStat.dev !== contextIdentity.dev
      || currentContextStat.ino !== contextIdentity.ino
      || currentContext.sha256 !== contextSha256
      || currentContext.size !== contextBytes.length
      || (currentContext.mode & 0o777) !== 0o600
      || worktreesAfter.length !== worktreesBefore.length
      || worktreesAfter.some((worktree, index) =>
        worktree !== worktreesBefore[index])) {
      throw new Error(
        "in-place RSI development failed to preserve the exact checkout topology",
      );
    }
    return {
      repositoryRoot,
      branchName,
      branchRef,
      previousHead: head.sourceCommit,
      previousRef,
      baseVersionId,
      plannedVersionId,
      sourceCommit: version.targetCommit,
      detached: false,
      developerContextPath,
      developerContextHash: context.canonicalHash,
      developerExplorationId:
        exploration?.manifest.explorationId ?? null,
      retrospectiveIncumbentId:
        adoption?.manifest.adoptionId ?? null,
      developerPlanHash: exploration
        ? exploration.manifest.nextOptimizationPlan.canonicalHash
        : adoption!.manifest.nextCandidate.planHash,
      worktreeCountBefore: worktreesBefore.length,
      worktreeCountAfter: worktreesAfter.length,
    };
  } catch (error) {
    const rollbackFailures: string[] = [];
    let branchRemoved = false;
    let contextRemoved = false;
    const currentHead = await git(repositoryRoot, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]).catch(() => null);
    const currentRef = await gitSucceeds(repositoryRoot, [
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ])
      ? await git(repositoryRoot, [
        "symbolic-ref",
        "--quiet",
        "HEAD",
      ]).catch(() => null)
      : null;
    if (currentHead !== head.sourceCommit || currentRef !== previousRef) {
      if (!await gitSucceeds(repositoryRoot, [
        "switch",
        "--detach",
        head.sourceCommit,
      ])) {
        rollbackFailures.push("restore previous commit");
      } else if (previousRef !== null
        && !await gitSucceeds(repositoryRoot, [
          "switch",
          previousRef.slice("refs/heads/".length),
        ])) {
        rollbackFailures.push("restore previous branch");
      }
    }
    if (branchCreated) {
      const checkoutRefAfterRestore = await gitSucceeds(repositoryRoot, [
        "symbolic-ref",
        "--quiet",
        "HEAD",
      ])
        ? await git(repositoryRoot, [
          "symbolic-ref",
          "--quiet",
          "HEAD",
        ]).catch(() => null)
        : null;
      if (checkoutRefAfterRestore === branchRef) {
        rollbackFailures.push(
          "delete newly-created branch while it remains checked out",
        );
      } else {
        const createdBranchCommit = await git(
          repositoryRoot,
          ["rev-parse", "--verify", `${branchRef}^{commit}`],
        ).catch(() => null);
        if (createdBranchCommit === version.targetCommit) {
          if (!await gitSucceeds(repositoryRoot, [
            "update-ref",
            "-d",
            branchRef,
            version.targetCommit,
          ])) {
            rollbackFailures.push("delete newly-created branch");
          } else {
            branchRemoved = true;
          }
        } else if (createdBranchCommit !== null) {
          rollbackFailures.push(
            "delete newly-created branch because its ref changed concurrently",
          );
        }
      }
    }
    if (contextCreated) {
      try {
        const currentContextStat = await lstat(developerContextPath);
        if (contextIdentity === null
          || currentContextStat.dev !== contextIdentity.dev
          || currentContextStat.ino !== contextIdentity.ino) {
          rollbackFailures.push(
            "delete newly-created Developer context because its file identity changed concurrently",
          );
        } else {
          const currentContext = await stableRegularFile(
            developerContextPath,
            1,
            16 * 1024 * 1024,
            "RSI Developer history artifact",
          );
          if (currentContext.sha256 !== contextSha256
            || currentContext.size !== contextBytes.length
            || (currentContext.mode & 0o777) !== 0o600) {
            rollbackFailures.push(
              "delete newly-created Developer context because its contents or mode changed concurrently",
            );
          } else {
            await rm(developerContextPath);
            contextRemoved = true;
          }
        }
      } catch {
        rollbackFailures.push(
          "verify or delete newly-created Developer context",
        );
      }
    }
    const restoredHead = await inspectCleanHead(
      repositoryRoot,
    ).catch(() => null);
    const restoredRef = await gitSucceeds(repositoryRoot, [
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ])
      ? await git(repositoryRoot, [
        "symbolic-ref",
        "--quiet",
        "HEAD",
      ]).catch(() => null)
      : null;
    const restoredWorktrees = await listedWorktreeRoots(
      repositoryRoot,
    ).catch(() => []);
    if (restoredHead?.sourceCommit !== head.sourceCommit
      || restoredHead.sourceTree !== head.sourceTree
      || restoredRef !== previousRef) {
      rollbackFailures.push("verify the restored checkout state");
    }
    if (restoredWorktrees.length !== worktreesBefore.length
      || restoredWorktrees.some((worktree, index) =>
        worktree !== worktreesBefore[index])) {
      rollbackFailures.push("verify the restored worktree topology");
    }
    if (branchCreated && branchRemoved
      && await gitSucceeds(repositoryRoot, [
        "show-ref",
        "--verify",
        "--quiet",
        branchRef,
      ])) {
      rollbackFailures.push("verify removal of the newly-created branch");
    }
    if (contextCreated && contextRemoved) {
      try {
        await lstat(developerContextPath);
        rollbackFailures.push(
          "verify removal of the newly-created Developer context",
        );
      } catch (contextError) {
        if ((contextError as NodeJS.ErrnoException).code !== "ENOENT") {
          rollbackFailures.push(
            "verify removal of the newly-created Developer context",
          );
        }
      }
    }
    if (rollbackFailures.length > 0) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${detail}; automatic rollback failed to ${rollbackFailures.join(
          " and ",
        )}`,
        { cause: error },
      );
    }
    throw error;
  }
  } finally {
    try {
      await rm(transactionLockPath);
    } finally {
      await transactionLock.close();
    }
  }
}

export function buildRsiDeveloperHistoryContext(
  graph: RsiVersionGraph,
): RsiDeveloperHistoryContext {
  return buildDeveloperHistoryContextFromGraph(graph);
}

export interface RsiPublicHistory extends Record<string, unknown> {
  schemaVersion:
    | "pi-rsi-public-history.v1"
    | "pi-rsi-public-history.v2";
  graph: {
    rootVersionId: string;
    selectedVersionId: string;
    decisionHeadId: string | null;
    eventCount: number;
    eventHeadHash: string;
    paperComplete: true;
  };
  artifactPolicy: {
    publicTagPayload:
      "aggregate_metrics_teacher_feedback_and_hash_bindings";
    detailedPublicArtifacts:
      "external_content_addressed_bundle_required";
    evaluatorPrivateMaterial:
      "never_in_public_history";
  };
  versions: Array<{
    versionId: string;
    parentVersionId: string | null;
    sourceCommit: string;
    sourceTree: string;
    manifestHash: string;
    tagObjectId: string;
    changeSummary: string;
    hypothesis: string;
    developmentContextHash: string | null;
    developerExplorationId: string | null;
    epochResumeId: string | null;
    developerPlanHash: string | null;
  }>;
  evaluations: Array<{
    evaluationId: string;
    versionId: string;
    protocolId: string;
    resultKind: RsiEvaluationResultKind;
    publicationMode: "prospective" | "retrospective_legacy";
    publicSummary: RsiEvaluationPublicSummary;
    decision: {
      decisionId: string;
      action: RsiDecisionAction;
      selectedVersionId: string;
      rationale: string;
      decisionHash: string;
      decisionTagObjectId: string;
    };
    claimBoundary: string;
    bindings: {
      openingHash: string;
      openingTagObjectId: string;
      protocolHash: string;
      resultHash: string;
      resultTagObjectId: string;
      resultPublicSummaryHash: string | null;
      publicationHash: string;
      publicationTagObjectId: string;
      artifactHash: string;
      stateRootPublicManifestHash: string | null;
    };
  }>;
  retrospectiveExperiments?: Array<{
    eventSequence: number;
    recordId: string;
    recordCommit: {
      sourceCommit: string;
      sourceTree: string;
    };
    evaluatedSource: {
      sourceCommit: string;
      sourceTree: string;
    };
    formalSelectedVersionId: string;
    changeSummary: string;
    hypothesis: string;
    component: RsiExplorationComponent;
    observations: RsiRetrospectiveObservation[];
    diagnoses: CausalDiagnosis[];
    prioritizedActions: CausalAction[];
    localGateOutcome:
      | "retain_experiment_control"
      | "prefer_experiment_candidate"
      | "inconclusive";
    archiveSealHash: string;
    archivePublicManifestHash: string;
    selectionEligibility:
      "ineligible_never_updates_selected_version";
    promotionEligibility: "ineligible_not_prospective_evidence";
    manifestHash: string;
    tagObjectId: string;
    claimBoundary: typeof RSI_RETROSPECTIVE_CLAIM_BOUNDARY;
  }>;
  canonicalHash: string;
}

export function buildRsiPublicHistory(
  graph: RsiVersionGraph,
): RsiPublicHistory {
  if (!graph.paperComplete || !graph.rootVersionId
    || !graph.selectedVersionId || graph.events.length === 0) {
    throw new Error(
      "paper-ready RSI history requires every non-legacy version to have a prospective protein/Teacher evaluation or an exact approved terminal quality-preflight rejection, with every evaluation completed, published, and decided",
    );
  }
  const decisions = new Map(
    graph.decisions.map(
      (item) => [item.manifest.evaluation.evaluationId, item] as const,
    ),
  );
  const openings = new Map(
    graph.evaluationOpenings.map(
      (item) => [item.manifest.evaluationId, item] as const,
    ),
  );
  const results = new Map(
    graph.evaluationResults.map(
      (item) => [item.manifest.evaluationId, item] as const,
    ),
  );
  const evaluations = graph.evaluationPublications
    .map((publication) => ({
      publication,
      sequence: eventSequenceForRef(graph.events, publication.ref),
    }))
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ publication }) => {
      const decision = decisions.get(publication.manifest.evaluationId);
      const opening = openings.get(publication.manifest.evaluationId);
      const result = results.get(publication.manifest.evaluationId);
      if (!decision || !opening || !result) {
        throw new Error(
          "paper-ready RSI publication lacks a decision, opening, or result",
        );
      }
      return {
        evaluationId: publication.manifest.evaluationId,
        versionId: publication.manifest.version.versionId,
        protocolId: opening.manifest.protocol.protocolId,
        resultKind: publication.manifest.result.kind,
        publicationMode: publication.manifest.publicationMode,
        publicSummary: structuredClone(publication.manifest.publicSummary),
        decision: {
          decisionId: decision.manifest.decisionId,
          action: decision.manifest.action,
          selectedVersionId: decision.manifest.selectedVersion.versionId,
          rationale: decision.manifest.rationale,
          decisionHash: decision.manifest.canonicalHash,
          decisionTagObjectId: decision.tagObjectId,
        },
        claimBoundary: publication.manifest.claimBoundary,
        bindings: {
          openingHash: publication.manifest.opening.manifestHash,
          openingTagObjectId: publication.manifest.opening.tagObjectId,
          protocolHash: publication.manifest.opening.protocolHash,
          resultHash: publication.manifest.result.manifestHash,
          resultTagObjectId: publication.manifest.result.tagObjectId,
          resultPublicSummaryHash:
            result.manifest.result.publicSummaryHash ?? null,
          publicationHash: publication.manifest.canonicalHash,
          publicationTagObjectId: publication.tagObjectId,
          artifactHash: publication.manifest.result.artifactHash,
          stateRootPublicManifestHash:
            publication.manifest.result.stateRootPublicManifestHash,
        },
      };
    });
  const common = {
    graph: {
      rootVersionId: graph.rootVersionId,
      selectedVersionId: graph.selectedVersionId,
      decisionHeadId: graph.decisionHeadId,
      eventCount: graph.events.length,
      eventHeadHash: graph.events.at(-1)!.manifest.canonicalHash,
      paperComplete: true as const,
    },
    artifactPolicy: {
      publicTagPayload:
        "aggregate_metrics_teacher_feedback_and_hash_bindings" as const,
      detailedPublicArtifacts:
        "external_content_addressed_bundle_required" as const,
      evaluatorPrivateMaterial:
        "never_in_public_history" as const,
    },
    versions: graph.versions
      .map((item) => ({
        versionId: item.manifest.versionId,
        parentVersionId: item.manifest.parent?.versionId ?? null,
        sourceCommit: item.manifest.sourceCommit,
        sourceTree: item.manifest.sourceTree,
        manifestHash: item.manifest.canonicalHash,
        tagObjectId: item.tagObjectId,
        changeSummary: item.manifest.change.summary,
        hypothesis: item.manifest.change.hypothesis,
        developmentContextHash:
          item.manifest.developmentContext?.contextHash ?? null,
        developerExplorationId:
          item.manifest.developmentPlan?.schemaVersion
              === RSI_DEVELOPER_EXPLORATION_SCHEMA
            ? item.manifest.developmentPlan.explorationId
            : null,
        epochResumeId:
          item.manifest.developmentPlan?.schemaVersion
              === RSI_EPOCH_RESUME_SCHEMA
            ? item.manifest.developmentPlan.resumeId
            : null,
        developerPlanHash:
          item.manifest.developmentPlan?.planHash ?? null,
      }))
      .sort((left, right) => compareAscii(left.versionId, right.versionId)),
    evaluations,
  };
  const retrospectiveExperiments = graph.retrospectiveExperiments
    .map((item) => ({
      item,
      eventSequence: eventSequenceForRef(graph.events, item.ref),
    }))
    .sort((left, right) => left.eventSequence - right.eventSequence)
    .map(({ item, eventSequence }) => ({
      eventSequence,
      recordId: item.manifest.recordId,
      recordCommit: structuredClone(item.manifest.recordCommit),
      evaluatedSource: structuredClone(item.manifest.evaluatedSource),
      formalSelectedVersionId:
        item.manifest.formalSelection.selectedVersion.versionId,
      changeSummary: item.manifest.experiment.changeSummary,
      hypothesis: item.manifest.experiment.hypothesis,
      component: item.manifest.experiment.component,
      observations: structuredClone(item.manifest.experiment.observations),
      diagnoses: [...item.manifest.experiment.diagnoses],
      prioritizedActions:
        [...item.manifest.experiment.prioritizedActions],
      localGateOutcome: item.manifest.experiment.localGateOutcome,
      archiveSealHash: item.manifest.archive.archiveSealHash,
      archivePublicManifestHash:
        item.manifest.archive.publicManifestHash,
      selectionEligibility:
        item.manifest.policies.selectionEligibility,
      promotionEligibility:
        item.manifest.policies.promotionEligibility,
      manifestHash: item.manifest.canonicalHash,
      tagObjectId: item.tagObjectId,
      claimBoundary: item.manifest.claimBoundary,
    }));
  const value = withCanonicalHash(
    retrospectiveExperiments.length === 0
      ? {
        schemaVersion: "pi-rsi-public-history.v1" as const,
        ...common,
      }
      : {
        schemaVersion: "pi-rsi-public-history.v2" as const,
        ...common,
        retrospectiveExperiments,
      },
  ) as RsiPublicHistory;
  assertPublicManifest(value, "RSI paper-ready public history");
  return value;
}

function metricCell(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function markdownText(value: string): string {
  return value.replace(/[\\`*_[\]<>|]/g, "\\$&");
}

export function renderRsiPublicHistoryMarkdown(
  history: RsiPublicHistory,
): string {
  const lines = [
    "# RSI public evaluation history",
    "",
    `- Root version: \`${history.graph.rootVersionId}\``,
    `- Selected version: \`${history.graph.selectedVersionId}\``,
    `- Event count: ${history.graph.eventCount}`,
    `- Canonical history hash: \`${history.canonicalHash}\``,
    "- Detailed public artifacts: external content-addressed bundle required",
    "- Evaluator-private material: never included in this public history",
    "",
    "| Version | Parent | Evaluation | Evidence | Decision | Overall Fmax (control → candidate) | MF | BP | CC |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const versions = new Map(
    history.versions.map((item) => [item.versionId, item] as const),
  );
  for (const evaluation of history.evaluations) {
    const version = versions.get(evaluation.versionId)!;
    const summary = evaluation.publicSummary;
    const metrics = summary.kind === "adaptive_protein_function"
      ? [
        `${metricCell(summary.control.metrics.overall.fmax)} → ${metricCell(summary.challenger.metrics.overall.fmax)}`,
        `${metricCell(summary.control.metrics.aspects.molecular_function.fmax)} → ${metricCell(summary.challenger.metrics.aspects.molecular_function.fmax)}`,
        `${metricCell(summary.control.metrics.aspects.biological_process.fmax)} → ${metricCell(summary.challenger.metrics.aspects.biological_process.fmax)}`,
        `${metricCell(summary.control.metrics.aspects.cellular_component.fmax)} → ${metricCell(summary.challenger.metrics.aspects.cellular_component.fmax)}`,
      ]
      : ["not a protein evaluation", "n/a", "n/a", "n/a"];
    lines.push(
      `| ${evaluation.versionId} | ${version.parentVersionId ?? "—"} | `
      + `${evaluation.evaluationId} | ${summary.kind} | `
      + `${evaluation.decision.action} → ${evaluation.decision.selectedVersionId} | `
      + `${metrics.join(" | ")} |`,
    );
  }
  lines.push("", "## Teacher feedback and iteration knowledge", "");
  for (const evaluation of history.evaluations) {
    const summary = evaluation.publicSummary;
    const version = versions.get(evaluation.versionId)!;
    lines.push(`### ${evaluation.versionId} / ${evaluation.evaluationId}`, "");
    lines.push(
      `- Publication mode: \`${evaluation.publicationMode}\``,
      `- Source commit: \`${version.sourceCommit}\``,
      `- Source tree: \`${version.sourceTree}\``,
      `- Registered change summary: ${markdownText(version.changeSummary)}`,
      `- Registered hypothesis: ${markdownText(version.hypothesis)}`,
      `- Pre-code plan: \`${
        version.developerExplorationId
          ? `exploration:${version.developerExplorationId}`
          : version.epochResumeId
            ? `epoch-resume:${version.epochResumeId}`
            : "root-or-legacy"
      }\``,
      `- Pre-code Developer plan hash: \`${version.developerPlanHash ?? "root-or-legacy"}\``,
      `- Protocol: \`${evaluation.protocolId}\` / \`${evaluation.bindings.protocolHash}\``,
      `- Protein evaluation: ${
        summary.kind === "adaptive_protein_function"
          ? "yes (adaptive-development aggregate)"
          : "no (software/frozen-replay evidence only)"
      }`,
    );
    if (summary.kind === "adaptive_protein_function") {
      lines.push(
        `- Outcome: \`${summary.challenger.decision}\``,
        `- Hypothesis verdict: \`${summary.teacher.hypothesisVerdict}\``,
        `- Mechanism verdict: \`${summary.teacher.mechanismVerdict}\``,
        `- Diagnoses: ${summary.teacher.diagnoses.length
          ? summary.teacher.diagnoses.map((item) => `\`${item}\``).join(", ")
          : "none"}`,
        `- Prioritized actions: ${summary.teacher.prioritizedActions.length
          ? summary.teacher.prioritizedActions.map((item) => `\`${item}\``).join(", ")
          : "none"}`,
        `- External evidence IDs: ${summary.method.externalEvidenceIds.length
          ? summary.method.externalEvidenceIds.map((item) => `\`${item}\``).join(", ")
          : "none"}`,
        `- Evaluated method hypothesis: ${markdownText(summary.method.hypothesis)}`,
        `- Evaluated method change summary: ${markdownText(summary.method.changeSummary)}`,
      );
    } else {
      lines.push(
        `- Summary: ${markdownText(summary.summary)}`,
        `- Checks: ${summary.checks.map(
          (item) => `\`${item.checkId}:${item.status}\``,
        ).join(", ")}`,
        `- Source artifact claim boundary: ${markdownText(summary.artifactClaimBoundary)}`,
      );
    }
    lines.push(
      `- Decision: \`${evaluation.decision.decisionId}\` / \`${evaluation.decision.action}\` → \`${evaluation.decision.selectedVersionId}\``,
      `- Decision rationale: ${markdownText(evaluation.decision.rationale)}`,
      `- Claim boundary: ${markdownText(evaluation.claimBoundary)}`,
      `- Version manifest/tag: \`${version.manifestHash}\` / \`${version.tagObjectId}\``,
      `- Opening manifest/tag: \`${evaluation.bindings.openingHash}\` / \`${evaluation.bindings.openingTagObjectId}\``,
      `- Result manifest/tag: \`${evaluation.bindings.resultHash}\` / \`${evaluation.bindings.resultTagObjectId}\``,
      `- Result-bound public summary hash: \`${
        evaluation.bindings.resultPublicSummaryHash ?? "legacy-unavailable"
      }\``,
      `- Publication manifest/tag: \`${evaluation.bindings.publicationHash}\` / \`${evaluation.bindings.publicationTagObjectId}\``,
      `- Result artifact hash: \`${evaluation.bindings.artifactHash}\``,
      `- StateRoot public manifest hash: \`${
        evaluation.bindings.stateRootPublicManifestHash ?? "not-applicable"
      }\``,
      `- Decision manifest/tag: \`${evaluation.decision.decisionHash}\` / \`${evaluation.decision.decisionTagObjectId}\``,
      "",
    );
  }
  if (history.retrospectiveExperiments?.length) {
    lines.push(
      "## Retrospective experiment knowledge",
      "",
      "These records preserve pre-contract observations for later reasoning. "
        + "They are not formal code versions and cannot update selection or promotion.",
      "",
    );
    for (const record of history.retrospectiveExperiments) {
      lines.push(
        `### ${record.recordId}`,
        "",
        `- Event sequence: ${record.eventSequence}`,
        `- Record commit/tree: \`${record.recordCommit.sourceCommit}\` / \`${record.recordCommit.sourceTree}\``,
        `- Evaluated commit/tree: \`${record.evaluatedSource.sourceCommit}\` / \`${record.evaluatedSource.sourceTree}\``,
        `- Formal selected version remained: \`${record.formalSelectedVersionId}\``,
        `- Component: \`${record.component}\``,
        `- Change summary: ${markdownText(record.changeSummary)}`,
        `- Hypothesis: ${markdownText(record.hypothesis)}`,
        `- Local gate outcome: \`${record.localGateOutcome}\``,
        `- Diagnoses: ${record.diagnoses.length
          ? record.diagnoses.map((item) => `\`${item}\``).join(", ")
          : "none"}`,
        `- Prioritized actions: ${record.prioritizedActions.length
          ? record.prioritizedActions
            .map((item) => `\`${item}\``).join(", ")
          : "none"}`,
      );
      for (const observation of record.observations) {
        lines.push(
          `- Observation \`${observation.observationId}\` `
            + `(${observation.cohortRole}, ${observation.interpretation}): `
            + `${observation.baseline} → ${observation.candidate} `
            + `(Δ ${observation.candidateMinusBaseline})`,
        );
      }
      lines.push(
        `- Archive seal/public manifest: \`${record.archiveSealHash}\` / \`${record.archivePublicManifestHash}\``,
        `- Selection eligibility: \`${record.selectionEligibility}\``,
        `- Promotion eligibility: \`${record.promotionEligibility}\``,
        `- Manifest/tag: \`${record.manifestHash}\` / \`${record.tagObjectId}\``,
        `- Claim boundary: ${markdownText(record.claimBoundary)}`,
        "",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function writeRsiHistoryArtifact(input: {
  graph: RsiVersionGraph;
  kind: "developer_context" | "paper_json" | "paper_markdown";
  outputPath: string;
}): Promise<{
  outputPath: string;
  sha256: string;
  size: number;
}> {
  const outputPath = resolve(input.outputPath);
  const parent = await realpath(dirname(outputPath));
  const canonicalOutput = join(parent, basename(outputPath));
  const content = input.kind === "developer_context"
    ? `${JSON.stringify(buildRsiDeveloperHistoryContext(input.graph), null, 2)}\n`
    : input.kind === "paper_json"
      ? `${JSON.stringify(buildRsiPublicHistory(input.graph), null, 2)}\n`
      : renderRsiPublicHistoryMarkdown(buildRsiPublicHistory(input.graph));
  try {
    const before = await lstat(canonicalOutput);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error("RSI history output must be a regular non-symlink file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const bytes = Buffer.from(content, "utf8");
  const stagingDir = await mkdtemp(join(parent, ".pi-rsi-history-"));
  const stagingPath = join(stagingDir, "artifact");
  try {
    const handle = await open(
      stagingPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(stagingPath, canonicalOutput);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
  return {
    outputPath: canonicalOutput,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

async function listExplorationTreeFiles(
  root: string,
  relativeRoot = "",
): Promise<string[]> {
  const directory = relativeRoot ? join(root, relativeRoot) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    compareAscii(left.name, right.name))) {
    const relativePath = relativeRoot
      ? join(relativeRoot, entry.name)
      : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `RSI exploration tree contains a symbolic link: ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...await listExplorationTreeFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(
        `RSI exploration tree contains a non-regular entry: ${relativePath}`,
      );
    }
  }
  return files;
}

async function ensureExplorationDirectory(path: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isDirectory()
      || await realpath(path) !== resolve(path)) {
      throw new Error(
        `RSI exploration-tree directory must be canonical and non-symlink: ${path}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { mode: 0o755 });
    const created = await lstat(path);
    if (created.isSymbolicLink() || !created.isDirectory()
      || await realpath(path) !== resolve(path)) {
      throw new Error(
        `RSI exploration-tree directory creation was redirected: ${path}`,
      );
    }
  }
  await chmod(path, 0o755);
}

async function writeOrVerifyExplorationFile(
  path: string,
  content: string,
): Promise<void> {
  const bytes = Buffer.from(content, "utf8");
  try {
    const existing = await stableRegularFile(
      path,
      1,
      16 * 1024 * 1024,
      "RSI exploration-tree artifact",
    );
    if (!existing.bytes.equals(bytes)) {
      throw new Error(
        `RSI exploration-tree immutable artifact changed: ${path}`,
      );
    }
    await chmod(path, 0o644);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await open(
    path,
    constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o644);
}

async function replaceExplorationIndex(
  root: string,
  content: string,
): Promise<void> {
  const path = join(root, "tree.json");
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(
        "RSI exploration-tree index must be a regular non-symlink file",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stagingDir = await mkdtemp(join(root, ".pi-rsi-tree-index-"));
  const stagingPath = join(stagingDir, "tree.json");
  try {
    await writeOrVerifyExplorationFile(stagingPath, content);
    await rename(stagingPath, path);
    await chmod(path, 0o644);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

export async function writeRsiExplorationTree(input: {
  graph: RsiVersionGraph;
  outputDir: string;
}): Promise<{
  outputDir: string;
  treeHash: string;
  explorationCount: number;
  files: Array<{ relativePath: string; sha256: string; size: number }>;
}> {
  if (!input.graph.paperComplete
    || input.graph.developerExplorations.length === 0
    || input.graph.events.length === 0
    || !input.graph.selectedVersionId) {
    throw new Error(
      "RSI exploration-tree export requires a paper-complete graph with at least one immutable Developer exploration",
    );
  }
  const ordered = [...input.graph.developerExplorations].sort(
    (left, right) =>
      eventSequenceForRef(input.graph.events, left.ref)
      - eventSequenceForRef(input.graph.events, right.ref),
  );
  const renderedExplorations = new Map<string, {
    analysis: string;
    plan: string;
  }>();
  for (const tagged of ordered) {
    await assertSchema(
      "rsi_evaluation_analysis.schema.json",
      tagged.manifest.evaluationAnalysis,
      `RSI exploration ${tagged.manifest.explorationId} evaluation analysis`,
    );
    await assertSchema(
      "rsi_next_optimization_plan.schema.json",
      tagged.manifest.nextOptimizationPlan,
      `RSI exploration ${tagged.manifest.explorationId} next plan`,
    );
    await assertSchema(
      "rsi_developer_exploration.schema.json",
      tagged.manifest,
      `RSI exploration ${tagged.manifest.explorationId}`,
    );
    if (tagged.ref !== tagged.manifest.tagRef || !OID.test(tagged.tagObjectId)) {
      throw new Error(
        `RSI exploration ${tagged.manifest.explorationId} has an invalid tag binding`,
      );
    }
    const versionId = tagged.manifest.sourceVersion.versionId;
    const analysis = renderRsiEvaluationAnalysisMarkdown(
      tagged.manifest.evaluationAnalysis,
    );
    const plan = renderRsiNextOptimizationPlanMarkdown(
      tagged.manifest.nextOptimizationPlan,
    );
    const analysisBinding = explorationArtifactBinding(
      `versions/${versionId}/evaluation_analysis.md`,
      analysis,
    );
    const planBinding = explorationArtifactBinding(
      `versions/${versionId}/next_optimization_plan.md`,
      plan,
    );
    if (canonicalJson(tagged.manifest.artifacts)
      !== canonicalJson({
        evaluationAnalysisMarkdown: analysisBinding,
        nextOptimizationPlanMarkdown: planBinding,
      })) {
      throw new Error(
        `RSI exploration ${tagged.manifest.explorationId} artifact bindings do not match the deterministic views`,
      );
    }
    renderedExplorations.set(tagged.manifest.explorationId, {
      analysis,
      plan,
    });
  }
  const requested = resolve(input.outputDir);
  const parent = await realpath(dirname(requested));
  const outputDir = join(parent, basename(requested));
  try {
    const existing = await lstat(outputDir);
    if (existing.isSymbolicLink() || !existing.isDirectory()
      || await realpath(outputDir) !== outputDir) {
      throw new Error(
        "RSI exploration-tree output must be a canonical non-symlink directory",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(outputDir, { mode: 0o755 });
  }
  await chmod(outputDir, 0o755);

  // Inspect the complete existing tree before creating any descendants. This
  // rejects a pre-positioned `versions` or per-version symlink before mkdir
  // could follow it and create artifacts outside the requested export root.
  const existingFiles = await listExplorationTreeFiles(outputDir);
  const expected = new Map<string, string>();
  const versionsDir = join(outputDir, "versions");
  await ensureExplorationDirectory(versionsDir);
  for (const tagged of ordered) {
    const versionId = tagged.manifest.sourceVersion.versionId;
    const versionDir = join(versionsDir, versionId);
    await ensureExplorationDirectory(versionDir);
    const rendered = renderedExplorations.get(
      tagged.manifest.explorationId,
    )!;
    expected.set(
      `versions/${versionId}/evaluation_analysis.md`,
      rendered.analysis,
    );
    expected.set(
      `versions/${versionId}/next_optimization_plan.md`,
      rendered.plan,
    );
    expected.set(
      `versions/${versionId}/manifest.json`,
      `${JSON.stringify(tagged.manifest, null, 2)}\n`,
    );
  }
  const allowedBefore = new Set([...expected.keys(), "tree.json"]);
  for (const relativePath of existingFiles) {
    if (!allowedBefore.has(relativePath)) {
      throw new Error(
        `RSI exploration tree contains an unexpected file: ${relativePath}`,
      );
    }
  }
  for (const [relativePath, content] of expected) {
    await writeOrVerifyExplorationFile(
      join(outputDir, relativePath),
      content,
    );
  }
  const head = input.graph.events.at(-1)!;
  const tree = withCanonicalHash({
    schemaVersion: "pi-rsi-exploration-tree.v1" as const,
    graphHead: {
      eventSequence: head.manifest.sequence,
      eventManifestHash: head.manifest.canonicalHash,
      selectedVersionId: input.graph.selectedVersionId,
      paperComplete: true as const,
      readyForNextVersion: input.graph.readyForNextVersion,
    },
    policy: {
      authority:
        "immutable_rsi_tags_and_events_markdown_is_reproducible_view" as const,
      evaluatorPrivateMaterial: "never_exported" as const,
    },
    entries: ordered.map((item) => ({
      explorationId: item.manifest.explorationId,
      manifestHash: item.manifest.canonicalHash,
      tagObjectId: item.tagObjectId,
      sourceVersionId: item.manifest.sourceVersion.versionId,
      baseVersionId: item.manifest.baseVersion.versionId,
      evaluationId: item.manifest.evaluation.evaluationId,
      action: item.manifest.nextOptimizationPlan.action,
      plannedVersionId:
        item.manifest.nextOptimizationPlan.plannedVersionId,
      evaluationAnalysisHash:
        item.manifest.evaluationAnalysis.canonicalHash,
      planHash: item.manifest.nextOptimizationPlan.canonicalHash,
      artifacts: structuredClone(item.manifest.artifacts),
    })),
  });
  await assertSchema(
    "rsi_exploration_tree.schema.json",
    tree,
    "RSI exploration-tree index",
  );
  await replaceExplorationIndex(
    outputDir,
    `${JSON.stringify(tree, null, 2)}\n`,
  );
  const actual = await listExplorationTreeFiles(outputDir);
  const expectedFinal = [...expected.keys(), "tree.json"].sort(compareAscii);
  if (canonicalJson(actual.sort(compareAscii))
    !== canonicalJson(expectedFinal)) {
    throw new Error(
      "RSI exploration-tree output inventory is incomplete or contains unexpected files",
    );
  }
  const files = await Promise.all(actual.sort(compareAscii).map(
    async (relativePath) => {
      const file = await stableRegularFile(
        join(outputDir, relativePath),
        1,
        16 * 1024 * 1024,
        "RSI exploration-tree artifact",
      );
      return {
        relativePath,
        sha256: file.sha256,
        size: file.size,
      };
    },
  ));
  return {
    outputDir,
    treeHash: tree.canonicalHash,
    explorationCount: ordered.length,
    files,
  };
}

export function renderRsiVersionTree(graph: RsiVersionGraph): string {
  if (graph.versions.length === 0) return "(empty RSI code-version graph)";
  const children = new Map<string, string[]>();
  for (const version of graph.versions) {
    const parent = version.manifest.parent?.versionId;
    if (!parent) continue;
    const list = children.get(parent) ?? [];
    list.push(version.manifest.versionId);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort();
  const evaluationByVersion = new Map<string, string[]>();
  for (const opening of graph.evaluationOpenings) {
    const evaluationId = opening.manifest.evaluationId;
    const state = graph.evaluationPublications.some((item) =>
      item.manifest.evaluationId === evaluationId)
      ? "published"
      : graph.evaluationResults.some((item) =>
        item.manifest.evaluationId === evaluationId)
        ? "completed-unpublished"
        : "opened";
    const list = evaluationByVersion.get(opening.manifest.version.versionId) ?? [];
    list.push(`${evaluationId}:${state}`);
    evaluationByVersion.set(opening.manifest.version.versionId, list);
  }
  const lines: string[] = [];
  const visit = (versionId: string, prefix: string, last: boolean, root: boolean): void => {
    const version = graph.versions.find((item) =>
      item.manifest.versionId === versionId)!;
    const markers = [
      versionId === graph.selectedVersionId
        ? "*last-prospective-selection*"
        : null,
      versionId === graph.currentBestVersionId
        ? "*current-best*"
        : null,
      graph.retrospectivelyAdoptedVersionIds.includes(versionId)
        ? "*retrospective-evidence*"
        : null,
    ].filter((item): item is string => item !== null);
    const marker = markers.length > 0
      ? ` ${markers.join(" ")}`
      : "";
    const evaluations = (evaluationByVersion.get(versionId) ?? []).sort();
    lines.push(
      `${root ? "" : `${prefix}${last ? "└─" : "├─"}`}${versionId}${marker} `
      + `[${version.manifest.sourceCommit.slice(0, 12)}]`
      + `${evaluations.length ? ` eval=${evaluations.join(",")}` : ""}`,
    );
    const descendants = children.get(versionId) ?? [];
    descendants.forEach((child, index) => {
      visit(
        child,
        root ? "" : `${prefix}${last ? "  " : "│ "}`,
        index === descendants.length - 1,
        false,
      );
    });
  };
  visit(graph.rootVersionId!, "", true, true);
  if (graph.retrospectiveExperiments.length > 0) {
    lines.push("retrospective-knowledge:");
    for (const record of [...graph.retrospectiveExperiments].sort(
      (left, right) =>
        eventSequenceForRef(graph.events, left.ref)
          - eventSequenceForRef(graph.events, right.ref),
    )) {
      lines.push(
        `  - ${record.manifest.recordId} `
          + `[evaluated ${record.manifest.evaluatedSource.sourceCommit.slice(0, 12)}] `
          + `gate=${record.manifest.experiment.localGateOutcome} `
          + `selected-unchanged=${record.manifest.formalSelection.selectedVersion.versionId}`,
      );
    }
  }
  if (graph.retrospectiveIncumbents.length > 0) {
    lines.push("current-best-adoptions:");
    for (const adoption of [...graph.retrospectiveIncumbents].sort(
      (left, right) =>
        eventSequenceForRef(graph.events, left.ref)
          - eventSequenceForRef(graph.events, right.ref),
    )) {
      lines.push(
        `  - ${adoption.manifest.adoptionId} `
          + `last-prospective-selection=${adoption.manifest.formalSelection.selectedVersion.versionId} `
          + `current-best=${adoption.manifest.incumbentVersion.versionId} `
          + `next=${adoption.manifest.nextCandidate.plannedVersionId}`,
      );
    }
  }
  if (graph.decisionHeadId) lines.push(`decision-head: ${graph.decisionHeadId}`);
  return lines.join("\n");
}

export function findVersionForCommit(
  graph: RsiVersionGraph,
  sourceCommit: string,
): TaggedManifest<RsiCodeVersionManifest> {
  return versionByCommit(graph, assertOid(sourceCommit, "source commit"));
}
