import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentAudit,
  CriticReview,
  FinalPrediction,
  GOAspect,
  GOTermPrediction,
  GenomeSnapshot,
} from "./types.js";

export interface ReportInput {
  prediction: FinalPrediction;
  critic: CriticReview;
  bundle: Record<string, unknown>;
  audits: AgentAudit[];
  runId: string;
  genome: GenomeSnapshot;
  quarantinedRecordCount: number;
}

function markdownEscape(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function collectEvidenceIndex(bundle: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  for (const section of ["domain_segments", "sequence_hits", "structure_hits", "uniprot_annotations", "pdb_annotations", "negative_search_evidence", "intrinsic_evidence"]) {
    const items = bundle[section];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item && typeof item === "object" && "evidence_id" in item) {
        index.set(String((item as Record<string, unknown>).evidence_id), item as Record<string, unknown>);
      }
    }
  }
  const candidateSources = bundle.candidate_sources;
  if (candidateSources && typeof candidateSources === "object" && !Array.isArray(candidateSources)) {
    const candidates = (candidateSources as Record<string, unknown>).go_candidates;
    if (Array.isArray(candidates)) {
      for (const item of candidates) {
        if (item && typeof item === "object" && !Array.isArray(item) && "evidence_id" in item) {
          index.set(String((item as Record<string, unknown>).evidence_id), item as Record<string, unknown>);
        }
      }
    }
  }
  return index;
}

function evidenceLabel(item: Record<string, unknown>): string {
  if (item.description) return String(item.description);
  if (item.protein_name) return String(item.protein_name);
  if (item.title) return String(item.title);
  if (item.target) return String(item.target);
  if (item.residue_range) return `${String(item.method)} domain ${String(item.residue_range)}`;
  return "See evidence_bundle.json";
}

export function renderAuditMarkdown(input: ReportInput): string {
  const { prediction, critic, bundle, audits, runId, genome, quarantinedRecordCount } = input;
  const evidenceIndex = collectEvidenceIndex(bundle);
  const protein = bundle.protein && typeof bundle.protein === "object" && !Array.isArray(bundle.protein)
    ? bundle.protein as Record<string, unknown>
    : {};
  const lines = [
    "# Protein Function Prediction Report",
    "",
    `- Run ID: \`${runId}\``,
    `- Protein ID: \`${prediction.proteinId}\``,
    `- Target mode: \`${prediction.targetMode}\` with \`${prediction.goPrediction.identityPolicy}\` identity policy`,
    `- Declared target TaxID: \`${prediction.targetContext.taxon.taxonId ?? "unavailable"}\` (provenance: \`${prediction.targetContext.taxon.provenance}\`)`,
    `- Phylogeny request: \`${prediction.targetContext.phylogeny.mode}\`; input status: \`${prediction.targetContext.phylogeny.status}\``,
    `- Input modality: \`${protein.structure_available === false ? "sequence_only" : "sequence_structure"}\``,
    `- Narrative mode: \`${prediction.narrativeMode}\``,
    `- Genome: \`${genome.genome.genomeId}\` (generation ${genome.genome.generation}, SHA-256 \`${genome.genomeHash}\`)`,
    `- Critic approved: **${critic.approved ? "yes" : "no"}**`,
    protein.structure_confidence_source === "alphafold_plddt"
      ? `- Structure confidence: AlphaFold pLDDT mean \`${Number(protein.structure_mean_plddt).toFixed(1)}\`; \`${(100 * Number(protein.structure_fraction_plddt_below_50)).toFixed(1)}%\` of residues below 50 (used as an uncalibrated structure-evidence penalty).`
      : "- Structure confidence: unavailable; no pLDDT scaling was applied.",
    "",
    "## Most likely function",
    "",
    `**${prediction.mostLikelyFunction}**`,
    "",
    prediction.functionalDescription,
    "",
    `**Qualitative confidence:** ${prediction.confidence}`,
    "",
    prediction.confidenceRationale,
  ];
  lines.push(
    "",
    "## GO labels",
    "",
    `- Method: \`${prediction.goPrediction.methodId}\``,
    `- Query taxon: \`${prediction.goPrediction.queryTaxonId ?? "unavailable"}\``,
    `- Query-like database records quarantined in the private audit layer: \`${quarantinedRecordCount}\` (their identities and GO labels were not supplied to the narrative agent or public GO object).`,
    `- Predicted GO IDs: \`${prediction.goPrediction.predictedGoIds.join(", ") || "abstained"}\``,
    `- Calibration: **${prediction.goPrediction.calibrationStatus}** — scores are host-computed ranking heuristics, not probabilities.`,
    `- GO DAG projection: \`${prediction.goPrediction.dagProjectionStatus}\`; taxon constraints: \`${prediction.goPrediction.taxonConstraintStatus}\`.`,
    `- Candidate sources: \`${prediction.goPrediction.candidateSources.appliedCandidateCount}/${prediction.goPrediction.candidateSources.candidateCount}\` normalized candidates applied; provider states: \`${prediction.goPrediction.candidateSources.providers.map((item) => `${item.provider}=${item.status}`).join(", ") || "none"}\`.`,
    `- Phylogeny module: \`${prediction.goPrediction.phylogenyStatus.mode}\`; applied \`${prediction.goPrediction.phylogenyStatus.appliedCount}/${prediction.goPrediction.phylogenyStatus.evidenceCount}\` relation records; quarantined \`${prediction.goPrediction.phylogenyStatus.quarantinedCount}\`.`,
    `- GO evidence judge: \`${prediction.goPrediction.semanticGoJudgeStatus ? `semantic ${prediction.goPrediction.semanticGoJudgeStatus.modeUsed} (${prediction.goPrediction.semanticGoJudgeStatus.acceptedCount}/${prediction.goPrediction.semanticGoJudgeStatus.candidateCount} accepted)` : prediction.goPrediction.goJudgeStatus ? `${prediction.goPrediction.goJudgeStatus.modeUsed} (${prediction.goPrediction.goJudgeStatus.judgedCandidateCount} candidates)` : "disabled"}\`.`,
    "",
    "| GO ID | Term | Aspect | Decision | Raw score | Final evidence score | Evidence |",
    "| --- | --- | --- | --- | ---: | ---: | --- |",
  );
  const reportedGo = prediction.goPrediction.terms.filter((term) => term.selected);
  if (reportedGo.length === 0) lines.push("| — | No independently supported predicted GO term | — | abstained | — | — | — |");
  for (const term of reportedGo) {
    const raw = term.rawScore === null ? "—" : term.rawScore.toFixed(3);
    const finalScore = term.fusionAdjustedScore ?? term.semanticAdjustedScore ?? term.judgeAdjustedScore ?? term.phylogenyAdjustedScore;
    const adjusted = finalScore === null ? "—" : finalScore.toFixed(3);
    lines.push(`| ${term.goId} | ${markdownEscape(term.termName)} | ${term.aspect} | ${term.decision} | ${raw} | ${adjusted} | ${markdownEscape(term.evidenceCode)} |`);
  }
  const topAbstained = prediction.goPrediction.terms.filter((term) => term.decision === "abstained").slice(0, 8);
  lines.push("", "### Highest-scoring abstentions", "");
  if (topAbstained.length === 0) lines.push("- None.");
  for (const term of topAbstained) {
    lines.push(`- \`${term.goId}\` ${term.termName}: ${(term.fusionAdjustedScore ?? term.semanticAdjustedScore ?? term.judgeAdjustedScore ?? term.phylogenyAdjustedScore ?? 0).toFixed(3)} — ${term.reasons.join(" ")}`);
  }
  lines.push("", "### GO method boundary", "", prediction.goPrediction.methodSummary, "");
  prediction.goPrediction.limitations.forEach((item) => lines.push(`- ${item}`));
  lines.push("", "## Key evidence", "", "| Evidence ID | Supports | Source label |", "| --- | --- | --- |");
  for (const evidence of prediction.keyEvidence) {
    const source = evidenceIndex.get(evidence.evidenceId);
    lines.push(`| ${markdownEscape(evidence.evidenceId)} | ${markdownEscape(evidence.supports)} | ${markdownEscape(source ? evidenceLabel(source) : "UNKNOWN ID")} |`);
  }
  lines.push("", "## Alternative functions", "");
  if (prediction.alternatives.length === 0) lines.push("No close alternative was retained.");
  for (const alternative of prediction.alternatives) {
    lines.push(`- **${alternative.function}** — ${alternative.rationale} (${alternative.evidenceIds.join(", ") || "no cited IDs"})`);
  }
  lines.push("", "## Conflicting evidence", "");
  if (prediction.conflictingEvidence.length === 0) lines.push("No material conflict was identified in the retained evidence.");
  else prediction.conflictingEvidence.forEach((item) => lines.push(`- ${item}`));
  lines.push("", "## Limitations", "");
  prediction.limitations.forEach((item) => lines.push(`- ${item}`));
  lines.push("", "## Recommended validation experiments", "");
  prediction.recommendedExperiments.forEach((item) => lines.push(`- ${item}`));
  lines.push("", "## Narrative review", "", critic.summary, "");
  for (const [label, items] of [
    ["Unsupported claims", critic.unsupportedClaims],
    ["Citation issues", critic.citationIssues],
    ["Double-counting risks", critic.doubleCountingRisks],
    ["Required revisions", critic.requiredRevisions],
  ] as const) {
    lines.push(`### ${label}`, "");
    if (items.length === 0) lines.push("- None.");
    else items.forEach((item) => lines.push(`- ${item}`));
    lines.push("");
  }
  lines.push("## Execution audit", "", "| Role | Model | Thinking | Session | Tokens | Cost |", "| --- | --- | --- | --- | ---: | ---: |");
  audits.forEach((audit) => {
    lines.push(`| ${audit.role} | ${audit.modelProvider}/${audit.modelId} | ${audit.thinkingLevel} | ${markdownEscape(audit.sessionFile ?? "in-memory")} | ${audit.stats.totalTokens} | ${audit.stats.cost.toFixed(6)} |`);
  });
  lines.push(
    "",
    "## RSI / evolution status",
    "",
    `${genome.genome.claimBoundary} This run records a versioned genome and replayable episode, but no external biological feedback or offspring promotion occurred.`,
    "",
    "## Scientific status",
    "",
    "This result is a computational hypothesis based on similarity and annotation evidence. It is not experimental validation.",
    "",
    "Machine-readable evidence and prediction files are stored beside this report.",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Human-facing report. The synthesizer/critic still produce the complete
 * machine-readable audit objects; this view deliberately presents their
 * approved conclusion as one final decision instead of exposing two internal
 * pipeline stages as reader-facing prose.
 */
export function renderMarkdown(input: ReportInput): string {
  const { prediction, critic, bundle, runId } = input;
  const evidenceIndex = collectEvidenceIndex(bundle);
  const lines = [
    "# Protein Function Prediction",
    "",
    `- Protein: \`${prediction.proteinId}\``,
    `- Run: \`${runId}\``,
    "",
    "## Conclusion",
    "",
    `**${prediction.mostLikelyFunction}**`,
    "",
    prediction.functionalDescription,
    "",
    `**Confidence: ${prediction.confidence}** — ${prediction.confidenceRationale}`,
    `**Evidence citations:** ${prediction.keyEvidence.map((item) => `\`${item.evidenceId}\``).join(", ")}`,
    "",
    "## Predicted GO labels",
    "",
    "| GO ID | Term | Aspect | Evidence score |",
    "| --- | --- | --- | ---: |",
  ];
  const selectedTerms = prediction.goPrediction.terms.filter((term) => term.selected);
  if (selectedTerms.length === 0) {
    lines.push("| — | No GO label passed the configured decision rule | — | — |");
  } else {
    for (const term of selectedTerms) {
      const score = term.fusionAdjustedScore ?? term.semanticAdjustedScore ?? term.judgeAdjustedScore ?? term.phylogenyAdjustedScore;
      lines.push(`| ${term.goId} | ${markdownEscape(term.termName)} | ${term.aspect} | ${score === null ? "—" : score.toFixed(3)} |`);
    }
  }
  lines.push("", "Scores are host-computed evidence rankings, not probabilities.");
  lines.push(
    "",
    "## Why this prediction",
    "",
    "| Evidence | Dimension | What it supports |",
    "| --- | --- | --- |",
  );
  for (const evidence of prediction.keyEvidence) {
    const source = evidenceIndex.get(evidence.evidenceId);
    const dimension = source
      ? String(source.source ?? source.method ?? source.provider ?? "database evidence")
      : "cited evidence";
    const sourceLabel = source ? evidenceLabel(source) : "Referenced machine-readable evidence";
    lines.push(`| ${markdownEscape(evidence.evidenceId)} | ${markdownEscape(dimension)} | ${markdownEscape(`${evidence.supports} Source: ${sourceLabel}`)} |`);
  }
  lines.push(
    "",
    "## Integrity check",
    "",
    critic.approved
      ? "The final conclusion passed citation coverage, blind-evidence, disclosure, and structured-output checks. Detailed critic findings and audit records remain available in the machine-readable artifacts."
      : "The final conclusion did not pass the independent integrity check; inspect the machine-readable critic artifact before using it.",
  );
  return `${lines.join("\n")}\n`;
}

type ReportedAspect = Exclude<GOAspect, "unknown">;

const REPORTED_ASPECTS: Array<{ key: ReportedAspect; label: string; shortLabel: string }> = [
  { key: "molecular_function", label: "Molecular Function", shortLabel: "Function" },
  { key: "biological_process", label: "Biological Process", shortLabel: "Process" },
  { key: "cellular_component", label: "Cellular Component", shortLabel: "Location" },
];

const REPORT_TEMPLATE_VERSION = "fixed-report-v2";
const GO_PREVIEW_LIMIT = 8;

function bundleItems(bundle: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = bundle[key];
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function finalGoScore(term: GOTermPrediction): number | null {
  return term.fusionAdjustedScore ?? term.semanticAdjustedScore ?? term.judgeAdjustedScore ?? term.phylogenyAdjustedScore;
}

function confidenceLabel(value: FinalPrediction["confidence"]): string {
  if (value === "high") return "High";
  if (value === "medium") return "Medium";
  if (value === "low") return "Low";
  return "Insufficient";
}

function selectionRoleLabel(term: GOTermPrediction): string {
  if (term.selectionRole === "entailed_ancestor") return "Entailed Ancestor";
  if (term.selectionRole === "primary_direct") return "Direct Hypothesis";
  return "Selected Hypothesis";
}

function evidenceDimension(evidenceId: string, source?: Record<string, unknown>): string {
  const hint = String(source?.source ?? source?.method ?? source?.provider ?? "").toLowerCase();
  if (evidenceId.startsWith("SEQ-") || hint.includes("sequence")) return "Sequence Similarity";
  if (evidenceId.startsWith("STR-") || hint.includes("structure") || hint.includes("foldseek")) return "Structure Similarity";
  if (evidenceId.startsWith("ANN-")) return "Curated Annotation";
  if (evidenceId.startsWith("CAND-") || source?.provider) return "Candidate Source";
  if (evidenceId.startsWith("PHY-")) return "Phylogeny Evidence";
  if (source?.residue_range) return "Domain Evidence";
  return "Supporting Evidence";
}

function renderList(items: string[], emptyMessage: string): string {
  if (items.length === 0) return `<p class="empty-state">${htmlEscape(emptyMessage)}</p>`;
  return `<ul>${items.map((item) => `<li>${htmlEscape(item)}</li>`).join("")}</ul>`;
}

function renderAlternativeList(prediction: FinalPrediction): string {
  if (prediction.alternatives.length === 0) return '<p class="empty-state">No Alternative Function Was Retained.</p>';
  return `<ul class="alternative-list">${prediction.alternatives.map((alternative) => {
    const citations = alternative.evidenceIds.length > 0
      ? `<div class="citation-row">${alternative.evidenceIds.map((id) => `<code>${htmlEscape(id)}</code>`).join("")}</div>`
      : "";
    return `<li><strong>${htmlEscape(alternative.function)}</strong><p>${htmlEscape(alternative.rationale)}</p>${citations}</li>`;
  }).join("")}</ul>`;
}

function renderEvidenceCards(input: ReportInput): string {
  const evidenceIndex = collectEvidenceIndex(input.bundle);
  if (input.prediction.keyEvidence.length === 0) {
    return '<p class="empty-state">No Key Evidence Was Retained.</p>';
  }
  return input.prediction.keyEvidence.map((evidence) => {
    const source = evidenceIndex.get(evidence.evidenceId);
    const label = source ? evidenceLabel(source) : "Referenced Machine-Readable Evidence";
    return `<article class="evidence-card">
      <div class="section-label">${htmlEscape(evidenceDimension(evidence.evidenceId, source))}</div>
      <h3>${htmlEscape(label)}</h3>
      <p>${htmlEscape(evidence.supports)}</p>
      <code>${htmlEscape(evidence.evidenceId)}</code>
    </article>`;
  }).join("");
}

function goTermSort(left: GOTermPrediction, right: GOTermPrediction): number {
  const roleRank = (term: GOTermPrediction): number => term.selectionRole === "entailed_ancestor" ? 1 : 0;
  const roleDifference = roleRank(left) - roleRank(right);
  if (roleDifference !== 0) return roleDifference;
  const scoreDifference = (finalGoScore(right) ?? -1) - (finalGoScore(left) ?? -1);
  if (scoreDifference !== 0) return scoreDifference;
  return left.goId.localeCompare(right.goId);
}

function renderGoRows(terms: GOTermPrediction[]): string {
  return terms.map((term) => {
    const score = finalGoScore(term);
    return `<tr>
      <td><code>${htmlEscape(term.goId)}</code><strong>${htmlEscape(term.termName)}</strong></td>
      <td><span class="role-chip ${term.selectionRole === "entailed_ancestor" ? "ancestor" : "direct"}">${selectionRoleLabel(term)}</span></td>
      <td>${htmlEscape(term.evidenceCode || "Unavailable")}</td>
      <td class="numeric">${term.evidenceIds.length}</td>
      <td class="numeric score">${score === null ? "Unavailable" : score.toFixed(3)}</td>
    </tr>`;
  }).join("");
}

function renderGoTableFrame(terms: GOTermPrediction[]): string {
  return `<div class="table-wrap"><table>
    <thead><tr><th>GO Label</th><th>Selection Role</th><th>Evidence Code</th><th>Evidence Records</th><th>Evidence Score</th></tr></thead>
    <tbody>${renderGoRows(terms)}</tbody>
  </table></div>`;
}

function renderGoTable(terms: GOTermPrediction[], aspectLabel: string): string {
  if (terms.length === 0) {
    return `<div class="empty-panel"><strong>No ${htmlEscape(aspectLabel)} Label Was Selected.</strong><span>The configured evidence and decision rules retained no prediction in this aspect.</span></div>`;
  }
  const sorted = [...terms].sort(goTermSort);
  const preview = sorted.slice(0, GO_PREVIEW_LIMIT);
  const remainder = sorted.slice(GO_PREVIEW_LIMIT);
  const folded = remainder.length > 0
    ? `<details class="go-more"><summary>Show ${remainder.length} More ${htmlEscape(aspectLabel)} Labels</summary>${renderGoTableFrame(remainder)}</details>`
    : "";
  return `${renderGoTableFrame(preview)}${folded}`;
}

export function renderHtml(input: ReportInput): string {
  const { prediction, critic, bundle, runId, genome } = input;
  const protein = bundle.protein && typeof bundle.protein === "object" && !Array.isArray(bundle.protein)
    ? bundle.protein as Record<string, unknown>
    : {};
  const selectedTerms = prediction.goPrediction.terms.filter((term) => term.selected);
  const aspectTerms = new Map<ReportedAspect, GOTermPrediction[]>(REPORTED_ASPECTS.map(({ key }) => [
    key,
    selectedTerms.filter((term) => term.aspect === key),
  ]));
  const unclassifiedTerms = selectedTerms.filter((term) => term.aspect === "unknown");
  const defaultAspect = REPORTED_ASPECTS.find(({ key }) => (aspectTerms.get(key)?.length ?? 0) > 0)?.key ?? "molecular_function";
  const sequenceHits = bundleItems(bundle, "sequence_hits").length;
  const structureHits = bundleItems(bundle, "structure_hits").length;
  const domainSegments = bundleItems(bundle, "domain_segments").length;
  const annotationCount = bundleItems(bundle, "uniprot_annotations").length + bundleItems(bundle, "pdb_annotations").length;
  const sequenceLength = Number.isFinite(Number(protein.sequence_length)) ? String(Number(protein.sequence_length)) : "Unavailable";
  const structureAvailable = protein.structure_available !== false;
  const inputModality = structureAvailable ? "Sequence And Structure" : "Sequence Only";
  const taxon = prediction.targetContext.taxon.taxonId === null ? "Unavailable" : String(prediction.targetContext.taxon.taxonId);
  const contextNotes = [
    ...(prediction.targetContext.taxon.taxonId === null ? [{
      title: "Target Taxonomy Not Provided",
      detail: "No caller-declared NCBI TaxID was supplied. Anonymous mode does not infer target taxonomy from similarity hits.",
    }] : []),
    ...(prediction.goPrediction.calibrationStatus === "unavailable" ? [{
      title: "Scores Are Not Calibrated",
      detail: "This genome has no fitted score-to-probability calibration model. Evidence scores are ranking heuristics, not probabilities.",
    }] : []),
    ...(structureAvailable && protein.structure_confidence_source !== "alphafold_plddt" ? [{
      title: "Structure Confidence Scaling Not Applied",
      detail: "The structure was searched, but its confidence values were not supplied through the supported AlphaFold pLDDT contract, so no confidence-based score scaling was applied.",
    }] : []),
  ];
  const contextHtml = contextNotes.length > 0
    ? `<details class="context-notes"><summary>${contextNotes.length} Context Note${contextNotes.length === 1 ? "" : "s"}</summary><ul>${contextNotes.map((note) => `<li><strong>${htmlEscape(note.title)}</strong><span>${htmlEscape(note.detail)}</span></li>`).join("")}</ul></details>`
    : "";
  const aspectControls = REPORTED_ASPECTS.map(({ key, label, shortLabel }) => {
    const count = aspectTerms.get(key)?.length ?? 0;
    return `<label for="go-${key}" class="aspect-control aspect-${key}"><span>${htmlEscape(label)}</span><strong>${count}</strong><small>${htmlEscape(shortLabel)} Labels</small></label>`;
  }).join("");
  const aspectPanels = REPORTED_ASPECTS.map(({ key, label }) => `<section class="go-panel panel-${key}" aria-labelledby="go-${key}-heading">
    <div class="panel-heading"><div><div class="section-label">Selected GO Hypotheses</div><h3 id="go-${key}-heading">${htmlEscape(label)}</h3></div><span>${aspectTerms.get(key)?.length ?? 0} Selected Labels</span></div>
    ${renderGoTable(aspectTerms.get(key) ?? [], label)}
  </section>`).join("");
  const unknownPanel = unclassifiedTerms.length > 0
    ? `<details class="audit-details"><summary>Unclassified Selected Terms (${unclassifiedTerms.length})</summary>${renderGoTable(unclassifiedTerms, "Unclassified")}</details>`
    : "";
  const confidence = confidenceLabel(prediction.confidence);
  const reviewWarning = critic.approved
    ? ""
    : '<div class="review-warning"><strong>Report Requires Manual Review.</strong> The structured critic did not approve this result.</div>';
  const narrativeSource = prediction.narrativeMode === "deterministic"
    ? "Deterministic Host Templates"
    : "Schema-Validated Pi Narrative Fields";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<title>Protein Function Prediction Report — ${htmlEscape(prediction.proteinId)}</title>
<style>
:root{--ink:#18242e;--muted:#5e6f79;--navy:#103f57;--navy-dark:#0b3043;--teal:#16768a;--line:#d8e4e7;--soft:#f1f6f6;--paper:#fff;--amber:#985707;--amber-bg:#fff7e8;--green:#267451;--green-bg:#edf8f2;--red:#a33d3d;--red-bg:#fff1f1;--mf:#7957a8;--bp:#287f6a;--cc:#376fb1;--shadow:0 12px 34px rgba(16,63,87,.08)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#edf3f3;color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.top-line{height:6px;background:linear-gradient(90deg,var(--navy),#1b8996 68%,#7cb89b)}.shell{width:min(1180px,calc(100% - 40px));margin:30px auto 60px}.skip-link{position:absolute;left:-9999px}.skip-link:focus{left:12px;top:12px;background:#fff;padding:9px 12px;z-index:20}.report-header{background:var(--navy);color:#fff;border-radius:18px;padding:31px 34px;box-shadow:var(--shadow)}.header-row{display:block}.section-label{font-size:12px;letter-spacing:.045em;color:var(--teal);font-weight:750}.report-header .section-label{color:#b9dce3}.report-header h1{font:650 clamp(27px,3.1vw,40px)/1.13 ui-serif,Georgia,serif;margin:7px 0 13px;max-width:760px}.meta{display:flex;flex-wrap:wrap;gap:9px 19px;color:#d5e7ea;font-size:13px}.meta code{color:#fff}.review-warning{margin-top:12px;border:1px solid #f0bcbc;border-radius:10px;padding:10px 12px;color:#ffe5e5;background:rgba(122,21,21,.23);font-size:13px}.scientific-status{margin:19px 0 0;padding:12px 15px;border-left:3px solid #e2b35c;background:rgba(0,0,0,.15);color:#f5e6c8;font-size:13px}.layout{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(280px,.8fr);gap:18px;margin-top:18px}.card{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:24px;box-shadow:var(--shadow)}.wide{grid-column:1/-1}.conclusion h2,.section-head h2{font:650 clamp(24px,2.5vw,32px)/1.18 ui-serif,Georgia,serif;color:var(--navy);margin:7px 0 12px}.conclusion>p{font-size:16px;max-width:800px}.confidence-row{display:flex;align-items:flex-start;gap:13px;border-top:1px solid var(--line);padding-top:18px;margin-top:19px}.confidence-badge{flex:none;border-radius:999px;padding:7px 12px;font-size:12px;font-weight:800}.confidence-badge.low,.confidence-badge.insufficient{color:var(--amber);background:var(--amber-bg);border:1px solid #edcf9b}.confidence-badge.medium{color:#185f78;background:#eaf7fb;border:1px solid #b7dce8}.confidence-badge.high{color:var(--green);background:var(--green-bg);border:1px solid #b8dfcb}.confidence-row p{font-size:13px;color:var(--muted);margin:2px 0 0}.facts{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-top:15px}.fact{background:var(--soft);padding:12px;border-radius:10px}.fact strong{display:block;color:var(--navy);font-size:18px}.fact span{font-size:11px;color:var(--muted);letter-spacing:.025em}.context-notes{border-top:1px solid var(--line);margin-top:14px;padding-top:11px}.context-notes summary{cursor:pointer;color:var(--muted);font-size:12px;font-weight:700}.context-notes ul{list-style:none;padding:0;margin:10px 0 0}.context-notes li{margin-top:9px}.context-notes strong,.context-notes span{display:block}.context-notes strong{font-size:12px;color:var(--ink)}.context-notes span{font-size:11px;color:var(--muted);margin-top:2px}.section-head,.panel-heading{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:17px}.section-head p,.panel-heading>span{color:var(--muted);font-size:13px;margin:0;max-width:580px}.evidence-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px}.evidence-card{border:1px solid var(--line);border-radius:12px;padding:16px;background:linear-gradient(180deg,#fff,var(--soft));min-width:0}.evidence-card h3{font-size:15px;line-height:1.35;margin:8px 0;overflow-wrap:anywhere}.evidence-card p{font-size:13px;color:var(--muted);margin:0 0 12px}.evidence-card code,.citation-row code{font-size:11px;color:var(--navy);overflow-wrap:anywhere}.go-tabs{border:0;padding:0;margin:0;min-width:0}.go-tabs>legend{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.go-tabs>input{position:absolute;opacity:0;pointer-events:none}.aspect-controls{display:grid;grid-template-columns:repeat(3,1fr);gap:11px;margin:2px 0 20px}.aspect-control{display:grid;grid-template-columns:1fr auto;gap:1px 12px;border-radius:12px;padding:15px 16px;color:#fff;cursor:pointer;opacity:.64;transition:opacity .15s ease,transform .15s ease,box-shadow .15s ease}.aspect-control:hover{opacity:.84;transform:translateY(-1px)}.aspect-control span{font-weight:750}.aspect-control strong{grid-row:1/3;grid-column:2;font-size:24px;align-self:center}.aspect-control small{opacity:.87}.aspect-molecular_function{background:var(--mf)}.aspect-biological_process{background:var(--bp)}.aspect-cellular_component{background:var(--cc)}#go-molecular_function:checked~.aspect-controls label[for="go-molecular_function"],#go-biological_process:checked~.aspect-controls label[for="go-biological_process"],#go-cellular_component:checked~.aspect-controls label[for="go-cellular_component"]{opacity:1;box-shadow:0 0 0 3px #fff,0 0 0 5px var(--navy);transform:none}#go-molecular_function:focus-visible~.aspect-controls label[for="go-molecular_function"],#go-biological_process:focus-visible~.aspect-controls label[for="go-biological_process"],#go-cellular_component:focus-visible~.aspect-controls label[for="go-cellular_component"]{outline:3px solid #111;outline-offset:3px}.go-panel{display:none}.go-panel h3{font:650 24px/1.2 ui-serif,Georgia,serif;color:var(--navy);margin:3px 0 0}#go-molecular_function:checked~.go-panels .panel-molecular_function,#go-biological_process:checked~.go-panels .panel-biological_process,#go-cellular_component:checked~.go-panels .panel-cellular_component{display:block}.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;min-width:840px}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:11px;letter-spacing:.025em;color:var(--muted);background:var(--soft)}tr:last-child td{border-bottom:0}td:first-child code{display:block;color:var(--navy);font-size:11px;margin-bottom:3px}td:first-child strong{font-weight:650}.numeric{text-align:right;font-variant-numeric:tabular-nums}.score{font-weight:750}.role-chip{display:inline-block;font-size:11px;border-radius:99px;padding:3px 8px;white-space:nowrap}.role-chip.direct{color:var(--green);background:var(--green-bg);border:1px solid #b8dfcb}.role-chip.ancestor{color:#665078;background:#f4effa;border:1px solid #d8c8e8}.score-note{font-size:12px;color:var(--muted);margin:12px 0 0}.score-note strong{color:var(--ink)}.go-more{margin-top:11px}.go-more summary{cursor:pointer;border:1px solid var(--line);border-radius:10px;padding:10px 13px;color:var(--navy);background:var(--soft);font-size:12px;font-weight:750}.go-more[open] summary{margin-bottom:10px}.empty-state{font-size:13px;color:var(--muted)}.empty-panel{border:1px dashed #bdcdd1;border-radius:12px;padding:24px;background:var(--soft)}.empty-panel strong,.empty-panel span{display:block}.empty-panel span{color:var(--muted);font-size:13px;margin-top:4px}.uncertainty-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.uncertainty-grid h3{font-size:15px;margin:0 0 9px;color:var(--navy)}.uncertainty-grid ul,.audit-details ul{margin:0;padding-left:20px}.uncertainty-grid li,.audit-details li{color:var(--muted);font-size:13px;margin-bottom:7px}.alternative-list{list-style:none;padding:0!important}.alternative-list li{border-left:3px solid #b6c9cd;padding:2px 0 2px 12px;margin-bottom:14px}.alternative-list p{margin:3px 0;color:var(--muted)}.citation-row{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}.audit-details{border-top:1px solid var(--line);margin-top:17px;padding-top:14px}.audit-details summary{cursor:pointer;font-weight:750;color:var(--navy)}.audit-details>p{color:var(--muted);font-size:13px}.technical-details{width:min(900px,100%);margin:0 auto;text-align:left;border-top:1px solid #cbd8da;padding-top:12px}.technical-details summary{cursor:pointer;text-align:center;color:var(--muted);font-weight:700}.technical-details p{font-size:12px;color:var(--muted)}.artifact-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}.artifact-links a{color:var(--navy);background:#fff;border:1px solid var(--line);border-radius:8px;padding:7px 10px;text-decoration:none;font-size:12px}.artifact-links a:hover{text-decoration:underline}.report-footer{text-align:center;color:var(--muted);font-size:12px;margin:21px}
@media(max-width:860px){.shell{width:min(100% - 22px,1180px)}.section-head,.panel-heading{display:block}.layout{grid-template-columns:1fr}.wide{grid-column:auto}.evidence-grid,.uncertainty-grid{grid-template-columns:1fr}.card,.report-header{padding:20px}.aspect-controls{grid-template-columns:1fr}.confidence-row{display:block}.confidence-row p{margin-top:10px}}
@media(max-width:480px){.facts{grid-template-columns:1fr}.meta{display:grid}.report-header h1{font-size:28px}}
@media print{body{background:#fff}.top-line,.aspect-controls{display:none}.shell{width:100%;margin:0}.report-header,.card{box-shadow:none;break-inside:avoid}.layout{display:block}.card{margin-top:12px}.go-panel{display:block!important;margin-top:18px}.audit-details>*,.go-more>*{display:block}.artifact-links,.technical-details{display:none}.scientific-status{border:1px solid #777}.table-wrap{overflow:visible}table{min-width:0;font-size:10px}th,td{padding:6px}}
</style>
</head>
<body data-report-template="${REPORT_TEMPLATE_VERSION}">
<a class="skip-link" href="#report-main">Skip To Report</a><div class="top-line"></div>
<div class="shell">
<header class="report-header">
  <div class="header-row"><div><div class="section-label">Evidence-Reasoned Result</div><h1>Protein Function Prediction Report</h1><div class="meta"><span>Protein <code>${htmlEscape(prediction.proteinId)}</code></span><span>Run <code>${htmlEscape(runId)}</code></span><span>${htmlEscape(sequenceLength)} Amino Acids</span><span>${htmlEscape(inputModality)}</span><span>Taxonomy ${htmlEscape(taxon)}</span></div></div></div>
  <p class="scientific-status"><strong>Scientific Status:</strong> This result is a computational hypothesis based on similarity and annotation evidence. It is not experimental validation.</p>${reviewWarning}
</header>
<main id="report-main" class="layout">
  <section class="card conclusion" aria-labelledby="conclusion-title"><div class="section-label">Most Likely Function</div><h2 id="conclusion-title">${htmlEscape(prediction.mostLikelyFunction)}</h2><p>${htmlEscape(prediction.functionalDescription)}</p><div class="confidence-row"><span class="confidence-badge ${htmlEscape(prediction.confidence)}">${htmlEscape(confidence)} Qualitative Confidence</span><p>${htmlEscape(prediction.confidenceRationale)}</p></div></section>
  <aside class="card" aria-label="Coverage At A Glance"><div class="section-label">Coverage At A Glance</div><div class="facts"><div class="fact"><strong>${sequenceHits}</strong><span>Sequence Hits</span></div><div class="fact"><strong>${structureHits}</strong><span>Structure Hits</span></div><div class="fact"><strong>${domainSegments}</strong><span>Domain Segments</span></div><div class="fact"><strong>${annotationCount}</strong><span>Annotations</span></div></div>${contextHtml}</aside>
  <section class="card wide" aria-labelledby="evidence-title"><div class="section-head"><div><div class="section-label">Supporting Evidence</div><h2 id="evidence-title">Why This Prediction</h2></div></div><div class="evidence-grid">${renderEvidenceCards(input)}</div></section>
  <section class="card wide" aria-labelledby="go-title"><div class="section-head"><div><div class="section-label">Gene Ontology</div><h2 id="go-title">Selected GO Hypotheses</h2></div></div>
    <fieldset class="go-tabs"><legend>Select A Gene Ontology Aspect</legend>
      ${REPORTED_ASPECTS.map(({ key }) => `<input type="radio" name="go-aspect" id="go-${key}"${key === defaultAspect ? " checked" : ""}>`).join("")}
      <div class="aspect-controls">${aspectControls}</div><div class="go-panels">${aspectPanels}</div>
    </fieldset>
    <p class="score-note"><strong>Interpretation:</strong> Evidence scores are host-computed ranking heuristics, not probabilities. A score of 0.700 does not mean 70% confidence.</p>${unknownPanel}
  </section>
  <section class="card wide" aria-labelledby="uncertainty-title"><div class="section-head"><div><div class="section-label">Uncertainty And Next Steps</div><h2 id="uncertainty-title">What Could Change This Conclusion</h2></div></div><div class="uncertainty-grid"><div><h3>Alternative Functions</h3>${renderAlternativeList(prediction)}</div><div><h3>Conflicting Evidence</h3>${renderList(prediction.conflictingEvidence, "No Material Conflict Was Identified In The Retained Evidence.")}</div></div><details class="audit-details"><summary>Known Limitations (${prediction.limitations.length})</summary>${renderList(prediction.limitations, "No Limitation Was Reported.")}</details><details class="audit-details"><summary>Recommended Validation Experiments (${prediction.recommendedExperiments.length})</summary>${renderList(prediction.recommendedExperiments, "No Validation Experiment Was Recommended.")}</details></section>
</main>
<footer class="report-footer"><details class="technical-details"><summary>Technical Details</summary><p>Page structure, labels, ordering, controls, and explanatory copy are fixed by host template <code>${REPORT_TEMPLATE_VERSION}</code>. Biological values are inserted only from validated structured artifacts. Narrative source: ${htmlEscape(narrativeSource)}.</p><p>Genome <code>${htmlEscape(genome.genome.genomeId)}</code>, generation ${htmlEscape(String(genome.genome.generation))}. Method <code>${htmlEscape(prediction.goPrediction.methodId)}</code>. ${input.quarantinedRecordCount} query-like record(s) were quarantined.</p><div class="artifact-links" aria-label="Machine Readable Artifacts"><a href="final_prediction.json">Final Prediction</a><a href="blind_go_view.json">Selected GO Data</a><a href="critic_review.json">Critic Review</a><a href="../evidence/blind_evidence_bundle.json">Blind Evidence Bundle</a><a href="../run_manifest.json">Run Manifest</a></div></details><p>Static, Offline-First, Evidence-Reasoned Protein Function Report</p></footer>
</div>
</body>
</html>\n`;
}

export async function writeReports(input: ReportInput & { runDir: string }): Promise<{ markdown: string; html: string }> {
  const predictionDir = join(input.runDir, "prediction");
  await mkdir(predictionDir, { recursive: true });
  const markdown = renderMarkdown(input);
  const html = renderHtml(input);
  const markdownPath = join(predictionDir, "function_prediction_report.md");
  const htmlPath = join(predictionDir, "function_prediction_report.html");
  await writeFile(markdownPath, markdown, "utf8");
  await writeFile(htmlPath, html, "utf8");
  return { markdown: markdownPath, html: htmlPath };
}
