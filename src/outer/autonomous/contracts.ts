import { hashCanonical } from "../../hash.js";
import { assertExperimentManifest, type RsiExperimentManifest } from "../../experiment/contracts.js";

export const AUTONOMOUS_RSI_STAGES = [
  "evaluate",
  "diagnose",
  "research",
  "plan",
  "develop",
  "verify",
] as const;

export type AutonomousRsiStage = typeof AUTONOMOUS_RSI_STAGES[number];
export type AutonomousRsiStatus = "initialized" | "running" | "stopped" | "completed" | "failed";
export type AutonomousRsiDirection = "maximize" | "minimize";
/** Bounded failure classes used by the controller's recovery policy. */
export type AutonomousRsiFailureClass = "candidate" | "framework" | "policy";
export type AutonomousRsiLifecyclePhase =
  | "test"
  | "diagnose"
  | "research_and_knowledge"
  | "plan"
  | "develop";
export type AutonomousRsiTestGate =
  | "software_verification"
  | "protein_evaluation";

export interface AutonomousRsiCandidate {
  candidateId: string;
  artifactHash: string;
  sourceCommit: string | null;
}

export interface AutonomousRsiWorkerSpec {
  command: string;
  args: string[];
  workingDirectory: "project" | "campaign";
  timeoutSeconds: number;
  inheritEnv: string[];
  networkAccess: "disabled" | "enabled";
}

export interface AutonomousRsiHistoricalSeed {
  seedId: string;
  originCampaignId: string;
  originalCandidateId: string;
  archiveManifestHash: string;
  evaluatorContractHash: string;
  candidate: AutonomousRsiCandidate;
  parentSourceCommit: string | null;
  evaluation: {
    metricId: string;
    value: number;
    iteration: number;
    outputHash: string;
  };
  hypothesis: string | null;
  lesson: string | null;
  verificationPassed: true;
}

export interface AutonomousRsiComparisonReference {
  metricId: string;
  targetMethod: string;
  targetValue: number;
  context: Array<{ method: string; split: string; metric: number; tier: string; diagnosticOnly: boolean }>;
  sourceManifestHash: string;
}

export interface AutonomousRsiSpec extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-spec.v1";
  campaignId: string;
  mode: "development_only";
  objective: {
    metricId: string;
    direction: AutonomousRsiDirection;
    minimumImprovement: number;
    plateauPatience: number;
  };
  budget: {
    maxIterations: number;
    maxStageAttempts: number;
  };
  initialCandidate: AutonomousRsiCandidate;
  /** Present on new production campaigns; absent on frozen legacy specs. */
  evaluatorContractHash?: string | null;
  /** Human-specified train/validation/test split frozen for this campaign. */
  dataSplitManifestHash?: string;
  /** Comparable, verified candidates imported from immutable published campaigns. */
  historicalSeeds?: AutonomousRsiHistoricalSeed[];
  /** Optional, canonical P0/P1 experiment binding; omitted for legacy/integration specs. */
  experiment?: RsiExperimentManifest;
  /** Aggregate-only baseline context exposed to Diagnose/Plan. */
  comparisonReference?: AutonomousRsiComparisonReference;
  workers: Record<AutonomousRsiStage, AutonomousRsiWorkerSpec>;
  formalGovernance: {
    mode: "handoff_only";
    terminalStopEventSequence: number | null;
    terminalStopEventHash: string | null;
    resumeContract: "explicit_append_only_new_epoch_required";
  };
  canonicalHash: string;
}

export interface AutonomousRsiArtifactBinding {
  relativePath: string;
  canonicalHash: string;
}

export interface AutonomousRsiStageInput extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-stage-input.v1";
  campaignId: string;
  iteration: number;
  stage: AutonomousRsiStage;
  currentCandidate: AutonomousRsiCandidate;
  /** Added by the tree-search extension; absent only in frozen legacy v1 inputs. */
  selectedBaseCandidate?: AutonomousRsiCandidate | null;
  objective: AutonomousRsiSpec["objective"];
  knowledgeHeadHash: string | null;
  /** Added by the tree-search extension; absent only in frozen legacy v1 inputs. */
  historyContext?: AutonomousRsiArtifactBinding;
  sourceArtifacts: Record<string, AutonomousRsiArtifactBinding>;
  /** Present when Develop is repairing a candidate rejected by Verify. */
  repairContext?: {
    failedIteration: number;
    planIteration?: number;
    failedCandidate: AutonomousRsiCandidate;
    verification: AutonomousRsiArtifactBinding;
    instruction: "repair_verification_failure_then_reverify";
  };
  experimentContext?: {
    manifestHash: string;
    experimentId: string;
    conditionId: string;
    replicateId: string;
    blockId: string;
    phase: "pilot" | "confirmatory";
    feedbackPolicy: "metric_only" | "structured_diagnostic";
    historyPolicy: "reset" | "persistent" | "shuffled";
    targetValidUpdates: number;
    maxPatchAttempts: number;
  };
  canonicalHash: string;
}

export interface AutonomousRsiStageOutput extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-stage-output.v1";
  campaignId: string;
  iteration: number;
  stage: AutonomousRsiStage;
  status: "completed" | "stop" | "retryable_failure" | "fatal_failure";
  summary: string;
  payload: Record<string, unknown>;
  canonicalHash: string;
}

export interface AutonomousRsiEvent extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-event.v1";
  sequence: number;
  iteration: number;
  stage: AutonomousRsiStage;
  attempt: number;
  inputPath: string;
  inputHash: string;
  outputPath: string;
  outputHash: string;
  previousEventHash: string | null;
  eventHash: string;
}

export interface AutonomousRsiRecoveryReceipt extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-recovery.v1";
  iteration: number;
  stage: AutonomousRsiStage;
  attempt: number;
  inputPath: string;
  inputHash: string;
  sourceAttemptPath: string;
  sourceOutputHash: string;
  resultPath: string;
  resultHash: string;
  classification: AutonomousRsiFailureClass;
  reason: "worker_output_promoted_after_controller_interruption";
  recoveredAt: string;
  canonicalHash: string;
}

export interface AutonomousRsiMetric {
  metricId: string;
  value: number;
  iteration: number;
  candidate: AutonomousRsiCandidate;
}

export interface AutonomousRsiState extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-state.v1";
  campaignId: string;
  specHash: string;
  status: AutonomousRsiStatus;
  nextIteration: number;
  nextStage: AutonomousRsiStage;
  currentCandidate: AutonomousRsiCandidate;
  bestMetric: AutonomousRsiMetric | null;
  plateauRounds: number;
  attempts: Partial<Record<AutonomousRsiStage, number>>;
  lastError: string | null;
  /** Present after a bounded failure/recovery decision; absent in legacy states. */
  lastFailureClass?: AutonomousRsiFailureClass | null;
  /** Append-only receipts for completed worker outputs recovered before event commit. */
  recoveryReceipts?: AutonomousRsiRecoveryReceipt[];
  events: AutonomousRsiEvent[];
  eventHeadHash: string | null;
  knowledgeHeadHash: string | null;
  stopReason: string | null;
  handoffHash: string | null;
  /** Bounded automatic verification-repair state; absent for ordinary iterations. */
  repairOf?: {
    failedIteration: number;
    planIteration?: number;
    failedCandidate: AutonomousRsiCandidate;
    verification: AutonomousRsiArtifactBinding;
  };
  repairAttempts?: number;
  canonicalHash: string;
}

export interface AutonomousRsiCandidateLifecycle {
  schemaVersion: "pi-autonomous-rsi-candidate-lifecycle.v1";
  phase: AutonomousRsiLifecyclePhase;
  testGate: AutonomousRsiTestGate | null;
  internalNextStage: AutonomousRsiStage;
  currentBestCandidate: AutonomousRsiCandidate;
  iterationBaseCandidate: AutonomousRsiCandidate;
  activeCandidate: AutonomousRsiCandidate;
  nextAction:
    | "software_verify_commit_bound_candidate"
    | "protein_evaluate_commit_bound_candidate"
    | "protein_evaluate_initial_candidate"
    | "diagnose_evaluation_feedback"
    | "research_and_distill_knowledge"
    | "plan_from_explicit_base"
    | "develop_and_commit_candidate";
  lifecycle: readonly [
    "plan_from_explicit_base",
    "develop_and_commit_candidate",
    "test.software_verification",
    "test.protein_evaluation",
    "diagnose",
    "research_and_distill_knowledge",
  ];
}

export interface AutonomousRsiKnowledgeEntry extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-knowledge-entry.v1";
  iteration: number;
  evaluatedCandidate: AutonomousRsiCandidate;
  nextCandidate: AutonomousRsiCandidate;
  stageHashes: Record<AutonomousRsiStage, string>;
  previousEntryHash: string | null;
  entryHash: string;
}

export interface AutonomousRsiKnowledgeIndex extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-knowledge-index.v1";
  campaignId: string;
  specHash: string;
  entries: AutonomousRsiKnowledgeEntry[];
  headEntryHash: string | null;
  canonicalHash: string;
}

export interface AutonomousRsiFormalHandoff extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-formal-handoff.v1";
  campaignId: string;
  specHash: string;
  campaignStatus: "stopped" | "completed" | "failed";
  stopReason: string;
  bestMetric: AutonomousRsiMetric | null;
  currentCandidate: AutonomousRsiCandidate;
  selectedCandidate: AutonomousRsiCandidate;
  candidateGraphHash: string;
  eventHeadHash: string | null;
  knowledgeHeadHash: string | null;
  formalGovernance: AutonomousRsiSpec["formalGovernance"];
  requiredNextAction: "review_only" | "explicit_resume_new_epoch_then_plan_register_open";
  claimBoundary: "development evidence only; not a formal RSI version, evaluation opening, selection, or promotion";
  canonicalHash: string;
}

const HASH = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,95}$/;
const GO_ID = /GO:\d{7}/i;
const ACCESSION = /(?:^|[^A-Z0-9])(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-\d+)?(?=$|[^A-Z0-9])/;
const CASE_ID = /(?:^|[^A-Z0-9])CASE(?:[_-][A-Z0-9]+)+(?=$|[^A-Z0-9])/i;
const SENSITIVE_KEY = /^(?:accessions?|proteins?|cases?|go(?:_?ids?|_?terms?)?|gold.*|private.*|targets?|sequences?|structures?|answers?|labels?)$/i;
const DEVELOPER_FORBIDDEN_PATH = /(?:^|[\\/._-])(?:private|evaluator[_-]?private|gold)(?:$|[\\/._-])/i;
const SECRET_ENV = /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL|COOKIE)$/i;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} has unexpected or missing keys`);
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} is not a safe identifier`);
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} is not a SHA-256 hash`);
  return value;
}

function sourceCommit(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !OID.test(value)) throw new Error(`${label} is not a Git object id`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return Number(value);
}

function safeText(value: unknown, label: string, maximum = 2000): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function canonical<T extends Record<string, unknown>>(value: T, label: string): T {
  const { canonicalHash, ...content } = value;
  if (typeof canonicalHash !== "string" || canonicalHash !== hashCanonical(content)) {
    throw new Error(`${label} canonical hash mismatch`);
  }
  return value;
}

export function withAutonomousCanonicalHash<T extends Record<string, unknown>>(
  content: T,
): T & { canonicalHash: string } {
  return { ...content, canonicalHash: hashCanonical(content) };
}

export function assertAutonomousCandidate(value: unknown, label: string): AutonomousRsiCandidate {
  const item = record(value, label);
  exactKeys(item, ["candidateId", "artifactHash", "sourceCommit"], label);
  return {
    candidateId: safeId(item.candidateId, `${label}.candidateId`),
    artifactHash: hash(item.artifactHash, `${label}.artifactHash`),
    sourceCommit: sourceCommit(item.sourceCommit, `${label}.sourceCommit`),
  };
}

function assertWorker(value: unknown, stage: AutonomousRsiStage): AutonomousRsiWorkerSpec {
  const item = record(value, `workers.${stage}`);
  exactKeys(item, ["command", "args", "workingDirectory", "timeoutSeconds", "inheritEnv", "networkAccess"], `workers.${stage}`);
  const command = safeText(item.command, `workers.${stage}.command`, 512);
  if (/[\r\n\0]/.test(command)) throw new Error(`workers.${stage}.command contains unsafe control characters`);
  if (!Array.isArray(item.args) || item.args.length > 64 || item.args.some((arg) => typeof arg !== "string" || arg.length > 2048 || /[\r\n\0]/.test(arg))) {
    throw new Error(`workers.${stage}.args must be a bounded string array`);
  }
  if (item.workingDirectory !== "project" && item.workingDirectory !== "campaign") {
    throw new Error(`workers.${stage}.workingDirectory is invalid`);
  }
  if (item.networkAccess !== "disabled" && item.networkAccess !== "enabled") {
    throw new Error(`workers.${stage}.networkAccess is invalid`);
  }
  if (!Array.isArray(item.inheritEnv) || item.inheritEnv.length > 32) throw new Error(`workers.${stage}.inheritEnv is invalid`);
  const inheritEnv = item.inheritEnv.map((name, index) => {
    if (typeof name !== "string" || !ENV_NAME.test(name)) throw new Error(`workers.${stage}.inheritEnv[${index}] is invalid`);
    if (stage !== "research" && SECRET_ENV.test(name)) {
      throw new Error(`workers.${stage} cannot inherit secret-bearing environment variable ${name}`);
    }
    return name;
  });
  if (new Set(inheritEnv).size !== inheritEnv.length) throw new Error(`workers.${stage}.inheritEnv contains duplicates`);
  if (stage !== "evaluate") {
    const serialized = [command, ...(item.args as string[])].join(" ");
    if (DEVELOPER_FORBIDDEN_PATH.test(serialized)) throw new Error(`workers.${stage} references a private/evaluator path`);
  }
  return {
    command,
    args: [...item.args] as string[],
    workingDirectory: item.workingDirectory,
    timeoutSeconds: boundedInteger(item.timeoutSeconds, 1, 86_400, `workers.${stage}.timeoutSeconds`),
    inheritEnv,
    networkAccess: item.networkAccess,
  };
}

export function assertAutonomousRsiSpec(value: unknown): AutonomousRsiSpec {
  const item = canonical(record(value, "autonomous RSI spec"), "autonomous RSI spec");
  exactKeys(item, [
    "schemaVersion", "campaignId", "mode", "objective", "budget", "initialCandidate", "workers", "formalGovernance", "canonicalHash",
    ...(item.evaluatorContractHash !== undefined ? ["evaluatorContractHash"] : []),
    ...(item.dataSplitManifestHash !== undefined ? ["dataSplitManifestHash"] : []),
    ...(item.historicalSeeds !== undefined ? ["historicalSeeds"] : []),
    ...(item.experiment !== undefined ? ["experiment"] : []),
    ...(item.comparisonReference !== undefined ? ["comparisonReference"] : []),
  ], "autonomous RSI spec");
  if (item.schemaVersion !== "pi-autonomous-rsi-spec.v1" || item.mode !== "development_only") {
    throw new Error("unsupported autonomous RSI spec mode/schema");
  }
  safeId(item.campaignId, "campaignId");
  const objective = record(item.objective, "objective");
  exactKeys(objective, ["metricId", "direction", "minimumImprovement", "plateauPatience"], "objective");
  safeId(objective.metricId, "objective.metricId");
  if (objective.direction !== "maximize" && objective.direction !== "minimize") throw new Error("objective.direction is invalid");
  if (finite(objective.minimumImprovement, "objective.minimumImprovement") < 0) {
    throw new Error("objective.minimumImprovement must be nonnegative");
  }
  boundedInteger(objective.plateauPatience, 1, 10_000, "objective.plateauPatience");
  const budget = record(item.budget, "budget");
  exactKeys(budget, ["maxIterations", "maxStageAttempts"], "budget");
  boundedInteger(budget.maxIterations, 1, 10_000, "budget.maxIterations");
  boundedInteger(budget.maxStageAttempts, 1, 100, "budget.maxStageAttempts");
  const initialCandidate = assertAutonomousCandidate(item.initialCandidate, "initialCandidate");
  if (item.evaluatorContractHash !== undefined && item.evaluatorContractHash !== null) {
    hash(item.evaluatorContractHash, "evaluatorContractHash");
  }
  if (item.dataSplitManifestHash !== undefined) hash(item.dataSplitManifestHash, "dataSplitManifestHash");
  if (item.comparisonReference !== undefined) {
    const reference = record(item.comparisonReference, "comparisonReference");
    exactKeys(reference, ["metricId", "targetMethod", "targetValue", "context", "sourceManifestHash"], "comparisonReference");
    safeId(reference.metricId, "comparisonReference.metricId");
    safeText(reference.targetMethod, "comparisonReference.targetMethod");
    finite(reference.targetValue, "comparisonReference.targetValue");
    hash(reference.sourceManifestHash, "comparisonReference.sourceManifestHash");
    if (!Array.isArray(reference.context) || reference.context.length > 256) throw new Error("comparisonReference.context is invalid");
    reference.context.forEach((raw, index) => {
      const row = record(raw, `comparisonReference.context[${index}]`);
      exactKeys(row, ["method", "split", "metric", "tier", "diagnosticOnly"], `comparisonReference.context[${index}]`);
      safeText(row.method, `comparisonReference.context[${index}].method`);
      safeText(row.split, `comparisonReference.context[${index}].split`);
      finite(row.metric, `comparisonReference.context[${index}].metric`);
      safeText(row.tier, `comparisonReference.context[${index}].tier`);
      if (typeof row.diagnosticOnly !== "boolean") throw new Error(`comparisonReference.context[${index}].diagnosticOnly is invalid`);
    });
  }
  if (item.experiment !== undefined) {
    const experiment = assertExperimentManifest(item.experiment);
    if (experiment.framework !== "latest_autonomous" || experiment.campaignId !== item.campaignId) throw new Error("LatestRSI experiment binding has the wrong framework/campaign");
    if (experiment.initialCandidate.candidateId !== initialCandidate.candidateId || experiment.initialCandidate.artifactHash !== initialCandidate.artifactHash || experiment.initialCandidate.sourceCommit !== initialCandidate.sourceCommit) throw new Error("LatestRSI experiment initial candidate differs from the RSI spec");
    if (item.evaluatorContractHash !== experiment.bindings.evaluatorContractHash) throw new Error("LatestRSI experiment evaluator contract differs from the RSI spec");
    if (experiment.budget.maxStageAttempts !== budget.maxStageAttempts) throw new Error("LatestRSI experiment stage-attempt budget differs from the RSI spec");
  }
  if (item.historicalSeeds !== undefined) {
    if (!Array.isArray(item.historicalSeeds) || item.historicalSeeds.length > 2048) {
      throw new Error("historicalSeeds must be a bounded array");
    }
    const seedIds = new Set<string>();
    const sourceCommits = new Set<string>();
    for (const [index, raw] of item.historicalSeeds.entries()) {
      const seed = record(raw, `historicalSeeds[${index}]`);
      exactKeys(seed, [
        "archiveManifestHash", "candidate", "evaluation", "evaluatorContractHash", "hypothesis", "lesson",
        "originCampaignId", "originalCandidateId", "parentSourceCommit", "seedId", "verificationPassed",
      ], `historicalSeeds[${index}]`);
      const seedId = safeId(seed.seedId, `historicalSeeds[${index}].seedId`);
      if (seedIds.has(seedId)) throw new Error("historicalSeeds contains duplicate seedId values");
      seedIds.add(seedId);
      safeId(seed.originCampaignId, `historicalSeeds[${index}].originCampaignId`);
      safeId(seed.originalCandidateId, `historicalSeeds[${index}].originalCandidateId`);
      hash(seed.archiveManifestHash, `historicalSeeds[${index}].archiveManifestHash`);
      const evaluatorHash = hash(seed.evaluatorContractHash, `historicalSeeds[${index}].evaluatorContractHash`);
      if (item.evaluatorContractHash !== evaluatorHash) throw new Error("historical seed evaluator contract is not comparable with this campaign");
      const candidate = assertAutonomousCandidate(seed.candidate, `historicalSeeds[${index}].candidate`);
      if (!candidate.sourceCommit) throw new Error("historical seed must be commit-bound");
      if (candidate.sourceCommit === initialCandidate.sourceCommit || sourceCommits.has(candidate.sourceCommit)) {
        throw new Error("historicalSeeds contains a duplicate current/seed source commit");
      }
      sourceCommits.add(candidate.sourceCommit);
      sourceCommit(seed.parentSourceCommit, `historicalSeeds[${index}].parentSourceCommit`);
      const evaluation = record(seed.evaluation, `historicalSeeds[${index}].evaluation`);
      exactKeys(evaluation, ["iteration", "metricId", "outputHash", "value"], `historicalSeeds[${index}].evaluation`);
      if (evaluation.metricId !== objective.metricId) throw new Error("historical seed metric is not comparable with this campaign");
      finite(evaluation.value, `historicalSeeds[${index}].evaluation.value`);
      boundedInteger(evaluation.iteration, 0, Number.MAX_SAFE_INTEGER, `historicalSeeds[${index}].evaluation.iteration`);
      hash(evaluation.outputHash, `historicalSeeds[${index}].evaluation.outputHash`);
      if (seed.hypothesis !== null) safeText(seed.hypothesis, `historicalSeeds[${index}].hypothesis`);
      if (seed.lesson !== null) safeText(seed.lesson, `historicalSeeds[${index}].lesson`);
      if (seed.verificationPassed !== true) throw new Error("historical seed must have passed verification");
    }
  }
  const workers = record(item.workers, "workers");
  exactKeys(workers, AUTONOMOUS_RSI_STAGES, "workers");
  for (const stage of AUTONOMOUS_RSI_STAGES) assertWorker(workers[stage], stage);
  const formal = record(item.formalGovernance, "formalGovernance");
  exactKeys(formal, ["mode", "terminalStopEventSequence", "terminalStopEventHash", "resumeContract"], "formalGovernance");
  if (formal.mode !== "handoff_only" || formal.resumeContract !== "explicit_append_only_new_epoch_required") {
    throw new Error("autonomous orchestration may only produce a formal handoff");
  }
  const stopSequence = formal.terminalStopEventSequence === null
    ? null
    : boundedInteger(formal.terminalStopEventSequence, 1, Number.MAX_SAFE_INTEGER, "formalGovernance.terminalStopEventSequence");
  const stopHash = formal.terminalStopEventHash === null ? null : hash(formal.terminalStopEventHash, "formalGovernance.terminalStopEventHash");
  if ((stopSequence === null) !== (stopHash === null)) throw new Error("formal stop sequence/hash must both be null or both be set");
  return item as unknown as AutonomousRsiSpec;
}

function assertNoSensitiveDeveloperValue(value: unknown, label: string): void {
  const visit = (current: unknown, path: string): void => {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (current && typeof current === "object") {
      for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
        if (SENSITIVE_KEY.test(key)) throw new Error(`${label} contains forbidden key at ${path}.${key}`);
        visit(entry, `${path}.${key}`);
      }
      return;
    }
    if (typeof current === "string" && (GO_ID.test(current) || ACCESSION.test(current) || CASE_ID.test(current) || DEVELOPER_FORBIDDEN_PATH.test(current))) {
      throw new Error(`${label} contains private/identifier-like content at ${path}`);
    }
  };
  visit(value, label);
}

function stringArray(value: unknown, label: string, maximumItems = 32): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${label} must be a bounded array`);
  return value.map((entry, index) => safeText(entry, `${label}[${index}]`, 1200));
}

export function assertAutonomousStageOutput(
  value: unknown,
  expected: {
    campaignId: string;
    iteration: number;
    stage: AutonomousRsiStage;
    spec: AutonomousRsiSpec;
    candidate: AutonomousRsiCandidate;
    baseCandidate?: AutonomousRsiCandidate;
  },
): AutonomousRsiStageOutput {
  const item = canonical(record(value, `${expected.stage} output`), `${expected.stage} output`);
  exactKeys(item, ["schemaVersion", "campaignId", "iteration", "stage", "status", "summary", "payload", "canonicalHash"], `${expected.stage} output`);
  if (item.schemaVersion !== "pi-autonomous-rsi-stage-output.v1"
    || item.campaignId !== expected.campaignId
    || item.iteration !== expected.iteration
    || item.stage !== expected.stage
    || !["completed", "stop", "retryable_failure", "fatal_failure"].includes(String(item.status))) {
    throw new Error(`${expected.stage} output does not bind the active stage`);
  }
  safeText(item.summary, `${expected.stage}.summary`);
  const payload = record(item.payload, `${expected.stage}.payload`);
  assertNoSensitiveDeveloperValue(payload, `${expected.stage}.payload`);
  if (item.status === "completed") {
    if (expected.stage === "evaluate") {
      const candidate = assertAutonomousCandidate(payload.candidate, "evaluate.payload.candidate");
      if (candidate.candidateId !== expected.candidate.candidateId || candidate.artifactHash !== expected.candidate.artifactHash) {
        throw new Error("evaluation output is bound to a different candidate");
      }
      const metric = record(payload.metric, "evaluate.payload.metric");
      exactKeys(metric, ["metricId", "value"], "evaluate.payload.metric");
      if (metric.metricId !== expected.spec.objective.metricId) throw new Error("evaluation metric id does not match the objective");
      finite(metric.value, "evaluate.payload.metric.value");
      if (payload.decision !== "continue" && payload.decision !== "stop") throw new Error("evaluate.payload.decision is invalid");
      const feedback = record(payload.feedback, "evaluate.payload.feedback");
      if (expected.spec.experiment?.feedbackPolicy === "metric_only" && feedback.structuredDiagnostic !== undefined) throw new Error("metric_only condition cannot expose structuredDiagnostic feedback");
      if (expected.spec.experiment?.phase === "confirmatory" && expected.spec.experiment.feedbackPolicy === "structured_diagnostic" && feedback.structuredDiagnostic === undefined) throw new Error("confirmatory structured_diagnostic condition requires structuredDiagnostic feedback");
    } else if (expected.stage === "diagnose") {
      stringArray(payload.diagnoses, "diagnose.payload.diagnoses");
      stringArray(payload.prioritizedActions, "diagnose.payload.prioritizedActions");
      if (payload.stopReason !== null) safeText(payload.stopReason, "diagnose.payload.stopReason");
      if (payload.lesson !== undefined) safeText(payload.lesson, "diagnose.payload.lesson");
      if (payload.primaryProblemSource !== undefined
        && !["parameter_or_hyperparameter", "implementation_or_pipeline", "method_or_tool_capability", "evaluation_or_measurement", "no_safe_action"].includes(String(payload.primaryProblemSource))) {
        throw new Error("diagnose.payload.primaryProblemSource is invalid");
      }
      if (payload.secondaryProblemSources !== undefined) {
        const secondary = stringArray(payload.secondaryProblemSources, "diagnose.payload.secondaryProblemSources", 4);
        if (secondary.some((source) => !["parameter_or_hyperparameter", "implementation_or_pipeline", "method_or_tool_capability", "evaluation_or_measurement"].includes(source))) {
          throw new Error("diagnose.payload.secondaryProblemSources contains an invalid source");
        }
      }
      if (payload.rootCauseRationale !== undefined) safeText(payload.rootCauseRationale, "diagnose.payload.rootCauseRationale");
      if (payload.researchRequired !== undefined && typeof payload.researchRequired !== "boolean") {
        throw new Error("diagnose.payload.researchRequired must be boolean");
      }
      if (payload.researchScope !== undefined
        && payload.researchScope !== null
        && payload.researchScope !== "function_prediction_process_or_method_improvement") {
        throw new Error("diagnose.payload.researchScope must be the process/method scope or null");
      }
      if (payload.researchQuestions !== undefined) {
        stringArray(payload.researchQuestions, "diagnose.payload.researchQuestions", 16);
      }
    } else if (expected.stage === "research") {
      const disposition = payload.disposition ?? "completed";
      if (disposition !== "completed" && disposition !== "not_required") {
        throw new Error("research.payload.disposition is invalid");
      }
      const minimumCards = disposition === "not_required" ? 0 : 1;
      if (!Array.isArray(payload.cards) || payload.cards.length < minimumCards || payload.cards.length > 32) {
        throw new Error(`research.payload.cards must contain ${minimumCards}..32 sanitized research cards`);
      }
      if (payload.researchScope !== undefined
        && payload.researchScope !== null
        && payload.researchScope !== "function_prediction_process_or_method_improvement") {
        throw new Error("research.payload.researchScope must be the process/method scope or null");
      }
      if (payload.sources !== undefined && !Array.isArray(payload.sources)) {
        throw new Error("research.payload.sources must be an array");
      }
      payload.cards.forEach((card, index) => {
        const entry = record(card, `research.payload.cards[${index}]`);
        safeId(entry.evidenceId, `research.payload.cards[${index}].evidenceId`);
        if (entry.sourceIds !== undefined) stringArray(entry.sourceIds, `research.payload.cards[${index}].sourceIds`, 8);
        safeText(entry.finding, `research.payload.cards[${index}].finding`, 2000);
        stringArray(entry.limitations, `research.payload.cards[${index}].limitations`, 8);
        stringArray(entry.supportedActions, `research.payload.cards[${index}].supportedActions`, 16);
      });
    } else if (expected.stage === "plan") {
      safeId(payload.planId, "plan.payload.planId");
      safeText(payload.hypothesis, "plan.payload.hypothesis");
      stringArray(payload.changeTargets, "plan.payload.changeTargets", 32);
      if (payload.changeFamily !== undefined) safeId(payload.changeFamily, "plan.payload.changeFamily");
      if (payload.predictedEffects !== undefined) {
        if (!Array.isArray(payload.predictedEffects) || payload.predictedEffects.length < 1 || payload.predictedEffects.length > 64) throw new Error("plan.payload.predictedEffects must contain 1..64 entries");
        payload.predictedEffects.forEach((raw, index) => {
          const effect = record(raw, `plan.payload.predictedEffects[${index}]`);
          exactKeys(effect, ["metricId", "sliceId", "direction", "minimumDelta"], `plan.payload.predictedEffects[${index}]`);
          safeId(effect.metricId, `plan.payload.predictedEffects[${index}].metricId`);
          safeId(effect.sliceId, `plan.payload.predictedEffects[${index}].sliceId`);
          if (!["increase", "decrease", "unchanged"].includes(String(effect.direction))) throw new Error("plan predicted effect direction is invalid");
          if (effect.minimumDelta !== null) finite(effect.minimumDelta, `plan.payload.predictedEffects[${index}].minimumDelta`);
        });
      }
      if (expected.spec.experiment && (payload.changeFamily === undefined || payload.predictedEffects === undefined)) throw new Error("instrumented plan must precommit changeFamily and predictedEffects");
      stringArray(payload.controls, "plan.payload.controls", 16);
      stringArray(payload.falsifiers, "plan.payload.falsifiers", 16);
      safeText(payload.rollbackCondition, "plan.payload.rollbackCondition");
      if (payload.baseCandidateId !== undefined) safeId(payload.baseCandidateId, "plan.payload.baseCandidateId");
      if (payload.baseRationale !== undefined) safeText(payload.baseRationale, "plan.payload.baseRationale");
      if (payload.branchAction !== undefined
        && payload.branchAction !== "continue"
        && payload.branchAction !== "backtrack"
        && payload.branchAction !== "branch") {
        throw new Error("plan.payload.branchAction is invalid");
      }
      if (payload.historyEvidenceIds !== undefined) stringArray(payload.historyEvidenceIds, "plan.payload.historyEvidenceIds", 64);
      if (payload.knowledgeEvidenceIds !== undefined) stringArray(payload.knowledgeEvidenceIds, "plan.payload.knowledgeEvidenceIds", 64);
    } else if (expected.stage === "develop") {
      const candidate = assertAutonomousCandidate(payload.candidate, "develop.payload.candidate");
      const base = expected.baseCandidate ?? expected.candidate;
      if (candidate.artifactHash === base.artifactHash) throw new Error("development produced no candidate change");
      if (candidate.sourceCommit === null) {
        throw new Error(
          "development must commit the candidate before the Test phase",
        );
      }
    } else if (expected.stage === "verify") {
      const candidate = assertAutonomousCandidate(payload.candidate, "verify.payload.candidate");
      if (typeof payload.passed !== "boolean") throw new Error("verify.payload.passed must be boolean");
      stringArray(payload.checks, "verify.payload.checks", 64);
      const base = expected.baseCandidate ?? expected.candidate;
      if (candidate.artifactHash === base.artifactHash) throw new Error("verification returned the unchanged parent candidate");
      if (candidate.sourceCommit === null) {
        throw new Error(
          "software verification requires a commit-bound candidate",
        );
      }
    }
  }
  return item as unknown as AutonomousRsiStageOutput;
}

export function metricImproved(
  direction: AutonomousRsiDirection,
  previous: number,
  current: number,
  minimumImprovement: number,
): boolean {
  return direction === "maximize"
    ? current - previous >= minimumImprovement
    : previous - current >= minimumImprovement;
}

export function autonomousStageRole(stage: AutonomousRsiStage): "developer" | "evaluator" {
  return stage === "evaluate" ? "evaluator" : "developer";
}

/**
 * Candidate-centric view of the replay-compatible internal stage machine.
 * `verify` and `evaluate` stay distinct internally because they run in
 * different trust domains, while callers see them as two gates of one Test
 * phase.
 */
export function projectAutonomousRsiCandidateLifecycle(
  state: AutonomousRsiState,
  activeCandidate: AutonomousRsiCandidate = state.currentCandidate,
): AutonomousRsiCandidateLifecycle {
  const currentBestCandidate =
    state.bestMetric?.candidate ?? state.currentCandidate;
  const shared = {
    schemaVersion: "pi-autonomous-rsi-candidate-lifecycle.v1" as const,
    internalNextStage: state.nextStage,
    currentBestCandidate,
    iterationBaseCandidate: state.currentCandidate,
    activeCandidate,
    lifecycle: [
      "plan_from_explicit_base",
      "develop_and_commit_candidate",
      "test.software_verification",
      "test.protein_evaluation",
      "diagnose",
      "research_and_distill_knowledge",
    ] as const,
  };
  if (state.nextStage === "verify") {
    return {
      ...shared,
      phase: "test",
      testGate: "software_verification",
      nextAction: "software_verify_commit_bound_candidate",
    };
  }
  if (state.nextStage === "evaluate") {
    return {
      ...shared,
      phase: "test",
      testGate: "protein_evaluation",
      nextAction: activeCandidate.sourceCommit === null
        ? "protein_evaluate_initial_candidate"
        : "protein_evaluate_commit_bound_candidate",
    };
  }
  if (state.nextStage === "diagnose") {
    return {
      ...shared,
      phase: "diagnose",
      testGate: null,
      nextAction: "diagnose_evaluation_feedback",
    };
  }
  if (state.nextStage === "research") {
    return {
      ...shared,
      phase: "research_and_knowledge",
      testGate: null,
      nextAction: "research_and_distill_knowledge",
    };
  }
  if (state.nextStage === "plan") {
    return {
      ...shared,
      phase: "plan",
      testGate: null,
      nextAction: "plan_from_explicit_base",
    };
  }
  return {
    ...shared,
    phase: "develop",
    testGate: null,
    nextAction: "develop_and_commit_candidate",
  };
}
