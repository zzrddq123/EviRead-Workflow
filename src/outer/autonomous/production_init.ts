import { readFile, realpath, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { hashCanonical, sha256File } from "../../hash.js";
import { assertExperimentManifest } from "../../experiment/contracts.js";
import { withAutonomousCanonicalHash, type AutonomousRsiHistoricalSeed, type AutonomousRsiSpec, type AutonomousRsiWorkerSpec } from "./contracts.js";
import { writeAutonomousRsiCampaignIdentity } from "./campaign_identity.js";
import { loadCompatibleHistoricalSeeds } from "./historical_onboarding.js";
import { initializeAutonomousRsiCampaign } from "./orchestrator.js";
import { loadRsiDataSplitManifest } from "../../data_split.js";

// The only scientific-loop adapter in this arm: bind the immutable R09 method/v1.4 runtime baseline.
const BASELINE_PATH = "config/autonomous-rsi-r09-v140-baseline.json";
// Workers use operator-authenticated Codex CLI; inherit routing, never credential values.
export const MODEL_CONTROL_ENV = ["CODEX_HOME", "CHATGPT_BASE_URL", "OPENAI_CHATGPT_BASE_URL", "CODEX_OPENAI_BASE_URL", "CODEX_CHATGPT_BASE_URL", "CODEX_REFRESH_TOKEN_URL_OVERRIDE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function repeated(args: string[], name: string): string[] {
  return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]!] : []);
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function inside(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

async function runGit(repository: string, args: string[]): Promise<string> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolveGit, rejectGit) => {
    const child = spawn("/usr/bin/git", args, { cwd: repository, env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", rejectGit);
    child.on("close", (code) => code === 0 ? resolveGit(Buffer.concat(stdout).toString("utf8").trim()) : rejectGit(new Error(Buffer.concat(stderr).toString("utf8"))));
  });
}

async function readCommand(path: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (!path) return undefined;
  const value = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`command file must contain one command object: ${path}`);
  return value as Record<string, unknown>;
}

async function verifyBaseline(repositoryRoot: string): Promise<Record<string, unknown>> {
  const path = resolve(repositoryRoot, BASELINE_PATH);
  const baseline = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const { canonicalHash, ...content } = baseline;
  if (canonicalHash !== hashCanonical(content)) throw new Error("bootstrap baseline canonicalHash mismatch");
  const evidence = baseline.evidenceBindings;
  if (!Array.isArray(evidence)) throw new Error("R08 GPT-wide baseline evidenceBindings are invalid");
  for (const raw of evidence) {
    const item = raw as Record<string, unknown>;
    const evidencePath = resolve(repositoryRoot, String(item.path));
    if (!inside(evidencePath, repositoryRoot) || await sha256File(evidencePath) !== item.sha256) throw new Error(`bootstrap baseline evidence binding mismatch: ${item.path}`);
  }
  const runtime = baseline.runtimeBinding as Record<string, unknown>;
  const genome = resolve(repositoryRoot, String(runtime.genomePath));
  if (!inside(genome, repositoryRoot) || await sha256File(genome) !== runtime.genomeSha256) throw new Error("bootstrap baseline genome binding mismatch");
  return baseline;
}

export async function initializeProductionAutonomousRsi(args: string[]): Promise<{ campaignDir: string; configPath: string; spec: AutonomousRsiSpec }> {
  const repositoryRoot = await realpath(resolve(required(args, "--repository-root")));
  const campaignDir = resolve(required(args, "--campaign-dir"));
  const runtimeDir = resolve(required(args, "--runtime-dir"));
  const workspaceRoot = resolve(required(args, "--workspace-root"));
  if (inside(campaignDir, repositoryRoot) || inside(runtimeDir, repositoryRoot) || inside(workspaceRoot, repositoryRoot)) {
    throw new Error("campaign, runtime, and workspace directories must be outside the repository");
  }
  if (!isAbsolute(campaignDir) || !isAbsolute(runtimeDir) || !isAbsolute(workspaceRoot)) throw new Error("production directories must be absolute");
  if (await realpath(await runGit(repositoryRoot, ["rev-parse", "--show-toplevel"])) !== repositoryRoot) throw new Error("repositoryRoot is not a Git top level");
  if (await runGit(repositoryRoot, ["status", "--porcelain", "--untracked-files=no"])) throw new Error("repository has tracked changes");
  const sourceCommit = await runGit(repositoryRoot, ["rev-parse", "HEAD"]);
  const sourceTree = await runGit(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
  const baseline = await verifyBaseline(repositoryRoot);
  const campaignId = required(args, "--campaign-id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(campaignId)) throw new Error("campaignId is invalid");
  const knowledgeBackend = option(args, "--knowledge-backend") ?? "pi";
  const developmentBackend = option(args, "--development-backend") ?? "pi";
  if (knowledgeBackend !== "pi" || developmentBackend !== "pi") {
    throw new Error("production initialization requires rooted Pi backends; command backends are reserved for isolated integration tests");
  }
  const knowledgeCommand = await readCommand(option(args, "--knowledge-command-file"));
  const developmentCommand = await readCommand(option(args, "--development-command-file"));
  const researchCommand = await readCommand(option(args, "--research-command-file"));
  const developmentObjective = option(args, "--development-objective");
  if (developmentObjective !== undefined && (!developmentObjective.trim() || developmentObjective.length > 4000)) throw new Error("development objective is invalid");
  const dataSplitPath = option(args, "--data-split-manifest");
  if (!dataSplitPath) throw new Error("production initialization requires --data-split-manifest binding training, validation, and test splits");
  const dataSplit = await loadRsiDataSplitManifest(resolve(dataSplitPath));
  if (knowledgeCommand || developmentCommand) throw new Error("production Pi backends do not accept knowledge/development command overrides");
  if (!researchCommand) throw new Error("production initialization requires --research-command-file for the only external-information stage");
  const evaluatorCommandEnv = option(args, "--evaluator-command-env") ?? "PI_AUTONOMOUS_RSI_EVALUATOR_COMMAND";
  const evaluatorPrivateEnv = [...new Set([evaluatorCommandEnv, ...repeated(args, "--evaluator-private-env")])];
  const commandBase = { timeoutMs: 3_600_000, inheritEnv: ["HOME", "PATH"] };
  const configBody: Record<string, unknown> = {
    schemaVersion: "pi-autonomous-rsi-production-worker-config.v1",
    ...(developmentObjective ? { developmentObjective } : {}),
    repositoryRoot,
    workspaceRoot,
    allowedChangePaths: ["src", "python", "scripts", "config", "genomes", "docs", "schemas", "package.json", "package-lock.json"],
    protectedChangePaths: [
      "rsi", "versions", "runs", "benchmark_runs", "benchmarks", ".git", "AGENTS.md",
      "src/outer", "src/experiment", "src/rsi_cli.ts", "src/data_split.ts", "src/data_split.test.ts", "schemas/rsi_data_split_manifest.schema.json", "test/rsi", "pi-agent",
      "package.json", "package-lock.json", "tsconfig.json", "CODEBASE_COMPOSITION.md", "CODEBASE_COMPOSITION.json",
      "src/go.test.ts", "src/hash.test.ts", "src/pi-sanitization.test.ts", "src/query_privacy.test.ts",
      "schemas/rsi_experiment_defs.schema.json", "schemas/rsi_experiment_manifest.schema.json",
      "schemas/rsi_iteration_precommit.schema.json", "schemas/rsi_evaluation_receipt.schema.json",
      "schemas/rsi_resource_usage_receipt.schema.json", "schemas/rsi_campaign_freeze_manifest.schema.json",
      "schemas/rsi_sealed_replay_manifest.schema.json", "schemas/rsi_developer_feedback_view.schema.json", "schemas/rsi_private_evaluation.schema.json",
      "schemas/rsi_capability_manifest.schema.json", "schemas/rsi_tool_acquisition_receipt.schema.json", "schemas/rsi_candidate_capability_usage.schema.json", "schemas/rsi_versioned_baseline.schema.json", "docs/ICLR_RESOURCE_POLICY.md",
    ],
    model: {
      provider: option(args, "--model-provider") ?? "openai-codex",
      id: option(args, "--model-id") ?? "gpt-5.6-sol",
      thinkingLevel: option(args, "--thinking-level") ?? "high",
    },
    knowledgeBackend,
    developmentBackend,
    ...(knowledgeCommand ? { knowledgeCommand } : {}),
    ...(developmentCommand ? { developmentCommand } : {}),
    researchCommand,
    methodResearchPolicy: {
      scope: "function_prediction_process_or_method_improvement",
      targetSpecificResearch: "forbidden",
      scholarlySourceTiers: ["q1_journal", "top_venue"],
      minimumIndependentScholarlySources: 2,
      officialDocumentationRole: "implementation_details_only",
      unadmittedSources: ["preprints", "blogs", "forums", "vendor_marketing"],
    },
    verificationCommands: [
      { id: "dependency-lock", executable: "/usr/bin/env", args: ["npm", "ci", "--ignore-scripts"], ...commandBase },
      { id: "typecheck", executable: "/usr/bin/env", args: ["npm", "run", "typecheck"], ...commandBase },
      { id: "typescript-tests", executable: "/usr/bin/env", args: ["npm", "run", "test:ts"], ...commandBase },
      { id: "python-tests", executable: "/usr/bin/env", args: ["npm", "run", "test:python"], ...commandBase },
      { id: "rsi-controller-tests", executable: "/usr/bin/env", args: ["npm", "run", "test:rsi"], ...commandBase },
    ],
    evaluatorCommandEnv,
    evaluatorPrivateEnv,
    dataSplit: { manifestPath: resolve(dataSplitPath), manifestHash: dataSplit.training.manifestHash, training: dataSplit.training, validation: dataSplit.manifest.validation, test: dataSplit.manifest.test },
    runtimeAttestations: {
      sandboxEnforced: true,
      nonResearchNetworkIsModelControlPlaneOnly: true,
      evaluatorPrivateDataIsolated: true,
    },
  };
  const config = { ...configBody, canonicalHash: hashCanonical(configBody) };
  await mkdir(runtimeDir, { recursive: true });
  const configPath = resolve(runtimeDir, `${campaignId}-production-worker.json`);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });

  const piAgent = resolve(repositoryRoot, "pi-agent");
  const researchInheritedEnv = Array.isArray(researchCommand.inheritEnv) ? researchCommand.inheritEnv.filter((value): value is string => typeof value === "string") : [];
  const worker = (stage: string, evaluator = false): AutonomousRsiWorkerSpec => ({
    command: piAgent,
    args: ["rsi", "autonomous-rsi-production-worker", "--stage", stage, "--input", "{{input}}", "--output", "{{output}}", "--config", configPath],
    workingDirectory: "project",
    timeoutSeconds: 86_400,
    inheritEnv: [...new Set(evaluator ? ["HOME", "PATH", ...MODEL_CONTROL_ENV, ...evaluatorPrivateEnv] : stage === "research" ? ["HOME", "PATH", ...MODEL_CONTROL_ENV, ...researchInheritedEnv] : stage === "develop" ? ["HOME", "PATH", ...MODEL_CONTROL_ENV, "PI_ICLR_CAPABILITY_CAMPAIGN_ROOT", "PI_ICLR_HOST_CAS"] : ["HOME", "PATH", ...MODEL_CONTROL_ENV])],
    networkAccess: stage === "research" ? "enabled" : "disabled",
  });
  const baselineHash = String(baseline.canonicalHash);
  const evaluatorContractHash = String(option(args, "--evaluator-contract-hash") ?? "");
  if (!/^[a-f0-9]{64}$/.test(evaluatorContractHash)) {
    throw new Error("production initialization requires --evaluator-contract-hash bound to the frozen evaluator/benchmark contract");
  }
  const publishedHistory = option(args, "--published-history");
  const historicalSeeds: AutonomousRsiHistoricalSeed[] = publishedHistory === "none" ? [] : await loadCompatibleHistoricalSeeds({
    repositoryRoot,
    ...(publishedHistory && publishedHistory !== "auto" ? { historyPath: resolve(publishedHistory) } : {}),
    evaluatorContractHash,
    metricId: option(args, "--metric-id") ?? "development_macro_groups123_overall_fmax",
    excludeSourceCommit: sourceCommit,
  });
  const initialCandidate = {
    candidateId: String(baseline.baselineId),
    artifactHash: hashCanonical({ schemaVersion: "pi-autonomous-rsi-baseline-code-binding.v1", baselineHash, sourceCommit, sourceTree }),
    sourceCommit,
  };
  const maximum = Number(option(args, "--max-iterations") ?? 2);
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 100) throw new Error("maxIterations is invalid");
  const experimentPath = option(args, "--experiment-manifest");
  const experiment = experimentPath
    ? assertExperimentManifest(JSON.parse(await readFile(resolve(experimentPath), "utf8")) as unknown)
    : undefined;
  if (experiment) {
    if (experiment.framework !== "latest_autonomous" || experiment.campaignId !== campaignId) throw new Error("experiment manifest does not bind this LatestRSI campaign");
    if (experiment.initialCandidate.candidateId !== initialCandidate.candidateId || experiment.initialCandidate.artifactHash !== initialCandidate.artifactHash || experiment.initialCandidate.sourceCommit !== initialCandidate.sourceCommit) throw new Error("experiment manifest initial candidate differs from production generation 0");
    if (experiment.bindings.evaluatorContractHash !== evaluatorContractHash) throw new Error("experiment/evaluator contract mismatch");
    if (maximum < experiment.budget.maxPatchAttempts + 1) throw new Error("maxIterations must allow G0 plus every pre-registered patch attempt");
  }
  const spec = withAutonomousCanonicalHash({
    schemaVersion: "pi-autonomous-rsi-spec.v1" as const,
    campaignId,
    mode: "development_only" as const,
    objective: {
      metricId: option(args, "--metric-id") ?? "development_macro_groups123_overall_fmax",
      direction: "maximize" as const,
      minimumImprovement: Number(option(args, "--minimum-improvement") ?? 0.001),
      plateauPatience: Number(option(args, "--plateau-patience") ?? 2),
    },
    budget: { maxIterations: maximum, maxStageAttempts: Number(option(args, "--max-stage-attempts") ?? 2) },
    initialCandidate,
    evaluatorContractHash,
    dataSplitManifestHash: dataSplit.training.manifestHash,
    historicalSeeds,
    ...(experiment ? { experiment } : {}),
    workers: {
      evaluate: worker("evaluate", true),
      diagnose: worker("diagnose"),
      research: worker("research"),
      plan: worker("plan"),
      develop: worker("develop"),
      verify: worker("verify"),
    },
    formalGovernance: {
      mode: "handoff_only" as const,
      terminalStopEventSequence: null,
      terminalStopEventHash: null,
      resumeContract: "explicit_append_only_new_epoch_required" as const,
    },
  }) as AutonomousRsiSpec;
  await initializeAutonomousRsiCampaign({ campaignDir, spec });
  await writeAutonomousRsiCampaignIdentity({
    schemaVersion: "pi-autonomous-rsi-campaign-identity.v1",
    campaignId,
    campaignDir,
    repositoryRoot,
    workspaceRoot,
    worktreePath: resolve(workspaceRoot, campaignId, "campaign-worktree"),
    baselineCommit: sourceCommit,
    evaluatorContractHash,
    status: "running",
    archiveManifestHash: null,
    promotionReceiptHash: null,
  });
  return { campaignDir, configPath, spec };
}

export async function productionAutonomousRsiInitCommand(args: string[]): Promise<number> {
  const result = await initializeProductionAutonomousRsi(args);
  console.log(JSON.stringify({ ok: true, campaignDir: result.campaignDir, configPath: result.configPath, specHash: result.spec.canonicalHash }, null, 2));
  return 0;
}
