import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PROJECT_ROOT, loadPredictionRuntimeEnv } from "./config.js";
import { sha256Text } from "./hash.js";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RemoteEvidenceResponse {
  ok: boolean;
  serviceVersion?: string;
  jobId?: string;
  evidenceBundle?: Record<string, unknown>;
  evidenceManifest?: Record<string, unknown>;
  evidenceSummary?: string;
  error?: string;
}

export async function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = PROJECT_ROOT): Promise<ProcessResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

function authorizationHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.EVIDENCE_API_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function normalizedTextHash(value: string): string {
  return sha256Text(`${value.replace(/\r\n?/g, "\n").trimEnd()}\n`);
}

export function validateEvidenceResponse(input: {
  bundle: Record<string, unknown>;
  manifest: Record<string, unknown>;
  proteinId: string;
  queryTaxonId?: number;
  sequenceText: string;
  structureText?: string;
}): void {
  if (input.manifest.status !== "completed") throw new Error("Evidence manifest is not completed");
  if (input.bundle.schema_version !== "pi-function-evidence.v3") throw new Error(`Unsupported evidence schema: ${String(input.bundle.schema_version)}`);
  const protein = input.bundle.protein;
  if (!protein || typeof protein !== "object" || Array.isArray(protein)) throw new Error("Evidence bundle has no protein metadata object");
  const metadata = protein as Record<string, unknown>;
  if (String(metadata.protein_id) !== input.proteinId) throw new Error("Evidence bundle protein_id does not match the requested target");
  if (String(metadata.sequence_input_sha256) !== normalizedTextHash(input.sequenceText)) throw new Error("Evidence bundle FASTA hash does not match the submitted input");
  if (input.structureText === undefined) {
    if (metadata.structure_input_sha256 !== null || metadata.structure_available !== false) throw new Error("Sequence-only evidence unexpectedly declares a structure");
  } else if (String(metadata.structure_input_sha256) !== normalizedTextHash(input.structureText)) {
    throw new Error("Evidence bundle PDB hash does not match the submitted input");
  }
  const returnedTaxonId = metadata.query_taxon_id === null || metadata.query_taxon_id === undefined
    ? null
    : Number(metadata.query_taxon_id);
  const requestedTaxonId = input.queryTaxonId ?? null;
  if (returnedTaxonId !== requestedTaxonId) {
    throw new Error(requestedTaxonId === null
      ? "Evidence bundle inferred a query taxon although none was declared"
      : "Evidence bundle query taxon does not match the requested taxon");
  }
  const returnedTaxonSource = String(metadata.query_taxon_id_source ?? "unavailable");
  if (requestedTaxonId === null && returnedTaxonSource !== "unavailable") {
    throw new Error("Evidence bundle query taxon provenance must remain unavailable when no TaxID was declared");
  }
  if (requestedTaxonId !== null && returnedTaxonSource !== "cli") {
    throw new Error("Evidence bundle did not preserve caller-provided query taxon provenance");
  }
  if (!Array.isArray(input.bundle.evidence_ids) || input.bundle.evidence_ids.length === 0) throw new Error("Evidence bundle contains no evidence IDs");
}

async function runLocalEvidencePipeline(input: {
  configPath: string;
  sequencePath: string;
  structurePath?: string;
  proteinId: string;
  queryTaxonId?: number;
  excludedAccessions: string[];
  runDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown>> {
  const python = input.env.PYTHON_BIN;
  if (!python) throw new Error("PYTHON_BIN is missing from local runtime config");
  const commandArgs = [
    join(PROJECT_ROOT, "python", "evidence_pipeline.py"),
    "run",
    "--config", input.configPath,
    "--sequence", input.sequencePath,
    "--protein-id", input.proteinId,
    "--run-dir", input.runDir,
  ];
  if (input.structurePath) commandArgs.push("--structure", input.structurePath);
  if (input.queryTaxonId !== undefined) commandArgs.push("--query-taxon-id", String(input.queryTaxonId));
  for (const accession of input.excludedAccessions) commandArgs.push("--exclude-accession", accession);
  const result = await runProcess(
    python,
    commandArgs,
    input.env,
  );
  if (result.code !== 0) {
    throw new Error(`Evidence pipeline failed with exit code ${result.code}. See ${join(input.runDir, "evidence_manifest.json")}`);
  }
  const bundle = JSON.parse(await readFile(join(input.runDir, "evidence", "evidence_bundle.json"), "utf8")) as Record<string, unknown>;
  const manifest = JSON.parse(await readFile(join(input.runDir, "evidence_manifest.json"), "utf8")) as Record<string, unknown>;
  validateEvidenceResponse({
    bundle,
    manifest,
    proteinId: input.proteinId,
    queryTaxonId: input.queryTaxonId,
    sequenceText: await readFile(input.sequencePath, "utf8"),
    structureText: input.structurePath ? await readFile(input.structurePath, "utf8") : undefined,
  });
  return bundle;
}

async function runHttpEvidencePipeline(input: {
  sequencePath: string;
  structurePath?: string;
  proteinId: string;
  queryTaxonId?: number;
  excludedAccessions: string[];
  runDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown>> {
  const baseUrl = input.env.EVIDENCE_API_URL?.trim().replace(/\/$/, "");
  if (!baseUrl) throw new Error("EVIDENCE_API_URL is required when EVIDENCE_BACKEND=http");
  const timeoutMs = Number(input.env.EVIDENCE_API_TIMEOUT_MS || 3_900_000);
  const sequenceFasta = await readFile(input.sequencePath, "utf8");
  const structurePdb = input.structurePath ? await readFile(input.structurePath, "utf8") : undefined;
  const response = await fetch(`${baseUrl}/v1/evidence`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authorizationHeaders(input.env),
    },
    body: JSON.stringify({ proteinId: input.proteinId, queryTaxonId: input.queryTaxonId, excludedAccessions: input.excludedAccessions, sequenceFasta, structurePdb }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = (await response.json()) as RemoteEvidenceResponse;
  if (!response.ok || !payload.ok || !payload.evidenceBundle || !payload.evidenceManifest) {
    throw new Error(`Remote evidence API failed (${response.status}): ${payload.error ?? "invalid response"}`);
  }
  if (payload.serviceVersion !== "pi-evidence-api.v3") throw new Error(`Unsupported evidence service version: ${String(payload.serviceVersion)}`);
  validateEvidenceResponse({
    bundle: payload.evidenceBundle,
    manifest: payload.evidenceManifest,
    proteinId: input.proteinId,
    queryTaxonId: input.queryTaxonId,
    sequenceText: sequenceFasta,
    structureText: structurePdb,
  });

  const inputDir = join(input.runDir, "input");
  const evidenceDir = join(input.runDir, "evidence");
  await mkdir(inputDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  await copyFile(input.sequencePath, join(inputDir, "sequence.fasta"));
  if (input.structurePath) await copyFile(input.structurePath, join(inputDir, "structure.pdb"));
  await writeFile(join(evidenceDir, "evidence_bundle.json"), `${JSON.stringify(payload.evidenceBundle, null, 2)}\n`, "utf8");
  await writeFile(join(evidenceDir, "evidence_summary.md"), payload.evidenceSummary ?? "# Remote evidence\n", "utf8");
  await writeFile(join(input.runDir, "evidence_manifest.json"), `${JSON.stringify(payload.evidenceManifest, null, 2)}\n`, "utf8");
  await writeFile(
    join(input.runDir, "remote_evidence_job.json"),
    `${JSON.stringify({
      backend: "http",
      apiUrl: baseUrl,
      serviceVersion: payload.serviceVersion,
      jobId: payload.jobId,
      fetchedAt: new Date().toISOString(),
      note: "Raw bioinformatics outputs remain on the evidence service; production deployments should provide signed artifact URLs.",
    }, null, 2)}\n`,
    "utf8",
  );
  return payload.evidenceBundle;
}

export async function runEvidencePipeline(input: {
  configPath: string;
  sequencePath: string;
  structurePath?: string;
  proteinId: string;
  queryTaxonId?: number;
  excludedAccessions: string[];
  runDir: string;
}): Promise<Record<string, unknown>> {
  const env = loadPredictionRuntimeEnv(input.configPath);
  await mkdir(input.runDir, { recursive: true });
  const backend = (env.EVIDENCE_BACKEND || "local").trim().toLowerCase();
  if (backend === "http") return await runHttpEvidencePipeline({ ...input, env });
  if (backend !== "local") throw new Error(`Unsupported EVIDENCE_BACKEND: ${backend}`);
  return await runLocalEvidencePipeline({ ...input, env });
}

export async function doctorEvidenceBackend(configPath: string): Promise<number> {
  const env = loadPredictionRuntimeEnv(configPath);
  const backend = (env.EVIDENCE_BACKEND || "local").trim().toLowerCase();
  if (backend === "http") {
    const baseUrl = env.EVIDENCE_API_URL?.trim().replace(/\/$/, "");
    if (!baseUrl) {
      console.error(JSON.stringify({ ok: false, backend, error: "EVIDENCE_API_URL is missing" }, null, 2));
      return 1;
    }
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: authorizationHeaders(env),
        signal: AbortSignal.timeout(Number(env.EVIDENCE_API_HEALTH_TIMEOUT_MS || 15_000)),
      });
      const payload: unknown = await response.json();
      console.log(JSON.stringify({ backend, apiUrl: baseUrl, response: payload }, null, 2));
      return response.ok ? 0 : 1;
    } catch (error) {
      console.error(JSON.stringify({ ok: false, backend, apiUrl: baseUrl, error: error instanceof Error ? error.message : String(error) }, null, 2));
      return 1;
    }
  }
  if (backend !== "local") {
    console.error(JSON.stringify({ ok: false, error: `Unsupported EVIDENCE_BACKEND: ${backend}` }, null, 2));
    return 1;
  }
  const python = env.PYTHON_BIN || "python3";
  const result = await runProcess(
    python,
    [join(PROJECT_ROOT, "python", "evidence_pipeline.py"), "doctor", "--config", configPath],
    env,
  );
  return result.code;
}
