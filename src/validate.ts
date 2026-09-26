import { access, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

import { PROJECT_ROOT } from "./config.js";
import { canonicalAccession } from "./accession.js";
import { normalizeCandidateSourceBundle } from "./candidate_sources.js";
import {
  buildBlindEvidenceView,
  buildBlindGoView,
  goPolicyAdmittedCandidateEvidenceIds,
} from "./blind.js";
import { IMMUTABLE_SCIENTIFIC_CONTRACT } from "./genome.js";
import { inferGoPredictions, renderGoTsv } from "./go.js";
import {
  applyGOScoreFusion,
  applyGOJudgeResult,
  buildGOJudgeBinding,
  validateGOJudgeResult,
  validateGOJudgeView,
} from "./go_judge.js";
import {
  GO_ROOT_IDS,
  loadGoOntologySnapshot,
  resolveGoTerm,
  type GOOntology,
} from "./go_ontology.js";
import { canonicalJson, hashCanonical, sha256File, sha256Text } from "./hash.js";
import { canonicalPdb } from "./input.js";
import {
  applySemanticGOJudgeResult,
  buildSemanticGOJudgeBinding,
  renderSemanticPredictionTsv,
  semanticPredictionRows,
  validateSemanticGOJudgeResult,
} from "./semantic_go_judge.js";
import {
  assertLearnedPredictorCompleteness,
  learnedPredictorBindingFromEvidenceBundle,
} from "./learned_predictor_contract.js";
import type { GOPredictionSet, GenomeSnapshot, TargetContext } from "./types.js";

export interface RunValidationResult {
  ok: boolean;
  runDir: string;
  issues: string[];
}

export interface RunValidationOptions {
  /**
   * The default remains a deploy-time validation against the current
   * deterministic inference implementation.  The historical replay mode is
   * intentionally narrower: it is used only after a completed acquisition
   * receipt has byte-bound the source run, and omits only re-deriving that
   * historical GO document with today's inference code.
   */
  mode?: "strict" | "receipt_bound_historical_frozen_replay_source";
}

export type GuardedStrictGoRecompute<T> =
  | { value: T; completenessIssue?: never }
  | { value?: never; completenessIssue: string };

export function containsAccessionToken(text: string, accession: string): boolean {
  const canonical = canonicalAccession(accession);
  if (canonical.length < 4) return false;
  const escaped = canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^A-Z0-9])${escaped}(?:$|[^A-Z0-9])`,
    "i",
  ).test(text);
}

/**
 * Strict validation re-executes today's deterministic GO implementation, but
 * it must not manufacture a donor-only result for an old learned genome whose
 * persisted evidence lacks its provider receipt. Return a validation issue
 * instead of throwing so such historical runs remain inspectable (and remain
 * eligible for the explicit receipt-bound historical validation mode).
 */
export function guardedStrictGoRecompute<T>(input: {
  genome: GenomeSnapshot;
  evidenceBundle: Record<string, unknown>;
  recompute: () => T;
}): GuardedStrictGoRecompute<T> {
  try {
    assertLearnedPredictorCompleteness({
      genome: input.genome.genome,
      binding: learnedPredictorBindingFromEvidenceBundle(input.evidenceBundle),
      boundary: "strict artifact recomputation",
    });
  } catch (error) {
    return {
      completenessIssue: error instanceof Error ? error.message : String(error),
    };
  }
  return { value: input.recompute() };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(path: string, issues: string[]): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push(`expected JSON object: ${path}`);
      return {};
    }
    return value as Record<string, unknown>;
  } catch (error) {
    issues.push(`invalid JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

async function readSchema(name: string, issues: string[]): Promise<TSchema | undefined> {
  try {
    return JSON.parse(await readFile(join(PROJECT_ROOT, "schemas", name), "utf8")) as TSchema;
  } catch (error) {
    issues.push(`invalid runtime schema ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function validateSchema(
  label: string,
  schema: TSchema | undefined,
  value: unknown,
  issues: string[],
  context?: Record<PropertyKey, TSchema>,
): void {
  if (!schema) return;
  const valid = context ? Check(context, schema, value) : Check(schema, value);
  if (valid) return;
  const details = [...(context ? Errors(context, schema, value) : Errors(schema, value))]
    .slice(0, 4)
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("; ");
  issues.push(`${label} does not satisfy its runtime JSON schema${details ? ` (${details})` : ""}`);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object).filter((item): item is Record<string, unknown> => item !== undefined) : [];
}

function evidenceAccessions(item: Record<string, unknown>): string[] {
  const direct = [item.accession, item.pdb_id, item.annotation_accession, item.source_accession, item.provider_accession, item.provider_primary_accession]
    .map(canonicalAccession);
  const aliases = [
    ...(Array.isArray(item.alias_accessions) ? item.alias_accessions : []),
    ...(Array.isArray(item.aliases) ? item.aliases : []),
  ];
  const fromAliases = aliases.flatMap((alias) => {
    const value = object(alias);
    return value
      ? [value.accession, value.id].map(canonicalAccession)
      : [canonicalAccession(alias)];
  });
  return [...new Set([...direct, ...fromAliases].filter(Boolean))];
}

function collectPredictionCitations(prediction: Record<string, unknown>): Set<string> {
  const citations = new Set<string>();
  for (const item of objects(prediction.keyEvidence)) {
    if (item.evidenceId) citations.add(String(item.evidenceId));
  }
  for (const alternative of objects(prediction.alternatives)) {
    if (Array.isArray(alternative.evidenceIds)) alternative.evidenceIds.forEach((id) => citations.add(String(id)));
  }
  return citations;
}

function round6(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.0000011;
}

function independentGroupRootCount(supports: Record<string, unknown>[], supportFloor: number): number {
  const edges = new Map<string, string[]>();
  for (const support of supports) {
    if (Number(support.adjustedSupport) < supportFloor) continue;
    const group = String(support.donorGroup ?? "");
    const roots = Array.isArray(support.provenanceRoots) ? support.provenanceRoots.map(String) : [];
    edges.set(group, [...new Set([...(edges.get(group) ?? []), ...roots])].sort());
  }
  const owner = new Map<string, string>();
  const visit = (group: string, seen: Set<string>): boolean => {
    for (const root of edges.get(group) ?? []) {
      if (seen.has(root)) continue;
      seen.add(root);
      const current = owner.get(root);
      if (current === undefined || visit(current, seen)) {
        owner.set(root, group);
        return true;
      }
    }
    return false;
  };
  let count = 0;
  for (const group of [...edges.keys()].sort()) if (visit(group, new Set())) count += 1;
  return count;
}

function aggregateIndependentSupports(
  supports: Record<string, unknown>[],
  key: "rawSupport" | "adjustedSupport",
): number {
  const groups = [...new Set(supports.map((support) => String(support.donorGroup ?? "")))].sort();
  const parent = new Map(groups.map((group) => [group, group]));
  const find = (group: string): string => {
    const current = parent.get(group) ?? group;
    if (current === group) return group;
    const root = find(current);
    parent.set(group, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  };
  const rootGroups = new Map<string, string[]>();
  for (const support of supports) {
    for (const root of Array.isArray(support.provenanceRoots) ? support.provenanceRoots.map(String) : []) {
      rootGroups.set(root, [...new Set([...(rootGroups.get(root) ?? []), String(support.donorGroup ?? "")])].sort());
    }
  }
  for (const connected of rootGroups.values()) for (const group of connected.slice(1)) union(connected[0], group);
  const byComponent = new Map<string, number>();
  for (const support of supports) {
    const component = find(String(support.donorGroup ?? ""));
    byComponent.set(component, Math.max(byComponent.get(component) ?? 0, Number(support[key])));
  }
  const ranked = [...byComponent.values()].sort((a, b) => b - a);
  return round6(0.7 * (ranked[0] ?? 0) + 0.2 * (ranked[1] ?? 0) + 0.1 * (ranked[2] ?? 0));
}

function aggregateSupports(
  supports: Record<string, unknown>[],
  key: "rawSupport" | "adjustedSupport",
): number {
  const hybrid = supports.filter((support) =>
    support.candidateSourceType === "deepgoplus_hybrid");
  if (hybrid.length === 0) return aggregateIndependentSupports(supports, key);
  const host = supports.filter((support) =>
    support.candidateSourceType !== "deepgoplus_hybrid");
  const hostScore = host.length === 0 ? 0 : aggregateIndependentSupports(host, key);
  const hybridScore = Math.max(0, ...hybrid.map((support) => Number(support[key])));
  return round6(Math.max(hostScore, hybridScore));
}

const GO_SELECTION_ASPECTS = ["molecular_function", "biological_process", "cellular_component"] as const;

/**
 * Validate the deploy-time meaning of the optional evidence frontier.
 *
 * The ordinary selector caps every selected term and requires every selected
 * score to clear its aspect threshold.  The frontier instead caps primary
 * direct hypotheses, then emits only ontology ancestors entailed by one of
 * those selected direct hypotheses.  Those closure terms do not spend a
 * primary-hypothesis slot and may have a decayed score below the leaf
 * threshold; every such exception is source-bound and checked here.
 */
export function goSelectionContractIssues(goValue: unknown, genomeValue: unknown): string[] {
  const issues: string[] = [];
  const go = object(goValue);
  const genome = object(genomeValue);
  if (!go || !genome) return ["GO selection contract requires prediction and genome objects"];
  const policy = object(genome.goPolicy) ?? {};
  const selectionPolicy = object(policy.selectionPolicy);
  const frontierEnabled = selectionPolicy?.mode === "evidence_frontier_v1";
  const configuredAspects = Array.isArray(selectionPolicy?.aspects)
    ? selectionPolicy.aspects.map(String)
    : [...GO_SELECTION_ASPECTS];
  const frontierAspects = new Set(frontierEnabled ? configuredAspects : []);
  const emittedAspects = Array.isArray(go.selectionPolicyAspects)
    ? go.selectionPolicyAspects.map(String)
    : undefined;

  if (frontierEnabled) {
    if (go.selectionPolicyMode !== "evidence_frontier_v1") {
      issues.push("GO selection policy mode does not match genome frontier policy");
    }
    if (selectionPolicy?.aspects === undefined) {
      if (emittedAspects !== undefined) issues.push("GO selection policy unexpectedly narrows an all-aspect frontier");
    } else if (canonicalJson([...(new Set(emittedAspects ?? []))].sort()) !== canonicalJson([...(new Set(configuredAspects))].sort())) {
      issues.push("GO selection policy aspects do not match genome frontier policy");
    }
  } else if (go.selectionPolicyMode !== undefined || emittedAspects !== undefined) {
    issues.push("GO prediction declares a frontier that the genome does not enable");
  }

  const maxPerAspect = Number(policy.maxSelectedTermsPerAspect);
  const thresholds = object(go.thresholds) ?? {};
  const terms = objects(go.terms);
  const termById = new Map(terms.map((term) => [String(term.goId ?? ""), term]));

  for (const aspect of GO_SELECTION_ASPECTS) {
    const selected = terms.filter((term) => term.selected === true && term.aspect === aspect);
    const frontierForAspect = frontierAspects.has(aspect);
    const budgeted = frontierForAspect
      ? selected.filter((term) => term.selectionRole !== "entailed_ancestor")
      : selected;
    if (!Number.isInteger(maxPerAspect) || maxPerAspect < 1 || budgeted.length > maxPerAspect) {
      issues.push(`selected GO primary hypotheses exceed genome cap for ${aspect}`);
    }

    for (const term of selected) {
      const goId = String(term.goId ?? "");
      const role = String(term.selectionRole ?? "");
      const isFrontierAncestor = frontierForAspect
        && term.candidateOrigin === "ontology_ancestor"
        && role === "entailed_ancestor";
      if (isFrontierAncestor) {
        const sourceGoIds = Array.isArray(term.sourceGoIds) ? term.sourceGoIds.map(String) : [];
        const hasSelectedDirectSource = sourceGoIds.some((sourceGoId) => {
          const source = termById.get(sourceGoId);
          return source?.selected === true
            && source.aspect === aspect
            && source.candidateOrigin !== "ontology_ancestor"
            && source.selectionRole === "primary_direct";
        });
        if (go.dagProjectionStatus !== "ancestor_closure_applied"
          || !Number.isInteger(term.ontologyDepth) || Number(term.ontologyDepth) < 1
          || !hasSelectedDirectSource) {
          issues.push(`selected frontier ancestor is not entailed by a selected direct hypothesis: ${goId}`);
        }
        if (term.selectionRank !== null) issues.push(`selected frontier ancestor must not consume a ranked hypothesis slot: ${goId}`);
        const blockers = Array.isArray(term.selectionBlockers) ? term.selectionBlockers.map(String) : [];
        if (blockers.some((blocker) => blocker !== "below_threshold")) {
          issues.push(`selected frontier ancestor retains a hard selection blocker: ${goId}`);
        }
        continue;
      }

      const threshold = Number(thresholds[aspect]);
      const fusionAdjusted = term.fusionAdjustedScore;
      const semanticAdjusted = term.semanticAdjustedScore;
      const judgeAdjusted = term.judgeAdjustedScore;
      const adjusted = term.phylogenyAdjustedScore;
      const selectionScore = fusionAdjusted === undefined
        ? (semanticAdjusted === undefined
          ? (judgeAdjusted === undefined ? adjusted : judgeAdjusted)
          : semanticAdjusted)
        : fusionAdjusted;
      if (!Number.isFinite(threshold) || selectionScore === null || selectionScore === undefined
        || !Number.isFinite(Number(selectionScore)) || Number(selectionScore) < threshold) {
        issues.push(`selected transfer below threshold: ${goId}`);
      }
      if (frontierForAspect) {
        if (term.candidateOrigin === "ontology_ancestor" || role !== "primary_direct" || term.preBudgetEligible !== true) {
          issues.push(`selected frontier primary is not an eligible direct hypothesis: ${goId}`);
        }
        if (!Number.isInteger(term.selectionRank) || Number(term.selectionRank) < 1 || Number(term.selectionRank) > maxPerAspect) {
          issues.push(`selected frontier primary has an invalid budget rank: ${goId}`);
        }
      }
    }
  }
  return issues;
}

function evidenceIndex(bundle: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const output = new Map<string, Record<string, unknown>>();
  for (const section of ["sequence_hits", "structure_hits", "domain_segments", "uniprot_annotations", "pdb_annotations", "negative_search_evidence", "intrinsic_evidence"]) {
    for (const item of objects(bundle[section])) {
      const evidenceId = String(item.evidence_id ?? "");
      if (evidenceId) output.set(evidenceId, item);
    }
  }
  const candidateSources = object(bundle.candidate_sources) ?? {};
  for (const item of objects(candidateSources.go_candidates ?? candidateSources.candidates)) {
    const evidenceId = String(item.evidence_id ?? item.evidenceId ?? "");
    if (evidenceId) output.set(evidenceId, item);
  }
  return output;
}

/**
 * Validate the private identity quarantine against both donor annotations and
 * provider candidate rows.  Candidate IDs are resolved through the same
 * pinned ontology used by inference so an alt_id is compared as its active
 * canonical GO ID.
 */
export function goQuarantineContractIssues(
  goValue: unknown,
  bundleValue: unknown,
  genomeValue: unknown,
  ontology?: GOOntology,
): string[] {
  const go = object(goValue);
  const bundle = object(bundleValue);
  const genome = object(genomeValue);
  if (!go || !bundle || !genome) {
    return ["GO quarantine contract requires prediction, evidence bundle, and genome objects"];
  }
  const queryLikeAccessions = new Set(
    Array.isArray(go.queryLikeAccessions)
      ? go.queryLikeAccessions.map(canonicalAccession).filter(Boolean)
      : [],
  );
  const canonicalActiveGoId = (goId: string): string =>
    ontology ? (resolveGoTerm(ontology, goId)?.id ?? goId) : goId;
  const annotationQuarantined = objects(bundle.uniprot_annotations)
    .filter((annotation) => queryLikeAccessions.has(canonicalAccession(annotation.accession)))
    .flatMap((annotation) => objects(annotation.go_terms).map((term) => String(term.id ?? "").toUpperCase()))
    .filter((goId) => /^GO:\d{7}$/.test(goId));
  const goPolicy = object(genome.goPolicy) ?? {};
  const candidatePolicy = object(goPolicy.candidateSourcePolicy);
  const learnedPolicy = object(goPolicy.learnedPredictorPolicy);
  const learnedSources = new Set([
    "mdeepfri_cnn",
    "mdeepfri_gcn",
    "deepgoplus_cnn",
    "deepgoplus_hybrid",
  ]);
  const enabledCandidateSource = (sourceType: string): boolean => {
    const policy = learnedSources.has(sourceType) ? learnedPolicy : candidatePolicy;
    const expectedMode = learnedSources.has(sourceType) ? "candidate_channel" : "storage_light";
    return policy?.mode === expectedMode
      && Array.isArray(policy.allowedSources)
      && policy.allowedSources.map(String).includes(sourceType);
  };
  const phylogenyEnabled = object(goPolicy.phylogenyPolicy)?.mode === "orthology_aware";
  const candidateQuarantined = normalizeCandidateSourceBundle(bundle).candidates
    .filter((candidate) =>
      enabledCandidateSource(candidate.sourceType)
      && (candidate.queryLike
        || (candidate.donorAccession !== null
          && queryLikeAccessions.has(canonicalAccession(candidate.donorAccession)))
        || (phylogenyEnabled && candidate.phylogeny?.queryLike === true)))
    .map((candidate) => candidate.goId);
  const expected = [...new Set(
    [...annotationQuarantined, ...candidateQuarantined].map(canonicalActiveGoId),
  )].sort();
  const declared = Array.isArray(go.quarantinedGoIds) ? go.quarantinedGoIds.map(String) : [];
  return canonicalJson(declared) === canonicalJson(expected)
    ? []
    : ["quarantinedGoIds does not match query-like annotation and candidate-source records"];
}

function validateGo(
  go: Record<string, unknown>,
  bundle: Record<string, unknown>,
  validIds: Set<string>,
  issues: string[],
  genome?: Record<string, unknown>,
  ontology?: GOOntology,
): void {
  if (go.schemaVersion !== "pi-go-prediction.v3") issues.push("unsupported GO prediction schemaVersion");
  if (go.calibrationStatus !== "unavailable") issues.push("MVP GO calibrationStatus must be unavailable");
  if (go.dagProjectionStatus !== "not_applied" && go.dagProjectionStatus !== "ancestor_closure_applied") {
    issues.push("unsupported GO dagProjectionStatus");
  }
  const ontologyBinding = object(go.ontologyBinding);
  if (go.dagProjectionStatus === "ancestor_closure_applied" && !ontologyBinding) {
    issues.push("ontology ancestor closure has no pinned ontology binding");
  }
  if (go.dagProjectionStatus === "not_applied" && ontologyBinding) {
    issues.push("ontology binding is present when DAG projection was not applied");
  }
  if (go.identityPolicy !== "strict_blind_v1" && go.identityPolicy !== "temporal_t0_v1") issues.push("unsupported GO identityPolicy");
  if (go.targetMode === "anonymous" && go.queryAccession !== null) issues.push("anonymous GO output must not declare a query accession");
  const canonicalHash = String(go.canonicalHash ?? "");
  const { canonicalHash: _ignored, ...withoutHash } = go;
  if (canonicalHash !== hashCanonical(withoutHash)) issues.push("GO canonicalHash does not match canonical content");

  const thresholds = object(go.thresholds) ?? {};
  const terms = objects(go.terms);
  const queryLikeAccessions = new Set(Array.isArray(go.queryLikeAccessions) ? go.queryLikeAccessions.map(canonicalAccession).filter(Boolean) : []);
  const explicitlyExcluded = Array.isArray(go.explicitlyExcludedAccessions) ? go.explicitlyExcludedAccessions.map(canonicalAccession).filter(Boolean) : [];
  for (const accession of explicitlyExcluded) if (!queryLikeAccessions.has(accession)) issues.push("an explicitly excluded accession is absent from the private quarantine set");
  const seen = new Set<string>();
  const predictedIds: string[] = [];
  for (const term of terms) {
    const goId = String(term.goId ?? "");
    if (!/^GO:\d{7}$/.test(goId)) issues.push(`invalid GO identifier: ${goId || "<empty>"}`);
    if (seen.has(goId)) issues.push(`duplicate GO term: ${goId}`);
    seen.add(goId);
    const decision = String(term.decision ?? "");
    const selected = term.selected === true;
    const raw = term.rawScore === null ? null : Number(term.rawScore);
    const adjusted = term.phylogenyAdjustedScore === null ? null : Number(term.phylogenyAdjustedScore);
    const judgeAdjusted = term.judgeAdjustedScore === undefined
      ? undefined
      : term.judgeAdjustedScore === null ? null : Number(term.judgeAdjustedScore);
    const semanticAdjusted = term.semanticAdjustedScore === undefined
      ? undefined
      : term.semanticAdjustedScore === null ? null : Number(term.semanticAdjustedScore);
    const fusionAdjusted = term.fusionAdjustedScore === undefined
      ? undefined
      : term.fusionAdjustedScore === null ? null : Number(term.fusionAdjustedScore);
    if (raw === null || !Number.isFinite(raw) || raw < 0 || raw > 1) issues.push(`GO rawScore outside [0,1]: ${goId}`);
    if (adjusted === null || !Number.isFinite(adjusted) || adjusted < 0 || adjusted > 1) issues.push(`GO phylogenyAdjustedScore outside [0,1]: ${goId}`);
    if (judgeAdjusted !== undefined
      && (judgeAdjusted === null || !Number.isFinite(judgeAdjusted) || judgeAdjusted < 0 || judgeAdjusted > 1)) {
      issues.push(`GO judgeAdjustedScore outside [0,1]: ${goId}`);
    }
    if (semanticAdjusted !== undefined
      && (semanticAdjusted === null || !Number.isFinite(semanticAdjusted) || semanticAdjusted < 0 || semanticAdjusted > 1)) {
      issues.push(`GO semanticAdjustedScore outside [0,1]: ${goId}`);
    }
    if (fusionAdjusted !== undefined
      && (fusionAdjusted === null || !Number.isFinite(fusionAdjusted) || fusionAdjusted < 0 || fusionAdjusted > 1)) {
      issues.push(`GO fusionAdjustedScore outside [0,1]: ${goId}`);
    }
    const judgment = object(term.agentJudgment);
    if (judgment) {
      const factor = Number(judgment.factor);
      const expectedJudgeScore = adjusted === null ? null : round6(Math.max(0, Math.min(1, adjusted * factor)));
      if (judgeAdjusted === undefined || expectedJudgeScore === null || !closeEnough(Number(judgeAdjusted), expectedJudgeScore)) {
        issues.push(`GO judge-adjusted score is inconsistent with its host factor: ${goId}`);
      }
      for (const evidenceId of Array.isArray(judgment.citedEvidenceIds) ? judgment.citedEvidenceIds.map(String) : []) {
        if (!validIds.has(evidenceId)) issues.push(`GO judge for ${goId} cites unknown evidence ID: ${evidenceId}`);
      }
    } else if (judgeAdjusted !== undefined) {
      issues.push(`GO term has a judge-adjusted score without a judgment: ${goId}`);
    }
    const semanticJudgment = object(term.semanticJudgment);
    if (semanticJudgment) {
      for (const evidenceId of Array.isArray(semanticJudgment.citedEvidenceIds) ? semanticJudgment.citedEvidenceIds.map(String) : []) {
        if (!validIds.has(evidenceId)) issues.push(`GO semantic judgment for ${goId} cites unknown evidence ID: ${evidenceId}`);
      }
      if (semanticAdjusted === undefined) issues.push(`GO term has a semantic judgment without a semantic score: ${goId}`);
    } else if (semanticAdjusted !== undefined && term.candidateOrigin !== "ontology_ancestor") {
      issues.push(`direct GO term has a semantic score without a semantic judgment: ${goId}`);
    }
    if (selected !== (decision === "transfer_hypothesis")) {
      issues.push(`GO selected/decision mismatch: ${goId}`);
    }
    if (selected) predictedIds.push(goId);
    if (term.calibrationStatus !== "unavailable") issues.push(`term calibrationStatus must be unavailable: ${goId}`);
    for (const evidenceId of Array.isArray(term.evidenceIds) ? term.evidenceIds.map(String) : []) {
      if (!validIds.has(evidenceId)) issues.push(`GO term ${goId} cites unknown evidence ID: ${evidenceId}`);
    }
    for (const support of objects(term.donorSupports)) {
      const annotationId = String(support.annotationEvidenceId ?? "");
      if (!validIds.has(annotationId)) issues.push(`GO donor for ${goId} has unknown annotation evidence ID: ${annotationId}`);
      for (const matchId of Array.isArray(support.matchEvidenceIds) ? support.matchEvidenceIds.map(String) : []) {
        if (!validIds.has(matchId)) issues.push(`GO donor for ${goId} has unknown match evidence ID: ${matchId}`);
      }
      if (!Array.isArray(support.provenanceRoots)) issues.push(`GO donor for ${goId} has no provenanceRoots array`);
      const supportNumbers = ["similarityScore", "evidenceWeight", "structureQualityFactor", "lineageFactor", "rawSupport", "adjustedSupport"];
      for (const field of supportNumbers) {
        const value = Number(support[field]);
        if (!Number.isFinite(value) || value < 0 || value > 1) issues.push(`GO donor ${goId} has invalid ${field}`);
      }
      if (support.sequenceSimilarityScore !== undefined) {
        const value = Number(support.sequenceSimilarityScore);
        if (!Number.isFinite(value) || value < 0 || value > 1) issues.push(`GO donor ${goId} has invalid sequenceSimilarityScore`);
        if (support.hasSequence !== true && value > 0) issues.push(`GO donor ${goId} has a sequence score without hasSequence=true`);
      }
      const donorAccession = canonicalAccession(support.accession);
      if (queryLikeAccessions.has(donorAccession)) issues.push("a quarantined query-like record was used as a GO donor");
    }
  }
  const declaredPredicted = Array.isArray(go.predictedGoIds) ? go.predictedGoIds.map(String) : [];
  if (canonicalJson(declaredPredicted) !== canonicalJson([...new Set(predictedIds)].sort())) issues.push("predictedGoIds does not match selected transfer terms");
  if (genome) issues.push(...goQuarantineContractIssues(go, bundle, genome, ontology));
  else issues.push("GO quarantine validation has no genome policy");
}

function validateGoPolicy(go: Record<string, unknown>, genome: Record<string, unknown>, issues: string[]): void {
  issues.push(...goSelectionContractIssues(go, genome));
  const policy = object(genome.goPolicy) ?? {};
  const candidatePolicy = object(policy.candidateSourcePolicy);
  const learnedPolicy = object(policy.learnedPredictorPolicy);
  const weights = object(policy.evidenceWeights) ?? {};
  const unknownWeight = Number(policy.unknownEvidenceWeight);
  const supportFloor = Number(policy.minimumDonorGroupSupport);
  const minimumRoots = Number(policy.minimumIndependentProvenanceRoots);
  const requireTwoGroups = policy.requireTwoStructureDonorGroups === true;
  const terms = objects(go.terms);
  const goRootIds = new Set<string>(Object.values(GO_ROOT_IDS));

  for (const term of terms) {
    const goId = String(term.goId ?? "");
    const supports = objects(term.donorSupports);
    const byGroupRaw = new Map<string, number>();
    const byGroupAdjusted = new Map<string, number>();
    for (const support of supports) {
      const code = String(support.evidenceCode ?? "");
      const ordinaryWeight = Number(weights[code] ?? unknownWeight);
      const learnedSource = ["mdeepfri_cnn", "mdeepfri_gcn", "deepgoplus_cnn", "deepgoplus_hybrid"]
        .includes(String(support.candidateSourceType ?? ""));
      const expectedWeight = learnedSource
        ? Number(learnedPolicy?.scoreScale)
        : support.candidateSourceType === undefined
          || support.candidateSelectionEligible === false
          ? ordinaryWeight
          : Math.max(ordinaryWeight, Number(candidatePolicy?.minimumEvidenceWeight ?? 0));
      const actualWeight = Number(support.evidenceWeight);
      if (!Number.isFinite(expectedWeight) || !closeEnough(actualWeight, expectedWeight)) {
        issues.push(`GO donor ${goId} evidence weight does not match genome policy`);
      }
      const expectedRaw = learnedSource && support.candidateSelectionEligible === false
        ? 0
        : round6(Number(support.similarityScore) * actualWeight);
      if (!closeEnough(Number(support.rawSupport), expectedRaw)) issues.push(`GO donor ${goId} raw support is inconsistent`);
      const expectedAdjusted = round6(Number(support.rawSupport) * Number(support.lineageFactor));
      if (!closeEnough(Number(support.adjustedSupport), expectedAdjusted)) issues.push(`GO donor ${goId} adjusted support is inconsistent`);
      if (support.candidateSourceType !== "deepgoplus_hybrid") {
        const group = String(support.donorGroup ?? "");
        byGroupRaw.set(group, Math.max(byGroupRaw.get(group) ?? 0, Number(support.rawSupport)));
        byGroupAdjusted.set(group, Math.max(byGroupAdjusted.get(group) ?? 0, Number(support.adjustedSupport)));
      }
    }
    if (!closeEnough(Number(term.rawScore), aggregateSupports(supports, "rawSupport"))) issues.push(`GO term raw score is inconsistent: ${goId}`);
    if (!closeEnough(Number(term.phylogenyAdjustedScore), aggregateSupports(supports, "adjustedSupport"))) issues.push(`GO term adjusted score is inconsistent: ${goId}`);

    if (term.selected === true) {
      if (goRootIds.has(goId)
        && supports.some((support) => support.candidateSourceType === "deepgoplus_hybrid")) {
        issues.push(`DeepGOPlus hybrid selected a GO namespace root: ${goId}`);
      }
      // The evidence-frontier contract separately proves that an entailed
      // ancestor has a selected, eligible direct source hypothesis in the same
      // aspect. Reapplying leaf-transfer gates to that safe is_a/part_of
      // closure incorrectly rejects BP/CC ancestors after their direct child
      // has already passed the evidence gate.
      if (
        term.selectionRole === "entailed_ancestor"
        && term.candidateOrigin === "ontology_ancestor"
      ) {
        continue;
      }
      const threshold = Number((object(go.thresholds) ?? {})[String(term.aspect)]);
      const hasSequence = supports.some((support) => {
        if ((policy.sequenceEligibilityMode ?? "primary_only") === "primary_only") {
          return support.matchMode === "sequence" && Number(support.adjustedSupport) >= threshold;
        }
        const sequenceScore = support.sequenceSimilarityScore === undefined
          ? (support.matchMode === "sequence" ? Number(support.similarityScore) : 0)
          : Number(support.sequenceSimilarityScore);
        return (support.hasSequence === true || support.matchMode === "sequence")
          && round6(sequenceScore * Number(support.evidenceWeight) * Number(support.lineageFactor)) >= threshold;
      });
      const eligibleCandidateSupports = supports.filter((support) => support.candidateSourceType !== undefined
        && support.candidateSelectionEligible !== false);
      const standardCandidateSupports = eligibleCandidateSupports.filter((support) =>
        !["mdeepfri_cnn", "mdeepfri_gcn", "deepgoplus_cnn", "deepgoplus_hybrid"].includes(String(support.candidateSourceType)));
      const learnedCandidateSupports = eligibleCandidateSupports.filter((support) =>
        ["mdeepfri_cnn", "mdeepfri_gcn", "deepgoplus_cnn", "deepgoplus_hybrid"].includes(String(support.candidateSourceType)));
      const candidateRoots = new Set(standardCandidateSupports
        .filter((support) => Number(support.adjustedSupport) >= supportFloor)
        .flatMap((support) => Array.isArray(support.provenanceRoots) ? support.provenanceRoots.map(String) : []));
      const learnedRoots = new Set(learnedCandidateSupports
        .filter((support) => Number(support.adjustedSupport) >= supportFloor)
        .flatMap((support) => Array.isArray(support.provenanceRoots) ? support.provenanceRoots.map(String) : []));
      const standardCandidateTransferAllowed = candidatePolicy?.mode === "storage_light"
        && candidateRoots.size >= Number(candidatePolicy.requireIndependentRoots ?? 1)
        && standardCandidateSupports.some((support) => Number(support.adjustedSupport) >= threshold
          && support.leafTransferAllowed !== false);
      const learnedCandidateTransferAllowed = learnedPolicy?.mode === "candidate_channel"
        && learnedRoots.size >= Number(learnedPolicy.requireIndependentRoots ?? 1)
        && learnedCandidateSupports.some((support) => Number(support.adjustedSupport) >= threshold
          && support.leafTransferAllowed !== false);
      const candidateTransferAllowed = standardCandidateTransferAllowed || learnedCandidateTransferAllowed;
      if (!hasSequence && !candidateTransferAllowed) {
        if (term.aspect !== "molecular_function") issues.push(`structure-only non-MF term was selected: ${goId}`);
        const qualifyingGroups = [...byGroupAdjusted.values()].filter((value) => value >= supportFloor).length;
        if (requireTwoGroups && qualifyingGroups < 2) issues.push(`selected structure-only GO term lacks two material donor groups: ${goId}`);
        if (independentGroupRootCount(
          supports.filter((support) => support.candidateSourceType !== "deepgoplus_hybrid"),
          supportFloor,
        ) < minimumRoots) {
          issues.push(`selected structure-only GO term lacks independent provenance roots: ${goId}`);
        }
      }
    }
  }
}

/** Direct test/replay surface for the genome-bound GO policy contract. */
export function goPolicyContractIssues(goValue: unknown, genomeValue: unknown): string[] {
  const go = object(goValue);
  const genome = object(genomeValue);
  if (!go || !genome) return ["GO policy contract requires prediction and genome objects"];
  const issues: string[] = [];
  validateGoPolicy(go, genome, issues);
  return issues;
}

async function validateHistoricalGoJudgeArtifacts(input: {
  runDir: string;
  go: Record<string, unknown>;
  goPolicy: Record<string, unknown>;
  runManifest: Record<string, unknown>;
  issues: string[];
}): Promise<void> {
  const judgePolicy = object(input.goPolicy.goJudgePolicy);
  const judgeViewPath = join(input.runDir, "prediction", "go_judge_view.json");
  const judgeResultPath = join(input.runDir, "prediction", "go_judge_result.json");
  const judgeAuditPath = join(input.runDir, "prediction", "go_judge_audit.json");
  const [hasView, hasResult, hasAudit] = await Promise.all([
    exists(judgeViewPath),
    exists(judgeResultPath),
    exists(judgeAuditPath),
  ]);
  const hasAnyArtifact = hasView || hasResult || hasAudit;
  if (judgePolicy?.mode !== "evidence_consistency") {
    if (hasAnyArtifact || input.go.goJudgeStatus !== undefined) {
      throw new Error("GO judge artifacts exist even though the genome disables the judge");
    }
    return;
  }

  // A judge-enabled historical run may legitimately have no judge artifacts
  // when its evidence-derived candidate view was empty.  If any judge state is
  // present, however, the complete canonical trio and its run-manifest hashes
  // remain mandatory even though current inference is not re-derived.
  if (!hasAnyArtifact && input.go.goJudgeStatus === undefined) return;
  if (!hasView || !hasResult || !hasAudit) {
    throw new Error("judge-enabled historical run has an incomplete bounded view/result/audit set");
  }
  const rawStoredView = await readJsonObject(judgeViewPath, input.issues);
  const rawStoredResult = await readJsonObject(judgeResultPath, input.issues);
  const rawJudgeAudit = await readJsonObject(judgeAuditPath, input.issues);
  validateSchema("GO judge view", await readSchema("go_judge_view.schema.json", input.issues), rawStoredView, input.issues);
  validateSchema("GO judge result", await readSchema("go_judge_result.schema.json", input.issues), rawStoredResult, input.issues);
  validateSchema("GO judge audit", await readSchema("go_judge_audit.schema.json", input.issues), rawJudgeAudit, input.issues);
  const storedView = validateGOJudgeView(rawStoredView);
  const storedResult = validateGOJudgeResult(storedView, rawStoredResult);
  const { canonicalHash: auditHash, ...auditContent } = rawJudgeAudit;
  if (auditHash !== hashCanonical(auditContent)) throw new Error("GO judge audit canonical hash mismatch");
  const status = object(input.go.goJudgeStatus);
  if (!status || (status.requestedMode !== "pi" && status.requestedMode !== "deterministic")) {
    throw new Error("judge-enabled GO artifact has no valid requested mode");
  }
  const configuredJudgeMode = judgePolicy.executionMode === "pi" ? "pi" : "deterministic";
  if (status.requestedMode !== configuredJudgeMode) {
    throw new Error("GO judge requested mode does not match the genome-bound execution mode");
  }
  const configuredBudgetMode = judgePolicy.candidateBudgetMode === "aspect_stratified_v1"
    ? "aspect_stratified_v1" : "global_ranked_v1";
  const recordedBudgetMode = status.candidateBudgetMode === "aspect_stratified_v1"
    ? "aspect_stratified_v1" : "global_ranked_v1";
  if (recordedBudgetMode !== configuredBudgetMode) {
    throw new Error("GO judge candidate budget mode does not match the genome-bound policy");
  }
  const configuredRetentionMode = judgePolicy.candidateRetentionMode === "preserve_ranked_evidence_v1"
    ? "preserve_ranked_evidence_v1" : "fail_closed_v1";
  const recordedRetentionMode = status.candidateRetentionMode === "preserve_ranked_evidence_v1"
    ? "preserve_ranked_evidence_v1" : "fail_closed_v1";
  if (recordedRetentionMode !== configuredRetentionMode) {
    throw new Error("GO judge candidate retention mode does not match the genome-bound policy");
  }
  const fallbackReason = status.fallbackReason === null
    ? null
    : typeof status.fallbackReason === "string" ? status.fallbackReason : undefined;
  if (fallbackReason === undefined) throw new Error("judge fallbackReason must be a string or null");
  const attempts = objects(rawJudgeAudit.attempts);
  const completedAttempts = attempts.filter((attempt) => attempt.status === "completed");
  const lastCompleted = completedAttempts.at(-1);
  if (!lastCompleted || lastCompleted.requestedMode !== storedResult.modeUsed) {
    throw new Error("GO judge audit does not bind the result mode to a completed execution");
  }
  if (status.requestedMode === "pi" && storedResult.modeUsed === "deterministic"
    && (fallbackReason === null
      || !attempts.some((attempt) => attempt.requestedMode === "pi" && attempt.status === "failed"))) {
    throw new Error("deterministic GO-judge fallback lacks a failed Pi attempt and explicit reason");
  }
  const goStage = object((object(input.runManifest.stages) ?? {}).goInference) ?? {};
  const artifactBinding = object(goStage.goJudgeArtifacts);
  if (!artifactBinding
    || artifactBinding.viewSha256 !== await sha256File(judgeViewPath)
    || artifactBinding.resultSha256 !== await sha256File(judgeResultPath)
    || artifactBinding.auditSha256 !== await sha256File(judgeAuditPath)) {
    throw new Error("run manifest does not hash-bind all GO judge artifacts");
  }
}

export async function validateRunArtifacts(
  runDirInput: string,
  options: RunValidationOptions = {},
): Promise<RunValidationResult> {
  const runDir = resolve(runDirInput);
  const issues: string[] = [];
  const validationMode = options.mode ?? "strict";
  if (validationMode !== "strict" && validationMode !== "receipt_bound_historical_frozen_replay_source") {
    return { ok: false, runDir, issues: ["unsupported run artifact validation mode"] };
  }
  const paths = {
    evidenceManifest: join(runDir, "evidence_manifest.json"),
    bundle: join(runDir, "evidence", "evidence_bundle.json"),
    blindBundle: join(runDir, "evidence", "blind_evidence_bundle.json"),
    blindGo: join(runDir, "prediction", "blind_go_view.json"),
    prediction: join(runDir, "prediction", "final_prediction.json"),
    go: join(runDir, "prediction", "go_predictions.json"),
    goTsv: join(runDir, "prediction", "go_predictions.tsv"),
    critic: join(runDir, "prediction", "critic_review.json"),
    audit: join(runDir, "prediction", "agent_audit.json"),
    genome: join(runDir, "prediction", "agent_genome.json"),
    episode: join(runDir, "prediction", "episode_trace.json"),
    markdown: join(runDir, "prediction", "function_prediction_report.md"),
    html: join(runDir, "prediction", "function_prediction_report.html"),
    runManifest: join(runDir, "run_manifest.json"),
    inputSequence: join(runDir, "input", "sequence.fasta"),
    inputStructure: join(runDir, "input", "structure.pdb"),
    redaction: join(runDir, "input", "redaction_report.json"),
  };
  for (const [name, path] of Object.entries(paths)) {
    if (name === "inputStructure") continue;
    if (!(await exists(path))) issues.push(`missing: ${path}`);
  }
  if (issues.length > 0) return { ok: false, runDir, issues };

  const evidenceManifest = await readJsonObject(paths.evidenceManifest, issues);
  const runManifest = await readJsonObject(paths.runManifest, issues);
  const bundle = await readJsonObject(paths.bundle, issues);
  const blindBundle = await readJsonObject(paths.blindBundle, issues);
  const blindGo = await readJsonObject(paths.blindGo, issues);
  const prediction = await readJsonObject(paths.prediction, issues);
  const go = await readJsonObject(paths.go, issues);
  const critic = await readJsonObject(paths.critic, issues);
  const genomeSnapshot = await readJsonObject(paths.genome, issues);
  const episode = await readJsonObject(paths.episode, issues);
  const redaction = await readJsonObject(paths.redaction, issues);
  let audits: Record<string, unknown>[] = [];
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.audit, "utf8"));
    if (!Array.isArray(parsed)) issues.push("agent audit must be a JSON array");
    else audits = parsed.map(object).filter((item): item is Record<string, unknown> => item !== undefined);
  } catch (error) {
    issues.push(`invalid agent audit JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const genomeSchema = await readSchema("agent_genome.schema.json", issues);
  const goSchema = await readSchema("go_prediction.schema.json", issues);
  const episodeSchema = await readSchema("episode_trace.schema.json", issues);
  const predictionSchema = await readSchema("function_prediction.schema.json", issues);
  validateSchema("agent genome", genomeSchema, genomeSnapshot.genome, issues);
  validateSchema("GO prediction", goSchema, go, issues);
  validateSchema("blind GO prediction", goSchema, blindGo, issues);
  validateSchema("episode trace", episodeSchema, episode, issues);
  validateSchema(
    "final prediction",
    predictionSchema,
    prediction,
    issues,
    goSchema ? { "go_prediction.schema.json": goSchema, [String((goSchema as unknown as Record<string, unknown>).$id ?? "pi-go-prediction.v2")]: goSchema } : undefined,
  );

  if (evidenceManifest.status !== "completed") issues.push("evidence manifest is not completed");
  if (bundle.schema_version !== "pi-function-evidence.v3") issues.push("unsupported evidence bundle schemaVersion");
  if (runManifest.status !== "completed") issues.push("run manifest is not completed");
  if (runManifest.schemaVersion !== "pi-function-run.v4") issues.push("unsupported run manifest schemaVersion");
  if (prediction.schemaVersion !== "pi-function-prediction.v4") issues.push("unsupported final prediction schemaVersion");
  if (critic.approved !== true) issues.push("final critic/contract review is not approved");
  const narrativeMode = String(runManifest.narrativeMode ?? "");
  const sessionPaths: string[] = [];
  const synthesisAudits = audits.filter((audit) => audit.role === "synthesizer");
  const criticAudits = audits.filter((audit) => audit.role === "critic");
  if (synthesisAudits.length === 0 || criticAudits.length === 0) issues.push("agent audit must contain synthesizer and critic records");
  if (narrativeMode === "pi") {
    for (const audit of audits) {
      const stats = object(audit.stats) ?? {};
      if (audit.modelProvider === "deterministic" || typeof audit.sessionFile !== "string" || Number(stats.totalTokens) <= 0) {
        issues.push("Pi narrative audit must record a non-deterministic model, session file, and positive token usage");
      } else {
        const sessionPath = resolve(runDir, audit.sessionFile);
        if (!sessionPath.startsWith(`${runDir}${sep}`)) issues.push("Pi session path escapes the run directory");
        else if (!(await exists(sessionPath))) issues.push(`missing Pi session file: ${audit.sessionFile}`);
        else sessionPaths.push(sessionPath);
      }
    }
  } else if (narrativeMode === "deterministic") {
    if (audits.length !== 2 || audits.some((audit) => audit.modelProvider !== "deterministic")) {
      issues.push("deterministic narrative mode must contain exactly two deterministic audit records");
    }
  } else {
    issues.push("run manifest has an unsupported narrative mode");
  }

  const validIds = new Set(Array.isArray(bundle.evidence_ids) ? bundle.evidence_ids.map(String) : []);
  const blindIds = new Set(Array.isArray(blindBundle.evidence_ids) ? blindBundle.evidence_ids.map(String) : []);
  const queryLike = new Set(Array.isArray(go.queryLikeAccessions) ? go.queryLikeAccessions.map(canonicalAccession).filter(Boolean) : []);
  for (const section of ["sequence_hits", "structure_hits", "uniprot_annotations", "pdb_annotations"]) {
    for (const item of objects(blindBundle[section])) {
      const itemAccessions = evidenceAccessions(item);
      if (itemAccessions.some((value) => queryLike.has(value)) || item.query_like === true) issues.push("blind evidence view contains a query-like record");
    }
  }
  for (const section of ["sequence_hits", "structure_hits", "uniprot_annotations", "pdb_annotations"]) {
    for (const item of objects(bundle[section])) {
      const itemAccessions = evidenceAccessions(item);
      const missing = item.query_like === true && itemAccessions.find((value) => !queryLike.has(value));
      if (missing) issues.push("a query-like evidence alias is absent from the private GO quarantine set");
    }
  }
  const blindProtein = object(blindBundle.protein) ?? {};
  if (blindProtein.header !== "anonymous_query" || Object.hasOwn(blindProtein, "query_like_accessions")) {
    issues.push("blind evidence protein metadata is not identity-redacted");
  }
  if (redaction.schemaVersion !== "pi-input-redaction.v2" || redaction.sourceIdentityMetadataRetained !== false) {
    issues.push("input redaction report is missing or does not confirm identity removal");
  }
  const expectedBlindBundle = buildBlindEvidenceView(
    bundle,
    [...queryLike],
    goPolicyAdmittedCandidateEvidenceIds(go as unknown as GOPredictionSet),
  );
  if (canonicalJson(blindBundle) !== canonicalJson(expectedBlindBundle)) issues.push("blind evidence bundle is not the canonical strict-blind view of full evidence");
  const expectedBlindGo = buildBlindGoView(go as unknown as GOPredictionSet);
  if (canonicalJson(blindGo) !== canonicalJson(expectedBlindGo)) issues.push("blind GO artifact is not the canonical strict-blind view of authoritative GO evidence");
  const publicParts = [
    canonicalJson(blindBundle),
    canonicalJson(blindGo),
    canonicalJson(prediction),
    canonicalJson(critic),
    canonicalJson(audits),
    canonicalJson(runManifest),
    canonicalJson(episode),
    await readFile(paths.markdown, "utf8"),
    await readFile(paths.html, "utf8"),
  ];
  for (const judgeArtifact of ["go_judge_view.json", "go_judge_result.json", "go_judge_audit.json", "semantic_go_judge_view.json", "semantic_go_judge_result.json", "semantic_go_score_surface.tsv"]) {
    const judgePath = join(runDir, "prediction", judgeArtifact);
    if (await exists(judgePath)) publicParts.push(await readFile(judgePath, "utf8"));
  }
  for (const sessionPath of sessionPaths) publicParts.push(await readFile(sessionPath, "utf8"));
  const publicText = publicParts.join("\n").toUpperCase();
  if (/(?:\/USERS\/|\/HOME\/|[A-Z]:\\USERS\\)/.test(publicText)) issues.push("public/Pi-bound artifacts expose an absolute workstation home path");
  for (const accession of queryLike) {
    if (containsAccessionToken(publicText, accession)) issues.push("a public/Pi-bound artifact exposes quarantined identity metadata");
  }
  const citations = collectPredictionCitations(prediction);
  if (objects(prediction.keyEvidence).length === 0) issues.push("prediction contains no primary evidence citations");
  const unknown = [...citations].filter((id) => !blindIds.has(id)).sort();
  if (unknown.length > 0) issues.push(`prediction cites evidence outside the strict-blind view: ${unknown.join(", ")}`);

  const embeddedGo = object(prediction.goPrediction);
  if (!embeddedGo || canonicalJson(embeddedGo) !== canonicalJson(blindGo)) issues.push("final prediction does not embed the exact public strict-blind GO object");

  const actualTsv = await readFile(paths.goTsv, "utf8");
  const expectedTsv = renderGoTsv(go as unknown as GOPredictionSet);
  if (actualTsv !== expectedTsv) issues.push("GO TSV content does not exactly match selected prediction terms in GO JSON");

  if (genomeSnapshot.schemaVersion !== "pi-agent-genome-snapshot.v1") issues.push("unsupported genome snapshot schemaVersion");
  const genome = object(genomeSnapshot.genome);
  if (!genome) {
    issues.push("genome snapshot has no genome object");
    validateGo(go, bundle, validIds, issues);
  }
  else if (String(genomeSnapshot.genomeHash) !== hashCanonical(genome)) issues.push("genomeHash does not match genome content");
  if (String(genomeSnapshot.immutableContractHash) !== hashCanonical(IMMUTABLE_SCIENTIFIC_CONTRACT)) issues.push("immutable scientific contract hash mismatch");
  if (String(go.genomeHash) !== String(genomeSnapshot.genomeHash)) issues.push("GO artifact is bound to a different genome hash");
  if (genome) {
    const goPolicy = object(genome.goPolicy) ?? {};
    if (String(go.genomeId) !== String(genome.genomeId)) issues.push("GO artifact genomeId does not match genome");
    if (String(go.methodId) !== String(goPolicy.methodId)) issues.push("GO methodId does not match genome policy");
    if (canonicalJson(go.thresholds) !== canonicalJson(goPolicy.thresholds)) issues.push("GO thresholds do not match genome policy");
    issues.push(...goPolicyContractIssues(go, genome));
    const ontologyPolicy = object(goPolicy.ontologyPolicy);
    let ontology: GOOntology | undefined;
    let ontologySnapshot: Record<string, unknown> | undefined;
    if (ontologyPolicy?.mode === "ancestor_closure") {
      const snapshotPath = join(runDir, "prediction", "go_ontology_snapshot.json");
      if (!(await exists(snapshotPath))) issues.push("ontology-enabled genome has no GO ontology snapshot");
      else {
        try {
          ontologySnapshot = await readJsonObject(snapshotPath, issues);
          ontology = await loadGoOntologySnapshot(snapshotPath);
        } catch (error) {
          issues.push(`invalid GO ontology snapshot: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    validateGo(go, bundle, validIds, issues, genome, ontology);
    if (validationMode === "strict") {
      let recomputedGo: GOPredictionSet | undefined;
      try {
        const guarded = guardedStrictGoRecompute({
          genome: genomeSnapshot as unknown as GenomeSnapshot,
          evidenceBundle: bundle,
          recompute: () => inferGoPredictions({
            proteinId: String(runManifest.proteinId ?? ""),
            bundle,
            genome: genomeSnapshot as unknown as GenomeSnapshot,
            queryTaxonId: runManifest.queryTaxonId === null ? null : Number(runManifest.queryTaxonId),
            targetContext: runManifest.targetContext as TargetContext,
            targetMode: runManifest.targetMode === "named_uncharacterized" ? "named_uncharacterized" : "anonymous",
            excludedAccessions: Array.isArray(go.explicitlyExcludedAccessions) ? go.explicitlyExcludedAccessions.map(String) : [],
            ontology,
            goJudgeMode: "disabled",
          }),
        });
        if ("completenessIssue" in guarded) {
          issues.push(`unable to recompute GO artifact: ${guarded.completenessIssue}`);
        } else {
          recomputedGo = guarded.value;
          const judgePolicy = object(goPolicy.goJudgePolicy);
          const judgeViewPath = join(runDir, "prediction", "go_judge_view.json");
          const judgeResultPath = join(runDir, "prediction", "go_judge_result.json");
          const judgeAuditPath = join(runDir, "prediction", "go_judge_audit.json");
          const semanticViewPath = join(runDir, "prediction", "semantic_go_judge_view.json");
          const semanticResultPath = join(runDir, "prediction", "semantic_go_judge_result.json");
          const semanticScoreSurfacePath = join(runDir, "prediction", "semantic_go_score_surface.tsv");
          if (judgePolicy?.mode === "evidence_consistency") {
            const binding = buildGOJudgeBinding(
              recomputedGo,
              Number(judgePolicy.maxCandidates),
              judgePolicy.candidateBudgetMode === "aspect_stratified_v1"
                ? "aspect_stratified_v1" : "global_ranked_v1",
            );
            if (binding) {
          if (!(await exists(judgeViewPath)) || !(await exists(judgeResultPath))) {
            throw new Error("judge-enabled run is missing its bounded view or result artifact");
          }
          if (!(await exists(judgeAuditPath))) throw new Error("judge-enabled run is missing its execution audit artifact");
          const rawStoredView = await readJsonObject(judgeViewPath, issues);
          const rawStoredResult = await readJsonObject(judgeResultPath, issues);
          const rawJudgeAudit = await readJsonObject(judgeAuditPath, issues);
          validateSchema("GO judge view", await readSchema("go_judge_view.schema.json", issues), rawStoredView, issues);
          validateSchema("GO judge result", await readSchema("go_judge_result.schema.json", issues), rawStoredResult, issues);
          validateSchema("GO judge audit", await readSchema("go_judge_audit.schema.json", issues), rawJudgeAudit, issues);
          const storedView = validateGOJudgeView(rawStoredView);
          if (canonicalJson(storedView) !== canonicalJson(binding.view)) {
            throw new Error("persisted GO judge view does not match the evidence-derived opaque view");
          }
          const storedResult = validateGOJudgeResult(binding.view, rawStoredResult);
          const { canonicalHash: auditHash, ...auditContent } = rawJudgeAudit;
          if (auditHash !== hashCanonical(auditContent)) throw new Error("GO judge audit canonical hash mismatch");
          const status = object(go.goJudgeStatus);
          if (!status || (status.requestedMode !== "pi" && status.requestedMode !== "deterministic")) {
            throw new Error("judge-enabled GO artifact has no valid requested mode");
          }
          const configuredJudgeMode = judgePolicy.executionMode === "pi" ? "pi" : "deterministic";
          if (status.requestedMode !== configuredJudgeMode) {
            throw new Error("GO judge requested mode does not match the genome-bound execution mode");
          }
          const configuredBudgetMode = judgePolicy.candidateBudgetMode === "aspect_stratified_v1"
            ? "aspect_stratified_v1" : "global_ranked_v1";
          const recordedBudgetMode = status.candidateBudgetMode === "aspect_stratified_v1"
            ? "aspect_stratified_v1" : "global_ranked_v1";
          if (recordedBudgetMode !== configuredBudgetMode) {
            throw new Error("GO judge candidate budget mode does not match the genome-bound policy");
          }
          const configuredRetentionMode = judgePolicy.candidateRetentionMode === "preserve_ranked_evidence_v1"
            ? "preserve_ranked_evidence_v1" : "fail_closed_v1";
          const recordedRetentionMode = status.candidateRetentionMode === "preserve_ranked_evidence_v1"
            ? "preserve_ranked_evidence_v1" : "fail_closed_v1";
          if (recordedRetentionMode !== configuredRetentionMode) {
            throw new Error("GO judge candidate retention mode does not match the genome-bound policy");
          }
          const fallbackReason = status.fallbackReason === null
            ? null
            : typeof status.fallbackReason === "string" ? status.fallbackReason : undefined;
          if (fallbackReason === undefined) throw new Error("judge fallbackReason must be a string or null");
          const attempts = objects(rawJudgeAudit.attempts);
          const completedAttempts = attempts.filter((attempt) => attempt.status === "completed");
          const lastCompleted = completedAttempts.at(-1);
          if (!lastCompleted || lastCompleted.requestedMode !== storedResult.modeUsed) {
            throw new Error("GO judge audit does not bind the result mode to a completed execution");
          }
          if (status.requestedMode === "pi" && storedResult.modeUsed === "deterministic"
            && (fallbackReason === null || !attempts.some((attempt) => attempt.requestedMode === "pi" && attempt.status === "failed"))) {
            throw new Error("deterministic GO-judge fallback lacks a failed Pi attempt and explicit reason");
          }
          const goStage = object((object(runManifest.stages) ?? {}).goInference) ?? {};
          const artifactBinding = object(goStage.goJudgeArtifacts);
          if (!artifactBinding
            || artifactBinding.viewSha256 !== await sha256File(judgeViewPath)
            || artifactBinding.resultSha256 !== await sha256File(judgeResultPath)
            || artifactBinding.auditSha256 !== await sha256File(judgeAuditPath)) {
            throw new Error("run manifest does not hash-bind all GO judge artifacts");
          }
          recomputedGo = applyGOJudgeResult({
            prediction: recomputedGo,
            binding,
            result: storedResult,
            maxSelectedTermsPerAspect: Number(goPolicy.maxSelectedTermsPerAspect),
            requestedMode: status.requestedMode,
            candidateRetentionMode: configuredRetentionMode,
            fallbackReason,
          });
            } else if (await exists(judgeViewPath) || await exists(judgeResultPath) || await exists(judgeAuditPath) || go.goJudgeStatus !== undefined) {
              throw new Error("GO judge artifacts exist even though the evidence-derived candidate view is empty");
            }
          } else if (judgePolicy?.mode === "semantic_reasoning") {
            if (await exists(judgeViewPath) || await exists(judgeResultPath) || await exists(judgeAuditPath) || go.goJudgeStatus !== undefined) {
              throw new Error("semantic reasoning run contains legacy GO judge state");
            }
            if (!ontologySnapshot) throw new Error("semantic reasoning validation requires the pinned ontology snapshot");
            if (!(await exists(semanticViewPath)) || !(await exists(semanticResultPath)) || !(await exists(semanticScoreSurfacePath))) {
              throw new Error("semantic reasoning run is missing its view, result, or score surface");
            }
            const semanticBlindEvidence = buildBlindEvidenceView(
              bundle,
              recomputedGo.queryLikeAccessions,
              goPolicyAdmittedCandidateEvidenceIds(recomputedGo),
            );
            const binding = buildSemanticGOJudgeBinding({
              prediction: recomputedGo,
              blindEvidenceBundle: semanticBlindEvidence,
              ontologySnapshot,
              maxCandidates: Number(judgePolicy.maxCandidates),
              maxDonorContexts: Number(judgePolicy.maxDonorContexts),
            });
            const storedView = await readJsonObject(semanticViewPath, issues);
            if (canonicalJson(storedView) !== canonicalJson(binding.view)) {
              throw new Error("persisted semantic GO view does not match the evidence-derived strict-blind view");
            }
            const storedResult = validateSemanticGOJudgeResult(
              binding,
              await readJsonObject(semanticResultPath, issues),
            );
            if (storedResult.audit.modelProvider !== judgePolicy.modelProvider
              || storedResult.audit.modelId !== judgePolicy.modelId
              || storedResult.audit.thinkingLevel !== (judgePolicy.thinkingLevel ?? "medium")) {
              throw new Error("semantic GO execution does not match the genome-bound model contract");
            }
            const expectedSurface = renderSemanticPredictionTsv(semanticPredictionRows({
              targetId: recomputedGo.proteinId,
              binding,
              result: storedResult,
            }));
            if (await readFile(semanticScoreSurfacePath, "utf8") !== expectedSurface) {
              throw new Error("semantic GO score surface does not match the frozen r08 host mapping");
            }
            const status = object(go.semanticGoJudgeStatus);
            if (!status || status.failurePolicy !== "fail_closed"
              || (status.scoringPolicy !== "r08_compact_acceptance_v1"
                && status.scoringPolicy !== "r08_compact_acceptance_global_calibration_v1")
              || status.modelProvider !== judgePolicy.modelProvider
              || status.modelId !== judgePolicy.modelId) {
              throw new Error("authoritative GO artifact lacks the genome-bound semantic status");
            }
            const goStage = object((object(runManifest.stages) ?? {}).goInference) ?? {};
            const artifactBinding = object(goStage.semanticGoJudgeArtifacts);
            if (!artifactBinding
              || artifactBinding.viewSha256 !== await sha256File(semanticViewPath)
              || artifactBinding.resultSha256 !== await sha256File(semanticResultPath)
              || artifactBinding.scoreSurfaceSha256 !== await sha256File(semanticScoreSurfacePath)) {
              throw new Error("run manifest does not hash-bind all semantic GO artifacts");
            }
            recomputedGo = applySemanticGOJudgeResult({
              prediction: recomputedGo,
              binding,
              result: storedResult,
              maxSelectedTermsPerAspect: Number(goPolicy.maxSelectedTermsPerAspect),
              maxCandidates: Number(judgePolicy.maxCandidates),
              maxDonorContexts: Number(judgePolicy.maxDonorContexts),
            });
          } else if (await exists(judgeViewPath) || await exists(judgeResultPath) || await exists(judgeAuditPath)
            || await exists(semanticViewPath) || await exists(semanticResultPath) || await exists(semanticScoreSurfacePath)
            || go.goJudgeStatus !== undefined || go.semanticGoJudgeStatus !== undefined) {
            throw new Error("GO judge artifacts exist even though the genome disables the judge");
          }
          const scoreFusionPolicy = object(goPolicy.scoreFusionPolicy);
          if (scoreFusionPolicy?.mode === "deepgoplus_anchor_v1") {
            recomputedGo = applyGOScoreFusion({
              prediction: recomputedGo,
              policy: scoreFusionPolicy as unknown as {
                mode: "deepgoplus_anchor_v1";
                anchorWeights: Record<"molecular_function" | "biological_process" | "cellular_component", number>;
              },
              maxSelectedTermsPerAspect: Number(goPolicy.maxSelectedTermsPerAspect),
            });
          }
        }
      } catch (error) {
        issues.push(`unable to recompute GO artifact: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (recomputedGo && canonicalJson(recomputedGo) !== canonicalJson(go)) issues.push("GO artifact does not exactly match deterministic inference from the bound evidence, ontology, and genome");
    } else {
      try {
        await validateHistoricalGoJudgeArtifacts({ runDir, go, goPolicy, runManifest, issues });
      } catch (error) {
        issues.push(`unable to validate stored GO judge artifacts: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const manifestGenome = object(runManifest.genome) ?? {};
    if (String(manifestGenome.genomeId) !== String(genome.genomeId) || String(manifestGenome.genomeHash) !== String(genomeSnapshot.genomeHash)) {
      issues.push("run manifest genome binding does not match snapshot");
    }
  }

  const bundleProtein = object(bundle.protein) ?? {};
  const lineageSourceId = bundleProtein.query_lineage_source_evidence_id === null ? "" : String(bundleProtein.query_lineage_source_evidence_id ?? "");
  if (lineageSourceId) {
    const source = evidenceIndex(bundle).get(lineageSourceId);
    const sourceAccession = canonicalAccession(source?.accession);
    if (queryLike.has(sourceAccession) || source?.query_like === true) issues.push("query lineage was sourced from a quarantined query-like annotation");
    const sourceTaxonId = source?.kind === "target_taxonomy" || source?.kind === "target_taxonomy_consensus"
      ? source.taxon_id
      : source?.organism_taxon_id;
    if (!source || Number(sourceTaxonId) !== Number(bundleProtein.query_taxon_id)
      || canonicalJson(source.organism_lineage) !== canonicalJson(bundleProtein.query_lineage)
      || String(source.payload_sha256 ?? "") !== String(bundleProtein.query_lineage_source_payload_sha256 ?? "")) {
      issues.push("query lineage is not bound to its cited same-taxon taxonomy/annotation payload");
    }
  } else if (Array.isArray(bundleProtein.query_lineage) && bundleProtein.query_lineage.length > 0) {
    issues.push("query lineage has no cited source evidence ID");
  }
  const manifestInputs = object(runManifest.inputs) ?? {};
  const episodeTarget = object(episode.target) ?? {};
  const proteinId = String(runManifest.proteinId ?? "");
  const targetMode = String(runManifest.targetMode ?? "");
  const taxonId = runManifest.queryTaxonId === null ? null : Number(runManifest.queryTaxonId);
  const manifestTargetContext = object(runManifest.targetContext) ?? {};
  const goTargetContext = object(go.targetContext) ?? {};
  const predictionTargetContext = object(prediction.targetContext) ?? {};
  const episodeTargetContext = object(episodeTarget.targetContext) ?? {};
  const redactionTargetContext = object(redaction.targetContext) ?? {};
  if (String(bundleProtein.protein_id) !== proteinId || String(go.proteinId) !== proteinId || String(blindGo.proteinId) !== proteinId || String(prediction.proteinId) !== proteinId || String(episodeTarget.proteinId) !== proteinId) {
    issues.push("proteinId differs across manifest, evidence, GO, prediction, or episode");
  }
  if (String(go.targetMode) !== targetMode || String(blindGo.targetMode) !== targetMode || String(prediction.targetMode) !== targetMode || String(episodeTarget.targetMode) !== targetMode || String(redaction.targetMode) !== targetMode) {
    issues.push("targetMode differs across manifest, GO, prediction, episode, or redaction report");
  }
  if (targetMode === "anonymous" && !/^ANON_[A-F0-9]{12}$/.test(proteinId)) issues.push("anonymous proteinId is not content-derived and opaque");
  if (runManifest.identityPolicy !== "strict_blind_v1" && runManifest.identityPolicy !== "temporal_t0_v1") issues.push("unsupported run identityPolicy");
  if (
    canonicalJson(manifestTargetContext) !== canonicalJson(predictionTargetContext)
    || canonicalJson(manifestTargetContext) !== canonicalJson(goTargetContext)
    || canonicalJson(manifestTargetContext) !== canonicalJson(episodeTargetContext)
    || canonicalJson(manifestTargetContext) !== canonicalJson(redactionTargetContext)
  ) {
    issues.push("target context differs across manifest, GO, prediction, episode, or redaction report");
  }
  const targetTaxon = object(manifestTargetContext.taxon) ?? {};
  const targetPhylogeny = object(manifestTargetContext.phylogeny) ?? {};
  const contextTaxonId = targetTaxon.taxonId === null ? null : Number(targetTaxon.taxonId);
  const expectedTaxonProvenance = taxonId === null ? "unavailable" : "provided";
  const expectedPhylogenyStatus = taxonId === null ? "unavailable_missing_taxon" : "requested";
  if (contextTaxonId !== taxonId || String(targetTaxon.provenance ?? "") !== expectedTaxonProvenance) {
    issues.push("target taxon context is inconsistent with the declared query TaxID");
  }
  if (
    !["optional", "required"].includes(String(targetPhylogeny.mode ?? ""))
    || String(targetPhylogeny.status ?? "") !== expectedPhylogenyStatus
  ) {
    issues.push("phylogeny request state is inconsistent with target taxon availability");
  }
  if (targetPhylogeny.mode === "required" && taxonId === null) {
    issues.push("required phylogeny mode has no declared target TaxID");
  }
  const bundleTaxon = bundleProtein.query_taxon_id === null ? null : Number(bundleProtein.query_taxon_id);
  const goTaxon = go.queryTaxonId === null ? null : Number(go.queryTaxonId);
  const blindGoTaxon = blindGo.queryTaxonId === null ? null : Number(blindGo.queryTaxonId);
  const episodeTaxon = episodeTarget.queryTaxonId === null ? null : Number(episodeTarget.queryTaxonId);
  if (bundleTaxon !== taxonId || goTaxon !== taxonId || blindGoTaxon !== taxonId || episodeTaxon !== taxonId) issues.push("query taxon differs across manifest, evidence, GO, or episode");
  const bundleTaxonSource = String(bundleProtein.query_taxon_id_source ?? "unavailable");
  if (taxonId === null && bundleTaxonSource !== "unavailable") issues.push("evidence inferred target taxonomy although the caller did not provide it");
  if (taxonId !== null && bundleTaxonSource !== "cli") issues.push("evidence did not retain caller-provided target taxonomy provenance");
  const copiedSequenceHash = await sha256File(paths.inputSequence);
  const sequenceInputText = await readFile(paths.inputSequence, "utf8");
  const normalizedSequenceHash = sha256Text(`${sequenceInputText.replace(/\r\n?/g, "\n").trimEnd()}\n`);
  if (sequenceInputText.split(/\r?\n/, 1)[0] !== ">anonymous_query" || /\b(?:OS|OX|GN|PE|SV)=/.test(sequenceInputText)) {
    issues.push("copied FASTA is not identity-sanitized");
  }
  if (String(manifestInputs.sequenceSha256) !== copiedSequenceHash || String(episodeTarget.sequenceSha256) !== copiedSequenceHash) {
    issues.push("FASTA hash differs across copied input, manifest, or episode target");
  }
  const hasStructure = manifestInputs.structure !== null;
  if (hasStructure) {
    if (!(await exists(paths.inputStructure))) issues.push(`missing: ${paths.inputStructure}`);
    else {
      const copiedStructureHash = await sha256File(paths.inputStructure);
      const structureInputText = await readFile(paths.inputStructure, "utf8");
      const normalizedStructureHash = sha256Text(`${structureInputText.replace(/\r\n?/g, "\n").trimEnd()}\n`);
      if (/^(?:HEADER|TITLE |COMPND|SOURCE|DBREF |SEQADV|JRNL  )/m.test(structureInputText)) issues.push("copied PDB contains identity-bearing metadata records");
      try {
        if (canonicalPdb(structureInputText).text !== structureInputText) issues.push("copied PDB is not byte-for-byte canonical after identity redaction");
      } catch (error) {
        issues.push(`copied PDB cannot be re-canonicalized: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (String(manifestInputs.structureSha256) !== copiedStructureHash || String(episodeTarget.structureSha256) !== copiedStructureHash) {
        issues.push("PDB hash differs across copied input, manifest, or episode target");
      }
      if (String(bundleProtein.structure_input_sha256) !== normalizedStructureHash) issues.push("evidence bundle PDB hash does not match copied PDB");
    }
  } else if (manifestInputs.structureSha256 !== null || episodeTarget.structureSha256 !== null || bundleProtein.structure_input_sha256 !== null || bundleProtein.structure_available !== false) {
    issues.push("sequence-only run has inconsistent structure absence metadata");
  }
  if (String(bundleProtein.sequence_input_sha256) !== normalizedSequenceHash) {
    issues.push("evidence bundle FASTA hash does not match copied FASTA");
  }

  if (episode.schemaVersion !== "pi-function-episode.v3") issues.push("unsupported episode schemaVersion");
  if (episode.status !== "completed") issues.push("episode is not completed");
  if (String(episode.genomeId) !== String(genome?.genomeId ?? "")) issues.push("episode genomeId does not match genome snapshot");
  if (String(episode.genomeHash) !== String(genomeSnapshot.genomeHash)) issues.push("episode is bound to a different genome hash");
  if (String(episode.runId) !== String(runManifest.runId)) issues.push("episode runId does not match manifest");
  if (String(episode.narrativeMode) !== String(runManifest.narrativeMode)) issues.push("episode narrative mode does not match manifest");
  if (String(prediction.narrativeMode) !== String(runManifest.narrativeMode)) issues.push("final prediction narrative mode does not match manifest");
  if (episode.promotionDecision !== "not_evaluated") issues.push("generation-0 episode promotionDecision must be not_evaluated");
  const episodeStarted = Date.parse(String(episode.startedAt ?? ""));
  const episodeFinished = Date.parse(String(episode.finishedAt ?? ""));
  if (!Number.isFinite(episodeStarted) || !Number.isFinite(episodeFinished) || episodeFinished < episodeStarted) {
    issues.push("episode timestamps are invalid or out of order");
  }
  const episodeSteps = objects(episode.steps);
  const stepNames = new Set(episodeSteps.map((step) => String(step.name ?? "")));
  const requiredSteps = ["collect_fixed_evidence", "infer_go", "synthesize_narrative", "review_narrative", "assemble_outputs"];
  for (const requiredStep of requiredSteps) {
    const count = episodeSteps.filter((step) => step.name === requiredStep).length;
    if (count !== 1) issues.push(`episode must contain exactly one ${requiredStep} step (found ${count})`);
  }
  const requiredIndices = requiredSteps.map((name) => episodeSteps.findIndex((step) => step.name === name));
  if (requiredIndices.some((index) => index < 0) || requiredIndices.some((index, position) => position > 0 && index <= requiredIndices[position - 1])) {
    issues.push("required episode steps are missing, duplicated, or out of order");
  }
  if (episodeSteps.some((step) => step.status !== "completed")) issues.push("episode contains a non-completed step");
  for (const step of episodeSteps) {
    const started = Date.parse(String(step.startedAt ?? ""));
    const finished = Date.parse(String(step.finishedAt ?? ""));
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started || Number(step.durationMs) < 0) {
      issues.push(`episode step has invalid timing: ${String(step.name ?? "<unknown>")}`);
    }
  }
  const collectStepHashes = object(episodeSteps.find((step) => step.name === "collect_fixed_evidence")?.outputHashes) ?? {};
  const goStepHashes = object(episodeSteps.find((step) => step.name === "infer_go")?.outputHashes) ?? {};
  const assembleStepHashes = object(episodeSteps.find((step) => step.name === "assemble_outputs")?.outputHashes) ?? {};
  if (String(collectStepHashes.evidenceBundle) !== hashCanonical(bundle)) issues.push("collect-evidence step hash does not match evidence bundle");
  if (String(goStepHashes.goPrediction) !== String(go.canonicalHash)) issues.push("GO-inference step hash does not match GO artifact");
  if (String(assembleStepHashes.finalPrediction) !== hashCanonical(prediction)) issues.push("assembly step hash does not match final prediction content");
  if (String(assembleStepHashes.criticReview) !== hashCanonical(critic)) issues.push("assembly step hash does not match critic review content");
  const feedback = object(episode.biologicalFeedback);
  if (!feedback || feedback.status !== "unavailable" || feedback.eligibleForEvolution !== false) {
    issues.push("generation-0 episode must explicitly be ineligible for evolution without biological feedback");
  }
  const episodeHashes = object(episode.outputHashes) ?? {};
  if (String(episodeHashes.genome) !== String(genomeSnapshot.genomeHash)) issues.push("episode genome output hash mismatch");
  if (String(episodeHashes.goPredictionAudit) !== String(go.canonicalHash)) issues.push("episode authoritative GO audit hash mismatch");
  if (String(episodeHashes.blindGoPrediction) !== String(blindGo.canonicalHash)) issues.push("episode blind GO output hash mismatch");
  if (String(episodeHashes.blindEvidenceBundle) !== hashCanonical(blindBundle)) issues.push("episode blind evidence bundle hash mismatch");
  if (String(episodeHashes.goTsv) !== await sha256File(paths.goTsv)) issues.push("episode GO TSV hash mismatch");
  if (String(episodeHashes.evidenceBundle) !== hashCanonical(bundle)) issues.push("episode evidence bundle hash mismatch");
  if (String(episodeHashes.evidenceManifest) !== await sha256File(paths.evidenceManifest)) issues.push("episode evidence manifest hash mismatch");
  if (String(episodeHashes.finalPrediction) !== await sha256File(paths.prediction)) issues.push("episode final prediction file hash mismatch");
  if (String(episodeHashes.criticReview) !== await sha256File(paths.critic)) issues.push("episode critic review file hash mismatch");
  if (String(episodeHashes.agentAudit) !== await sha256File(paths.audit)) issues.push("episode agent audit file hash mismatch");
  if (String(episodeHashes.markdownReport) !== await sha256File(paths.markdown)) issues.push("episode Markdown report hash mismatch");
  if (String(episodeHashes.htmlReport) !== await sha256File(paths.html)) issues.push("episode HTML report hash mismatch");

  return { ok: issues.length === 0, runDir, issues };
}
