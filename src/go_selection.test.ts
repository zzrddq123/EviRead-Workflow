import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { validateGenome } from "./genome.js";
import { applyGOSelection } from "./go_selection.js";
import type { GODonorSupport, GOTermPrediction } from "./types.js";

function support(id: string): GODonorSupport {
  return {
    accession: `DONOR-${id}`,
    donorGroup: `group-${id}`,
    proteinName: "fixture donor",
    organism: "fixture organism",
    taxonId: 9606,
    annotationEvidenceId: `ANN-${id}`,
    matchEvidenceIds: [`SEQ-${id}`],
    matchMode: "sequence",
    similarityScore: 0.8,
    evidenceCode: "EXP",
    provenanceRoots: [`root-${id}`],
    evidenceWeight: 1,
    structureQualityFactor: 1,
    lineageFactor: 1,
    lineageStatus: "unavailable",
    rawSupport: 0.8,
    adjustedSupport: 0.8,
  };
}

function term(input: {
  goId: string;
  score: number;
  origin: "direct_annotation" | "ontology_ancestor";
  eligible: boolean;
  sourceGoIds?: string[];
  blockers?: GOTermPrediction["selectionBlockers"];
}): GOTermPrediction {
  return {
    goId: input.goId,
    termName: `term ${input.goId}`,
    aspect: "biological_process",
    decision: input.eligible ? "transfer_hypothesis" : "abstained",
    selected: input.eligible,
    preBudgetEligible: input.eligible,
    selectionRole: "not_selected",
    selectionRank: null,
    rawScore: input.score,
    phylogenyAdjustedScore: input.score,
    calibrationStatus: "unavailable",
    confidenceLabel: input.eligible ? "low_heuristic" : "abstained",
    evidenceCode: "EXP",
    donorSupports: [support(input.goId)],
    evidenceIds: [`ANN-${input.goId}`, `SEQ-${input.goId}`],
    reasons: [],
    selectionBlockers: input.blockers ?? (input.eligible ? [] : ["below_threshold"]),
    candidateOrigin: input.origin,
    ...(input.sourceGoIds ? { sourceGoIds: input.sourceGoIds, ontologyDepth: 1 } : {}),
  };
}

function summarize(terms: GOTermPrediction[]): Array<Record<string, unknown>> {
  return [...terms]
    .sort((left, right) => left.goId.localeCompare(right.goId))
    .map((item) => ({
      goId: item.goId,
      selected: item.selected,
      role: item.selectionRole,
      rank: item.selectionRank,
      blockers: item.selectionBlockers,
    }));
}

test("evidence frontier budgets direct hypotheses and emits only their entailed ancestor closure", () => {
  const first = term({ goId: "GO:4000001", score: 0.8, origin: "direct_annotation", eligible: true });
  const second = term({ goId: "GO:4000002", score: 0.7, origin: "direct_annotation", eligible: true });
  const firstAncestor = term({
    goId: "GO:4000011",
    score: 0.6,
    origin: "ontology_ancestor",
    eligible: false,
    sourceGoIds: [first.goId],
  });
  const secondAncestor = term({
    goId: "GO:4000012",
    score: 0.65,
    origin: "ontology_ancestor",
    eligible: true,
    sourceGoIds: [second.goId],
  });
  const terms = [secondAncestor, second, firstAncestor, first];
  applyGOSelection({ terms, mode: "evidence_frontier_v1", maxSelectedTermsPerAspect: 1, phase: "pre_judge" });

  assert.equal(first.selected, true);
  assert.equal(first.selectionRole, "primary_direct");
  assert.equal(first.selectionRank, 1);
  assert.equal(second.selected, false);
  assert.equal(second.selectionRank, 2);
  assert.ok(second.selectionBlockers?.includes("per_aspect_budget"));
  assert.equal(firstAncestor.selected, true, "safe closure is entailed even when the decayed ancestor score is below threshold");
  assert.equal(firstAncestor.selectionRole, "entailed_ancestor");
  assert.equal(firstAncestor.selectionRank, null);
  assert.equal(secondAncestor.selected, false);
  assert.ok(secondAncestor.selectionBlockers?.includes("source_hypothesis_not_selected"));
});

test("frontier selection is permutation-stable and cannot relax hard host gates", () => {
  const direct = term({ goId: "GO:5000001", score: 0.8, origin: "direct_annotation", eligible: true });
  const blockedAncestor = term({
    goId: "GO:5000002",
    score: 0.7,
    origin: "ontology_ancestor",
    eligible: false,
    sourceGoIds: [direct.goId],
    blockers: ["candidate_provider_floor"],
  });
  const input = [direct, blockedAncestor];
  const one = structuredClone(input);
  const two = structuredClone(input).reverse();
  applyGOSelection({ terms: one, mode: "evidence_frontier_v1", maxSelectedTermsPerAspect: 1, phase: "pre_judge" });
  applyGOSelection({ terms: two, mode: "evidence_frontier_v1", maxSelectedTermsPerAspect: 1, phase: "pre_judge" });
  assert.deepEqual(summarize(one), summarize(two));
  assert.equal(one.find((item) => item.goId === blockedAncestor.goId)?.selected, false);
});

test("disabled selector preserves the legacy fixed cap across direct and ancestor terms", () => {
  const direct = term({ goId: "GO:6000001", score: 0.8, origin: "direct_annotation", eligible: true });
  const higherAncestor = term({
    goId: "GO:6000002",
    score: 0.9,
    origin: "ontology_ancestor",
    eligible: true,
    sourceGoIds: [direct.goId],
  });
  const terms = [direct, higherAncestor];
  applyGOSelection({ terms, mode: "disabled", maxSelectedTermsPerAspect: 1, phase: "pre_judge" });
  assert.equal(higherAncestor.selected, true);
  assert.equal(direct.selected, false);
  assert.ok(direct.selectionBlockers?.includes("per_aspect_budget"));
});

test("aspect-scoped frontier changes BP while preserving the legacy selector for MF and CC", () => {
  const bpDirect = term({ goId: "GO:6100001", score: 0.8, origin: "direct_annotation", eligible: true });
  const bpAncestor = term({
    goId: "GO:6100002",
    score: 0.9,
    origin: "ontology_ancestor",
    eligible: true,
    sourceGoIds: [bpDirect.goId],
  });
  const ccDirect = term({ goId: "GO:6100003", score: 0.8, origin: "direct_annotation", eligible: true });
  const ccAncestor = term({
    goId: "GO:6100004",
    score: 0.9,
    origin: "ontology_ancestor",
    eligible: true,
    sourceGoIds: [ccDirect.goId],
  });
  ccDirect.aspect = "cellular_component";
  ccAncestor.aspect = "cellular_component";
  applyGOSelection({
    terms: [bpAncestor, bpDirect, ccAncestor, ccDirect],
    mode: "evidence_frontier_v1",
    frontierAspects: ["biological_process"],
    maxSelectedTermsPerAspect: 1,
    phase: "pre_judge",
  });
  assert.equal(bpDirect.selected, true, "BP spends its budget on the direct hypothesis");
  assert.equal(bpAncestor.selected, true, "the entailed BP ancestor does not spend the direct budget");
  assert.equal(ccAncestor.selected, true, "CC retains legacy score-ranked behavior");
  assert.equal(ccDirect.selected, false);
});

test("genome validation accepts only the closed evidence-frontier policy enum", async () => {
  const raw = JSON.parse(await readFile(join(process.cwd(), "test", "fixtures", "genomes", "bootstrap-v0.json"), "utf8")) as Record<string, unknown>;
  const goPolicy = (raw.goPolicy ?? {}) as Record<string, unknown>;
  goPolicy.selectionPolicy = { mode: "evidence_frontier_v1" };
  assert.equal(validateGenome(raw).goPolicy.selectionPolicy?.mode, "evidence_frontier_v1");
  goPolicy.selectionPolicy = { mode: "evidence_frontier_v1", aspects: ["biological_process"] };
  assert.deepEqual(validateGenome(raw).goPolicy.selectionPolicy?.aspects, ["biological_process"]);
  goPolicy.selectionPolicy = { mode: "disabled", aspects: ["biological_process"] };
  assert.throws(() => validateGenome(raw), /selectionPolicy\.aspects/);
  goPolicy.selectionPolicy = { mode: "unbounded" };
  assert.throws(() => validateGenome(raw), /selectionPolicy\.mode/);
});

test("selector derives legacy eligibility when audit fields are absent and rejects unknown modes", () => {
  const legacy = term({ goId: "GO:7000001", score: 0.8, origin: "direct_annotation", eligible: true });
  delete legacy.preBudgetEligible;
  applyGOSelection({ terms: [legacy], maxSelectedTermsPerAspect: 1, phase: "pre_judge" });
  assert.equal(legacy.selected, true);
  assert.equal(legacy.preBudgetEligible, true);
  assert.throws(() => applyGOSelection({
    terms: [legacy],
    mode: "unknown" as "disabled",
    maxSelectedTermsPerAspect: 1,
    phase: "pre_judge",
  }), /Unsupported GO selection mode/);
});
