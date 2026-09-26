import assert from "node:assert/strict";
import test from "node:test";

import {
  adjustByPhylogeny,
  collapseCorrelatedPhylogenySupports,
  DEFAULT_PHYLOGENY_POLICY,
  lineageOverlapFactor,
  normalizeOmaRelation,
  normalizeLineage,
  orderedLineageDiceOverlap,
  type PhylogenyEvidence,
} from "./phylogeny.js";

function evidence(overrides: Partial<PhylogenyEvidence> = {}): PhylogenyEvidence {
  return {
    schemaVersion: "pi-phylogeny-evidence.v1",
    provider: "OMA",
    providerRelease: "2026-01",
    providerPayloadSha256: "a".repeat(64),
    evidenceId: "ORTH-OMA-001",
    provenanceRoot: "OMA:HOG:001",
    targetTaxonId: 9606,
    targetLineage: ["Eukaryota", "Metazoa", "Chordata", "Mammalia", "Primates"],
    donorTaxonId: 10090,
    donorLineage: ["Eukaryota", "Metazoa", "Chordata", "Mammalia", "Rodentia"],
    relation: "one_to_one",
    evolutionaryDistance: 0.4,
    hogId: "HOG:001",
    queryLike: false,
    ...overrides,
  };
}

test("OMA relationship labels normalize into a closed auditable vocabulary", () => {
  assert.equal(normalizeOmaRelation("1:1"), "one_to_one");
  assert.equal(normalizeOmaRelation("1:n"), "one_to_many");
  assert.equal(normalizeOmaRelation("m:n"), "many_to_many");
  assert.equal(normalizeOmaRelation("post duplication paralog"), "post_duplication_paralog");
  assert.equal(normalizeOmaRelation("unknown"), "unresolved_ortholog");
});

test("lineage normalization removes provider formatting noise but only synthetic roots", () => {
  assert.deepEqual(
    normalizeLineage([" ROOT ", "  Eukaryota ", "cellular   organisms", "METAzoa", " Metazoa ", "Chordata"]),
    ["eukaryota", "metazoa", "chordata"],
  );
  assert.deepEqual(normalizeLineage(["Bacteria", "Terrabacteria group"]), ["bacteria", "terrabacteria group"]);
});

test("ordered lineage overlap ignores synthetic-root mismatch, case, whitespace, and duplicates", () => {
  const target = ["root", " Eukaryota", "Metazoa", "Chordata", "Chordata"];
  const donor = ["cellular organisms", "eukaryota ", "  metaZOA ", " chordata  "];
  assert.equal(orderedLineageDiceOverlap(target, donor), 1);
  assert.equal(lineageOverlapFactor(target, donor), 1);
});

test("ordered LCS rewards a sparse and dense same-clade lineage above a primate-versus-yeast donor", () => {
  const primate = ["Eukaryota", "Metazoa", "Chordata", "Mammalia", "Primates"];
  const densePrimate = [
    "cellular organisms", "Eukaryota", "Opisthokonta", "Metazoa", "Eumetazoa", "Bilateria",
    "Deuterostomia", "Chordata", "Vertebrata", "Mammalia", "Euarchontoglires", "Primates",
  ];
  const yeast = ["Eukaryota", "Opisthokonta", "Fungi", "Dikarya", "Ascomycota", "Saccharomycetes"];
  const sameClade = orderedLineageDiceOverlap(primate, densePrimate);
  const distant = orderedLineageDiceOverlap(primate, yeast);
  assert.ok(sameClade !== null && distant !== null && sameClade > distant);
  assert.ok(lineageOverlapFactor(primate, densePrimate) > lineageOverlapFactor(primate, yeast));
});

test("cross-domain lineages receive the configured floor and missing lineage remains unavailable-neutral", () => {
  assert.equal(orderedLineageDiceOverlap(["Bacteria", "Proteobacteria"], ["Eukaryota", "Metazoa"]), 0);
  assert.equal(
    lineageOverlapFactor(["Bacteria", "Proteobacteria"], ["Eukaryota", "Metazoa"]),
    DEFAULT_PHYLOGENY_POLICY.lineageFloor,
  );
  assert.equal(orderedLineageDiceOverlap([], ["Eukaryota"]), null);
  assert.equal(orderedLineageDiceOverlap(["root", "cellular organisms"], ["Eukaryota"]), null);
  assert.equal(lineageOverlapFactor([], ["Eukaryota"]), 1);
});

test("strict OMA lineage weighting short-circuits to one for the same positive TaxID", () => {
  const result = adjustByPhylogeny({
    aspect: "molecular_function",
    evidence: evidence({
      targetTaxonId: 9606,
      donorTaxonId: 9606,
      targetLineage: ["Eukaryota", "Metazoa", "Primates"],
      donorLineage: ["Bacteria", "Proteobacteria"],
      evolutionaryDistance: null,
    }),
  });
  assert.equal(result.lineageFactor, 1);
  assert.equal(result.combinedFactor, 1);
});

test("one-to-one ortholog outranks an otherwise identical paralog and BP decays more than MF", () => {
  const orthologMf = adjustByPhylogeny({ aspect: "molecular_function", evidence: evidence() });
  const orthologBp = adjustByPhylogeny({ aspect: "biological_process", evidence: evidence() });
  const paralog = adjustByPhylogeny({
    aspect: "molecular_function",
    evidence: evidence({ relation: "post_duplication_paralog" }),
  });
  assert.ok(orthologMf.combinedFactor > orthologBp.combinedFactor);
  assert.ok(orthologMf.combinedFactor > paralog.combinedFactor);
  assert.equal(paralog.leafTransferAllowed, false);
  assert.equal(DEFAULT_PHYLOGENY_POLICY.relationWeights.one_to_one, 1);
});

test("missing target TaxID abstains from phylogeny rather than guessing from a donor", () => {
  const result = adjustByPhylogeny({
    aspect: "molecular_function",
    evidence: evidence({ targetTaxonId: null, targetLineage: [] }),
  });
  assert.equal(result.status, "unavailable_target_taxon");
  assert.equal(result.combinedFactor, 1);
  assert.equal(result.leafTransferAllowed, false);
  assert.match(result.reasons.join(" "), /not guessed/);
});

test("query-like OMA anchor and taxon-forbidden terms fail closed", () => {
  const anchor = adjustByPhylogeny({ aspect: "molecular_function", evidence: evidence({ queryLike: true }) });
  const forbidden = adjustByPhylogeny({
    aspect: "molecular_function",
    evidence: evidence(),
    targetLineageTaxonIds: [2759, 33208, 9606],
    constraint: { status: "available", neverInTaxonIds: [9606], onlyInTaxonIds: [] },
  });
  assert.equal(anchor.status, "quarantined");
  assert.equal(anchor.combinedFactor, 0);
  assert.equal(forbidden.status, "taxon_forbidden");
  assert.equal(forbidden.combinedFactor, 0);
});

test("related donors collapse to one clade contribution", () => {
  const supports = [
    { id: "a", clade: "HOG1|mammal", score: 0.7 },
    { id: "b", clade: "HOG1|mammal", score: 0.9 },
    { id: "c", clade: "HOG1|fish", score: 0.6 },
  ];
  const collapsed = collapseCorrelatedPhylogenySupports(supports, (item) => item.score, (item) => item.clade);
  assert.deepEqual(collapsed.map((item) => item.id), ["b", "c"]);
});
