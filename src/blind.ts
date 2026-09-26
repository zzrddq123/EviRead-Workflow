import type { GOPredictionSet } from "./types.js";
import { hashCanonical } from "./hash.js";
import { canonicalAccession } from "./accession.js";

type JsonObject = Record<string, unknown>;

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function accessions(item: JsonObject): string[] {
  const direct = [
    item.accession,
    item.pdb_id,
    item.pdbId,
    item.annotation_accession,
    item.annotationAccession,
    item.source_accession,
    item.sourceAccession,
    item.provider_accession,
    item.providerAccession,
    item.provider_primary_accession,
    item.providerPrimaryAccession,
  ]
    .map(canonicalAccession);
  const aliases = [
    ...(Array.isArray(item.alias_accessions) ? item.alias_accessions : []),
    ...(Array.isArray(item.aliasAccessions) ? item.aliasAccessions : []),
    ...(Array.isArray(item.aliases) ? item.aliases : []),
  ];
  const fromAliases = aliases.flatMap((alias) => {
    if (alias && typeof alias === "object" && !Array.isArray(alias)) {
      const record = alias as JsonObject;
      return [record.accession, record.id].map(canonicalAccession);
    }
    return [canonicalAccession(alias)];
  });
  return [...new Set([...direct, ...fromAliases].filter(Boolean))];
}

function isExcluded(item: JsonObject, excluded: Set<string>): boolean {
  return item.query_like === true || item.queryLike === true || accessions(item).some((value) => excluded.has(value));
}

const OMIT = Symbol("omit-quarantined-identity");

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function identityTokenPattern(identity: string): RegExp {
  return new RegExp(`(^|[^A-Z0-9])${escapedRegex(identity)}(?=$|[^A-Z0-9])`, "gi");
}

function redactExcludedIdentityText(value: string, excluded: Set<string>): string {
  let output = value;
  for (const identity of excluded) {
    if (identity.length < 4) continue;
    output = output.replace(identityTokenPattern(identity), (_match, prefix: string) =>
      `${prefix}[query-like identity redacted]`);
  }
  return output;
}

function containsExcludedIdentityText(value: string, excluded: Set<string>): boolean {
  return [...excluded].some((identity) =>
    identity.length >= 4 && identityTokenPattern(identity).test(value));
}

function nestedIdentityValues(item: JsonObject): string[] {
  const direct = [
    item.accession,
    item.pdb_id,
    item.annotation_accession,
    item.source_accession,
    item.provider_accession,
    item.provider_primary_accession,
    item.record_accession,
    item.recordAccession,
    item.reference_id,
    item.referenceId,
    item.donor_accession,
    item.donorAccession,
  ].map(canonicalAccession);
  return [...new Set([...direct, ...accessions(item)].filter(Boolean))];
}

/**
 * Clone retained public evidence while removing the smallest nested object
 * carrying a quarantined identity. This preserves a safe donor and its other
 * provenance, but drops (for example) a UniProt citation whose reference_id
 * points back to the anonymous query.
 */
function sanitizeRetainedValue(value: unknown, excluded: Set<string>): unknown | typeof OMIT {
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeRetainedValue(item, excluded))
      .filter((item) => item !== OMIT);
  }
  if (value && typeof value === "object") {
    const record = value as JsonObject;
    if (nestedIdentityValues(record).some((identity) => excluded.has(identity))) return OMIT;
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(record)) {
      const sanitized = sanitizeRetainedValue(item, excluded);
      if (sanitized !== OMIT) output[key] = sanitized;
    }
    return output;
  }
  if (typeof value === "string") return redactExcludedIdentityText(value, excluded);
  return value;
}

function containsExcludedIdentityDeep(value: unknown, excluded: Set<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => containsExcludedIdentityDeep(item, excluded));
  if (!value || typeof value !== "object") return false;
  const record = value as JsonObject;
  return nestedIdentityValues(record).some((identity) => excluded.has(identity))
    || Object.values(record).some((item) => containsExcludedIdentityDeep(item, excluded));
}

function sanitizedObjects(value: unknown, excluded: Set<string>): JsonObject[] {
  return objects(value)
    .map((item) => sanitizeRetainedValue(item, excluded))
    .filter((item): item is JsonObject => item !== OMIT && Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function sanitizeAnnotation(item: JsonObject, excluded: Set<string>): JsonObject | undefined {
  const sanitized = sanitizeRetainedValue(item, excluded);
  if (sanitized === OMIT || !sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return undefined;
  const output = sanitized as JsonObject;

  if (Array.isArray(item.go_terms)) {
    output.go_terms = sanitizedObjects(
      objects(item.go_terms).filter((term) => !containsExcludedIdentityDeep(term, excluded)),
      excluded,
    );
  }

  if (item.structured_xrefs && typeof item.structured_xrefs === "object" && !Array.isArray(item.structured_xrefs)) {
    const source = item.structured_xrefs as JsonObject;
    const sanitizedRoot = sanitizeRetainedValue(source, excluded);
    if (sanitizedRoot !== OMIT && sanitizedRoot && typeof sanitizedRoot === "object" && !Array.isArray(sanitizedRoot)) {
      const xrefs = sanitizedRoot as JsonObject;
      let itemCount = 0;
      let removedEcAssertion = false;
      for (const [category, rows] of Object.entries(source)) {
        if (!Array.isArray(rows)) continue;
        const retained = sanitizedObjects(
          objects(rows).filter((row) => !containsExcludedIdentityDeep(row, excluded)),
          excluded,
        );
        if (category === "ec_numbers" && retained.length !== objects(rows).length) removedEcAssertion = true;
        xrefs[category] = retained;
        itemCount += retained.length;
      }
      if (typeof source.item_count === "number") xrefs.item_count = itemCount;
      output.structured_xrefs = xrefs;
      if (removedEcAssertion) delete output.catalytic_activity;
    } else {
      delete output.structured_xrefs;
      delete output.catalytic_activity;
    }
  }
  return output;
}

/**
 * Candidate rows visible to the narrative must be derived from the
 * authoritative GO-policy result, never directly from the provider payload.
 * A candidate is visible only when at least one authoritative direct or
 * ontology-projected support passed both its provider floor and leaf-transfer
 * gate. This keeps usable ancestor evidence while hiding disabled,
 * aspect-excluded, and below-floor rows.
 */
export function goPolicyAdmittedCandidateEvidenceIds(
  go: Pick<GOPredictionSet, "terms">,
): string[] {
  return [...new Set(go.terms.flatMap((term) =>
    term.donorSupports
      .filter((support) =>
        support.candidateSourceType !== undefined
        && support.candidateSelectionEligible !== false
        && support.leafTransferAllowed !== false)
      .map((support) => support.annotationEvidenceId)
      .filter(Boolean),
  ))].sort();
}

export function buildBlindEvidenceView(
  bundle: JsonObject,
  queryLikeAccessions: string[],
  admittedCandidateEvidenceIds: readonly string[],
): JsonObject {
  const excluded = new Set(queryLikeAccessions.map(canonicalAccession).filter(Boolean));
  const admittedCandidates = new Set(admittedCandidateEvidenceIds);
  const sequenceHits = sanitizedObjects(objects(bundle.sequence_hits).filter((item) => !isExcluded(item, excluded)), excluded);
  const structureHits = sanitizedObjects(objects(bundle.structure_hits).filter((item) => !isExcluded(item, excluded)), excluded);
  const annotations = objects(bundle.uniprot_annotations)
    .filter((item) => !isExcluded(item, excluded))
    .map((item) => sanitizeAnnotation(item, excluded))
    .filter((item): item is JsonObject => item !== undefined);
  const pdbAnnotations = sanitizedObjects(objects(bundle.pdb_annotations).filter((item) => !isExcluded(item, excluded)), excluded);
  const domains = sanitizedObjects(bundle.domain_segments, excluded);
  const negativeSearchEvidence = sanitizedObjects(bundle.negative_search_evidence, excluded);
  const intrinsicEvidence = sanitizedObjects(bundle.intrinsic_evidence, excluded);
  const candidateSource = bundle.candidate_sources && typeof bundle.candidate_sources === "object" && !Array.isArray(bundle.candidate_sources)
    ? bundle.candidate_sources as JsonObject
    : {};
  const candidateRows = objects(candidateSource.go_candidates ?? candidateSource.candidates);
  const candidateIsQueryLike = (item: JsonObject): boolean => {
    const donor = canonicalAccession(item.donor_accession ?? item.donorAccession);
    const phylogeny = item.phylogeny && typeof item.phylogeny === "object" && !Array.isArray(item.phylogeny)
      ? item.phylogeny as JsonObject
      : {};
    return item.query_like === true || item.queryLike === true
      || phylogeny.query_like === true || phylogeny.queryLike === true
      || Boolean(donor && excluded.has(donor));
  };
  const candidateQueryLikeRecordCount = candidateRows.filter(candidateIsQueryLike).length;
  const candidates = sanitizedObjects(candidateRows.filter((item) => {
    const evidenceId = String(item.evidence_id ?? item.evidenceId ?? "");
    return admittedCandidates.has(evidenceId) && !candidateIsQueryLike(item);
  }), excluded);
  const candidateEvidenceIds = candidates.flatMap((item) => {
    const ids = [String(item.evidence_id ?? item.evidenceId ?? "")];
    const phylogeny = item.phylogeny && typeof item.phylogeny === "object" && !Array.isArray(item.phylogeny)
      ? item.phylogeny as JsonObject
      : {};
    ids.push(String(phylogeny.evidence_id ?? phylogeny.evidenceId ?? ""));
    return ids.filter(Boolean);
  });
  const evidenceIds = [...new Set(
    [...sequenceHits, ...structureHits, ...annotations, ...pdbAnnotations, ...domains, ...negativeSearchEvidence, ...intrinsicEvidence]
      .map((item) => String(item.evidence_id ?? ""))
      .filter(Boolean)
      .concat(candidateEvidenceIds),
  )].sort();
  const proteinSource = bundle.protein && typeof bundle.protein === "object" && !Array.isArray(bundle.protein)
    ? bundle.protein as JsonObject
    : {};
  const {
    query_like_accessions: _queryLikeAccessions,
    query_lineage_source_evidence_id: _lineageEvidence,
    ...proteinWithoutIdentity
  } = proteinSource;
  const protein = { ...proteinWithoutIdentity, header: "anonymous_query", query_lineage_source_evidence_id: null };
  const runtimeSource = bundle.runtime && typeof bundle.runtime === "object" && !Array.isArray(bundle.runtime)
    ? bundle.runtime as JsonObject
    : {};
  const runtime = {
    tool_versions: runtimeSource.tool_versions ?? {},
    foldseek_probability_cutoff: runtimeSource.foldseek_probability_cutoff ?? null,
    segmentation_confidence_cutoff: runtimeSource.segmentation_confidence_cutoff ?? null,
    path_and_cache_inventories: "withheld_from_narrative_view",
  };
  const sanitizedBundle = sanitizeRetainedValue(bundle, excluded);
  if (sanitizedBundle === OMIT || !sanitizedBundle || typeof sanitizedBundle !== "object" || Array.isArray(sanitizedBundle)) {
    throw new Error("strict-blind evidence construction could not sanitize the evidence root");
  }
  const sanitizedCandidateSource = sanitizeRetainedValue(candidateSource, excluded);
  const candidateMetadata = sanitizedCandidateSource !== OMIT
    && sanitizedCandidateSource && typeof sanitizedCandidateSource === "object" && !Array.isArray(sanitizedCandidateSource)
    ? sanitizedCandidateSource as JsonObject
    : {};
  const {
    go_candidates: _unfilteredGoCandidates,
    candidates: _unfilteredLegacyCandidates,
    // Receipts are evaluator/audit artifacts, not narrative evidence. In
    // particular, the full-hybrid receipt contains bounded DIAMOND donor IDs,
    // accessions and TaxIDs; retaining it would bypass candidate-row
    // quarantine for exact/near-exact training matches.
    deepgoplus_receipt: _deepGoPlusReceipt,
    ...candidateMetadataWithoutRows
  } = candidateMetadata;
  const view = {
    ...sanitizedBundle as JsonObject,
    protein,
    runtime,
    sequence_hits: sequenceHits,
    structure_hits: structureHits,
    uniprot_annotations: annotations,
    pdb_annotations: pdbAnnotations,
    candidate_sources: {
      ...candidateMetadataWithoutRows,
      go_candidates: candidates,
    },
    evidence_ids: evidenceIds,
    blind_view: {
      policy: "temporal_t0_v1",
      // Preserve the historical accession-level count while also accounting
      // for provider candidate rows that carry no donor accession (the usual
      // exact-training-match shape for learned predictors).
      query_like_records_removed: queryLikeAccessions.length + candidateQueryLikeRecordCount,
      candidate_query_like_records_removed: candidateQueryLikeRecordCount,
      candidate_policy: "authoritative_go_admitted_direct_candidates_only",
      admitted_candidate_count: candidates.length,
      note: "T0 sequence, structure, and homolog evidence remains eligible for T1 prediction; only explicitly declared query-like records are removed.",
    },
  };
  const publicText = JSON.stringify(view);
  if (containsExcludedIdentityText(publicText, excluded)) {
    throw new Error("strict-blind evidence construction retained quarantined identity metadata");
  }
  return view;
}

export function buildBlindGoView(go: GOPredictionSet): GOPredictionSet {
  const { canonicalHash: _sourceCanonicalHash, ...withoutHash } = go;
  const hasOntologyQuarantine = Object.prototype.hasOwnProperty.call(go, "ontologyQuarantinedGoIds");
  const admittedCandidates = new Set(goPolicyAdmittedCandidateEvidenceIds(go));
  const terms = go.terms.flatMap((term) => {
    const hadCandidateSupport = term.donorSupports.some(
      (support) => support.candidateSourceType !== undefined,
    );
    const donorSupports = term.donorSupports.filter((support) =>
      support.candidateSourceType === undefined
      || admittedCandidates.has(support.annotationEvidenceId));
    if (hadCandidateSupport && donorSupports.length === 0) {
      if (term.selected) {
        throw new Error(`strict-blind GO construction found selected term ${term.goId} with no policy-admitted support`);
      }
      return [];
    }
    if (donorSupports.length === term.donorSupports.length) return [term];
    const evidenceIds = [...new Set(donorSupports.flatMap((support) => [
      support.annotationEvidenceId,
      ...support.matchEvidenceIds,
    ]).filter(Boolean))].sort();
    const evidenceCode = [...new Set(donorSupports.map((support) => support.evidenceCode).filter(Boolean))].sort().join(",");
    return [{
      ...term,
      donorSupports,
      evidenceIds,
      evidenceCode,
    }];
  });
  const view = {
    ...withoutHash,
    queryAccession: null,
    queryLikeAccessions: [],
    explicitlyExcludedAccessions: [],
    quarantinedGoIds: [],
    ...(hasOntologyQuarantine ? { ontologyQuarantinedGoIds: [] } : {}),
    terms,
  };
  return { ...view, canonicalHash: hashCanonical(view) };
}
