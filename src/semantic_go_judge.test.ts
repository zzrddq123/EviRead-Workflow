import assert from "node:assert/strict";
import test from "node:test";

import {
  applySemanticGOJudgeResult,
  buildSemanticGOJudgeBinding,
  renderSemanticPredictionTsv,
  runSemanticGOJudge,
  semanticPredictionRows,
} from "./semantic_go_judge.js";
import type { GOPredictionSet } from "./types.js";

function prediction(): GOPredictionSet {
  return {
    schemaVersion: "pi-go-prediction.v3",
    proteinId: "ANON_TEST",
    targetMode: "anonymous",
    identityPolicy: "strict_blind_v1",
    queryAccession: null,
    queryLikeAccessions: [],
    explicitlyExcludedAccessions: [],
    queryTaxonId: null,
    queryLineage: [],
    targetContext: { taxon: { taxonId: null, provenance: "unavailable" }, phylogeny: { mode: "optional", status: "unavailable_missing_taxon" } },
    genomeId: "test",
    genomeHash: "hash",
    methodId: "test",
    methodSummary: "test",
    calibrationStatus: "unavailable",
    dagProjectionStatus: "ancestor_closure_applied",
    candidateSources: { bundleHash: "hash", providers: [], candidateCount: 0, appliedCandidateCount: 0 },
    phylogenyStatus: { mode: "disabled", targetTaxonStatus: "unavailable", evidenceCount: 0, appliedCount: 0, quarantinedCount: 0 },
    taxonConstraintStatus: "not_evaluated",
    thresholds: { molecular_function: 0.1, biological_process: 0.1, cellular_component: 0.1 },
    quarantinedGoIds: [],
    predictedGoIds: [],
    terms: [{
      goId: "GO:0000001",
      termName: "example activity",
      aspect: "molecular_function",
      decision: "transfer_hypothesis",
      selected: true,
      rawScore: 0.5,
      phylogenyAdjustedScore: 0.5,
      preBudgetEligible: true,
      selectionRole: "primary_direct",
      selectionRank: 1,
      calibrationStatus: "unavailable",
      confidenceLabel: "low_heuristic",
      evidenceCode: "IDA",
      evidenceIds: ["ANN-1", "SEQ-1"],
      reasons: [],
      candidateOrigin: "direct_annotation",
      donorSupports: [{
        accession: "P1",
        donorGroup: "group",
        proteinName: "Example protein",
        organism: "Example organism",
        taxonId: null,
        annotationEvidenceId: "ANN-1",
        matchEvidenceIds: ["SEQ-1"],
        matchMode: "sequence",
        similarityScore: 0.8,
        evidenceCode: "IDA",
        provenanceRoots: ["PMID:1"],
        evidenceWeight: 1,
        structureQualityFactor: 1,
        lineageFactor: 1,
        lineageStatus: "unavailable",
        rawSupport: 0.8,
        adjustedSupport: 0.8,
      }],
    }],
    canonicalHash: "hash",
    limitations: [],
  };
}

test("semantic judge builds an anonymous allowlist and scores accepted direct terms", () => {
  const binding = buildSemanticGOJudgeBinding({
    prediction: prediction(),
    blindEvidenceBundle: {
      protein: { sequence_length: 100, structure_available: true, query_lineage: ["Eukaryota"] },
      sequence_hits: [{ evidence_id: "SEQ-1", description: "Example protein", organism: "Example organism", percent_identity: 80, query_coverage: 1 }],
      structure_hits: [],
      uniprot_annotations: [{ accession: "P1", protein_name: "Example protein", organism: "Example organism", function: ["Catalyzes an example reaction."], keywords: ["Enzyme"] }],
    },
    ontologySnapshot: { terms: [{ id: "GO:0000001", name: "example activity", parents: [] }] },
  });
  const card = binding.view.candidatesByAspect.molecular_function[0];
  assert.equal(card.hypothesisName, "example activity");
  assert.equal(JSON.stringify(binding.view).includes("GO:0000001"), false);
  const rows = semanticPredictionRows({
    targetId: "T1",
    binding,
    result: {
      schemaVersion: "pi-semantic-go-judge-result.v1",
      viewHash: binding.view.viewHash,
      modeUsed: "pi",
      accepted: [{ candidateToken: card.candidateToken, confidence: "high", citedEvidenceIds: ["ANN-1"], rationale: "Curated catalytic evidence." }],
      rejected: [],
      audit: { modelProvider: "test", modelId: "test", thinkingLevel: "none", inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    },
  });
  assert.deepEqual(rows, [{ targetId: "T1", goId: "GO:0000001", score: 0.88, status: "accepted" }]);
});

test("mainline adapter preserves exact r08 scores and retains only accepted direct terms plus closure", () => {
  const source = prediction();
  source.selectionPolicyMode = "evidence_frontier_v1";
  const second = structuredClone(source.terms[0]);
  second.goId = "GO:0000002";
  second.termName = "second activity";
  second.phylogenyAdjustedScore = 0.25;
  second.rawScore = 0.25;
  second.selectionRank = 2;
  const ancestor = structuredClone(source.terms[0]);
  ancestor.goId = "GO:0000003";
  ancestor.termName = "ancestor activity";
  ancestor.candidateOrigin = "ontology_ancestor";
  ancestor.sourceGoIds = ["GO:0000001"];
  ancestor.ontologyDepth = 1;
  ancestor.preBudgetEligible = false;
  ancestor.selectionRole = "entailed_ancestor";
  ancestor.selectionRank = null;
  source.terms = [source.terms[0], second, ancestor];
  const binding = buildSemanticGOJudgeBinding({
    prediction: source,
    blindEvidenceBundle: {
      protein: { sequence_length: 100, structure_available: true, query_lineage: ["Eukaryota"] },
      sequence_hits: [{ evidence_id: "SEQ-1", description: "Example protein", organism: "Example organism", percent_identity: 80, query_coverage: 1 }],
      structure_hits: [],
      uniprot_annotations: [{ accession: "P1", protein_name: "Example protein", organism: "Example organism", function: ["Catalyzes an example reaction."], keywords: ["Enzyme"] }],
    },
    ontologySnapshot: { terms: [
      { id: "GO:0000001", name: "example activity", parents: [{ relation: "is_a", parentId: "GO:0000003" }] },
      { id: "GO:0000002", name: "second activity", parents: [] },
      { id: "GO:0000003", name: "ancestor activity", parents: [] },
    ] },
  });
  const acceptedCard = binding.view.candidatesByAspect.molecular_function.find((item) => item.hypothesisName === "example activity")!;
  const result = {
    schemaVersion: "pi-semantic-go-judge-result.v1" as const,
    viewHash: binding.view.viewHash,
    modeUsed: "pi" as const,
    accepted: [{ candidateToken: acceptedCard.candidateToken, confidence: "high" as const, citedEvidenceIds: ["ANN-1"], rationale: "Curated catalytic evidence." }],
    rejected: [],
    audit: { modelProvider: "openai-codex", modelId: "gpt-5.6-sol", thinkingLevel: "high", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
  const rows = semanticPredictionRows({ targetId: "T1", binding, result });
  assert.deepEqual(rows.map((item) => [item.goId, item.score, item.status]), [
    ["GO:0000001", 0.88, "accepted"],
    ["GO:0000002", 0.04, "omitted"],
  ]);
  assert.equal(renderSemanticPredictionTsv(rows), "target_id\tgo_id\tscore\nT1\tGO:0000001\t0.880000000\nT1\tGO:0000002\t0.040000000\n");
  const applied = applySemanticGOJudgeResult({
    prediction: source,
    binding,
    result,
    maxSelectedTermsPerAspect: 32,
    maxCandidates: 128,
    maxDonorContexts: 12,
  });
  assert.deepEqual(applied.predictedGoIds, ["GO:0000001", "GO:0000003"]);
  assert.equal(applied.terms.find((item) => item.goId === "GO:0000001")?.semanticAdjustedScore, 0.88);
  assert.equal(applied.terms.find((item) => item.goId === "GO:0000002")?.selected, false);
  assert.equal(applied.terms.find((item) => item.goId === "GO:0000003")?.semanticAdjustedScore, 0.88);
  assert.equal(applied.semanticGoJudgeStatus?.failurePolicy, "fail_closed");
});

test("mandatory semantic execution fails rather than substituting a deterministic judge", async () => {
  const binding = buildSemanticGOJudgeBinding({
    prediction: prediction(),
    blindEvidenceBundle: {
      protein: { sequence_length: 100, structure_available: false, query_lineage: [] },
      sequence_hits: [], structure_hits: [],
      uniprot_annotations: [{ accession: "P1", protein_name: "Example protein", organism: "Example organism" }],
    },
    ontologySnapshot: { terms: [{ id: "GO:0000001", name: "example activity", parents: [] }] },
  });
  await assert.rejects(
    runSemanticGOJudge({ projectRoot: process.cwd(), binding, modelProvider: "missing-provider", modelId: "missing-model" }),
    /semantic GO judge model is unavailable/,
  );
});
