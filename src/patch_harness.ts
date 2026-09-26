import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync } from "node:fs";
import { access, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
} from "./codex_runtime.js";
import { Type } from "typebox";

import { hashCanonical, sha256Text } from "./hash.js";
import { TEACHER_ACTION_IDS, type TeacherActionId } from "./teacher_evaluator.js";

const execFileAsync = promisify(execFile);

export const PATCH_EXPERIMENT_IDS = [
  "candidate_label_retriever",
  "remote_evidence_recompute",
  "source_decorrelation",
  "aspect_selection_calibration",
] as const;
export type PatchExperimentId = typeof PATCH_EXPERIMENT_IDS[number];

const PROTECTED_PATH = /^(?:benchmarks|benchmark_runs|campaigns|runs|evaluator_private|schemas)\//;
const PRIVATE_TOKEN = /(?:GO:\d{7}|CASE[_-][A-Z0-9_-]+|(?:^|[^A-Z0-9])(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-\d+)?(?=$|[^A-Z0-9]))/i;

const EXPERIMENTS: Readonly<Record<PatchExperimentId, {
  teacherActions: readonly TeacherActionId[];
  allowedFiles: readonly string[];
  maximumChangedLines: number;
  requiredGateIds: readonly PatchGateId[];
  evidenceMode: "frozen_replay" | "full_tool_recompute";
}>> = {
  candidate_label_retriever: {
    teacherActions: ["add_ontology_label_retriever", "expand_direct_candidates"],
    allowedFiles: [
      "src/candidate_sources.ts",
      "src/go.ts",
      "src/types.ts",
    ],
    maximumChangedLines: 600,
    requiredGateIds: ["typecheck", "candidate_tests", "privacy_tests"],
    evidenceMode: "frozen_replay",
  },
  remote_evidence_recompute: {
    teacherActions: ["rerun_evidence_acquisition"],
    allowedFiles: [
      "src/evidence_acquisition.ts",
      "src/full_recompute_command.ts",
      "src/benchmark.ts",
      "python/evidence_pipeline.py",
      "python/ncbi_remote_blast.py",
      "python/foldseek_remote.py",
    ],
    maximumChangedLines: 900,
    requiredGateIds: ["typecheck", "evidence_ts_tests", "evidence_python_tests", "privacy_tests"],
    evidenceMode: "full_tool_recompute",
  },
  source_decorrelation: {
    teacherActions: ["decorrelate_sources", "strengthen_phylogeny_context"],
    allowedFiles: [
      "src/candidate_sources.ts",
      "src/go.ts",
      "src/phylogeny.ts",
    ],
    maximumChangedLines: 500,
    requiredGateIds: ["typecheck", "candidate_tests", "privacy_tests"],
    evidenceMode: "frozen_replay",
  },
  aspect_selection_calibration: {
    teacherActions: [
      "calibrate_mf_selection",
      "calibrate_bp_selection",
      "calibrate_cc_selection",
      "calibrate_aspect_selection",
      "tighten_selection_budget",
    ],
    allowedFiles: [
      "src/go.ts",
      "src/go_selection.ts",
      "src/genome.ts",
      "src/types.ts",
    ],
    maximumChangedLines: 500,
    requiredGateIds: ["typecheck", "go_tests", "privacy_tests"],
    evidenceMode: "frozen_replay",
  },
};

export type PatchGateId =
  | "typecheck"
  | "candidate_tests"
  | "go_tests"
  | "evidence_ts_tests"
  | "evidence_python_tests"
  | "privacy_tests";

export interface PatchExperimentSpec {
  schemaVersion: "pi-patch-experiment-spec.v1";
  experimentId: PatchExperimentId;
  teacherAction: TeacherActionId;
  retainedParentGenomeHash: string;
  sourceCommit: string;
  allowedFiles: string[];
  maximumChangedLines: number;
  maximumEditOperations: number;
  requiredGateIds: PatchGateId[];
  evidenceMode: "frozen_replay" | "full_tool_recompute";
  evaluatorBoundary: "developer_worktree_has_no_private_evaluator_mount";
  rollbackPolicy: "discard_worktree_on_any_failed_gate";
  canonicalHash: string;
}

export interface PatchDiffSummary {
  files: Array<{ path: string; addedLines: number; deletedLines: number }>;
  totalChangedLines: number;
  canonicalHash: string;
}

export interface PatchGateResult {
  gateId: PatchGateId;
  passed: boolean;
  exitCode: number;
  stdoutSha256: string;
  stderrSha256: string;
}

export type PatchSandboxBackend = "macos_sandbox_exec" | "linux_bwrap" | "test_injected" | "unsupported";

export interface PatchSandboxAttestation {
  backend: PatchSandboxBackend;
  verified: boolean;
  networkPolicy: "denied" | "unverified";
  filesystemPolicy: "worktree_and_runtime_read_only_scratch_write_only" | "unverified";
  environmentPolicy: "minimal_no_inherited_secrets" | "unverified";
}

export interface PatchSandboxRunInput {
  command: string;
  args: string[];
  cwd: string;
  scratchDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBufferBytes: number;
}

export interface PatchSandboxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A test may inject this interface; the CLI never accepts a runner or backend name. */
export interface PatchSandboxExecutor {
  attestation: PatchSandboxAttestation;
  run(input: PatchSandboxRunInput): Promise<PatchSandboxRunResult>;
}

export interface PatchGateExecution {
  sandbox: PatchSandboxAttestation;
  gateResults: PatchGateResult[];
}

export interface PatchTrialReceipt {
  schemaVersion: "pi-patch-trial-receipt.v2";
  experimentSpecHash: string;
  sourceCommit: string;
  patchDiffHash: string;
  patchContentSha256: string;
  sandbox: PatchSandboxAttestation;
  gateResults: PatchGateResult[];
  evidenceAcquisitionReceiptHash: string | null;
  privateEvaluationReceiptHash: string | null;
  decision:
    | "eligible_for_private_evaluation"
    | "pending_full_recompute"
    | "rejected_gate"
    | "rejected_unsupported_sandbox";
  canonicalHash: string;
}

function canonicalFilePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(normalized)
    || normalized.startsWith("/")
    || normalized.split("/").some((part) => part === "." || part === "..")
    || PROTECTED_PATH.test(normalized)) {
    throw new Error("patch path is unsafe or evaluator-protected");
  }
  return normalized;
}

function exactSha(value: string, label: string): string {
  if (!/^[a-f0-9]{40,64}$/.test(value)) throw new Error(`${label} must be a lowercase Git/SHA hash`);
  return value;
}

export function buildPatchExperimentSpec(input: {
  experimentId: PatchExperimentId;
  teacherAction: TeacherActionId;
  retainedParentGenomeHash: string;
  sourceCommit: string;
}): PatchExperimentSpec {
  const registered = EXPERIMENTS[input.experimentId];
  if (!registered || !registered.teacherActions.includes(input.teacherAction)) {
    throw new Error("teacher action is not registered for this patch experiment");
  }
  const content = {
    schemaVersion: "pi-patch-experiment-spec.v1" as const,
    experimentId: input.experimentId,
    teacherAction: input.teacherAction,
    retainedParentGenomeHash: exactSha(input.retainedParentGenomeHash, "retainedParentGenomeHash"),
    sourceCommit: exactSha(input.sourceCommit, "sourceCommit"),
    allowedFiles: registered.allowedFiles.map(canonicalFilePath),
    maximumChangedLines: registered.maximumChangedLines,
    maximumEditOperations: 12,
    requiredGateIds: [...registered.requiredGateIds],
    evidenceMode: registered.evidenceMode,
    evaluatorBoundary: "developer_worktree_has_no_private_evaluator_mount" as const,
    rollbackPolicy: "discard_worktree_on_any_failed_gate" as const,
  };
  return { ...content, canonicalHash: hashCanonical(content) };
}

/** Resolve one Teacher enum through the closed patch registry.
 *
 * Callers cannot supply or override this mapping. A future registry edit that
 * accidentally assigns one action to multiple experiments fails closed.
 */
export function registeredPatchExperimentForAction(action: TeacherActionId): PatchExperimentId | null {
  if (!(TEACHER_ACTION_IDS as readonly unknown[]).includes(action)) {
    throw new Error(`Unknown Teacher action: ${String(action)}`);
  }
  const matches = PATCH_EXPERIMENT_IDS.filter((experimentId) =>
    EXPERIMENTS[experimentId].teacherActions.includes(action));
  if (matches.length > 1) throw new Error(`Teacher action has ambiguous registered patch experiments: ${action}`);
  return matches[0] ?? null;
}

export function assertPatchExperimentSpec(value: unknown): PatchExperimentSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("patch experiment spec must be an object");
  const typed = value as PatchExperimentSpec;
  const expected = buildPatchExperimentSpec({
    experimentId: typed.experimentId,
    teacherAction: typed.teacherAction,
    retainedParentGenomeHash: typed.retainedParentGenomeHash,
    sourceCommit: typed.sourceCommit,
  });
  if (typed.canonicalHash !== expected.canonicalHash || JSON.stringify(typed) !== JSON.stringify(expected)) {
    throw new Error("patch experiment spec is not the canonical registered experiment");
  }
  return typed;
}

export function validatePatchDiff(specInput: PatchExperimentSpec, files: PatchDiffSummary["files"]): PatchDiffSummary {
  const spec = assertPatchExperimentSpec(specInput);
  if (!Array.isArray(files) || files.length === 0) throw new Error("patch trial has no source changes");
  const allowed = new Set(spec.allowedFiles);
  const seen = new Set<string>();
  const normalized = files.map((item) => {
    const path = canonicalFilePath(item.path);
    if (!allowed.has(path)) throw new Error(`patch modifies a file outside the experiment allowlist: ${path}`);
    if (seen.has(path)) throw new Error(`patch diff contains duplicate file: ${path}`);
    seen.add(path);
    if (!Number.isInteger(item.addedLines) || item.addedLines < 0
      || !Number.isInteger(item.deletedLines) || item.deletedLines < 0) {
      throw new Error("patch line counts must be non-negative integers");
    }
    return { path, addedLines: item.addedLines, deletedLines: item.deletedLines };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const totalChangedLines = normalized.reduce((sum, item) => sum + item.addedLines + item.deletedLines, 0);
  if (totalChangedLines === 0 || totalChangedLines > spec.maximumChangedLines) {
    throw new Error("patch exceeds the registered changed-line budget");
  }
  const content = { files: normalized, totalChangedLines };
  return { ...content, canonicalHash: hashCanonical(content) };
}

export async function inspectPatchDiff(worktree: string, spec: PatchExperimentSpec): Promise<PatchDiffSummary> {
  const { stdout } = await execFileAsync("git", ["diff", "--numstat", "--", ...spec.allowedFiles], {
    cwd: worktree,
    maxBuffer: 2 * 1024 * 1024,
  });
  const files = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [added, deleted, ...pathParts] = line.split("\t");
    if (added === "-" || deleted === "-") throw new Error("binary patch files are forbidden");
    return {
      path: pathParts.join("\t"),
      addedLines: Number(added),
      deletedLines: Number(deleted),
    };
  });
  return validatePatchDiff(spec, files);
}

async function resolveAllowedFile(worktree: string, spec: PatchExperimentSpec, requested: string): Promise<string> {
  const path = canonicalFilePath(requested);
  if (!spec.allowedFiles.includes(path)) throw new Error("file is outside the patch experiment allowlist");
  const root = resolve(worktree);
  const target = resolve(root, path);
  if (relative(root, target).startsWith("..")) throw new Error("file escapes the isolated patch worktree");
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("patch tools accept regular non-symlink source files only");
  return target;
}

export async function readAllowedPatchSource(worktree: string, spec: PatchExperimentSpec, path: string): Promise<string> {
  const target = await resolveAllowedFile(worktree, assertPatchExperimentSpec(spec), path);
  const text = await readFile(target, "utf8");
  if (text.length > 300_000) throw new Error("source file exceeds the bounded patch read budget");
  return text;
}

export async function replaceAllowedPatchSource(input: {
  worktree: string;
  spec: PatchExperimentSpec;
  path: string;
  oldText: string;
  newText: string;
}): Promise<void> {
  if (!input.oldText || input.oldText.length > 30_000 || input.newText.length > 60_000) {
    throw new Error("patch replacement exceeds the bounded edit size");
  }
  if (PRIVATE_TOKEN.test(input.oldText) || PRIVATE_TOKEN.test(input.newText)) {
    throw new Error("patch replacement contains a forbidden label, case, or accession token");
  }
  const target = await resolveAllowedFile(input.worktree, assertPatchExperimentSpec(input.spec), input.path);
  const prior = await readFile(target, "utf8");
  const first = prior.indexOf(input.oldText);
  if (first < 0 || prior.indexOf(input.oldText, first + input.oldText.length) >= 0) {
    throw new Error("patch oldText must match exactly once");
  }
  const next = `${prior.slice(0, first)}${input.newText}${prior.slice(first + input.oldText.length)}`;
  if (next.length > 400_000) throw new Error("edited source file exceeds the bounded file size");
  await writeFile(target, next, "utf8");
}

const GATE_COMMANDS: Readonly<Record<PatchGateId, { command: string; args: readonly string[] }>> = {
  typecheck: { command: process.execPath, args: ["node_modules/typescript/bin/tsc", "--noEmit"] },
  candidate_tests: { command: process.execPath, args: ["node_modules/tsx/dist/cli.mjs", "--test", "src/candidate_sources.test.ts", "src/go.test.ts"] },
  go_tests: { command: process.execPath, args: ["node_modules/tsx/dist/cli.mjs", "--test", "src/go.test.ts", "src/go_selection.test.ts", "src/genome.test.ts"] },
  evidence_ts_tests: {
    command: process.execPath,
    args: [
      "node_modules/tsx/dist/cli.mjs",
      "--test",
      "src/evidence_acquisition.test.ts",
      "src/full_recompute_command.test.ts",
      "src/benchmark_security.test.ts",
    ],
  },
  evidence_python_tests: {
    command: "python3",
    args: [
      "-m", "unittest", "-v",
      "python.test_evidence_pipeline",
      "python.test_ncbi_remote_blast",
      "python.test_foldseek_remote",
    ],
  },
  privacy_tests: { command: process.execPath, args: ["node_modules/tsx/dist/cli.mjs", "--test", "src/outer_architect.test.ts", "src/benchmark_security.test.ts"] },
};

function pathIsInside(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
}

function executableSync(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function worktreeManagedExecutable(worktree: string, path: string): boolean {
  if (!pathIsInside(worktree, path) || !executableSync(path)) return false;
  try {
    return pathIsInside(realpathSync(worktree), realpathSync(path));
  } catch {
    return false;
  }
}

/** Resolve the repository-managed Python without inheriting a workstation Python. */
export function patchPythonCommand(worktreeInput: string): string {
  const worktree = resolve(worktreeInput);
  const managedConfig = join(worktree, "config", "managed.env");
  if (existsSync(managedConfig)) {
    try {
      const configured = (() => {
        // Keep this parser deliberately tiny and side-effect free: the gate
        // needs only PYTHON_BIN, not the rest of the runtime environment.
        const body = readFileSync(managedConfig, "utf8");
        for (const raw of body.split(/\r?\n/)) {
          let line = raw.trim();
          if (!line || line.startsWith("#")) continue;
          if (line.startsWith("export ")) line = line.slice(7).trim();
          if (!line.startsWith("PYTHON_BIN=")) continue;
          let value = line.slice("PYTHON_BIN=".length).trim();
          if ((value.startsWith("\"") && value.endsWith("\""))
            || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
          return resolve(worktree, value);
        }
        return undefined;
      })();
      // The sandbox only grants the source worktree and managed system roots.
      // An absolute developer override outside that boundary is intentionally
      // ignored here instead of silently widening gate access.
      if (configured && worktreeManagedExecutable(worktree, configured)) return configured;
    } catch {
      // Fall through to the canonical repo-managed path.
    }
  }
  const repositoryManaged = join(worktree, ".runtime", "env", "bin", process.platform === "win32" ? "python.exe" : "python");
  if (worktreeManagedExecutable(worktree, repositoryManaged)) return repositoryManaged;
  return process.platform === "win32" ? "python" : "python3";
}

/** Public audit view of the closed gate registry; callers cannot override it. */
export function patchGateInvocation(gateId: PatchGateId, worktree = resolve(".")): { command: string; args: string[] } {
  const gate = GATE_COMMANDS[gateId];
  return {
    command: gateId === "evidence_python_tests" ? patchPythonCommand(worktree) : gate.command,
    args: [...gate.args],
  };
}

const VERIFIED_SANDBOX: Omit<PatchSandboxAttestation, "backend"> = {
  verified: true,
  networkPolicy: "denied",
  filesystemPolicy: "worktree_and_runtime_read_only_scratch_write_only",
  environmentPolicy: "minimal_no_inherited_secrets",
};

const UNSUPPORTED_SANDBOX: PatchSandboxAttestation = {
  backend: "unsupported",
  verified: false,
  networkPolicy: "unverified",
  filesystemPolicy: "unverified",
  environmentPolicy: "unverified",
};

function sandboxQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function minimalGateEnvironment(scratchDir: string): NodeJS.ProcessEnv {
  return {
    HOME: join(scratchDir, "home"),
    TMPDIR: join(scratchDir, "tmp"),
    TMP: join(scratchDir, "tmp"),
    TEMP: join(scratchDir, "tmp"),
    PATH: `${dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    npm_config_cache: join(scratchDir, "npm-cache"),
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
  };
}

async function macOsSandboxExecutor(worktree: string): Promise<PatchSandboxExecutor | null> {
  const sandboxExec = "/usr/bin/sandbox-exec";
  if (!await executable(sandboxExec)) return null;
  return {
    attestation: { backend: "macos_sandbox_exec", ...VERIFIED_SANDBOX },
    async run(input) {
      const canonicalScratch = await realpath(input.scratchDir);
      const systemRoots = [
        "/System",
        "/usr",
        "/Library",
        "/opt/homebrew",
        "/usr/local",
        "/private/etc",
        "/private/var/db/dyld",
        "/dev",
      ];
      const existingRoots: string[] = [];
      for (const root of systemRoots) {
        try {
          await access(root);
          existingRoots.push(root);
        } catch {
          // Optional package-manager roots need not exist.
        }
      }
      const readableSubtrees = [...existingRoots, resolve(worktree), canonicalScratch];
      const readableParents = [...new Set(readableSubtrees.flatMap((path) => ["/", ...parentMountDirectories(path)]))];
      const readRules = [
        ...readableSubtrees.map((path) => `(subpath ${sandboxQuote(path)})`),
        ...readableParents.map((path) => `(literal ${sandboxQuote(path)})`),
      ].join(" ");
      const profile = [
        "(version 1)",
        "(deny default)",
        "(allow process*)",
        "(allow signal (target self))",
        "(allow sysctl-read)",
        "(allow mach-lookup)",
        `(allow file-read* ${readRules})`,
        `(allow file-write* (subpath ${sandboxQuote(canonicalScratch)}))`,
        "(deny network*)",
        `(allow network-bind network-inbound network-outbound (prefix ${sandboxQuote(`${canonicalScratch}/`)}))`,
      ].join("\n");
      const profilePath = join(input.scratchDir, "sandbox.sb");
      await writeFile(profilePath, `${profile}\n`, { encoding: "utf8", mode: 0o600 });
      const canonicalEnv = {
        ...input.env,
        HOME: join(canonicalScratch, "home"),
        TMPDIR: join(canonicalScratch, "tmp"),
        TMP: join(canonicalScratch, "tmp"),
        TEMP: join(canonicalScratch, "tmp"),
        npm_config_cache: join(canonicalScratch, "npm-cache"),
      };
      try {
        const result = await execFileAsync(sandboxExec, ["-f", profilePath, input.command, ...input.args], {
          cwd: input.cwd,
          env: canonicalEnv,
          timeout: input.timeoutMs,
          maxBuffer: input.maxBufferBytes,
          encoding: "utf8",
        });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const typed = error as { code?: number; stdout?: string; stderr?: string };
        return {
          exitCode: typeof typed.code === "number" ? typed.code : 1,
          stdout: typed.stdout ?? "",
          stderr: typed.stderr ?? String(error),
        };
      }
    },
  };
}

function parentMountDirectories(path: string): string[] {
  const output: string[] = [];
  let cursor = dirname(resolve(path));
  while (cursor !== "/") {
    output.push(cursor);
    cursor = dirname(cursor);
  }
  return output.reverse();
}

async function linuxBubblewrapExecutor(worktree: string): Promise<PatchSandboxExecutor | null> {
  if (process.platform !== "linux") return null;
  let bwrap: string | undefined;
  for (const candidate of ["/usr/bin/bwrap", "/bin/bwrap"]) {
    if (await executable(candidate)) {
      bwrap = candidate;
      break;
    }
  }
  if (!bwrap) return null;
  return {
    attestation: { backend: "linux_bwrap", ...VERIFIED_SANDBOX },
    async run(input) {
      const roots = ["/usr", "/bin", "/lib", "/lib64", "/opt", "/usr/local"];
      const existingRoots: string[] = [];
      for (const root of roots) {
        try {
          await access(root);
          existingRoots.push(root);
        } catch {
          // Architecture/package-manager dependent roots are optional.
        }
      }
      const dirs = [...new Set([
        ...existingRoots.flatMap(parentMountDirectories),
        ...parentMountDirectories(worktree),
        ...parentMountDirectories(input.scratchDir),
      ])];
      const args = [
        "--die-with-parent", "--new-session", "--unshare-all", "--unshare-net",
        "--proc", "/proc", "--dev", "/dev",
        ...dirs.flatMap((path) => ["--dir", path]),
        ...existingRoots.flatMap((path) => ["--ro-bind", path, path]),
        "--ro-bind", resolve(worktree), resolve(worktree),
        "--bind", resolve(input.scratchDir), resolve(input.scratchDir),
        "--bind", join(resolve(input.scratchDir), "tmp"), "/tmp",
        ...dirs.flatMap((path) => ["--chmod", "0555", path]),
        "--chdir", input.cwd,
        "--", input.command, ...input.args,
      ];
      try {
        const result = await execFileAsync(bwrap, args, {
          cwd: input.cwd,
          env: input.env,
          timeout: input.timeoutMs,
          maxBuffer: input.maxBufferBytes,
          encoding: "utf8",
        });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const typed = error as { code?: number; stdout?: string; stderr?: string };
        return {
          exitCode: typeof typed.code === "number" ? typed.code : 1,
          stdout: typed.stdout ?? "",
          stderr: typed.stderr ?? String(error),
        };
      }
    },
  };
}

export async function verifyPatchSandboxExecutor(executor: PatchSandboxExecutor, worktreeInput: string): Promise<boolean> {
  const worktree = await realpath(resolve(worktreeInput));
  const probeRoot = await mkdtemp(join(tmpdir(), "pi-patch-sandbox-probe-"));
  const worktreeProbeRoot = await mkdtemp(join(worktree, ".pi-patch-sandbox-probe-"));
  const scratchDir = join(probeRoot, "scratch");
  const forbiddenReadPath = join(probeRoot, "forbidden-read.txt");
  const forbiddenWritePath = join(probeRoot, "forbidden-write.txt");
  const worktreeSentinelPath = join(worktreeProbeRoot, "read-only.txt");
  const worktreeSentinel = "worktree-readable-but-not-writable\n";
  const forbiddenEnvironmentName = "PI_PATCH_SANDBOX_FORBIDDEN_SENTINEL";
  const previousForbiddenEnvironment = process.env[forbiddenEnvironmentName];
  await import("node:fs/promises").then(async ({ mkdir }) => {
    await mkdir(join(scratchDir, "home"), { recursive: true });
    await mkdir(join(scratchDir, "tmp"), { recursive: true });
  });
  await writeFile(forbiddenReadPath, "sandbox-probe-secret\n", "utf8");
  await writeFile(worktreeSentinelPath, worktreeSentinel, "utf8");
  process.env[forbiddenEnvironmentName] = "must-not-be-inherited";
  try {
    const script = [
      "const fs=require('node:fs');",
      "const net=require('node:net');",
      `if(fs.readFileSync(${JSON.stringify(worktreeSentinelPath)},'utf8')!==${JSON.stringify(worktreeSentinel)})process.exit(41);`,
      `try{fs.appendFileSync(${JSON.stringify(worktreeSentinelPath)},'forbidden');process.exit(42)}catch{}`,
      `try{fs.readFileSync(${JSON.stringify(forbiddenReadPath)});process.exit(43)}catch{}`,
      `try{fs.writeFileSync(${JSON.stringify(forbiddenWritePath)},'forbidden');process.exit(44)}catch{}`,
      `if([${JSON.stringify(forbiddenEnvironmentName)},'AWS_SECRET_ACCESS_KEY','GITHUB_TOKEN','NCBI_BLAST_EMAIL','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','PYTHONPATH','NODE_OPTIONS'].some(k=>process.env[k]!==undefined))process.exit(45);`,
      "try{fs.writeFileSync(process.env.TMPDIR+'/probe.txt','ok');if(fs.readFileSync(process.env.TMPDIR+'/probe.txt','utf8')!=='ok')process.exit(46)}catch{process.exit(46)}",
      "let done=false;const finish=(code)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();process.exit(code)};",
      "const socket=net.createConnection({host:'198.51.100.1',port:9});",
      "socket.once('connect',()=>finish(47));",
      "socket.once('error',(error)=>finish(['EPERM','EACCES','ENETUNREACH','EHOSTUNREACH'].includes(error.code)?0:48));",
      "const timer=setTimeout(()=>finish(49),1500);",
    ].join("");
    const result = await executor.run({
      command: process.execPath,
      args: ["-e", script],
      cwd: worktree,
      scratchDir,
      env: minimalGateEnvironment(scratchDir),
      timeoutMs: 15_000,
      maxBufferBytes: 512 * 1024,
    });
    let outsideWriteExists = true;
    try {
      await access(forbiddenWritePath);
    } catch {
      outsideWriteExists = false;
    }
    let scratchProbe = "";
    try {
      scratchProbe = await readFile(join(scratchDir, "tmp", "probe.txt"), "utf8");
    } catch {
      // A claimed scratch-write allowance must leave the exact host-visible probe.
    }
    return result.exitCode === 0
      && await readFile(worktreeSentinelPath, "utf8") === worktreeSentinel
      && !outsideWriteExists
      && scratchProbe === "ok";
  } finally {
    if (previousForbiddenEnvironment === undefined) delete process.env[forbiddenEnvironmentName];
    else process.env[forbiddenEnvironmentName] = previousForbiddenEnvironment;
    await rm(worktreeProbeRoot, { recursive: true, force: true });
    await rm(probeRoot, { recursive: true, force: true });
  }
}

/** Detect and actively probe the only supported host isolation backends. */
export async function detectVerifiedPatchSandboxExecutor(worktree: string): Promise<PatchSandboxExecutor | null> {
  const candidate = process.platform === "darwin"
    ? await macOsSandboxExecutor(worktree)
    : process.platform === "linux"
      ? await linuxBubblewrapExecutor(worktree)
      : null;
  if (!candidate || !await verifyPatchSandboxExecutor(candidate, worktree)) return null;
  return candidate;
}

function attestationIsVerified(value: PatchSandboxAttestation): boolean {
  return value && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [
      "backend", "environmentPolicy", "filesystemPolicy", "networkPolicy", "verified",
    ].sort().join(",")
    && value.verified === true
    && ["macos_sandbox_exec", "linux_bwrap", "test_injected"].includes(value.backend)
    && value.networkPolicy === "denied"
    && value.filesystemPolicy === "worktree_and_runtime_read_only_scratch_write_only"
    && value.environmentPolicy === "minimal_no_inherited_secrets";
}

export async function runPatchGates(
  worktree: string,
  specInput: PatchExperimentSpec,
  injectedExecutor?: PatchSandboxExecutor,
): Promise<PatchGateExecution> {
  const spec = assertPatchExperimentSpec(specInput);
  const executor = injectedExecutor ?? await detectVerifiedPatchSandboxExecutor(worktree);
  if (!executor || !attestationIsVerified(executor.attestation)) {
    return { sandbox: UNSUPPORTED_SANDBOX, gateResults: [] };
  }
  const scratchDir = await mkdtemp(join(tmpdir(), "pi-patch-gates-"));
  await import("node:fs/promises").then(async ({ mkdir }) => {
    await mkdir(join(scratchDir, "home"), { recursive: true });
    await mkdir(join(scratchDir, "tmp"), { recursive: true });
  });
  const output: PatchGateResult[] = [];
  try {
    for (const gateId of spec.requiredGateIds) {
      const gate = patchGateInvocation(gateId, worktree);
      const result = await executor.run({
        command: gate.command,
        args: [...gate.args],
        cwd: worktree,
        scratchDir,
        env: minimalGateEnvironment(scratchDir),
        timeoutMs: 15 * 60_000,
        maxBufferBytes: 8 * 1024 * 1024,
      });
      output.push({
        gateId,
        passed: result.exitCode === 0,
        exitCode: result.exitCode,
        stdoutSha256: sha256Text(result.stdout),
        stderrSha256: sha256Text(result.stderr),
      });
      if (result.exitCode !== 0) break;
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
  return { sandbox: { ...executor.attestation }, gateResults: output };
}

export function buildPatchTrialReceipt(input: {
  spec: PatchExperimentSpec;
  diff: PatchDiffSummary;
  patchContentSha256: string;
  gateExecution: PatchGateExecution;
}): PatchTrialReceipt {
  const spec = assertPatchExperimentSpec(input.spec);
  const diff = validatePatchDiff(spec, input.diff.files);
  if (diff.canonicalHash !== input.diff.canonicalHash) throw new Error("patch diff summary hash mismatch");
  if (!/^[a-f0-9]{64}$/.test(input.patchContentSha256)) throw new Error("patch content hash is invalid");
  const gateResults = input.gateExecution.gateResults;
  if (!Array.isArray(gateResults)) throw new Error("patch gate results must be an array");
  for (const result of gateResults) {
    if (!result || typeof result !== "object" || Array.isArray(result)
      || Object.keys(result).sort().join(",") !== [
        "exitCode", "gateId", "passed", "stderrSha256", "stdoutSha256",
      ].sort().join(",")
      || !Number.isInteger(result.exitCode) || result.exitCode < 0
      || result.passed !== (result.exitCode === 0)
      || !/^[a-f0-9]{64}$/.test(result.stdoutSha256)
      || !/^[a-f0-9]{64}$/.test(result.stderrSha256)) {
      throw new Error("patch gate result is invalid or non-canonical");
    }
  }
  if (gateResults.some((item, index) => item.gateId !== spec.requiredGateIds[index])) {
    throw new Error("patch gate results do not follow the registered gate order");
  }
  const sandboxVerified = attestationIsVerified(input.gateExecution.sandbox);
  const sandboxUnsupported = input.gateExecution.sandbox
    && typeof input.gateExecution.sandbox === "object"
    && !Array.isArray(input.gateExecution.sandbox)
    && Object.keys(input.gateExecution.sandbox).sort().join(",") === [
      "backend", "environmentPolicy", "filesystemPolicy", "networkPolicy", "verified",
    ].sort().join(",")
    && input.gateExecution.sandbox.backend === "unsupported"
    && input.gateExecution.sandbox.verified === false
    && input.gateExecution.sandbox.networkPolicy === "unverified"
    && input.gateExecution.sandbox.filesystemPolicy === "unverified"
    && input.gateExecution.sandbox.environmentPolicy === "unverified";
  if (!sandboxVerified && !sandboxUnsupported) throw new Error("patch sandbox attestation is invalid");
  if (sandboxUnsupported && gateResults.length !== 0) {
    throw new Error("unsupported sandbox cannot report executed gates");
  }
  const allPassed = sandboxVerified
    && gateResults.length === spec.requiredGateIds.length
    && gateResults.every((item) => item.passed && item.exitCode === 0);
  const decision = !sandboxVerified
    ? "rejected_unsupported_sandbox" as const
    : !allPassed
      ? "rejected_gate" as const
      : spec.evidenceMode === "full_tool_recompute"
        ? "pending_full_recompute" as const
        : "eligible_for_private_evaluation" as const;
  const content = {
    schemaVersion: "pi-patch-trial-receipt.v2" as const,
    experimentSpecHash: spec.canonicalHash,
    sourceCommit: spec.sourceCommit,
    patchDiffHash: diff.canonicalHash,
    patchContentSha256: input.patchContentSha256,
    sandbox: input.gateExecution.sandbox,
    gateResults,
    evidenceAcquisitionReceiptHash: null,
    privateEvaluationReceiptHash: null,
    decision,
  };
  return { ...content, canonicalHash: hashCanonical(content) };
}

export function assertPatchTrialReceipt(
  value: unknown,
  spec: PatchExperimentSpec,
  diff: PatchDiffSummary,
): PatchTrialReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("patch trial receipt must be an object");
  const typed = value as PatchTrialReceipt;
  const expected = buildPatchTrialReceipt({
    spec,
    diff,
    patchContentSha256: typed.patchContentSha256,
    gateExecution: { sandbox: typed.sandbox, gateResults: typed.gateResults },
  });
  if (typed.canonicalHash !== expected.canonicalHash || JSON.stringify(typed) !== JSON.stringify(expected)) {
    throw new Error("patch trial receipt is invalid or non-canonical");
  }
  return typed;
}

const PATCHER_SYSTEM_PROMPT = `You are a bounded source-code Developer in a protein-function prediction RSI harness.

You receive one leak-safe experiment specification derived from aggregate Teacher enums. You cannot access benchmark proteins, case identifiers, GO labels, accessions, private evaluator artifacts, files outside the allowlist, a shell, the network, skills, extensions, or arbitrary tools.

Use read_patch_source and replace_patch_source only on allowlisted files. Make the smallest scientifically defensible implementation for the registered experiment. Never weaken anonymity, query-like quarantine, validation, evaluator separation, or error handling. Do not add hard-coded GO IDs, proteins, cases, gold labels, URLs, credentials, or benchmark-specific conditions. Finish by calling submit_patch_trial.`;

function providerError(session: { agent: { state: { messages: Array<{ role: string; stopReason?: string; errorMessage?: string }> } } }): string | undefined {
  const last = [...session.agent.state.messages].reverse().find((message) => message.role === "assistant");
  return last?.stopReason === "error" ? last.errorMessage ?? "unknown provider error" : undefined;
}

export async function runPiPatchDeveloper(input: {
  worktree: string;
  spec: PatchExperimentSpec;
}): Promise<{ submittedFiles: string[]; editOperations: number }> {
  const spec = assertPatchExperimentSpec(input.spec);
  let editOperations = 0;
  let submittedFiles: string[] | undefined;
  const readTool = defineTool({
    name: "read_patch_source",
    label: "Read allowlisted source",
    description: "Read one source file explicitly listed in the patch experiment specification.",
    parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
    async execute(_id, params) {
      const text = await readAllowedPatchSource(input.worktree, spec, params.path);
      return { content: [{ type: "text" as const, text }], details: { path: params.path } };
    },
  });
  const replaceTool = defineTool({
    name: "replace_patch_source",
    label: "Edit allowlisted source",
    description: "Replace one uniquely matching source substring in an allowlisted file.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 200 }),
      oldText: Type.String({ minLength: 1, maxLength: 30_000 }),
      newText: Type.String({ maxLength: 60_000 }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      if (editOperations >= spec.maximumEditOperations) throw new Error("patch edit-operation budget exhausted");
      await replaceAllowedPatchSource({ worktree: input.worktree, spec, ...params });
      editOperations += 1;
      return { content: [{ type: "text" as const, text: `Applied bounded replacement to ${params.path}.` }], details: { path: params.path } };
    },
  });
  const submitTool = defineTool({
    name: "submit_patch_trial",
    label: "Submit patch trial",
    description: "Finish the bounded patch turn and report only the allowlisted files intentionally changed.",
    parameters: Type.Object({
      changedFiles: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 12 }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const unique = [...new Set(params.changedFiles.map(canonicalFilePath))].sort();
      if (unique.some((path) => !spec.allowedFiles.includes(path))) throw new Error("submitted patch file is outside the allowlist");
      submittedFiles = unique;
      return { content: [{ type: "text" as const, text: "Patch trial captured for host-side verification." }], details: { changedFiles: unique }, terminate: true };
    },
  });

  const loader = new DefaultResourceLoader({
    cwd: input.worktree,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => PATCHER_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: input.worktree,
    resourceLoader: loader,
    tools: ["read_patch_source", "replace_patch_source", "submit_patch_trial"],
    customTools: [readTool, replaceTool, submitTool],
    thinkingLevel: "high",
    sessionManager: SessionManager.inMemory(input.worktree),
  });
  try {
    await session.prompt(`Implement this canonical experiment and submit the changed file list:\n\n${JSON.stringify(spec)}`);
    const firstError = providerError(session);
    if (firstError) throw new Error(`Pi patch Developer provider request failed: ${firstError}`);
    if (!submittedFiles) await session.prompt("Call submit_patch_trial now with only the allowlisted files you actually changed.");
    const secondError = providerError(session);
    if (secondError) throw new Error(`Pi patch Developer provider request failed: ${secondError}`);
    if (!submittedFiles) throw new Error("Pi patch Developer did not submit a patch trial");
    return { submittedFiles, editOperations };
  } finally {
    session.dispose();
  }
}
