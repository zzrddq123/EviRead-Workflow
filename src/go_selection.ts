import type { GOAspect, GOTermPrediction } from "./types.js";

export type GOSelectionMode = "disabled" | "evidence_frontier_v1";
export type GOSelectionPhase = "pre_judge" | "post_judge";

export interface GOSelectionInput {
  terms: GOTermPrediction[];
  mode?: GOSelectionMode;
  /** Restrict the evidence frontier to selected aspects; omitted means all. */
  frontierAspects?: readonly Exclude<GOAspect, "unknown">[];
  maxSelectedTermsPerAspect: number;
  phase: GOSelectionPhase;
  /** Existing direct-only host decisions that an optional candidate judge cannot replace. */
  protectedGoIds?: ReadonlySet<string>;
}

const ASPECTS = ["molecular_function", "biological_process", "cellular_component"] as const;
const SELECTOR_BLOCKERS = new Set<NonNullable<GOTermPrediction["selectionBlockers"]>[number]>([
  "per_aspect_budget",
  "source_hypothesis_not_selected",
]);
const SELECTOR_REASON_PREFIXES = [
  "Selector budget:",
  "Evidence frontier:",
];

function score(term: GOTermPrediction): number {
  return term.fusionAdjustedScore ?? term.semanticAdjustedScore ?? term.judgeAdjustedScore ?? term.phylogenyAdjustedScore ?? -1;
}

function deterministicRank(left: GOTermPrediction, right: GOTermPrediction): number {
  return score(right) - score(left) || left.goId.localeCompare(right.goId);
}

function rankWithProtected(terms: GOTermPrediction[], protectedGoIds: ReadonlySet<string>): GOTermPrediction[] {
  return [...terms].sort((left, right) => Number(protectedGoIds.has(right.goId)) - Number(protectedGoIds.has(left.goId))
    || deterministicRank(left, right));
}

function addBlocker(term: GOTermPrediction, blocker: NonNullable<GOTermPrediction["selectionBlockers"]>[number]): void {
  term.selectionBlockers = [...new Set([...(term.selectionBlockers ?? []), blocker])];
}

export function hasGOHardSelectionBlocker(term: GOTermPrediction): boolean {
  return (term.selectionBlockers ?? []).some((blocker) => blocker !== "below_threshold"
    && blocker !== "per_aspect_budget"
    && blocker !== "judge_candidate_budget"
    && blocker !== "source_hypothesis_not_selected");
}

function resetSelectorState(term: GOTermPrediction): void {
  term.selected = false;
  term.decision = "abstained";
  term.confidenceLabel = "abstained";
  term.selectionRole = "not_selected";
  term.selectionRank = null;
  term.selectionBlockers = (term.selectionBlockers ?? []).filter((blocker) => !SELECTOR_BLOCKERS.has(blocker));
  term.reasons = term.reasons.filter((reason) => !SELECTOR_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix)));
}

function select(term: GOTermPrediction, role: "primary_direct" | "entailed_ancestor"): void {
  term.selected = true;
  term.decision = "transfer_hypothesis";
  term.confidenceLabel = "low_heuristic";
  term.selectionRole = role;
}

function isDirect(term: GOTermPrediction): boolean {
  return term.candidateOrigin !== "ontology_ancestor";
}

function legacyAspectSelection(
  terms: GOTermPrediction[],
  aspect: Exclude<GOAspect, "unknown">,
  maxSelectedTermsPerAspect: number,
  protectedGoIds: ReadonlySet<string>,
  phase: GOSelectionPhase,
): void {
  const eligible = rankWithProtected(
    terms.filter((term) => term.aspect === aspect && term.preBudgetEligible === true),
    protectedGoIds,
  );
  eligible.forEach((term, index) => {
    term.selectionRank = index + 1;
    if (index < maxSelectedTermsPerAspect) {
      select(term, term.candidateOrigin === "ontology_ancestor" ? "entailed_ancestor" : "primary_direct");
      return;
    }
    addBlocker(term, "per_aspect_budget");
    term.reasons.push(phase === "post_judge"
      ? `Selector budget: exceeded the post-judge cap of ${maxSelectedTermsPerAspect} fixed terms for this aspect.`
      : `Selector budget: exceeded the fixed per-aspect cap of ${maxSelectedTermsPerAspect}.`);
  });
}

function frontierAspectSelection(
  terms: GOTermPrediction[],
  aspect: Exclude<GOAspect, "unknown">,
  maxSelectedTermsPerAspect: number,
  protectedGoIds: ReadonlySet<string>,
  phase: GOSelectionPhase,
): void {
  const direct = rankWithProtected(
    terms.filter((term) => term.aspect === aspect && isDirect(term) && term.preBudgetEligible === true),
    protectedGoIds,
  );
  direct.forEach((term, index) => {
    term.selectionRank = index + 1;
    if (index < maxSelectedTermsPerAspect) {
      select(term, "primary_direct");
      return;
    }
    addBlocker(term, "per_aspect_budget");
    term.reasons.push(phase === "post_judge"
      ? `Selector budget: direct hypothesis rank ${index + 1} exceeded the post-judge cap of ${maxSelectedTermsPerAspect} frontier hypotheses for this aspect.`
      : `Selector budget: direct hypothesis rank ${index + 1} exceeded the per-aspect frontier cap of ${maxSelectedTermsPerAspect}.`);
  });

  const selectedDirectGoIds = new Set(direct.slice(0, maxSelectedTermsPerAspect).map((term) => term.goId));
  const ancestors = terms
    .filter((term) => term.aspect === aspect && !isDirect(term))
    .sort((left, right) => (left.ontologyDepth ?? Number.MAX_SAFE_INTEGER) - (right.ontologyDepth ?? Number.MAX_SAFE_INTEGER)
      || deterministicRank(left, right));
  for (const ancestor of ancestors) {
    const entailed = (ancestor.sourceGoIds ?? []).some((sourceGoId) => selectedDirectGoIds.has(sourceGoId));
    if (entailed && !hasGOHardSelectionBlocker(ancestor)) {
      select(ancestor, "entailed_ancestor");
      ancestor.reasons.push("Evidence frontier: selected only as an ontology ancestor entailed by a selected direct source hypothesis.");
      continue;
    }
    if (!entailed) {
      addBlocker(ancestor, "source_hypothesis_not_selected");
      ancestor.reasons.push("Evidence frontier: no selected direct source hypothesis entailed this ontology ancestor.");
    }
  }
}

/**
 * Apply the sole per-aspect GO selector. Callers first set preBudgetEligible to
 * the deterministic host/judge eligibility for the phase. The function never
 * creates a candidate, relaxes a hard evidence gate, or reads query identity.
 */
export function applyGOSelection(input: GOSelectionInput): GOTermPrediction[] {
  if (!Number.isInteger(input.maxSelectedTermsPerAspect) || input.maxSelectedTermsPerAspect < 1) {
    throw new Error("GO selection cap must be a positive integer");
  }
  const mode = input.mode ?? "disabled";
  if (mode !== "disabled" && mode !== "evidence_frontier_v1") {
    throw new Error("Unsupported GO selection mode");
  }
  const protectedGoIds = input.protectedGoIds ?? new Set<string>();
  const frontierAspects = new Set(input.frontierAspects ?? ASPECTS);
  if (input.frontierAspects !== undefined && (frontierAspects.size !== input.frontierAspects.length
    || input.frontierAspects.length < 1
    || input.frontierAspects.some((aspect) => !ASPECTS.includes(aspect)))) {
    throw new Error("GO frontier aspects must be a non-empty unique list of known GO aspects");
  }
  for (const term of input.terms) {
    // Old prediction fixtures/artifacts did not persist this audit field. A
    // direct selector call therefore derives the same state from `selected`.
    if (term.preBudgetEligible === undefined) term.preBudgetEligible = term.selected;
    resetSelectorState(term);
  }
  for (const aspect of ASPECTS) {
    if (mode === "evidence_frontier_v1" && frontierAspects.has(aspect)) {
      frontierAspectSelection(input.terms, aspect, input.maxSelectedTermsPerAspect, protectedGoIds, input.phase);
    } else {
      legacyAspectSelection(input.terms, aspect, input.maxSelectedTermsPerAspect, protectedGoIds, input.phase);
    }
  }
  return input.terms;
}
