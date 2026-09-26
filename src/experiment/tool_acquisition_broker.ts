import { constants, copyFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  appendAcquisitionReceipt,
  loadAcquisitionPrecommit,
  loadCapabilityCampaign,
  makeArtifactReadOnly,
  precommitToolAcquisition,
  type ToolAcquisitionReceipt,
} from "./capability_governance.js";

const CAPABILITY_ROOT_ENV = "PI_ICLR_CAPABILITY_CAMPAIGN_ROOT";
const HOST_CAS_ENV = "PI_ICLR_HOST_CAS";
function safeName(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "artifact"; }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }

async function downloadHttps(url: string, destination: string, maximumBytes: number): Promise<{ artifactHash: string; byteCount: number }> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`tool download failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("tool download exceeds precommitted byte limit");
  const handle = await open(destination, "wx", 0o600), hash = createHash("sha256"); let byteCount = 0;
  try {
    const reader = response.body.getReader();
    while (true) { const { done, value } = await reader.read(); if (done) break; byteCount += value.byteLength; if (byteCount > maximumBytes) throw new Error("tool download exceeds precommitted byte limit"); hash.update(value); await handle.write(value); }
  } catch (error) { await handle.close(); await rm(destination, { force: true }); throw error; }
  await handle.close(); return { artifactHash: hash.digest("hex"), byteCount };
}

export function capabilityWorkerEnvironment(): Record<string, string> {
  const campaignRoot = process.env[CAPABILITY_ROOT_ENV], hostCasRoot = process.env[HOST_CAS_ENV];
  if ((campaignRoot && !hostCasRoot) || (!campaignRoot && hostCasRoot)) throw new Error(`${CAPABILITY_ROOT_ENV} and ${HOST_CAS_ENV} must be configured together`);
  return campaignRoot ? { PI_ICLR_PRIVATE_TOOL_ROOT: join(resolve(campaignRoot), "private-tools") } : {};
}

export function createToolAcquisitionTool(input: { campaignId: string; updateIndex: number }) {
  const campaignRoot = process.env[CAPABILITY_ROOT_ENV], hostCasRoot = process.env[HOST_CAS_ENV];
  if (!campaignRoot && !hostCasRoot) return undefined;
  if (!campaignRoot || !hostCasRoot) throw new Error(`${CAPABILITY_ROOT_ENV} and ${HOST_CAS_ENV} must be configured together`);
  const Parameters = Type.Object({
    requestId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }),
    toolId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }),
    purpose: Type.String({ minLength: 1, maxLength: 2000 }),
    sourceUrl: Type.String({ pattern: "^https://" }),
    artifactKind: Type.Union([Type.Literal("executable"), Type.Literal("archive"), Type.Literal("model"), Type.Literal("data")]),
    expectedArtifactHash: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]),
    maxBytes: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false });
  return defineTool({ name: "request_tool_acquisition", label: "Acquire private tool", description: "Precommit and acquire one independently selected HTTPS artifact into this campaign's private toolbox. The Host downloads it; no shell installer runs.", parameters: Parameters,
    async execute(_id, params) {
      const loaded = await loadCapabilityCampaign(campaignRoot); if (loaded.state.campaignId !== input.campaignId) throw new Error("capability campaign/RSI campaign mismatch");
      const precommit = await precommitToolAcquisition(campaignRoot, { schemaVersion: "pi-rsi-tool-acquisition-precommit.v1", updateIndex: input.updateIndex, requestId: params.requestId, toolId: params.toolId, purpose: params.purpose, sourceUrl: params.sourceUrl, artifactKind: params.artifactKind, expectedArtifactHash: params.expectedArtifactHash, maxBytes: params.maxBytes, recordedAt: new Date().toISOString() });
      const receipt = await acquireToolArtifact({ campaignRoot, hostCasRoot, precommitHash: precommit.canonicalHash });
      return { content: [{ type: "text" as const, text: `Acquired ${params.toolId}. Candidate code may resolve it beneath PI_ICLR_PRIVATE_TOOL_ROOT/${receipt.installedRelativePath.replace(/^private-tools\//, "")}. Receipt ${receipt.canonicalHash}.` }], details: { precommitHash: precommit.canonicalHash, receiptHash: receipt.canonicalHash, artifactHash: receipt.artifactHash, privateToolRelativePath: receipt.installedRelativePath.replace(/^private-tools\//, "") } };
    } });
}

export async function acquireToolArtifact(input: {
  campaignRoot: string;
  hostCasRoot: string;
  precommitHash: string;
  artifactBytes?: Uint8Array;
  acquiredAt?: string;
}): Promise<ToolAcquisitionReceipt> {
  const campaignRoot = resolve(input.campaignRoot), hostCasRoot = resolve(input.hostCasRoot), precommit = await loadAcquisitionPrecommit(campaignRoot, input.precommitHash), { state } = await loadCapabilityCampaign(campaignRoot);
  if (precommit.campaignId !== state.campaignId) throw new Error("precommit belongs to another capability campaign");
  await mkdir(join(campaignRoot, "private-tools", precommit.requestId), { recursive: true }); await mkdir(join(hostCasRoot, "sha256"), { recursive: true, mode: 0o700 });
  const staging = join(campaignRoot, "tmp", `${precommit.canonicalHash}.download`); await rm(staging, { force: true });
  let artifactHash: string, byteCount: number;
  if (input.artifactBytes !== undefined) { byteCount = input.artifactBytes.byteLength; if (byteCount > precommit.maxBytes) throw new Error("tool artifact exceeds precommitted byte limit"); artifactHash = createHash("sha256").update(input.artifactBytes).digest("hex"); await writeFile(staging, input.artifactBytes, { flag: "wx", mode: 0o600 }); }
  else ({ artifactHash, byteCount } = await downloadHttps(precommit.sourceUrl, staging, precommit.maxBytes));
  if (precommit.expectedArtifactHash !== null && precommit.expectedArtifactHash !== artifactHash) { await rm(staging, { force: true }); throw new Error("downloaded artifact hash differs from precommit"); }
  const casDirectory = join(hostCasRoot, "sha256", artifactHash), casArtifact = join(casDirectory, "artifact"); await mkdir(casDirectory, { recursive: true, mode: 0o700 }); let reusedHostCasArtifact = await exists(casArtifact);
  if (!reusedHostCasArtifact) {
    try { await copyFile(staging, casArtifact, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") reusedHostCasArtifact = true;
      else { try { await copyFile(staging, casArtifact, constants.COPYFILE_EXCL); } catch (fallback) { if ((fallback as NodeJS.ErrnoException).code === "EEXIST") reusedHostCasArtifact = true; else throw fallback; } }
    }
    if (!reusedHostCasArtifact) await makeArtifactReadOnly(casArtifact, precommit.artifactKind === "executable");
  }
  const casBytes = await readFile(casArtifact);
  if (casBytes.byteLength !== byteCount || createHash("sha256").update(casBytes).digest("hex") !== artifactHash) throw new Error("Host CAS artifact integrity mismatch");
  await rm(staging, { force: true });
  const suffix = safeName(basename(new URL(precommit.sourceUrl).pathname)), installedRelativePath = `private-tools/${precommit.requestId}/${suffix}`; const installed = join(campaignRoot, installedRelativePath); await rm(installed, { force: true });
  try { await copyFile(casArtifact, installed, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE); } catch { await copyFile(casArtifact, installed, constants.COPYFILE_EXCL); }
  await makeArtifactReadOnly(installed, precommit.artifactKind === "executable");
  try {
    return await appendAcquisitionReceipt(campaignRoot, {
      schemaVersion: "pi-rsi-tool-acquisition-receipt.v1", campaignId: state.campaignId, requestId: precommit.requestId, toolId: precommit.toolId,
      precommitHash: precommit.canonicalHash, sourceUrl: precommit.sourceUrl, artifactKind: precommit.artifactKind, artifactHash, byteCount,
      installedRelativePath, reusedHostCasArtifact, acquiredAt: input.acquiredAt ?? new Date().toISOString(),
    });
  } catch (error) { await rm(installed, { force: true }); throw error; }
}
