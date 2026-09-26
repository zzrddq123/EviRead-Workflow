import assert from "node:assert/strict";
import test from "node:test";

import { renderAuditMarkdown, renderHtml, renderMarkdown } from "./report.js";
import type { CriticReview, FinalPrediction, GenomeSnapshot } from "./types.js";

const prediction = {
  schemaVersion: "pi-function-prediction.v4",
  proteinId: "ANON_REPORT",
  targetMode: "anonymous",
  targetContext: {
    taxon: { taxonId: null, provenance: "unavailable" },
    phylogeny: { mode: "optional", status: "unavailable_missing_taxon" },
  },
  narrativeMode: "deterministic",
  mostLikelyFunction: "ATP-dependent helicase family protein",
  functionalDescription: "Sequence and structure evidence support an ATP-dependent helicase-family assignment.",
  confidence: "medium",
  confidenceRationale: "The two evidence dimensions agree at family level.",
  keyEvidence: [
    { evidenceId: "SEQ-01", supports: "A retained sequence match supports the helicase family." },
    { evidenceId: "STR-01", supports: "A structure match supports the same fold." },
  ],
  alternatives: [{ function: "ATPase", rationale: "broader family", evidenceIds: ["SEQ-01"] }],
  conflictingEvidence: ["A low-coverage hit suggests another family."],
  limitations: ["Substrate specificity is unresolved."],
  recommendedExperiments: ["An old recommendation retained only for artifact compatibility."],
  goPrediction: {
    methodId: "strict-blind-test",
    queryTaxonId: null,
    queryLineage: [],
    terms: [
      {
        goId: "GO:0004386",
        termName: "helicase activity",
        aspect: "molecular_function",
        selected: true,
        decision: "transfer_hypothesis",
        selectionRole: "primary_direct",
        rawScore: 0.8,
        phylogenyAdjustedScore: 0.7,
        evidenceCode: "EXP",
        evidenceIds: ["SEQ-01", "STR-01"],
      },
      {
        goId: "GO:0008152",
        termName: "metabolic process",
        aspect: "biological_process",
        selected: true,
        decision: "transfer_hypothesis",
        selectionRole: "entailed_ancestor",
        rawScore: 0.6,
        phylogenyAdjustedScore: 0.5,
        evidenceCode: "EXP",
        evidenceIds: ["SEQ-01"],
      },
      {
        goId: "GO:0005737",
        termName: "cytoplasm",
        aspect: "cellular_component",
        selected: true,
        decision: "transfer_hypothesis",
        selectionRole: "primary_direct",
        rawScore: 0.4,
        phylogenyAdjustedScore: 0.3,
        evidenceCode: "EXP",
        evidenceIds: ["STR-01"],
      },
    ],
    predictedGoIds: ["GO:0004386", "GO:0008152", "GO:0005737"],
    limitations: ["audit limitation"],
    candidateSources: { appliedCandidateCount: 0, candidateCount: 0, providers: [] },
    phylogenyStatus: { mode: "disabled", appliedCount: 0, evidenceCount: 0, quarantinedCount: 0 },
    calibrationStatus: "unavailable",
    dagProjectionStatus: "not_evaluated",
    taxonConstraintStatus: "not_evaluated",
    methodSummary: "audit method summary",
  },
} as unknown as FinalPrediction;

const critic = {
  approved: true,
  summary: "approved after structured review",
  unsupportedClaims: [],
  citationIssues: [],
  doubleCountingRisks: [],
  requiredRevisions: [],
} satisfies CriticReview;

const genome = {
  genome: { genomeId: "test-genome", generation: 1, claimBoundary: "development only" },
  genomeHash: "a".repeat(64),
} as unknown as GenomeSnapshot;

const input = {
  prediction,
  critic,
  bundle: {
    protein: { structure_available: true },
    sequence_hits: [{ evidence_id: "SEQ-01", source: "sequence", description: "sequence homolog" }],
    structure_hits: [{ evidence_id: "STR-01", source: "structure", description: "structure homolog" }],
  },
  audits: [],
  runId: "report-test",
  genome,
  quarantinedRecordCount: 0,
};

test("default report merges internal synthesis/review into one concise evidence-backed decision", () => {
  const markdown = renderMarkdown(input);
  assert.match(markdown, /ATP-dependent helicase family protein/);
  assert.match(markdown, /GO:0004386/);
  assert.match(markdown, /SEQ-01/);
  assert.match(markdown, /STR-01/);
  assert.match(markdown, /passed citation coverage/);
  assert.doesNotMatch(markdown, /## Conflicting evidence/);
  assert.doesNotMatch(markdown, /## Limitations/);
  assert.doesNotMatch(markdown, /## Recommended validation experiments/);
  assert.doesNotMatch(markdown, /## Narrative review/);
});

test("the full audit rendering remains available without cluttering the default report", () => {
  const markdown = renderAuditMarkdown(input);
  assert.match(markdown, /## Conflicting evidence/);
  assert.match(markdown, /## Limitations/);
  assert.match(markdown, /## Recommended validation experiments/);
  assert.match(markdown, /## Narrative review/);
});

test("semantic HTML renders title-case sections and one selectable panel per GO aspect", () => {
  const html = renderHtml(input);
  assert.match(html, /<h1>Protein Function Prediction Report<\/h1>/);
  assert.match(html, /<h2 id="go-title">Selected GO Hypotheses<\/h2>/);
  assert.doesNotMatch(html, /<pre>/);
  assert.doesNotMatch(html, /text-transform:\s*uppercase/);
  assert.match(html, /id="go-molecular_function" checked/);
  assert.match(html, /id="go-biological_process"/);
  assert.match(html, /id="go-cellular_component"/);
  assert.match(html, /class="go-panel panel-molecular_function"/);
  assert.match(html, /class="go-panel panel-biological_process"/);
  assert.match(html, /class="go-panel panel-cellular_component"/);
  assert.match(html, /GO:0004386/);
  assert.match(html, /GO:0008152/);
  assert.match(html, /GO:0005737/);
  assert.match(html, /Entailed Ancestor/);
  assert.match(html, /ranking heuristics, not probabilities/);
  assert.match(html, /data-report-template="fixed-report-v2"/);
  assert.match(html, /Page structure, labels, ordering, controls, and explanatory copy are fixed by host template/);
  assert.doesNotMatch(html, /Independent Review Passed/);
  assert.doesNotMatch(html, /approved after structured review/);
  assert.match(html, /<summary>3 Context Notes<\/summary>/);
  assert.match(html, /Anonymous mode does not infer target taxonomy from similarity hits/);
});

test("semantic HTML escapes biological prose and exposes failed review state", () => {
  const html = renderHtml({
    ...input,
    prediction: {
      ...prediction,
      mostLikelyFunction: "<script>not a function</script>",
    } as FinalPrediction,
    critic: {
      ...critic,
      approved: false,
      summary: "Review <failed> safely.",
    },
  });
  assert.doesNotMatch(html, /<script>not a function<\/script>/);
  assert.match(html, /&lt;script&gt;not a function&lt;\/script&gt;/);
  assert.match(html, /Report Requires Manual Review/);
  assert.doesNotMatch(html, /Review &lt;failed&gt; safely\./);
});

test("semantic HTML previews eight GO labels and folds the remainder", () => {
  const molecularTemplate = prediction.goPrediction.terms[0];
  const molecularTerms = Array.from({ length: 10 }, (_, index) => ({
    ...molecularTemplate,
    goId: `GO:${String(index + 1).padStart(7, "0")}`,
    termName: `fixture molecular function ${index + 1}`,
    phylogenyAdjustedScore: 1 - (index * 0.01),
  }));
  const html = renderHtml({
    ...input,
    prediction: {
      ...prediction,
      goPrediction: {
        ...prediction.goPrediction,
        terms: [
          ...molecularTerms,
          ...prediction.goPrediction.terms.slice(1),
        ],
      },
    } as FinalPrediction,
  });
  assert.match(html, /Show 2 More Molecular Function Labels/);
  assert.equal((html.match(/fixture molecular function/g) ?? []).length, 10);
  assert.match(html, /class="go-more"/);
});

test("semantic HTML keeps all three GO aspect controls when no label is selected", () => {
  const html = renderHtml({
    ...input,
    prediction: {
      ...prediction,
      goPrediction: {
        ...prediction.goPrediction,
        terms: [],
        predictedGoIds: [],
      },
    } as FinalPrediction,
  });
  assert.match(html, /Molecular Function<\/span><strong>0<\/strong>/);
  assert.match(html, /Biological Process<\/span><strong>0<\/strong>/);
  assert.match(html, /Cellular Component<\/span><strong>0<\/strong>/);
  assert.match(html, /No Molecular Function Label Was Selected/);
  assert.match(html, /No Biological Process Label Was Selected/);
  assert.match(html, /No Cellular Component Label Was Selected/);
});
