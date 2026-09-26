import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { assertExperimentManifest, withExperimentHash } from "./contracts.js";
import { assertDeveloperFeedbackView, renderDeveloperFeedback } from "./feedback.js";
import { assertFiveCellBatch, createFiveCellBatch } from "./batch.js";
import { verifyCandidateDiff } from "./candidate_guard.js";
import { exportCampaign } from "./exporter.js";
import { appendExperimentRecord, importShuffledHistory, initializeExperimentStore, verifyExperimentStore } from "./store.js";

const COMMANDS = new Set([
  "experiment-manifest-seal", "experiment-spec-bind", "experiment-init", "experiment-record", "experiment-feedback-render",
  "experiment-batch-plan", "experiment-history-import", "experiment-candidate-guard", "experiment-export", "experiment-verify",
]);

async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(resolve(path), "utf8")) as unknown; }
async function output(path: string, value: unknown): Promise<void> { const resolved = resolve(path); await mkdir(dirname(resolved), { recursive: true }); await writeFile(resolved, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
function option(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
function required(args: string[], name: string): string { const value = option(args, name); if (!value) throw new Error(`missing ${name}`); return value; }

export function experimentUsage(): string {
  return `RSI experiment instrumentation:
  ./pi-agent rsi experiment-manifest-seal --input DRAFT.json --output MANIFEST.json
  ./pi-agent rsi experiment-spec-bind --spec SPEC.json --manifest MANIFEST.json --output BOUND_SPEC.json
  ./pi-agent rsi experiment-init --manifest MANIFEST.json --campaign-dir DIR
  ./pi-agent rsi experiment-record --campaign-dir DIR --record RECORD.json
  ./pi-agent rsi experiment-feedback-render --evaluation PRIVATE.json --policy metric_only|structured_diagnostic --output VIEW.json
  ./pi-agent rsi experiment-batch-plan --design DESIGN.json --output BATCH.json
  ./pi-agent rsi experiment-history-import --campaign-dir DIR --artifact SHUFFLED.json
  ./pi-agent rsi experiment-candidate-guard --repo REPO --base COMMIT --candidate COMMIT
  ./pi-agent rsi experiment-export --campaign-dir DIR --output EXPORT.json
  ./pi-agent rsi experiment-verify --campaign-dir DIR`;
}

export function isExperimentCommand(command: string): boolean { return COMMANDS.has(command); }

export async function experimentCommand(command: string, args: string[]): Promise<number> {
  if (command === "experiment-manifest-seal") {
    const raw = await json(required(args, "--input"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("manifest draft must be an object");
    const { canonicalHash: _ignored, ...body } = raw as Record<string, unknown>;
    const manifest = assertExperimentManifest(withExperimentHash(body));
    await output(required(args, "--output"), manifest); console.log(JSON.stringify({ ok: true, manifestHash: manifest.canonicalHash }, null, 2)); return 0;
  }
  if (command === "experiment-spec-bind") {
    const specValue = await json(required(args, "--spec"));
    if (!specValue || typeof specValue !== "object" || Array.isArray(specValue)) throw new Error("RSI spec must be an object");
    const manifest = assertExperimentManifest(await json(required(args, "--manifest")));
    const specBody: Record<string, unknown> = { ...(specValue as Record<string, unknown>), experiment: manifest };
    delete specBody.canonicalHash;
    if (specBody.campaignId !== manifest.campaignId) throw new Error("RSI spec/experiment campaignId mismatch");
    const bound = withExperimentHash(specBody);
    await output(required(args, "--output"), bound); console.log(JSON.stringify({ ok: true, specHash: bound.canonicalHash, manifestHash: manifest.canonicalHash }, null, 2)); return 0;
  }
  if (command === "experiment-init") {
    const result = await initializeExperimentStore(required(args, "--campaign-dir"), await json(required(args, "--manifest")));
    console.log(JSON.stringify({ ok: true, manifestHash: result.manifest.canonicalHash, indexHash: result.index.canonicalHash }, null, 2)); return 0;
  }
  if (command === "experiment-record") {
    const index = await appendExperimentRecord(required(args, "--campaign-dir"), await json(required(args, "--record")));
    console.log(JSON.stringify({ ok: true, recordCount: index.records.length, eventHeadHash: index.eventHeadHash, frozen: index.frozen }, null, 2)); return 0;
  }
  if (command === "experiment-feedback-render") {
    const policy = required(args, "--policy");
    if (policy !== "metric_only" && policy !== "structured_diagnostic") throw new Error("feedback policy must be metric_only or structured_diagnostic");
    const view = assertDeveloperFeedbackView(renderDeveloperFeedback(await json(required(args, "--evaluation")), policy));
    await output(required(args, "--output"), view); console.log(JSON.stringify({ ok: true, developerViewHash: view.canonicalHash, privateEvaluationHash: view.privateEvaluationHash }, null, 2)); return 0;
  }
  if (command === "experiment-batch-plan") {
    const batch = assertFiveCellBatch(createFiveCellBatch(await json(required(args, "--design"))));
    await output(required(args, "--output"), batch); console.log(JSON.stringify({ ok: true, campaignCount: batch.campaigns.length, batchHash: batch.canonicalHash }, null, 2)); return 0;
  }
  if (command === "experiment-history-import") {
    const artifactHash = await importShuffledHistory(required(args, "--campaign-dir"), await json(required(args, "--artifact")));
    console.log(JSON.stringify({ ok: true, artifactHash }, null, 2)); return 0;
  }
  if (command === "experiment-candidate-guard") {
    console.log(JSON.stringify(await verifyCandidateDiff(resolve(required(args, "--repo")), required(args, "--base"), required(args, "--candidate")), null, 2)); return 0;
  }
  if (command === "experiment-export") {
    const value = await exportCampaign(required(args, "--campaign-dir")); await output(required(args, "--output"), value); console.log(JSON.stringify({ ok: true, exportHash: value.canonicalHash }, null, 2)); return 0;
  }
  if (command === "experiment-verify") { console.log(JSON.stringify(await verifyExperimentStore(required(args, "--campaign-dir")), null, 2)); return 0; }
  throw new Error(`unknown experiment command: ${command}`);
}
