import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadReadArtifact, mergeReadBundle } from "./eviread_read.js";

const artifact = {
  schema: "biolm-evidence.v1",
  sequence_sha256: "query-hash",
  models: [
    { model: "esm2", observation_scope: "sequence_crop", neighbors: [{ id: "donor-a", cosine: 0.8 }], predictions: [{ go_id: "GO:0000001", aspect: "MF", score: 0.7 }] },
    { model: "esmc", observation_scope: "whole_protein", neighbors: [{ id: "donor-a", cosine: 0.75 }], predictions: [{ go_id: "GO:0000001", aspect: "MF", score: 0.6 }] },
    { model: "protrek", observation_scope: "whole_protein", neighbors: [], predictions: [] },
  ],
  candidates: [{ go_id: "GO:0000001", aspect: "MF", score: 0.7, source_id: "esm2", evidence_id: "e1", provenance_root: "p1" }],
  limitations: ["shared donor annotations are correlated"],
};

test("EviRead renders and attaches model evidence without inventing GO rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "eviread-read-"));
  const path = join(root, "biolm.json");
  await writeFile(path, `${JSON.stringify(artifact)}\n`);
  const read = await loadReadArtifact({ artifactPath: path, expectedSequenceSha256: "query-hash", runDir: root });
  assert.match(read.text, /ESM2|esm2/);
  assert.match(read.text, /GO:0000001/);
  const merged = mergeReadBundle({ evidence_ids: ["fixed"] }, read.bundle);
  const sources = merged.candidate_sources as Record<string, unknown>;
  assert.equal((sources.go_candidates as unknown[]).length, 1);
  assert.ok(String(merged.eviread_read_text).includes("Similarity"));
  assert.match(await readFile(join(root, "evidence", "eviread_read.txt"), "utf8"), /GO:0000001/);
});

test("EviRead rejects a mismatched query artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "eviread-read-mismatch-"));
  const path = join(root, "biolm.json");
  await writeFile(path, `${JSON.stringify(artifact)}\n`);
  await assert.rejects(
    loadReadArtifact({ artifactPath: path, expectedSequenceSha256: "other-query" }),
    /sequence hash does not match/,
  );
});
