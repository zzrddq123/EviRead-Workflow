import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";

import { hashCanonical, sha256File } from "./hash.js";
import type { GOAspect, GOPredictionSet } from "./types.js";

export type BenchmarkSplit = "search" | "selection" | "promotion";
export type ProtectedBenchmarkRole = "development" | "calibration" | "selection" | "test";
export type PrivateBenchmarkPartition = BenchmarkSplit | ProtectedBenchmarkRole;
export type PublicBatchSplit = BenchmarkSplit | "hidden";
export type ScoredAspect = Exclude<GOAspect, "unknown">;

export const ADAPTIVE30_SUITE_ID = "bioreason-pro-z29-fresh30" as const;
export const ADAPTIVE30_SELECTION_SEED = "bioreason-pro-z29-fresh30-20260722" as const;
export const RANDOM20_SUITE_ID = "bioreason-pro-z47-random20" as const;
export const RANDOM20_SELECTION_SEED = "bioreason-pro-z47-random20-20260725" as const;
export const PROSPECTIVE20_SUITE_ID = "bioreason-pro-z55-prospective20" as const;
export const PROSPECTIVE20_SELECTION_SEED = "bioreason-pro-z55-prospective20-20260727" as const;
export const ADAPTIVE30_PRIOR_ID_MAP_SHA256S = [
  "2a7605af91669489876ca5f667fe140ed1bf25182170e57105cd795fb6c63c9f",
  "c2f16de36df7b8849acd295ad9464ac78753f56e40cea693f2574a03ba658b3e",
  "dd2774a1dd94635eb2b099e3705033f4720c81bdb276cc2733cb833eed4724ed",
] as const;

interface PublicBenchmarkCaseBase {
  caseId: string;
  sequence: string;
  structure: string | null;
  sequenceSha256: string;
  structureSha256: string | null;
  length: number;
}

export interface PublicBenchmarkCaseV1 extends PublicBenchmarkCaseBase {
  split: BenchmarkSplit;
  stratum?: string;
}

export interface PublicBenchmarkCaseV2 extends PublicBenchmarkCaseBase {}

export type PublicBenchmarkCase = PublicBenchmarkCaseV1 | PublicBenchmarkCaseV2;

interface PublicBenchmarkManifestBase {
  suiteId: string;
  seed: string;
  metric: "flat_exact_smoke_v1" | "aspect_masked_flat_exact_smoke_v2";
  claimBoundary: string;
  canonicalHash: string;
}

export interface PublicBenchmarkManifestV1 extends PublicBenchmarkManifestBase {
  schemaVersion: "pi-bioreason-public-suite.v1";
  cases: PublicBenchmarkCaseV1[];
  splits: Record<BenchmarkSplit, string[]>;
}

export interface PublicBenchmarkManifestV2 extends PublicBenchmarkManifestBase {
  schemaVersion: "pi-bioreason-public-suite.v2";
  cases: PublicBenchmarkCaseV2[];
  /** Present only as one of the complete, count-bound CAFA profile tuples. */
  suiteProfile?: "protected20" | "adaptive30" | "random20" | "prospective20";
  partitionPolicy?:
    | "evaluator_private_development_calibration_selection_test_v1"
    | "evaluator_private_adaptive_development_only_v1";
  evaluationMetric?: "cafa_hierarchical_protein_centric_v1";
}

export type PublicBenchmarkManifest = PublicBenchmarkManifestV1 | PublicBenchmarkManifestV2;

/**
 * Profile labels are partitioned behind role-specific opening receipts.
 * Legacy aggregate evaluators must reject the suite from public metadata
 * before they probe `private/targets.json`, which contains all four roles.
 */
export function assertLegacyAggregateTargetAccess(
  manifest: PublicBenchmarkManifest,
  commandLabel: string,
): void {
  if (manifest.schemaVersion === "pi-bioreason-public-suite.v2"
    && (
      manifest.suiteProfile === "protected20"
      || manifest.suiteProfile === "adaptive30"
      || manifest.suiteProfile === "random20"
      || manifest.suiteProfile === "prospective20"
    )) {
    throw new Error(
      `${commandLabel} refuses ${manifest.suiteProfile} aggregate private targets; use its capability-gated CAFA gold-opening workflow`,
    );
  }
}

export interface PrivateBenchmarkTarget {
  caseId: string;
  split: PrivateBenchmarkPartition;
  accession: string;
  sequenceSha256: string;
  gold: Record<ScoredAspect, string[]>;
  /** Explicit CAFA protein-aspect mask; absent only on legacy v0.4 manifests. */
  scoredAspects?: ScoredAspect[];
  removedRootGoIds: string[];
  structureAcquisition?: Record<string, unknown>;
}

export interface PrivateBenchmarkTargets {
  schemaVersion: "pi-bioreason-private-targets.v1";
  suiteId: string;
  publicManifestHash: string;
  cases: PrivateBenchmarkTarget[];
  canonicalHash: string;
}

/** One evaluator partition. New evaluators should prefer this over targets.json. */
export interface PrivateBenchmarkTargetShard {
  schemaVersion: "pi-bioreason-private-target-shard.v1";
  suiteId: string;
  publicManifestHash: string;
  split: PrivateBenchmarkPartition;
  caseCount: number;
  cases: PrivateBenchmarkTarget[];
  canonicalHash: string;
}

export interface PrivateBenchmarkExclusion {
  caseId: string;
  sequenceSha256: string;
  accession: string;
}

export interface PrivateBenchmarkExclusions {
  schemaVersion: "pi-bioreason-private-exclusions.v1";
  suiteId: string;
  publicManifestHash: string;
  cases: PrivateBenchmarkExclusion[];
  canonicalHash: string;
}

export type PublicTargetTaxonSource = "trusted_reference_taxon_lookup_v1";

/**
 * Label-free target metadata produced inside the trusted benchmark boundary.
 *
 * The private accession is used only as the lookup key and is deliberately not
 * retained here.  This artifact may cross into the developer/prediction side:
 * it contains only an opaque case ID and the species TaxID explicitly required
 * by the phylogeny module.
 */
export interface PublicTargetContextCase {
  caseId: string;
  queryTaxonId: number;
  source: PublicTargetTaxonSource;
}

export interface PublicTargetContext {
  schemaVersion: "pi-bioreason-public-target-context.v1";
  suiteId: string;
  publicManifestHash: string;
  cases: PublicTargetContextCase[];
  canonicalHash: string;
}

export type UniProtTaxonLookup = (accession: string) => Promise<number>;
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface BatchCaseRecord {
  caseId: string;
  /** v2 public suites expose no evaluator split; public batch artifacts say hidden. */
  split: PublicBatchSplit;
  runDir: string;
  status: "completed" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  validationOk: boolean;
  error?: string;
}

export interface BatchManifest {
  schemaVersion: "pi-bioreason-batch.v2";
  suiteId: string;
  publicManifestHash: string;
  privateExclusionsHash: string;
  /** Absent only on legacy v0.6 batches; every new batch writes hash or null. */
  publicTargetContextHash?: string | null;
  /** Absent only on legacy v0.6 batches and then interpreted as optional. */
  phylogenyMode?: "optional" | "required";
  genomePath: string;
  genomeHash: string;
  narrativeMode: "pi" | "deterministic";
  identityExclusionPolicy: "trusted_private_accession_v1";
  configLabel: string;
  configSha256: string;
  /** Present only for evaluator-owned full remote recomputes. */
  evidenceAcquisitionPlanHash?: string;
  /** Opaque rolling-provider epoch paired with evidenceAcquisitionPlanHash. */
  evidenceAcquisitionEpochId?: string;
  status: "running" | "completed" | "completed_with_failures";
  cases: BatchCaseRecord[];
  startedAt: string;
  finishedAt: string | null;
  canonicalHash: string;
}

export interface BatchRunSettings extends Pick<
  BatchManifest,
  "suiteId" | "publicManifestHash" | "privateExclusionsHash" | "genomeHash" | "narrativeMode" | "identityExclusionPolicy" | "configSha256"
> {
  publicTargetContextHash: string | null;
  phylogenyMode: "optional" | "required";
  evidenceAcquisitionPlanHash?: string;
  evidenceAcquisitionEpochId?: string;
}

export function batchManifestMatchesSettings(manifest: BatchManifest, expected: BatchRunSettings): boolean {
  return manifest.schemaVersion === "pi-bioreason-batch.v2"
    && manifest.suiteId === expected.suiteId
    && manifest.publicManifestHash === expected.publicManifestHash
    && manifest.privateExclusionsHash === expected.privateExclusionsHash
    && (manifest.publicTargetContextHash ?? null) === expected.publicTargetContextHash
    && (manifest.phylogenyMode ?? "optional") === expected.phylogenyMode
    && manifest.genomeHash === expected.genomeHash
    && manifest.narrativeMode === expected.narrativeMode
    && manifest.identityExclusionPolicy === expected.identityExclusionPolicy
    && manifest.configSha256 === expected.configSha256
    && manifest.evidenceAcquisitionPlanHash === expected.evidenceAcquisitionPlanHash
    && manifest.evidenceAcquisitionEpochId === expected.evidenceAcquisitionEpochId;
}

export function publicBatchSplit(
  manifest: PublicBenchmarkManifest,
  benchmarkCase: PublicBenchmarkCase,
): PublicBatchSplit {
  if (manifest.schemaVersion === "pi-bioreason-public-suite.v2") return "hidden";
  const legacy = benchmarkCase as PublicBenchmarkCaseV1;
  if (legacy.split !== "search" && legacy.split !== "selection" && legacy.split !== "promotion") {
    throw new Error(`Legacy public case has no valid split: ${legacy.caseId}`);
  }
  return legacy.split;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export function withCanonicalHash<T extends Record<string, unknown>>(value: T): T & { canonicalHash: string } {
  const { canonicalHash: _ignored, ...content } = value;
  return { ...content, canonicalHash: hashCanonical(content) } as T & { canonicalHash: string };
}

function verifyCanonicalHash(value: Record<string, unknown>, label: string): void {
  const { canonicalHash, ...content } = value;
  if (typeof canonicalHash !== "string" || canonicalHash !== hashCanonical(content)) {
    throw new Error(`${label} canonicalHash does not match its content`);
  }
}

function ensureExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const expectedSet = new Set(expected);
  const extra = Object.keys(value).filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !(key in value));
  if (extra.length > 0 || missing.length > 0) {
    throw new Error(`${label} has an invalid field set`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function ensureRelativeSafePath(value: string, label: string): void {
  const parts = typeof value === "string" ? value.split(/[\\/]/) : [];
  if (!value
    || isAbsolute(value)
    || win32.isAbsolute(value)
    || value.includes("\0")
    || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${label} must be a safe relative path`);
  }
}

export async function loadPublicManifest(publicDirInput: string): Promise<{ publicDir: string; manifest: PublicBenchmarkManifest }> {
  const publicDir = resolve(publicDirInput);
  const manifest = await readJson<PublicBenchmarkManifest>(join(publicDir, "manifest.json"));
  if (manifest.schemaVersion !== "pi-bioreason-public-suite.v1"
    && manifest.schemaVersion !== "pi-bioreason-public-suite.v2") {
    throw new Error("Unsupported public benchmark schemaVersion");
  }
  if (manifest.metric !== "flat_exact_smoke_v1" && manifest.metric !== "aspect_masked_flat_exact_smoke_v2") {
    throw new Error("Unsupported benchmark metric contract");
  }
  verifyCanonicalHash(manifest as unknown as Record<string, unknown>, "public manifest");
  if (manifest.schemaVersion === "pi-bioreason-public-suite.v2") {
    const profileFields = [manifest.suiteProfile, manifest.partitionPolicy, manifest.evaluationMetric];
    const hasAnyProfileField = profileFields.some((value) => value !== undefined);
    const protected20 = manifest.suiteProfile === "protected20"
      && manifest.partitionPolicy === "evaluator_private_development_calibration_selection_test_v1"
      && manifest.evaluationMetric === "cafa_hierarchical_protein_centric_v1"
      && manifest.metric === "aspect_masked_flat_exact_smoke_v2"
      && manifest.cases.length === 20;
    const adaptive30 = manifest.suiteProfile === "adaptive30"
      && manifest.suiteId === ADAPTIVE30_SUITE_ID
      && manifest.seed === ADAPTIVE30_SELECTION_SEED
      && manifest.partitionPolicy === "evaluator_private_adaptive_development_only_v1"
      && manifest.evaluationMetric === "cafa_hierarchical_protein_centric_v1"
      && manifest.metric === "aspect_masked_flat_exact_smoke_v2"
      && manifest.cases.length === 30
      && manifest.cases.every((item) => item.structure !== null && item.structureSha256 !== null);
    const random20 = manifest.suiteProfile === "random20"
      && manifest.suiteId === RANDOM20_SUITE_ID
      && manifest.seed === RANDOM20_SELECTION_SEED
      && manifest.partitionPolicy === "evaluator_private_development_calibration_selection_test_v1"
      && manifest.evaluationMetric === "cafa_hierarchical_protein_centric_v1"
      && manifest.metric === "aspect_masked_flat_exact_smoke_v2"
      && manifest.cases.length === 20;
    const prospective20 = manifest.suiteProfile === "prospective20"
      && manifest.suiteId === PROSPECTIVE20_SUITE_ID
      && manifest.seed === PROSPECTIVE20_SELECTION_SEED
      && manifest.partitionPolicy === "evaluator_private_development_calibration_selection_test_v1"
      && manifest.evaluationMetric === "cafa_hierarchical_protein_centric_v1"
      && manifest.metric === "aspect_masked_flat_exact_smoke_v2"
      && manifest.cases.length === 20;
    if (hasAnyProfileField && !protected20 && !adaptive30 && !random20 && !prospective20) {
      throw new Error("Profiled public benchmark metadata must match an exact count- and policy-bound CAFA profile");
    }
  }
  const caseIds = new Set<string>();
  const sequenceHashes = new Set<string>();
  for (const item of manifest.cases) {
    if (!/^CASE_[0-9]{3}_[A-F0-9]{8}$/.test(item.caseId)) throw new Error(`Invalid opaque case ID: ${item.caseId}`);
    if (caseIds.has(item.caseId)) throw new Error(`Duplicate public case ID: ${item.caseId}`);
    if (sequenceHashes.has(item.sequenceSha256)) throw new Error(`Duplicate public sequence hash: ${item.sequenceSha256}`);
    caseIds.add(item.caseId);
    sequenceHashes.add(item.sequenceSha256);
    if (manifest.schemaVersion === "pi-bioreason-public-suite.v2") {
      if ("split" in item || "stratum" in item) {
        throw new Error(`Public v2 case leaks evaluator partition metadata: ${item.caseId}`);
      }
    } else {
      const legacy = item as PublicBenchmarkCaseV1;
      if (legacy.split !== "search" && legacy.split !== "selection" && legacy.split !== "promotion") {
        throw new Error(`Invalid legacy public split: ${item.caseId}`);
      }
    }
    ensureRelativeSafePath(item.sequence, `${item.caseId}.sequence`);
    if (item.structure) ensureRelativeSafePath(item.structure, `${item.caseId}.structure`);
    const sequencePath = join(publicDir, item.sequence);
    if (!(await exists(sequencePath))) throw new Error(`Missing public sequence: ${sequencePath}`);
    if (await sha256File(sequencePath) !== item.sequenceSha256) throw new Error(`Public sequence hash mismatch: ${item.caseId}`);
    if (item.structure) {
      const structurePath = join(publicDir, item.structure);
      if (!(await exists(structurePath))) throw new Error(`Missing public structure: ${structurePath}`);
      if (await sha256File(structurePath) !== item.structureSha256) throw new Error(`Public structure hash mismatch: ${item.caseId}`);
    } else if (item.structureSha256 !== null) {
      throw new Error(`Structure hash present without structure path: ${item.caseId}`);
    }
  }
  if (manifest.schemaVersion === "pi-bioreason-public-suite.v1") {
    if (!manifest.splits || typeof manifest.splits !== "object") throw new Error("Legacy public manifest has no split partition");
    for (const split of ["search", "selection", "promotion"] as const) {
      if (!Array.isArray(manifest.splits[split])) throw new Error(`Legacy public split list is invalid: ${split}`);
      for (const caseId of manifest.splits[split]) {
        const item = manifest.cases.find((candidate) => candidate.caseId === caseId);
        if (item && item.split !== split) throw new Error(`Legacy public case/split list mismatch: ${caseId}`);
      }
    }
    const declared = [...Object.values(manifest.splits).flat()].sort();
    if (JSON.stringify(declared) !== JSON.stringify([...caseIds].sort())) throw new Error("Public split lists do not partition the cases exactly once");
  } else if ("splits" in (manifest as unknown as Record<string, unknown>)) {
    throw new Error("Public v2 manifest must not expose evaluator split lists");
  }
  return { publicDir, manifest };
}

function privatePartitionsFor(expected: PublicBenchmarkManifest): ReadonlySet<PrivateBenchmarkPartition> {
  if (expected.schemaVersion === "pi-bioreason-public-suite.v2"
    && (
      expected.suiteProfile === "protected20"
      || expected.suiteProfile === "random20"
      || expected.suiteProfile === "prospective20"
    )) {
    return new Set<PrivateBenchmarkPartition>(["development", "calibration", "selection", "test"]);
  }
  if (expected.schemaVersion === "pi-bioreason-public-suite.v2" && expected.suiteProfile === "adaptive30") {
    return new Set<PrivateBenchmarkPartition>(["development"]);
  }
  return new Set<PrivateBenchmarkPartition>(["search", "selection", "promotion"]);
}

export async function loadPrivateTargets(privateDirInput: string, expected: PublicBenchmarkManifest): Promise<PrivateBenchmarkTargets> {
  const privateDir = resolve(privateDirInput);
  const targets = await readJson<PrivateBenchmarkTargets>(join(privateDir, "targets.json"));
  if (targets.schemaVersion !== "pi-bioreason-private-targets.v1") throw new Error("Unsupported private benchmark schemaVersion");
  verifyCanonicalHash(targets as unknown as Record<string, unknown>, "private targets");
  if (targets.suiteId !== expected.suiteId || targets.publicManifestHash !== expected.canonicalHash) {
    throw new Error("Private targets are not bound to this public benchmark manifest");
  }
  const seen = validatePrivateTargetCases(targets.cases, expected);
  if (seen.size !== expected.cases.length) throw new Error("Private targets do not cover every public case exactly once");
  return targets;
}

function validatePrivateTargetCases(
  cases: PrivateBenchmarkTarget[],
  expected: PublicBenchmarkManifest,
  requiredSplit?: PrivateBenchmarkPartition,
): Set<string> {
  if (!Array.isArray(cases)) throw new Error("Private targets cases must be an array");
  const publicById = new Map(expected.cases.map((item) => [item.caseId, item]));
  const allowedPartitions = privatePartitionsFor(expected);
  const seen = new Set<string>();
  for (const target of cases) {
    if (seen.has(target.caseId)) throw new Error(`Duplicate private target case: ${target.caseId}`);
    seen.add(target.caseId);
    const publicCase = publicById.get(target.caseId);
    if (!publicCase) throw new Error(`Private target has no public case: ${target.caseId}`);
    if (!allowedPartitions.has(target.split)
      || (requiredSplit !== undefined && target.split !== requiredSplit)
      || target.sequenceSha256 !== publicCase.sequenceSha256
      || (expected.schemaVersion === "pi-bioreason-public-suite.v1"
        && target.split !== (publicCase as PublicBenchmarkCaseV1).split)) {
      throw new Error(`Private/public target binding mismatch: ${target.caseId}`);
    }
    if (!/^[A-Z0-9]+(?:-[0-9]+)?$/.test(target.accession)) {
      throw new Error(`Invalid private target accession: ${target.caseId}`);
    }
    for (const terms of Object.values(target.gold)) {
      if (!Array.isArray(terms) || terms.some((term) => !/^GO:\d{7}$/.test(term))) throw new Error(`Invalid gold GO list: ${target.caseId}`);
    }
    if (expected.metric === "aspect_masked_flat_exact_smoke_v2" && target.scoredAspects === undefined) {
      throw new Error(`Aspect-masked v2 target must declare scoredAspects: ${target.caseId}`);
    }
    if (target.scoredAspects !== undefined) {
      const allowed = new Set<ScoredAspect>(["molecular_function", "biological_process", "cellular_component"]);
      if (!Array.isArray(target.scoredAspects)
        || target.scoredAspects.length === 0
        || new Set(target.scoredAspects).size !== target.scoredAspects.length
        || target.scoredAspects.some((aspect) => !allowed.has(aspect))) {
        throw new Error(`Invalid scored-aspect mask: ${target.caseId}`);
      }
    }
  }
  return seen;
}

/**
 * Open and validate exactly one evaluator-private target partition.
 *
 * This function deliberately does not read legacy targets.json, seal.json, or
 * sibling shards. For split-hidden public v2 suites, callers should pass the
 * expected hash precommitted in seal.v2; that hash makes this shard the
 * authoritative split membership. Legacy v1 suites additionally expose enough
 * information for an exact case-ID coverage comparison.
 */
export async function loadPrivateTargetShard(
  privateDirInput: string,
  expected: PublicBenchmarkManifest,
  split: PrivateBenchmarkPartition,
  expectedCanonicalHash?: string,
): Promise<PrivateBenchmarkTargetShard> {
  if (!privatePartitionsFor(expected).has(split)) {
    throw new Error("Unsupported private target shard split");
  }
  const privateDir = resolve(privateDirInput);
  const shard = await readJson<PrivateBenchmarkTargetShard>(join(privateDir, "shards", `${split}.targets.json`));
  if (shard.schemaVersion !== "pi-bioreason-private-target-shard.v1") {
    throw new Error("Unsupported private target shard schemaVersion");
  }
  verifyCanonicalHash(shard as unknown as Record<string, unknown>, `private ${split} target shard`);
  if (expectedCanonicalHash !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(expectedCanonicalHash)) throw new Error("Expected private target shard hash is invalid");
    if (shard.canonicalHash !== expectedCanonicalHash) {
      throw new Error(`Private ${split} target shard no longer matches its precommitted seal hash`);
    }
  }
  if (shard.suiteId !== expected.suiteId || shard.publicManifestHash !== expected.canonicalHash) {
    throw new Error("Private target shard is not bound to this public benchmark manifest");
  }
  if (shard.split !== split) throw new Error(`Private target shard split mismatch: expected ${split}`);
  if (!Array.isArray(shard.cases)
    || !Number.isSafeInteger(shard.caseCount)
    || shard.caseCount < 1
    || shard.caseCount !== shard.cases.length) {
    throw new Error(`Private ${split} target shard caseCount does not match its cases`);
  }
  const seen = validatePrivateTargetCases(shard.cases, expected, split);
  if (expected.schemaVersion === "pi-bioreason-public-suite.v1") {
    if (split !== "search" && split !== "selection" && split !== "promotion") {
      throw new Error("Legacy public suites cannot bind a protected benchmark role");
    }
    const expectedIds = [...expected.splits[split]].sort();
    if (JSON.stringify([...seen].sort()) !== JSON.stringify(expectedIds)) {
      throw new Error(`Private ${split} target shard does not cover its public split exactly once`);
    }
  }
  return shard;
}

export async function loadPrivateExclusions(
  privateDirInput: string,
  expected: PublicBenchmarkManifest,
): Promise<PrivateBenchmarkExclusions> {
  const privateDir = resolve(privateDirInput);
  const exclusions = await readJson<PrivateBenchmarkExclusions>(join(privateDir, "exclusions.json"));
  if (exclusions.schemaVersion !== "pi-bioreason-private-exclusions.v1") {
    throw new Error("Unsupported private benchmark exclusions schemaVersion");
  }
  verifyCanonicalHash(exclusions as unknown as Record<string, unknown>, "private exclusions");
  if (exclusions.suiteId !== expected.suiteId || exclusions.publicManifestHash !== expected.canonicalHash) {
    throw new Error("Private exclusions are not bound to this public benchmark manifest");
  }
  const publicById = new Map(expected.cases.map((item) => [item.caseId, item]));
  const seen = new Set<string>();
  for (const exclusion of exclusions.cases) {
    if (seen.has(exclusion.caseId)) throw new Error(`Duplicate private exclusion case: ${exclusion.caseId}`);
    seen.add(exclusion.caseId);
    const publicCase = publicById.get(exclusion.caseId);
    if (!publicCase) throw new Error(`Private exclusion has no public case: ${exclusion.caseId}`);
    if (exclusion.sequenceSha256 !== publicCase.sequenceSha256) {
      throw new Error(`Private exclusion/public sequence binding mismatch: ${exclusion.caseId}`);
    }
    if (!/^[A-Z0-9]+(?:-[0-9]+)?$/.test(exclusion.accession)) {
      throw new Error(`Invalid private exclusion accession: ${exclusion.caseId}`);
    }
  }
  if (seen.size !== expected.cases.length) throw new Error("Private exclusions do not cover every public case exactly once");
  return exclusions;
}

/** Resolve only an NCBI TaxID from a trusted UniProtKB accession lookup. */
export async function lookupUniProtTaxonId(
  accession: string,
  fetcher: FetchLike = globalThis.fetch,
): Promise<number> {
  try {
    const direct = new URL(`https://rest.uniprot.org/uniprotkb/${encodeURIComponent(accession)}.json`);
    direct.searchParams.set("fields", "organism_id");
    const search = new URL("https://rest.uniprot.org/uniprotkb/search");
    search.searchParams.set("query", `accession:${accession}`);
    search.searchParams.set("fields", "accession,organism_id");
    search.searchParams.set("format", "json");
    search.searchParams.set("size", "1");
    // AlphaFold DB is keyed by the same accession and retains TaxID metadata
    // for some records no longer returned by the current UniProtKB endpoint.
    const alphaFold = new URL(`https://alphafold.ebi.ac.uk/api/prediction/${encodeURIComponent(accession)}`);
    for (const url of [direct, search, alphaFold]) {
      const response = await fetcher(url, {
        headers: {
          accept: "application/json,*/*",
          "user-agent": "PiFunctionPredictionAgent/0.7 benchmark-target-context",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) continue;
      const payload = await response.json() as unknown;
      const entry = Array.isArray(payload)
        ? payload[0]
        : (payload && typeof payload === "object" && !Array.isArray(payload)
          && Array.isArray((payload as Record<string, unknown>).results)
          ? ((payload as Record<string, unknown>).results as unknown[])[0]
          : payload);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const organismValue = (entry as Record<string, unknown>).organism;
      const taxonId = organismValue && typeof organismValue === "object" && !Array.isArray(organismValue)
        ? Number((organismValue as Record<string, unknown>).taxonId)
        : Number((entry as Record<string, unknown>).taxId);
      if (Number.isSafeInteger(taxonId) && taxonId > 0) return taxonId;
    }
    throw new Error("response has no positive TaxID");
  } catch {
    // Do not propagate a network error containing the accession-bearing URL.
    throw new Error("Trusted UniProtKB taxonomy lookup failed");
  }
}

/**
 * Convert identity-only private exclusions to a label-free public context.
 * The injected lookup makes network behavior testable without weakening the
 * boundary or persisting the lookup accession.
 */
export async function buildPublicTargetContext(
  expected: PublicBenchmarkManifest,
  exclusions: PrivateBenchmarkExclusions,
  taxonLookup: UniProtTaxonLookup = lookupUniProtTaxonId,
): Promise<PublicTargetContext> {
  if (exclusions.suiteId !== expected.suiteId || exclusions.publicManifestHash !== expected.canonicalHash) {
    throw new Error("Private exclusions are not bound to the public benchmark manifest");
  }
  const exclusionsByCase = new Map(exclusions.cases.map((item) => [item.caseId, item]));
  if (exclusionsByCase.size !== expected.cases.length) {
    throw new Error("Private exclusions do not cover the public benchmark exactly once");
  }
  const cases: PublicTargetContextCase[] = [];
  for (const benchmarkCase of expected.cases) {
    const exclusion = exclusionsByCase.get(benchmarkCase.caseId);
    if (!exclusion || exclusion.sequenceSha256 !== benchmarkCase.sequenceSha256) {
      throw new Error(`Private exclusion/public sequence binding mismatch: ${benchmarkCase.caseId}`);
    }
    let queryTaxonId: number;
    try {
      queryTaxonId = await taxonLookup(exclusion.accession);
    } catch {
      // The case ID is public; the secret accession and provider URL are not.
      throw new Error(`Target TaxID lookup failed for ${benchmarkCase.caseId}`);
    }
    if (!Number.isSafeInteger(queryTaxonId) || queryTaxonId <= 0) {
      throw new Error(`Target TaxID lookup returned an invalid value for ${benchmarkCase.caseId}`);
    }
    cases.push({
      caseId: benchmarkCase.caseId,
      queryTaxonId,
      source: "trusted_reference_taxon_lookup_v1",
    });
  }
  return withCanonicalHash({
    schemaVersion: "pi-bioreason-public-target-context.v1",
    suiteId: expected.suiteId,
    publicManifestHash: expected.canonicalHash,
    cases,
  }) as PublicTargetContext;
}

export async function loadPublicTargetContext(
  pathInput: string,
  expected: PublicBenchmarkManifest,
): Promise<PublicTargetContext> {
  const path = resolve(pathInput);
  const raw = record(await readJson<unknown>(path), "public target context");
  ensureExactKeys(
    raw,
    ["schemaVersion", "suiteId", "publicManifestHash", "cases", "canonicalHash"],
    "public target context",
  );
  verifyCanonicalHash(raw, "public target context");
  if (raw.schemaVersion !== "pi-bioreason-public-target-context.v1") {
    throw new Error("Unsupported public target context schemaVersion");
  }
  if (raw.suiteId !== expected.suiteId || raw.publicManifestHash !== expected.canonicalHash) {
    throw new Error("Public target context is not bound to this public benchmark manifest");
  }
  if (!Array.isArray(raw.cases) || raw.cases.length !== expected.cases.length) {
    throw new Error("Public target context does not cover every public case exactly once");
  }
  const outputCases: PublicTargetContextCase[] = [];
  for (let index = 0; index < expected.cases.length; index += 1) {
    const expectedCase = expected.cases[index];
    const item = record(raw.cases[index], `public target context case ${index + 1}`);
    ensureExactKeys(item, ["caseId", "queryTaxonId", "source"], `public target context case ${index + 1}`);
    if (item.caseId !== expectedCase.caseId) {
      throw new Error("Public target context case order/coverage does not match the public manifest");
    }
    if (!Number.isSafeInteger(item.queryTaxonId) || Number(item.queryTaxonId) <= 0) {
      throw new Error(`Public target context has an invalid TaxID: ${expectedCase.caseId}`);
    }
    if (item.source !== "trusted_reference_taxon_lookup_v1") {
      throw new Error(`Public target context has an invalid source: ${expectedCase.caseId}`);
    }
    outputCases.push({
      caseId: expectedCase.caseId,
      queryTaxonId: Number(item.queryTaxonId),
      source: "trusted_reference_taxon_lookup_v1",
    });
  }
  return { ...raw, cases: outputCases } as unknown as PublicTargetContext;
}

export function publicTargetContextPredictionArgs(
  targetContext: PublicTargetContextCase | undefined,
): string[] {
  return targetContext
    ? ["--query-taxon-id", String(targetContext.queryTaxonId), "--phylogeny-mode", "required"]
    : ["--phylogeny-mode", "optional"];
}

export function assertPrivateTargetExclusionBindings(
  targets: PrivateBenchmarkTargets,
  exclusions: PrivateBenchmarkExclusions,
): void {
  if (targets.suiteId !== exclusions.suiteId || targets.publicManifestHash !== exclusions.publicManifestHash) {
    throw new Error("Private targets and exclusions are not bound to the same benchmark");
  }
  const exclusionsByCase = new Map(exclusions.cases.map((item) => [item.caseId, item]));
  for (const target of targets.cases) {
    const exclusion = exclusionsByCase.get(target.caseId);
    if (!exclusion) throw new Error(`Private target has no matching exclusion: ${target.caseId}`);
    if (target.sequenceSha256 !== exclusion.sequenceSha256 || target.accession !== exclusion.accession) {
      throw new Error(`Private target/exclusion identity binding mismatch: ${target.caseId}`);
    }
  }
  if (targets.cases.length !== exclusions.cases.length) {
    throw new Error("Private target/exclusion counts differ");
  }
}

export function authoritativeExclusionIssues(
  prediction: Pick<GOPredictionSet, "explicitlyExcludedAccessions">,
  expectedAccession: string,
): string[] {
  const actual = Array.isArray(prediction.explicitlyExcludedAccessions)
    ? prediction.explicitlyExcludedAccessions
    : [];
  if (actual.length !== 1 || actual[0] !== expectedAccession) {
    return ["authoritative GO exclusion list must equal the trusted target exclusion exactly"];
  }
  return [];
}

export async function loadBatchManifest(
  batchDirInput: string,
  expected: PublicBenchmarkManifest,
  expectedPrivateExclusionsHash?: string,
): Promise<{ batchDir: string; manifest: BatchManifest }> {
  const batchDir = resolve(batchDirInput);
  const manifest = await readJson<BatchManifest>(join(batchDir, "batch_manifest.json"));
  if (manifest.schemaVersion !== "pi-bioreason-batch.v2") throw new Error("Unsupported batch manifest schemaVersion");
  verifyCanonicalHash(manifest as unknown as Record<string, unknown>, "batch manifest");
  if (manifest.identityExclusionPolicy !== "trusted_private_accession_v1") {
    throw new Error("Batch predates trusted private target exclusion; regenerate it with benchmark run --private");
  }
  if (manifest.suiteId !== expected.suiteId || manifest.publicManifestHash !== expected.canonicalHash) {
    throw new Error("Batch output is not bound to this public benchmark manifest");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.privateExclusionsHash)) {
    throw new Error("Batch manifest has no valid private exclusions hash; regenerate it with benchmark run --private");
  }
  if (expectedPrivateExclusionsHash && manifest.privateExclusionsHash !== expectedPrivateExclusionsHash) {
    throw new Error("Batch output is not bound to the current private exclusions manifest");
  }
  if (manifest.publicTargetContextHash !== undefined
    && manifest.publicTargetContextHash !== null
    && !/^[a-f0-9]{64}$/.test(manifest.publicTargetContextHash)) {
    throw new Error("Batch manifest has an invalid public target context hash");
  }
  const publicTargetContextHash = manifest.publicTargetContextHash ?? null;
  const phylogenyMode = manifest.phylogenyMode ?? "optional";
  if (phylogenyMode !== "optional" && phylogenyMode !== "required") {
    throw new Error("Batch manifest has an invalid phylogeny mode");
  }
  if ((publicTargetContextHash === null) !== (phylogenyMode === "optional")) {
    throw new Error("Batch target context hash and phylogeny mode are inconsistent");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.configSha256)) throw new Error("Batch manifest has no valid config content hash");
  const acquisitionHash = manifest.evidenceAcquisitionPlanHash;
  const acquisitionEpoch = manifest.evidenceAcquisitionEpochId;
  if ((acquisitionHash === undefined) !== (acquisitionEpoch === undefined)) {
    throw new Error("Batch evidence acquisition hash and epoch must be present together");
  }
  if (acquisitionHash !== undefined && !/^[a-f0-9]{64}$/.test(acquisitionHash)) {
    throw new Error("Batch manifest has an invalid evidence acquisition plan hash");
  }
  if (acquisitionEpoch !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(acquisitionEpoch)) {
    throw new Error("Batch manifest has an invalid evidence acquisition epoch ID");
  }
  if (!Array.isArray(manifest.cases)) throw new Error("Batch manifest cases must be an array");
  const expectedById = new Map(expected.cases.map((item) => [item.caseId, item]));
  const seenCaseIds = new Set<string>();
  const seenRunDirs = new Set<string>();
  for (const record of manifest.cases) {
    if (seenCaseIds.has(record.caseId)) throw new Error(`Duplicate batch case record: ${record.caseId}`);
    seenCaseIds.add(record.caseId);
    const expectedCase = expectedById.get(record.caseId);
    if (!expectedCase) throw new Error(`Unknown batch case record: ${record.caseId}`);
    if (record.split !== publicBatchSplit(expected, expectedCase)) {
      throw new Error(`Batch/public split mismatch: ${record.caseId}`);
    }
    ensureRelativeSafePath(record.runDir, `${record.caseId}.runDir`);
    if (seenRunDirs.has(record.runDir)) throw new Error(`Duplicate batch runDir: ${record.runDir}`);
    seenRunDirs.add(record.runDir);
  }
  if (manifest.status !== "running") {
    const missing = expected.cases.filter((item) => !seenCaseIds.has(item.caseId)).map((item) => item.caseId);
    if (missing.length > 0) throw new Error(`Terminal batch manifest is missing case records: ${missing.join(", ")}`);
  }
  return { batchDir, manifest };
}

export async function runInputBindingIssues(runDirInput: string, expected: PublicBenchmarkCase): Promise<string[]> {
  const runDir = resolve(runDirInput);
  let runManifest: Record<string, unknown>;
  try {
    runManifest = await readJson<Record<string, unknown>>(join(runDir, "run_manifest.json"));
  } catch (error) {
    return [`unable to read run manifest for public input binding: ${error instanceof Error ? error.message : String(error)}`];
  }
  const inputs = runManifest.inputs && typeof runManifest.inputs === "object" && !Array.isArray(runManifest.inputs)
    ? runManifest.inputs as Record<string, unknown>
    : {};
  const issues: string[] = [];
  if (inputs.sequenceSha256 !== expected.sequenceSha256) {
    issues.push("run sequence hash does not match public benchmark case");
  }
  if (inputs.structureSha256 !== expected.structureSha256) {
    issues.push("run structure hash does not match public benchmark case");
  }
  return issues;
}

export async function runTargetContextBindingIssues(
  runDirInput: string,
  expected: PublicTargetContextCase | undefined,
): Promise<string[]> {
  const runDir = resolve(runDirInput);
  let runManifest: Record<string, unknown>;
  try {
    runManifest = await readJson<Record<string, unknown>>(join(runDir, "run_manifest.json"));
  } catch (error) {
    return [`unable to read run manifest for target context binding: ${error instanceof Error ? error.message : String(error)}`];
  }
  const expectedTaxonId = expected?.queryTaxonId ?? null;
  const expectedMode = expected ? "required" : "optional";
  const actualTaxonId = runManifest.queryTaxonId === null ? null : Number(runManifest.queryTaxonId);
  const targetContext = runManifest.targetContext && typeof runManifest.targetContext === "object" && !Array.isArray(runManifest.targetContext)
    ? runManifest.targetContext as Record<string, unknown>
    : {};
  const taxon = targetContext.taxon && typeof targetContext.taxon === "object" && !Array.isArray(targetContext.taxon)
    ? targetContext.taxon as Record<string, unknown>
    : {};
  const phylogeny = targetContext.phylogeny && typeof targetContext.phylogeny === "object" && !Array.isArray(targetContext.phylogeny)
    ? targetContext.phylogeny as Record<string, unknown>
    : {};
  const issues: string[] = [];
  if (actualTaxonId !== expectedTaxonId || (taxon.taxonId === null ? null : Number(taxon.taxonId)) !== expectedTaxonId) {
    issues.push("run query TaxID does not match the bound public target context");
  }
  if (String(phylogeny.mode ?? "") !== expectedMode) {
    issues.push("run phylogeny mode does not match the bound public target context");
  }
  return issues;
}

export async function loadGoPrediction(batchDir: string, record: BatchCaseRecord): Promise<GOPredictionSet> {
  if (record.status !== "completed" || !record.validationOk) throw new Error(`Case has no valid prediction: ${record.caseId}`);
  return await readJson<GOPredictionSet>(join(batchDir, record.runDir, "prediction", "blind_go_view.json"));
}
