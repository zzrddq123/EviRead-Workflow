import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { exportZ86Predictions, extractModelCifCanonicalSequence, prepareZ86Inputs } from "./z86_bridge.js";

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function fixtureRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "z86-bridge-test-"));
}

function tinyCif(sequence = "(MET)(ALA)(GLY)"): string {
  return `_entity_poly.pdbx_seq_one_letter_code_can\n;${sequence}\n;\n`;
}

test("extractModelCifCanonicalSequence decodes ModelCIF parenthesized residues", () => {
  assert.equal(extractModelCifCanonicalSequence(tinyCif("(MET)(ALA)(HIS)(VAL)(UNK)")), "MAHVX");
});

test("extractModelCifCanonicalSequence prefers informative sequence blocks over all-X canonical blocks", () => {
  const source = [
    "_entity_poly.pdbx_seq_one_letter_code",
    "_entity_poly.pdbx_seq_one_letter_code_can",
    "1 polypeptide(L) no no A",
    ";(MET)(ALA)(GLY)",
    ";",
    ";XXX",
    ";",
    "#",
  ].join("\n");
  assert.equal(extractModelCifCanonicalSequence(source), "MAG");
});

test("prepareZ86Inputs writes anonymous FASTA and manifest from public structure resources", async () => {
  const root = await fixtureRoot();
  try {
    const benchmark = join(root, "benchmark");
    const structure = join(benchmark, "resources", "target_structures_simplefold", "group_4", "Z69T99999.cif");
    await write(structure, tinyCif());
    await write(join(benchmark, "resources", "target_structure_groups.tsv"), [
      "group\tgroupOrder\tproteinId\trelativePath\tsha256\tsequenceSha256",
      "group_4\t1\tZ69T99999\ttarget_structures_simplefold/group_4/Z69T99999.cif\tignored\t7a147e995516744443e1ffa5b1e52315f1ad02b1e76b6cf3ac6a80cc153bbc87",
      "",
    ].join("\n"));
    const output = join(root, "inputs");
    await prepareZ86Inputs(["--benchmark", benchmark, "--output-root", output, "--groups", "group_4", "--limit-per-group", "1"]);
    assert.equal(await readFile(join(output, "group_4", "Z69T99999", "sequence.fasta"), "utf8"), ">anonymous_query\nMAG\n");
    const manifest = JSON.parse(await readFile(join(output, "z86_inputs_manifest.json"), "utf8")) as Record<string, unknown>;
    assert.equal(manifest.targetCount, 1);
    assert.equal(typeof manifest.canonicalHash, "string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exportZ86Predictions writes canonical target_id/go_id/score rows from completed runs", async () => {
  const root = await fixtureRoot();
  try {
    const benchmark = join(root, "benchmark");
    await write(join(benchmark, "resources", "target_structure_groups.tsv"), [
      "group\tgroupOrder\tproteinId\trelativePath\tsha256\tsequenceSha256",
      "group_1\t1\tZ69T00001\tunused.cif\tignored\tignored",
      "group_1\t2\tZ69T00002\tunused.cif\tignored\tignored",
      "",
    ].join("\n"));
    const run = join(root, "runs", "Z69T00001");
    await write(join(run, "run_manifest.json"), JSON.stringify({ status: "completed", runId: "Z69T00001" }));
    await write(join(run, "prediction", "go_predictions.json"), JSON.stringify({
      schemaVersion: "pi-go-prediction.v3",
      identityPolicy: "strict_blind_v1",
      targetMode: "anonymous",
      queryAccession: null,
      terms: [
        { goId: "GO:0000001", decision: "transfer_hypothesis", preBudgetEligible: true, selected: true, fusionAdjustedScore: 0.4, phylogenyAdjustedScore: 0.2 },
        { goId: "GO:0000001", decision: "transfer_hypothesis", preBudgetEligible: true, selected: false, fusionAdjustedScore: 0.7 },
        { goId: "GO:0000002", decision: "transfer_hypothesis", preBudgetEligible: false, selected: false, fusionAdjustedScore: 0.9 },
      ],
    }));
    const predictions = join(root, "predictions");
    const receipt = join(root, "receipt.json");
    await exportZ86Predictions([
      "--benchmark", benchmark,
      "--runs-root", join(root, "runs"),
      "--predictions", predictions,
      "--receipt", receipt,
      "--groups", "group_1",
      "--allow-missing",
    ]);
    assert.equal(await readFile(join(predictions, "group_1.tsv"), "utf8"), "target_id\tgo_id\tscore\nZ69T00001\tGO:0000001\t0.700000000\n");
    const exported = JSON.parse(await readFile(receipt, "utf8")) as Record<string, unknown>;
    const groups = exported.groups as Array<Record<string, unknown>>;
    assert.equal(groups[0]!.completedRunCount, 1);
    assert.equal(groups[0]!.missingAbstentionCount, 1);
    assert.equal(typeof exported.canonicalHash, "string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
