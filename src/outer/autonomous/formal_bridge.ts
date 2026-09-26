import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { hashCanonical } from "../../hash.js";
import { installRsiControllerBundle } from "../version_graph/rsi_controller_bundle.js";
import { assertAutonomousCandidate, type AutonomousRsiCandidate } from "./contracts.js";
import { verifyAutonomousRsiCampaign } from "./orchestrator.js";

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FORMAL_COMMANDS = [
  "rsi-version-register",
  "rsi-version-evaluation-open",
  "rsi-version-evaluation-complete",
  "rsi-version-evaluation-publish",
  "rsi-version-decide",
  "rsi-version-exploration-record",
] as const;
type FormalCommand = typeof FORMAL_COMMANDS[number];

interface FormalOperation {
  operationId: string;
  command: FormalCommand;
  args: string[];
}

interface FormalAuthorization {
  schemaVersion: "pi-autonomous-rsi-formal-authorization.v1";
  authorizationId: string;
  campaignDir: string;
  repositoryRoot: string;
  remote: string;
  expectedHandoffHash: string;
  expectedCandidate: AutonomousRsiCandidate;
  approvalTokenSha256: string;
  safetyAcceptance: {
    developmentCampaignVerified: true;
    handoffReviewed: true;
    evaluatorIsolationVerified: true;
    unopenedCohortPrecommitted: true;
    remotePublicationRequired: true;
    controllerOwnedMutationsOnly: true;
  };
  operations: FormalOperation[];
  canonicalHash: string;
}

interface FormalBridgeReceipt {
  schemaVersion: "pi-autonomous-rsi-formal-bridge-receipt.v1";
  authorizationId: string;
  authorizationHash: string;
  campaignId: string;
  candidate: AutonomousRsiCandidate;
  controllerBundleHash: string;
  controllerSourceCommit: string;
  status: "running" | "completed" | "reconciliation_required";
  operations: Array<{
    operationId: string;
    command: FormalCommand;
    state: "pending" | "running" | "completed" | "uncertain";
    stdoutSha256: string | null;
    stderrSha256: string | null;
  }>;
  canonicalHash: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw new Error(`${label} keys mismatch`);
}

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function parseAuthorization(value: unknown): FormalAuthorization {
  const item = record(value, "formal authorization");
  exactKeys(item, ["approvalTokenSha256", "authorizationId", "campaignDir", "canonicalHash", "expectedCandidate", "expectedHandoffHash", "operations", "remote", "repositoryRoot", "safetyAcceptance", "schemaVersion"], "formal authorization");
  const { canonicalHash, ...content } = item;
  if (item.schemaVersion !== "pi-autonomous-rsi-formal-authorization.v1") throw new Error("unsupported formal authorization schemaVersion");
  if (!HASH.test(String(canonicalHash)) || canonicalHash !== hashCanonical(content)) throw new Error("formal authorization canonicalHash mismatch");
  if (!SAFE_ID.test(String(item.authorizationId)) || !SAFE_ID.test(String(item.remote))) throw new Error("formal authorization identity is invalid");
  if (!isAbsolute(String(item.campaignDir)) || !isAbsolute(String(item.repositoryRoot))) throw new Error("campaignDir and repositoryRoot must be absolute");
  if (!HASH.test(String(item.expectedHandoffHash)) || !HASH.test(String(item.approvalTokenSha256))) throw new Error("formal authorization hash binding is invalid");
  const safety = record(item.safetyAcceptance, "safetyAcceptance");
  exactKeys(safety, ["controllerOwnedMutationsOnly", "developmentCampaignVerified", "evaluatorIsolationVerified", "handoffReviewed", "remotePublicationRequired", "unopenedCohortPrecommitted"], "safetyAcceptance");
  if (Object.values(safety).some((entry) => entry !== true)) throw new Error("every formal safety acceptance must be true");
  if (!Array.isArray(item.operations) || item.operations.length < 1 || item.operations.length > FORMAL_COMMANDS.length) throw new Error("formal operations must be a bounded non-empty array");
  const seen = new Set<string>();
  let previous = -1;
  const operations = item.operations.map((raw, index) => {
    const operation = record(raw, `operations[${index}]`);
    exactKeys(operation, ["args", "command", "operationId"], `operations[${index}]`);
    if (!SAFE_ID.test(String(operation.operationId)) || seen.has(String(operation.operationId))) throw new Error(`operations[${index}].operationId is invalid or duplicated`);
    seen.add(String(operation.operationId));
    if (!FORMAL_COMMANDS.includes(operation.command as FormalCommand)) throw new Error(`operations[${index}].command is not allowed`);
    const order = FORMAL_COMMANDS.indexOf(operation.command as FormalCommand);
    if (order <= previous) throw new Error("formal operations must be unique and lifecycle ordered");
    previous = order;
    if (!Array.isArray(operation.args) || operation.args.length > 64 || operation.args.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.length > 4096 || /[\r\n\0]/.test(arg))) {
      throw new Error(`operations[${index}].args is invalid`);
    }
    const args = operation.args as string[];
    if (args.some((arg) => arg === "--repo" || arg === "--remote" || arg.startsWith("--repo=") || arg.startsWith("--remote="))) throw new Error("operation args may not override --repo or --remote");
    return { operationId: operation.operationId as string, command: operation.command as FormalCommand, args: [...args] };
  });
  return {
    schemaVersion: item.schemaVersion,
    authorizationId: item.authorizationId as string,
    campaignDir: item.campaignDir as string,
    repositoryRoot: item.repositoryRoot as string,
    remote: item.remote as string,
    expectedHandoffHash: item.expectedHandoffHash as string,
    expectedCandidate: assertAutonomousCandidate(item.expectedCandidate, "expectedCandidate"),
    approvalTokenSha256: item.approvalTokenSha256 as string,
    safetyAcceptance: safety as unknown as FormalAuthorization["safetyAcceptance"],
    operations,
    canonicalHash: canonicalHash as string,
  };
}

async function git(repository: string, args: string[]): Promise<string> {
  return await run("/usr/bin/git", args, repository).then((result) => result.stdout.trim());
}

async function run(executable: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd,
      env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolveRun({ stdout: out, stderr: err });
      else rejectRun(new Error(`formal controller command failed (${code ?? signal ?? "unknown"}): ${err.slice(-4000)}`));
    });
  });
}

function withHash<T extends Record<string, unknown>>(value: T): T & { canonicalHash: string } {
  return { ...value, canonicalHash: hashCanonical(value) };
}

async function writeReceipt(path: string, receipt: Omit<FormalBridgeReceipt, "canonicalHash">): Promise<FormalBridgeReceipt> {
  const value = withHash(receipt) as FormalBridgeReceipt;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
  return value;
}

function inside(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function candidateEqual(left: AutonomousRsiCandidate, right: AutonomousRsiCandidate): boolean {
  return left.candidateId === right.candidateId && left.artifactHash === right.artifactHash && left.sourceCommit === right.sourceCommit;
}

function approvalToken(): string {
  const token = process.env.PI_AUTONOMOUS_RSI_FORMAL_APPROVAL_TOKEN;
  if (!token || token.length < 24) throw new Error("PI_AUTONOMOUS_RSI_FORMAL_APPROVAL_TOKEN is missing or too short");
  return createHash("sha256").update(token).digest("hex");
}

export async function executeAutonomousRsiFormalBridge(input: {
  authorizationPath: string;
  receiptPath: string;
}): Promise<FormalBridgeReceipt> {
  const authorization = parseAuthorization(await loadJson(input.authorizationPath));
  if (approvalToken() !== authorization.approvalTokenSha256) throw new Error("formal approval token hash mismatch");
  const campaignDir = await realpath(authorization.campaignDir);
  const repositoryRoot = await realpath(authorization.repositoryRoot);
  const receiptPath = resolve(input.receiptPath);
  if (inside(campaignDir, repositoryRoot) || inside(receiptPath, repositoryRoot)) throw new Error("formal campaign and receipt must remain outside the candidate repository");
  try {
    await readFile(receiptPath, "utf8");
    throw new Error("formal bridge receipt already exists; refuse to replay or guess operation state");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const verification = await verifyAutonomousRsiCampaign(campaignDir);
  if (!verification.valid || !["completed", "stopped"].includes(verification.status)) throw new Error("development campaign is not terminal and verified");
  const handoff = record(await loadJson(resolve(campaignDir, "formal_handoff.json")), "formal handoff");
  if (handoff.canonicalHash !== authorization.expectedHandoffHash) throw new Error("formal handoff hash mismatch");
  const handoffCandidate = assertAutonomousCandidate(
    handoff.selectedCandidate ?? handoff.currentCandidate,
    "formal handoff selectedCandidate",
  );
  if (!candidateEqual(handoffCandidate, authorization.expectedCandidate)) throw new Error("formal authorization candidate differs from verified handoff selection");
  if (!authorization.expectedCandidate.sourceCommit) throw new Error("formal candidate is not commit-bound");
  const top = await realpath(await git(repositoryRoot, ["rev-parse", "--show-toplevel"]));
  if (top !== repositoryRoot) throw new Error("repositoryRoot is not the candidate Git top level");
  if (await git(repositoryRoot, ["rev-parse", "HEAD"]) !== authorization.expectedCandidate.sourceCommit) throw new Error("formal repository HEAD differs from authorized candidate");
  if (await git(repositoryRoot, ["status", "--porcelain", "--untracked-files=normal"])) throw new Error("formal repository must be completely clean");
  await git(repositoryRoot, ["remote", "get-url", authorization.remote]);

  const controller = await installRsiControllerBundle({ repositoryRoot });
  const sourceCommit = controller.manifest.controllerSource.sourceCommit;
  if (sourceCommit !== authorization.expectedCandidate.sourceCommit) throw new Error("installed controller is not bound to the authorized candidate commit");
  const bundleHash = controller.manifest.canonicalHash;
  const base = {
    schemaVersion: "pi-autonomous-rsi-formal-bridge-receipt.v1" as const,
    authorizationId: authorization.authorizationId,
    authorizationHash: authorization.canonicalHash,
    campaignId: String(handoff.campaignId),
    candidate: authorization.expectedCandidate,
    controllerBundleHash: bundleHash,
    controllerSourceCommit: sourceCommit,
  };
  let receipt: Omit<FormalBridgeReceipt, "canonicalHash"> = {
    ...base,
    status: "running",
    operations: authorization.operations.map((operation) => ({ operationId: operation.operationId, command: operation.command, state: "pending", stdoutSha256: null, stderrSha256: null })),
  };
  await writeReceipt(receiptPath, receipt);

  for (let index = 0; index < authorization.operations.length; index += 1) {
    const operation = authorization.operations[index]!;
    receipt.operations[index] = { ...receipt.operations[index]!, state: "running" };
    await writeReceipt(receiptPath, receipt);
    try {
      const result = await run(controller.nodeExecutablePath, [controller.runnerPath, operation.command, "--repo", repositoryRoot, ...operation.args, "--remote", authorization.remote], repositoryRoot);
      receipt.operations[index] = {
        ...receipt.operations[index]!,
        state: "completed",
        stdoutSha256: createHash("sha256").update(result.stdout).digest("hex"),
        stderrSha256: createHash("sha256").update(result.stderr).digest("hex"),
      };
      await writeReceipt(receiptPath, receipt);
    } catch (error) {
      receipt.operations[index] = { ...receipt.operations[index]!, state: "uncertain" };
      receipt.status = "reconciliation_required";
      await writeReceipt(receiptPath, receipt);
      throw error;
    }
  }
  receipt.status = "completed";
  return await writeReceipt(receiptPath, receipt);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function autonomousRsiFormalBridgeCommand(args: string[]): Promise<number> {
  const authorization = option(args, "--authorization");
  const receipt = option(args, "--receipt");
  if (!authorization || !receipt) throw new Error("autonomous-rsi-formal-bridge requires --authorization and --receipt");
  const result = await executeAutonomousRsiFormalBridge({ authorizationPath: resolve(authorization), receiptPath: resolve(receipt) });
  console.log(JSON.stringify({ ok: result.status === "completed", status: result.status, canonicalHash: result.canonicalHash }, null, 2));
  return result.status === "completed" ? 0 : 1;
}
