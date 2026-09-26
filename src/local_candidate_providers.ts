import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { hashCanonical, sha256Text } from "./hash.js";
import {
  mergeRemoteCandidateBundles,
  parseInterProScanTsv,
  type SnakeCaseCandidateSourceBundle,
  type SnakeCaseProviderRecord,
} from "./remote_candidate_providers.js";

const execFileAsync = promisify(execFile);

type LocalMode = "disabled" | "local";
type JsonObject = Record<string, unknown>;

function emptyBundle(): SnakeCaseCandidateSourceBundle {
  return { candidate_sources: { providers: [], go_candidates: [] } };
}

export interface LocalCandidateDependencies {
  run?: (executable: string, args: string[]) => Promise<void>;
}

function unavailable(provider: "InterProScan" | "OMA", path: string, reason: string): SnakeCaseCandidateSourceBundle {
  return { candidate_sources: { providers: [{
    provider,
    status: "unavailable",
    endpoint_or_path: path,
    release: null,
    request_sha256: null,
    payload_sha256: null,
    cache_hit: false,
    reason,
  }], go_candidates: [] } };
}

function failed(provider: "InterProScan" | "OMA", path: string, error: unknown): SnakeCaseCandidateSourceBundle {
  const diagnostic = error instanceof Error ? error.message : String(error);
  return { candidate_sources: { providers: [{
    provider,
    status: "failed",
    endpoint_or_path: path,
    release: null,
    request_sha256: null,
    payload_sha256: null,
    cache_hit: false,
    reason: `Local ${provider} execution failed; command, workstation-path, and identity details were redacted from public evidence (diagnostic_sha256=${sha256Text(diagnostic)}).`,
  }], go_candidates: [] } };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required for the local frozen provider`);
  return resolve(value);
}

async function defaultRun(executable: string, args: string[]): Promise<void> {
  await execFileAsync(executable, args, { maxBuffer: 16 * 1024 * 1024 });
}

function parseBundle(value: unknown, provider: "OMA"): SnakeCaseCandidateSourceBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${provider} local runner returned no object`);
  const source = (value as JsonObject).candidate_sources;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error(`${provider} local runner returned no candidate_sources`);
  const providers = (source as JsonObject).providers;
  const candidates = (source as JsonObject).go_candidates;
  if (!Array.isArray(providers) || providers.length !== 1 || !Array.isArray(candidates)) {
    throw new Error(`${provider} local runner returned a malformed bundle`);
  }
  if ((providers[0] as JsonObject)?.provider !== provider) throw new Error(`${provider} local runner provider mismatch`);
  return value as SnakeCaseCandidateSourceBundle;
}

export async function runOmaLocal(input: {
  sequence: string;
  targetLineage: readonly string[];
  excludedAccessions?: readonly string[];
  mode: LocalMode;
  env: NodeJS.ProcessEnv;
  dependencies?: LocalCandidateDependencies;
}): Promise<SnakeCaseCandidateSourceBundle> {
  if (input.mode !== "local") return emptyBundle();
  let directory = "";
  try {
    const python = required(input.env, "OMA_LOCAL_PYTHON");
    const runner = required(input.env, "OMA_LOCAL_RUNNER");
    const database = required(input.env, "OMA_LOCAL_DATABASE");
    const store = required(input.env, "OMA_LOCAL_STORE");
    const manifest = required(input.env, "OMA_LOCAL_MANIFEST");
    const ontology = required(input.env, "GO_ONTOLOGY_OBO");
    const omamer = required(input.env, "OMA_LOCAL_BIN");
    directory = await mkdtemp(join(tmpdir(), "pi-oma-local-"));
    const query = join(directory, "query.fasta");
    const output = join(directory, "candidates.json");
    await writeFile(query, `>anonymous_query\n${input.sequence}\n`, { encoding: "utf8", mode: 0o600 });
    const args = [
      runner,
      "--omamer-bin", omamer,
      "--omamer-db", database,
      "--store", store,
      "--manifest", manifest,
      "--ontology", ontology,
      "--query", query,
      "--output", output,
      "--maximum", input.env.OMA_LOCAL_MAX_CANDIDATES?.trim() || "120",
      "--threads", input.env.OMA_LOCAL_THREADS?.trim() || "2",
    ];
    for (const accession of [...new Set(input.excludedAccessions ?? [])].sort()) {
      args.push("--exclude-accession", accession);
    }
    await (input.dependencies?.run ?? defaultRun)(python, args);
    return parseBundle(JSON.parse(await readFile(output, "utf8")), "OMA");
  } catch (error) {
    return failed("OMA", "local:OMAmer:hash-bound", error);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

function assertInterProManifest(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("InterProScan local manifest is not an object");
  const manifest = value as JsonObject;
  const { canonicalHash, ...content } = manifest;
  if (manifest.schemaVersion !== "pi-temporal-interproscan-manifest.v1"
    || manifest.release !== "5.75-106.0"
    || manifest.status !== "ready"
    || canonicalHash !== hashCanonical(content)) {
    throw new Error("InterProScan local manifest is not a ready, canonical 5.75-106.0 binding");
  }
  return manifest;
}

export async function runInterProScanLocal(input: {
  sequence: string;
  mode: LocalMode;
  env: NodeJS.ProcessEnv;
  dependencies?: LocalCandidateDependencies;
}): Promise<SnakeCaseCandidateSourceBundle> {
  if (input.mode !== "local") return emptyBundle();
  let directory = "";
  try {
    const executable = required(input.env, "INTERPROSCAN_LOCAL_BIN");
    const manifestPath = required(input.env, "INTERPROSCAN_LOCAL_MANIFEST");
    const manifest = assertInterProManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    directory = await mkdtemp(join(tmpdir(), "pi-interpro-local-"));
    const query = join(directory, "query.fasta");
    const output = join(directory, "interpro.tsv");
    await writeFile(query, `>anonymous_query\n${input.sequence}\n`, { encoding: "utf8", mode: 0o600 });
    const applications = input.env.INTERPROSCAN_APPLICATIONS?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
    const args = ["-i", query, "-o", output, "-f", "TSV", "-goterms", "-iprlookup", "-dp"];
    if (applications.length > 0) args.push("-appl", applications.join(","));
    await (input.dependencies?.run ?? defaultRun)(executable, args);
    const payload = await readFile(output, "utf8");
    const payloadSha256 = sha256Text(payload);
    return { candidate_sources: {
      providers: [{
        provider: "InterProScan",
        status: "completed",
        endpoint_or_path: "local:InterProScan:5.75-106.0:hash-bound",
        release: String(manifest.release),
        request_sha256: sha256Text(input.sequence),
        payload_sha256: payloadSha256,
        cache_hit: false,
        reason: null,
      }],
      go_candidates: parseInterProScanTsv(payload, {
        queryLength: input.sequence.length,
        release: String(manifest.release),
        payloadSha256,
        externalMappings: [],
      }),
    } };
  } catch (error) {
    return failed("InterProScan", "local:InterProScan:5.75-106.0:hash-bound", error);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export async function collectLocalCandidateSources(input: {
  sequence: string;
  targetLineage: readonly string[];
  excludedAccessions: readonly string[];
  interproMode: LocalMode;
  omaMode: LocalMode;
  env: NodeJS.ProcessEnv;
  dependencies?: LocalCandidateDependencies;
}): Promise<SnakeCaseCandidateSourceBundle> {
  const bundles = await Promise.all([
    runInterProScanLocal({ sequence: input.sequence, mode: input.interproMode, env: input.env, dependencies: input.dependencies }),
    runOmaLocal({
      sequence: input.sequence,
      targetLineage: input.targetLineage,
      excludedAccessions: input.excludedAccessions,
      mode: input.omaMode,
      env: input.env,
      dependencies: input.dependencies,
    }),
  ]);
  return mergeRemoteCandidateBundles(bundles);
}
