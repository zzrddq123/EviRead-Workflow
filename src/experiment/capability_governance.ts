import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { hashCanonical, sha256File } from "../hash.js";

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export interface CommonDataResource extends Record<string, unknown> {
  resourceId: string;
  release: string;
  artifactHash: string;
  licenseId: string;
  sourceUrl: string;
}

export interface CommonDataManifest extends Record<string, unknown> {
  schemaVersion: "pi-rsi-common-data-manifest.v1";
  snapshotId: string;
  resources: CommonDataResource[];
  readOnly: true;
  canonicalHash: string;
}

export interface StartingTool extends Record<string, unknown> {
  toolId: string;
  version: string;
  artifactHash: string;
  entrypoint: string;
  licenseId: string;
  sourceUrl: string;
}

export interface AcquisitionPolicy extends Record<string, unknown> {
  enabledFromUpdate: number;
  allowedSourceSchemes: ["https"];
  maxAttempts: number;
  maxSuccessfulTools: number;
  maxBytes: number;
  requireIndependentPrecommit: true;
  candidateMayBrowseHostCas: false;
}

export interface StartingToolboxManifest extends Record<string, unknown> {
  schemaVersion: "pi-rsi-starting-toolbox-manifest.v1";
  baselineId: string;
  commonDataManifestHash: string;
  visibleTools: StartingTool[];
  acquisitionPolicy: AcquisitionPolicy;
  canonicalHash: string;
}

export interface ToolAcquisitionPrecommit extends Record<string, unknown> {
  schemaVersion: "pi-rsi-tool-acquisition-precommit.v1";
  campaignId: string;
  updateIndex: number;
  requestId: string;
  toolId: string;
  purpose: string;
  sourceUrl: string;
  artifactKind: "executable" | "archive" | "model" | "data";
  expectedArtifactHash: string | null;
  maxBytes: number;
  recordedAt: string;
  previousEventHash: string | null;
  canonicalHash: string;
}

export interface ToolAcquisitionReceipt extends Record<string, unknown> {
  schemaVersion: "pi-rsi-tool-acquisition-receipt.v1";
  campaignId: string;
  requestId: string;
  toolId: string;
  precommitHash: string;
  sourceUrl: string;
  artifactKind: ToolAcquisitionPrecommit["artifactKind"];
  artifactHash: string;
  byteCount: number;
  installedRelativePath: string;
  reusedHostCasArtifact: boolean;
  acquiredAt: string;
  previousEventHash: string;
  canonicalHash: string;
}

interface CapabilityEvent extends Record<string, unknown> {
  sequence: number;
  kind: ToolAcquisitionPrecommit["schemaVersion"] | ToolAcquisitionReceipt["schemaVersion"];
  recordHash: string;
  relativePath: string;
  previousEventHash: string | null;
  eventHash: string;
}

export interface CapabilityCampaignState extends Record<string, unknown> {
  schemaVersion: "pi-rsi-capability-campaign-state.v1";
  campaignId: string;
  commonDataManifestHash: string;
  startingToolboxManifestHash: string;
  acquisitionAttempts: number;
  successfulTools: number;
  acquiredBytes: number;
  events: CapabilityEvent[];
  acquiredCapabilityHeadHash: string | null;
  canonicalHash: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} keys mismatch`);
}
function text(value: unknown, label: string, maximum = 1000): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new Error(`${label} must be bounded text`);
  return value;
}
function id(value: unknown, label: string): string { const output = text(value, label, 128); if (!SAFE_ID.test(output)) throw new Error(`${label} is invalid`); return output; }
function hash(value: unknown, label: string): string { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be SHA-256`); return value; }
function integer(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${label} is invalid`);
  return Number(value);
}
function httpsUrl(value: unknown, label: string): string { const output = text(value, label, 2000); const parsed = new URL(output); if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error(`${label} must be credential-free HTTPS`); return output; }
function timestamp(value: unknown, label: string): string { if (typeof value !== "string" || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be RFC3339 UTC`); return value; }
function canonical<T extends Record<string, unknown>>(value: T, label: string): T {
  const { canonicalHash, ...body } = value;
  if (canonicalHash !== hashCanonical(body)) throw new Error(`${label} canonicalHash mismatch`);
  return value;
}
function withHash<T extends Record<string, unknown>>(body: T): T & { canonicalHash: string } { return { ...body, canonicalHash: hashCanonical(body) }; }
function noDuplicates(values: readonly string[], label: string): void { if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`); }

export function sealCommonDataManifest(value: unknown): CommonDataManifest {
  const raw = object(value, "common data manifest");
  exact(raw, ["readOnly", "resources", "schemaVersion", "snapshotId"], "common data manifest draft");
  if (raw.schemaVersion !== "pi-rsi-common-data-manifest.v1" || raw.readOnly !== true) throw new Error("common data manifest schema/readOnly is invalid");
  if (!Array.isArray(raw.resources)) throw new Error("common data resources must be an array");
  const resources = raw.resources.map((entry, index): CommonDataResource => {
    const item = object(entry, `resources[${index}]`); exact(item, ["artifactHash", "licenseId", "release", "resourceId", "sourceUrl"], `resources[${index}]`);
    return { resourceId: id(item.resourceId, `resources[${index}].resourceId`), release: text(item.release, `resources[${index}].release`, 256), artifactHash: hash(item.artifactHash, `resources[${index}].artifactHash`), licenseId: text(item.licenseId, `resources[${index}].licenseId`, 256), sourceUrl: httpsUrl(item.sourceUrl, `resources[${index}].sourceUrl`) };
  });
  noDuplicates(resources.map((entry) => entry.resourceId), "common data resource IDs");
  return withHash({ schemaVersion: "pi-rsi-common-data-manifest.v1" as const, snapshotId: id(raw.snapshotId, "snapshotId"), resources, readOnly: true as const });
}

export function assertCommonDataManifest(value: unknown): CommonDataManifest {
  const raw = object(value, "common data manifest"); const { canonicalHash, ...body } = raw;
  const sealed = sealCommonDataManifest(body); if (canonicalHash !== sealed.canonicalHash) throw new Error("common data manifest canonicalHash mismatch"); return raw as unknown as CommonDataManifest;
}

export function sealStartingToolboxManifest(value: unknown): StartingToolboxManifest {
  const raw = object(value, "starting toolbox manifest"); exact(raw, ["acquisitionPolicy", "baselineId", "commonDataManifestHash", "schemaVersion", "visibleTools"], "starting toolbox draft");
  if (raw.schemaVersion !== "pi-rsi-starting-toolbox-manifest.v1" || !Array.isArray(raw.visibleTools)) throw new Error("starting toolbox manifest schema/tools are invalid");
  const tools = raw.visibleTools.map((entry, index): StartingTool => { const item = object(entry, `visibleTools[${index}]`); exact(item, ["artifactHash", "entrypoint", "licenseId", "sourceUrl", "toolId", "version"], `visibleTools[${index}]`); const entrypoint = text(item.entrypoint, `visibleTools[${index}].entrypoint`, 512); if (isAbsolute(entrypoint) || normalize(entrypoint).split(sep).includes("..")) throw new Error("starting tool entrypoint must be relative"); return { toolId: id(item.toolId, `visibleTools[${index}].toolId`), version: text(item.version, `visibleTools[${index}].version`, 256), artifactHash: hash(item.artifactHash, `visibleTools[${index}].artifactHash`), entrypoint, licenseId: text(item.licenseId, `visibleTools[${index}].licenseId`, 256), sourceUrl: httpsUrl(item.sourceUrl, `visibleTools[${index}].sourceUrl`) }; });
  noDuplicates(tools.map((entry) => entry.toolId), "starting tool IDs");
  const policy = object(raw.acquisitionPolicy, "acquisitionPolicy"); exact(policy, ["allowedSourceSchemes", "candidateMayBrowseHostCas", "enabledFromUpdate", "maxAttempts", "maxBytes", "maxSuccessfulTools", "requireIndependentPrecommit"], "acquisitionPolicy");
  if (JSON.stringify(policy.allowedSourceSchemes) !== JSON.stringify(["https"]) || policy.requireIndependentPrecommit !== true || policy.candidateMayBrowseHostCas !== false) throw new Error("acquisition policy isolation is invalid");
  const acquisitionPolicy: AcquisitionPolicy = { enabledFromUpdate: integer(policy.enabledFromUpdate, "enabledFromUpdate", 1), allowedSourceSchemes: ["https"], maxAttempts: integer(policy.maxAttempts, "maxAttempts", 1, 1000), maxSuccessfulTools: integer(policy.maxSuccessfulTools, "maxSuccessfulTools", 1, 1000), maxBytes: integer(policy.maxBytes, "maxBytes", 1), requireIndependentPrecommit: true, candidateMayBrowseHostCas: false };
  return withHash({ schemaVersion: "pi-rsi-starting-toolbox-manifest.v1" as const, baselineId: id(raw.baselineId, "baselineId"), commonDataManifestHash: hash(raw.commonDataManifestHash, "commonDataManifestHash"), visibleTools: tools, acquisitionPolicy });
}

export function assertStartingToolboxManifest(value: unknown): StartingToolboxManifest {
  const raw = object(value, "starting toolbox manifest"); const { canonicalHash, ...body } = raw; const sealed = sealStartingToolboxManifest(body); if (canonicalHash !== sealed.canonicalHash) throw new Error("starting toolbox manifest canonicalHash mismatch"); return raw as unknown as StartingToolboxManifest;
}

function campaignPath(root: string, ...parts: string[]): string { return join(resolve(root), ...parts); }
async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")) as unknown; }
async function writeExclusive(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
async function replaceJson(path: string, value: unknown): Promise<void> { const temporary = `${path}.tmp-${process.pid}`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, path); }

export async function initializeCapabilityCampaign(input: { campaignRoot: string; campaignId: string; commonDataManifest: unknown; startingToolboxManifest: unknown }): Promise<CapabilityCampaignState> {
  const campaignId = id(input.campaignId, "campaignId"), common = assertCommonDataManifest(input.commonDataManifest), toolbox = assertStartingToolboxManifest(input.startingToolboxManifest);
  if (toolbox.commonDataManifestHash !== common.canonicalHash) throw new Error("starting toolbox/common data binding mismatch");
  const root = resolve(input.campaignRoot); await mkdir(root, { recursive: true });
  try { await access(campaignPath(root, "state.json")); throw new Error("capability campaign already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeExclusive(campaignPath(root, "manifests", "COMMON_DATA_MANIFEST.json"), common);
  await writeExclusive(campaignPath(root, "manifests", "STARTING_TOOLBOX_MANIFEST.json"), toolbox);
  for (const directory of ["capability-view", "private-tools", "dependency-env", "cache", "home", "tmp", "receipts/precommits", "receipts/acquisitions"]) await mkdir(campaignPath(root, directory), { recursive: true });
  const state = withHash({ schemaVersion: "pi-rsi-capability-campaign-state.v1" as const, campaignId, commonDataManifestHash: common.canonicalHash, startingToolboxManifestHash: toolbox.canonicalHash, acquisitionAttempts: 0, successfulTools: 0, acquiredBytes: 0, events: [] as CapabilityEvent[], acquiredCapabilityHeadHash: null });
  await writeExclusive(campaignPath(root, "state.json"), state); return state;
}

export async function loadCapabilityCampaign(campaignRoot: string): Promise<{ state: CapabilityCampaignState; common: CommonDataManifest; toolbox: StartingToolboxManifest }> {
  const root = resolve(campaignRoot), state = canonical(object(await readJson(campaignPath(root, "state.json")), "capability state"), "capability state") as unknown as CapabilityCampaignState;
  if (state.schemaVersion !== "pi-rsi-capability-campaign-state.v1") throw new Error("unsupported capability state");
  const common = assertCommonDataManifest(await readJson(campaignPath(root, "manifests", "COMMON_DATA_MANIFEST.json"))), toolbox = assertStartingToolboxManifest(await readJson(campaignPath(root, "manifests", "STARTING_TOOLBOX_MANIFEST.json")));
  if (state.commonDataManifestHash !== common.canonicalHash || state.startingToolboxManifestHash !== toolbox.canonicalHash || toolbox.commonDataManifestHash !== common.canonicalHash) throw new Error("capability manifest/state binding mismatch");
  return { state, common, toolbox };
}

function eventFor(state: CapabilityCampaignState, kind: CapabilityEvent["kind"], relativePath: string, recordHash: string): CapabilityEvent {
  const body = { sequence: state.events.length + 1, kind, recordHash, relativePath, previousEventHash: state.acquiredCapabilityHeadHash };
  return { ...body, eventHash: hashCanonical(body) };
}
async function updateState(root: string, state: CapabilityCampaignState): Promise<void> { const { canonicalHash: _ignored, ...body } = state; await replaceJson(campaignPath(root, "state.json"), withHash(body)); }

export async function precommitToolAcquisition(campaignRoot: string, request: Omit<ToolAcquisitionPrecommit, "campaignId" | "previousEventHash" | "canonicalHash">): Promise<ToolAcquisitionPrecommit> {
  const root = resolve(campaignRoot), { state, toolbox } = await loadCapabilityCampaign(root), raw = object(request, "tool acquisition request"); exact(raw, ["artifactKind", "expectedArtifactHash", "maxBytes", "purpose", "recordedAt", "requestId", "schemaVersion", "sourceUrl", "toolId", "updateIndex"], "tool acquisition request");
  if (raw.schemaVersion !== "pi-rsi-tool-acquisition-precommit.v1" || !["executable", "archive", "model", "data"].includes(String(raw.artifactKind))) throw new Error("tool acquisition request schema/kind is invalid");
  const updateIndex = integer(raw.updateIndex, "updateIndex", toolbox.acquisitionPolicy.enabledFromUpdate); if (state.acquisitionAttempts >= toolbox.acquisitionPolicy.maxAttempts) throw new Error("tool acquisition attempt budget exhausted");
  const requestId = id(raw.requestId, "requestId");
  for (const event of state.events.filter((entry) => entry.kind === "pi-rsi-tool-acquisition-precommit.v1")) {
    const existing = await loadAcquisitionPrecommit(root, event.recordHash);
    if (existing.requestId === requestId) throw new Error("tool acquisition requestId already exists in this campaign");
  }
  const maxBytes = integer(raw.maxBytes, "maxBytes", 1, toolbox.acquisitionPolicy.maxBytes - state.acquiredBytes), sourceUrl = httpsUrl(raw.sourceUrl, "sourceUrl");
  const body = { schemaVersion: "pi-rsi-tool-acquisition-precommit.v1" as const, campaignId: state.campaignId, updateIndex, requestId, toolId: id(raw.toolId, "toolId"), purpose: text(raw.purpose, "purpose", 2000), sourceUrl, artifactKind: raw.artifactKind as ToolAcquisitionPrecommit["artifactKind"], expectedArtifactHash: raw.expectedArtifactHash === null ? null : hash(raw.expectedArtifactHash, "expectedArtifactHash"), maxBytes, recordedAt: timestamp(raw.recordedAt, "recordedAt"), previousEventHash: state.acquiredCapabilityHeadHash };
  const precommit = withHash(body), relativePath = `receipts/precommits/${precommit.canonicalHash}.json`; await writeExclusive(campaignPath(root, relativePath), precommit);
  const event = eventFor(state, precommit.schemaVersion, relativePath, precommit.canonicalHash); state.events.push(event); state.acquisitionAttempts += 1; state.acquiredCapabilityHeadHash = event.eventHash; await updateState(root, state); return precommit;
}

export async function loadAcquisitionPrecommit(campaignRoot: string, precommitHash: string): Promise<ToolAcquisitionPrecommit> {
  hash(precommitHash, "precommitHash"); const value = canonical(object(await readJson(campaignPath(campaignRoot, "receipts", "precommits", `${precommitHash}.json`)), "tool acquisition precommit"), "tool acquisition precommit") as unknown as ToolAcquisitionPrecommit;
  if (value.schemaVersion !== "pi-rsi-tool-acquisition-precommit.v1" || value.canonicalHash !== precommitHash) throw new Error("tool acquisition precommit binding mismatch"); return value;
}

export async function appendAcquisitionReceipt(campaignRoot: string, receiptBody: {
  schemaVersion: "pi-rsi-tool-acquisition-receipt.v1";
  campaignId: string;
  requestId: string;
  toolId: string;
  precommitHash: string;
  sourceUrl: string;
  artifactKind: ToolAcquisitionPrecommit["artifactKind"];
  artifactHash: string;
  byteCount: number;
  installedRelativePath: string;
  reusedHostCasArtifact: boolean;
  acquiredAt: string;
}): Promise<ToolAcquisitionReceipt> {
  const root = resolve(campaignRoot), { state, toolbox } = await loadCapabilityCampaign(root); if (state.successfulTools >= toolbox.acquisitionPolicy.maxSuccessfulTools) throw new Error("successful tool budget exhausted");
  const precommit = await loadAcquisitionPrecommit(root, receiptBody.precommitHash); if (precommit.campaignId !== state.campaignId || precommit.requestId !== receiptBody.requestId || precommit.toolId !== receiptBody.toolId || precommit.sourceUrl !== receiptBody.sourceUrl || precommit.artifactKind !== receiptBody.artifactKind) throw new Error("acquisition receipt/precommit mismatch");
  for (const event of state.events.filter((entry) => entry.kind === "pi-rsi-tool-acquisition-receipt.v1")) {
    const existing = canonical(object(await readJson(campaignPath(root, safeRelative(event.relativePath, "receipt path"))), "tool acquisition receipt"), "tool acquisition receipt") as unknown as ToolAcquisitionReceipt;
    if (existing.precommitHash === precommit.canonicalHash) throw new Error("tool acquisition precommit already has a receipt");
  }
  hash(receiptBody.artifactHash, "receipt artifactHash"); timestamp(receiptBody.acquiredAt, "receipt acquiredAt"); safeRelative(receiptBody.installedRelativePath, "installedRelativePath");
  if (precommit.expectedArtifactHash !== null && precommit.expectedArtifactHash !== receiptBody.artifactHash) throw new Error("acquired artifact hash differs from precommit");
  if (receiptBody.byteCount > precommit.maxBytes || state.acquiredBytes + receiptBody.byteCount > toolbox.acquisitionPolicy.maxBytes) throw new Error("tool acquisition byte budget exceeded");
  const receipt = withHash({ ...receiptBody, previousEventHash: state.acquiredCapabilityHeadHash! }) as ToolAcquisitionReceipt; const relativePath = `receipts/acquisitions/${receipt.canonicalHash}.json`; await writeExclusive(campaignPath(root, relativePath), receipt);
  const event = eventFor(state, receipt.schemaVersion, relativePath, receipt.canonicalHash); state.events.push(event); state.successfulTools += 1; state.acquiredBytes += receipt.byteCount; state.acquiredCapabilityHeadHash = event.eventHash; await updateState(root, state); return receipt;
}

function safeRelative(path: string, label: string): string { if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.length === 0) throw new Error(`${label} is unsafe`); return path.replaceAll("\\", "/"); }

export async function listAcquisitionReceipts(campaignRoot: string): Promise<ToolAcquisitionReceipt[]> {
  const root = resolve(campaignRoot), { state } = await loadCapabilityCampaign(root);
  const receipts: ToolAcquisitionReceipt[] = [];
  for (const event of state.events) {
    if (event.kind !== "pi-rsi-tool-acquisition-receipt.v1") continue;
    const value = canonical(object(await readJson(campaignPath(root, safeRelative(event.relativePath, "receipt path"))), "tool acquisition receipt"), "tool acquisition receipt") as unknown as ToolAcquisitionReceipt;
    if (value.canonicalHash !== event.recordHash || value.campaignId !== state.campaignId) throw new Error("tool acquisition receipt event binding mismatch");
    receipts.push(value);
  }
  return receipts;
}

export async function verifyCapabilityCampaign(campaignRoot: string): Promise<{ campaignId: string; successfulTools: number; acquiredBytes: number; acquiredCapabilityHeadHash: string | null }> {
  const root = resolve(campaignRoot), { state, toolbox } = await loadCapabilityCampaign(root); let head: string | null = null, attempts = 0, successes = 0, bytes = 0; const precommits = new Map<string, ToolAcquisitionPrecommit>();
  for (let index = 0; index < state.events.length; index += 1) { const event = state.events[index]!; if (event.sequence !== index + 1 || event.previousEventHash !== head) throw new Error("capability event chain ordering mismatch"); const { eventHash, ...eventBody } = event; if (eventHash !== hashCanonical(eventBody)) throw new Error("capability event hash mismatch"); const path = safeRelative(event.relativePath, "event path"), record = canonical(object(await readJson(campaignPath(root, path)), "capability record"), "capability record"); if (record.canonicalHash !== event.recordHash || record.schemaVersion !== event.kind) throw new Error("capability event/record mismatch"); if (event.kind === "pi-rsi-tool-acquisition-precommit.v1") { const precommit = record as unknown as ToolAcquisitionPrecommit; if (precommit.campaignId !== state.campaignId || precommit.previousEventHash !== event.previousEventHash) throw new Error("precommit campaign/chain mismatch"); precommits.set(precommit.canonicalHash, precommit); attempts += 1; } else { const receipt = record as unknown as ToolAcquisitionReceipt, precommit = precommits.get(receipt.precommitHash); if (!precommit || receipt.previousEventHash !== event.previousEventHash || receipt.campaignId !== state.campaignId) throw new Error("acquisition receipt lacks matching earlier precommit"); const installed = campaignPath(root, safeRelative(receipt.installedRelativePath, "installedRelativePath")); if (relative(root, installed).startsWith(`..${sep}`) || await sha256File(installed) !== receipt.artifactHash) throw new Error("installed artifact hash mismatch"); if (receipt.byteCount > precommit.maxBytes) throw new Error("receipt exceeds precommit bytes"); successes += 1; bytes += receipt.byteCount; } head = event.eventHash; }
  if (attempts !== state.acquisitionAttempts || successes !== state.successfulTools || bytes !== state.acquiredBytes || head !== state.acquiredCapabilityHeadHash || attempts > toolbox.acquisitionPolicy.maxAttempts || successes > toolbox.acquisitionPolicy.maxSuccessfulTools || bytes > toolbox.acquisitionPolicy.maxBytes) throw new Error("capability state counters/head mismatch");
  return { campaignId: state.campaignId, successfulTools: successes, acquiredBytes: bytes, acquiredCapabilityHeadHash: head };
}

export async function makeArtifactReadOnly(path: string, executable: boolean): Promise<void> { await chmod(path, executable ? 0o555 : 0o444); }
