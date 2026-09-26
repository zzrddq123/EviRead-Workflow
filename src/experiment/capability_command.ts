import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  initializeCapabilityCampaign,
  precommitToolAcquisition,
  sealCommonDataManifest,
  sealStartingToolboxManifest,
  verifyCapabilityCampaign,
  type ToolAcquisitionPrecommit,
} from "./capability_governance.js";
import { acquireToolArtifact } from "./tool_acquisition_broker.js";
import {
  materializeFrozenG0Baseline,
  materializeVersionedBaseline,
  sealCandidateCapabilityUsage,
  verifyVersionedBaseline,
  type CandidateCapabilityUsageManifest,
} from "./baseline_governance.js";

const COMMANDS = new Set(["capability-manifest-seal", "capability-init", "capability-precommit", "capability-acquire", "capability-verify", "capability-usage-seal", "baseline-g0-materialize", "baseline-materialize", "baseline-verify"]);
async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(resolve(path), "utf8")) as unknown; }
async function output(path: string, value: unknown): Promise<void> { const resolved = resolve(path); await mkdir(dirname(resolved), { recursive: true }); await writeFile(resolved, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
function option(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
function required(args: string[], name: string): string { const value = option(args, name); if (!value) throw new Error(`missing ${name}`); return value; }

export function capabilityUsage(): string {
  return `RSI capability governance:
  ./pi-agent rsi capability-manifest-seal --kind common-data|starting-toolbox --input DRAFT.json --output MANIFEST.json
  ./pi-agent rsi capability-init --campaign-root DIR --campaign-id ID --common-data COMMON.json --starting-toolbox TOOLBOX.json
  ./pi-agent rsi capability-precommit --campaign-root DIR --request REQUEST.json
  ./pi-agent rsi capability-acquire --campaign-root DIR --host-cas DIR --precommit HASH
  ./pi-agent rsi capability-verify --campaign-root DIR
  ./pi-agent rsi capability-usage-seal --campaign-root DIR --draft DRAFT.json
  ./pi-agent rsi baseline-g0-materialize --toolbox TOOLBOX.json --draft DRAFT.json --output-root DIR
  ./pi-agent rsi baseline-materialize --campaign-root DIR --usage USAGE.json --draft DRAFT.json --output-root DIR
  ./pi-agent rsi baseline-verify --baseline-root DIR`;
}
export function isCapabilityCommand(command: string): boolean { return COMMANDS.has(command); }

export async function capabilityCommand(command: string, args: string[]): Promise<number> {
  if (command === "capability-manifest-seal") {
    const kind = required(args, "--kind"), raw = await json(required(args, "--input"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("capability manifest draft must be an object");
    const { canonicalHash: _ignored, ...body } = raw as Record<string, unknown>;
    const manifest = kind === "common-data" ? sealCommonDataManifest(body) : kind === "starting-toolbox" ? sealStartingToolboxManifest(body) : (() => { throw new Error("capability manifest kind must be common-data or starting-toolbox"); })();
    await output(required(args, "--output"), manifest); console.log(JSON.stringify({ ok: true, manifestHash: manifest.canonicalHash }, null, 2)); return 0;
  }
  if (command === "capability-init") {
    const result = await initializeCapabilityCampaign({ campaignRoot: required(args, "--campaign-root"), campaignId: required(args, "--campaign-id"), commonDataManifest: await json(required(args, "--common-data")), startingToolboxManifest: await json(required(args, "--starting-toolbox")) });
    console.log(JSON.stringify({ ok: true, campaignId: result.campaignId, stateHash: result.canonicalHash }, null, 2)); return 0;
  }
  if (command === "capability-precommit") {
    const request = await json(required(args, "--request"));
    const precommit = await precommitToolAcquisition(required(args, "--campaign-root"), request as Omit<ToolAcquisitionPrecommit, "campaignId" | "previousEventHash" | "canonicalHash">);
    console.log(JSON.stringify({ ok: true, precommitHash: precommit.canonicalHash }, null, 2)); return 0;
  }
  if (command === "capability-acquire") {
    const receipt = await acquireToolArtifact({ campaignRoot: required(args, "--campaign-root"), hostCasRoot: required(args, "--host-cas"), precommitHash: required(args, "--precommit") });
    console.log(JSON.stringify({ ok: true, receiptHash: receipt.canonicalHash, artifactHash: receipt.artifactHash, installedRelativePath: receipt.installedRelativePath }, null, 2)); return 0;
  }
  if (command === "capability-verify") { console.log(JSON.stringify({ ok: true, ...await verifyCapabilityCampaign(required(args, "--campaign-root")) }, null, 2)); return 0; }
  if (command === "capability-usage-seal") {
    const campaignRoot = resolve(required(args, "--campaign-root")), draft = await json(required(args, "--draft"));
    const usage = await sealCandidateCapabilityUsage(campaignRoot, draft as Parameters<typeof sealCandidateCapabilityUsage>[1]);
    const destination = resolve(campaignRoot, "candidate-capabilities", `${usage.candidate.candidateId}.json`);
    await output(destination, usage);
    console.log(JSON.stringify({ ok: true, usageManifestHash: usage.canonicalHash, output: destination }, null, 2)); return 0;
  }
  if (command === "baseline-g0-materialize") {
    const draft = await json(required(args, "--draft")) as Record<string, unknown>, toolbox = await json(required(args, "--toolbox"));
    const baseline = await materializeFrozenG0Baseline({ destinationRoot: required(args, "--output-root"), baselineId: String(draft.baselineId), armId: String(draft.armId), candidate: draft.candidate as Parameters<typeof materializeFrozenG0Baseline>[0]["candidate"], commonDataManifestHash: String(draft.commonDataManifestHash), startingToolboxManifest: toolbox as Parameters<typeof materializeFrozenG0Baseline>[0]["startingToolboxManifest"], verificationReceiptHashes: draft.verificationReceiptHashes as string[] });
    console.log(JSON.stringify({ ok: true, baselineManifestHash: baseline.canonicalHash, outputRoot: resolve(required(args, "--output-root")) }, null, 2)); return 0;
  }
  if (command === "baseline-materialize") {
    const draft = await json(required(args, "--draft")) as Record<string, unknown>, usage = await json(required(args, "--usage")) as CandidateCapabilityUsageManifest;
    const baseline = await materializeVersionedBaseline({ campaignRoot: required(args, "--campaign-root"), destinationRoot: required(args, "--output-root"), usageManifest: usage, parentBaselineId: String(draft.parentBaselineId), baselineId: String(draft.baselineId), armId: String(draft.armId), toolMetadata: draft.toolMetadata as Parameters<typeof materializeVersionedBaseline>[0]["toolMetadata"], verificationReceiptHashes: draft.verificationReceiptHashes as string[] });
    console.log(JSON.stringify({ ok: true, baselineManifestHash: baseline.canonicalHash, outputRoot: resolve(required(args, "--output-root")) }, null, 2)); return 0;
  }
  if (command === "baseline-verify") { const baseline = await verifyVersionedBaseline(required(args, "--baseline-root")); console.log(JSON.stringify({ ok: true, baselineId: baseline.baselineId, baselineManifestHash: baseline.canonicalHash }, null, 2)); return 0; }
  throw new Error(`unknown capability command: ${command}`);
}
