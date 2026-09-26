import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceNarrativeDisclosures,
  narrativeDisclosureProblems,
  narrativeEvidenceView,
  narrativeGoView,
  requiredNarrativeDisclosures,
} from "./agents.js";
import type { FunctionPrediction, GOPredictionSet } from "./types.js";

function prediction(): FunctionPrediction {
  return {
    proteinId: "ANON_TEST",
    mostLikelyFunction: "test family protein",
    functionalDescription: "test",
    confidence: "low",
    confidenceRationale: "test",
    keyEvidence: [{ evidenceId: "SEQ-01", supports: "test" }],
    alternatives: [],
    conflictingEvidence: [],
    limitations: Array.from({ length: 10 }, (_, index) => `original limitation ${index + 1}`),
    recommendedExperiments: ["discarded experiment"],
  };
}

const go = {
  queryTaxonId: null,
  queryLineage: [],
  taxonConstraintStatus: "not_evaluated",
  terms: [],
} as unknown as GOPredictionSet;

const evidence = {
  blind_view: { query_like_records_removed: 1 },
  domain_segments: [{ source: "merizo" }, { source: "chainsaw" }],
};

test("deterministic narrative guard inserts bounded strict-blind, GO, taxon, and correlation disclosures", () => {
  const required = requiredNarrativeDisclosures(evidence, go);
  assert.equal(required.length, 4);
  assert.match(required[0], /identity is not available to this narrative/);
  assert.match(required[1], /no GO terms were selected and every listed term was abstained/);
  const guarded = enforceNarrativeDisclosures(prediction(), evidence, go);
  assert.equal(guarded.limitations.length, 10);
  assert.deepEqual(guarded.limitations.slice(0, 4), required);
  assert.deepEqual(guarded.recommendedExperiments, []);
  assert.deepEqual(narrativeDisclosureProblems(guarded, evidence, go), []);
  assert.equal(narrativeDisclosureProblems(prediction(), evidence, go).length, 4);
});

test("taxonomy disclosure distinguishes available lineage from an unevaluated constraint file", () => {
  const provided = {
    ...go,
    queryTaxonId: 9606,
    queryLineage: ["Eukaryota", "Metazoa", "Homo sapiens"],
  } as GOPredictionSet;
  const disclosure = requiredNarrativeDisclosures({ blind_view: {} }, provided)
    .find((item) => item.startsWith("Taxonomy disclosure:"));
  assert.match(disclosure ?? "", /TaxID 9606.*lineage were available/);
  assert.doesNotMatch(disclosure ?? "", /taxon\/lineage is unavailable/);
});

test("narrative views preserve every selected citation while bounding large GO and evidence surfaces", () => {
  const largeGo = {
    schemaVersion: "fixture",
    canonicalHash: "a".repeat(64),
    proteinId: "ANON_TEST",
    predictedGoIds: ["GO:0000001"],
    terms: [
      {
        goId: "GO:0000001", termName: "selected", aspect: "molecular_function", selected: true,
        rawScore: 0.9, evidenceIds: ["ANN-999", "STR-499", "CAND-999"],
        donorSupports: [{ annotationEvidenceId: "ANN-999", matchEvidenceIds: ["STR-499"] }],
      },
      ...Array.from({ length: 900 }, (_, index) => ({
        goId: `GO:${String(index + 100).padStart(7, "0")}`,
        termName: `abstained ${index}`,
        aspect: "biological_process",
        selected: false,
        rawScore: 0.8 - index / 2000,
        evidenceIds: [`SEQ-${index}`],
      })),
    ],
  } as unknown as GOPredictionSet;
  const largeEvidence = {
    schema_version: "fixture",
    protein: { protein_id: "ANON_TEST" },
    blind_view: { query_like_records_removed: 1 },
    domain_segments: [],
    sequence_hits: Array.from({ length: 200 }, (_, index) => ({ evidence_id: `SEQ-${index}`, rank: index })),
    structure_hits: Array.from({ length: 500 }, (_, index) => ({ evidence_id: `STR-${index}`, rank: index, _target_sequence: "A".repeat(2000) })),
    uniprot_annotations: Array.from({ length: 1000 }, (_, index) => ({ evidence_id: `ANN-${index}`, function: `function ${index}`, go_terms: [] })),
    pdb_annotations: [],
    intrinsic_evidence: [],
    limitations: [],
    candidate_sources: {
      providers: [{ provider: "OMA", status: "completed" }],
      go_candidates: Array.from({ length: 1000 }, (_, index) => ({ evidence_id: `CAND-${index}`, go_id: "GO:0000001" })),
    },
  };
  const goView = narrativeGoView(largeGo);
  const evidenceView = narrativeEvidenceView(largeEvidence, largeGo);
  assert.equal((goView.selectedTerms as unknown[]).length, 1);
  assert.equal((goView.leadingAbstentions as unknown[]).length, 18);
  assert.equal(goView.omittedAbstentionCount, 882);
  assert.ok((evidenceView.citable_evidence_ids as string[]).includes("ANN-999"));
  assert.ok((evidenceView.citable_evidence_ids as string[]).includes("STR-499"));
  assert.ok((evidenceView.citable_evidence_ids as string[]).includes("CAND-999"));
  assert.ok(JSON.stringify(evidenceView).length < 200_000);
  assert.ok(JSON.stringify(goView).length < 100_000);
  assert.doesNotMatch(JSON.stringify(evidenceView), /_target_sequence/);
});

test("taxonomy disclosure labels frozen donor consensus as coarse rather than unavailable", () => {
  const inferred = {
    ...go,
    queryTaxonId: null,
    queryLineage: ["cellular organisms", "Eukaryota"],
  } as GOPredictionSet;
  const disclosure = requiredNarrativeDisclosures({ blind_view: {} }, inferred)
    .find((item) => item.startsWith("Taxonomy disclosure:"));
  assert.match(disclosure ?? "", /frozen-donor consensus.*coarse lineage/);
  assert.match(disclosure ?? "", /no exact query TaxID/);
  assert.doesNotMatch(disclosure ?? "", /taxon\/lineage is unavailable/);
});
