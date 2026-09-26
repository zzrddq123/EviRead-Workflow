import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";

const exec = promisify(execFile);

export const CANDIDATE_ALLOWED_PREFIXES = ["src", "python", "scripts", "config", "genomes", "docs", "schemas"] as const;
export const CANDIDATE_PROTECTED_PREFIXES = [
  "src/outer", "src/experiment", "src/rsi_cli.ts", "test/rsi", "rsi", "versions", "runs", "campaigns", "benchmarks", "benchmark_runs", ".git", "AGENTS.md", "pi-agent",
  "package.json", "package-lock.json", "tsconfig.json", "CODEBASE_COMPOSITION.md", "CODEBASE_COMPOSITION.json",
  "schemas/rsi_experiment_defs.schema.json", "schemas/rsi_experiment_manifest.schema.json", "schemas/rsi_iteration_precommit.schema.json", "schemas/rsi_evaluation_receipt.schema.json", "schemas/rsi_resource_usage_receipt.schema.json", "schemas/rsi_campaign_freeze_manifest.schema.json", "schemas/rsi_sealed_replay_manifest.schema.json", "schemas/rsi_developer_feedback_view.schema.json", "schemas/rsi_private_evaluation.schema.json",
  "schemas/rsi_capability_manifest.schema.json", "schemas/rsi_tool_acquisition_receipt.schema.json", "schemas/rsi_candidate_capability_usage.schema.json", "schemas/rsi_versioned_baseline.schema.json", "docs/ICLR_RESOURCE_POLICY.md",
] as const;

function inside(path: string, prefix: string): boolean { const normalized = prefix.replace(/\/$/, ""); return path === normalized || path.startsWith(`${normalized}/`); }

export function assertCandidatePaths(paths: readonly string[]): string[] {
  if (paths.length < 1) throw new Error("candidate produced no changed paths");
  const normalized = [...new Set(paths.map((path) => path.replaceAll("\\", "/")))].sort();
  for (const path of normalized) {
    if (!path || isAbsolute(path) || path.split("/").includes("..")) throw new Error(`unsafe candidate path: ${path}`);
    if (CANDIDATE_PROTECTED_PREFIXES.some((prefix) => inside(path, prefix)) || /(?:^|\/)test[^/]*\.(?:ts|js|py)$/.test(path) || /\.(?:test|spec)\.(?:ts|js|py)$/.test(path) || /(?:^|\/)__tests__(?:\/|$)/.test(path)) throw new Error(`candidate changed protected experiment/controller/test path: ${path}`);
    if (!CANDIDATE_ALLOWED_PREFIXES.some((prefix) => inside(path, prefix))) throw new Error(`candidate changed path outside prediction allowlist: ${path}`);
  }
  return normalized;
}

export async function verifyCandidateDiff(repository: string, baseCommit: string, candidateCommit: string): Promise<{ valid: true; changedPaths: string[] }> {
  const run = async (args: string[]): Promise<string> => (await exec("/usr/bin/git", args, { cwd: repository, env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C.UTF-8" }, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  await run(["cat-file", "-e", `${baseCommit}^{commit}`]); await run(["cat-file", "-e", `${candidateCommit}^{commit}`]);
  const ancestor = await run(["merge-base", "--is-ancestor", baseCommit, candidateCommit]).then(() => true, () => false); if (!ancestor) throw new Error("candidate commit does not descend from its bound base");
  const paths = (await run(["diff", "--name-only", baseCommit, candidateCommit, "--"])).split("\n").filter(Boolean);
  await run(["diff", "--check", baseCommit, candidateCommit, "--"]);
  return { valid: true, changedPaths: assertCandidatePaths(paths) };
}
