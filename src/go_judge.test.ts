import assert from "node:assert/strict";
import test from "node:test";

import { hashCanonical } from "./hash.js";

import {
  applyGOJudgeResult,
  applyGOScoreFusion,
  buildGOJudgeBinding,
  GO_JUDGE_FACTORS,
  judgeGOCandidatesDeterministically,
  runGOEvidenceJudge,
  serializeGOJudgeView,
  validateGOJudgeSubmission,
  validateGOJudgeResult,
  validateGOJudgeView,
  type GOJudgeView,
} from "./go_judge.js";
import type { GODonorSupport, GOPredictionSet, GOTermPrediction } from "./types.js";

const viewCandidates: GOJudgeView["candidates"] = [
  {
    candidateToken: `cand_${"1".repeat(16)}`,
    hypothesisName: "binding",
    aspect: "molecular_function",
    evidence: [
      {
        evidenceId: "SEQ-01",
        channel: "sequence",
        direction: "support",
        strength: "strong",
        independenceGroup: "donor_group_1",
      },
      {
        evidenceId: "STR-01",
        channel: "structure",
        direction: "support",
        strength: "moderate",
        independenceGroup: "structure_group_1",
      },
    ],
  },
  {
    candidateToken: `cand_${"2".repeat(16)}`,
    hypothesisName: "signal transduction",
    aspect: "biological_process",
    evidence: [
      {
        evidenceId: "PHY-01",
        channel: "phylogeny",
        direction: "contradict",
        strength: "strong",
        independenceGroup: "lineage_group_1",
      },
    ],
  },
  {
    candidateToken: `cand_${"3".repeat(16)}`,
    hypothesisName: "intracellular compartment",
    aspect: "cellular_component",
    evidence: [
      {
        evidenceId: "DOM-01",
        channel: "domain",
        direction: "support",
        strength: "moderate",
        independenceGroup: "domain_group_1",
      },
    ],
  },
];

const view: GOJudgeView = {
  schemaVersion: "go-evidence-judge-view-v1",
  viewHash: `sha256:${hashCanonical({ schemaVersion: "go-evidence-judge-view-v1", candidates: viewCandidates })}`,
  candidates: viewCandidates,
};

function judgeView(candidates: GOJudgeView["candidates"]): GOJudgeView {
  return {
    schemaVersion: "go-evidence-judge-view-v1",
    viewHash: `sha256:${hashCanonical({ schemaVersion: "go-evidence-judge-view-v1", candidates })}`,
    candidates,
  };
}

function donorSupport(id: string, candidateSource = false): GODonorSupport {
  return {
    accession: `DONOR-${id}`,
    donorGroup: `donor-${id}`,
    proteinName: "bounded fixture donor",
    organism: "fixture organism",
    taxonId: 9606,
    annotationEvidenceId: `ANN-${id}`,
    matchEvidenceIds: [`MATCH-${id}`],
    matchMode: candidateSource ? "domain_mapping" : "sequence",
    similarityScore: 0.8,
    evidenceCode: candidateSource ? "IEA" : "EXP",
    provenanceRoots: [`root-${id}`],
    evidenceWeight: 0.8,
    structureQualityFactor: 1,
    lineageFactor: 1,
    lineageStatus: "unavailable",
    ...(candidateSource ? {
      candidateSourceType: "interpro" as const,
      sourceProvider: "InterProScan" as const,
      candidateBaseScore: 0.8,
      candidateQueryCoverage: 0.8,
      candidateSelectionEligible: true,
    } : {}),
    rawSupport: 0.6,
    adjustedSupport: 0.6,
  };
}

function predictionTerm(input: {
  goId: string;
  selected: boolean;
  score: number;
  candidateSource: boolean;
}): GOTermPrediction {
  const supports = input.candidateSource
    ? [donorSupport(`${input.goId}-A`, true), donorSupport(`${input.goId}-B`, true)]
    : [donorSupport(`${input.goId}-DIRECT`)];
  return {
    goId: input.goId,
    termName: `fixture term ${input.goId.slice(-1)}`,
    aspect: "molecular_function",
    decision: input.selected ? "transfer_hypothesis" : "abstained",
    selected: input.selected,
    preBudgetEligible: input.selected,
    selectionRole: input.selected ? "primary_direct" : "not_selected",
    selectionRank: input.selected ? 1 : null,
    rawScore: input.score,
    phylogenyAdjustedScore: input.score,
    calibrationStatus: "unavailable",
    confidenceLabel: input.selected ? "low_heuristic" : "abstained",
    evidenceCode: input.candidateSource ? "IEA" : "EXP",
    donorSupports: supports,
    evidenceIds: supports.flatMap((support) => [support.annotationEvidenceId, ...support.matchEvidenceIds]),
    reasons: ["Baseline host decision."],
    selectionBlockers: input.selected ? [] : ["below_threshold"],
    candidateOrigin: input.candidateSource ? "direct_candidate_source" : "direct_annotation",
  };
}

function predictionSet(terms: GOTermPrediction[]): GOPredictionSet {
  const withoutHash: Omit<GOPredictionSet, "canonicalHash"> = {
    schemaVersion: "pi-go-prediction.v3",
    proteinId: "ANON-JUDGE-SCOPE",
    targetMode: "anonymous",
    identityPolicy: "strict_blind_v1",
    queryAccession: null,
    queryLikeAccessions: [],
    explicitlyExcludedAccessions: [],
    queryTaxonId: 9606,
    queryLineage: [],
    targetContext: {
      taxon: { taxonId: 9606, provenance: "provided" },
      phylogeny: { mode: "optional", status: "requested" },
    },
    genomeId: "judge-scope-fixture",
    genomeHash: "a".repeat(64),
    methodId: "judge-scope-fixture",
    methodSummary: "Fixture baseline.",
    calibrationStatus: "unavailable",
    dagProjectionStatus: "not_applied",
    candidateSources: {
      bundleHash: "b".repeat(64),
      providers: [],
      candidateCount: terms.filter((term) => term.donorSupports.some((support) => support.candidateSourceType)).length,
      appliedCandidateCount: terms.filter((term) => term.donorSupports.some((support) => support.candidateSourceType)).length,
    },
    phylogenyStatus: {
      mode: "disabled",
      targetTaxonStatus: "provided",
      evidenceCount: 0,
      appliedCount: 0,
      quarantinedCount: 0,
    },
    taxonConstraintStatus: "not_evaluated",
    thresholds: { molecular_function: 0.5, biological_process: 0.5, cellular_component: 0.5 },
    quarantinedGoIds: [],
    predictedGoIds: terms.filter((term) => term.selected).map((term) => term.goId).sort(),
    terms,
    limitations: [],
  };
  return { ...withoutHash, canonicalHash: hashCanonical(withoutHash) };
}

test("GO judge view is closed, opaque, and contains no visible GO identifier", () => {
  const serialized = serializeGOJudgeView(view);
  assert.deepEqual(JSON.parse(serialized), view);
  assert.doesNotMatch(serialized, /GO:\d{7}/i);
  assert.throws(() => validateGOJudgeView({ ...view, viewHash: `sha256:${"a".repeat(64)}` }), /canonical view content/);
  assert.throws(() => validateGOJudgeView({ ...view, leakedGoIds: ["GO:0003674"] }));
  assert.throws(() => validateGOJudgeView({
    ...view,
    candidates: [{ ...view.candidates[0], candidateToken: "GO:0003674" }],
  }));
  assert.throws(() => validateGOJudgeView({
    ...view,
    candidates: [{
      ...view.candidates[0],
      evidence: [{ ...view.candidates[0].evidence[0], evidenceId: "invented-GO:0003674" }],
    }],
  }));
});

test("submission accepts only candidate tokens and evidence IDs allowlisted for that candidate", () => {
  const decisions = validateGOJudgeSubmission(view, {
    judgments: [
      { candidateToken: view.candidates[2].candidateToken, verdict: "uncertain", citedEvidenceIds: ["DOM-01"] },
      { candidateToken: view.candidates[0].candidateToken, verdict: "support", citedEvidenceIds: ["SEQ-01", "STR-01"] },
      { candidateToken: view.candidates[1].candidateToken, verdict: "contradict", citedEvidenceIds: ["PHY-01"] },
    ],
  });
  assert.deepEqual(decisions.map((decision) => decision.candidateToken), view.candidates.map((candidate) => candidate.candidateToken));
  assert.deepEqual(decisions.map((decision) => decision.factor), [
    GO_JUDGE_FACTORS.support,
    GO_JUDGE_FACTORS.contradict,
    GO_JUDGE_FACTORS.uncertain,
  ]);

  assert.throws(() => validateGOJudgeSubmission(view, {
    judgments: [
      { candidateToken: view.candidates[0].candidateToken, verdict: "support", citedEvidenceIds: ["PHY-01"] },
      { candidateToken: view.candidates[1].candidateToken, verdict: "contradict", citedEvidenceIds: ["PHY-01"] },
      { candidateToken: view.candidates[2].candidateToken, verdict: "uncertain", citedEvidenceIds: ["DOM-01"] },
    ],
  }), /non-allowlisted evidence ID/);
  assert.throws(() => validateGOJudgeSubmission(view, {
    judgments: [
      { candidateToken: "GO:0003674", verdict: "support", citedEvidenceIds: ["SEQ-01"] },
      { candidateToken: view.candidates[1].candidateToken, verdict: "contradict", citedEvidenceIds: ["PHY-01"] },
      { candidateToken: view.candidates[2].candidateToken, verdict: "uncertain", citedEvidenceIds: ["DOM-01"] },
    ],
  }), /non-allowlisted candidate token/);
});

test("deterministic fallback deduplicates correlated groups and emits fixed factors", () => {
  const result = judgeGOCandidatesDeterministically(view);
  assert.equal(result.modeUsed, "deterministic");
  assert.deepEqual(result.decisions.map(({ verdict, factor }) => ({ verdict, factor })), [
    { verdict: "support", factor: 1.05 },
    { verdict: "contradict", factor: 0.4 },
    { verdict: "uncertain", factor: 0.85 },
  ]);

  const correlated = judgeView([{
      candidateToken: `cand_${"4".repeat(16)}`,
      hypothesisName: "catalytic activity",
      aspect: "molecular_function",
      evidence: [
        { evidenceId: "SEQ-A", channel: "sequence", direction: "support", strength: "strong", independenceGroup: "same_hit" },
        { evidenceId: "STR-A", channel: "structure", direction: "support", strength: "strong", independenceGroup: "same_hit" },
      ],
    }]);
  assert.equal(judgeGOCandidatesDeterministically(correlated).decisions[0].verdict, "uncertain");
});

test("submission must cover every candidate exactly once and cannot add arbitrary fields", () => {
  assert.throws(() => validateGOJudgeSubmission(view, {
    judgments: [{ candidateToken: view.candidates[0].candidateToken, verdict: "support", citedEvidenceIds: ["SEQ-01"] }],
  }), /exactly one judgment/);
  assert.throws(() => validateGOJudgeSubmission(view, {
    judgments: view.candidates.map((candidate) => ({
      candidateToken: candidate.candidateToken,
      verdict: "uncertain",
      citedEvidenceIds: [candidate.evidence[0].evidenceId],
      goId: "GO:0003674",
    })),
  }), /unexpected field/);
});

test("candidate-source scope preserves a selected direct-only baseline term", () => {
  const direct = predictionTerm({ goId: "GO:1000001", selected: true, score: 0.7, candidateSource: false });
  const promotableCandidate = predictionTerm({ goId: "GO:1000002", selected: false, score: 0.49, candidateSource: true });
  const prediction = predictionSet([direct, promotableCandidate]);
  const binding = buildGOJudgeBinding(prediction, 128);
  assert.ok(binding);
  assert.deepEqual(Object.values(binding.tokenToGoId), [promotableCandidate.goId]);

  const judged = applyGOJudgeResult({
    prediction,
    binding,
    result: judgeGOCandidatesDeterministically(binding.view),
    maxSelectedTermsPerAspect: 1,
    requestedMode: "deterministic",
  });
  const judgedDirect = judged.terms.find((term) => term.goId === direct.goId);
  const judgedCandidate = judged.terms.find((term) => term.goId === promotableCandidate.goId);
  assert.deepEqual(judgedDirect, direct, "the out-of-scope direct baseline selection must remain untouched");
  assert.equal(judgedCandidate?.agentJudgment?.verdict, "support");
  assert.equal(judgedCandidate?.selected, false, "candidate promotions cannot consume a protected direct baseline slot");
  assert.match(judgedCandidate?.reasons.at(-1) ?? "", /post-judge cap/);
  assert.ok(judgedCandidate?.selectionBlockers?.includes("per_aspect_budget"));
});

test("a judge triggered in one aspect preserves direct-only CAFA sweep eligibility in other aspects", () => {
  const selectedMf = predictionTerm({ goId: "GO:1100001", selected: true, score: 0.8, candidateSource: false });
  const overflowMf = predictionTerm({ goId: "GO:1100002", selected: false, score: 0.7, candidateSource: false });
  overflowMf.preBudgetEligible = true;
  overflowMf.selectionRank = 2;
  overflowMf.selectionBlockers = ["per_aspect_budget"];
  const bpCandidate = predictionTerm({ goId: "GO:1100003", selected: true, score: 0.8, candidateSource: true });
  bpCandidate.aspect = "biological_process";
  const prediction = predictionSet([selectedMf, overflowMf, bpCandidate]);
  const binding = buildGOJudgeBinding(prediction, 3, "aspect_stratified_v1");
  assert.ok(binding);
  assert.deepEqual(Object.values(binding.tokenToGoId), [bpCandidate.goId]);

  const judged = applyGOJudgeResult({
    prediction,
    binding,
    result: judgeGOCandidatesDeterministically(binding.view),
    maxSelectedTermsPerAspect: 1,
    requestedMode: "deterministic",
  });
  const judgedOverflow = judged.terms.find((term) => term.goId === overflowMf.goId);
  assert.equal(judgedOverflow?.selected, false);
  assert.equal(judgedOverflow?.preBudgetEligible, true,
    "the unrelated direct hypothesis must remain in the scored CAFA threshold sweep");
  assert.ok(judgedOverflow?.selectionBlockers?.includes("per_aspect_budget"));
  assert.equal(judgedOverflow?.agentJudgment, undefined);
});

test("candidate judge view preserves mapping and strict phylogeny roles even when a provider reuses an evidence ID", () => {
  const candidate = predictionTerm({ goId: "GO:1500001", selected: true, score: 0.8, candidateSource: true });
  candidate.donorSupports = [{
    ...candidate.donorSupports[0],
    annotationEvidenceId: "CAND-OMA-001",
    matchEvidenceIds: ["CAND-OMA-001", "PHY-OMA-001"],
    matchMode: "orthology",
    orthologyRelation: "one_to_one",
  }];
  const binding = buildGOJudgeBinding(predictionSet([candidate]), 128);
  assert.ok(binding);
  const channels = binding.view.candidates[0].evidence.map((item) => item.channel).sort();
  assert.deepEqual(channels, ["ontology", "phylogeny", "phylogeny"]);
  assert.equal(new Set(binding.view.candidates[0].evidence.map((item) => item.evidenceId)).size, 3);
  assert.deepEqual(
    [...new Set(Object.values(binding.evidenceTokenToId))].sort(),
    ["CAND-OMA-001", "PHY-OMA-001"],
  );
  assert.equal(new Set(binding.view.candidates[0].evidence.map((item) => item.independenceGroup)).size, 1);
});

test("candidate-source terms are judged in budget and fail closed when truncated", () => {
  const judgedCandidate = predictionTerm({ goId: "GO:2000001", selected: true, score: 0.8, candidateSource: true });
  const truncatedCandidate = predictionTerm({ goId: "GO:2000002", selected: true, score: 0.7, candidateSource: true });
  const prediction = predictionSet([truncatedCandidate, judgedCandidate]);
  const binding = buildGOJudgeBinding(prediction, 1);
  assert.ok(binding);
  assert.equal(binding.view.candidates.length, 1);
  assert.deepEqual(Object.values(binding.tokenToGoId), [judgedCandidate.goId]);

  const judged = applyGOJudgeResult({
    prediction,
    binding,
    result: judgeGOCandidatesDeterministically(binding.view),
    maxSelectedTermsPerAspect: 3,
    requestedMode: "deterministic",
  });
  const covered = judged.terms.find((term) => term.goId === judgedCandidate.goId);
  const truncated = judged.terms.find((term) => term.goId === truncatedCandidate.goId);
  assert.equal(covered?.agentJudgment?.verdict, "support");
  assert.equal(covered?.selected, true);
  assert.equal(truncated?.agentJudgment, undefined);
  assert.equal(truncated?.selected, false);
  assert.equal(truncated?.preBudgetEligible, false);
  assert.equal(truncated?.decision, "abstained");
  assert.ok(truncated?.selectionBlockers?.includes("judge_candidate_budget"));
  assert.match(truncated?.reasons.at(-1) ?? "", /did not cover.*candidate budget.*fail-closed/i);
});

test("ranked-evidence retention keeps admissible candidates outside the judge budget scoreable", () => {
  const coveredCandidate = predictionTerm({ goId: "GO:2050001", selected: true, score: 0.8, candidateSource: true });
  const retainedCandidate = predictionTerm({ goId: "GO:2050002", selected: true, score: 0.7, candidateSource: true });
  const prediction = predictionSet([retainedCandidate, coveredCandidate]);
  const binding = buildGOJudgeBinding(prediction, 1);
  assert.ok(binding);

  const judged = applyGOJudgeResult({
    prediction,
    binding,
    result: judgeGOCandidatesDeterministically(binding.view),
    maxSelectedTermsPerAspect: 3,
    requestedMode: "deterministic",
    candidateRetentionMode: "preserve_ranked_evidence_v1",
  });
  const retained = judged.terms.find((term) => term.goId === retainedCandidate.goId);
  assert.equal(retained?.agentJudgment, undefined);
  assert.equal(retained?.selected, true);
  assert.equal(retained?.preBudgetEligible, true);
  assert.equal(retained?.selectionBlockers?.includes("judge_candidate_budget"), false);
  assert.match(retained?.reasons.at(-1) ?? "", /retained in the ranked evaluation output/i);
  assert.equal(judged.goJudgeStatus?.candidateRetentionMode, "preserve_ranked_evidence_v1");
});

test("ranked-evidence retention does not operationally select a below-threshold hypothesis", () => {
  const candidate = predictionTerm({ goId: "GO:2050003", selected: false, score: 0.3, candidateSource: true });
  candidate.selectionBlockers = ["below_threshold"];
  candidate.preBudgetEligible = false;
  const prediction = predictionSet([candidate]);
  const binding = buildGOJudgeBinding(prediction, 1);
  assert.ok(binding);

  const judged = applyGOJudgeResult({
    prediction,
    binding,
    result: judgeGOCandidatesDeterministically(binding.view),
    maxSelectedTermsPerAspect: 3,
    requestedMode: "deterministic",
    candidateRetentionMode: "preserve_ranked_evidence_v1",
  });
  const after = judged.terms.find((term) => term.goId === candidate.goId);
  assert.equal(after?.selected, false);
  assert.equal(after?.decision, "abstained");
  assert.equal(after?.preBudgetEligible, true, "the score remains available to an external threshold sweep");
  assert.ok(after?.selectionBlockers?.includes("below_threshold"));
});

test("aspect-stratified judge quotas prevent BP expansion from displacing MF or CC", () => {
  const mf = predictionTerm({ goId: "GO:2100001", selected: true, score: 0.6, candidateSource: true });
  const bp = predictionTerm({ goId: "GO:2100002", selected: true, score: 0.6, candidateSource: true });
  bp.aspect = "biological_process";
  const cc = predictionTerm({ goId: "GO:2100003", selected: true, score: 0.6, candidateSource: true });
  cc.aspect = "cellular_component";
  const newBp = predictionTerm({ goId: "GO:2100004", selected: true, score: 0.95, candidateSource: true });
  newBp.aspect = "biological_process";

  const before = buildGOJudgeBinding(
    predictionSet([mf, bp, cc]),
    3,
    "aspect_stratified_v1",
  );
  const after = buildGOJudgeBinding(
    predictionSet([mf, bp, cc, newBp]),
    3,
    "aspect_stratified_v1",
  );
  assert.ok(before && after);
  assert.equal(after.candidateBudgetMode, "aspect_stratified_v1");
  const beforeIds = new Set(Object.values(before.tokenToGoId));
  const afterIds = new Set(Object.values(after.tokenToGoId));
  assert.equal(beforeIds.has(mf.goId) && afterIds.has(mf.goId), true);
  assert.equal(beforeIds.has(cc.goId) && afterIds.has(cc.goId), true);
  assert.equal(afterIds.has(newBp.goId), true);
  assert.equal(afterIds.has(bp.goId), false, "the extra BP hypothesis competes only within BP");
});

test("frontier judge reviews direct hypotheses and reconstructs ancestor closure without spending judge budget", () => {
  const direct = predictionTerm({ goId: "GO:3000001", selected: true, score: 0.8, candidateSource: true });
  direct.sourceGoIds = [direct.goId];
  const ancestor: GOTermPrediction = {
    ...structuredClone(direct),
    goId: "GO:3000002",
    termName: "fixture ancestor",
    candidateOrigin: "ontology_ancestor",
    sourceGoIds: [direct.goId],
    ontologyDepth: 1,
    selectionRole: "entailed_ancestor",
    selectionRank: null,
  };
  const prediction = predictionSet([ancestor, direct]);
  prediction.selectionPolicyMode = "evidence_frontier_v1";
  const binding = buildGOJudgeBinding(prediction, 1);
  assert.ok(binding);
  assert.deepEqual(Object.values(binding.tokenToGoId), [direct.goId]);

  const judged = applyGOJudgeResult({
    prediction,
    binding,
    result: judgeGOCandidatesDeterministically(binding.view),
    maxSelectedTermsPerAspect: 1,
    requestedMode: "deterministic",
  });
  const judgedDirect = judged.terms.find((term) => term.goId === direct.goId);
  const judgedAncestor = judged.terms.find((term) => term.goId === ancestor.goId);
  assert.equal(judgedDirect?.selected, true);
  assert.equal(judgedDirect?.selectionRole, "primary_direct");
  assert.equal(judgedAncestor?.selected, true);
  assert.equal(judgedAncestor?.selectionRole, "entailed_ancestor");
  assert.equal(judgedAncestor?.agentJudgment, undefined);
  assert.equal(judgedAncestor?.selectionBlockers?.includes("judge_candidate_budget"), false);
});

test("public runner exposes the pure deterministic offline path", async () => {
  const result = await runGOEvidenceJudge({
    projectRoot: ".",
    mode: "deterministic",
    view,
  });
  assert.equal(result.modeUsed, "deterministic");
  assert.deepEqual(result.decisions, judgeGOCandidatesDeterministically(view).decisions);
  assert.deepEqual(validateGOJudgeResult(view, result), result);
  assert.throws(() => validateGOJudgeResult(view, {
    ...result,
    decisions: result.decisions.map((decision, index) => index === 0 ? { ...decision, factor: 0.99 } : decision),
  }), /non-host factor/);
});

test("aspect score fusion preserves the DeepGOPlus anchor and cannot mint candidates", () => {
  const anchored = predictionTerm({ goId: "GO:4000001", selected: false, score: 0.4, candidateSource: true });
  anchored.donorSupports = anchored.donorSupports.map((support) => ({
    ...support,
    matchMode: "learned_sequence",
    candidateSourceType: "deepgoplus_cnn",
    sourceProvider: "DeepGOPlus",
    candidateBaseScore: 0.8,
  }));
  const evidenceOnly = predictionTerm({ goId: "GO:4000002", selected: true, score: 0.8, candidateSource: false });
  const prediction = predictionSet([anchored, evidenceOnly]);
  const fused = applyGOScoreFusion({
    prediction,
    policy: {
      mode: "deepgoplus_anchor_v1",
      anchorWeights: {
        molecular_function: 0.6,
        biological_process: 0.75,
        cellular_component: 0.97,
      },
    },
    maxSelectedTermsPerAspect: 32,
  });
  assert.equal(fused.terms.length, 2);
  assert.equal(fused.terms.find((term) => term.goId === anchored.goId)?.fusionAdjustedScore, 0.64);
  assert.equal(fused.terms.find((term) => term.goId === anchored.goId)?.selected, true);
  assert.equal(fused.terms.find((term) => term.goId === evidenceOnly.goId)?.fusionAdjustedScore, 0.32);
  assert.equal(fused.terms.find((term) => term.goId === evidenceOnly.goId)?.selected, false);
  assert.deepEqual(fused.scoreFusionStatus?.anchorWeights, {
    molecular_function: 0.6,
    biological_process: 0.75,
    cellular_component: 0.97,
  });
});
