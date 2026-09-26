import type { AgentAudit, CriticReview, FunctionPrediction, GOPredictionSet, GOTermPrediction } from "./types.js";

function selectedTerm(go: GOPredictionSet, aspect: GOTermPrediction["aspect"], decision?: GOTermPrediction["decision"]): GOTermPrediction | undefined {
  return go.terms.find((term) => term.selected
    && term.aspect === aspect && (!decision || term.decision === decision));
}

function evidenceForTerm(term: GOTermPrediction): Array<{ evidenceId: string; supports: string }> {
  const output: Array<{ evidenceId: string; supports: string }> = [];
  for (const donor of term.donorSupports.slice(0, 3)) {
    const matchId = donor.matchEvidenceIds[0];
    if (matchId) {
      output.push({
        evidenceId: matchId,
        supports: `${donor.matchMode.replaceAll("_", " ")} similarity connects the query to ${donor.proteinName}; this is transfer evidence, not proof of ${term.termName}.`,
      });
    }
    output.push({
      evidenceId: donor.annotationEvidenceId,
      supports: `${donor.proteinName} carries ${term.goId} (${term.termName}) with evidence code ${donor.evidenceCode}; the annotation and similarity hit are linked evidence.`,
    });
  }
  const seen = new Set<string>();
  return output.filter((item) => item.evidenceId && !seen.has(item.evidenceId) && seen.add(item.evidenceId)).slice(0, 10);
}

function fallbackEvidence(bundle: Record<string, unknown> | undefined): Array<{ evidenceId: string; supports: string }> {
  if (!bundle) return [];
  for (const [section, supports] of [
    ["sequence_hits", "The strongest retained sequence-similarity result does not establish a specific biochemical function."],
    ["structure_hits", "The strongest retained structure-similarity result did not support a selected GO function under the fixed policy."],
    ["domain_segments", "A deterministic structure segment was retained, but it does not establish a biochemical function."],
    ["negative_search_evidence", "The completed similarity search returned no retained non-query evidence; the agent therefore abstained."],
    ["intrinsic_evidence", "Intrinsic sequence evidence is available, but it does not establish a specific molecular function."],
  ] as const) {
    const items = bundle[section];
    if (!Array.isArray(items)) continue;
    const item = items.find((value) => value && typeof value === "object" && "evidence_id" in value) as Record<string, unknown> | undefined;
    if (item?.evidence_id) return [{ evidenceId: String(item.evidence_id), supports }];
  }
  return [];
}

export function buildDeterministicNarrative(
  proteinId: string,
  go: GOPredictionSet,
  bundle?: Record<string, unknown>,
): FunctionPrediction {
  const molecularFunction = selectedTerm(go, "molecular_function", "transfer_hypothesis");
  const leadingHypothesis = go.terms.find((term) => term.aspect === "molecular_function"
    && term.decision === "abstained" && (term.fusionAdjustedScore ?? term.semanticAdjustedScore ?? term.judgeAdjustedScore ?? term.phylogenyAdjustedScore ?? 0) > 0);
  const primary = molecularFunction ?? go.terms.find((term) => term.selected);
  const keyEvidence = primary ? evidenceForTerm(primary) : [];
  const combinedEvidence = [...keyEvidence].filter(
    (item, index, items) => items.findIndex((candidate) => candidate.evidenceId === item.evidenceId) === index,
  ).slice(0, 12);

  if (molecularFunction) {
    return {
      proteinId,
      mostLikelyFunction: `Possible ${molecularFunction.termName}-related protein (low-confidence GO transfer hypothesis)`,
      functionalDescription: `The deterministic GO module retained ${molecularFunction.goId} (${molecularFunction.termName}) only as a low-confidence transfer hypothesis with an uncalibrated final evidence score of ${(molecularFunction.fusionAdjustedScore ?? molecularFunction.semanticAdjustedScore ?? molecularFunction.judgeAdjustedScore ?? molecularFunction.phylogenyAdjustedScore ?? 0).toFixed(3)}. The transfer passed the fixed donor-group and provenance-root gates; it does not establish catalytic activity, substrate specificity, family membership, or pathway role. Query-like annotations were quarantined before scoring.`,
      confidence: "low",
      confidenceRationale: "The molecular-function signal comes from similarity transfer rather than a direct query annotation. The run applied a frozen GO-DAG ancestor closure and may include conservative OMA HOG evidence, but unresolved orthology, missing exact target TaxID/taxon constraints, and absent fitted calibration keep the conclusion low-confidence. Structural-hit and annotation records from one donor are treated as linked evidence.",
      keyEvidence: combinedEvidence,
      alternatives: [
        {
          function: "Noncatalytic interaction or scaffold protein",
          rationale: "A shared regional fold can support binding or architecture without conserving the annotated catalytic function of the full donor protein.",
          evidenceIds: molecularFunction.evidenceIds.slice(0, 6),
        },
      ],
      conflictingEvidence: [
        "No selected molecular-function term is a direct experimental annotation of the query protein.",
        "Remote or partial structural similarity does not identify the aligned region as the donor's active site.",
      ],
      limitations: [...go.limitations, "The deterministic narrative mode is a conservative template, not an independent language-model synthesis or scientific review."],
      recommendedExperiments: [],
    };
  }

  if (leadingHypothesis) {
    const hypothesisEvidence = evidenceForTerm(leadingHypothesis);
    const cited = [...hypothesisEvidence].filter(
      (item, index, items) => items.findIndex((candidate) => candidate.evidenceId === item.evidenceId) === index,
    ).slice(0, 12);
    return {
      proteinId,
      mostLikelyFunction: `Molecular function unresolved; leading hypothesis is ${leadingHypothesis.termName}-related`,
      functionalDescription: `${leadingHypothesis.goId} (${leadingHypothesis.termName}) is the highest-ranked transferred molecular-function hypothesis, with uncalibrated final evidence score ${(leadingHypothesis.fusionAdjustedScore ?? leadingHypothesis.semanticAdjustedScore ?? leadingHypothesis.judgeAdjustedScore ?? leadingHypothesis.phylogenyAdjustedScore ?? 0).toFixed(3)}, but it did not pass the fixed independence/provenance gate and is therefore an abstention rather than a predicted GO label. It may reflect shared regional architecture instead of conserved activity; query-like annotations were not used.`,
      confidence: "low",
      confidenceRationale: "The leading molecular-function hypothesis is supported only by remote or partial similarity and lacks enough independent traceable annotation roots. No characterized sequence homolog establishes the activity.",
      keyEvidence: cited.length > 0 ? cited : fallbackEvidence(bundle),
      alternatives: [{
        function: "Noncatalytic interaction or scaffold protein",
        rationale: "A shared regional fold can support binding or architecture without conserving the donor proteins' activity.",
        evidenceIds: leadingHypothesis.evidenceIds.slice(0, 6),
      }],
      conflictingEvidence: [
        "The leading transferred molecular-function term was explicitly abstained by the deterministic GO policy.",
        "Correlated donor annotations sharing one publication or inference root do not constitute independent biological confirmations.",
      ],
      limitations: [...go.limitations, "The deterministic narrative mode is a conservative template, not an independent language-model synthesis or scientific review."],
      recommendedExperiments: [],
    };
  }

  return {
    proteinId,
    mostLikelyFunction: "Precise molecular function unresolved",
    functionalDescription: "No molecular-function GO transfer from non-query donors passed the bootstrap genome's conservative criteria. Query-like database annotations were quarantined and were not copied into the result.",
    confidence: "insufficient",
    confidenceRationale: "Available evidence does not support a specific molecular function under the fixed heuristic transfer policy.",
    keyEvidence: combinedEvidence.length > 0 ? combinedEvidence : fallbackEvidence(bundle),
    alternatives: [],
    conflictingEvidence: [],
    limitations: [...go.limitations, "The deterministic narrative mode is a conservative template, not an independent language-model synthesis or scientific review."],
    recommendedExperiments: [],
  };
}

export function deterministicReview(prediction: FunctionPrediction): CriticReview {
  return {
    approved: prediction.keyEvidence.length > 0,
    summary: "Deterministic contract review checked that the template uses guarded language and emits evidence citations. This is not an independent scientific critic.",
    unsupportedClaims: [],
    citationIssues: prediction.keyEvidence.length > 0 ? [] : ["No primary evidence citation was available."],
    doubleCountingRisks: [],
    requiredRevisions: prediction.keyEvidence.length > 0 ? [] : ["Acquire evidence that can support at least one cited statement."],
  };
}

export function deterministicAudit(role: "synthesizer" | "critic"): AgentAudit {
  return {
    role,
    modelProvider: "deterministic",
    modelId: role === "synthesizer" ? "guarded-template-v1" : "contract-validator-v1",
    thinkingLevel: "none",
    stats: { userMessages: 0, assistantMessages: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
  };
}
