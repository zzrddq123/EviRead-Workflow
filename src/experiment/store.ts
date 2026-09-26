import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { hashCanonical } from "../hash.js";
import { assertDeveloperSafe } from "./feedback.js";
import {
  assertEvaluationReceipt,
  assertExperimentManifest,
  assertExperimentRecord,
  assertFreezeManifest,
  assertIterationPrecommit,
  assertResourceUsageReceipt,
  withExperimentHash,
  type RsiCampaignFreezeManifest,
  type RsiEvaluationReceipt,
  type RsiExperimentIndex,
  type RsiExperimentManifest,
  type RsiExperimentRecord,
  type RsiIterationPrecommit,
  type RsiResourceUsageReceipt,
} from "./contracts.js";

const experimentRoot = (campaignDir: string) => join(campaignDir, "experiment");
const manifestPath = (campaignDir: string) => join(experimentRoot(campaignDir), "manifest.json");
const indexPath = (campaignDir: string) => join(experimentRoot(campaignDir), "index.json");
const freezePath = (campaignDir: string) => join(experimentRoot(campaignDir), "freeze.json");
const HASH = /^[a-f0-9]{64}$/;

async function exists(path: string): Promise<boolean> { return access(path).then(() => true, () => false); }
async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")) as unknown; }

async function atomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function writeOrVerify(path: string, value: unknown): Promise<void> {
  if (await exists(path)) {
    if (JSON.stringify(await readJson(path)) !== JSON.stringify(value)) throw new Error(`immutable experiment artifact differs: ${path}`);
    return;
  }
  await atomic(path, value);
}

function indexWithHash(value: Omit<RsiExperimentIndex, "canonicalHash">): RsiExperimentIndex {
  return withExperimentHash(value) as RsiExperimentIndex;
}

function assertIndex(value: unknown, manifest: RsiExperimentManifest): RsiExperimentIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("experiment index must be an object");
  const index = value as RsiExperimentIndex;
  const { canonicalHash, ...body } = index;
  if (canonicalHash !== hashCanonical(body) || index.schemaVersion !== "pi-rsi-experiment-index.v1" || index.manifestHash !== manifest.canonicalHash || index.campaignId !== manifest.campaignId || !Array.isArray(index.records)) throw new Error("experiment index identity/hash mismatch");
  let previous: string | null = null;
  index.records.forEach((entry, offset) => {
    const content = { sequence: entry.sequence, kind: entry.kind, relativePath: entry.relativePath, recordHash: entry.recordHash, previousEventHash: entry.previousEventHash };
    if (entry.sequence !== offset + 1 || entry.previousEventHash !== previous || entry.eventHash !== hashCanonical(content) || !HASH.test(entry.recordHash) || entry.relativePath.startsWith("/") || entry.relativePath.split("/").includes("..")) throw new Error(`experiment index event ${offset + 1} is invalid`);
    previous = entry.eventHash;
  });
  if (index.eventHeadHash !== previous) throw new Error("experiment index head mismatch");
  return index;
}

function recordRelativePath(record: RsiExperimentRecord): string {
  if (record.schemaVersion === "pi-rsi-iteration-precommit.v1") return `records/precommit/update-${String(record.updateIndex).padStart(3, "0")}-attempt-${String(record.patchAttempt).padStart(3, "0")}.json`;
  if (record.schemaVersion === "pi-rsi-evaluation-receipt.v1") return `records/evaluation/${record.split}-${String(record.evaluatorCallIndex).padStart(4, "0")}-${record.evaluationId}.json`;
  if (record.schemaVersion === "pi-rsi-resource-usage-receipt.v1") return `records/resource/update-${String(record.updateIndex).padStart(3, "0")}-patch-${String(record.patchAttempt).padStart(3, "0")}-${record.stage}-attempt-${String(record.attempt).padStart(3, "0")}.json`;
  if (record.schemaVersion === "pi-rsi-campaign-freeze-manifest.v1") return "freeze.json";
  return `records/sealed/${record.experimentId}.json`;
}

function within(path: string, parent: string): boolean {
  const value = relative(parent, path);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
}

export async function loadExperiment(campaignDirInput: string): Promise<{ campaignDir: string; manifest: RsiExperimentManifest; index: RsiExperimentIndex }> {
  const campaignDir = resolve(campaignDirInput);
  const manifest = assertExperimentManifest(await readJson(manifestPath(campaignDir)));
  const index = assertIndex(await readJson(indexPath(campaignDir)), manifest);
  return { campaignDir, manifest, index };
}

export async function initializeExperimentStore(campaignDirInput: string, supplied: unknown): Promise<{ manifest: RsiExperimentManifest; index: RsiExperimentIndex }> {
  const campaignDir = resolve(campaignDirInput);
  const raw = supplied && typeof supplied === "object" && !Array.isArray(supplied) && !("canonicalHash" in supplied)
    ? withExperimentHash(supplied as Record<string, unknown>)
    : supplied;
  const manifest = assertExperimentManifest(raw);
  if (await exists(manifestPath(campaignDir))) {
    const existing = assertExperimentManifest(await readJson(manifestPath(campaignDir)));
    if (existing.canonicalHash !== manifest.canonicalHash) throw new Error("campaign has a different experiment manifest");
    return { manifest: existing, index: assertIndex(await readJson(indexPath(campaignDir)), existing) };
  }
  await mkdir(experimentRoot(campaignDir), { recursive: true, mode: 0o700 });
  await atomic(manifestPath(campaignDir), manifest);
  const index = indexWithHash({ schemaVersion: "pi-rsi-experiment-index.v1", manifestHash: manifest.canonicalHash, campaignId: manifest.campaignId, records: [], eventHeadHash: null, frozen: false });
  await atomic(indexPath(campaignDir), index);
  return { manifest, index };
}

export async function appendExperimentRecord(campaignDirInput: string, supplied: unknown): Promise<RsiExperimentIndex> {
  const loaded = await loadExperiment(campaignDirInput);
  const raw = supplied && typeof supplied === "object" && !Array.isArray(supplied) && !("canonicalHash" in supplied)
    ? withExperimentHash(supplied as Record<string, unknown>)
    : supplied;
  const record = assertExperimentRecord(raw, loaded.manifest);
  if (loaded.index.frozen && record.schemaVersion !== "pi-rsi-sealed-replay-manifest.v1" && !(record.schemaVersion === "pi-rsi-evaluation-receipt.v1" && record.split === "sealed")) throw new Error("campaign is frozen; only sealed records may be appended");
  if (!loaded.index.frozen && (record.schemaVersion === "pi-rsi-sealed-replay-manifest.v1" || (record.schemaVersion === "pi-rsi-evaluation-receipt.v1" && record.split === "sealed"))) throw new Error("sealed records require a frozen campaign");
  if (record.schemaVersion === "pi-rsi-evaluation-receipt.v1" && record.split === "development" && record.updateIndex > 0) {
    const precommitPaths = loaded.index.records.filter((entry) => entry.kind === "pi-rsi-iteration-precommit.v1");
    const precommits = await Promise.all(precommitPaths.map(async (entry) => assertIterationPrecommit(await readJson(join(experimentRoot(loaded.campaignDir), entry.relativePath)), loaded.manifest)));
    if (!precommits.some((entry) => entry.updateIndex === record.updateIndex)) throw new Error(`development evaluation ${record.evaluationId} has no earlier precommit`);
  }
  if (record.schemaVersion === "pi-rsi-campaign-freeze-manifest.v1") {
    if (loaded.index.frozen) throw new Error("campaign is already frozen");
    if (loaded.manifest.phase === "confirmatory") {
      const dev = loaded.index.records.filter((entry) => entry.kind === "pi-rsi-evaluation-receipt.v1");
      const receipts = await Promise.all(dev.map(async (entry) => assertEvaluationReceipt(await readJson(join(experimentRoot(loaded.campaignDir), entry.relativePath)), loaded.manifest)));
      const bound = receipts.find((entry) => entry.split === "development" && entry.canonicalHash === record.developmentEvaluationHash);
      if (!bound || bound.metricsCompleteness !== "canonical_16") throw new Error("confirmatory freeze requires a bound canonical_16 development receipt");
    }
  }
  const relativePath = recordRelativePath(record);
  const absolutePath = resolve(experimentRoot(loaded.campaignDir), relativePath);
  if (!within(absolutePath, experimentRoot(loaded.campaignDir))) throw new Error("experiment record path escapes campaign");
  await writeOrVerify(absolutePath, record);
  const duplicate = loaded.index.records.find((entry) => entry.relativePath === relativePath);
  if (duplicate) {
    if (duplicate.recordHash !== record.canonicalHash) throw new Error("experiment record path already binds another hash");
    return loaded.index;
  }
  const eventContent = { sequence: loaded.index.records.length + 1, kind: record.schemaVersion, relativePath, recordHash: record.canonicalHash, previousEventHash: loaded.index.eventHeadHash };
  const event = { ...eventContent, eventHash: hashCanonical(eventContent) };
  const next = indexWithHash({ ...loaded.index, records: [...loaded.index.records, event], eventHeadHash: event.eventHash, frozen: loaded.index.frozen || record.schemaVersion === "pi-rsi-campaign-freeze-manifest.v1", canonicalHash: undefined } as unknown as Omit<RsiExperimentIndex, "canonicalHash">);
  await atomic(`${indexPath(loaded.campaignDir)}.next`, next);
  await rename(`${indexPath(loaded.campaignDir)}.next`, indexPath(loaded.campaignDir));
  return next;
}

export async function verifyExperimentStore(campaignDirInput: string): Promise<{ valid: true; manifestHash: string; recordCount: number; eventHeadHash: string | null; frozen: boolean }> {
  const loaded = await loadExperiment(campaignDirInput);
  const seenPrecommit = new Set<string>();
  let sawFreeze = false;
  for (const entry of loaded.index.records) {
    const path = resolve(experimentRoot(loaded.campaignDir), entry.relativePath);
    if (!within(path, experimentRoot(loaded.campaignDir))) throw new Error("indexed experiment path escapes campaign");
    const record = assertExperimentRecord(await readJson(path), loaded.manifest);
    if (record.canonicalHash !== entry.recordHash) throw new Error(`experiment record hash mismatch: ${entry.relativePath}`);
    if (record.schemaVersion === "pi-rsi-iteration-precommit.v1") seenPrecommit.add(`${record.updateIndex}:${record.patchAttempt}`);
    if (record.schemaVersion === "pi-rsi-evaluation-receipt.v1" && record.updateIndex > 0 && record.split === "development") {
      if (![...seenPrecommit].some((key) => key.startsWith(`${record.updateIndex}:`))) throw new Error(`development evaluation ${record.evaluationId} has no earlier precommit`);
    }
    if (record.schemaVersion === "pi-rsi-campaign-freeze-manifest.v1") sawFreeze = true;
    if ((record.schemaVersion === "pi-rsi-sealed-replay-manifest.v1" || (record.schemaVersion === "pi-rsi-evaluation-receipt.v1" && record.split === "sealed")) && !sawFreeze) throw new Error("sealed record precedes campaign freeze");
  }
  if (loaded.index.frozen !== sawFreeze) throw new Error("experiment index frozen flag disagrees with freeze record");
  return { valid: true, manifestHash: loaded.manifest.canonicalHash, recordCount: loaded.index.records.length, eventHeadHash: loaded.index.eventHeadHash, frozen: loaded.index.frozen };
}

export async function importShuffledHistory(campaignDirInput: string, artifact: unknown): Promise<string> {
  const loaded = await loadExperiment(campaignDirInput);
  if (loaded.manifest.framework !== "latest_autonomous" || loaded.manifest.historyPolicy !== "shuffled") throw new Error("shuffled history can only be imported for a LatestRSI shuffled condition");
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error("shuffled history artifact must be an object");
  const item = artifact as Record<string, unknown>; const { canonicalHash, ...body } = item;
  if (item.schemaVersion !== "pi-rsi-shuffled-history.v1" || typeof canonicalHash !== "string" || canonicalHash !== hashCanonical(body) || !Array.isArray(item.candidateTree) || !Array.isArray(item.explorationRecords) || !Array.isArray(item.knowledgeCards) || !Array.isArray(item.unresolvedProblems)) throw new Error("shuffled history artifact identity/hash mismatch");
  assertDeveloperSafe(body, "shuffled history artifact");
  await writeOrVerify(join(experimentRoot(loaded.campaignDir), "shuffled-history.json"), item);
  return canonicalHash;
}

export async function readExperimentRecords(campaignDirInput: string): Promise<{ manifest: RsiExperimentManifest; index: RsiExperimentIndex; records: RsiExperimentRecord[] }> {
  const loaded = await loadExperiment(campaignDirInput);
  const records = await Promise.all(loaded.index.records.map(async (entry) => assertExperimentRecord(await readJson(join(experimentRoot(loaded.campaignDir), entry.relativePath)), loaded.manifest)));
  return { manifest: loaded.manifest, index: loaded.index, records };
}

export function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
export async function sha256File(path: string): Promise<string> { return sha256(await readFile(path)); }

export async function appendPrecommit(campaignDir: string, record: RsiIterationPrecommit): Promise<RsiExperimentIndex> { const loaded = await loadExperiment(campaignDir); assertIterationPrecommit(record, loaded.manifest); return appendExperimentRecord(campaignDir, record); }
export async function appendEvaluation(campaignDir: string, record: RsiEvaluationReceipt): Promise<RsiExperimentIndex> { const loaded = await loadExperiment(campaignDir); assertEvaluationReceipt(record, loaded.manifest); return appendExperimentRecord(campaignDir, record); }
export async function appendResourceUsage(campaignDir: string, record: RsiResourceUsageReceipt): Promise<RsiExperimentIndex> { const loaded = await loadExperiment(campaignDir); assertResourceUsageReceipt(record, loaded.manifest); return appendExperimentRecord(campaignDir, record); }
export async function freezeCampaign(campaignDir: string, record: RsiCampaignFreezeManifest): Promise<RsiExperimentIndex> { const loaded = await loadExperiment(campaignDir); assertFreezeManifest(record, loaded.manifest); return appendExperimentRecord(campaignDir, record); }
