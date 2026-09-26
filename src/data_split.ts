import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hashCanonical } from "./hash.js";

export interface RsiDataSplit {
  proteinsFile: string;
  goldRoot: string;
  goldAccess: "developer_allowed" | "evaluator_only";
  evaluationPhase?: "during_rsi" | "after_freeze_only";
  /** SHA-256 of every explicitly referenced file, keyed by canonical absolute path. */
  fileHashes: Record<string, string>;
}
export interface RsiDataSplitManifest {
  schemaVersion: "pi-rsi-data-split-manifest.v1";
  splitId: string;
  benchmarkId?: string;
  training: RsiDataSplit;
  validation: RsiDataSplit;
  test?: RsiDataSplit;
  partitionPolicy: {
    requireDisjointProteinIds: boolean;
    requireDisjointSequenceHashes: boolean;
    requireDisjointStructureHashes?: boolean;
  };
  canonicalHash: string;
}
export interface TrainingBinding {
  manifestPath: string;
  manifestHash: string;
  proteinsFile: string;
  goldRoot: string;
}
const HASH = /^[a-f0-9]{64}$/;
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} has unknown keys`);
}
function inside(path: string, parent: string): boolean {
  const p = relative(parent, path);
  return p === "" || (!isAbsolute(p) && p !== ".." && !p.startsWith(`..${sep}`));
}
function sha256(data: Buffer | string): string { return createHash("sha256").update(data).digest("hex"); }
/** Compare residues, not FASTA headers, wrapping, whitespace, or letter case. */
export function normalizedSequence(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  if (lines.filter(line => line.startsWith(">")).length !== 1 || !lines[0]?.startsWith(">")) throw new Error("sequence file must contain exactly one FASTA record");
  const sequence = lines.slice(1).join("").replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z*]+$/.test(sequence)) throw new Error("FASTA sequence is empty or invalid");
  return sequence;
}

/** Verify both the human-selected partition and its immutable file inventory. */
export async function loadRsiDataSplitManifest(path: string): Promise<{ manifest: RsiDataSplitManifest; training: TrainingBinding }> {
  if (!isAbsolute(path)) throw new Error("data split manifest path must be absolute");
  const manifestPath = await realpath(path);
  const raw = object(JSON.parse(await readFile(manifestPath, "utf8")), "data split manifest");
  keys(raw, ["schemaVersion", "splitId", "benchmarkId", "training", "validation", "test", "partitionPolicy", "canonicalHash"], "manifest");
  if (raw.schemaVersion !== "pi-rsi-data-split-manifest.v1") throw new Error("unsupported data split manifest schemaVersion");
  if (typeof raw.splitId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(raw.splitId)) throw new Error("invalid splitId");
  if (raw.benchmarkId !== undefined && typeof raw.benchmarkId !== "string") throw new Error("invalid benchmarkId");
  const claimed = String(raw.canonicalHash ?? ""), body = { ...raw }; delete body.canonicalHash;
  if (!HASH.test(claimed) || claimed !== hashCanonical(body)) throw new Error("data split manifest canonicalHash mismatch");
  const policy = object(raw.partitionPolicy, "partitionPolicy");
  keys(policy, ["requireDisjointProteinIds", "requireDisjointSequenceHashes", "requireDisjointStructureHashes"], "partitionPolicy");
  if (policy.requireDisjointProteinIds !== true || policy.requireDisjointSequenceHashes !== true || (policy.requireDisjointStructureHashes !== undefined && typeof policy.requireDisjointStructureHashes !== "boolean")) throw new Error("partitionPolicy must require disjoint protein IDs and sequences");
  const manifest = raw as unknown as RsiDataSplitManifest;
  const inventories: Record<string, Set<string>> = {};
  const cases: Record<string, Array<{ id: string; sequenceHash: string; structureHash?: string }>> = {};
  for (const label of ["training", "validation", ...(raw.test === undefined ? [] : ["test" as const])] as const) {
    const item = object(raw[label], label);
    keys(item, ["proteinsFile", "goldRoot", "goldAccess", "evaluationPhase", "fileHashes"], label);
    for (const key of ["proteinsFile", "goldRoot"] as const) {
      if (typeof item[key] !== "string" || !isAbsolute(item[key]) || await realpath(item[key]) !== item[key]) throw new Error(`${label}.${key} must be a canonical absolute path`);
    }
    if (!(await stat(item.goldRoot as string)).isDirectory()) throw new Error(`${label}.goldRoot must be a directory`);
    if (item.goldAccess !== (label === "training" ? "developer_allowed" : "evaluator_only")) throw new Error(`${label} Gold access is invalid`);
    if (label === "training" ? item.evaluationPhase !== undefined : label === "validation" ? !["during_rsi", "after_freeze_only"].includes(String(item.evaluationPhase)) : item.evaluationPhase !== "after_freeze_only") throw new Error(`${label} evaluationPhase is invalid`);
    const hashes = object(item.fileHashes, `${label}.fileHashes`);
    const inventory = inventories[label] = new Set<string>();
    const read = async (value: unknown, base: string, gold = false): Promise<Buffer> => {
      if (typeof value !== "string" || !value) throw new Error(`${label}: missing file path`);
      const file = await realpath(resolve(base, value));
      if (gold && !inside(file, item.goldRoot as string)) throw new Error(`${label}: Gold path escapes goldRoot`);
      if (!(await stat(file)).isFile()) throw new Error(`${label}: expected a regular file`);
      const bytes = await readFile(file);
      if (typeof hashes[file] !== "string" || !HASH.test(hashes[file]) || hashes[file] !== sha256(bytes)) throw new Error(`${label}: file hash mismatch or missing inventory entry`);
      inventory.add(file); return bytes;
    };
    const proteinsPath = item.proteinsFile as string;
    const parsed: unknown = JSON.parse((await read(proteinsPath, dirname(proteinsPath))).toString("utf8"));
    const rows = Array.isArray(parsed) ? parsed : object(parsed, `${label} proteinsFile`).proteins;
    if (!Array.isArray(rows) || !rows.length) throw new Error(`${label}.proteinsFile must contain a non-empty JSON proteins array`);
    cases[label] = [];
    for (const value of rows) {
      const row = object(value, `${label} protein`), id = row.proteinId;
      if (typeof id !== "string" || !id.trim()) throw new Error(`${label}: proteinId is required`);
      const sequence = normalizedSequence((await read(row.sequence, dirname(proteinsPath))).toString("utf8"));
      const structureHash = row.structure == null ? undefined : sha256(await read(row.structure, dirname(proteinsPath)));
      await read(row.gold ?? row.goldGoIds, item.goldRoot as string, true);
      cases[label]!.push({ id, sequenceHash: sha256(sequence), ...(structureHash ? { structureHash } : {}) });
    }
    if (Object.keys(hashes).length !== inventory.size || Object.keys(hashes).some(file => !inventory.has(file))) throw new Error(`${label}: file inventory contains unreferenced files`);
    if (new Set(cases[label]!.map(row => row.id)).size !== rows.length) throw new Error(`duplicate protein ID within ${label}`);
  }
  for (const [a, b] of [["training", "validation"], ...(raw.test === undefined ? [] : [["training", "test"], ["validation", "test"]] as const)] as const) {
    for (const key of ["id", "sequenceHash", ...(policy.requireDisjointStructureHashes ? ["structureHash" as const] : [])] as const) {
      const values = new Set(cases[a]!.map(row => row[key]).filter(Boolean));
      if (cases[b]!.some(row => row[key] && values.has(row[key]))) throw new Error(`${key === "id" ? "protein ID" : key === "sequenceHash" ? "sequence" : "structure"} overlap between ${a} and ${b}`);
    }
    // An exact training inventory must never authorize a held-out input/Gold file.
    if ([...inventories[a]!].some(file => inventories[b]!.has(file))) throw new Error(`file overlap between ${a} and ${b}`);
  }
  if (manifest.test === undefined) delete (manifest as unknown as Record<string, unknown>).test;
  return { manifest, training: { manifestPath, manifestHash: claimed, proteinsFile: manifest.training.proteinsFile, goldRoot: manifest.training.goldRoot } };
}

export function createTrainingReadTool(binding: TrainingBinding) {
  const Parameters = Type.Object({ path: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false });
  return defineTool({
    name: "training_read", label: "Read Training Resource",
    description: "Read only files explicitly listed in the frozen training inventory. Start with proteins-file; then use proteins/<relative-path> or gold/<relative-path>. For absolute row paths, use proteins/<absolute-path> or gold/<absolute-path>. Validation/test files are never authorized. Training Gold is for general method development; guard against overfitting.",
    parameters: Parameters,
    async execute(_id, params) {
      const virtual = params.path.replaceAll("\\", "/");
      const direct = virtual === "proteins-file";
      const root = virtual.startsWith("gold/") ? binding.goldRoot : virtual.startsWith("proteins/") || direct ? dirname(binding.proteinsFile) : undefined;
      const suffix = direct ? binding.proteinsFile : virtual.slice(virtual.indexOf("/") + 1);
      if (!root || !suffix || suffix.split("/").includes("..")) throw new Error("training_read path must be proteins-file, proteins/<path>, or gold/<path>");
      const loaded = await loadRsiDataSplitManifest(binding.manifestPath);
      if (hashCanonical(loaded.training) !== hashCanonical(binding)) throw new Error("training resource binding changed");
      const resolved = await realpath(resolve(root, suffix));
      const expected = loaded.manifest.training.fileHashes[resolved];
      if (!expected) throw new Error("training_read path escapes training resource inventory");
      if ((await stat(resolved)).size > 200_000) throw new Error("training_read file exceeds 200000 bytes");
      const bytes = await readFile(resolved);
      if (sha256(bytes) !== expected) throw new Error("training_read file changed after binding");
      return { content: [{ type: "text" as const, text: bytes.toString("utf8") }], details: { path: virtual, sha256: expected } };
    },
  });
}

/** Worker configs and campaign provenance must name exactly the same partition. */
export async function verifyRsiDataSplitBinding(value: unknown, expectedHash?: string): Promise<void> {
  if (value === undefined) {
    if (expectedHash !== undefined) throw new Error("campaign requires its data split binding");
    return;
  }
  const binding = object(value, "dataSplit");
  keys(binding, ["manifestPath", "manifestHash", "training", "validation", "test"], "dataSplit");
  if (typeof binding.manifestPath !== "string") throw new Error("dataSplit manifestPath is required");
  const loaded = await loadRsiDataSplitManifest(binding.manifestPath);
  if (binding.manifestHash !== loaded.manifest.canonicalHash || (expectedHash !== undefined && binding.manifestHash !== expectedHash)) throw new Error("data split manifest hash changed after worker configuration");
  if (hashCanonical(binding.training) !== hashCanonical(loaded.training)
    || hashCanonical(binding.validation) !== hashCanonical(loaded.manifest.validation)
    || (binding.test !== undefined && (!loaded.manifest.test || hashCanonical(binding.test) !== hashCanonical(loaded.manifest.test)))) throw new Error("data split binding does not match the manifest");
}
