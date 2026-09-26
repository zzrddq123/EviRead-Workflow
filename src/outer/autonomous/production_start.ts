import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { assertExperimentManifest } from "../../experiment/contracts.js";
import {
  autonomousRsiCampaignStatus,
  runAutonomousRsiCampaign,
  verifyAutonomousRsiCampaign,
} from "./orchestrator.js";
import { initializeProductionAutonomousRsi } from "./production_init.js";
import { loadRsiDataSplitManifest } from "../../data_split.js";

interface ProductionStartProfile {
  schemaVersion: "pi-autonomous-rsi-production-start-profile.v1";
  campaignId: string;
  runRoot: string;
  researchCommandFile: string;
  evaluatorCommandFile: string;
  evaluatorContractHash: string;
  dataSplitManifest: string;
  developmentObjective?: string;
  publishedHistory: "auto" | string | null;
  maxIterations: number;
  maxStageAttempts?: number;
  metricId?: string;
  minimumImprovement?: number;
  plateauPatience?: number;
  experimentManifest: string | null;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const EVALUATOR_COMMAND_ENV = "PI_AUTONOMOUS_RSI_EVALUATOR_COMMAND";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} has unexpected or missing keys`);
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function loadProductionStartProfile(path: string): Promise<ProductionStartProfile> {
  const raw = object(await json(resolve(path)), "production start profile");
  exactKeys(raw, ["campaignId", "dataSplitManifest", "evaluatorCommandFile", "evaluatorContractHash", "maxIterations", "publishedHistory", "researchCommandFile", "runRoot", "schemaVersion", ...(raw.developmentObjective !== undefined ? ["developmentObjective"] : []), ...(raw.experimentManifest !== undefined ? ["experimentManifest"] : []), ...(raw.maxStageAttempts !== undefined ? ["maxStageAttempts"] : []), ...(raw.metricId !== undefined ? ["metricId"] : []), ...(raw.minimumImprovement !== undefined ? ["minimumImprovement"] : []), ...(raw.plateauPatience !== undefined ? ["plateauPatience"] : []), ...(raw.modelProvider !== undefined ? ["modelProvider"] : []), ...(raw.modelId !== undefined ? ["modelId"] : []), ...(raw.thinkingLevel !== undefined ? ["thinkingLevel"] : [])], "production start profile");
  if (raw.schemaVersion !== "pi-autonomous-rsi-production-start-profile.v1") throw new Error("unsupported production start profile schemaVersion");
  if (typeof raw.campaignId !== "string" || !SAFE_ID.test(raw.campaignId)) throw new Error("production start profile campaignId is invalid");
  for (const key of ["runRoot", "researchCommandFile", "evaluatorCommandFile"] as const) {
    if (typeof raw[key] !== "string" || !isAbsolute(raw[key])) throw new Error(`production start profile ${key} must be absolute`);
  }
  if (typeof raw.dataSplitManifest !== "string" || !isAbsolute(raw.dataSplitManifest)) throw new Error("production start profile dataSplitManifest must be absolute");
  if (raw.developmentObjective !== undefined && (typeof raw.developmentObjective !== "string" || !raw.developmentObjective.trim() || raw.developmentObjective.length > 4000)) throw new Error("developmentObjective is invalid");
  if (raw.experimentManifest !== undefined && raw.experimentManifest !== null && (typeof raw.experimentManifest !== "string" || !isAbsolute(raw.experimentManifest))) throw new Error("production start profile experimentManifest must be an absolute path or null");
  if (raw.experimentManifest === undefined) raw.experimentManifest = null;
  if (typeof raw.evaluatorContractHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.evaluatorContractHash)) {
    throw new Error("production start profile evaluatorContractHash must be SHA-256");
  }
  if (raw.publishedHistory !== null && raw.publishedHistory !== "auto"
    && (typeof raw.publishedHistory !== "string" || !isAbsolute(raw.publishedHistory))) {
    throw new Error("production start profile publishedHistory must be auto, an absolute path, or null");
  }
  if (!Number.isInteger(raw.maxIterations) || Number(raw.maxIterations) < 1 || Number(raw.maxIterations) > 100) throw new Error("production start profile maxIterations must be an integer in [1, 100]");
  if (raw.maxStageAttempts !== undefined && (!Number.isInteger(raw.maxStageAttempts) || Number(raw.maxStageAttempts) < 1 || Number(raw.maxStageAttempts) > 10)) throw new Error("production start profile maxStageAttempts is invalid");
  if (raw.metricId !== undefined && (typeof raw.metricId !== "string" || !SAFE_ID.test(raw.metricId))) throw new Error("production start profile metricId is invalid");
  for (const key of ["modelProvider", "modelId"] as const) if (raw[key] !== undefined && (typeof raw[key] !== "string" || raw[key].length < 1)) throw new Error(`production start profile ${key} is invalid`);
  if (raw.thinkingLevel !== undefined && !THINKING_LEVELS.includes(raw.thinkingLevel as typeof THINKING_LEVELS[number])) throw new Error("production start profile thinkingLevel is invalid");
  for (const key of ["minimumImprovement", "plateauPatience"] as const) if (raw[key] !== undefined && (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || Number(raw[key]) < 0)) throw new Error(`production start profile ${key} is invalid`);
  if (raw.plateauPatience !== undefined && !Number.isInteger(raw.plateauPatience)) throw new Error("production start profile plateauPatience must be an integer");
  return raw as unknown as ProductionStartProfile;
}

function evaluatorPrivateEnvironment(value: unknown): string[] {
  const command = object(value, "evaluator command");
  exactKeys(command, ["args", "executable", "inheritEnv", "timeoutMs"], "evaluator command");
  if (typeof command.executable !== "string" || command.executable.length < 1) throw new Error("evaluator command executable is invalid");
  if (!Array.isArray(command.args) || command.args.some((entry) => typeof entry !== "string")) throw new Error("evaluator command args are invalid");
  if (!Array.isArray(command.inheritEnv) || command.inheritEnv.some((entry) => typeof entry !== "string" || !ENV_NAME.test(entry))) {
    throw new Error("evaluator command inheritEnv is invalid");
  }
  if (!Number.isInteger(command.timeoutMs) || Number(command.timeoutMs) < 1_000 || Number(command.timeoutMs) > 86_400_000) {
    throw new Error("evaluator command timeoutMs is invalid");
  }
  return [...new Set(command.inheritEnv as string[])];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function runProductionAutonomousRsiFromProfile(input: {
  profilePath: string;
  repositoryRoot?: string;
}): Promise<{ initialized: boolean; status: Record<string, unknown>; verification: Awaited<ReturnType<typeof verifyAutonomousRsiCampaign>> }> {
  const profile = await loadProductionStartProfile(input.profilePath);
  if (await exists(join(resolve(profile.runRoot, ".."), "FINAL_CANDIDATE_FREEZE.json"))) throw new Error("campaign is frozen for final testing");
  const experiment = profile.experimentManifest ? assertExperimentManifest(await json(profile.experimentManifest)) : null;
  const repositoryRoot = await realpath(resolve(input.repositoryRoot ?? "."));
  const evaluatorCommand = await json(profile.evaluatorCommandFile);
  const evaluatorPrivateEnv = evaluatorPrivateEnvironment(evaluatorCommand);
  await access(profile.researchCommandFile);
  const campaignDir = join(profile.runRoot, "campaign");
  const runtimeDir = join(profile.runRoot, "runtime");
  // Sibling campaign run roots intentionally share one workspace registry so
  // an operator can run M campaigns in parallel and select one exact worktree.
  const workspaceRoot = join(resolve(profile.runRoot, ".."), "workspaces");
  const initialized = !(await exists(join(campaignDir, "spec.json")));
  if (initialized) {
    const args = [
      "--repository-root", repositoryRoot,
      "--campaign-id", profile.campaignId,
      "--campaign-dir", campaignDir,
      "--runtime-dir", runtimeDir,
      "--workspace-root", workspaceRoot,
      "--research-command-file", profile.researchCommandFile,
      "--data-split-manifest", profile.dataSplitManifest,
      "--max-iterations", String(profile.maxIterations),
      "--evaluator-contract-hash", profile.evaluatorContractHash,
      "--metric-id", profile.metricId ?? "development_macro_groups123_overall_fmax",
      "--minimum-improvement", String(profile.minimumImprovement ?? 0.001),
      "--plateau-patience", String(profile.plateauPatience ?? 2),
      "--max-stage-attempts", String(profile.maxStageAttempts ?? 2),
      "--model-provider", profile.modelProvider ?? "openai-codex",
      "--model-id", profile.modelId ?? "gpt-5.6-sol",
      "--thinking-level", profile.thinkingLevel ?? "high",
    ];
    if (profile.developmentObjective) args.push("--development-objective", profile.developmentObjective);
    if (profile.experimentManifest) args.push("--experiment-manifest", profile.experimentManifest);
    // `auto` is the normal zero-config mode and discovers immutable
    // refs/campaigns/* archives from the canonical repository/remote.
    args.push("--published-history", profile.publishedHistory === null ? "none" : profile.publishedHistory);
    for (const name of evaluatorPrivateEnv) args.push("--evaluator-private-env", name);
    await initializeProductionAutonomousRsi(args);
  } else {
    const spec = object(await json(join(campaignDir, "spec.json")), "existing autonomous RSI spec");
    const budget = object(spec.budget, "existing autonomous RSI spec budget");
    const storedExperiment = spec.experiment && typeof spec.experiment === "object" && !Array.isArray(spec.experiment) ? spec.experiment as Record<string, unknown> : null;
    const workerConfig = object(await json(join(runtimeDir, `${profile.campaignId}-production-worker.json`)), "existing production worker config");
    const storedModel = object(workerConfig.model, "existing production worker model");
    if ((workerConfig.developmentObjective ?? null) !== (profile.developmentObjective ?? null)
      || spec.campaignId !== profile.campaignId
      || budget.maxIterations !== profile.maxIterations
      || spec.evaluatorContractHash !== profile.evaluatorContractHash
      || spec.dataSplitManifestHash !== (await loadRsiDataSplitManifest(profile.dataSplitManifest)).training.manifestHash
      || (spec.objective as Record<string, unknown>).metricId !== (profile.metricId ?? "development_macro_groups123_overall_fmax")
      || (spec.objective as Record<string, unknown>).minimumImprovement !== (profile.minimumImprovement ?? 0.001)
      || (spec.objective as Record<string, unknown>).plateauPatience !== (profile.plateauPatience ?? 2)
      || (budget.maxStageAttempts as number) !== (profile.maxStageAttempts ?? 2)
      || storedModel.provider !== (profile.modelProvider ?? "openai-codex")
      || storedModel.id !== (profile.modelId ?? "gpt-5.6-sol")
      || storedModel.thinkingLevel !== (profile.thinkingLevel ?? "high")
      || (experiment?.canonicalHash ?? null) !== (storedExperiment?.canonicalHash ?? null)) {
      throw new Error("production start profile does not match the existing sealed campaign identity/budget");
    }
  }
  const previous = process.env[EVALUATOR_COMMAND_ENV];
  process.env[EVALUATOR_COMMAND_ENV] = JSON.stringify(evaluatorCommand);
  try {
    await runAutonomousRsiCampaign({ campaignDir, projectRoot: repositoryRoot });
  } finally {
    if (previous === undefined) delete process.env[EVALUATOR_COMMAND_ENV];
    else process.env[EVALUATOR_COMMAND_ENV] = previous;
  }
  const status = await autonomousRsiCampaignStatus(campaignDir);
  const verification = await verifyAutonomousRsiCampaign(campaignDir);
  return { initialized, status, verification };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function productionAutonomousRsiStartCommand(args: string[]): Promise<number> {
  const allowed = new Set(["--profile", "--repository-root"]);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]!) || !args[index + 1]) throw new Error(`invalid autonomous-rsi-production-start argument: ${args[index] ?? "missing"}`);
  }
  const profilePath = option(args, "--profile");
  if (!profilePath) throw new Error("autonomous-rsi-production-start requires --profile");
  const result = await runProductionAutonomousRsiFromProfile({
    profilePath,
    ...(option(args, "--repository-root") ? { repositoryRoot: option(args, "--repository-root") } : {}),
  });
  console.log(JSON.stringify({ ok: result.verification.valid, initialized: result.initialized, status: result.status, verification: result.verification }, null, 2));
  return result.verification.valid && result.status.status !== "failed" ? 0 : 1;
}
