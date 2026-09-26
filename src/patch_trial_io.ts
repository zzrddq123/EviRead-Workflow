import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { hashCanonical, sha256Text } from "./hash.js";
import {
  assertPatchExperimentSpec,
  assertPatchTrialReceipt,
  inspectPatchDiff,
  validatePatchDiff,
  type PatchDiffSummary,
  type PatchExperimentSpec,
  type PatchTrialReceipt,
} from "./patch_harness.js";

const execFileAsync = promisify(execFile);

export interface PatchContentManifest {
  schemaVersion: "pi-patch-content-manifest.v1";
  experimentSpecHash: string;
  sourceCommit: string;
  diffSummaryHash: string;
  unifiedDiffSha256: string;
  files: string[];
  canonicalHash: string;
}

export interface PendingPatchTrialBundle {
  trialDir: string;
  spec: PatchExperimentSpec;
  diff: PatchDiffSummary;
  diffManifest: PatchContentManifest;
  receipt: PatchTrialReceipt;
}

export interface EvidencePatchBinding {
  pendingPatchTrialReceiptHash: string;
  experimentSpecHash: string;
  sourceCommit: string;
  patchDiffHash: string;
  patchContentSha256: string;
}

async function readBoundedRegularFile(path: string, label: string, maximumBytes: number): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes) {
    throw new Error(`${label} must be a bounded regular non-symlink file`);
  }
  return await readFile(path, "utf8");
}

async function readJson(path: string, label: string, maximumBytes: number): Promise<unknown> {
  const text = await readBoundedRegularFile(path, label, maximumBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${String(error)}`);
  }
}

function assertContentManifest(
  value: unknown,
  spec: PatchExperimentSpec,
  diff: PatchDiffSummary,
  unifiedDiff: string,
): PatchContentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("patch content manifest must be an object");
  const typed = value as PatchContentManifest;
  const content = {
    schemaVersion: "pi-patch-content-manifest.v1" as const,
    experimentSpecHash: spec.canonicalHash,
    sourceCommit: spec.sourceCommit,
    diffSummaryHash: diff.canonicalHash,
    unifiedDiffSha256: sha256Text(unifiedDiff),
    files: diff.files.map((item) => item.path),
  };
  const expected = { ...content, canonicalHash: hashCanonical(content) };
  if (JSON.stringify(typed) !== JSON.stringify(expected)) {
    throw new Error("patch content manifest is invalid or non-canonical");
  }
  return typed;
}

export async function loadPendingPatchTrialBundle(trialDirInput: string): Promise<PendingPatchTrialBundle> {
  const trialDir = resolve(trialDirInput);
  const stat = await lstat(trialDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("patch trial directory must be a canonical regular non-symlink directory");
  }
  const spec = assertPatchExperimentSpec(await readJson(
    resolve(trialDir, "patch_experiment_spec.json"), "patch experiment spec", 128 * 1024,
  ));
  const rawDiff = await readJson(resolve(trialDir, "patch_diff_summary.json"), "patch diff summary", 128 * 1024);
  if (!rawDiff || typeof rawDiff !== "object" || Array.isArray(rawDiff)) throw new Error("patch diff summary must be an object");
  const typedDiff = rawDiff as PatchDiffSummary;
  const diff = validatePatchDiff(spec, typedDiff.files);
  if (JSON.stringify(typedDiff) !== JSON.stringify(diff)) throw new Error("patch diff summary is invalid or non-canonical");
  const unifiedDiff = await readBoundedRegularFile(resolve(trialDir, "patch.diff"), "patch unified diff", 4 * 1024 * 1024);
  const diffManifest = assertContentManifest(
    await readJson(resolve(trialDir, "patch_diff_manifest.json"), "patch content manifest", 128 * 1024),
    spec,
    diff,
    unifiedDiff,
  );
  const receipt = assertPatchTrialReceipt(
    await readJson(resolve(trialDir, "patch_trial_receipt.json"), "patch trial receipt", 256 * 1024),
    spec,
    diff,
  );
  if (receipt.patchContentSha256 !== diffManifest.unifiedDiffSha256) {
    throw new Error("patch receipt is not bound to the exact unified diff content");
  }
  if (spec.evidenceMode !== "full_tool_recompute" || receipt.decision !== "pending_full_recompute") {
    throw new Error("patch trial is not a pending full-tool recompute");
  }
  return { trialDir, spec, diff, diffManifest, receipt };
}

export function evidencePatchBinding(bundle: PendingPatchTrialBundle): EvidencePatchBinding {
  return {
    pendingPatchTrialReceiptHash: bundle.receipt.canonicalHash,
    experimentSpecHash: bundle.spec.canonicalHash,
    sourceCommit: bundle.spec.sourceCommit,
    patchDiffHash: bundle.diff.canonicalHash,
    patchContentSha256: bundle.diffManifest.unifiedDiffSha256,
  };
}

function canonicalStatusPath(value: string): string {
  const path = value.replaceAll("\\", "/");
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path)) {
    throw new Error("Git returned a non-canonical patch path");
  }
  return path;
}

async function gitText(worktree: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: worktree,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

/** Prove that the command is executing from the exact base+working-tree patch that passed gates. */
export async function assertWorktreeMatchesPendingPatch(
  worktreeInput: string,
  bundle: PendingPatchTrialBundle,
): Promise<void> {
  const worktree = await realpath(resolve(worktreeInput));
  const topLevel = (await gitText(worktree, ["rev-parse", "--show-toplevel"])).trim();
  if (await realpath(topLevel) !== worktree) throw new Error("full recompute is not running at the patch worktree root");
  const head = (await gitText(worktree, ["rev-parse", "--verify", "HEAD"])).trim();
  if (head !== bundle.spec.sourceCommit) throw new Error("full recompute source commit does not match the pending patch");
  const status = await gitText(worktree, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  const changed: string[] = [];
  for (const entry of status.split("\0").filter(Boolean)) {
    if (entry.slice(0, 2) !== " M" || entry[2] !== " ") {
      throw new Error("full recompute patch worktree contains a non-patch or untracked change");
    }
    changed.push(canonicalStatusPath(entry.slice(3)));
  }
  changed.sort();
  if (JSON.stringify(changed) !== JSON.stringify(bundle.diff.files.map((item) => item.path))) {
    throw new Error("full recompute worktree file set does not match the pending patch");
  }
  const diff = await inspectPatchDiff(worktree, bundle.spec);
  if (diff.canonicalHash !== bundle.diff.canonicalHash) {
    throw new Error("full recompute worktree diff summary does not match the pending patch");
  }
  const unifiedDiff = await gitText(worktree, [
    "-c", "diff.algorithm=myers", "-c", "core.quotePath=true",
    "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--full-index",
    "--src-prefix=a/", "--dst-prefix=b/", "--", ...bundle.spec.allowedFiles,
  ]);
  if (sha256Text(unifiedDiff) !== bundle.diffManifest.unifiedDiffSha256) {
    throw new Error("full recompute worktree content does not match the gated pending patch");
  }
}
