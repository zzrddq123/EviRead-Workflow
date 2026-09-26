import { lstat, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import { exists, readJson, withCanonicalHash } from "./benchmark_io.js";
import type { BatchManifest, PrivateBenchmarkExclusions, PublicBenchmarkManifest } from "./benchmark_io.js";
import { parseEnvFile, PROJECT_ROOT } from "./config.js";
import { loadGenome } from "./genome.js";
import { hashCanonical, sha256File } from "./hash.js";
import type { EvidencePatchBinding } from "./patch_trial_io.js";
import {
  LOCAL_DEVELOPER_EXECUTION_SCOPE,
  assertLocalEvidenceSnapshot,
  validateLocalBatchAgainstSnapshot,
  type LocalEvidenceSnapshot,
} from "./local_evidence_snapshot.js";

export const REMOTE_EVIDENCE_PROFILES = ["remote", "remote_broad"] as const;
export type RemoteEvidenceProfile = typeof REMOTE_EVIDENCE_PROFILES[number];
export type EvidenceAcquisitionProfile = RemoteEvidenceProfile | "sequence_structure";
export type EvidenceExecutionScope = "portable_remote" | typeof LOCAL_DEVELOPER_EXECUTION_SCOPE;
export type EvidenceSourceKind = "remote_exact_cache" | "local_content_snapshot";
export type EvidencePortability = "portable_remote_runtime" | "nonportable_developer_override";

const PROFILE_CONTRACT: Readonly<Record<RemoteEvidenceProfile, {
  sequenceDatabases: readonly string[];
  structureDatabases: readonly string[];
  topK: number;
  annotationLimit: number;
}>> = {
  remote: {
    sequenceDatabases: ["swissprot"],
    structureDatabases: ["afdb-swissprot", "pdb100"],
    topK: 8,
    annotationLimit: 16,
  },
  remote_broad: {
    sequenceDatabases: ["swissprot", "nr_cluster_seq"],
    structureDatabases: ["afdb-swissprot", "afdb50", "pdb100"],
    topK: 12,
    annotationLimit: 32,
  },
};

const SAFE_CONFIG_KEYS = [
  "EVIDENCE_PROFILE",
  "SEQUENCE_SEARCH_BACKEND",
  "STRUCTURE_SEARCH_BACKEND",
  "NCBI_BLAST_URL",
  "NCBI_BLAST_DATABASES",
  "NCBI_BLAST_TOOL",
  "NCBI_BLAST_REQUEST_TIMEOUT_SECONDS",
  "NCBI_BLAST_JOB_TIMEOUT_SECONDS",
  "NCBI_BLAST_JOB_TIMEOUT_SECONDS_SWISSPROT",
  "NCBI_BLAST_JOB_TIMEOUT_SECONDS_REFSEQ_PROTEIN",
  "NCBI_BLAST_JOB_TIMEOUT_SECONDS_NR",
  "NCBI_BLAST_JOB_TIMEOUT_SECONDS_NR_CLUSTER_SEQ",
  "NCBI_BLAST_MAX_RESPONSE_BYTES",
  "NCBI_BLAST_REQUEST_INTERVAL_SECONDS",
  "NCBI_BLAST_POLL_INTERVAL_SECONDS",
  "NCBI_BLAST_MAX_ATTEMPTS",
  "NCBI_BLAST_REFRESH",
  "FOLDSEEK_REMOTE_URL",
  "FOLDSEEK_REMOTE_DATABASES",
  "FOLDSEEK_REMOTE_MODE",
  "FOLDSEEK_REMOTE_TIMEOUT_SECONDS",
  "FOLDSEEK_REMOTE_MAX_WAIT_SECONDS",
  "FOLDSEEK_REMOTE_POLL_SECONDS",
  "FOLDSEEK_REMOTE_MAX_ATTEMPTS",
  "FOLDSEEK_REMOTE_BACKOFF_BASE_SECONDS",
  "FOLDSEEK_REMOTE_BACKOFF_MAX_SECONDS",
  "FOLDSEEK_REMOTE_BACKOFF_JITTER_FRACTION",
  "FOLDSEEK_REMOTE_SUBMISSION_INTERVAL_SECONDS",
  "FOLDSEEK_REMOTE_REFRESH",
  "TOP_K",
  "ANNOTATION_LIMIT",
  "CANDIDATE_PROVIDER_MODE",
  "INTERPROSCAN_REST_URL",
  "INTERPROSCAN_APPLICATIONS",
  "OMA_REST_URL",
  "OMA_FASTMAP_MODE",
  "OMA_FASTMAP_REST_URL",
] as const;

export interface EvidenceAcquisitionPlan {
  schemaVersion: "pi-evidence-acquisition-plan.v2";
  planId: string;
  executionClass: "full_tool_recompute";
  profile: EvidenceAcquisitionProfile;
  /** Absent on pre-v1.2 remote plans and interpreted as portable_remote. */
  executionScope?: EvidenceExecutionScope;
  /** Local-only, path-redacted full-content snapshot binding. */
  sourceKind?: "local_content_snapshot";
  sourceManifestHash?: string;
  portability?: "nonportable_developer_override";
  acquisitionEpochId: string;
  publicSuiteId: string;
  publicManifestHash: string;
  privateExclusionsHash: string;
  publicTargetContextHash: string | null;
  genomeHash: string;
  narrativeMode: "deterministic";
  configLabel: string;
  configSha256: string;
  sanitizedConfig: Record<string, string>;
  ontologyBinding: { dataVersion: string; sha256: string };
  /** Null for an ordinary benchmark acquisition; exact pending trial binding for a Patcher recompute. */
  patchBinding: EvidencePatchBinding | null;
  responsePolicy: {
    cacheRequired: boolean;
    rawResponseHashesRequired: true;
    silentLocalFallbackAllowed: false;
    providerErrorsAreBiologicalAbstentions: false;
    localSnapshotRequired?: true;
  };
  claimBoundary: string;
  canonicalHash: string;
}

export interface RemoteCacheManifestFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface RemoteCacheManifest {
  schemaVersion: "pi-remote-cache-manifest.v1";
  acquisitionPlanHash: string;
  /** New full-recompute manifests are batch-exact; legacy fixtures omit this. */
  scope?: "batch_exact_remote_search_cache_v1";
  roots: Array<{
    label: string;
    present: boolean;
    files: RemoteCacheManifestFile[];
    totalBytes: number;
  }>;
  totalFiles: number;
  totalBytes: number;
  cases?: Array<{
    caseId: string;
    providers: RemoteCacheProviderBinding[];
  }>;
  canonicalHash: string;
}

export interface RemoteCacheProviderBinding {
  provider: "ncbi_blast" | "foldseek_remote";
  database: string;
  cacheRootLabel: "ncbi_remote_blast" | "foldseek_remote";
  cacheKey: string;
  cacheEntrySha256: string;
  cacheFiles: RemoteCacheManifestFile[];
  rawArtifact: RemoteCacheManifestFile;
  providerPayloadSha256: string;
  cacheHit: boolean;
}

export interface EvidenceAcquisitionReceipt {
  schemaVersion: "pi-evidence-acquisition-receipt.v2";
  acquisitionPlanHash: string;
  patchBinding: EvidencePatchBinding | null;
  batchManifestHash: string;
  cacheManifestHash: string;
  /** Present on local developer-snapshot receipts. cacheManifestHash is kept as a compatibility alias. */
  executionScope?: typeof LOCAL_DEVELOPER_EXECUTION_SCOPE;
  sourceKind?: "local_content_snapshot";
  sourceManifestHash?: string;
  portability?: "nonportable_developer_override";
  snapshotVerification?: { preRunHash: string; postRunHash: string };
  status: "completed" | "completed_with_failures";
  caseCount: number;
  completedCaseCount: number;
  cases: Array<{
    caseId: string;
    status: "completed" | "failed" | "skipped";
    validationOk: boolean;
    runManifestSha256: string | null;
    evidenceBundleSha256: string | null;
    blindEvidenceBundleSha256: string | null;
    goPredictionSha256: string | null;
    evidenceManifestSha256: string | null;
    remoteProviderCount: number;
    localProviderCount?: number;
  }>;
  startedAt: string;
  finishedAt: string;
  claimBoundary: string;
  canonicalHash: string;
}

function exactCsv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be an opaque identifier using only letters, digits, dot, underscore, or dash`);
  }
  return value;
}

function assertEvidencePatchBinding(value: unknown, label: string): asserts value is EvidencePatchBinding | null {
  if (value === null) return;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [
      "experimentSpecHash",
      "patchContentSha256",
      "patchDiffHash",
      "pendingPatchTrialReceiptHash",
      "sourceCommit",
    ].sort().join(",")) {
    throw new Error(`${label} patch binding is invalid`);
  }
  for (const [name, hash] of Object.entries(value)) {
    const pattern = name === "sourceCommit" ? /^[a-f0-9]{40,64}$/ : /^[a-f0-9]{64}$/;
    if (typeof hash !== "string" || !pattern.test(hash)) throw new Error(`${label} patch binding hash is invalid`);
  }
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function nonNegativeNumber(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a finite non-negative number`);
  return parsed;
}

function projectPath(value: string): string {
  return resolve(PROJECT_ROOT, value);
}

function assertProfileConfig(profile: RemoteEvidenceProfile, config: Record<string, string>): void {
  const expected = PROFILE_CONTRACT[profile];
  if (config.EVIDENCE_PROFILE !== profile) throw new Error("runtime config profile does not match the acquisition plan");
  if (config.SEQUENCE_SEARCH_BACKEND !== "ncbi" || config.STRUCTURE_SEARCH_BACKEND !== "foldseek_remote") {
    throw new Error("full-tool recompute requires explicit NCBI and Foldseek remote backends");
  }
  if (exactCsv(config.NCBI_BLAST_DATABASES).join(",") !== expected.sequenceDatabases.join(",")) {
    throw new Error(`runtime config has an unexpected ${profile} NCBI database contract`);
  }
  if (exactCsv(config.FOLDSEEK_REMOTE_DATABASES).join(",") !== expected.structureDatabases.join(",")) {
    throw new Error(`runtime config has an unexpected ${profile} Foldseek database contract`);
  }
  if (positiveInteger(config.TOP_K, "TOP_K") !== expected.topK
    || positiveInteger(config.ANNOTATION_LIMIT, "ANNOTATION_LIMIT") !== expected.annotationLimit) {
    throw new Error(`runtime config has an unexpected ${profile} search budget`);
  }
  if (!config.NCBI_BLAST_EMAIL?.trim()) throw new Error("NCBI contact email is required but is never copied into the public plan");
  if (!config.NCBI_BLAST_CACHE_DIR?.trim() || !config.FOLDSEEK_REMOTE_CACHE_DIR?.trim()) {
    throw new Error("remote cache directories are required for a replayable full-tool recompute");
  }
  positiveInteger(config.NCBI_BLAST_JOB_TIMEOUT_SECONDS, "NCBI_BLAST_JOB_TIMEOUT_SECONDS");
  for (const database of expected.sequenceDatabases) {
    const suffix = database.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
    const key = `NCBI_BLAST_JOB_TIMEOUT_SECONDS_${suffix}`;
    if (config[key] !== undefined) positiveInteger(config[key], key);
  }
  positiveInteger(config.FOLDSEEK_REMOTE_MAX_ATTEMPTS, "FOLDSEEK_REMOTE_MAX_ATTEMPTS");
  nonNegativeNumber(config.FOLDSEEK_REMOTE_BACKOFF_BASE_SECONDS, "FOLDSEEK_REMOTE_BACKOFF_BASE_SECONDS");
  nonNegativeNumber(config.FOLDSEEK_REMOTE_BACKOFF_MAX_SECONDS, "FOLDSEEK_REMOTE_BACKOFF_MAX_SECONDS");
  const jitter = nonNegativeNumber(config.FOLDSEEK_REMOTE_BACKOFF_JITTER_FRACTION, "FOLDSEEK_REMOTE_BACKOFF_JITTER_FRACTION");
  if (jitter > 1) throw new Error("FOLDSEEK_REMOTE_BACKOFF_JITTER_FRACTION must not exceed 1");
  nonNegativeNumber(config.FOLDSEEK_REMOTE_SUBMISSION_INTERVAL_SECONDS, "FOLDSEEK_REMOTE_SUBMISSION_INTERVAL_SECONDS");
  const pacerDir = config.FOLDSEEK_REMOTE_PACER_DIR?.trim();
  if (!pacerDir) throw new Error("FOLDSEEK_REMOTE_PACER_DIR is required for cross-process submission pacing");
  const allowedCacheRoot = resolve(PROJECT_ROOT, ".runtime", "cache");
  const relativePacer = relative(allowedCacheRoot, projectPath(pacerDir));
  if (!relativePacer || relativePacer.startsWith("..") || relativePacer.includes("../")) {
    throw new Error("FOLDSEEK_REMOTE_PACER_DIR must be a child of the repo-managed .runtime/cache directory");
  }
}

export async function buildEvidenceAcquisitionPlan(input: {
  planId: string;
  acquisitionEpochId: string;
  profile: EvidenceAcquisitionProfile;
  executionScope?: EvidenceExecutionScope;
  localSnapshot?: LocalEvidenceSnapshot;
  publicManifest: PublicBenchmarkManifest;
  privateExclusions: PrivateBenchmarkExclusions;
  publicTargetContextHash: string | null;
  genomePath: string;
  configPath: string;
  ontologyPath: string;
  patchBinding?: EvidencePatchBinding | null;
}): Promise<EvidenceAcquisitionPlan> {
  const profile = input.profile;
  const config = parseEnvFile(input.configPath);
  const localScope = input.executionScope === LOCAL_DEVELOPER_EXECUTION_SCOPE;
  if (localScope) {
    if (profile !== "sequence_structure" || !input.localSnapshot) {
      throw new Error("developer_local_snapshot requires profile sequence_structure and a pre-run snapshot");
    }
    const snapshot = assertLocalEvidenceSnapshot(input.localSnapshot);
    if (snapshot.configBinding.sha256 !== await sha256File(input.configPath)) {
      throw new Error("local snapshot is not bound to the acquisition config bytes");
    }
  } else {
    if (input.executionScope !== undefined && input.executionScope !== "portable_remote") {
      throw new Error("unsupported evidence execution scope");
    }
    if (!REMOTE_EVIDENCE_PROFILES.includes(profile as RemoteEvidenceProfile)) throw new Error("unsupported remote evidence profile");
    if (input.localSnapshot) throw new Error("portable remote acquisition cannot carry a local snapshot");
    assertProfileConfig(profile as RemoteEvidenceProfile, config);
  }
  if (input.privateExclusions.suiteId !== input.publicManifest.suiteId
    || input.privateExclusions.publicManifestHash !== input.publicManifest.canonicalHash) {
    throw new Error("private exclusions are not bound to the public benchmark suite");
  }
  const genome = await loadGenome(input.genomePath);
  const ontologySha256 = await sha256File(input.ontologyPath);
  if (config.GO_ONTOLOGY_OBO && await sha256File(projectPath(config.GO_ONTOLOGY_OBO)) !== ontologySha256) {
    throw new Error("runtime config ontology does not match the acquisition plan ontology");
  }
  const ontologyText = await import("node:fs/promises").then(({ readFile }) => readFile(input.ontologyPath, "utf8"));
  const dataVersion = ontologyText.match(/^data-version:\s*(.+)$/m)?.[1]?.trim();
  if (!dataVersion) throw new Error("GO ontology has no data-version binding");
  const sanitizedConfig = Object.fromEntries(
    (localScope
      ? (["EVIDENCE_PROFILE", "SEQUENCE_SEARCH_BACKEND", "STRUCTURE_SEARCH_BACKEND", "TOP_K", "ANNOTATION_LIMIT", "CANDIDATE_PROVIDER_MODE"] as const)
      : SAFE_CONFIG_KEYS
    ).filter((key) => config[key] !== undefined).map((key) => [key, config[key]]),
  );
  if (!localScope) {
    sanitizedConfig.FOLDSEEK_REMOTE_PACER_SCOPE = relative(
      resolve(PROJECT_ROOT, ".runtime", "cache"),
      projectPath(config.FOLDSEEK_REMOTE_PACER_DIR),
    ).split("\\").join("/");
  }
  const content = {
    schemaVersion: "pi-evidence-acquisition-plan.v2" as const,
    planId: safeId(input.planId, "planId"),
    executionClass: "full_tool_recompute" as const,
    profile,
    ...(localScope ? {
      executionScope: LOCAL_DEVELOPER_EXECUTION_SCOPE,
      sourceKind: "local_content_snapshot" as const,
      sourceManifestHash: input.localSnapshot!.canonicalHash,
      portability: "nonportable_developer_override" as const,
    } : {}),
    acquisitionEpochId: safeId(input.acquisitionEpochId, "acquisitionEpochId"),
    publicSuiteId: input.publicManifest.suiteId,
    publicManifestHash: input.publicManifest.canonicalHash,
    privateExclusionsHash: input.privateExclusions.canonicalHash,
    publicTargetContextHash: input.publicTargetContextHash,
    genomeHash: genome.genomeHash,
    narrativeMode: "deterministic" as const,
    configLabel: basename(input.configPath),
    configSha256: await sha256File(input.configPath),
    sanitizedConfig,
    ontologyBinding: { dataVersion, sha256: ontologySha256 },
    patchBinding: input.patchBinding ?? null,
    responsePolicy: {
      cacheRequired: !localScope,
      rawResponseHashesRequired: true as const,
      silentLocalFallbackAllowed: false as const,
      providerErrorsAreBiologicalAbstentions: false as const,
      ...(localScope ? { localSnapshotRequired: true as const } : {}),
    },
    claimBoundary: localScope
      ? "Evaluator-owned local developer snapshot acquisition. This nonportable override is comparable only when every system shares the exact full-content source snapshot and frozen evidence batch."
      : "Evaluator-owned full remote evidence acquisition. Public services are rolling; comparisons are valid only inside this hash-bound acquisition epoch or an exact cache replay.",
  };
  return withCanonicalHash(content) as EvidenceAcquisitionPlan;
}

export function assertEvidenceAcquisitionPlan(value: unknown): EvidenceAcquisitionPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("evidence acquisition plan must be an object");
  const typed = value as EvidenceAcquisitionPlan;
  const localScope = typed.executionScope === LOCAL_DEVELOPER_EXECUTION_SCOPE;
  const remoteScope = typed.executionScope === undefined || typed.executionScope === "portable_remote";
  if (typed.schemaVersion !== "pi-evidence-acquisition-plan.v2"
    || typed.executionClass !== "full_tool_recompute"
    || (!localScope && !remoteScope)
    || (localScope ? typed.profile !== "sequence_structure" : !REMOTE_EVIDENCE_PROFILES.includes(typed.profile as RemoteEvidenceProfile))
    || typed.narrativeMode !== "deterministic"
    || typed.responsePolicy?.cacheRequired !== !localScope
    || typed.responsePolicy?.rawResponseHashesRequired !== true
    || typed.responsePolicy?.silentLocalFallbackAllowed !== false
    || typed.responsePolicy?.providerErrorsAreBiologicalAbstentions !== false) {
    throw new Error("unsupported or unsafe evidence acquisition plan");
  }
  safeId(typed.planId, "planId");
  safeId(typed.acquisitionEpochId, "acquisitionEpochId");
  if (localScope) {
    if (typed.sourceKind !== "local_content_snapshot"
      || typed.portability !== "nonportable_developer_override"
      || typeof typed.sourceManifestHash !== "string"
      || !/^[a-f0-9]{64}$/.test(typed.sourceManifestHash)
      || typed.responsePolicy.localSnapshotRequired !== true) {
      throw new Error("local acquisition plan has no exact nonportable snapshot binding");
    }
  } else if (typed.sourceKind !== undefined || typed.sourceManifestHash !== undefined
    || typed.portability !== undefined || typed.responsePolicy.localSnapshotRequired !== undefined) {
    throw new Error("remote acquisition plan contains local-only source fields");
  }
  assertEvidencePatchBinding(typed.patchBinding, "evidence acquisition plan");
  const { canonicalHash, ...content } = typed;
  if (canonicalHash !== hashCanonical(content)) throw new Error("evidence acquisition plan hash mismatch");
  for (const forbidden of ["EMAIL", "TOKEN", "PASSWORD", "SECRET", "ACCESSION", "GOLD"]) {
    if (Object.keys(typed.sanitizedConfig).some((key) => key.toUpperCase().includes(forbidden))) {
      throw new Error("evidence acquisition plan contains a forbidden private config key");
    }
  }
  return typed;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 hash`);
  return value;
}

async function ordinaryFile(path: string, displayPath: string): Promise<{ body: Buffer; file: RemoteCacheManifestFile }> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new Error(`required acquisition artifact is missing: ${displayPath}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    throw new Error(`acquisition artifact must be a non-empty regular non-symlink file: ${displayPath}`);
  }
  const body = await readFile(path);
  return { body, file: { path: displayPath, sizeBytes: stat.size, sha256: await sha256File(path) } };
}

async function ordinaryJson(path: string, displayPath: string): Promise<{ value: Record<string, unknown>; file: RemoteCacheManifestFile }> {
  const loaded = await ordinaryFile(path, displayPath);
  try {
    return { value: object(JSON.parse(loaded.body.toString("utf8")), displayPath), file: loaded.file };
  } catch (error) {
    throw new Error(`acquisition JSON is unreadable: ${displayPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertManagedCacheRoot(configured: string, label: string): Promise<string> {
  const rootPath = projectPath(configured);
  const allowedRoot = resolve(PROJECT_ROOT, ".runtime", "cache");
  const relation = relative(allowedRoot, rootPath);
  if (!relation || relation.startsWith("..") || relation.includes("../")) {
    throw new Error(`${label} cache must be a distinct child of the repo-managed .runtime/cache directory`);
  }
  let stat;
  try {
    stat = await lstat(rootPath);
  } catch {
    throw new Error(`${label} cache root is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} cache root must be a non-symlink directory`);
  return rootPath;
}

function sameJson(left: unknown, right: unknown): boolean {
  return hashCanonical(left) === hashCanonical(right);
}

const FOLDSEEK_PROVENANCE_KEYS: Readonly<Record<string, string>> = {
  "afdb-swissprot": "swissprot_full_length",
  afdb50: "uniprot_afdb50_full_length",
  "afdb-proteome": "uniprot_afdb_proteome_full_length",
  pdb100: "pdb_full_length",
};

async function ncbiBinding(input: {
  caseId: string;
  runRoot: string;
  database: string;
  record: Record<string, unknown>;
  cacheRoot: string;
}): Promise<RemoteCacheProviderBinding> {
  if (input.record.status !== "completed" || input.record.backend !== "ncbi_common_url_api") {
    throw new Error(`${input.caseId}/${input.database} has no completed NCBI remote provenance`);
  }
  const request = object(input.record.request, `${input.caseId}/${input.database} NCBI request`);
  if (request.database !== input.database || request.program !== "blastp") {
    throw new Error(`${input.caseId}/${input.database} NCBI request identity is inconsistent`);
  }
  const cache = object(input.record.cache, `${input.caseId}/${input.database} NCBI cache`);
  const cacheKey = sha(cache.key, `${input.caseId}/${input.database} NCBI cache key`);
  const identityKeys = ["schema_version", "endpoint", "program", "database", "query_sha256", "query_length", "parameters"];
  const identity = Object.fromEntries(identityKeys.map((key) => [key, request[key]]));
  if (hashCanonical(identity) !== cacheKey) throw new Error(`${input.caseId}/${input.database} NCBI cache key is not request-bound`);

  const rawRelative = `raw/sequence/blast_${input.database}.remote.json`;
  const provenanceRelative = `raw/sequence/blast_${input.database}.remote.provenance.json`;
  const raw = await ordinaryFile(join(input.runRoot, rawRelative), rawRelative);
  const provenance = await ordinaryJson(join(input.runRoot, provenanceRelative), provenanceRelative);
  if (!sameJson(provenance.value, input.record)) throw new Error(`${input.caseId}/${input.database} NCBI provenance copies disagree`);
  const payloadHash = sha(input.record.raw_payload_sha256, `${input.caseId}/${input.database} NCBI raw payload`);
  if (raw.file.sha256 !== payloadHash || input.record.raw_payload_size !== raw.file.sizeBytes) {
    throw new Error(`${input.caseId}/${input.database} NCBI raw payload hash/size mismatch`);
  }

  const responseName = `${cacheKey}.json`;
  const metadataName = `${cacheKey}.meta.json`;
  const response = await ordinaryFile(join(input.cacheRoot, responseName), responseName);
  const metadata = await ordinaryJson(join(input.cacheRoot, metadataName), metadataName);
  if (response.file.sha256 !== raw.file.sha256 || response.file.sizeBytes !== raw.file.sizeBytes) {
    throw new Error(`${input.caseId}/${input.database} NCBI raw artifact differs from its exact cache response`);
  }
  const meta = metadata.value;
  if (meta.cache_key !== cacheKey || meta.response_sha256 !== response.file.sha256
    || meta.response_size !== response.file.sizeBytes
    || !sameJson(Object.fromEntries(identityKeys.map((key) => [key, meta[key]])), identity)) {
    throw new Error(`${input.caseId}/${input.database} NCBI cache metadata is not request/payload-bound`);
  }
  const cacheFiles = [response.file, metadata.file].sort((a, b) => a.path.localeCompare(b.path));
  return {
    provider: "ncbi_blast",
    database: input.database,
    cacheRootLabel: "ncbi_remote_blast",
    cacheKey,
    cacheEntrySha256: hashCanonical(cacheFiles),
    cacheFiles,
    rawArtifact: raw.file,
    providerPayloadSha256: payloadHash,
    cacheHit: typeof cache.hit === "boolean" ? cache.hit : (() => { throw new Error("NCBI cache hit provenance is missing"); })(),
  };
}

async function foldseekBindings(input: {
  caseId: string;
  runRoot: string;
  databases: readonly string[];
  searches: Record<string, unknown>;
  cacheRoot: string;
  config: Record<string, string>;
}): Promise<RemoteCacheProviderBinding[]> {
  const rawRelative = "raw/foldseek/remote/result.json";
  const raw = await ordinaryJson(join(input.runRoot, rawRelative), rawRelative);
  const apiBase = (input.config.FOLDSEEK_REMOTE_URL ?? "").replace(/\/$/, "");
  const mode = input.config.FOLDSEEK_REMOTE_MODE ?? "tmalign";
  let shared: { key: string; wrapper: Record<string, unknown>; file: RemoteCacheManifestFile } | undefined;
  const output: RemoteCacheProviderBinding[] = [];
  for (const database of input.databases) {
    const provenanceKey = FOLDSEEK_PROVENANCE_KEYS[database];
    if (!provenanceKey) throw new Error(`unsupported Foldseek acquisition database: ${database}`);
    const record = object(input.searches[provenanceKey], `${input.caseId}/${database} Foldseek provenance`);
    if (record.status !== "completed" || record.backend !== "foldseek_public_ticket_api"
      || record.database_id !== database || record.api_base !== apiBase || record.mode !== mode) {
      throw new Error(`${input.caseId}/${database} has no matching completed Foldseek remote provenance`);
    }
    const querySha256 = sha(record.query_sha256, `${input.caseId}/${database} Foldseek query`);
    const payloadSha256 = sha(record.result_payload_sha256, `${input.caseId}/${database} Foldseek result`);
    if (hashCanonical(raw.value) !== payloadSha256) {
      throw new Error(`${input.caseId}/${database} Foldseek raw result hash mismatch`);
    }
    const cacheKey = hashCanonical({
      schemaVersion: "pi-foldseek-remote.v1",
      querySha256,
      apiBase,
      databases: input.databases,
      mode,
    });
    if (!shared) {
      const name = `${cacheKey}.json`;
      const loaded = await ordinaryJson(join(input.cacheRoot, name), name);
      const wrapper = loaded.value;
      const { canonicalHash, ...wrapperContent } = wrapper;
      if (canonicalHash !== hashCanonical(wrapperContent)) throw new Error(`${input.caseId} Foldseek cache wrapper hash mismatch`);
      if (wrapper.schemaVersion !== "pi-foldseek-remote.v1" || wrapper.querySha256 !== querySha256
        || wrapper.apiBase !== apiBase || wrapper.mode !== mode || !sameJson(wrapper.databases, input.databases)
        || wrapper.resultSha256 !== payloadSha256 || !sameJson(wrapper.result, raw.value)) {
        throw new Error(`${input.caseId} Foldseek cache wrapper is not request/result-bound`);
      }
      shared = { key: cacheKey, wrapper, file: loaded.file };
    } else if (shared.key !== cacheKey) {
      throw new Error(`${input.caseId} Foldseek databases do not share one exact request cache key`);
    }
    const cacheHit = record.from_cache;
    if (typeof cacheHit !== "boolean") throw new Error(`${input.caseId}/${database} Foldseek cache provenance is missing`);
    output.push({
      provider: "foldseek_remote",
      database,
      cacheRootLabel: "foldseek_remote",
      cacheKey,
      cacheEntrySha256: shared.file.sha256,
      cacheFiles: [shared.file],
      rawArtifact: raw.file,
      providerPayloadSha256: payloadSha256,
      cacheHit,
    });
  }
  return output;
}

export async function buildRemoteCacheManifest(input: {
  plan: EvidenceAcquisitionPlan;
  batchDir: string;
  batchManifest: BatchManifest;
  configPath: string;
}): Promise<RemoteCacheManifest> {
  const plan = assertEvidenceAcquisitionPlan(input.plan);
  if (plan.executionScope === LOCAL_DEVELOPER_EXECUTION_SCOPE
    || !REMOTE_EVIDENCE_PROFILES.includes(plan.profile as RemoteEvidenceProfile)) {
    throw new Error("remote cache manifest cannot attest a local developer snapshot acquisition");
  }
  if (input.batchManifest.status !== "completed") throw new Error("an exact remote cache manifest requires a fully completed batch");
  if (input.batchManifest.evidenceAcquisitionPlanHash !== plan.canonicalHash
    || input.batchManifest.evidenceAcquisitionEpochId !== plan.acquisitionEpochId) {
    throw new Error("batch acquisition binding does not match the cache manifest plan");
  }
  const config = parseEnvFile(input.configPath);
  assertProfileConfig(plan.profile as RemoteEvidenceProfile, config);
  const ncbiRoot = await assertManagedCacheRoot(config.NCBI_BLAST_CACHE_DIR, "NCBI");
  const foldseekRoot = await assertManagedCacheRoot(config.FOLDSEEK_REMOTE_CACHE_DIR, "Foldseek");
  const expected = PROFILE_CONTRACT[plan.profile as RemoteEvidenceProfile];
  const cases: NonNullable<RemoteCacheManifest["cases"]> = [];
  for (const item of input.batchManifest.cases) {
    if (item.status !== "completed" || !item.validationOk) throw new Error(`cannot attest incomplete case ${item.caseId}`);
    const runRoot = resolve(input.batchDir, item.runDir);
    if (relative(resolve(input.batchDir), runRoot).startsWith("..")) throw new Error("batch run path escapes the batch directory");
    const runRootStat = await lstat(runRoot);
    if (runRootStat.isSymbolicLink() || !runRootStat.isDirectory()) throw new Error(`${item.caseId} run root must be a non-symlink directory`);
    const run = (await ordinaryJson(join(runRoot, "run_manifest.json"), "run_manifest.json")).value;
    const acquisition = object(run.evidenceAcquisition, `${item.caseId} run acquisition binding`);
    if (run.status !== "completed" || acquisition.planHash !== plan.canonicalHash || acquisition.epochId !== plan.acquisitionEpochId) {
      throw new Error(`${item.caseId} run was not acquisition-bound at creation`);
    }
    const evidence = (await ordinaryJson(join(runRoot, "evidence_manifest.json"), "evidence_manifest.json")).value;
    if (evidence.status !== "completed") throw new Error(`${item.caseId} evidence manifest is not completed`);
    const stages = object(evidence.stages, `${item.caseId} evidence stages`);
    const sequenceStage = object(stages.sequence_search, `${item.caseId} sequence search`);
    const sequenceSearches = object(sequenceStage.searches, `${item.caseId} sequence searches`);
    const providers: RemoteCacheProviderBinding[] = [];
    for (const database of expected.sequenceDatabases) {
      providers.push(await ncbiBinding({
        caseId: item.caseId,
        runRoot,
        database,
        record: object(sequenceSearches[database], `${item.caseId}/${database} NCBI provenance`),
        cacheRoot: ncbiRoot,
      }));
    }
    const inputs = object(run.inputs, `${item.caseId} run inputs`);
    if (inputs.structure !== null) {
      const structureStage = object(stages.structure_search, `${item.caseId} structure search`);
      if (structureStage.status !== "completed") throw new Error(`${item.caseId} structure search is not completed`);
      providers.push(...await foldseekBindings({
        caseId: item.caseId,
        runRoot,
        databases: expected.structureDatabases,
        searches: object(structureStage.searches, `${item.caseId} structure searches`),
        cacheRoot: foldseekRoot,
        config,
      }));
    }
    const bundle = (await ordinaryJson(join(runRoot, "evidence", "evidence_bundle.json"), "evidence/evidence_bundle.json")).value;
    const runtime = object(bundle.runtime, `${item.caseId} evidence runtime`);
    const backends = object(runtime.search_backends, `${item.caseId} evidence search backends`);
    if (backends.sequence !== "ncbi" || (inputs.structure !== null && backends.structure !== "foldseek_remote")
      || (inputs.structure === null && backends.structure !== null)) {
      throw new Error(`${item.caseId} evidence runtime used a local, missing, or silently substituted search backend`);
    }
    cases.push({ caseId: item.caseId, providers });
  }

  const rootFiles = (label: RemoteCacheProviderBinding["cacheRootLabel"]): RemoteCacheManifestFile[] => {
    const unique = new Map<string, RemoteCacheManifestFile>();
    for (const binding of cases.flatMap((item) => item.providers).filter((item) => item.cacheRootLabel === label)) {
      for (const file of binding.cacheFiles) {
        const prior = unique.get(file.path);
        if (prior && !sameJson(prior, file)) throw new Error(`cache file has conflicting bindings: ${file.path}`);
        unique.set(file.path, file);
      }
    }
    return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));
  };
  const roots = (["ncbi_remote_blast", "foldseek_remote"] as const).map((label) => {
    const files = rootFiles(label);
    return { label, present: true, files, totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0) };
  });
  const content = {
    schemaVersion: "pi-remote-cache-manifest.v1" as const,
    acquisitionPlanHash: plan.canonicalHash,
    scope: "batch_exact_remote_search_cache_v1" as const,
    roots,
    totalFiles: roots.reduce((sum, root) => sum + root.files.length, 0),
    totalBytes: roots.reduce((sum, root) => sum + root.totalBytes, 0),
    cases,
  };
  return withCanonicalHash(content) as RemoteCacheManifest;
}

export function assertRemoteCacheManifest(value: unknown): RemoteCacheManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("remote cache manifest must be an object");
  }
  const typed = value as RemoteCacheManifest;
  const { canonicalHash, ...content } = typed;
  if (typed.schemaVersion !== "pi-remote-cache-manifest.v1"
    || typeof typed.acquisitionPlanHash !== "string"
    || !Array.isArray(typed.roots)
    || !Number.isSafeInteger(typed.totalFiles)
    || typed.totalFiles < 0
    || !Number.isSafeInteger(typed.totalBytes)
    || typed.totalBytes < 0
    || canonicalHash !== hashCanonical(content)) {
    throw new Error("remote cache manifest is invalid or non-canonical");
  }
  const files = typed.roots.flatMap((root) => {
    if (!root || typeof root.label !== "string" || typeof root.present !== "boolean"
      || !Array.isArray(root.files) || !Number.isSafeInteger(root.totalBytes) || root.totalBytes < 0) {
      throw new Error("remote cache manifest root is invalid");
    }
    for (const file of root.files) {
      if (!file || typeof file.path !== "string" || file.path.includes("..")
        || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0
        || !/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new Error("remote cache manifest file binding is invalid");
      }
    }
    if (root.totalBytes !== root.files.reduce((sum, file) => sum + file.sizeBytes, 0)) {
      throw new Error("remote cache manifest root byte count is invalid");
    }
    return root.files;
  });
  if (typed.totalFiles !== files.length
    || typed.totalBytes !== files.reduce((sum, file) => sum + file.sizeBytes, 0)) {
    throw new Error("remote cache manifest totals are invalid");
  }
  if (typed.scope !== undefined) {
    if (typed.scope !== "batch_exact_remote_search_cache_v1" || !Array.isArray(typed.cases)) {
      throw new Error("remote cache manifest exact scope is invalid");
    }
    const rootFiles = new Map(typed.roots.flatMap((root) => root.files.map((file) => [`${root.label}/${file.path}`, file] as const)));
    if (new Set(typed.cases.map((item) => item.caseId)).size !== typed.cases.length) {
      throw new Error("remote cache manifest has duplicate case bindings");
    }
    for (const item of typed.cases) {
      if (!item || typeof item.caseId !== "string" || !Array.isArray(item.providers) || item.providers.length === 0) {
        throw new Error("remote cache manifest case binding is invalid");
      }
      const providerKeys = new Set<string>();
      for (const binding of item.providers) {
        const key = `${binding.provider}/${binding.database}`;
        if (providerKeys.has(key)) throw new Error("remote cache manifest has duplicate provider bindings");
        providerKeys.add(key);
        if (!binding || !["ncbi_blast", "foldseek_remote"].includes(binding.provider)
          || !["ncbi_remote_blast", "foldseek_remote"].includes(binding.cacheRootLabel)
          || typeof binding.database !== "string" || !/^[a-f0-9]{64}$/.test(binding.cacheKey)
          || !/^[a-f0-9]{64}$/.test(binding.cacheEntrySha256)
          || !/^[a-f0-9]{64}$/.test(binding.providerPayloadSha256)
          || typeof binding.cacheHit !== "boolean" || !Array.isArray(binding.cacheFiles)
          || binding.cacheFiles.length === 0) {
          throw new Error("remote cache manifest provider binding is invalid");
        }
        for (const file of binding.cacheFiles) {
          const rootFile = rootFiles.get(`${binding.cacheRootLabel}/${file.path}`);
          if (!rootFile || !sameJson(rootFile, file)) throw new Error("remote cache provider references an unbound cache file");
        }
      }
    }
  }
  return typed;
}

async function requiredHash(path: string, label: string): Promise<string> {
  return (await ordinaryFile(path, label)).file.sha256;
}

export async function buildEvidenceAcquisitionReceipt(input: {
  plan: EvidenceAcquisitionPlan;
  batchDir: string;
  batchManifest: BatchManifest;
  cacheManifest: RemoteCacheManifest;
}): Promise<EvidenceAcquisitionReceipt> {
  assertEvidenceAcquisitionPlan(input.plan);
  if (input.plan.executionScope === LOCAL_DEVELOPER_EXECUTION_SCOPE) {
    throw new Error("remote acquisition receipt cannot attest a local developer snapshot acquisition");
  }
  if (input.batchManifest.status !== "completed"
    || input.batchManifest.publicManifestHash !== input.plan.publicManifestHash
    || input.batchManifest.privateExclusionsHash !== input.plan.privateExclusionsHash
    || input.batchManifest.genomeHash !== input.plan.genomeHash
    || input.batchManifest.configSha256 !== input.plan.configSha256
    || (input.batchManifest.publicTargetContextHash ?? null) !== input.plan.publicTargetContextHash
    || input.batchManifest.narrativeMode !== "deterministic"
    || input.batchManifest.evidenceAcquisitionPlanHash !== input.plan.canonicalHash
    || input.batchManifest.evidenceAcquisitionEpochId !== input.plan.acquisitionEpochId) {
    throw new Error("prediction batch is not bound to the evidence acquisition plan");
  }
  const cacheManifest = assertRemoteCacheManifest(input.cacheManifest);
  if (cacheManifest.acquisitionPlanHash !== input.plan.canonicalHash
    || cacheManifest.scope !== "batch_exact_remote_search_cache_v1" || !cacheManifest.cases) {
    throw new Error("remote cache manifest is not bound to the evidence acquisition plan");
  }
  const cacheCases = new Map(cacheManifest.cases.map((item) => [item.caseId, item]));
  if (cacheCases.size !== input.batchManifest.cases.length) throw new Error("remote cache manifest is not cohort-exact");
  const cases = [];
  for (const item of input.batchManifest.cases) {
    const runRoot = resolve(input.batchDir, item.runDir);
    if (relative(resolve(input.batchDir), runRoot).startsWith("..")) throw new Error("batch run path escapes the batch directory");
    if (item.status !== "completed" || !item.validationOk) throw new Error(`completed receipt cannot include incomplete case ${item.caseId}`);
    const cacheCase = cacheCases.get(item.caseId);
    if (!cacheCase) throw new Error(`remote cache manifest omits ${item.caseId}`);
    const runLoaded = await ordinaryJson(join(runRoot, "run_manifest.json"), `${item.caseId}/run_manifest.json`);
    const runAcquisition = object(runLoaded.value.evidenceAcquisition, `${item.caseId} run acquisition binding`);
    if (runLoaded.value.status !== "completed" || runAcquisition.planHash !== input.plan.canonicalHash
      || runAcquisition.epochId !== input.plan.acquisitionEpochId) {
      throw new Error(`${item.caseId} run provenance is not bound to the acquisition plan`);
    }
    const evidenceLoaded = await ordinaryJson(join(runRoot, "evidence_manifest.json"), `${item.caseId}/evidence_manifest.json`);
    if (evidenceLoaded.value.status !== "completed") throw new Error(`${item.caseId} evidence provenance is not completed`);
    cases.push({
      caseId: item.caseId,
      status: item.status,
      validationOk: item.validationOk,
      runManifestSha256: runLoaded.file.sha256,
      evidenceManifestSha256: evidenceLoaded.file.sha256,
      evidenceBundleSha256: await requiredHash(join(runRoot, "evidence", "evidence_bundle.json"), `${item.caseId}/evidence/evidence_bundle.json`),
      blindEvidenceBundleSha256: await requiredHash(join(runRoot, "evidence", "blind_evidence_bundle.json"), `${item.caseId}/evidence/blind_evidence_bundle.json`),
      goPredictionSha256: await requiredHash(join(runRoot, "prediction", "go_predictions.json"), `${item.caseId}/prediction/go_predictions.json`),
      remoteProviderCount: cacheCase.providers.length,
    });
  }
  const content = {
    schemaVersion: "pi-evidence-acquisition-receipt.v2" as const,
    acquisitionPlanHash: input.plan.canonicalHash,
    patchBinding: input.plan.patchBinding,
    batchManifestHash: input.batchManifest.canonicalHash,
    cacheManifestHash: cacheManifest.canonicalHash,
    status: "completed" as const,
    caseCount: cases.length,
    completedCaseCount: cases.filter((item) => item.status === "completed" && item.validationOk).length,
    cases,
    startedAt: input.batchManifest.startedAt,
    finishedAt: input.batchManifest.finishedAt ?? new Date().toISOString(),
    claimBoundary: "This receipt proves artifact/config/cache binding for a full remote recompute. It does not by itself prove biological accuracy or provider/database immutability.",
  };
  return withCanonicalHash(content) as EvidenceAcquisitionReceipt;
}

export async function buildLocalEvidenceAcquisitionReceipt(input: {
  plan: EvidenceAcquisitionPlan;
  preRunSnapshot: LocalEvidenceSnapshot;
  postRunSnapshot: LocalEvidenceSnapshot;
  configPath: string;
  batchDir: string;
  batchManifest: BatchManifest;
}): Promise<EvidenceAcquisitionReceipt> {
  const plan = assertEvidenceAcquisitionPlan(input.plan);
  const preRunSnapshot = assertLocalEvidenceSnapshot(input.preRunSnapshot);
  const postRunSnapshot = assertLocalEvidenceSnapshot(input.postRunSnapshot);
  if (plan.executionScope !== LOCAL_DEVELOPER_EXECUTION_SCOPE
    || plan.profile !== "sequence_structure"
    || plan.sourceKind !== "local_content_snapshot"
    || plan.portability !== "nonportable_developer_override"
    || plan.sourceManifestHash !== preRunSnapshot.canonicalHash
    || preRunSnapshot.canonicalHash !== postRunSnapshot.canonicalHash) {
    throw new Error("local evidence sources changed during acquisition or do not match the plan");
  }
  if (input.batchManifest.status !== "completed"
    || input.batchManifest.publicManifestHash !== plan.publicManifestHash
    || input.batchManifest.privateExclusionsHash !== plan.privateExclusionsHash
    || input.batchManifest.genomeHash !== plan.genomeHash
    || input.batchManifest.configSha256 !== plan.configSha256
    || (input.batchManifest.publicTargetContextHash ?? null) !== plan.publicTargetContextHash
    || input.batchManifest.narrativeMode !== "deterministic"
    || input.batchManifest.evidenceAcquisitionPlanHash !== plan.canonicalHash
    || input.batchManifest.evidenceAcquisitionEpochId !== plan.acquisitionEpochId) {
    throw new Error("prediction batch is not bound to the local evidence acquisition plan");
  }
  const localCases = new Map((await validateLocalBatchAgainstSnapshot({
    snapshot: preRunSnapshot,
    configPath: input.configPath,
    batchDir: input.batchDir,
    batchManifest: input.batchManifest,
  })).map((item) => [item.caseId, item]));
  if (localCases.size !== input.batchManifest.cases.length) {
    throw new Error("local snapshot validation is not cohort-exact");
  }
  const cases = [];
  for (const item of input.batchManifest.cases) {
    const local = localCases.get(item.caseId);
    if (!local || item.status !== "completed" || !item.validationOk) {
      throw new Error(`completed local receipt cannot include incomplete case ${item.caseId}`);
    }
    const runRoot = resolve(input.batchDir, item.runDir);
    if (relative(resolve(input.batchDir), runRoot).startsWith("..")) throw new Error("batch run path escapes the batch directory");
    const runLoaded = await ordinaryJson(join(runRoot, "run_manifest.json"), `${item.caseId}/run_manifest.json`);
    const evidenceLoaded = await ordinaryJson(join(runRoot, "evidence_manifest.json"), `${item.caseId}/evidence_manifest.json`);
    cases.push({
      caseId: item.caseId,
      status: item.status,
      validationOk: item.validationOk,
      runManifestSha256: runLoaded.file.sha256,
      evidenceManifestSha256: evidenceLoaded.file.sha256,
      evidenceBundleSha256: await requiredHash(join(runRoot, "evidence", "evidence_bundle.json"), `${item.caseId}/evidence/evidence_bundle.json`),
      blindEvidenceBundleSha256: await requiredHash(join(runRoot, "evidence", "blind_evidence_bundle.json"), `${item.caseId}/evidence/blind_evidence_bundle.json`),
      goPredictionSha256: await requiredHash(join(runRoot, "prediction", "go_predictions.json"), `${item.caseId}/prediction/go_predictions.json`),
      remoteProviderCount: 0,
      localProviderCount: local.localProviderCount,
    });
  }
  const content = {
    schemaVersion: "pi-evidence-acquisition-receipt.v2" as const,
    acquisitionPlanHash: plan.canonicalHash,
    patchBinding: plan.patchBinding,
    batchManifestHash: input.batchManifest.canonicalHash,
    // Compatibility alias retained for existing materialization/promotion
    // contracts. For this scope it is the local source manifest hash, not a
    // remote response-cache hash.
    cacheManifestHash: preRunSnapshot.canonicalHash,
    executionScope: LOCAL_DEVELOPER_EXECUTION_SCOPE,
    sourceKind: "local_content_snapshot" as const,
    sourceManifestHash: preRunSnapshot.canonicalHash,
    portability: "nonportable_developer_override" as const,
    snapshotVerification: {
      preRunHash: preRunSnapshot.canonicalHash,
      postRunHash: postRunSnapshot.canonicalHash,
    },
    status: "completed" as const,
    caseCount: cases.length,
    completedCaseCount: cases.length,
    cases,
    startedAt: input.batchManifest.startedAt,
    finishedAt: input.batchManifest.finishedAt ?? new Date().toISOString(),
    claimBoundary: "This receipt proves a cohort-complete run against one unchanged, full-content local developer snapshot. The result is intentionally nonportable and is not a public database-release claim.",
  };
  return withCanonicalHash(content) as EvidenceAcquisitionReceipt;
}

export function assertEvidenceAcquisitionReceipt(value: unknown): EvidenceAcquisitionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("evidence acquisition receipt must be an object");
  }
  const typed = value as EvidenceAcquisitionReceipt;
  const localScope = typed.executionScope === LOCAL_DEVELOPER_EXECUTION_SCOPE;
  const { canonicalHash, ...content } = typed;
  if (typed.schemaVersion !== "pi-evidence-acquisition-receipt.v2"
    || !["completed", "completed_with_failures"].includes(typed.status)
    || !Array.isArray(typed.cases)
    || !Number.isSafeInteger(typed.caseCount)
    || !Number.isSafeInteger(typed.completedCaseCount)
    || canonicalHash !== hashCanonical(content)) {
    throw new Error("evidence acquisition receipt is invalid or non-canonical");
  }
  if (typed.caseCount !== typed.cases.length
    || new Set(typed.cases.map((item) => item.caseId)).size !== typed.cases.length
    || typed.completedCaseCount !== typed.cases.filter(
      (item) => item.status === "completed" && item.validationOk,
    ).length) {
    throw new Error("evidence acquisition receipt case accounting is invalid");
  }
  for (const item of typed.cases) {
    if (typeof item.caseId !== "string" || !Number.isSafeInteger(item.remoteProviderCount)
      || (localScope ? item.remoteProviderCount !== 0 : item.remoteProviderCount < 1)
      || (localScope && (!Number.isSafeInteger(item.localProviderCount) || item.localProviderCount! < 1))
      || (!localScope && item.localProviderCount !== undefined)) {
      throw new Error("evidence acquisition receipt case provenance is invalid");
    }
    const artifactHashes = [
      item.runManifestSha256,
      item.evidenceManifestSha256,
      item.evidenceBundleSha256,
      item.blindEvidenceBundleSha256,
      item.goPredictionSha256,
    ];
    if (typed.status === "completed"
      && (item.status !== "completed" || item.validationOk !== true
        || artifactHashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)))) {
      throw new Error("completed acquisition receipt has a missing or invalid critical case artifact");
    }
  }
  for (const hash of [typed.acquisitionPlanHash, typed.batchManifestHash, typed.cacheManifestHash]) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("evidence acquisition receipt hash binding is invalid");
  }
  if (localScope) {
    if (typed.sourceKind !== "local_content_snapshot"
      || typed.portability !== "nonportable_developer_override"
      || typed.sourceManifestHash !== typed.cacheManifestHash
      || typed.snapshotVerification?.preRunHash !== typed.sourceManifestHash
      || typed.snapshotVerification?.postRunHash !== typed.sourceManifestHash) {
      throw new Error("local acquisition receipt has no unchanged nonportable source snapshot binding");
    }
  } else if (typed.executionScope !== undefined || typed.sourceKind !== undefined
    || typed.sourceManifestHash !== undefined || typed.portability !== undefined
    || typed.snapshotVerification !== undefined) {
    throw new Error("remote acquisition receipt contains local-only source fields");
  }
  assertEvidencePatchBinding(typed.patchBinding, "evidence acquisition receipt");
  return typed;
}

export async function loadEvidenceAcquisitionPlan(path: string): Promise<EvidenceAcquisitionPlan> {
  return assertEvidenceAcquisitionPlan(await readJson<unknown>(path));
}
