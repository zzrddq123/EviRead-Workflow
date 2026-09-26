import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "../../codex_runtime.js";
import { Type } from "typebox";

import { hashCanonical } from "../../hash.js";
import { assertCandidatePaths } from "../../experiment/candidate_guard.js";
import { configureSdkNetwork } from "../../network.js";
import { capabilityWorkerEnvironment, createToolAcquisitionTool } from "../../experiment/tool_acquisition_broker.js";
import { createTrainingReadTool, verifyRsiDataSplitBinding, type TrainingBinding } from "../../data_split.js";
import {
  assertAutonomousHistoryContext,
  type AutonomousRsiHistoryContext,
} from "./history_context.js";
import {
  AUTONOMOUS_RSI_STAGES,
  assertAutonomousCandidate,
  assertAutonomousRsiSpec,
  assertAutonomousStageOutput,
  withAutonomousCanonicalHash,
  type AutonomousRsiCandidate,
  type AutonomousRsiSpec,
  type AutonomousRsiStage,
  type AutonomousRsiStageInput,
  type AutonomousRsiStageOutput,
} from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface CommandSpec {
  executable: string;
  args: string[];
  timeoutMs: number;
  inheritEnv: string[];
}

interface VerificationCommand extends CommandSpec {
  id: string;
}

export type AutonomousRsiMethodResearchScope = "function_prediction_process_or_method_improvement";
export type AutonomousRsiProblemSource =
  | "parameter_or_hyperparameter"
  | "implementation_or_pipeline"
  | "method_or_tool_capability"
  | "evaluation_or_measurement"
  | "no_safe_action";
export type AutonomousRsiResearchSourceType =
  | "peer_reviewed_primary"
  | "peer_reviewed_review"
  | "official_tool_or_database_documentation";
export type AutonomousRsiResearchQualityTier =
  | "q1_journal"
  | "top_venue"
  | "authoritative_official_documentation";

export interface AutonomousRsiMethodResearchSource extends Record<string, unknown> {
  sourceId: string;
  sourceType: AutonomousRsiResearchSourceType;
  qualityTier: AutonomousRsiResearchQualityTier;
  qualityEvidence: string;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  persistentId: string;
  url: string;
  relevantFindings: string[];
  limitations: string[];
}

export interface AutonomousRsiMethodResearchMaterial extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-method-research-material.v1";
  researchScope: AutonomousRsiMethodResearchScope;
  questions: string[];
  sources: AutonomousRsiMethodResearchSource[];
}

export interface MethodResearchPolicy {
  scope: AutonomousRsiMethodResearchScope;
  targetSpecificResearch: "forbidden";
  scholarlySourceTiers: ["q1_journal", "top_venue"];
  minimumIndependentScholarlySources: number;
  officialDocumentationRole: "implementation_details_only";
  unadmittedSources: ["preprints", "blogs", "forums", "vendor_marketing"];
}

interface ProductionWorkerConfig {
  developmentObjective?: string;
  schemaVersion: "pi-autonomous-rsi-production-worker-config.v1";
  repositoryRoot: string;
  workspaceRoot: string;
  allowedChangePaths: string[];
  protectedChangePaths: string[];
  model: {
    provider: string;
    id: string;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  };
  knowledgeBackend: "pi" | "command";
  developmentBackend: "pi" | "command";
  knowledgeCommand?: CommandSpec;
  developmentCommand?: CommandSpec;
  researchCommand?: CommandSpec;
  methodResearchPolicy: MethodResearchPolicy;
  verificationCommands: VerificationCommand[];
  evaluatorCommandEnv: string;
  evaluatorPrivateEnv: string[];
  dataSplit?: {
    manifestPath: string;
    manifestHash: string;
    training: TrainingBinding;
    validation: { proteinsFile: string; goldRoot: string; goldAccess: "evaluator_only"; evaluationPhase?: "during_rsi" | "after_freeze_only" };
    test: { proteinsFile: string; goldRoot: string; goldAccess: "evaluator_only"; evaluationPhase?: "during_rsi" | "after_freeze_only" };
  };
  runtimeAttestations: {
    sandboxEnforced: boolean;
    nonResearchNetworkIsModelControlPlaneOnly: boolean;
    evaluatorPrivateDataIsolated: boolean;
  };
  canonicalHash: string;
}

interface WorkspaceRecord {
  schemaVersion: "pi-autonomous-rsi-workspace-record.v1";
  campaignId: string;
  candidateId: string;
  iteration: number;
  parentCommit: string;
  sourceCommit: string;
  sourceTree: string;
  workspaceRelativePath: string;
  canonicalHash: string;
}

const METHOD_RESEARCH_SCOPE: AutonomousRsiMethodResearchScope = "function_prediction_process_or_method_improvement";
const PROBLEM_SOURCES: readonly AutonomousRsiProblemSource[] = [
  "parameter_or_hyperparameter",
  "implementation_or_pipeline",
  "method_or_tool_capability",
  "evaluation_or_measurement",
  "no_safe_action",
];
const SCHOLARLY_SOURCE_TYPES = new Set<AutonomousRsiResearchSourceType>(["peer_reviewed_primary", "peer_reviewed_review"]);
const SCHOLARLY_QUALITY_TIERS = new Set<AutonomousRsiResearchQualityTier>(["q1_journal", "top_venue"]);
const TARGET_SPECIFIC_RESEARCH = /(?:this|the|query|target|specific)\s+protein|(?:该|此|目标|待预测)蛋白/i;
const DOI_OR_PMID = /^(?:doi:10\.\d{4,9}\/\S+|pmid:\d+)$/i;

const DiagnosisParameters = Type.Object({
  diagnoses: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), { minItems: 1, maxItems: 32 }),
  prioritizedActions: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), { minItems: 1, maxItems: 32 }),
  lesson: Type.String({ minLength: 1, maxLength: 2000 }),
  primaryProblemSource: Type.Union(PROBLEM_SOURCES.map((source) => Type.Literal(source))),
  secondaryProblemSources: Type.Array(Type.Union(PROBLEM_SOURCES.slice(0, -1).map((source) => Type.Literal(source))), { maxItems: 4 }),
  rootCauseRationale: Type.String({ minLength: 1, maxLength: 2000 }),
  researchRequired: Type.Boolean(),
  researchScope: Type.Union([Type.Literal(METHOD_RESEARCH_SCOPE), Type.Null()]),
  researchQuestions: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), { maxItems: 16 }),
  stopReason: Type.Union([Type.String({ minLength: 1, maxLength: 1200 }), Type.Null()]),
}, { additionalProperties: false });

const ResearchParameters = Type.Object({
  cards: Type.Array(Type.Object({
    evidenceId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$" }),
    sourceIds: Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$" }), { minItems: 1, maxItems: 8 }),
    finding: Type.String({ minLength: 1, maxLength: 2000 }),
    limitations: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), { maxItems: 8 }),
    supportedActions: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), { minItems: 1, maxItems: 16 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false });

const PlanParameters = Type.Object({
  planId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$" }),
  baseCandidateId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$" }),
  branchAction: Type.Union([Type.Literal("continue"), Type.Literal("backtrack"), Type.Literal("branch")]),
  baseRationale: Type.String({ minLength: 1, maxLength: 2000 }),
  historyEvidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 64 }),
  knowledgeEvidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 }),
  hypothesis: Type.String({ minLength: 1, maxLength: 2000 }),
  changeTargets: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), { minItems: 1, maxItems: 32 }),
  changeFamily: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$" })),
  predictedEffects: Type.Optional(Type.Array(Type.Object({
    metricId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$" }),
    sliceId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$" }),
    direction: Type.Union([Type.Literal("increase"), Type.Literal("decrease"), Type.Literal("unchanged")]),
    minimumDelta: Type.Union([Type.Number(), Type.Null()]),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 64 })),
  controls: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), { minItems: 1, maxItems: 16 }),
  falsifiers: Type.Array(Type.String({ minLength: 1, maxLength: 1200 }), { minItems: 1, maxItems: 16 }),
  rollbackCondition: Type.String({ minLength: 1, maxLength: 2000 }),
}, { additionalProperties: false });

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} keys mismatch`);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function commandSpec(value: unknown, label: string): CommandSpec {
  const item = asObject(value, label);
  exactKeys(item, ["args", "executable", "inheritEnv", "timeoutMs"], label);
  const executable = stringValue(item.executable, `${label}.executable`);
  const args = item.args;
  const inheritEnv = item.inheritEnv;
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string")) throw new Error(`${label}.args must be strings`);
  if (!Array.isArray(inheritEnv) || inheritEnv.some((entry) => typeof entry !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(entry))) {
    throw new Error(`${label}.inheritEnv must be environment variable names`);
  }
  const timeoutMs = Number(item.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 86_400_000) throw new Error(`${label}.timeoutMs is invalid`);
  return { executable, args: [...args], timeoutMs, inheritEnv: [...new Set(inheritEnv)] };
}

function boundedText(value: unknown, label: string, maximum = 2000): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function boundedStrings(value: unknown, label: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum}..${maximum} strings`);
  }
  return value.map((entry, index) => boundedText(entry, `${label}[${index}]`, 1200));
}

function assertMethodResearchPolicy(value: unknown): MethodResearchPolicy {
  const policy = asObject(value, "methodResearchPolicy");
  exactKeys(policy, [
    "minimumIndependentScholarlySources", "officialDocumentationRole", "scholarlySourceTiers",
    "scope", "targetSpecificResearch", "unadmittedSources",
  ], "methodResearchPolicy");
  if (policy.scope !== METHOD_RESEARCH_SCOPE || policy.targetSpecificResearch !== "forbidden"
    || policy.officialDocumentationRole !== "implementation_details_only") {
    throw new Error("methodResearchPolicy scope/target/documentation boundary is invalid");
  }
  if (JSON.stringify(policy.scholarlySourceTiers) !== JSON.stringify(["q1_journal", "top_venue"])
    || JSON.stringify(policy.unadmittedSources) !== JSON.stringify(["preprints", "blogs", "forums", "vendor_marketing"])) {
    throw new Error("methodResearchPolicy source tiers are invalid");
  }
  const minimum = Number(policy.minimumIndependentScholarlySources);
  if (!Number.isInteger(minimum) || minimum < 1 || minimum > 10) {
    throw new Error("methodResearchPolicy.minimumIndependentScholarlySources is invalid");
  }
  return policy as unknown as MethodResearchPolicy;
}

function assertMethodQuestion(value: string, label: string): void {
  if (TARGET_SPECIFIC_RESEARCH.test(value) || /GO:\d{7}/i.test(value) || /(?:gold|private[_ -]?evaluator|target identity)/i.test(value)) {
    throw new Error(`${label} requests target-specific/private knowledge instead of process or method research`);
  }
}

export function assertAutonomousMethodResearchMaterial(
  value: unknown,
  policy: MethodResearchPolicy,
  expectedQuestions: readonly string[],
): AutonomousRsiMethodResearchMaterial {
  const material = asObject(value, "method research material");
  exactKeys(material, ["questions", "researchScope", "schemaVersion", "sources"], "method research material");
  if (material.schemaVersion !== "pi-autonomous-rsi-method-research-material.v1" || material.researchScope !== policy.scope) {
    throw new Error("method research material has the wrong schema or scope");
  }
  const questions = boundedStrings(material.questions, "method research material.questions", 1, 16);
  questions.forEach((question, index) => assertMethodQuestion(question, `method research material.questions[${index}]`));
  if (JSON.stringify(questions) !== JSON.stringify(expectedQuestions)) {
    throw new Error("method research material questions do not match the bound diagnosis questions");
  }
  if (!Array.isArray(material.sources) || material.sources.length < 1 || material.sources.length > 32) {
    throw new Error("method research material.sources must contain 1..32 admitted sources");
  }
  const sourceIds = new Set<string>();
  const persistentIds = new Set<string>();
  const sources = material.sources.map((raw, index): AutonomousRsiMethodResearchSource => {
    const source = asObject(raw, `method research material.sources[${index}]`);
    exactKeys(source, [
      "authors", "limitations", "persistentId", "qualityEvidence", "qualityTier", "relevantFindings",
      "sourceId", "sourceType", "title", "url", "venue", "year",
    ], `method research material.sources[${index}]`);
    const sourceId = boundedText(source.sourceId, `sources[${index}].sourceId`, 96);
    if (!SAFE_ID.test(sourceId) || sourceIds.has(sourceId)) throw new Error(`sources[${index}].sourceId is invalid or duplicated`);
    sourceIds.add(sourceId);
    const sourceType = source.sourceType as AutonomousRsiResearchSourceType;
    const qualityTier = source.qualityTier as AutonomousRsiResearchQualityTier;
    if (!["peer_reviewed_primary", "peer_reviewed_review", "official_tool_or_database_documentation"].includes(String(sourceType))) {
      throw new Error(`sources[${index}].sourceType is not admitted`);
    }
    const scholarly = SCHOLARLY_SOURCE_TYPES.has(sourceType);
    if (scholarly !== SCHOLARLY_QUALITY_TIERS.has(qualityTier)
      || (!scholarly && qualityTier !== "authoritative_official_documentation")) {
      throw new Error(`sources[${index}] quality tier does not match its source type`);
    }
    const persistentId = boundedText(source.persistentId, `sources[${index}].persistentId`, 256);
    if ((scholarly && !DOI_OR_PMID.test(persistentId))
      || (!scholarly && !/^url:https:\/\//i.test(persistentId))
      || persistentIds.has(persistentId.toLowerCase())) {
      throw new Error(`sources[${index}].persistentId is invalid or duplicated`);
    }
    persistentIds.add(persistentId.toLowerCase());
    const url = boundedText(source.url, `sources[${index}].url`, 1000);
    if (!/^https:\/\//i.test(url)) throw new Error(`sources[${index}].url must use HTTPS`);
    const year = Number(source.year);
    if (!Number.isInteger(year) || year < 1900 || year > new Date().getUTCFullYear() + 1) throw new Error(`sources[${index}].year is invalid`);
    return {
      sourceId,
      sourceType,
      qualityTier,
      qualityEvidence: boundedText(source.qualityEvidence, `sources[${index}].qualityEvidence`, 1200),
      title: boundedText(source.title, `sources[${index}].title`, 1000),
      authors: boundedStrings(source.authors, `sources[${index}].authors`, 1, 64),
      year,
      venue: boundedText(source.venue, `sources[${index}].venue`, 500),
      persistentId,
      url,
      relevantFindings: boundedStrings(source.relevantFindings, `sources[${index}].relevantFindings`, 1, 16),
      limitations: boundedStrings(source.limitations, `sources[${index}].limitations`, 0, 8),
    };
  });
  const scholarlyCount = sources.filter((source) => SCHOLARLY_SOURCE_TYPES.has(source.sourceType)).length;
  if (scholarlyCount < policy.minimumIndependentScholarlySources) {
    throw new Error(`method research requires at least ${policy.minimumIndependentScholarlySources} independent Q1/top-venue scholarly sources`);
  }
  return {
    schemaVersion: "pi-autonomous-rsi-method-research-material.v1",
    researchScope: METHOD_RESEARCH_SCOPE,
    questions,
    sources,
  };
}

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function loadConfig(path: string): Promise<ProductionWorkerConfig> {
  const raw = asObject(await loadJson(path), "production worker config");
  exactKeys(raw, [
    "allowedChangePaths", "canonicalHash", "developmentBackend", "developmentCommand",
    "evaluatorCommandEnv", "evaluatorPrivateEnv", "knowledgeBackend", "knowledgeCommand",
    "methodResearchPolicy", "model", "protectedChangePaths", "repositoryRoot", "researchCommand", "runtimeAttestations", "dataSplit",
    "schemaVersion", "verificationCommands", "workspaceRoot", "developmentObjective",
  ].filter((key) => raw[key] !== undefined), "production worker config");
  if (raw.schemaVersion !== "pi-autonomous-rsi-production-worker-config.v1") throw new Error("unsupported production worker config schemaVersion");
  if (!isAbsolute(stringValue(raw.repositoryRoot, "repositoryRoot")) || !isAbsolute(stringValue(raw.workspaceRoot, "workspaceRoot"))) {
    throw new Error("repositoryRoot and workspaceRoot must be absolute");
  }
  const list = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0 || isAbsolute(entry) || entry.includes(".."))) {
      throw new Error(`${label} must contain safe relative paths`);
    }
    return [...new Set(value as string[])];
  };
  const model = asObject(raw.model, "model");
  exactKeys(model, ["id", "provider", "thinkingLevel"], "model");
  const attestations = asObject(raw.runtimeAttestations, "runtimeAttestations");
  exactKeys(attestations, ["evaluatorPrivateDataIsolated", "nonResearchNetworkIsModelControlPlaneOnly", "sandboxEnforced"], "runtimeAttestations");
  if (Object.values(attestations).some((value) => value !== true)) throw new Error("all runtime isolation attestations must be true");
  if (raw.knowledgeBackend !== "pi" && raw.knowledgeBackend !== "command") throw new Error("knowledgeBackend is invalid");
  if (raw.developmentBackend !== "pi" && raw.developmentBackend !== "command") throw new Error("developmentBackend is invalid");
  const verify = raw.verificationCommands;
  if (!Array.isArray(verify) || verify.length === 0) throw new Error("verificationCommands must be non-empty");
  const configWithoutHash = { ...raw };
  delete configWithoutHash.canonicalHash;
  if (!SHA256.test(String(raw.canonicalHash)) || raw.canonicalHash !== hashCanonical(configWithoutHash)) {
    throw new Error("production worker config canonicalHash mismatch");
  }
  const thinking = model.thinkingLevel;
  if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(thinking))) throw new Error("model.thinkingLevel is invalid");
  if (raw.developmentObjective !== undefined && (typeof raw.developmentObjective !== "string" || !raw.developmentObjective.trim() || raw.developmentObjective.length > 4000)) throw new Error("developmentObjective is invalid");
  return {
    schemaVersion: raw.schemaVersion,
    ...(raw.developmentObjective === undefined ? {} : { developmentObjective: raw.developmentObjective as string }),
    repositoryRoot: raw.repositoryRoot as string,
    workspaceRoot: raw.workspaceRoot as string,
    allowedChangePaths: list(raw.allowedChangePaths, "allowedChangePaths"),
    protectedChangePaths: list(raw.protectedChangePaths, "protectedChangePaths"),
    model: { provider: stringValue(model.provider, "model.provider"), id: stringValue(model.id, "model.id"), thinkingLevel: thinking as ProductionWorkerConfig["model"]["thinkingLevel"] },
    knowledgeBackend: raw.knowledgeBackend,
    developmentBackend: raw.developmentBackend,
    knowledgeCommand: raw.knowledgeCommand === undefined ? undefined : commandSpec(raw.knowledgeCommand, "knowledgeCommand"),
    developmentCommand: raw.developmentCommand === undefined ? undefined : commandSpec(raw.developmentCommand, "developmentCommand"),
    researchCommand: raw.researchCommand === undefined ? undefined : commandSpec(raw.researchCommand, "researchCommand"),
    methodResearchPolicy: assertMethodResearchPolicy(raw.methodResearchPolicy),
    dataSplit: raw.dataSplit === undefined ? undefined : (() => {
      const x = asObject(raw.dataSplit, "dataSplit");
      const training = asObject(x.training, "dataSplit.training");
      if (typeof x.manifestPath !== "string" || !isAbsolute(x.manifestPath) || typeof x.manifestHash !== "string" || !SHA256.test(x.manifestHash)) throw new Error("dataSplit binding is invalid");
      if (typeof training.manifestPath !== "string" || typeof training.manifestHash !== "string" || typeof training.proteinsFile !== "string" || typeof training.goldRoot !== "string") throw new Error("dataSplit.training binding is invalid");
      return x as unknown as ProductionWorkerConfig["dataSplit"];
    })(),
    verificationCommands: verify.map((entry, index) => {
      const item = asObject(entry, `verificationCommands[${index}]`);
      exactKeys(item, ["args", "executable", "id", "inheritEnv", "timeoutMs"], `verificationCommands[${index}]`);
      const id = stringValue(item.id, `verificationCommands[${index}].id`);
      if (!SAFE_ID.test(id)) throw new Error(`verificationCommands[${index}].id is invalid`);
      const command = commandSpec({ executable: item.executable, args: item.args, timeoutMs: item.timeoutMs, inheritEnv: item.inheritEnv }, `verificationCommands[${index}]`);
      return { id, ...command };
    }),
    evaluatorCommandEnv: stringValue(raw.evaluatorCommandEnv, "evaluatorCommandEnv"),
    evaluatorPrivateEnv: (() => {
      if (!Array.isArray(raw.evaluatorPrivateEnv) || raw.evaluatorPrivateEnv.some((entry) => typeof entry !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(entry))) {
        throw new Error("evaluatorPrivateEnv must contain environment variable names");
      }
      if (!(raw.evaluatorPrivateEnv as string[]).includes(raw.evaluatorCommandEnv as string)) throw new Error("evaluatorPrivateEnv must include evaluatorCommandEnv");
      return [...new Set(raw.evaluatorPrivateEnv as string[])];
    })(),
    runtimeAttestations: { sandboxEnforced: true, nonResearchNetworkIsModelControlPlaneOnly: true, evaluatorPrivateDataIsolated: true },
    canonicalHash: raw.canonicalHash as string,
  };
}

function substitute(value: string, replacements: Readonly<Record<string, string>>): string {
  return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => {
    const replacement = replacements[key];
    if (replacement === undefined) throw new Error(`unknown command placeholder: ${key}`);
    return replacement;
  });
}

async function runCommand(input: {
  spec: CommandSpec;
  cwd: string;
  replacements: Readonly<Record<string, string>>;
  extraEnv?: Readonly<Record<string, string>>;
  allowedInheritedEnv?: readonly string[];
}): Promise<{ stdout: string; stderr: string }> {
  const inherited: NodeJS.ProcessEnv = {};
  const allowed = new Set(input.allowedInheritedEnv ?? input.spec.inheritEnv);
  for (const name of input.spec.inheritEnv) {
    if (!allowed.has(name)) throw new Error(`command requested unauthorized inherited environment variable: ${name}`);
    if (process.env[name] !== undefined) inherited[name] = process.env[name];
  }
  const executable = substitute(input.spec.executable, input.replacements);
  const args = input.spec.args.map((arg) => substitute(arg, input.replacements));
  return await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, {
      cwd: input.cwd,
      env: {
        LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC",
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
        ...inherited, ...input.extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), input.spec.timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); rejectCommand(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolveCommand({ stdout: out, stderr: err });
      else rejectCommand(new Error(`command failed (${code ?? signal ?? "unknown"}): ${executable} ${args.join(" ")}\n${err.slice(-4000)}`));
    });
  });
}

async function git(repository: string, args: string[]): Promise<string> {
  const result = await runCommand({
    spec: { executable: "/usr/bin/git", args, timeoutMs: 120_000, inheritEnv: ["PATH", "HOME"] },
    cwd: repository,
    replacements: {},
  });
  return result.stdout.trim();
}

function inside(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

async function verifiedRoots(config: ProductionWorkerConfig): Promise<{ repositoryRoot: string; workspaceRoot: string }> {
  const repositoryRoot = await realpath(config.repositoryRoot);
  const workspaceRootParent = dirname(config.workspaceRoot);
  await mkdir(workspaceRootParent, { recursive: true });
  await mkdir(config.workspaceRoot, { recursive: true });
  const workspaceRoot = await realpath(config.workspaceRoot);
  if (inside(workspaceRoot, repositoryRoot)) throw new Error("workspaceRoot must be outside repositoryRoot");
  const top = await git(repositoryRoot, ["rev-parse", "--show-toplevel"]);
  if (await realpath(top) !== repositoryRoot) throw new Error("repositoryRoot is not the Git top level");
  return { repositoryRoot, workspaceRoot };
}

async function campaignSpec(): Promise<AutonomousRsiSpec> {
  const campaignDir = process.env.PI_AUTONOMOUS_RSI_CAMPAIGN;
  if (!campaignDir) throw new Error("PI_AUTONOMOUS_RSI_CAMPAIGN is required");
  return assertAutonomousRsiSpec(await loadJson(join(await realpath(campaignDir), "spec.json")));
}

function assertStageInput(value: unknown): AutonomousRsiStageInput {
  const item = asObject(value, "stage input");
  exactKeys(item, [
    "campaignId", "canonicalHash", "currentCandidate", "iteration", "knowledgeHeadHash",
    "objective", "schemaVersion", "sourceArtifacts", "stage",
    ...(item.selectedBaseCandidate !== undefined ? ["selectedBaseCandidate"] : []),
    ...(item.historyContext !== undefined ? ["historyContext"] : []),
    ...(item.repairContext !== undefined ? ["repairContext"] : []),
    ...(item.experimentContext !== undefined ? ["experimentContext"] : []),
  ], "stage input");
  const { canonicalHash, ...content } = item;
  if (item.schemaVersion !== "pi-autonomous-rsi-stage-input.v1" || !AUTONOMOUS_RSI_STAGES.includes(item.stage as AutonomousRsiStage)) throw new Error("unsupported stage input");
  if (!SHA256.test(String(canonicalHash)) || canonicalHash !== hashCanonical(content)) throw new Error("stage input canonicalHash mismatch");
  if (!SAFE_ID.test(String(item.campaignId)) || !Number.isInteger(item.iteration) || Number(item.iteration) < 1) throw new Error("stage input identity is invalid");
  assertAutonomousCandidate(item.currentCandidate, "stage input currentCandidate");
  if (item.selectedBaseCandidate !== undefined && item.selectedBaseCandidate !== null) {
    assertAutonomousCandidate(item.selectedBaseCandidate, "stage input selectedBaseCandidate");
  }
  asObject(item.objective, "stage input objective");
  asObject(item.sourceArtifacts, "stage input sourceArtifacts");
  if (item.historyContext !== undefined) {
    const history = asObject(item.historyContext, "stage input historyContext");
    exactKeys(history, ["canonicalHash", "relativePath"], "stage input historyContext");
    if (!SHA256.test(String(history.canonicalHash)) || typeof history.relativePath !== "string") {
      throw new Error("stage input historyContext binding is invalid");
    }
  }
  if (item.repairContext !== undefined) {
    const repair = asObject(item.repairContext, "stage input repairContext");
    exactKeys(repair, ["failedCandidate", "failedIteration", "instruction", "verification", ...(repair.planIteration !== undefined ? ["planIteration"] : [])], "stage input repairContext");
    if (!Number.isInteger(repair.failedIteration) || Number(repair.failedIteration) < 1 || (repair.planIteration !== undefined && (!Number.isInteger(repair.planIteration) || Number(repair.planIteration) < 1)) || repair.instruction !== "repair_verification_failure_then_reverify") throw new Error("stage input repairContext is invalid");
    assertAutonomousCandidate(repair.failedCandidate, "stage input repairContext.failedCandidate");
    const verification = asObject(repair.verification, "stage input repairContext.verification");
    exactKeys(verification, ["canonicalHash", "relativePath"], "stage input repairContext.verification");
    if (!SHA256.test(String(verification.canonicalHash)) || typeof verification.relativePath !== "string") throw new Error("stage input repairContext.verification is invalid");
  }
  if (item.experimentContext !== undefined) {
    const experiment = asObject(item.experimentContext, "stage input experimentContext");
    exactKeys(experiment, ["blockId", "conditionId", "experimentId", "feedbackPolicy", "historyPolicy", "manifestHash", "maxPatchAttempts", "phase", "replicateId", "targetValidUpdates"], "stage input experimentContext");
    if (!SHA256.test(String(experiment.manifestHash)) || !["pilot", "confirmatory"].includes(String(experiment.phase)) || !["metric_only", "structured_diagnostic"].includes(String(experiment.feedbackPolicy)) || !["reset", "persistent", "shuffled"].includes(String(experiment.historyPolicy))) throw new Error("stage input experimentContext is invalid");
  }
  if (item.knowledgeHeadHash !== null && !SHA256.test(String(item.knowledgeHeadHash))) throw new Error("stage input knowledgeHeadHash is invalid");
  return item as unknown as AutonomousRsiStageInput;
}

async function readStageArtifact(input: AutonomousRsiStageInput, stage: AutonomousRsiStage): Promise<AutonomousRsiStageOutput | undefined> {
  const ref = input.sourceArtifacts[stage];
  if (!ref) return undefined;
  const campaignDir = process.env.PI_AUTONOMOUS_RSI_CAMPAIGN;
  if (!campaignDir) throw new Error("PI_AUTONOMOUS_RSI_CAMPAIGN is required");
  const root = await realpath(campaignDir);
  const path = resolve(root, ref.relativePath);
  if (!inside(path, root)) throw new Error("stage artifact escapes campaign directory");
  const value = assertAutonomousStageOutput(await loadJson(path), {
    campaignId: input.campaignId,
    iteration: input.repairContext && stage === "plan"
      ? (input.repairContext.planIteration ?? input.repairContext.failedIteration)
      : input.repairContext && stage === "verify" ? input.repairContext.failedIteration : input.iteration,
    stage,
    spec: await campaignSpec(),
    candidate: stage === "verify" && input.repairContext ? input.repairContext.failedCandidate : input.currentCandidate,
    ...(input.repairContext || input.selectedBaseCandidate
      ? { baseCandidate: input.currentCandidate }
      : {}),
  });
  if (value.canonicalHash !== ref.canonicalHash) throw new Error(`stage artifact binding mismatch: ${stage}`);
  return value;
}

async function buildOutput(input: AutonomousRsiStageInput, stage: AutonomousRsiStage, payload: Record<string, unknown>): Promise<AutonomousRsiStageOutput> {
  const output = withAutonomousCanonicalHash({
    schemaVersion: "pi-autonomous-rsi-stage-output.v1" as const,
    campaignId: input.campaignId,
    iteration: input.iteration,
    stage,
    status: "completed" as const,
    summary: `${stage} completed by the production adapter`,
    payload,
  });
  return assertAutonomousStageOutput(output, {
    campaignId: input.campaignId,
    iteration: input.iteration,
    stage,
    spec: await campaignSpec(),
    candidate: input.currentCandidate,
    ...(input.selectedBaseCandidate ? { baseCandidate: input.selectedBaseCandidate } : {}),
  });
}

async function createLoader(cwd: string, prompt: string): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => prompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  return loader;
}

function providerError(session: Awaited<ReturnType<typeof createAgentSession>>["session"]): string | undefined {
  const last = session.state.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
  return last?.role === "assistant" && last.stopReason === "error" ? last.errorMessage ?? "unknown provider error" : undefined;
}

function piSessionUsage(session: Awaited<ReturnType<typeof createAgentSession>>["session"]): Record<string, number> {
  let inputTokens = 0; let outputTokens = 0; let cacheReadTokens = 0; let cacheWriteTokens = 0; let modelCalls = 0; let toolCalls = 0; let costUsd = 0;
  for (const raw of session.state.messages as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const message = raw as Record<string, unknown>;
    if (message.role === "assistant") {
      modelCalls += 1;
      const usage = message.usage && typeof message.usage === "object" && !Array.isArray(message.usage) ? message.usage as Record<string, unknown> : {};
      const number = (key: string): number => typeof usage[key] === "number" && Number.isFinite(usage[key]) ? Number(usage[key]) : 0;
      inputTokens += number("input"); outputTokens += number("output"); cacheReadTokens += number("cacheRead"); cacheWriteTokens += number("cacheWrite"); costUsd += number("cost");
      if (Array.isArray(message.content)) toolCalls += message.content.filter((part) => part && typeof part === "object" && !Array.isArray(part) && (part as Record<string, unknown>).type === "toolCall").length;
    }
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, modelCalls, toolCalls, costUsd };
}

async function piKnowledgeStage(input: AutonomousRsiStageInput, config: ProductionWorkerConfig, context: string): Promise<Record<string, unknown>> {
  if (input.stage !== "diagnose" && input.stage !== "research" && input.stage !== "plan") throw new Error("Pi knowledge stage is invalid");
  let submitted: Record<string, unknown> | undefined;
  const parameters = input.stage === "diagnose" ? DiagnosisParameters : input.stage === "research" ? ResearchParameters : PlanParameters;
  const tool = defineTool({
    name: "submit_autonomous_stage",
    label: `Submit ${input.stage}`,
    description: `Submit the final structured ${input.stage} artifact.`,
    parameters,
    async execute(_id, params) {
      submitted = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
      return { content: [{ type: "text" as const, text: `${input.stage} captured.` }], details: submitted, terminate: true };
    },
  });
  const systemPrompt = `You are the ${input.stage} worker in a fail-closed autonomous protein-prediction RSI development loop.\n\nPUBLIC DEVELOPMENT OBJECTIVE:\n${config.developmentObjective ?? "Improve aggregate validation performance with a generalizable protein-prediction method."}\n\nUse the complete supplied candidate-tree history, prior lessons, persistent research cards, and current sanitized evaluation. Training Gold is explicitly permitted through the bound read-only training resource for general method development. Never request or infer validation/test Gold labels, target identities, target-specific protein facts, GO answers, or evaluator-only paths. If researchRequired is true, every researchQuestions item MUST be a general method/process/tool question about protein-function prediction or GO evidence integration; do not mention a protein, target, accession, sequence, GO answer, benchmark instance, or private resource, and do not ask for facts or ablations about an individual target. During method iteration, actively guard against overfitting to training Gold: reject protein- or category-specific tricks unless they have a plausible mechanism and improve aggregate validation generalization. Never change formal Git refs, RSI registry files, tags, or governance state. During diagnose, FIRST classify the observed problem source using primaryProblemSource and any secondaryProblemSources: parameter_or_hyperparameter, implementation_or_pipeline, method_or_tool_capability, evaluation_or_measurement, or no_safe_action. Only after that classification choose the route. Parameter/hyperparameter, implementation/pipeline, and evaluation/measurement problems must skip external Research and proceed to a direct bounded fix/Plan. Any diagnosis containing method_or_tool_capability must require external methodological Research, set researchScope to ${METHOD_RESEARCH_SCOPE}, and formulate bounded method/tool questions. Never request more facts about a benchmark/query protein. During research, use only the host-supplied, source-vetted material: Q1-journal or top-venue peer-reviewed sources are required, and authoritative official tool/database documentation may support implementation details only. Preprints, blogs, forums, and vendor marketing are not admitted evidence. Every research card must cite sourceIds from the supplied material. During plan, jointly choose one evaluated historical base candidate and one falsifiable change. historyEvidenceIds must contain only exact candidateId values present in the supplied candidate graph (at the initial root, use the current candidateId); never place artifact, event, context, or output hashes in that field. Cite research records separately through knowledgeEvidenceIds. When experimentContext is present, also precommit changeFamily and one or more predictedEffects (metricId, sliceId, direction, minimumDelta) before development. External web research is permitted only in the research stage and only through host-supplied research material. Treat evaluator feedback as aggregate sanitized evidence, not labels. If the stage input contains repairContext, you are repairing a candidate rejected by software verification: inspect the bound verification artifact, make the smallest general code/configuration fix needed, commit the repair, and return the repaired candidate binding for Verify. Do not skip tests, suppress failures, alter governance, or reuse a failed candidate without a new commit. Your final action must be submit_autonomous_stage.`;
  const loader = await createLoader(config.repositoryRoot, systemPrompt);
  const modelRuntime = {} as ModelRuntime;
  const model = { provider: "openai-codex", id: config.model.id } as any;
  const trainingTool = config.dataSplit ? createTrainingReadTool(config.dataSplit.training) : undefined;
  const knowledgeTools = [tool, ...(trainingTool ? [trainingTool] : [])];
  const { session } = await createAgentSession({
    cwd: config.repositoryRoot,
    modelRuntime,
    model,
    resourceLoader: loader,
    tools: knowledgeTools.map((entry) => entry.name),
    customTools: knowledgeTools,
    thinkingLevel: config.model.thinkingLevel,
    sessionManager: SessionManager.inMemory(config.repositoryRoot),
  });
  try {
    await session.prompt(`Produce the bounded ${input.stage} result and submit it.\n\nSTAGE INPUT:\n${JSON.stringify(input)}\n\nBOUND ARTIFACT CONTEXT:\n${context}`);
    const firstError = providerError(session);
    if (firstError) throw new Error(`Pi ${input.stage} provider request failed: ${firstError}`);
    if (!submitted) await session.prompt("Call submit_autonomous_stage now. Do not add prose.");
    const secondError = providerError(session);
    if (secondError) throw new Error(`Pi ${input.stage} provider request failed: ${secondError}`);
    if (!submitted) throw new Error(`Pi ${input.stage} worker did not submit structured output`);
    return { ...submitted, resourceUsage: piSessionUsage(session) };
  } finally {
    session.dispose();
  }
}

async function commandKnowledgeStage(inputPath: string, outputPath: string, input: AutonomousRsiStageInput, config: ProductionWorkerConfig): Promise<Record<string, unknown>> {
  if (!config.knowledgeCommand) throw new Error("knowledgeCommand is required for command backend");
  const scratch = `${outputPath}.payload.json`;
  await rm(scratch, { force: true });
  await runCommand({
    spec: config.knowledgeCommand,
    cwd: config.repositoryRoot,
    replacements: { input: inputPath, output: scratch, stage: input.stage, iteration: String(input.iteration), campaign: input.campaignId },
    extraEnv: { PI_AUTONOMOUS_RSI_INPUT: inputPath, PI_AUTONOMOUS_RSI_OUTPUT: scratch, PI_AUTONOMOUS_RSI_STAGE: input.stage },
  });
  const payload = asObject(await loadJson(scratch), "knowledge command payload");
  await rm(scratch, { force: true });
  return payload;
}

async function readHistoryContext(input: AutonomousRsiStageInput): Promise<AutonomousRsiHistoryContext | null> {
  if (!input.historyContext) return null;
  const campaignDir = process.env.PI_AUTONOMOUS_RSI_CAMPAIGN;
  if (!campaignDir) throw new Error("PI_AUTONOMOUS_RSI_CAMPAIGN is required");
  const root = await realpath(campaignDir);
  const path = resolve(root, input.historyContext.relativePath);
  if (!inside(path, root)) throw new Error("history context escapes campaign directory");
  const history = assertAutonomousHistoryContext(
    await loadJson(path) as AutonomousRsiHistoryContext,
    await campaignSpec(),
  );
  if (history.canonicalHash !== input.historyContext.canonicalHash) {
    throw new Error("history context binding mismatch");
  }
  return history;
}

interface BoundedKnowledgeContext {
  serialized: string;
  researchMaterial: AutonomousRsiMethodResearchMaterial | null;
}

async function knowledgeContext(input: AutonomousRsiStageInput, config: ProductionWorkerConfig, inputPath: string): Promise<BoundedKnowledgeContext> {
  const artifacts: Record<string, unknown> = {};
  for (const stage of AUTONOMOUS_RSI_STAGES) {
    const artifact = await readStageArtifact(input, stage);
    if (artifact) artifacts[stage] = artifact.payload;
  }
  let researchMaterial: AutonomousRsiMethodResearchMaterial | null = null;
  if (input.stage === "research") {
    if (!config.researchCommand) throw new Error("method research requires a configured researchCommand");
    const diagnosis = asObject(artifacts.diagnose, "bound diagnosis artifact");
    const questions = boundedStrings(diagnosis.researchQuestions, "bound diagnosis researchQuestions", 1, 16);
    const result = await runCommand({
      spec: config.researchCommand,
      cwd: config.repositoryRoot,
      replacements: { input: inputPath, stage: input.stage, iteration: String(input.iteration), campaign: input.campaignId },
      extraEnv: { PI_AUTONOMOUS_RSI_INPUT: inputPath, PI_AUTONOMOUS_RSI_STAGE: input.stage },
    });
    if (Buffer.byteLength(result.stdout, "utf8") > 500_000) throw new Error("method research material exceeds 500000 bytes");
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error("researchCommand stdout must be one structured method-research JSON object");
    }
    researchMaterial = assertAutonomousMethodResearchMaterial(raw, config.methodResearchPolicy, questions);
  }
  const history = await readHistoryContext(input);
  if (input.stage === "develop") {
    const diagnosis = artifacts.diagnose && typeof artifacts.diagnose === "object" && !Array.isArray(artifacts.diagnose)
      ? artifacts.diagnose as Record<string, unknown> : {};
    const plan = artifacts.plan && typeof artifacts.plan === "object" && !Array.isArray(artifacts.plan)
      ? artifacts.plan as Record<string, unknown> : {};
    const research = artifacts.research && typeof artifacts.research === "object" && !Array.isArray(artifacts.research)
      ? artifacts.research as Record<string, unknown> : {};
    const cards = Array.isArray(research.cards) ? research.cards.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const card = raw as Record<string, unknown>;
      return {
        evidenceId: card.evidenceId,
        finding: card.finding,
        limitations: card.limitations,
        supportedActions: card.supportedActions,
      };
    }).filter(Boolean) : [];
    const bounded = {
      schemaVersion: "pi-autonomous-rsi-develop-context.v1",
      iteration: input.iteration,
      currentCandidate: input.currentCandidate,
      selectedBaseCandidate: input.selectedBaseCandidate ?? input.currentCandidate,
      diagnosis: {
        primaryProblemSource: diagnosis.primaryProblemSource,
        secondaryProblemSources: diagnosis.secondaryProblemSources,
        lesson: diagnosis.lesson,
        prioritizedActions: diagnosis.prioritizedActions,
      },
      research: { cards },
      plan: {
        planId: plan.planId,
        hypothesis: plan.hypothesis,
        changeFamily: plan.changeFamily,
        changeTargets: plan.changeTargets,
        predictedEffects: plan.predictedEffects,
        controls: plan.controls,
        falsifiers: plan.falsifiers,
        rollbackCondition: plan.rollbackCondition,
      },
    };
    return { serialized: JSON.stringify(bounded, null, 2), researchMaterial };
  }
  return {
    serialized: JSON.stringify({ history, artifacts, methodResearchPolicy: config.methodResearchPolicy, researchMaterial }, null, 2),
    researchMaterial,
  };
}

async function changedPaths(workspace: string): Promise<string[]> {
  const [tracked, staged, untracked] = await Promise.all([
    git(workspace, ["diff", "--name-only", "-z"]),
    git(workspace, ["diff", "--cached", "--name-only", "-z"]),
    git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set(`${tracked}\0${staged}\0${untracked}`.split("\0")
    .filter(Boolean)
    .map((path) => path.replaceAll("\\", "/")))];
}

function pathWithinPrefix(path: string, prefix: string): boolean {
  const normalized = prefix.replace(/\/$/, "");
  return path === normalized || path.startsWith(`${normalized}/`);
}

function assertAllowedChanges(paths: readonly string[], config: ProductionWorkerConfig): void {
  assertCandidatePaths(paths);
  if (paths.length === 0) throw new Error("development produced no code changes");
  for (const path of paths) {
    if (isAbsolute(path) || path.split("/").includes("..")) throw new Error(`unsafe changed path: ${path}`);
    if (config.protectedChangePaths.some((prefix) => pathWithinPrefix(path, prefix))) throw new Error(`development changed protected path: ${path}`);
    if (!config.allowedChangePaths.some((prefix) => pathWithinPrefix(path, prefix))) throw new Error(`development changed path outside allowlist: ${path}`);
  }
}

async function assertNoSymlinkChanges(workspace: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      const stat = await lstat(join(workspace, path));
      if (stat.isSymbolicLink()) throw new Error(`development may not add or modify symlinks: ${path}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }
}

function candidateId(input: AutonomousRsiStageInput, sourceCommit: string): string {
  return `${input.campaignId}-i${String(input.iteration).padStart(3, "0")}-${sourceCommit.slice(0, 12)}`.slice(0, 128);
}

async function workspaceRecordPath(workspaceRoot: string, campaignId: string, candidate: string): Promise<string> {
  const records = join(workspaceRoot, ".records", campaignId);
  await mkdir(records, { recursive: true });
  return join(records, `${candidate}.json`);
}

function campaignWorkspacePath(workspaceRoot: string, campaignId: string): string {
  return join(workspaceRoot, campaignId, "campaign-worktree");
}

async function checkoutCleanWorkspace(
  workspace: string,
  sourceCommit: string,
  freshAttempt = false,
  preserveExistingChanges = false,
): Promise<string> {
  const resolved = await realpath(workspace);
  const status = await git(resolved, ["status", "--porcelain"]);
  const head = await git(resolved, ["rev-parse", "HEAD"]);
  // A worker can be killed while Codex has made useful uncommitted edits.
  // When the campaign is retrying the same source commit, retain that desk so
  // the next Codex session can inspect and finish it instead of losing work.
  if (preserveExistingChanges && status && head === sourceCommit) return resolved;
  const trackedStatus = status.split("\n").filter((line) => line.trim() && !line.startsWith("?? ")).join("\n");
  if (trackedStatus) throw new Error(`campaign worktree has tracked changes before checkout: ${trackedStatus.split("\n").join(", ")}`);
  if (freshAttempt || head !== sourceCommit) {
    // Ignored build/cache output is not a candidate version.  Purge it before
    // a new Develop attempt or a switch to another historical commit so one
    // physical worktree cannot leak state between logical candidates.
    await git(resolved, ["clean", "-ffdx"]);
  } else {
    const dirty = await changedPaths(resolved);
    if (dirty.length > 0) throw new Error(`campaign worktree is dirty before checkout: ${dirty.join(", ")}`);
  }
  if (head !== sourceCommit) {
    await git(resolved, ["checkout", "--detach", sourceCommit]);
    const checkedOut = await git(resolved, ["rev-parse", "HEAD"]);
    if (checkedOut !== sourceCommit) throw new Error("campaign worktree checkout binding mismatch");
  }
  return resolved;
}

async function loadOrCreateCampaignWorkspace(
  config: ProductionWorkerConfig,
  input: AutonomousRsiStageInput,
  sourceCommit: string,
  freshAttempt = false,
  preserveExistingChanges = false,
): Promise<string> {
  const roots = await verifiedRoots(config);
  await git(roots.repositoryRoot, ["cat-file", "-e", `${sourceCommit}^{commit}`]);
  const workspace = campaignWorkspacePath(roots.workspaceRoot, input.campaignId);
  await mkdir(dirname(workspace), { recursive: true });
  try {
    const resolved = await realpath(workspace);
    if (!inside(resolved, roots.workspaceRoot)) throw new Error("campaign worktree escapes workspaceRoot");
    return checkoutCleanWorkspace(resolved, sourceCommit, freshAttempt, preserveExistingChanges);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await git(roots.repositoryRoot, ["worktree", "add", "--detach", workspace, sourceCommit]);
  return checkoutCleanWorkspace(workspace, sourceCommit, freshAttempt, preserveExistingChanges);
}

async function recordWorkspace(config: ProductionWorkerConfig, input: AutonomousRsiStageInput, parentCommit: string, sourceCommit: string, sourceTree: string, workspace: string): Promise<WorkspaceRecord> {
  const roots = await verifiedRoots(config);
  const id = candidateId(input, sourceCommit);
  const relativePath = relative(roots.workspaceRoot, workspace).replaceAll("\\", "/");
  if (!relativePath || relativePath.startsWith("..")) throw new Error("workspace escapes workspaceRoot");
  const body = {
    schemaVersion: "pi-autonomous-rsi-workspace-record.v1" as const,
    campaignId: input.campaignId,
    candidateId: id,
    iteration: input.iteration,
    parentCommit,
    sourceCommit,
    sourceTree,
    workspaceRelativePath: relativePath,
  };
  const record = { ...body, canonicalHash: hashCanonical(body) };
  const recordPath = await workspaceRecordPath(roots.workspaceRoot, input.campaignId, id);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  const candidateRef = `refs/autonomous/${input.campaignId}/candidates/${id}`;
  try {
    await git(roots.repositoryRoot, ["check-ref-format", candidateRef]);
    await git(roots.repositoryRoot, ["update-ref", candidateRef, sourceCommit, ""]);
  } catch (error) {
    await rm(recordPath, { force: true });
    throw error;
  }
  return record;
}

async function loadWorkspaceForCandidate(config: ProductionWorkerConfig, candidate: AutonomousRsiCandidate, input: AutonomousRsiStageInput): Promise<{ workspace: string; record?: WorkspaceRecord }> {
  if (!candidate.sourceCommit || !GIT_OBJECT.test(candidate.sourceCommit)) throw new Error("candidate sourceCommit is required for production workers");
  const roots = await verifiedRoots(config);
  const path = await workspaceRecordPath(roots.workspaceRoot, input.campaignId, candidate.candidateId);
  try {
    const raw = asObject(await loadJson(path), "workspace record");
    const claimedHash = String(raw.canonicalHash ?? "");
    const body = { ...raw };
    delete body.canonicalHash;
    if (!SHA256.test(claimedHash) || claimedHash !== hashCanonical(body)) throw new Error("workspace record hash mismatch");
    if (raw.candidateId !== candidate.candidateId || raw.sourceCommit !== candidate.sourceCommit || raw.campaignId !== input.campaignId) throw new Error("workspace record candidate binding mismatch");
    const workspace = resolve(roots.workspaceRoot, String(raw.workspaceRelativePath));
    if (!inside(workspace, roots.workspaceRoot)) throw new Error("workspace record escapes workspaceRoot");
    try {
      return { workspace: await checkoutCleanWorkspace(workspace, candidate.sourceCommit), record: raw as unknown as WorkspaceRecord };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT"
        || workspace !== campaignWorkspacePath(roots.workspaceRoot, input.campaignId)) throw error;
      return {
        workspace: await loadOrCreateCampaignWorkspace(config, input, candidate.sourceCommit),
        record: raw as unknown as WorkspaceRecord,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const workspace = await loadOrCreateCampaignWorkspace(config, input, candidate.sourceCommit);
  const tree = await git(workspace, ["rev-parse", "HEAD^{tree}"]);
  const body = {
    schemaVersion: "pi-autonomous-rsi-workspace-record.v1" as const,
    campaignId: input.campaignId,
    candidateId: candidate.candidateId,
    iteration: input.iteration,
    parentCommit: candidate.sourceCommit,
    sourceCommit: candidate.sourceCommit,
    sourceTree: tree,
    workspaceRelativePath: relative(roots.workspaceRoot, workspace).replaceAll("\\", "/"),
  };
  const record = { ...body, canonicalHash: hashCanonical(body) };
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  return { workspace, record };
}

async function rootedWorkspacePath(workspace: string, relativePath: string, allowMissing: boolean): Promise<string> {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) throw new Error("workspace tool path must be safe and relative");
  const candidate = resolve(workspace, relativePath);
  if (!inside(candidate, workspace)) throw new Error("workspace tool path escapes the candidate worktree");
  try {
    const resolved = await realpath(candidate);
    if (!inside(resolved, workspace)) throw new Error("workspace tool resolved through a symlink outside the candidate worktree");
    return resolved;
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await realpath(dirname(candidate));
    if (!inside(parent, workspace)) throw new Error("workspace tool parent escapes the candidate worktree");
    return candidate;
  }
}

function developmentTools(workspace: string, config: ProductionWorkerConfig) {
  const ReadParameters = Type.Object({ path: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false });
  const ListParameters = Type.Object({ path: Type.String({ minLength: 1, maxLength: 512 }), maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }, { additionalProperties: false });
  const WriteParameters = Type.Object({ path: Type.String({ minLength: 1, maxLength: 512 }), content: Type.String({ maxLength: 200_000 }) }, { additionalProperties: false });
  const ReplaceParameters = Type.Object({ path: Type.String({ minLength: 1, maxLength: 512 }), oldText: Type.String({ minLength: 1, maxLength: 100_000 }), newText: Type.String({ maxLength: 100_000 }) }, { additionalProperties: false });
  const ensureMutable = (path: string): void => assertAllowedChanges([path.replaceAll("\\", "/")], { ...config, allowedChangePaths: config.allowedChangePaths });
  return [
    defineTool({
      name: "workspace_read",
      label: "Read Candidate File",
      description: "Read a UTF-8 file inside the detached candidate worktree.",
      parameters: ReadParameters,
      async execute(_id, params) {
        const path = await rootedWorkspacePath(workspace, params.path, false);
        const content = await readFile(path, "utf8");
        if (content.length > 200_000) throw new Error("workspace_read file exceeds 200000 characters");
        return { content: [{ type: "text" as const, text: content }], details: { path: params.path } };
      },
    }),
    defineTool({
      name: "workspace_list",
      label: "List Candidate Directory",
      description: "List entries in one directory inside the detached candidate worktree.",
      parameters: ListParameters,
      async execute(_id, params) {
        const path = await rootedWorkspacePath(workspace, params.path, false);
        const entries = (await readdir(path, { withFileTypes: true })).slice(0, params.maxEntries ?? 200)
          .map((entry) => `${entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"}\t${entry.name}`);
        return { content: [{ type: "text" as const, text: entries.join("\n") }], details: { count: entries.length } };
      },
    }),
    defineTool({
      name: "workspace_write",
      label: "Write Candidate File",
      description: "Create or replace an allowlisted UTF-8 file inside the detached candidate worktree.",
      parameters: WriteParameters,
      async execute(_id, params) {
        ensureMutable(params.path);
        const path = await rootedWorkspacePath(workspace, params.path, true);
        await writeFile(path, params.content, "utf8");
        return { content: [{ type: "text" as const, text: `Wrote ${params.path}.` }], details: { path: params.path } };
      },
    }),
    defineTool({
      name: "workspace_replace",
      label: "Replace Candidate Text",
      description: "Replace exactly one unique text block in an allowlisted UTF-8 candidate file.",
      parameters: ReplaceParameters,
      async execute(_id, params) {
        ensureMutable(params.path);
        const path = await rootedWorkspacePath(workspace, params.path, false);
        const current = await readFile(path, "utf8");
        const first = current.indexOf(params.oldText);
        if (first < 0 || current.indexOf(params.oldText, first + 1) >= 0) throw new Error("workspace_replace oldText must match exactly once");
        await writeFile(path, `${current.slice(0, first)}${params.newText}${current.slice(first + params.oldText.length)}`, "utf8");
        return { content: [{ type: "text" as const, text: `Updated ${params.path}.` }], details: { path: params.path } };
      },
    }),
  ];
}

async function piDevelop(input: AutonomousRsiStageInput, config: ProductionWorkerConfig, workspace: string, context: string): Promise<Record<string, number>> {
  const prompt = `You are the development worker in a fail-closed autonomous protein-function-prediction RSI loop. You may use the supplied rooted Host workspace tools, read-only training-read tool, and native Codex tools when useful. Native tools and any helper agent are confined to this detached campaign candidate worktree; do not access or modify the main repository, another worktree, evaluator-private data, formal RSI registries, Git refs, tags, or unrelated paths. Helper agents may not delegate further and must obey the same boundary. PUBLIC DEVELOPMENT OBJECTIVE:\n${config.developmentObjective ?? "Improve aggregate validation performance with a generalizable protein-prediction method."}\n\nImplement exactly the bound plan using the supplied diagnosis/research/plan context. Training Gold may be read only through the bound read-only training resource; do not access validation/test Gold or benchmark-private labels. Avoid overfitting training Gold with protein- or category-specific tricks; prefer changes with a plausible mechanism and expected aggregate validation generalization. Do not commit; host verification and candidate commit run after you finish. Keep all edits inside the current candidate worktree and host allowlist. Before workspace_replace, read the current file and use a distinctive exact block. If a Host tool reports an error, treat it as recoverable feedback: reread the current state, correct the arguments or edit block, and continue the same task rather than abandoning the session. If request_tool_acquisition is available, you may independently choose and acquire one HTTPS artifact into this campaign only; candidate code resolves it beneath PI_ICLR_PRIVATE_TOOL_ROOT. When the implementation is complete, either call submit_develop with the allowlisted files you changed or return a final structured summary. Do not call submit_develop before finishing the implementation.`;
  const loader = await createLoader(workspace, prompt);
  const modelRuntime = {} as ModelRuntime;
  const model = { provider: "openai-codex", id: config.model.id } as any;
  const acquisitionTool = createToolAcquisitionTool({ campaignId: input.campaignId, updateIndex: Math.max(1, input.iteration) });
  const trainingTool = config.dataSplit ? createTrainingReadTool(config.dataSplit.training) : undefined;
  const submitTool = defineTool({
    name: "submit_develop",
    label: "Submit Develop Changes",
    description: "Finish the Develop stage after implementation is complete. Report only the allowlisted files actually changed; the Host will run diff checks, tests, and the candidate commit.",
    parameters: Type.Object({
      changedFiles: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { minItems: 1, maxItems: 64, uniqueItems: true }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const paths = [...new Set(params.changedFiles.map((path) => path.replaceAll("\\", "/")))].sort();
      if (paths.some((path) => isAbsolute(path) || path.split("/").includes(".."))) {
        throw new Error("submit_develop paths must be relative and must not escape the candidate worktree");
      }
      assertAllowedChanges(paths, config);
      return {
        content: [{ type: "text" as const, text: "Develop submission captured. Host verification and candidate commit will run next." }],
        details: { changedFiles: paths },
        terminate: true,
      };
    },
  });
  const customTools = [...developmentTools(workspace, config), submitTool, ...(trainingTool ? [trainingTool] : []), ...(acquisitionTool ? [acquisitionTool] : [])];
  const { session } = await createAgentSession({
    cwd: workspace,
    modelRuntime,
    model,
    resourceLoader: loader,
    tools: customTools.map((tool) => tool.name),
    customTools,
    thinkingLevel: config.model.thinkingLevel,
    allowNativeTools: true,
    allowMultiAgent: true,
    sessionManager: SessionManager.inMemory(workspace),
  } as any);
  try {
    await session.prompt(`Implement iteration ${input.iteration}.\n\nBOUND CONTEXT:\n${context}`);
    const error = providerError(session);
    if (error) throw new Error(`Pi develop provider request failed: ${error}`);
    return piSessionUsage(session);
  } finally {
    session.dispose();
  }
}

async function develop(input: AutonomousRsiStageInput, config: ProductionWorkerConfig, inputPath: string): Promise<Record<string, unknown>> {
  const roots = await verifiedRoots(config);
  const baseCandidate = input.selectedBaseCandidate ?? input.currentCandidate;
  const plan = await readStageArtifact(input, "plan");
  if (!plan) throw new Error("develop requires a bound plan");
  const plannedBase = typeof plan.payload.baseCandidateId === "string"
    ? plan.payload.baseCandidateId
    : input.currentCandidate.candidateId;
  if (plannedBase !== baseCandidate.candidateId) throw new Error("develop base differs from the plan-selected candidate");
  const parentCommit = baseCandidate.sourceCommit;
  if (!parentCommit || !GIT_OBJECT.test(parentCommit)) throw new Error("develop requires a commit-bound selected base candidate");
  await git(roots.repositoryRoot, ["cat-file", "-e", `${parentCommit}^{commit}`]);
  const worktree = await loadOrCreateCampaignWorkspace(config, input, parentCommit, true, true);
  try {
    const context = await knowledgeContext(input, config, inputPath);
    let resourceUsage: Record<string, number> | undefined;
    if (config.developmentBackend === "pi") resourceUsage = await piDevelop(input, config, worktree, context.serialized);
    else {
      if (!config.developmentCommand) throw new Error("developmentCommand is required for command backend");
      await runCommand({
        spec: config.developmentCommand,
        cwd: worktree,
        replacements: { input: inputPath, workspace: worktree, iteration: String(input.iteration), campaign: input.campaignId },
        extraEnv: { PI_AUTONOMOUS_RSI_INPUT: inputPath, PI_AUTONOMOUS_RSI_WORKSPACE: worktree, PI_AUTONOMOUS_RSI_STAGE: "develop" },
      });
    }
    const paths = await changedPaths(worktree);
    assertAllowedChanges(paths, config);
    await assertNoSymlinkChanges(worktree, paths);
    await git(worktree, ["diff", "--check"]);
    await git(worktree, ["add", "--all", "--", ...paths]);
    await git(worktree, ["commit", "-m", `autonomous(${input.campaignId}): iteration ${input.iteration} candidate`]);
    const sourceCommit = await git(worktree, ["rev-parse", "HEAD"]);
    const sourceTree = await git(worktree, ["rev-parse", "HEAD^{tree}"]);
    const dirty = await changedPaths(worktree);
    if (dirty.length > 0) throw new Error(`candidate worktree is dirty after commit: ${dirty.join(", ")}`);
    const record = await recordWorkspace(config, input, parentCommit, sourceCommit, sourceTree, worktree);
    const artifactHash = hashCanonical({ schemaVersion: "pi-autonomous-rsi-code-artifact.v1", parentCommit, sourceCommit, sourceTree, planHash: (await readStageArtifact(input, "plan"))?.canonicalHash ?? null });
    return { candidate: { candidateId: record.candidateId, artifactHash, sourceCommit }, ...(resourceUsage ? { resourceUsage } : {}) };
  } catch (error) {
    // This path is a campaign-owned disposable desk.  Candidate history is
    // preserved by commits/refs/graph records; an uncommitted failed attempt
    // must be removed so the sealed stage can retry in the same worktree.
    await git(worktree, ["reset", "--hard", parentCommit]).catch(() => undefined);
    await git(worktree, ["clean", "-ffdx"]).catch(() => undefined);
    throw error;
  }
}

async function verifyCandidate(input: AutonomousRsiStageInput, config: ProductionWorkerConfig): Promise<Record<string, unknown>> {
  const developed = await readStageArtifact(input, "develop");
  if (!developed) throw new Error("verify requires develop output");
  const candidate = assertAutonomousCandidate(developed.payload.candidate, "developed candidate");
  const binding = await loadWorkspaceForCandidate(config, candidate, input);
  const head = await git(binding.workspace, ["rev-parse", "HEAD"]);
  if (head !== candidate.sourceCommit) throw new Error("verification workspace HEAD mismatch");
  if ((await changedPaths(binding.workspace)).length > 0) throw new Error("verification workspace is dirty before checks");
  const checks: string[] = [];
  let passed = true;
  for (const check of config.verificationCommands) {
    try {
      const result = await runCommand({
        spec: check,
        cwd: binding.workspace,
        replacements: { workspace: binding.workspace, commit: head, iteration: String(input.iteration), campaign: input.campaignId },
        extraEnv: capabilityWorkerEnvironment(),
      });
      const outputHash = createHash("sha256").update(result.stdout).update("\0").update(result.stderr).digest("hex");
      checks.push(`${check.id}: passed; output sha256 ${outputHash}`);
    } catch (error) {
      passed = false;
      const failureHash = createHash("sha256").update(error instanceof Error ? error.message : String(error)).digest("hex");
      checks.push(`${check.id}: failed; diagnostic sha256 ${failureHash}`);
      break;
    }
  }
  return { candidate, passed, checks };
}

function parseEvaluatorCommand(value: string): CommandSpec {
  const raw = JSON.parse(value) as unknown;
  return commandSpec(raw, "evaluator command environment payload");
}

async function evaluate(input: AutonomousRsiStageInput, config: ProductionWorkerConfig, inputPath: string, outputPath: string): Promise<Record<string, unknown>> {
  const binding = await loadWorkspaceForCandidate(config, input.currentCandidate, input);
  const head = await git(binding.workspace, ["rev-parse", "HEAD"]);
  if (head !== input.currentCandidate.sourceCommit) throw new Error("evaluation workspace HEAD mismatch");
  if ((await changedPaths(binding.workspace)).length > 0) throw new Error("evaluation workspace is dirty");
  const encoded = process.env[config.evaluatorCommandEnv];
  if (!encoded) throw new Error(`missing evaluator command environment variable: ${config.evaluatorCommandEnv}`);
  const evaluator = parseEvaluatorCommand(encoded);
  for (const name of evaluator.inheritEnv) {
    if (!config.evaluatorPrivateEnv.includes(name)) throw new Error(`evaluator requested unauthorized private environment variable: ${name}`);
  }
  const scratch = `${outputPath}.evaluator.json`;
  await rm(scratch, { force: true });
  // The operator-bound split controls whether validation feedback is permitted.
  // A training-gated evaluator may skip validation below its frozen threshold;
  // after_freeze_only continues to forbid validation during development.
  const evaluationSplit = config.dataSplit?.validation.evaluationPhase === "after_freeze_only"
    ? "training"
    : "training_and_validation";
  await runCommand({
    spec: evaluator,
    cwd: binding.workspace,
    replacements: { input: inputPath, output: scratch, workspace: binding.workspace, commit: head, iteration: String(input.iteration), campaign: input.campaignId },
    extraEnv: { PI_AUTONOMOUS_RSI_INPUT: inputPath, PI_AUTONOMOUS_RSI_OUTPUT: scratch, PI_AUTONOMOUS_RSI_WORKSPACE: binding.workspace, PI_AUTONOMOUS_RSI_COMMIT: head, PI_AUTONOMOUS_RSI_EVALUATION_SPLIT: evaluationSplit, ...capabilityWorkerEnvironment() },
    allowedInheritedEnv: config.evaluatorPrivateEnv,
  });
  const result = asObject(await loadJson(scratch), "evaluator result");
  await rm(scratch, { force: true });
  exactKeys(result, ["decision", "feedback", "metric", "schemaVersion"], "evaluator result");
  if (result.schemaVersion !== "pi-autonomous-rsi-evaluator-result.v1") throw new Error("unsupported evaluator result schemaVersion");
  const metric = asObject(result.metric, "evaluator result.metric");
  exactKeys(metric, ["metricId", "value"], "evaluator result.metric");
  if (typeof metric.metricId !== "string" || !SAFE_ID.test(metric.metricId) || metric.metricId !== input.objective.metricId || typeof metric.value !== "number" || !Number.isFinite(metric.value)) throw new Error("evaluator metric is invalid or does not match the objective");
  if (result.decision !== "continue" && result.decision !== "stop") throw new Error("evaluator decision is invalid");
  const rawFeedback = asObject(result.feedback, "evaluator result.feedback");
  const experiment = input.experimentContext;
  let developerFeedback: Record<string, unknown> = rawFeedback;
  if (experiment?.feedbackPolicy === "metric_only") {
    developerFeedback = rawFeedback.metricOnly && typeof rawFeedback.metricOnly === "object" && !Array.isArray(rawFeedback.metricOnly)
      ? rawFeedback.metricOnly as Record<string, unknown>
      : { policy: "metric_only", primaryMetric: structuredClone(metric), decision: result.decision };
  } else if (experiment?.feedbackPolicy === "structured_diagnostic") {
    if (rawFeedback.structuredDiagnostic && typeof rawFeedback.structuredDiagnostic === "object" && !Array.isArray(rawFeedback.structuredDiagnostic)) {
      developerFeedback = {
        policy: "structured_diagnostic",
        primaryMetric: structuredClone(metric),
        ...(rawFeedback.aggregateMetrics !== undefined ? { aggregateMetrics: structuredClone(rawFeedback.aggregateMetrics) } : {}),
        structuredDiagnostic: structuredClone(rawFeedback.structuredDiagnostic),
      };
    } else if (experiment.phase === "confirmatory") {
      throw new Error("confirmatory structured_diagnostic condition requires evaluator feedback.structuredDiagnostic");
    }
  }
  const privateResultHash = hashCanonical(result);
  const developerFeedbackHash = hashCanonical(developerFeedback);
  return {
    candidate: input.currentCandidate,
    metric,
    decision: result.decision,
    feedback: developerFeedback,
    ...(experiment ? { evaluationBinding: { evaluatorResultHash: privateResultHash, developerFeedbackHash, feedbackPolicy: experiment.feedbackPolicy } } : {}),
  };
}

export function assertAutonomousProductionDiagnosis(payload: Record<string, unknown>, policy: MethodResearchPolicy): void {
  const primary = payload.primaryProblemSource;
  if (typeof primary !== "string" || !PROBLEM_SOURCES.includes(primary as AutonomousRsiProblemSource)) {
    throw new Error("production diagnosis must classify a valid primaryProblemSource before routing");
  }
  const secondary = boundedStrings(payload.secondaryProblemSources, "production diagnosis secondaryProblemSources", 0, 4);
  if (new Set(secondary).size !== secondary.length
    || secondary.includes(primary)
    || secondary.some((source) => source === "no_safe_action" || !PROBLEM_SOURCES.includes(source as AutonomousRsiProblemSource))) {
    throw new Error("production diagnosis secondaryProblemSources are invalid or duplicated");
  }
  boundedText(payload.rootCauseRationale, "production diagnosis rootCauseRationale", 2000);
  if (primary === "no_safe_action" && (secondary.length > 0 || typeof payload.stopReason !== "string" || payload.stopReason.length < 1)) {
    throw new Error("no_safe_action must be exclusive and provide a stopReason");
  }
  const methodGap = primary === "method_or_tool_capability" || secondary.includes("method_or_tool_capability");
  if (payload.researchRequired !== methodGap) {
    throw new Error("production diagnosis Research routing must follow the classified method/tool capability gap");
  }
  const questions = boundedStrings(payload.researchQuestions, "production diagnosis researchQuestions", methodGap ? 1 : 0, 16);
  questions.forEach((question, index) => assertMethodQuestion(question, `production diagnosis researchQuestions[${index}]`));
  if (methodGap) {
    if (payload.researchScope !== policy.scope) throw new Error("required research must use the process/method improvement scope");
  } else if (payload.researchScope !== null || questions.length !== 0) {
    throw new Error("researchScope/questions must be empty when the root-cause route skips method research");
  }
}

function assertProductionResearchCards(
  payload: Record<string, unknown>,
  material: AutonomousRsiMethodResearchMaterial,
): void {
  if (!Array.isArray(payload.cards) || payload.cards.length < 1 || payload.cards.length > 32) {
    throw new Error("production research must return 1..32 source-bound knowledge cards");
  }
  const sources = new Map(material.sources.map((source) => [source.sourceId, source]));
  for (const [index, raw] of payload.cards.entries()) {
    const card = asObject(raw, `production research cards[${index}]`);
    const sourceIds = boundedStrings(card.sourceIds, `production research cards[${index}].sourceIds`, 1, 8);
    if (new Set(sourceIds).size !== sourceIds.length || sourceIds.some((sourceId) => !sources.has(sourceId))) {
      throw new Error(`production research cards[${index}] cites an unknown or duplicated sourceId`);
    }
    if (!sourceIds.some((sourceId) => SCHOLARLY_SOURCE_TYPES.has(sources.get(sourceId)!.sourceType))) {
      throw new Error(`production research cards[${index}] requires at least one Q1/top-venue scholarly source`);
    }
  }
}


export async function runProductionAutonomousRsiWorker(options: {
  stage: string;
  inputPath: string;
  outputPath: string;
  configPath: string;
}): Promise<AutonomousRsiStageOutput> {
  configureSdkNetwork(process.env);
  if (!AUTONOMOUS_RSI_STAGES.includes(options.stage as AutonomousRsiStage)) throw new Error(`invalid production worker stage: ${options.stage}`);
  const stage = options.stage as AutonomousRsiStage;
  const input = assertStageInput(await loadJson(options.inputPath));
  if (input.stage !== stage) throw new Error(`worker stage/input mismatch: ${stage}/${input.stage}`);
  const config = await loadConfig(options.configPath);
  await verifyRsiDataSplitBinding(config.dataSplit, (await campaignSpec()).dataSplitManifestHash);
  const roots = await verifiedRoots(config);
  if (roots.repositoryRoot !== await realpath(process.env.PI_AUTONOMOUS_RSI_PROJECT_ROOT ?? roots.repositoryRoot)) throw new Error("production config repositoryRoot/project root mismatch");
  let payload: Record<string, unknown>;
  if (stage === "research") {
    const diagnosis = await readStageArtifact(input, "diagnose");
    if (!diagnosis) throw new Error("research requires the current reflection");
    assertAutonomousProductionDiagnosis(diagnosis.payload, config.methodResearchPolicy);
    if (diagnosis.payload.researchRequired === false) {
      payload = { disposition: "not_required", researchScope: null, sources: [], cards: [] };
    } else {
      const context = await knowledgeContext(input, config, options.inputPath);
      if (!context.researchMaterial) throw new Error("required method research did not produce admitted source material");
      const research = config.knowledgeBackend === "pi"
        ? await piKnowledgeStage(input, config, context.serialized)
        : await commandKnowledgeStage(options.inputPath, options.outputPath, input, config);
      assertProductionResearchCards(research, context.researchMaterial);
      payload = {
        ...research,
        disposition: "completed",
        researchScope: context.researchMaterial.researchScope,
        sources: context.researchMaterial.sources,
      };
    }
  } else if (stage === "diagnose" || stage === "plan") {
    const context = await knowledgeContext(input, config, options.inputPath);
    payload = config.knowledgeBackend === "pi"
      ? await piKnowledgeStage(input, config, context.serialized)
      : await commandKnowledgeStage(options.inputPath, options.outputPath, input, config);
    if (stage === "diagnose") assertAutonomousProductionDiagnosis(payload, config.methodResearchPolicy);
    if (stage === "plan" && payload.baseCandidateId === undefined) {
      payload = {
        ...payload,
        baseCandidateId: input.currentCandidate.candidateId,
        branchAction: "continue",
        baseRationale: "Legacy command backend continues from the latest evaluated candidate.",
        historyEvidenceIds: [input.currentCandidate.candidateId],
        knowledgeEvidenceIds: [],
      };
    }
    if (stage === "plan" && input.experimentContext) {
      if (typeof payload.changeFamily !== "string" || !SAFE_ID.test(payload.changeFamily) || !Array.isArray(payload.predictedEffects) || payload.predictedEffects.length < 1) {
        throw new Error("instrumented plan requires changeFamily and predictedEffects before development");
      }
    }
  } else if (stage === "develop") payload = await develop(input, config, options.inputPath);
  else if (stage === "verify") payload = await verifyCandidate(input, config);
  else payload = await evaluate(input, config, options.inputPath, options.outputPath);
  const output = await buildOutput(input, stage, payload);
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  return output;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`missing ${name}`);
  return resolve(value);
}

export async function productionAutonomousRsiWorkerCommand(args: string[]): Promise<number> {
  const output = await runProductionAutonomousRsiWorker({
    stage: option(args, "--stage") ?? "",
    inputPath: required(args, "--input"),
    outputPath: required(args, "--output"),
    configPath: required(args, "--config"),
  });
  console.log(JSON.stringify({ ok: true, stage: output.stage, canonicalHash: output.canonicalHash }, null, 2));
  return 0;
}
