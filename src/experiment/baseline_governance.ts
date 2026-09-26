import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { hashCanonical, sha256File } from "../hash.js";
import {
  assertStartingToolboxManifest,
  listAcquisitionReceipts,
  loadCapabilityCampaign,
  sealStartingToolboxManifest,
  verifyCapabilityCampaign,
  type StartingToolboxManifest,
  type ToolAcquisitionReceipt,
} from "./capability_governance.js";

const HASH = /^[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40,64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CandidateCapabilityBinding extends Record<string, unknown> {
  candidateId: string;
  sourceCommit: string;
  sourceTree: string;
}

export interface CandidateCapabilityDisposition extends Record<string, unknown> {
  receiptHash: string;
  disposition: "required" | "unused";
  evidenceHash: string;
  rationale: string;
}

export interface CandidateCapabilityUsageManifest extends Record<string, unknown> {
  schemaVersion: "pi-rsi-candidate-capability-usage.v1";
  campaignId: string;
  candidate: CandidateCapabilityBinding;
  commonDataManifestHash: string;
  startingToolboxManifestHash: string;
  acquiredCapabilityHeadHash: string;
  acquisitions: CandidateCapabilityDisposition[];
  requiredAcquisitionReceiptHashes: string[];
  requiredCapabilityClosureHash: string;
  verificationReceiptHash: string;
  evaluationReceiptHash: string;
  canonicalHash: string;
}

export interface VersionedBaselineRequiredTool extends Record<string, unknown> {
  toolId: string;
  version: string;
  licenseId: string;
  sourceUrl: string;
  artifactKind: ToolAcquisitionReceipt["artifactKind"];
  artifactHash: string;
  acquisitionReceiptHash: string;
  installedRelativePath: string;
  executable: boolean;
}

export interface VersionedBaselineManifest extends Record<string, unknown> {
  schemaVersion: "pi-rsi-versioned-baseline-manifest.v1";
  baselineKind: "frozen_g0" | "promoted";
  baselineId: string;
  parentBaselineId: string | null;
  armId: string;
  sourceCampaignId: string | null;
  candidate: CandidateCapabilityBinding;
  commonDataManifestHash: string;
  parentStartingToolboxManifestHash: string | null;
  startingToolboxManifestHash: string;
  candidateCapabilityUsageManifestHash: string | null;
  requiredCapabilityClosureHash: string;
  requiredAcquisitionReceiptHashes: string[];
  requiredTools: VersionedBaselineRequiredTool[];
  verificationReceiptHashes: string[];
  claimBoundary: "immutable code/tool/common-data baseline; no private evaluator data or campaign mutable state";
  canonicalHash: string;
}

export interface PromotionCapabilityClosure extends Record<string, unknown> {
  mode: "code_only" | "versioned_baseline";
  commonDataManifestHash: string;
  startingToolboxManifestHash: string;
  acquiredCapabilityHeadHash: string | null;
  candidateCapabilityUsageManifestHash: string | null;
  requiredCapabilityClosureHash: string;
  requiredAcquisitionReceiptHashes: string[];
  versionedBaselineManifestHash: string | null;
}

interface CandidateCapabilityUsageDraft {
  schemaVersion: "pi-rsi-candidate-capability-usage.v1";
  campaignId: string;
  candidate: CandidateCapabilityBinding;
  acquisitions: CandidateCapabilityDisposition[];
  verificationReceiptHash: string;
  evaluationReceiptHash: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} keys mismatch`);
}
function hash(value: unknown, label: string): string { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be SHA-256`); return value; }
function id(value: unknown, label: string): string { if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} is invalid`); return value; }
function oid(value: unknown, label: string): string { if (typeof value !== "string" || !OID.test(value)) throw new Error(`${label} is invalid`); return value; }
function text(value: unknown, label: string, maximum = 2000): string { if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new Error(`${label} must be bounded text`); return value; }
function withHash<T extends Record<string, unknown>>(body: T): T & { canonicalHash: string } { return { ...body, canonicalHash: hashCanonical(body) }; }
function canonical<T extends Record<string, unknown>>(value: T, label: string): T { const { canonicalHash, ...body } = value; if (canonicalHash !== hashCanonical(body)) throw new Error(`${label} canonicalHash mismatch`); return value; }
function uniqueSorted(values: string[], label: string): string[] { const output = [...values].sort(); if (new Set(output).size !== output.length) throw new Error(`${label} contains duplicates`); return output; }
function safeRelative(value: unknown, label: string): string { const path = text(value, label, 1000).replaceAll("\\", "/"); if (isAbsolute(path) || normalize(path).split(sep).includes("..")) throw new Error(`${label} must be relative`); return path; }
function candidate(value: unknown, label: string): CandidateCapabilityBinding { const item = object(value, label); exact(item, ["candidateId", "sourceCommit", "sourceTree"], label); return { candidateId: id(item.candidateId, `${label}.candidateId`), sourceCommit: oid(item.sourceCommit, `${label}.sourceCommit`), sourceTree: oid(item.sourceTree, `${label}.sourceTree`) }; }
function sameCandidate(left: CandidateCapabilityBinding, right: CandidateCapabilityBinding): boolean { return left.candidateId === right.candidateId && left.sourceCommit === right.sourceCommit && left.sourceTree === right.sourceTree; }
function privacyScan(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (/(?:^|[\/._-])(?:evaluator[_-]?private|private|gold|known[_-]?mask|target[_-]?identity|vault)(?:$|[\/._-])/i.test(serialized) || /GO:\d{7}/i.test(serialized) || /(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-\d+)?/.test(serialized)) throw new Error("capability baseline metadata contains evaluator-private, Gold, target, accession, or GO-answer content");
}

function closureHash(input: { candidate: CandidateCapabilityBinding; commonDataManifestHash: string; startingToolboxManifestHash: string; acquiredCapabilityHeadHash: string | null; requiredReceiptHashes: string[] }): string {
  return hashCanonical({
    schemaVersion: "pi-rsi-required-capability-closure.v1",
    candidate: input.candidate,
    commonDataManifestHash: input.commonDataManifestHash,
    startingToolboxManifestHash: input.startingToolboxManifestHash,
    acquiredCapabilityHeadHash: input.acquiredCapabilityHeadHash,
    requiredAcquisitionReceiptHashes: uniqueSorted(input.requiredReceiptHashes, "required receipt hashes"),
  });
}

export async function sealCandidateCapabilityUsage(campaignRoot: string, value: CandidateCapabilityUsageDraft): Promise<CandidateCapabilityUsageManifest> {
  await verifyCapabilityCampaign(campaignRoot);
  const { state } = await loadCapabilityCampaign(campaignRoot), receipts = await listAcquisitionReceipts(campaignRoot), raw = object(value, "candidate capability usage draft");
  exact(raw, ["schemaVersion", "campaignId", "candidate", "acquisitions", "verificationReceiptHash", "evaluationReceiptHash"], "candidate capability usage draft");
  if (raw.schemaVersion !== "pi-rsi-candidate-capability-usage.v1" || raw.campaignId !== state.campaignId) throw new Error("candidate capability usage campaign/schema mismatch");
  const boundCandidate = candidate(raw.candidate, "candidate capability usage candidate");
  if (!Array.isArray(raw.acquisitions)) throw new Error("candidate capability usage acquisitions must be an array");
  const acquisitions = raw.acquisitions.map((entry, index): CandidateCapabilityDisposition => {
    const item = object(entry, `acquisitions[${index}]`); exact(item, ["disposition", "evidenceHash", "rationale", "receiptHash"], `acquisitions[${index}]`);
    if (item.disposition !== "required" && item.disposition !== "unused") throw new Error("capability disposition must be required or unused");
    return { receiptHash: hash(item.receiptHash, `acquisitions[${index}].receiptHash`), disposition: item.disposition, evidenceHash: hash(item.evidenceHash, `acquisitions[${index}].evidenceHash`), rationale: text(item.rationale, `acquisitions[${index}].rationale`) };
  }).sort((left, right) => left.receiptHash.localeCompare(right.receiptHash));
  const expected = uniqueSorted(receipts.map((receipt) => receipt.canonicalHash), "campaign acquisition receipt hashes");
  const declared = uniqueSorted(acquisitions.map((entry) => entry.receiptHash), "declared acquisition receipt hashes");
  if (JSON.stringify(expected) !== JSON.stringify(declared)) throw new Error("candidate capability usage must classify every successful acquisition exactly once");
  privacyScan(acquisitions);
  const required = acquisitions.filter((entry) => entry.disposition === "required").map((entry) => entry.receiptHash);
  const requiredCapabilityClosureHash = closureHash({ candidate: boundCandidate, commonDataManifestHash: state.commonDataManifestHash, startingToolboxManifestHash: state.startingToolboxManifestHash, acquiredCapabilityHeadHash: state.acquiredCapabilityHeadHash, requiredReceiptHashes: required });
  return withHash({
    schemaVersion: "pi-rsi-candidate-capability-usage.v1" as const,
    campaignId: state.campaignId,
    candidate: boundCandidate,
    commonDataManifestHash: state.commonDataManifestHash,
    startingToolboxManifestHash: state.startingToolboxManifestHash,
    acquiredCapabilityHeadHash: hash(state.acquiredCapabilityHeadHash, "acquiredCapabilityHeadHash"),
    acquisitions,
    requiredAcquisitionReceiptHashes: uniqueSorted(required, "required acquisition receipt hashes"),
    requiredCapabilityClosureHash,
    verificationReceiptHash: hash(raw.verificationReceiptHash, "verificationReceiptHash"),
    evaluationReceiptHash: hash(raw.evaluationReceiptHash, "evaluationReceiptHash"),
  });
}

export function assertCandidateCapabilityUsage(value: unknown): CandidateCapabilityUsageManifest {
  const item = canonical(object(value, "candidate capability usage"), "candidate capability usage");
  exact(item, ["schemaVersion", "campaignId", "candidate", "commonDataManifestHash", "startingToolboxManifestHash", "acquiredCapabilityHeadHash", "acquisitions", "requiredAcquisitionReceiptHashes", "requiredCapabilityClosureHash", "verificationReceiptHash", "evaluationReceiptHash", "canonicalHash"], "candidate capability usage");
  if (item.schemaVersion !== "pi-rsi-candidate-capability-usage.v1") throw new Error("unsupported candidate capability usage schema");
  id(item.campaignId, "campaignId"); const boundCandidate = candidate(item.candidate, "candidate");
  hash(item.commonDataManifestHash, "commonDataManifestHash"); hash(item.startingToolboxManifestHash, "startingToolboxManifestHash"); hash(item.acquiredCapabilityHeadHash, "acquiredCapabilityHeadHash");
  hash(item.requiredCapabilityClosureHash, "requiredCapabilityClosureHash"); hash(item.verificationReceiptHash, "verificationReceiptHash"); hash(item.evaluationReceiptHash, "evaluationReceiptHash");
  if (!Array.isArray(item.acquisitions) || !Array.isArray(item.requiredAcquisitionReceiptHashes)) throw new Error("candidate capability usage arrays are invalid");
  const acquisitions = (item.acquisitions as unknown[]).map((entry, index): CandidateCapabilityDisposition => { const raw = object(entry, `acquisitions[${index}]`); exact(raw, ["disposition", "evidenceHash", "rationale", "receiptHash"], `acquisitions[${index}]`); if (raw.disposition !== "required" && raw.disposition !== "unused") throw new Error("capability disposition must be required or unused"); return { receiptHash: hash(raw.receiptHash, "acquisition receiptHash"), disposition: raw.disposition, evidenceHash: hash(raw.evidenceHash, "acquisition evidenceHash"), rationale: text(raw.rationale, "acquisition rationale") }; });
  uniqueSorted(acquisitions.map((entry) => entry.receiptHash), "usage acquisition receipt hashes"); privacyScan(acquisitions);
  const required = uniqueSorted(acquisitions.filter((entry) => entry.disposition === "required").map((entry) => entry.receiptHash), "required acquisition receipt hashes");
  if (JSON.stringify(required) !== JSON.stringify(item.requiredAcquisitionReceiptHashes)) throw new Error("required capability receipt list differs from dispositions");
  const expected = closureHash({ candidate: boundCandidate, commonDataManifestHash: String(item.commonDataManifestHash), startingToolboxManifestHash: String(item.startingToolboxManifestHash), acquiredCapabilityHeadHash: String(item.acquiredCapabilityHeadHash), requiredReceiptHashes: required });
  if (item.requiredCapabilityClosureHash !== expected) throw new Error("required capability closure hash mismatch");
  return item as unknown as CandidateCapabilityUsageManifest;
}

async function writeExclusive(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o400 }); }
async function cloneArtifact(source: string, destination: string, executable: boolean): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try { await copyFile(source, destination, constants.COPYFILE_FICLONE_FORCE); } catch { await copyFile(source, destination); }
  await chmod(destination, executable ? 0o555 : 0o444);
}

export async function materializeFrozenG0Baseline(input: {
  destinationRoot: string;
  baselineId: string;
  armId: string;
  candidate: CandidateCapabilityBinding;
  commonDataManifestHash: string;
  startingToolboxManifest: StartingToolboxManifest;
  verificationReceiptHashes: string[];
}): Promise<VersionedBaselineManifest> {
  const toolbox = assertStartingToolboxManifest(input.startingToolboxManifest), boundCandidate = candidate(input.candidate, "candidate");
  if (toolbox.commonDataManifestHash !== hash(input.commonDataManifestHash, "commonDataManifestHash")) throw new Error("frozen G0 common data/toolbox mismatch");
  const root = resolve(input.destinationRoot);
  try { await access(root); throw new Error("frozen G0 baseline destination already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(root, { recursive: false, mode: 0o700 });
  await writeExclusive(join(root, "STARTING_TOOLBOX_MANIFEST.json"), toolbox);
  const requiredCapabilityClosureHash = closureHash({ candidate: boundCandidate, commonDataManifestHash: toolbox.commonDataManifestHash, startingToolboxManifestHash: toolbox.canonicalHash, acquiredCapabilityHeadHash: null, requiredReceiptHashes: [] });
  const body = {
    schemaVersion: "pi-rsi-versioned-baseline-manifest.v1" as const,
    baselineKind: "frozen_g0" as const,
    baselineId: id(input.baselineId, "baselineId"),
    parentBaselineId: null,
    armId: id(input.armId, "armId"),
    sourceCampaignId: null,
    candidate: boundCandidate,
    commonDataManifestHash: toolbox.commonDataManifestHash,
    parentStartingToolboxManifestHash: null,
    startingToolboxManifestHash: toolbox.canonicalHash,
    candidateCapabilityUsageManifestHash: null,
    requiredCapabilityClosureHash,
    requiredAcquisitionReceiptHashes: [] as string[],
    requiredTools: [] as VersionedBaselineRequiredTool[],
    verificationReceiptHashes: uniqueSorted(input.verificationReceiptHashes.map((entry) => hash(entry, "verificationReceiptHash")), "verification receipt hashes"),
    claimBoundary: "immutable code/tool/common-data baseline; no private evaluator data or campaign mutable state" as const,
  };
  if (body.verificationReceiptHashes.length < 1) throw new Error("frozen G0 baseline requires verification receipts");
  const baseline = withHash(body); await writeExclusive(join(root, "BASELINE_MANIFEST.json"), baseline); await chmod(root, 0o500); return baseline;
}

export async function materializeVersionedBaseline(input: {
  campaignRoot: string;
  destinationRoot: string;
  usageManifest: CandidateCapabilityUsageManifest;
  parentBaselineId: string;
  baselineId: string;
  armId: string;
  toolMetadata: Array<{ receiptHash: string; version: string; licenseId: string; executable: boolean }>;
  verificationReceiptHashes: string[];
}): Promise<VersionedBaselineManifest> {
  await verifyCapabilityCampaign(input.campaignRoot);
  const usage = assertCandidateCapabilityUsage(input.usageManifest), { state, toolbox } = await loadCapabilityCampaign(input.campaignRoot), receipts = await listAcquisitionReceipts(input.campaignRoot);
  if (usage.campaignId !== state.campaignId || usage.commonDataManifestHash !== state.commonDataManifestHash || usage.startingToolboxManifestHash !== state.startingToolboxManifestHash || usage.acquiredCapabilityHeadHash !== state.acquiredCapabilityHeadHash) throw new Error("candidate capability usage no longer matches campaign state");
  if (usage.requiredAcquisitionReceiptHashes.length < 1) throw new Error("versioned baseline materialization requires at least one required acquired capability");
  const metadata = new Map(input.toolMetadata.map((entry) => [hash(entry.receiptHash, "tool metadata receiptHash"), entry]));
  if (metadata.size !== input.toolMetadata.length || metadata.size !== usage.requiredAcquisitionReceiptHashes.length) throw new Error("tool metadata must cover each required acquisition exactly once");
  const byHash = new Map(receipts.map((receipt) => [receipt.canonicalHash, receipt]));
  const root = resolve(input.destinationRoot);
  try { await access(root); throw new Error("versioned baseline destination already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(root, { recursive: false, mode: 0o700 });
  const requiredTools: VersionedBaselineRequiredTool[] = [];
  const merged = new Map(toolbox.visibleTools.map((tool) => [tool.toolId, tool]));
  for (const receiptHash of usage.requiredAcquisitionReceiptHashes) {
    const receipt = byHash.get(receiptHash), meta = metadata.get(receiptHash);
    if (!receipt || !meta) throw new Error("required acquisition receipt or tool metadata is missing");
    if (typeof meta.executable !== "boolean") throw new Error("tool metadata executable must be boolean");
    const installedRelativePath = `private-tools/${receipt.toolId}/${receipt.artifactHash}/${basename(receipt.installedRelativePath)}`;
    const source = join(resolve(input.campaignRoot), receipt.installedRelativePath), destination = join(root, installedRelativePath);
    await cloneArtifact(source, destination, meta.executable);
    if (await sha256File(destination) !== receipt.artifactHash) throw new Error("materialized baseline artifact hash mismatch");
    const requiredTool: VersionedBaselineRequiredTool = { toolId: receipt.toolId, version: text(meta.version, "tool version", 256), licenseId: text(meta.licenseId, "tool license", 256), sourceUrl: receipt.sourceUrl, artifactKind: receipt.artifactKind, artifactHash: receipt.artifactHash, acquisitionReceiptHash: receipt.canonicalHash, installedRelativePath, executable: meta.executable };
    requiredTools.push(requiredTool);
    merged.set(receipt.toolId, { toolId: receipt.toolId, version: requiredTool.version, artifactHash: receipt.artifactHash, entrypoint: installedRelativePath, licenseId: requiredTool.licenseId, sourceUrl: receipt.sourceUrl });
  }
  requiredTools.sort((left, right) => left.acquisitionReceiptHash.localeCompare(right.acquisitionReceiptHash));
  const promotedToolbox = sealStartingToolboxManifest({ schemaVersion: "pi-rsi-starting-toolbox-manifest.v1", baselineId: id(input.baselineId, "baselineId"), commonDataManifestHash: state.commonDataManifestHash, visibleTools: [...merged.values()].sort((left, right) => left.toolId.localeCompare(right.toolId)), acquisitionPolicy: toolbox.acquisitionPolicy });
  await writeExclusive(join(root, "STARTING_TOOLBOX_MANIFEST.json"), promotedToolbox);
  await writeExclusive(join(root, "CANDIDATE_CAPABILITY_USAGE.json"), usage);
  for (const receiptHash of usage.requiredAcquisitionReceiptHashes) await writeExclusive(join(root, "receipts", "acquisitions", `${receiptHash}.json`), byHash.get(receiptHash)!);
  const body = {
    schemaVersion: "pi-rsi-versioned-baseline-manifest.v1" as const,
    baselineKind: "promoted" as const,
    baselineId: id(input.baselineId, "baselineId"),
    parentBaselineId: id(input.parentBaselineId, "parentBaselineId"),
    armId: id(input.armId, "armId"),
    sourceCampaignId: state.campaignId,
    candidate: usage.candidate,
    commonDataManifestHash: state.commonDataManifestHash,
    parentStartingToolboxManifestHash: toolbox.canonicalHash,
    startingToolboxManifestHash: promotedToolbox.canonicalHash,
    candidateCapabilityUsageManifestHash: usage.canonicalHash,
    requiredCapabilityClosureHash: usage.requiredCapabilityClosureHash,
    requiredAcquisitionReceiptHashes: usage.requiredAcquisitionReceiptHashes,
    requiredTools,
    verificationReceiptHashes: uniqueSorted(input.verificationReceiptHashes.map((entry) => hash(entry, "verificationReceiptHash")), "verification receipt hashes"),
    claimBoundary: "immutable code/tool/common-data baseline; no private evaluator data or campaign mutable state" as const,
  };
  if (body.verificationReceiptHashes.length < 1) throw new Error("versioned baseline requires verification receipts");
  const baseline = withHash(body);
  await writeExclusive(join(root, "BASELINE_MANIFEST.json"), baseline);
  await chmod(root, 0o500);
  return baseline;
}

export async function verifyVersionedBaseline(rootPath: string): Promise<VersionedBaselineManifest> {
  const root = resolve(rootPath), baseline = canonical(object(JSON.parse(await readFile(join(root, "BASELINE_MANIFEST.json"), "utf8")) as unknown, "versioned baseline"), "versioned baseline");
  exact(baseline, ["schemaVersion", "baselineKind", "baselineId", "parentBaselineId", "armId", "sourceCampaignId", "candidate", "commonDataManifestHash", "parentStartingToolboxManifestHash", "startingToolboxManifestHash", "candidateCapabilityUsageManifestHash", "requiredCapabilityClosureHash", "requiredAcquisitionReceiptHashes", "requiredTools", "verificationReceiptHashes", "claimBoundary", "canonicalHash"], "versioned baseline");
  if (baseline.schemaVersion !== "pi-rsi-versioned-baseline-manifest.v1" || !["frozen_g0", "promoted"].includes(String(baseline.baselineKind)) || baseline.claimBoundary !== "immutable code/tool/common-data baseline; no private evaluator data or campaign mutable state") throw new Error("versioned baseline schema/claim boundary is invalid");
  id(baseline.baselineId, "baselineId"); id(baseline.armId, "armId"); candidate(baseline.candidate, "candidate");
  ["commonDataManifestHash", "startingToolboxManifestHash", "requiredCapabilityClosureHash"].forEach((key) => hash(baseline[key], key));
  for (const key of ["parentStartingToolboxManifestHash", "candidateCapabilityUsageManifestHash"] as const) if (baseline[key] !== null) hash(baseline[key], key);
  for (const key of ["parentBaselineId", "sourceCampaignId"] as const) if (baseline[key] !== null) id(baseline[key], key);
  if (!Array.isArray(baseline.requiredTools) || !Array.isArray(baseline.requiredAcquisitionReceiptHashes) || !Array.isArray(baseline.verificationReceiptHashes)) throw new Error("versioned baseline arrays are invalid");
  const toolbox = assertStartingToolboxManifest(JSON.parse(await readFile(join(root, "STARTING_TOOLBOX_MANIFEST.json"), "utf8")) as unknown);
  if (toolbox.canonicalHash !== baseline.startingToolboxManifestHash || toolbox.commonDataManifestHash !== baseline.commonDataManifestHash || (baseline.baselineKind === "promoted" && toolbox.baselineId !== baseline.baselineId)) throw new Error("versioned baseline starting toolbox binding mismatch");
  const requiredTools = baseline.requiredTools as VersionedBaselineRequiredTool[];
  for (const value of baseline.verificationReceiptHashes as unknown[]) hash(value, "verificationReceiptHash");
  if (baseline.baselineKind === "frozen_g0" && (baseline.parentBaselineId !== null || baseline.sourceCampaignId !== null || baseline.parentStartingToolboxManifestHash !== null || baseline.candidateCapabilityUsageManifestHash !== null || requiredTools.length !== 0 || (baseline.requiredAcquisitionReceiptHashes as unknown[]).length !== 0)) throw new Error("frozen G0 baseline cannot inherit campaign acquisitions");
  if (baseline.baselineKind === "promoted" && (baseline.parentBaselineId === null || baseline.sourceCampaignId === null || baseline.parentStartingToolboxManifestHash === null || baseline.candidateCapabilityUsageManifestHash === null || requiredTools.length === 0)) throw new Error("promoted baseline requires parent/campaign/usage/tool bindings");
  let usage: CandidateCapabilityUsageManifest | null = null;
  if (baseline.baselineKind === "promoted") {
    usage = assertCandidateCapabilityUsage(JSON.parse(await readFile(join(root, "CANDIDATE_CAPABILITY_USAGE.json"), "utf8")) as unknown);
    if (usage.canonicalHash !== baseline.candidateCapabilityUsageManifestHash || !sameCandidate(usage.candidate, candidate(baseline.candidate, "candidate")) || usage.requiredCapabilityClosureHash !== baseline.requiredCapabilityClosureHash || JSON.stringify(usage.requiredAcquisitionReceiptHashes) !== JSON.stringify(baseline.requiredAcquisitionReceiptHashes)) throw new Error("versioned baseline candidate usage binding mismatch");
  }
  const receipts = uniqueSorted(requiredTools.map((tool) => hash(tool.acquisitionReceiptHash, "required tool acquisitionReceiptHash")), "required tool receipt hashes");
  if (JSON.stringify(receipts) !== JSON.stringify(baseline.requiredAcquisitionReceiptHashes)) throw new Error("versioned baseline required receipt list mismatch");
  for (const tool of requiredTools) {
    id(tool.toolId, "required tool toolId"); text(tool.version, "required tool version", 256); text(tool.licenseId, "required tool licenseId", 256); text(tool.sourceUrl, "required tool sourceUrl", 2000); if (typeof tool.executable !== "boolean") throw new Error("required tool executable must be boolean");
    const path = safeRelative(tool.installedRelativePath, "required tool installedRelativePath"), absolute = join(root, path), rel = relative(root, absolute);
    if (rel.startsWith(`..${sep}`) || rel === "..") throw new Error("versioned baseline artifact escapes baseline root");
    if (await sha256File(absolute) !== hash(tool.artifactHash, "required tool artifactHash")) throw new Error("versioned baseline artifact hash mismatch");
    const receipt = canonical(object(JSON.parse(await readFile(join(root, "receipts", "acquisitions", `${tool.acquisitionReceiptHash}.json`), "utf8")) as unknown, "baseline acquisition receipt"), "baseline acquisition receipt") as unknown as ToolAcquisitionReceipt;
    if (receipt.canonicalHash !== tool.acquisitionReceiptHash || receipt.toolId !== tool.toolId || receipt.artifactHash !== tool.artifactHash || receipt.sourceUrl !== tool.sourceUrl || receipt.artifactKind !== tool.artifactKind) throw new Error("versioned baseline acquisition receipt/tool mismatch");
    const visible = toolbox.visibleTools.find((entry) => entry.toolId === tool.toolId);
    if (!visible || visible.artifactHash !== tool.artifactHash || visible.entrypoint !== path || visible.sourceUrl !== tool.sourceUrl) throw new Error("versioned baseline required tool/toolbox mismatch");
  }
  return baseline as unknown as VersionedBaselineManifest;
}

export async function resolvePromotionCapabilityClosure(input: {
  campaignRoot: string;
  candidate: CandidateCapabilityBinding;
  usageManifest: CandidateCapabilityUsageManifest | null;
  versionedBaselineRoot: string | null;
}): Promise<PromotionCapabilityClosure> {
  await verifyCapabilityCampaign(input.campaignRoot);
  const { state } = await loadCapabilityCampaign(input.campaignRoot), receipts = await listAcquisitionReceipts(input.campaignRoot);
  if (receipts.length === 0) {
    return { mode: "code_only", commonDataManifestHash: state.commonDataManifestHash, startingToolboxManifestHash: state.startingToolboxManifestHash, acquiredCapabilityHeadHash: state.acquiredCapabilityHeadHash, candidateCapabilityUsageManifestHash: null, requiredCapabilityClosureHash: closureHash({ candidate: input.candidate, commonDataManifestHash: state.commonDataManifestHash, startingToolboxManifestHash: state.startingToolboxManifestHash, acquiredCapabilityHeadHash: state.acquiredCapabilityHeadHash, requiredReceiptHashes: [] }), requiredAcquisitionReceiptHashes: [], versionedBaselineManifestHash: null };
  }
  if (!input.usageManifest) throw new Error("promotion requires a candidate capability usage manifest after any successful acquisition");
  const usage = assertCandidateCapabilityUsage(input.usageManifest);
  if (usage.campaignId !== state.campaignId || !sameCandidate(usage.candidate, input.candidate) || usage.commonDataManifestHash !== state.commonDataManifestHash || usage.startingToolboxManifestHash !== state.startingToolboxManifestHash || usage.acquiredCapabilityHeadHash !== state.acquiredCapabilityHeadHash) throw new Error("candidate capability usage does not bind the selected candidate/campaign state");
  const actual = uniqueSorted(receipts.map((receipt) => receipt.canonicalHash), "campaign receipt hashes"), declared = uniqueSorted(usage.acquisitions.map((entry) => entry.receiptHash), "usage receipt hashes");
  if (JSON.stringify(actual) !== JSON.stringify(declared)) throw new Error("candidate capability usage does not classify the complete acquisition closure");
  if (usage.requiredAcquisitionReceiptHashes.length === 0) return { mode: "code_only", commonDataManifestHash: state.commonDataManifestHash, startingToolboxManifestHash: state.startingToolboxManifestHash, acquiredCapabilityHeadHash: state.acquiredCapabilityHeadHash, candidateCapabilityUsageManifestHash: usage.canonicalHash, requiredCapabilityClosureHash: usage.requiredCapabilityClosureHash, requiredAcquisitionReceiptHashes: [], versionedBaselineManifestHash: null };
  if (!input.versionedBaselineRoot) throw new Error("promotion requires a sealed versioned baseline for required acquired capabilities");
  const baseline = await verifyVersionedBaseline(input.versionedBaselineRoot);
  if (!sameCandidate(baseline.candidate, input.candidate) || baseline.sourceCampaignId !== state.campaignId || baseline.commonDataManifestHash !== state.commonDataManifestHash || baseline.parentStartingToolboxManifestHash !== state.startingToolboxManifestHash || baseline.candidateCapabilityUsageManifestHash !== usage.canonicalHash || baseline.requiredCapabilityClosureHash !== usage.requiredCapabilityClosureHash || JSON.stringify(baseline.requiredAcquisitionReceiptHashes) !== JSON.stringify(usage.requiredAcquisitionReceiptHashes)) throw new Error("versioned baseline does not bind the selected candidate capability closure");
  return { mode: "versioned_baseline", commonDataManifestHash: state.commonDataManifestHash, startingToolboxManifestHash: baseline.startingToolboxManifestHash, acquiredCapabilityHeadHash: state.acquiredCapabilityHeadHash, candidateCapabilityUsageManifestHash: usage.canonicalHash, requiredCapabilityClosureHash: usage.requiredCapabilityClosureHash, requiredAcquisitionReceiptHashes: usage.requiredAcquisitionReceiptHashes, versionedBaselineManifestHash: baseline.canonicalHash };
}

export async function findCapabilityCampaignRoot(startPath: string): Promise<string> {
  let current = resolve(startPath);
  for (;;) {
    try { await access(join(current, "state.json")); await access(join(current, "manifests", "STARTING_TOOLBOX_MANIFEST.json")); return current; } catch { /* continue upward */ }
    const parent = dirname(current); if (parent === current) throw new Error("promotion requires a capability campaign state bound to the campaign"); current = parent;
  }
}

export async function readCandidateCapabilityUsage(campaignRoot: string, candidateId: string): Promise<CandidateCapabilityUsageManifest | null> {
  const path = join(resolve(campaignRoot), "candidate-capabilities", `${id(candidateId, "candidateId")}.json`);
  try { return assertCandidateCapabilityUsage(JSON.parse(await readFile(path, "utf8")) as unknown); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
