import { hashCanonical } from "./hash.js";
import { canonicalAccession } from "./accession.js";
import type { GOAspect } from "./types.js";
import type { OrthologyRelation, PhylogenyEvidence } from "./phylogeny.js";

export const CANDIDATE_SOURCE_TYPES = ["biolm_retrieval", "interpro", "pfam", "panther", "ec", "oma_ortholog", "oma_fastmap", "mdeepfri_cnn", "mdeepfri_gcn", "deepgoplus_cnn", "deepgoplus_hybrid"] as const;
export type CandidateSourceType = typeof CANDIDATE_SOURCE_TYPES[number];
export type CandidateProviderStatus = "completed" | "unavailable" | "failed" | "disabled";

export interface CandidateProviderRecord {
  provider: "BioLM" | "InterProScan" | "GOA_mapping" | "OMA" | "mDeepFRI" | "DeepGOPlus";
  status: CandidateProviderStatus;
  endpointOrPath: string;
  release: string | null;
  requestSha256: string | null;
  payloadSha256: string | null;
  cacheHit: boolean;
  reason: string | null;
}

export interface GOCandidateEvidence {
  schemaVersion: "pi-go-candidate.v1";
  goId: string;
  termName: string;
  aspect: GOAspect;
  sourceType: CandidateSourceType;
  sourceId: string;
  mappingId: string;
  provider: CandidateProviderRecord["provider"];
  providerRelease: string;
  providerPayloadSha256: string;
  evidenceId: string;
  provenanceRoot: string;
  baseScore: number;
  queryCoverage: number | null;
  domainRange: string | null;
  queryLike: boolean;
  annotationEvidenceCode: string;
  donorAccession: string | null;
  phylogeny: PhylogenyEvidence | null;
}

export interface CandidateSourceBundle {
  schemaVersion: "pi-candidate-sources.v1";
  providers: CandidateProviderRecord[];
  candidates: GOCandidateEvidence[];
  canonicalHash: string;
}

export interface GOAssociationMapping {
  database: "InterPro" | "Pfam" | "EC";
  sourceId: string;
  goId: string;
  description: string;
}

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function records(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(record).filter((value): value is JsonObject => value !== undefined) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function unit(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

function integerOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function normalizeAspect(value: unknown): GOAspect {
  const normalized = text(value).toLowerCase();
  if (normalized === "molecular_function" || normalized === "f" || normalized === "mf") return "molecular_function";
  if (normalized === "biological_process" || normalized === "p" || normalized === "bp") return "biological_process";
  if (normalized === "cellular_component" || normalized === "c" || normalized === "cc") return "cellular_component";
  return "unknown";
}

function providerRecord(value: unknown): CandidateProviderRecord | undefined {
  const item = record(value);
  if (!item) return undefined;
  const provider = text(item.provider);
  const status = text(item.status);
  if (!(["BioLM", "InterProScan", "GOA_mapping", "OMA", "mDeepFRI", "DeepGOPlus"] as string[]).includes(provider)) return undefined;
  if (!(["completed", "unavailable", "failed", "disabled"] as string[]).includes(status)) return undefined;
  return {
    provider: provider as CandidateProviderRecord["provider"],
    status: status as CandidateProviderStatus,
    endpointOrPath: text(item.endpoint_or_path ?? item.endpointOrPath),
    release: text(item.release) || null,
    requestSha256: text(item.request_sha256 ?? item.requestSha256) || null,
    payloadSha256: text(item.payload_sha256 ?? item.payloadSha256) || null,
    cacheHit: item.cache_hit === true || item.cacheHit === true,
    reason: text(item.reason) || null,
  };
}

function normalizePhylogeny(value: unknown): PhylogenyEvidence | null {
  const item = record(value);
  if (!item) return null;
  const relation = text(item.relation) as OrthologyRelation;
  const provider = text(item.provider);
  if (!(["one_to_one", "one_to_many", "many_to_one", "many_to_many", "coortholog", "unresolved_ortholog", "post_duplication_paralog"] as string[]).includes(relation)) return null;
  if (!(["OMA", "OrthoDB", "GeneTree", "declared"] as string[]).includes(provider)) return null;
  const distance = item.evolutionary_distance ?? item.evolutionaryDistance;
  const parsedDistance = distance === null || distance === undefined ? null : Number(distance);
  return {
    schemaVersion: "pi-phylogeny-evidence.v1",
    provider: provider as PhylogenyEvidence["provider"],
    providerRelease: text(item.provider_release ?? item.providerRelease) || "unversioned",
    providerPayloadSha256: text(item.provider_payload_sha256 ?? item.providerPayloadSha256),
    evidenceId: text(item.evidence_id ?? item.evidenceId),
    provenanceRoot: text(item.provenance_root ?? item.provenanceRoot),
    targetTaxonId: integerOrNull(item.target_taxon_id ?? item.targetTaxonId),
    targetLineage: stringArray(item.target_lineage ?? item.targetLineage),
    donorTaxonId: integerOrNull(item.donor_taxon_id ?? item.donorTaxonId),
    donorLineage: stringArray(item.donor_lineage ?? item.donorLineage),
    relation,
    evolutionaryDistance: parsedDistance !== null && Number.isFinite(parsedDistance) && parsedDistance >= 0 ? parsedDistance : null,
    hogId: text(item.hog_id ?? item.hogId) || null,
    queryLike: item.query_like === true || item.queryLike === true,
  };
}

function normalizeCandidate(value: unknown): GOCandidateEvidence | undefined {
  const item = record(value);
  if (!item) return undefined;
  const goId = text(item.go_id ?? item.goId).toUpperCase();
  const sourceType = text(item.source_type ?? item.sourceType) as CandidateSourceType;
  const provider = text(item.provider) as CandidateProviderRecord["provider"];
  if (!/^GO:\d{7}$/.test(goId)) return undefined;
  if (!(CANDIDATE_SOURCE_TYPES as readonly string[]).includes(sourceType)) return undefined;
  if (!(["BioLM", "InterProScan", "GOA_mapping", "OMA", "mDeepFRI", "DeepGOPlus"] as string[]).includes(provider)) return undefined;
  const payloadHash = text(item.provider_payload_sha256 ?? item.providerPayloadSha256);
  if (!/^[0-9a-f]{64}$/.test(payloadHash)) return undefined;
  const candidate: GOCandidateEvidence = {
    schemaVersion: "pi-go-candidate.v1",
    goId,
    termName: text(item.term_name ?? item.termName) || "name unavailable",
    aspect: normalizeAspect(item.aspect),
    sourceType,
    sourceId: text(item.source_id ?? item.sourceId),
    mappingId: text(item.mapping_id ?? item.mappingId),
    provider,
    providerRelease: text(item.provider_release ?? item.providerRelease) || "unversioned",
    providerPayloadSha256: payloadHash,
    evidenceId: text(item.evidence_id ?? item.evidenceId),
    provenanceRoot: text(item.provenance_root ?? item.provenanceRoot),
    baseScore: unit(item.base_score ?? item.baseScore),
    queryCoverage: item.query_coverage === null || item.queryCoverage === null ? null : unit(item.query_coverage ?? item.queryCoverage),
    domainRange: text(item.domain_range ?? item.domainRange) || null,
    queryLike: item.query_like === true || item.queryLike === true,
    annotationEvidenceCode: text(item.annotation_evidence_code ?? item.annotationEvidenceCode).toUpperCase() || "IEA",
    donorAccession: canonicalAccession(item.donor_accession ?? item.donorAccession) || null,
    phylogeny: normalizePhylogeny(item.phylogeny),
  };
  if (!candidate.sourceId || !candidate.mappingId || !candidate.evidenceId || !candidate.provenanceRoot) return undefined;
  return candidate;
}

export function normalizeCandidateSourceBundle(bundle: JsonObject): CandidateSourceBundle {
  const source = record(bundle.candidate_sources) ?? {};
  const providers = records(source.providers).map(providerRecord).filter((value): value is CandidateProviderRecord => value !== undefined)
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.endpointOrPath.localeCompare(b.endpointOrPath));
  const candidates = records(source.go_candidates ?? source.candidates).map(normalizeCandidate)
    .filter((value): value is GOCandidateEvidence => value !== undefined)
    .sort((a, b) => a.goId.localeCompare(b.goId) || a.provenanceRoot.localeCompare(b.provenanceRoot) || a.evidenceId.localeCompare(b.evidenceId));
  const deduplicated = [...new Map(candidates.map((item) => [`${item.goId}|${item.provenanceRoot}|${item.mappingId}|${item.donorAccession ?? ""}`, item])).values()];
  const content = { schemaVersion: "pi-candidate-sources.v1" as const, providers, candidates: deduplicated };
  return { ...content, canonicalHash: hashCanonical(content) };
}

export function parseGOAssociationMapping(source: string, database: GOAssociationMapping["database"]): GOAssociationMapping[] {
  const prefix = database === "InterPro" ? "InterPro:" : database === "Pfam" ? "Pfam:" : "EC:";
  const rows: GOAssociationMapping[] = [];
  for (const rawLine of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("!")) continue;
    const sourceMatch = line.match(new RegExp(`${prefix.replace(":", "\\:")}([^\\s>]+)`));
    const goMatch = line.match(/GO:(\d{7})/g);
    if (!sourceMatch || !goMatch) continue;
    const sourceId = sourceMatch[1].trim();
    const description = line.includes(">") ? line.slice(0, line.indexOf(">")).trim() : line;
    for (const goId of unique(goMatch.map((item) => item.toUpperCase()))) rows.push({ database, sourceId, goId, description });
  }
  return rows.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.goId.localeCompare(b.goId));
}

export function fuseCandidateScores(candidates: readonly GOCandidateEvidence[]): number {
  const byRoot = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.queryLike) continue;
    byRoot.set(candidate.provenanceRoot, Math.max(byRoot.get(candidate.provenanceRoot) ?? 0, candidate.baseScore));
  }
  const ranked = [...byRoot.values()].sort((a, b) => b - a);
  return Math.round(Math.min(1, 0.7 * (ranked[0] ?? 0) + 0.2 * (ranked[1] ?? 0) + 0.1 * (ranked[2] ?? 0)) * 1_000_000) / 1_000_000;
}
