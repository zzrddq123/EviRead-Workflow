import { writeFile } from "node:fs/promises";

import { CANDIDATE_SOURCE_TYPES, normalizeCandidateSourceBundle, type CandidateSourceType, type GOCandidateEvidence } from "./candidate_sources.js";
import { ancestorsOf, GO_ROOT_IDS, resolveGoTerm, type GOOntology } from "./go_ontology.js";
import {
  applyGOJudgeResult,
  buildGOJudgeBinding,
  judgeGOCandidatesDeterministically,
} from "./go_judge.js";
import { hashCanonical } from "./hash.js";
import { applyGOSelection } from "./go_selection.js";
import {
  adjustByPhylogeny,
  DEFAULT_PHYLOGENY_POLICY,
  orderedLineageDiceOverlap,
  type PhylogenyPolicy,
} from "./phylogeny.js";
import type {
  AgentGenome,
  GOAspect,
  GODonorSupport,
  GOPredictionSet,
  GOTermPrediction,
  GenomeSnapshot,
  TargetContext,
  TargetMode,
} from "./types.js";
import { canonicalAccession } from "./accession.js";

type JsonObject = Record<string, unknown>;

interface MatchSupport {
  accession: string;
  mode: "sequence" | "full_structure" | "local_structure" | "domain_structure";
  score: number;
  evidenceIds: string[];
  hasSequence: boolean;
  sequenceScore: number;
  structureQualityFactor: number;
}

interface TermAccumulator {
  goId: string;
  termName: string;
  aspect: GOAspect;
  supports: GODonorSupport[];
  sourceGoIds: Set<string>;
  minimumOntologyDepth: number;
}

const ASPECT_ORDER: GOAspect[] = ["molecular_function", "biological_process", "cellular_component", "unknown"];
const GO_ROOT_ID_SET = new Set<string>(Object.values(GO_ROOT_IDS));

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function records(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is JsonObject => item !== undefined) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integerOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function round(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function evidenceAccessions(item: JsonObject): string[] {
  const direct = [item.accession, item.pdb_id, item.annotation_accession, item.source_accession, item.provider_accession, item.provider_primary_accession]
    .map(canonicalAccession);
  const aliases = [
    ...(Array.isArray(item.alias_accessions) ? item.alias_accessions : []),
    ...(Array.isArray(item.aliases) ? item.aliases : []),
  ];
  const fromAliases = aliases.flatMap((alias) => {
    const value = record(alias);
    return value
      ? [value.accession, value.id].map(canonicalAccession)
      : [canonicalAccession(alias)];
  });
  return unique([...direct, ...fromAliases]);
}

function resolvedTargetContext(queryTaxonId: number | null, supplied?: TargetContext): TargetContext {
  if (supplied) {
    if (supplied.taxon.taxonId !== queryTaxonId) throw new Error("GO targetContext TaxID does not match the deterministic query TaxID");
    return supplied;
  }
  return {
    taxon: queryTaxonId === null
      ? { taxonId: null, provenance: "unavailable" }
      : { taxonId: queryTaxonId, provenance: "provided" },
    phylogeny: queryTaxonId === null
      ? { mode: "optional", status: "unavailable_missing_taxon" }
      : { mode: "optional", status: "requested" },
  };
}

function phylogenyPolicy(genome: AgentGenome): PhylogenyPolicy {
  const configured = genome.goPolicy.phylogenyPolicy;
  if (!configured) return DEFAULT_PHYLOGENY_POLICY;
  return {
    schemaVersion: "pi-phylogeny-policy.v1",
    relationWeights: { ...configured.relationWeights },
    aspectDistanceDecay: { ...configured.aspectDistanceDecay },
    lineageFloor: configured.lineageFloor,
    lineageRange: configured.lineageRange,
    paralogLeafTransferAllowed: false,
    cladeCollapseDepth: configured.cladeCollapseDepth,
  };
}

function isLearnedCandidateSource(sourceType: GOCandidateEvidence["sourceType"]): boolean {
  return sourceType === "mdeepfri_cnn"
    || sourceType === "mdeepfri_gcn"
    || sourceType === "deepgoplus_cnn"
    || sourceType === "deepgoplus_hybrid";
}

function candidateMatchMode(candidate: GOCandidateEvidence): GODonorSupport["matchMode"] {
  if (candidate.sourceType === "biolm_retrieval") return "learned_sequence";
  if (candidate.sourceType === "mdeepfri_gcn") return "learned_structure";
  if (candidate.sourceType === "mdeepfri_cnn"
    || candidate.sourceType === "deepgoplus_cnn"
    || candidate.sourceType === "deepgoplus_hybrid") {
    return "learned_sequence";
  }
  if (candidate.sourceType === "oma_ortholog") return "orthology";
  if (candidate.sourceType === "oma_fastmap") return "sequence_mapping";
  if (candidate.sourceType === "ec") return "ec_mapping";
  return "domain_mapping";
}

function declaredQueryLikeAccessions(bundle: JsonObject): string[] {
  const protein = record(bundle.protein) ?? {};
  const fromProtein = Array.isArray(protein.query_like_accessions)
    ? protein.query_like_accessions.map(canonicalAccession)
    : [];
  const fromEvidence = ["sequence_hits", "structure_hits", "uniprot_annotations", "pdb_annotations"]
    .flatMap((section) => records(bundle[section]))
    .filter((item) => item.query_like === true)
    .flatMap((item) => evidenceAccessions(item));
  return unique([...fromProtein, ...fromEvidence]);
}

function normalizeDonorGroup(proteinName: string, accession: string): string {
  const normalized = proteinName
    .toLowerCase()
    .replace(/\b(?:mouse|human|rat|protein|isoform|homolog)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return normalized || accession.toLowerCase();
}

function aspectFrom(term: JsonObject): GOAspect {
  const explicit = text(term.aspect);
  if (explicit === "molecular_function" || explicit === "biological_process" || explicit === "cellular_component") return explicit;
  const prefix = text(term.term).slice(0, 2);
  if (prefix === "F:") return "molecular_function";
  if (prefix === "P:") return "biological_process";
  if (prefix === "C:") return "cellular_component";
  return "unknown";
}

function termName(term: JsonObject): string {
  const named = text(term.name);
  if (named) return named;
  return text(term.term).replace(/^[FPC]:/, "") || "name unavailable";
}

function evidenceCode(term: JsonObject): string {
  return (text(term.evidence_code) || text(term.evidence_type).split(":", 1)[0] || "UNKNOWN").toUpperCase();
}

function evidenceWeight(genome: AgentGenome, code: string): number {
  const configured = genome.goPolicy.evidenceWeights[code];
  return round(configured === undefined ? genome.goPolicy.unknownEvidenceWeight : configured);
}

function provenanceRoots(term: JsonObject): string[] {
  return unique(records(term.references).flatMap((reference) => {
    const source = text(reference.source).trim();
    const referenceId = text(reference.reference_id).trim();
    return source && referenceId ? [`${source}:${referenceId}`] : [];
  }));
}

function lineageFactor(
  genome: AgentGenome,
  queryTaxonId: number | null,
  queryLineage: string[],
  donorTaxonId: number | null,
  donorLineage: string[],
): { factor: number; status: "applied" | "unavailable" } {
  if (queryTaxonId !== null && donorTaxonId !== null && queryTaxonId === donorTaxonId) return { factor: 1, status: "applied" };
  const overlap = orderedLineageDiceOverlap(queryLineage, donorLineage);
  if (overlap === null) return { factor: 1, status: "unavailable" };
  return { factor: round(genome.goPolicy.lineageFloor + genome.goPolicy.lineageRange * overlap), status: "applied" };
}

function sequenceMatches(bundle: JsonObject): Map<string, MatchSupport> {
  const output = new Map<string, MatchSupport>();
  for (const hit of records(bundle.sequence_hits)) {
    if (hit.annotation_eligible === false) continue;
    const accession = canonicalAccession(hit.annotation_accession ?? hit.accession);
    if (!accession) continue;
    const subjectLength = Math.max(1, number(hit.subject_length));
    const subjectCoverage = Math.min(1, number(hit.alignment_length) / subjectLength);
    const score = round((number(hit.percent_identity) / 100) * Math.sqrt(number(hit.query_coverage) * subjectCoverage));
    const candidate: MatchSupport = {
      accession,
      mode: "sequence",
      score,
      evidenceIds: [text(hit.evidence_id)].filter(Boolean),
      hasSequence: true,
      sequenceScore: score,
      structureQualityFactor: 1,
    };
    const previous = output.get(accession);
    if (!previous || candidate.score > previous.score) output.set(accession, candidate);
  }
  return output;
}

function structureMatches(bundle: JsonObject, genome: AgentGenome): Map<string, MatchSupport> {
  const output = new Map<string, MatchSupport>();
  const protein = record(bundle.protein) ?? {};
  const alphaFoldConfidence = text(protein.structure_confidence_source) === "alphafold_plddt";
  const fullQuality = alphaFoldConfidence ? Math.max(0, Math.min(1, number(protein.structure_mean_plddt) / 100)) : 1;
  const domains = records(bundle.domain_segments);
  for (const hit of records(bundle.structure_hits)) {
    const referenceDatabase = text(hit.reference_database);
    const bridgedPdb = referenceDatabase === "pdb" && Boolean(canonicalAccession(hit.annotation_accession));
    if ((!bridgedPdb && !["swissprot", "uniprot"].includes(referenceDatabase))
      || hit.annotation_eligible === false) continue;
    const accession = canonicalAccession(hit.annotation_accession ?? hit.accession);
    if (!accession) continue;
    const isFullSearch = text(hit.scope) === "full_length";
    const isGlobal = isFullSearch
      && number(hit.query_coverage) >= genome.goPolicy.globalStructureCoverageFloor
      && number(hit.target_coverage) >= genome.goPolicy.globalStructureCoverageFloor;
    const domain = domains.find((item) => text(item.residue_range) === text(hit.query_domain_range));
    const structureQualityFactor = isFullSearch
      ? fullQuality
      : alphaFoldConfidence && domain ? Math.max(0, Math.min(1, number(domain.mean_plddt) / 100)) : fullQuality;
    const base = number(hit.probability) * number(hit.query_tm_score)
      * Math.sqrt(number(hit.query_coverage) * number(hit.target_coverage));
    const score = round((isGlobal ? base : base * genome.goPolicy.domainStructurePenalty) * structureQualityFactor);
    const candidate: MatchSupport = {
      accession,
      mode: isGlobal ? "full_structure" : isFullSearch ? "local_structure" : "domain_structure",
      score,
      evidenceIds: [text(hit.evidence_id)].filter(Boolean),
      hasSequence: false,
      sequenceScore: 0,
      structureQualityFactor: round(structureQualityFactor),
    };
    const previous = output.get(accession);
    if (!previous || candidate.score > previous.score) output.set(accession, candidate);
  }
  return output;
}

function bestMatches(bundle: JsonObject, genome: AgentGenome): Map<string, MatchSupport> {
  const sequence = sequenceMatches(bundle);
  const structure = structureMatches(bundle, genome);
  const accessions = new Set([...sequence.keys(), ...structure.keys()]);
  const output = new Map<string, MatchSupport>();
  for (const accession of accessions) {
    const seq = sequence.get(accession);
    const str = structure.get(accession);
    if (seq && str && genome.goPolicy.sequenceEligibilityMode === "retained_sequence") {
      const primary = seq.score >= str.score ? seq : str;
      output.set(accession, {
        ...primary,
        // Do not let a stronger structural match erase the independently
        // observed sequence hit. BP/CC transfer may use the primary score,
        // but only when sequence evidence itself clears the aspect threshold.
        evidenceIds: unique([...seq.evidenceIds, ...str.evidenceIds]),
        hasSequence: true,
        sequenceScore: seq.score,
      });
    } else if (seq && (!str || seq.score >= str.score)) output.set(accession, seq);
    else if (str) output.set(accession, str);
  }
  return output;
}

function aggregateIndependentScore(
  supports: GODonorSupport[],
  key: "rawSupport" | "adjustedSupport",
): number {
  const groups = unique(supports.map((support) => support.donorGroup));
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
    for (const root of support.provenanceRoots) rootGroups.set(root, unique([...(rootGroups.get(root) ?? []), support.donorGroup]));
  }
  for (const connected of rootGroups.values()) {
    for (const group of connected.slice(1)) union(connected[0], group);
  }
  const byComponent = new Map<string, number>();
  for (const support of supports) {
    const component = find(support.donorGroup);
    byComponent.set(component, Math.max(byComponent.get(component) ?? 0, support[key]));
  }
  const ranked = [...byComponent.values()].sort((a, b) => b - a);
  return round(0.7 * (ranked[0] ?? 0) + 0.2 * (ranked[1] ?? 0) + 0.1 * (ranked[2] ?? 0));
}

/**
 * The stock DeepGOPlus hybrid score already contains a DIAMOND homology
 * transfer component. It is therefore a correlated predictor prior, not a
 * second independent donor. Combine it with the host score by max rather than
 * awarding the extra 0.2 provenance-component vote, and preserve its native
 * score when it is the only source.
 */
function aggregateScore(supports: GODonorSupport[], key: "rawSupport" | "adjustedSupport"): number {
  const hybrid = supports.filter((support) =>
    support.candidateSourceType === "deepgoplus_hybrid");
  if (hybrid.length === 0) return aggregateIndependentScore(supports, key);
  const host = supports.filter((support) =>
    support.candidateSourceType !== "deepgoplus_hybrid");
  const hostScore = host.length === 0 ? 0 : aggregateIndependentScore(host, key);
  const hybridScore = Math.max(0, ...hybrid.map((support) => support[key]));
  return round(Math.max(hostScore, hybridScore));
}

function independentGroupRootCount(supports: GODonorSupport[], supportFloor: number): number {
  const edges = new Map<string, string[]>();
  for (const support of supports) {
    if (support.adjustedSupport < supportFloor) continue;
    const roots = edges.get(support.donorGroup) ?? [];
    edges.set(support.donorGroup, unique([...roots, ...support.provenanceRoots]));
  }
  const rootOwner = new Map<string, string>();
  const visit = (group: string, seen: Set<string>): boolean => {
    for (const root of edges.get(group) ?? []) {
      if (seen.has(root)) continue;
      seen.add(root);
      const owner = rootOwner.get(root);
      if (owner === undefined || visit(owner, seen)) {
        rootOwner.set(root, group);
        return true;
      }
    }
    return false;
  };
  let count = 0;
  for (const group of [...edges.keys()].sort()) if (visit(group, new Set())) count += 1;
  return count;
}

function rankTerms(a: GOTermPrediction, b: GOTermPrediction): number {
  const decisionRank: Record<string, number> = { transfer_hypothesis: 0, abstained: 1 };
  return decisionRank[a.decision] - decisionRank[b.decision]
    || ASPECT_ORDER.indexOf(a.aspect) - ASPECT_ORDER.indexOf(b.aspect)
    || (b.phylogenyAdjustedScore ?? -1) - (a.phylogenyAdjustedScore ?? -1)
    || a.goId.localeCompare(b.goId);
}

export function inferGoPredictions(input: {
  proteinId: string;
  bundle: JsonObject;
  genome: GenomeSnapshot;
  queryTaxonId?: number | null;
  targetContext?: TargetContext;
  targetMode?: TargetMode;
  excludedAccessions?: string[];
  identityPolicy?: "strict_blind_v1" | "temporal_t0_v1";
  ontology?: GOOntology;
  /**
   * The pure replay/evaluator path uses the deterministic bounded judge by
   * default when the genome enables it. The runtime may request `disabled`
   * temporarily so an audited Pi judgment can be applied at the orchestration
   * boundary without making this synchronous scientific core network-aware.
   */
  goJudgeMode?: "deterministic" | "disabled";
}): GOPredictionSet {
  const { bundle, genome: snapshot } = input;
  const genome = snapshot.genome;
  const targetMode = input.targetMode ?? "anonymous";
  const identityPolicy = input.identityPolicy ?? "temporal_t0_v1";
  const explicitlyExcludedAccessions = unique((input.excludedAccessions ?? []).map(canonicalAccession));
  // Similarity is evidence, not an identity/quarantine rule. Do not infer
  // query identity from percent identity or coverage: even a 99%+ sequence
  // hit remains an ordinary donor unless explicitly marked query_like or
  // explicitly excluded by the evaluator.
  const detectedQueryLikeAccessions = unique([
    ...explicitlyExcludedAccessions,
    ...declaredQueryLikeAccessions(bundle),
  ]);
  const queryLikeAccessions = identityPolicy === "strict_blind_v1" ? detectedQueryLikeAccessions : [];
  const queryLike = new Set(queryLikeAccessions);
  // A display label such as KIAA… is not necessarily a database accession.
  // Exclusions remain explicit audit data; query identity is never inferred.
  const accession = null;
  const protein = record(bundle.protein) ?? {};
  const resolvedTaxonId = input.queryTaxonId ?? integerOrNull(protein.query_taxon_id);
  const targetContext = resolvedTargetContext(resolvedTaxonId, input.targetContext);
  const annotations = records(bundle.uniprot_annotations)
    .filter((item) => text(item.retrieval_status) === "completed")
    .sort((a, b) => text(a.accession).localeCompare(text(b.accession)));
  const declaredLineageSource = ["declared_taxid_lookup", "target_taxonomy_provider", "frozen_donor_consensus"].includes(text(protein.query_lineage_source));
  const queryLineage = declaredLineageSource && Array.isArray(protein.query_lineage)
    ? protein.query_lineage.map(text).filter(Boolean)
    : [];
  const matches = bestMatches(bundle, genome);
  const quarantinedGoIds = new Set<string>();
  // Keep ontology rejection separate from identity quarantine. The latter is
  // validated against query-like annotation records, while this set records
  // otherwise admissible evidence whose GO ID is absent from the active
  // pinned ontology (including obsolete IDs omitted by go-basic parsing).
  const ontologyQuarantinedGoIds = new Set<string>();
  const accumulators = new Map<string, TermAccumulator>();
  const ontologyPolicy = genome.goPolicy.ontologyPolicy;
  const ontologyClosurePolicy = ontologyPolicy?.mode === "ancestor_closure" ? ontologyPolicy : undefined;
  const ontologyEnabled = ontologyClosurePolicy !== undefined;
  const candidateBundle = normalizeCandidateSourceBundle(bundle);
  const candidatePolicy = genome.goPolicy.candidateSourcePolicy;
  const candidateSourcesEnabled = candidatePolicy?.mode === "storage_light";
  const learnedPredictorPolicy = genome.goPolicy.learnedPredictorPolicy;
  const learnedPredictorEnabled = learnedPredictorPolicy?.mode === "candidate_channel";
  const predictionGapBaselineAspects = new Set<Exclude<GOAspect, "unknown">>();
  const hostBaselineGoIds = new Set<string>();
  if (learnedPredictorEnabled
    && (learnedPredictorPolicy.activationMode === "prediction_aspect_gap_only"
      || learnedPredictorPolicy.activationMode === "host_term_agreement_only")) {
    const baselineGenome = structuredClone(snapshot);
    baselineGenome.genome.goPolicy.learnedPredictorPolicy = {
      ...learnedPredictorPolicy,
      mode: "disabled",
    };
    baselineGenome.genomeHash = hashCanonical(baselineGenome.genome);
    const baselinePrediction = inferGoPredictions({
      ...input,
      genome: baselineGenome,
      // The rescue gate is a deterministic host decision and must not depend
      // on an external or bounded judge invocation.
      goJudgeMode: "disabled",
    });
    for (const term of baselinePrediction.terms) {
      const score = term.fusionAdjustedScore ?? term.judgeAdjustedScore ?? term.phylogenyAdjustedScore ?? 0;
      if (term.aspect !== "unknown" && term.preBudgetEligible !== false && score > 0) {
        predictionGapBaselineAspects.add(term.aspect);
        hostBaselineGoIds.add(term.goId);
      }
    }
  }
  const phylogenyEnabled = genome.goPolicy.phylogenyPolicy?.mode === "orthology_aware";
  const selectionMode = genome.goPolicy.selectionPolicy?.mode ?? "disabled";
  const selectionAspects = genome.goPolicy.selectionPolicy?.aspects;
  let appliedCandidateCount = 0;
  let selectionEligibleCandidateCount = 0;
  let appliedPhylogenyCount = 0;
  let quarantinedPhylogenyCount = 0;
  const directGoIds = new Set<string>();
  const candidateSourceStats = new Map<CandidateSourceType, {
    normalized: number;
    admitted: number;
    selectionEligible: number;
  }>(CANDIDATE_SOURCE_TYPES.map((sourceType) => [sourceType, {
    normalized: candidateBundle.candidates.filter((candidate) => candidate.sourceType === sourceType).length,
    admitted: 0,
    selectionEligible: 0,
  }]));
  const novelCandidateGoIds = new Map<CandidateSourceType, Set<string>>(
    CANDIDATE_SOURCE_TYPES.map((sourceType) => [sourceType, new Set<string>()]),
  );
  if (ontologyEnabled && !input.ontology) {
    throw new Error("Genome requires ancestor_closure but no pinned GO ontology was supplied");
  }
  if (input.ontology && !ontologyEnabled) {
    throw new Error("A supplied GO ontology requires a genome-bound ancestor_closure policy");
  }

  const addSupport = (parameters: {
    goId: string;
    name: string;
    aspect: GOAspect;
    support: GODonorSupport;
    sourceGoId: string;
    ontologyDepth: number;
  }): void => {
    const existing = accumulators.get(parameters.goId) ?? {
      goId: parameters.goId,
      termName: parameters.name,
      aspect: parameters.aspect,
      supports: [],
      sourceGoIds: new Set<string>(),
      minimumOntologyDepth: parameters.ontologyDepth,
    };
    existing.supports.push(parameters.support);
    existing.sourceGoIds.add(parameters.sourceGoId);
    existing.minimumOntologyDepth = Math.min(existing.minimumOntologyDepth, parameters.ontologyDepth);
    accumulators.set(parameters.goId, existing);
  };

  for (const annotation of annotations) {
    const donorAccession = canonicalAccession(annotation.accession);
    const annotationEvidenceId = text(annotation.evidence_id);
    const isQueryLike = queryLike.has(donorAccession);
    const match = matches.get(donorAccession);
    if (!isQueryLike && !match) continue;
    const proteinName = text(annotation.protein_name) || donorAccession;
    const donorGroup = normalizeDonorGroup(proteinName, donorAccession);
    const donorLineage = Array.isArray(annotation.organism_lineage)
      ? annotation.organism_lineage.map(text).filter(Boolean)
      : [];
    const donorTaxonId = integerOrNull(annotation.organism_taxon_id);
    const lineage = lineageFactor(genome, resolvedTaxonId, queryLineage, donorTaxonId, donorLineage);

    for (const term of records(annotation.go_terms)) {
      const rawGoId = text(term.id).toUpperCase();
      if (!/^GO:\d{7}$/.test(rawGoId)) continue;
      const ontologyTerm = input.ontology ? resolveGoTerm(input.ontology, rawGoId) : undefined;
      const goId = ontologyTerm?.id ?? rawGoId;
      if (isQueryLike) {
        quarantinedGoIds.add(goId);
        continue;
      }
      if (input.ontology && !ontologyTerm) {
        ontologyQuarantinedGoIds.add(rawGoId);
        continue;
      }
      if (ontologyEnabled && GO_ROOT_ID_SET.has(goId)) continue;
      if (!match) continue;
      const aspect = ontologyTerm?.namespace ?? aspectFrom(term);
      const code = evidenceCode(term);
      const roots = provenanceRoots(term);
      const weight = evidenceWeight(genome, code);
      const rawSupport = round(match.score * weight);
      const adjustedSupport = round(rawSupport * lineage.factor);
      const support: GODonorSupport = {
        accession: donorAccession,
        donorGroup,
        proteinName,
        organism: text(annotation.organism),
        taxonId: donorTaxonId,
        annotationEvidenceId,
        matchEvidenceIds: match.evidenceIds,
        matchMode: match.mode,
        ...(genome.goPolicy.sequenceEligibilityMode === "retained_sequence" ? {
          hasSequence: match.hasSequence,
          sequenceSimilarityScore: match.sequenceScore,
        } : {}),
        similarityScore: match.score,
        evidenceCode: code,
        provenanceRoots: roots,
        evidenceWeight: weight,
        structureQualityFactor: match.structureQualityFactor,
        lineageFactor: lineage.factor,
        lineageStatus: lineage.status,
        rawSupport,
        adjustedSupport,
      };
      addSupport({
        goId,
        name: ontologyTerm?.name ?? termName(term),
        aspect,
        support,
        sourceGoId: goId,
        ontologyDepth: 0,
      });
      directGoIds.add(goId);
      if (ontologyClosurePolicy && input.ontology && ontologyTerm) {
        for (const ancestor of ancestorsOf(input.ontology, ontologyTerm.id, {
          maxDepth: ontologyClosurePolicy.maxDepth,
          sameNamespace: true,
          excludeRoots: ontologyClosurePolicy.excludeRoots,
        })) {
          const decay = ontologyClosurePolicy.scoreDecay ** ancestor.depth;
          const propagatedSimilarity = round(support.similarityScore * decay);
          const propagatedRaw = round(propagatedSimilarity * support.evidenceWeight);
          addSupport({
            goId: ancestor.id,
            name: ancestor.name,
            aspect: ancestor.namespace,
            support: {
              ...support,
              similarityScore: propagatedSimilarity,
              ...(support.sequenceSimilarityScore === undefined ? {} : {
                sequenceSimilarityScore: round(support.sequenceSimilarityScore * decay),
              }),
              rawSupport: propagatedRaw,
              adjustedSupport: round(propagatedRaw * support.lineageFactor),
              ontologyDepth: ancestor.depth,
              sourceGoId: ontologyTerm.id,
            },
            sourceGoId: ontologyTerm.id,
            ontologyDepth: ancestor.depth,
          });
        }
      }
    }
  }

  // A learned channel can be routed as a rescue-only method without looking at
  // labels or private target identity.  This host-side gate is computed solely
  // from already admitted donor annotations before provider candidates run.
  // Ontology ancestors do not manufacture coverage: only direct annotated
  // terms count as evidence that an aspect is already represented.
  const directlyAnnotatedAspects = new Set(
    [...directGoIds]
      .map((goId) => accumulators.get(goId)?.aspect)
      .filter((aspect): aspect is Exclude<GOAspect, "unknown"> => aspect !== undefined && aspect !== "unknown"),
  );

  if ((candidateSourcesEnabled && candidatePolicy) || (learnedPredictorEnabled && learnedPredictorPolicy)) {
    const allowed = new Set<string>(candidatePolicy?.allowedSources ?? []);
    const allowedAspects = new Set(candidatePolicy?.allowedAspects ?? [
      "molecular_function",
      "biological_process",
      "cellular_component",
    ]);
    const learnedAllowed = new Set<string>(learnedPredictorPolicy?.allowedSources ?? []);
    const learnedAllowedAspects = new Set(learnedPredictorPolicy?.allowedAspects ?? []);
    const learnedRankedEvidenceIds = learnedPredictorPolicy?.maxCandidatesPerAspect === undefined
      ? null
      : new Set(
        [...learnedAllowedAspects].flatMap((aspect) =>
          candidateBundle.candidates
            .filter((candidate) => {
              if (!isLearnedCandidateSource(candidate.sourceType)
                || !learnedAllowed.has(candidate.sourceType)
                || candidate.queryLike
                || (candidate.donorAccession !== null
                  && queryLike.has(canonicalAccession(candidate.donorAccession)))) return false;
              const ontologyTerm = input.ontology
                ? resolveGoTerm(input.ontology, candidate.goId)
                : undefined;
              if (input.ontology && !ontologyTerm) return false;
              const resolvedGoId = ontologyTerm?.id ?? candidate.goId;
              return (ontologyTerm?.namespace ?? candidate.aspect) === aspect
                && (learnedPredictorPolicy.activationMode !== "host_term_agreement_only"
                  || hostBaselineGoIds.has(resolvedGoId));
            })
            .sort((left, right) =>
              right.baseScore - left.baseScore
              || left.goId.localeCompare(right.goId)
              || left.provenanceRoot.localeCompare(right.provenanceRoot)
              || left.evidenceId.localeCompare(right.evidenceId))
            .slice(0, learnedPredictorPolicy.maxCandidatesPerAspect)
            .map((candidate) => candidate.evidenceId)),
      );
    for (const candidate of candidateBundle.candidates) {
      const learnedCandidate = isLearnedCandidateSource(candidate.sourceType);
      if (learnedCandidate
        ? !learnedPredictorEnabled || !learnedAllowed.has(candidate.sourceType)
        : !candidateSourcesEnabled || !allowed.has(candidate.sourceType)) continue;
      const ontologyTerm = input.ontology ? resolveGoTerm(input.ontology, candidate.goId) : undefined;
      const goId = ontologyTerm?.id ?? candidate.goId;
      const candidateIsQueryLike = candidate.queryLike
        || (candidate.donorAccession !== null && queryLike.has(canonicalAccession(candidate.donorAccession)));
      if (candidateIsQueryLike) {
        quarantinedGoIds.add(goId);
        quarantinedPhylogenyCount += Number(candidate.phylogeny !== null);
        continue;
      }
      if (input.ontology && !ontologyTerm) {
        ontologyQuarantinedGoIds.add(candidate.goId);
        continue;
      }
      // Learned hybrid rows are direct agent-facing hypotheses, but the three
      // namespace roots are never useful function predictions.  Reject a
      // direct root even when no ontology snapshot is configured; otherwise a
      // root emitted by the provider could pass the learned-candidate policy.
      if ((ontologyEnabled || candidate.sourceType === "deepgoplus_hybrid")
        && GO_ROOT_ID_SET.has(goId)) continue;
      const aspect = ontologyTerm?.namespace ?? candidate.aspect;
      if (aspect === "unknown") continue;
      if (learnedCandidate ? !learnedAllowedAspects.has(aspect) : !allowedAspects.has(aspect)) continue;
      if (learnedCandidate
        && learnedRankedEvidenceIds !== null
        && !learnedRankedEvidenceIds.has(candidate.evidenceId)) continue;
      if (learnedCandidate
        && learnedPredictorPolicy?.activationMode === "direct_annotation_gap_only"
        && directlyAnnotatedAspects.has(aspect)) continue;
      if (learnedCandidate
        && learnedPredictorPolicy?.activationMode === "prediction_aspect_gap_only"
        && predictionGapBaselineAspects.has(aspect)) continue;
      if (learnedCandidate
        && learnedPredictorPolicy?.activationMode === "host_term_agreement_only"
        && !hostBaselineGoIds.has(goId)) continue;
      if (candidate.sourceType === "ec" && aspect !== "molecular_function") continue;

      const code = candidate.annotationEvidenceCode;
      // Candidate admission and final selection are deliberately separate.
      // Every valid, non-query-like, evidence-backed term enters the pool.
      // Provider floors only decide whether that support can authorize a
      // selected leaf term; below-floor hypotheses remain auditable abstentions.
      const candidateSelectionEligible = learnedCandidate
        ? candidate.baseScore >= learnedPredictorPolicy!.minimumScore
        : candidate.baseScore >= candidatePolicy!.minimumBaseScore
          && (candidate.queryCoverage === null || candidate.queryCoverage >= candidatePolicy!.minimumQueryCoverage);
      // Provider baseScore already encodes query-to-signature/ortholog support.
      // A genome may therefore test a bounded floor for the *second* (GO
      // annotation-code) attenuation without weakening the provider gates or
      // changing ordinary similarity-transfer evidence weights.
      const baseEvidenceWeight = evidenceWeight(genome, code);
      const weight = learnedCandidate
        ? learnedPredictorPolicy!.scoreScale
        : candidateSelectionEligible
          ? Math.max(baseEvidenceWeight, candidatePolicy!.minimumEvidenceWeight ?? 0)
          : baseEvidenceWeight;
      // A learned score floor is a true method gate: retain below-floor rows
      // for audit, but do not let them alter fused scores or ontology ranks.
      const rawSupport = learnedCandidate && !candidateSelectionEligible
        ? 0
        : round(candidate.baseScore * weight);
      let adjustmentFactor = 1;
      let leafTransferAllowed = true;
      let cladeKey = candidate.provenanceRoot;
      let relation: GODonorSupport["orthologyRelation"];
      let components: GODonorSupport["phylogenyComponents"];
      let donorTaxonId: number | null = null;
      let donorLineage: string[] = [];
      if (candidate.phylogeny) {
        relation = candidate.phylogeny.relation;
        donorTaxonId = candidate.phylogeny.donorTaxonId;
        donorLineage = candidate.phylogeny.donorLineage;
        if (phylogenyEnabled) {
          const adjustment = adjustByPhylogeny({
            aspect,
            evidence: {
              ...candidate.phylogeny,
              targetTaxonId: targetContext.taxon.taxonId,
              targetLineage: queryLineage,
              queryLike: candidate.queryLike || candidate.phylogeny.queryLike,
            },
            policy: phylogenyPolicy(genome),
          });
          if (adjustment.status === "quarantined" || adjustment.status === "taxon_forbidden") {
            quarantinedGoIds.add(goId);
            quarantinedPhylogenyCount += 1;
            continue;
          }
          adjustmentFactor = adjustment.combinedFactor;
          leafTransferAllowed = adjustment.leafTransferAllowed;
          cladeKey = adjustment.cladeKey;
          components = {
            relationFactor: adjustment.relationFactor,
            distanceFactor: adjustment.distanceFactor,
            lineageFactor: adjustment.lineageFactor,
            taxonConstraintFactor: adjustment.taxonConstraintFactor,
          };
          if (adjustment.status === "applied") appliedPhylogenyCount += 1;
        }
      }
      const adjustedSupport = round(rawSupport * adjustmentFactor);
      const syntheticAccession = candidate.donorAccession ?? `${candidate.sourceType.toUpperCase()}:${candidate.sourceId}`;
      const support: GODonorSupport = {
        accession: syntheticAccession,
        donorGroup: cladeKey,
        proteinName: `${candidate.sourceType} GO candidate`,
        organism: "provider-recorded donor",
        taxonId: donorTaxonId,
        annotationEvidenceId: candidate.evidenceId,
        // Keep the provider mapping record and its distinct OMA phylogeny
        // record available to the bounded judge. They share one provenance
        // root downstream, so exposing both roles does not make them
        // independent evidence.
        matchEvidenceIds: unique([
          candidate.evidenceId,
          ...(candidate.phylogeny?.evidenceId ? [candidate.phylogeny.evidenceId] : []),
        ]),
        matchMode: candidateMatchMode(candidate),
        similarityScore: candidate.baseScore,
        evidenceCode: code,
        provenanceRoots: [candidate.provenanceRoot],
        evidenceWeight: weight,
        structureQualityFactor: 1,
        lineageFactor: adjustmentFactor,
        lineageStatus: candidate.phylogeny && phylogenyEnabled && targetContext.taxon.taxonId !== null ? "applied" : "unavailable",
        candidateSourceType: candidate.sourceType,
        sourceProvider: candidate.provider,
        candidateBaseScore: candidate.baseScore,
        candidateQueryCoverage: candidate.queryCoverage,
        candidateSelectionEligible,
        ...(relation ? { orthologyRelation: relation } : {}),
        cladeKey,
        leafTransferAllowed,
        ...(components ? { phylogenyComponents: components } : {}),
        rawSupport,
        adjustedSupport,
      };
      addSupport({
        goId,
        name: ontologyTerm?.name ?? candidate.termName,
        aspect,
        support,
        sourceGoId: goId,
        ontologyDepth: 0,
      });
      appliedCandidateCount += 1;
      const stats = candidateSourceStats.get(candidate.sourceType)!;
      stats.admitted += 1;
      if (candidateSelectionEligible) {
        stats.selectionEligible += 1;
        selectionEligibleCandidateCount += 1;
      }
      if (!directGoIds.has(goId)) novelCandidateGoIds.get(candidate.sourceType)!.add(goId);
      if (ontologyClosurePolicy
        && input.ontology
        && ontologyTerm) {
        for (const ancestor of ancestorsOf(input.ontology, ontologyTerm.id, {
          maxDepth: ontologyClosurePolicy.maxDepth,
          sameNamespace: true,
          // A DeepGOPlus hybrid row is treated here as a direct, agent-safe
          // score.  The host may therefore derive its safe is_a/part_of
          // closure, but may never turn a namespace root into a prediction,
          // even if an experimental genome permits roots for other evidence.
          excludeRoots: candidate.sourceType === "deepgoplus_hybrid"
            ? true
            : ontologyClosurePolicy.excludeRoots,
        })) {
          const decay = ontologyClosurePolicy.scoreDecay ** ancestor.depth;
          const propagatedSimilarity = round(support.similarityScore * decay);
          const propagatedRaw = support.candidateSourceType !== undefined
            && isLearnedCandidateSource(support.candidateSourceType)
            && support.candidateSelectionEligible === false
            ? 0
            : round(propagatedSimilarity * support.evidenceWeight);
          addSupport({
            goId: ancestor.id,
            name: ancestor.name,
            aspect: ancestor.namespace,
            support: {
              ...support,
              similarityScore: propagatedSimilarity,
              rawSupport: propagatedRaw,
              adjustedSupport: round(propagatedRaw * support.lineageFactor),
              leafTransferAllowed: true,
              ontologyDepth: ancestor.depth,
              sourceGoId: ontologyTerm.id,
            },
            sourceGoId: ontologyTerm.id,
            ontologyDepth: ancestor.depth,
          });
        }
      }
    }
  }

  const transferred: GOTermPrediction[] = [];
  for (const accumulator of [...accumulators.values()].sort((a, b) => a.goId.localeCompare(b.goId))) {
    const supportsByAccession = new Map<string, GODonorSupport>();
    for (const support of accumulator.supports) {
      const current = supportsByAccession.get(support.accession);
      if (!current || support.adjustedSupport > current.adjustedSupport) supportsByAccession.set(support.accession, support);
    }
    const supports = [...supportsByAccession.values()].sort((a, b) => b.adjustedSupport - a.adjustedSupport || a.accession.localeCompare(b.accession));
    // DeepGOPlus hybrid already contains a DIAMOND homology component.  It can
    // authorize transfer through the learned-candidate policy below, but it
    // must not masquerade as a second ordinary structure donor group/root.
    const ordinaryStructureSupports = supports.filter(
      (support) => support.candidateSourceType !== "deepgoplus_hybrid",
    );
    const groupSupport = new Map<string, number>();
    for (const support of ordinaryStructureSupports) {
      groupSupport.set(support.donorGroup, Math.max(groupSupport.get(support.donorGroup) ?? 0, support.adjustedSupport));
    }
    const qualifyingGroupCount = [...groupSupport.values()].filter((value) => value >= genome.goPolicy.minimumDonorGroupSupport).length;
    const independentRootCount = independentGroupRootCount(
      ordinaryStructureSupports,
      genome.goPolicy.minimumDonorGroupSupport,
    );
    const rawScore = aggregateScore(supports, "rawSupport");
    const adjustedScore = aggregateScore(supports, "adjustedSupport");
    const knownAspect = accumulator.aspect !== "unknown";
    const threshold = accumulator.aspect === "unknown" ? 1 : genome.goPolicy.thresholds[accumulator.aspect];
    const hasSequence = supports.some((item) => {
      if ((genome.goPolicy.sequenceEligibilityMode ?? "primary_only") === "primary_only") {
        return item.matchMode === "sequence" && item.adjustedSupport >= threshold;
      }
      const sequenceScore = item.sequenceSimilarityScore
        ?? (item.matchMode === "sequence" ? item.similarityScore : 0);
      return (item.hasSequence ?? item.matchMode === "sequence")
        && round(sequenceScore * item.evidenceWeight * item.lineageFactor) >= threshold;
    });
    const candidateSupports = supports.filter((item) => item.candidateSourceType !== undefined);
    const selectionEligibleCandidateSupports = candidateSupports.filter((item) => item.candidateSelectionEligible !== false);
    const standardCandidateSupports = selectionEligibleCandidateSupports.filter((item) =>
      item.candidateSourceType === undefined || !isLearnedCandidateSource(item.candidateSourceType));
    const learnedCandidateSupports = selectionEligibleCandidateSupports.filter((item) =>
      item.candidateSourceType !== undefined && isLearnedCandidateSource(item.candidateSourceType));
    const standardCandidateRoots = new Set(standardCandidateSupports
      .filter((item) => item.adjustedSupport >= genome.goPolicy.minimumDonorGroupSupport)
      .flatMap((item) => item.provenanceRoots));
    const learnedCandidateRoots = new Set(learnedCandidateSupports
      .filter((item) => item.adjustedSupport >= genome.goPolicy.minimumDonorGroupSupport)
      .flatMap((item) => item.provenanceRoots));
    const standardCandidateTransferAllowed = candidateSourcesEnabled
      && candidatePolicy !== undefined
      && standardCandidateRoots.size >= candidatePolicy.requireIndependentRoots
      && standardCandidateSupports.some((item) => item.adjustedSupport >= threshold && item.leafTransferAllowed !== false);
    const learnedCandidateTransferAllowed = learnedPredictorEnabled
      && learnedPredictorPolicy !== undefined
      && learnedCandidateRoots.size >= learnedPredictorPolicy.requireIndependentRoots
      && learnedCandidateSupports.some((item) => item.adjustedSupport >= threshold && item.leafTransferAllowed !== false);
    const candidateTransferAllowed = standardCandidateTransferAllowed || learnedCandidateTransferAllowed;
    const structureTransferAllowed = accumulator.aspect === "molecular_function"
      && (!genome.goPolicy.requireTwoStructureDonorGroups || qualifyingGroupCount >= 2)
      && independentRootCount >= genome.goPolicy.minimumIndependentProvenanceRoots;
    const eligible = knownAspect && adjustedScore >= threshold && (hasSequence || structureTransferAllowed || candidateTransferAllowed);
    const reasons: string[] = [];
    const selectionBlockers: NonNullable<GOTermPrediction["selectionBlockers"]> = [];
    if (!knownAspect) {
      reasons.push("GO aspect is unavailable or malformed.");
      selectionBlockers.push("unknown_aspect");
    }
    if (!hasSequence && !candidateTransferAllowed && accumulator.aspect !== "molecular_function") reasons.push("Structure-only transfer is disabled for biological-process and cellular-component terms.");
    if (!hasSequence && !candidateTransferAllowed && accumulator.aspect === "molecular_function" && qualifyingGroupCount < 2) reasons.push(`Structure-only molecular-function transfer requires two donor protein groups with support at least ${genome.goPolicy.minimumDonorGroupSupport.toFixed(3)}.`);
    if (!hasSequence && !candidateTransferAllowed && accumulator.aspect === "molecular_function" && independentRootCount < genome.goPolicy.minimumIndependentProvenanceRoots) reasons.push(`Only ${independentRootCount} independent donor-group/provenance-root pair(s) passed the support floor; ${genome.goPolicy.minimumIndependentProvenanceRoots} are required.`);
    if (candidateSupports.length > 0 && !candidateTransferAllowed) {
      const belowProviderFloor = candidateSupports.filter((item) => item.candidateSelectionEligible === false).length;
      if (belowProviderFloor > 0) reasons.push(`${belowProviderFloor} evidence-backed candidate support(s) remain in the pool but cannot authorize selection because provider score/coverage floors were not met.`);
      if (standardCandidateSupports.length > 0 && standardCandidateRoots.size < (candidatePolicy?.requireIndependentRoots ?? 1)) reasons.push(`Candidate-source transfer requires ${candidatePolicy?.requireIndependentRoots ?? 1} independent provenance root(s); ${standardCandidateRoots.size} passed the support floor.`);
      if (learnedCandidateSupports.length > 0 && learnedCandidateRoots.size < (learnedPredictorPolicy?.requireIndependentRoots ?? 1)) reasons.push(`Learned-predictor transfer requires ${learnedPredictorPolicy?.requireIndependentRoots ?? 1} independent model provenance root(s); ${learnedCandidateRoots.size} passed the support floor.`);
      if (selectionEligibleCandidateSupports.length > 0
        && !selectionEligibleCandidateSupports.some((item) =>
          item.adjustedSupport >= threshold && item.leafTransferAllowed !== false)) {
        reasons.push(`No selection-eligible candidate support clears the ${threshold.toFixed(3)} GO-term threshold.`);
      }
      if (candidateSupports.every((item) => item.leafTransferAllowed === false)) reasons.push("Available phylogeny evidence supports only a broad ancestor or abstention, not this leaf GO term.");
    }
    if (!hasSequence && !structureTransferAllowed && !candidateTransferAllowed) {
      if (accumulator.aspect !== "molecular_function" && candidateSupports.length === 0) selectionBlockers.push("non_mf_structure_only");
      if (accumulator.aspect === "molecular_function" && qualifyingGroupCount < 2) selectionBlockers.push("insufficient_structure_groups");
      if (accumulator.aspect === "molecular_function" && independentRootCount < genome.goPolicy.minimumIndependentProvenanceRoots) selectionBlockers.push("insufficient_provenance_roots");
      if (candidateSupports.length > 0) {
        if (selectionEligibleCandidateSupports.length === 0) selectionBlockers.push("candidate_provider_floor");
        if ((standardCandidateSupports.length > 0 && standardCandidateRoots.size < (candidatePolicy?.requireIndependentRoots ?? 1))
          || (learnedCandidateSupports.length > 0 && learnedCandidateRoots.size < (learnedPredictorPolicy?.requireIndependentRoots ?? 1))) selectionBlockers.push("candidate_independent_roots");
        if (selectionEligibleCandidateSupports.length > 0
          && !selectionEligibleCandidateSupports.some((item) =>
            item.adjustedSupport >= threshold && item.leafTransferAllowed !== false)) {
          selectionBlockers.push("candidate_term_threshold");
        }
        if (candidateSupports.every((item) => item.leafTransferAllowed === false)) selectionBlockers.push("phylogeny_leaf_forbidden");
      }
    }
    if (adjustedScore < threshold) {
      reasons.push(`Lineage-adjusted heuristic score ${adjustedScore.toFixed(3)} is below the ${threshold.toFixed(3)} threshold.`);
      selectionBlockers.push("below_threshold");
    }
    if (eligible) reasons.push("Retained only as a low-confidence similarity-transfer hypothesis, not as a curated annotation or calibrated probability.");
    transferred.push({
      goId: accumulator.goId,
      termName: accumulator.termName,
      aspect: accumulator.aspect,
      decision: eligible ? "transfer_hypothesis" : "abstained",
      selected: eligible,
      ...(selectionMode === "evidence_frontier_v1" ? {
        preBudgetEligible: eligible,
        selectionRole: "not_selected" as const,
        selectionRank: null,
      } : {}),
      rawScore,
      phylogenyAdjustedScore: adjustedScore,
      calibrationStatus: "unavailable",
      confidenceLabel: eligible ? "low_heuristic" : "abstained",
      evidenceCode: unique(supports.map((item) => item.evidenceCode)).join(","),
      donorSupports: supports,
      evidenceIds: unique(supports.flatMap((item) => [item.annotationEvidenceId, ...item.matchEvidenceIds])),
      reasons,
      selectionBlockers: unique(selectionBlockers) as NonNullable<GOTermPrediction["selectionBlockers"]>,
      ...((ontologyEnabled || candidateSupports.length > 0) ? {
        candidateOrigin: accumulator.minimumOntologyDepth > 0
          ? "ontology_ancestor" as const
          : candidateSupports.length === supports.length
            ? "direct_candidate_source" as const
            : "direct_annotation" as const,
      } : {}),
      ...(ontologyEnabled ? {
        sourceGoIds: [...accumulator.sourceGoIds].sort(),
        ontologyDepth: accumulator.minimumOntologyDepth,
      } : {}),
    });
  }

  const allTerms = [...transferred].sort(rankTerms);
  if (selectionMode === "evidence_frontier_v1") {
    applyGOSelection({
      terms: allTerms,
      mode: selectionMode,
      frontierAspects: selectionAspects,
      maxSelectedTermsPerAspect: genome.goPolicy.maxSelectedTermsPerAspect,
      phase: "pre_judge",
    });
  } else {
    // Preserve byte-for-byte legacy predictions so frozen evidence batches
    // remain replay-valid unless the frontier is explicitly genome-enabled.
    for (const aspect of ["molecular_function", "biological_process", "cellular_component"] as const) {
      const selected = allTerms.filter((term) => term.aspect === aspect && term.decision === "transfer_hypothesis");
      selected.slice(genome.goPolicy.maxSelectedTermsPerAspect).forEach((term) => {
        term.selected = false;
        term.decision = "abstained";
        term.confidenceLabel = "abstained";
        term.reasons.push(`Exceeded the genome cap of ${genome.goPolicy.maxSelectedTermsPerAspect} transferred terms for this aspect.`);
      });
    }
  }
  allTerms.sort(rankTerms);
  const selectedCandidateTerms = allTerms.filter((term) => term.selected
    && term.donorSupports.some((support) => support.candidateSourceType !== undefined
      && support.candidateSelectionEligible !== false));
  const sourceStats = CANDIDATE_SOURCE_TYPES.map((sourceType) => {
    const stats = candidateSourceStats.get(sourceType)!;
    return {
      sourceType,
      ...stats,
      // Count canonical GO terms, not donor rows. Many OMA donors can support
      // the same term and must not inflate candidate-pool coverage.
      novelToDirectPool: novelCandidateGoIds.get(sourceType)!.size,
      selectedTerms: selectedCandidateTerms.filter((term) => term.donorSupports
        .some((support) => support.candidateSourceType === sourceType
          && support.candidateSelectionEligible !== false)).length,
    };
  });

  const withoutHash = {
    schemaVersion: "pi-go-prediction.v3" as const,
    proteinId: input.proteinId,
    targetMode,
    identityPolicy,
    queryAccession: accession,
    queryLikeAccessions,
    explicitlyExcludedAccessions,
    queryTaxonId: resolvedTaxonId,
    queryLineage,
    targetContext,
    genomeId: genome.genomeId,
    genomeHash: snapshot.genomeHash,
    methodId: genome.goPolicy.methodId,
    methodSummary: (genome.goPolicy.sequenceEligibilityMode === "retained_sequence"
      ? (identityPolicy === "temporal_t0_v1" ? "Temporal T0 GO transfer: T0 sequence, structure, and homolog annotations remain eligible evidence for T1 prediction; no similarity-based identity quarantine is applied." : "Strict-blind GO transfer: only explicitly declared/excluded query-like records are quarantined; similarity and coverage never infer query identity. Remaining donors retain sequence and structure evidence.")
      : "GO transfer uses explicitly declared/excluded query-like records only; percent identity and coverage do not trigger quarantine. Remaining donors use per-accession max sequence/full-structure/domain-structure similarity, GO evidence-code weights, optional pLDDT scaling and lineage overlap, followed by provenance-component fusion (0.7/0.2/0.1) and aspect thresholds.")
      + (input.ontology
        ? " A pinned go-basic snapshot resolves active alt IDs and quarantines unknown or obsolete direct-annotation and candidate-source GO IDs before scoring."
        : "")
      + (ontologyEnabled
        ? " It propagates only safe is_a/part_of ancestors with depth decay and cannot invent leaf candidates."
        : "")
      + (candidateSourcesEnabled
        ? " Storage-light InterPro/Pfam/PANTHER/EC, OMA FastMap hypotheses, and independent OMA-ortholog candidates are admitted before selection and fused by provenance root; provider floors control selection rather than silently deleting the candidate, and the OMA mapped anchor is never used as a GO donor."
        : "")
      + (learnedPredictorEnabled
        ? learnedPredictorPolicy?.allowedSources[0] === "deepgoplus_cnn"
          ? ` A hash-bound DeepGOPlus CNN-only adapter contributes direct pre-ontology model scores${learnedPredictorPolicy.activationMode === "direct_annotation_gap_only" ? " only for GO aspects with no direct donor-derived annotation" : learnedPredictorPolicy.activationMode === "prediction_aspect_gap_only" ? " only for GO aspects with no positive host-baseline hypothesis" : learnedPredictorPolicy.activationMode === "host_term_agreement_only" ? " only for GO terms already proposed by the positive host-only baseline" : ""}${learnedPredictorPolicy.maxCandidatesPerAspect === undefined ? "" : `, capped at ${learnedPredictorPolicy.maxCandidatesPerAspect} direct row(s) per aspect`}; its DIAMOND and stock hybrid outputs are deliberately excluded to avoid double-counting homology, all terms share one model/query provenance root, and scores remain uncalibrated.`
          : learnedPredictorPolicy?.allowedSources[0] === "deepgoplus_hybrid"
            ? ` A hash-bound DeepGOPlus DIAMOND+CNN prediction vector contributes direct agent-safe scores as one correlation-aware prior${learnedPredictorPolicy.activationMode === "direct_annotation_gap_only" ? " only for GO aspects with no direct donor-derived annotation" : learnedPredictorPolicy.activationMode === "prediction_aspect_gap_only" ? " only for GO aspects with no positive host-baseline hypothesis" : learnedPredictorPolicy.activationMode === "host_term_agreement_only" ? " only for GO terms already proposed by the positive host-only baseline" : ""}${learnedPredictorPolicy.maxCandidatesPerAspect === undefined ? "" : `, capped at ${learnedPredictorPolicy.maxCandidatesPerAspect} direct row(s) per aspect`}; it is max-combined rather than counted as an independent homology or structure vote, while the host derives only the pinned safe is_a/part_of closure and always excludes GO namespace roots.`
          : ` A hash-bound mDeepFRI ${learnedPredictorPolicy?.allowedSources[0] === "mdeepfri_gcn" ? "structure-GCN" : "sequence-CNN"} overlay contributes an independently scored learned candidate channel${learnedPredictorPolicy?.activationMode === "direct_annotation_gap_only" ? " only for GO aspects with no direct donor-derived annotation" : learnedPredictorPolicy?.activationMode === "prediction_aspect_gap_only" ? " only for GO aspects with no positive host-baseline hypothesis" : learnedPredictorPolicy?.activationMode === "host_term_agreement_only" ? " only for GO terms already proposed by the positive host-only baseline" : ""}${learnedPredictorPolicy?.maxCandidatesPerAspect === undefined ? "" : `, capped at ${learnedPredictorPolicy.maxCandidatesPerAspect} direct row(s) per aspect`}; all terms from one model/query share one provenance root, scores remain uncalibrated, and the model cannot cite target annotations.`
        : "")
      + (phylogenyEnabled
        ? " Orthology relation and duplication status take precedence over taxonomic proximity; related donors are collapsed by HOG/clade and unsupported leaf terms abstain."
        : "")
      + (selectionMode === "evidence_frontier_v1"
        ? " The evidence-frontier selector budgets only direct hypotheses, then emits the safe ontology closure entailed by selected direct source GO IDs."
        : ""),
    ...(selectionMode === "evidence_frontier_v1" ? {
      selectionPolicyMode: selectionMode,
      ...(selectionAspects ? { selectionPolicyAspects: [...selectionAspects] } : {}),
    } : {}),
    calibrationStatus: "unavailable" as const,
    dagProjectionStatus: ontologyEnabled ? "ancestor_closure_applied" as const : "not_applied" as const,
    ...(ontologyClosurePolicy && input.ontology ? {
      ontologyBinding: {
        dataVersion: input.ontology.dataVersion,
        sourceSha256: input.ontology.sha256,
        policy: "safe_is_a_part_of_ancestor_closure_v1" as const,
        maxDepth: ontologyClosurePolicy.maxDepth,
        scoreDecay: ontologyClosurePolicy.scoreDecay,
        rootsExcluded: true as const,
      },
    } : {}),
    candidateSources: {
      bundleHash: candidateBundle.canonicalHash,
      providers: candidateBundle.providers.map((provider) => ({
        provider: provider.provider,
        status: provider.status,
        release: provider.release,
        payloadSha256: provider.payloadSha256,
        reason: provider.reason,
      })),
      candidateCount: candidateBundle.candidates.length,
      admittedCandidateCount: appliedCandidateCount,
      appliedCandidateCount,
      selectionEligibleCandidateCount,
      selectedCandidateTermCount: selectedCandidateTerms.length,
      sourceStats,
    },
    phylogenyStatus: {
      mode: phylogenyEnabled ? "orthology_aware" as const : "disabled" as const,
      targetTaxonStatus: targetContext.taxon.provenance,
      evidenceCount: candidateBundle.candidates.filter((candidate) => candidate.phylogeny !== null).length,
      appliedCount: appliedPhylogenyCount,
      quarantinedCount: quarantinedPhylogenyCount,
      lineageWeightedSupportCount: allTerms.flatMap((term) => term.donorSupports)
        .filter((support) => support.lineageStatus === "applied").length,
      selectedLineageWeightedSupportCount: allTerms.filter((term) => term.selected)
        .flatMap((term) => term.donorSupports)
        .filter((support) => support.lineageStatus === "applied").length,
    },
    taxonConstraintStatus: resolvedTaxonId === null ? "unavailable" as const : "not_evaluated" as const,
    thresholds: genome.goPolicy.thresholds,
    quarantinedGoIds: [...quarantinedGoIds].sort(),
    ...(input.ontology ? {
      ontologyQuarantinedGoIds: [...ontologyQuarantinedGoIds].sort(),
    } : {}),
    predictedGoIds: unique(allTerms.filter((term) => term.selected && term.decision === "transfer_hypothesis").map((term) => term.goId)),
    terms: allTerms,
    limitations: [
      "Scores are deterministic ranking heuristics, not calibrated probabilities.",
      ...(phylogenyEnabled
        ? ["OMA orthology relation, duplication status, distance, declared target TaxID, and clade collapse are applied when release-bound evidence is available; unavailable fields cause abstention or an explicit unavailable state."]
        : ["Lineage overlap is a mild proximity adjustment; orthology-aware phylogeny is disabled in this genome."]),
      "UniProt GO cross-reference summaries do not provide a complete frozen GAF/GPAD assertion record, qualifier/NOT coverage, or release-matched provenance.",
      ...(ontologyEnabled
        ? ["A pinned go-basic ontology supplied active-ID validation, alt-ID resolution, and safe is_a/part_of ancestor closure; unknown and obsolete IDs were quarantined before scoring. It does not generate unsupported leaf functions, apply information-content weighting, or enforce taxon constraints."]
        : input.ontology
          ? ["A pinned go-basic ontology supplied active-ID validation and alt-ID resolution without DAG projection; unknown and obsolete IDs were quarantined before scoring. No information-content model or taxon-constraint resource was applied."]
          : ["No versioned GO DAG projection, obsolete-term check, information-content model, or taxon-constraint resource was applied."]),
      "GO terms attached to explicitly declared query-like accessions are quarantined and never act as donors; similarity or coverage alone never marks a donor query-like, and the same GO term may still be independently re-predicted from other homologs.",
      `A full-query Foldseek search is treated as global only when both query and target coverage are at least ${genome.goPolicy.globalStructureCoverageFloor.toFixed(2)}; otherwise the local/domain penalty applies.`,
      "Structure-only molecular-function transfer requires two materially supported donor groups and two independent donor-group/provenance-root pairs; shared publications are counted once by bipartite matching.",
      ...(candidateSourcesEnabled
        ? ["InterPro/GO, OMA FastMap, and orthology mappings are IEA-like candidate evidence, not curated target annotations; correlated signatures from one query domain or one FastMap donor count once. OMA FastMap is local-similarity evidence and never masquerades as phylogeny."]
        : ["Storage-light domain/EC/orthology candidate sources are disabled in this genome."]),
      ...(learnedPredictorEnabled
        ? ["mDeepFRI model outputs are non-citable candidate scores rather than calibrated probabilities or biological evidence; unknown training overlap and model-age mismatch require an independent temporal holdout."]
        : ["Learned external GO predictor candidates are disabled in this genome."]),
      ...(resolvedTaxonId === null
        ? ["No target TaxID was declared, so phylogeny and GO taxon-constraint reasoning cannot be treated as available."]
        : ["A target TaxID was declared, but a release-bound GO taxon-constraint file is not yet configured; terms are not claimed taxon-validated."]),
    ],
  };
  const basePrediction: GOPredictionSet = { ...withoutHash, canonicalHash: hashCanonical(withoutHash) };
  const judgePolicy = genome.goPolicy.goJudgePolicy;
  if (judgePolicy?.mode !== "evidence_consistency" || input.goJudgeMode === "disabled") {
    return basePrediction;
  }
  if (judgePolicy.executionMode === "pi") {
    throw new Error("A Pi-bound GO judge cannot be evaluated by the synchronous deterministic replay path");
  }
  const binding = buildGOJudgeBinding(
    basePrediction,
    judgePolicy.maxCandidates,
    judgePolicy.candidateBudgetMode ?? "global_ranked_v1",
  );
  if (!binding) return basePrediction;
  return applyGOJudgeResult({
    prediction: basePrediction,
    binding,
    result: judgeGOCandidatesDeterministically(binding.view),
    maxSelectedTermsPerAspect: genome.goPolicy.maxSelectedTermsPerAspect,
    requestedMode: "deterministic",
    candidateRetentionMode: judgePolicy.candidateRetentionMode ?? "fail_closed_v1",
  });
}

export function renderGoTsv(predictions: GOPredictionSet): string {
  const lines = ["protein_id\tgo_id\tscore\taspect\tdecision\tselected\tcalibration_status"];
  for (const term of predictions.terms.filter((item) => item.selected && item.decision === "transfer_hypothesis")) {
    lines.push([
      predictions.proteinId,
      term.goId,
      (term.fusionAdjustedScore ?? term.semanticAdjustedScore ?? term.judgeAdjustedScore ?? term.phylogenyAdjustedScore ?? 0).toFixed(6),
      term.aspect,
      term.decision,
      String(term.selected),
      term.calibrationStatus,
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

export async function writeGoTsv(path: string, predictions: GOPredictionSet): Promise<void> {
  await writeFile(path, renderGoTsv(predictions), "utf8");
}
