import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { hashCanonical } from "./hash.js";
import { createTrainingReadTool, loadRsiDataSplitManifest } from "./data_split.js";

async function makeSplit(root: string, name: string, id: string, sequence: string) {
  const dir = join(root, name);
  await mkdir(join(dir, "gold"), { recursive: true });
  await writeFile(join(dir, "sequence.fasta"), `>${id}\n${sequence}\n`);
  await writeFile(join(dir, "gold", "annotations.txt"), "GO:0008150\n");
  await writeFile(join(dir, "proteins.json"), JSON.stringify({ proteins: [{ proteinId: id, sequence: "sequence.fasta", gold: "annotations.txt" }] }));
  const fileHashes: Record<string, string> = {};
  for (const file of [join(dir, "proteins.json"), join(dir, "sequence.fasta"), join(dir, "gold", "annotations.txt")]) fileHashes[file] = createHash("sha256").update(await readFile(file)).digest("hex");
  return { fileHashes, proteinsFile: join(dir, "proteins.json"), goldRoot: join(dir, "gold"), goldAccess: name === "training" ? "developer_allowed" as const : "evaluator_only" as const, ...(name === "test" ? { evaluationPhase: "after_freeze_only" as const } : name === "validation" ? { evaluationPhase: "after_freeze_only" as const } : {}) };
}

test("human-selected train/validation/test manifest is hash-bound and disjoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rsi-split-"));
  try {
    const body = {
      schemaVersion: "pi-rsi-data-split-manifest.v1" as const,
      splitId: "test-split",
      training: await makeSplit(root, "training", "train-1", "AAAA"),
      validation: await makeSplit(root, "validation", "valid-1", "CCCC"),
      test: await makeSplit(root, "test", "test-1", "GGGG"),
      partitionPolicy: { requireDisjointProteinIds: true, requireDisjointSequenceHashes: true },
    };
    const path = join(root, "split.json");
    await writeFile(path, JSON.stringify({ ...body, canonicalHash: hashCanonical(body) }));
    const loaded = await loadRsiDataSplitManifest(path);
    assert.equal(loaded.manifest.splitId, "test-split");
    assert.equal(loaded.training.manifestHash, hashCanonical(body));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("training_read is read-only and cannot reach validation/test or symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rsi-training-read-"));
  try {
    const body = {
      schemaVersion: "pi-rsi-data-split-manifest.v1" as const,
      splitId: "read-boundary",
      training: await makeSplit(root, "training", "train-1", "AAAA"),
      validation: await makeSplit(root, "validation", "valid-1", "CCCC"),
      test: await makeSplit(root, "test", "test-1", "GGGG"),
      partitionPolicy: { requireDisjointProteinIds: true, requireDisjointSequenceHashes: true },
    };
    const path = join(root, "split.json");
    await writeFile(path, JSON.stringify({ ...body, canonicalHash: hashCanonical(body) }));
    const loaded = await loadRsiDataSplitManifest(path);
    const tool = createTrainingReadTool(loaded.training);
    const result = await tool.execute("test", { path: "gold/annotations.txt" }, undefined, undefined, {} as any);
    assert.equal(result.content[0]?.type, "text");
    await assert.rejects(() => tool.execute("test", { path: "validation/annotations.txt" }, undefined, undefined, {} as any), /training_read path must be/);
    await assert.rejects(() => tool.execute("test", { path: "gold/../validation/annotations.txt" }, undefined, undefined, {} as any), /training_read path must be/);
    const outside = join(root, "outside.txt");
    await writeFile(outside, "not training Gold\n");
    await symlink(outside, join(root, "training", "gold", "escape.txt"));
    await assert.rejects(() => tool.execute("test", { path: "gold/escape.txt" }, undefined, undefined, {} as any), /escapes training resource/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("overlapping selected splits fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rsi-split-overlap-"));
  try {
    const train = await makeSplit(root, "training", "same", "AAAA");
    const validation = await makeSplit(root, "validation", "same", "AAAA");
    const test = await makeSplit(root, "test", "test-1", "GGGG");
    const body = { schemaVersion: "pi-rsi-data-split-manifest.v1" as const, splitId: "overlap", training: train, validation, test, partitionPolicy: { requireDisjointProteinIds: true, requireDisjointSequenceHashes: true } };
    await writeFile(join(root, "split.json"), JSON.stringify({ ...body, canonicalHash: hashCanonical(body) }));
    await assert.rejects(() => loadRsiDataSplitManifest(join(root, "split.json")), /protein ID overlap/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-rsi-split-regression-"));
  const body = { schemaVersion: "pi-rsi-data-split-manifest.v1" as const, splitId: "regression", training: await makeSplit(root, "training", "train", "AAAA"), validation: await makeSplit(root, "validation", "valid", "CCCC"), test: await makeSplit(root, "test", "test", "GGGG"), partitionPolicy: { requireDisjointProteinIds: true, requireDisjointSequenceHashes: true } };
  const path = join(root, "split.json");
  const seal = async () => writeFile(path, JSON.stringify({ ...body, canonicalHash: hashCanonical(body) }));
  await seal(); return { root, body, path, seal };
}

test("different FASTA identifiers and wrapping do not hide identical sequences", async () => {
  const f = await fixture();
  try {
    const file = join(f.root, "validation", "sequence.fasta");
    await writeFile(file, ">a different name\r\naa\r\naa\r\n");
    f.body.validation.fileHashes[file] = createHash("sha256").update(await readFile(file)).digest("hex"); await f.seal();
    await assert.rejects(loadRsiDataSplitManifest(f.path), /sequence overlap/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("content drift and unlisted neighboring labels cannot enter training_read", async () => {
  const f = await fixture();
  try {
    const loaded = await loadRsiDataSplitManifest(f.path), tool = createTrainingReadTool(loaded.training);
    await writeFile(join(f.root, "training", "validation-labels.txt"), "private labels");
    await assert.rejects(tool.execute("test", { path: "proteins/validation-labels.txt" }, undefined, undefined, {} as any), /inventory/);
    await writeFile(join(f.root, "training", "gold", "annotations.txt"), "GO:0003674\n");
    await assert.rejects(tool.execute("test", { path: "gold/annotations.txt" }, undefined, undefined, {} as any), /file hash mismatch/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("partition policies and held-out phases fail closed", async () => {
  const f = await fixture();
  try {
    f.body.partitionPolicy.requireDisjointSequenceHashes = false; await f.seal();
    await assert.rejects(loadRsiDataSplitManifest(f.path), /partitionPolicy/);
    f.body.partitionPolicy.requireDisjointSequenceHashes = true;
    Object.assign(f.body.validation, { evaluationPhase: "unknown_phase" }); await f.seal();
    await assert.rejects(loadRsiDataSplitManifest(f.path), /validation evaluationPhase/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("validation may supply RSI feedback but test remains frozen and evaluator-only", async () => {
  const f = await fixture();
  try {
    (f.body.validation as any).evaluationPhase = "during_rsi";
    await f.seal();
    const loaded = await loadRsiDataSplitManifest(f.path);
    assert.equal(loaded.manifest.validation.evaluationPhase, "during_rsi");
    assert.equal(loaded.manifest.validation.goldAccess, "evaluator_only");
    (f.body.test as any).evaluationPhase = "during_rsi";
    await f.seal();
    await assert.rejects(loadRsiDataSplitManifest(f.path), /test evaluationPhase is invalid/);
    f.body.test.evaluationPhase = "after_freeze_only";
    (f.body.validation as any).goldAccess = "developer_allowed";
    await f.seal();
    await assert.rejects(loadRsiDataSplitManifest(f.path), /validation Gold access is invalid/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
