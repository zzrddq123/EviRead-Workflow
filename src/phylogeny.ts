import type { GOAspect } from "./types.js";

export const ORTHOLOGY_RELATIONS = [
  "one_to_one",
  "one_to_many",
  "many_to_one",
  "many_to_many",
  "coortholog",
  "unresolved_ortholog",
  "post_duplication_paralog",
] as const;

export type OrthologyRelation = typeof ORTHOLOGY_RELATIONS[number];
export type KnownGOAspect = Exclude<GOAspect, "unknown">;

export interface PhylogenyPolicy {
  schemaVersion: "pi-phylogeny-policy.v1";
  relationWeights: Record<OrthologyRelation, number>;
  aspectDistanceDecay: Record<KnownGOAspect, number>;
  lineageFloor: number;
  lineageRange: number;
  paralogLeafTransferAllowed: false;
  cladeCollapseDepth: number;
}

export interface PhylogenyEvidence {
  schemaVersion: "pi-phylogeny-evidence.v1";
  provider: "OMA" | "OrthoDB" | "GeneTree" | "declared";
  providerRelease: string;
  providerPayloadSha256: string;
  evidenceId: string;
  provenanceRoot: string;
  targetTaxonId: number | null;
  targetLineage: string[];
  donorTaxonId: number | null;
  donorLineage: string[];
  relation: OrthologyRelation;
  evolutionaryDistance: number | null;
  hogId: string | null;
  queryLike: boolean;
}

export interface GOTaxonConstraint {
  status: "available" | "unavailable";
  neverInTaxonIds: number[];
  onlyInTaxonIds: number[];
  sourceSha256?: string;
}

export interface PhylogenyAdjustment {
  status: "applied" | "unavailable_target_taxon" | "quarantined" | "taxon_forbidden";
  relationFactor: number;
  distanceFactor: number;
  lineageFactor: number;
  taxonConstraintFactor: number;
  combinedFactor: number;
  leafTransferAllowed: boolean;
  cladeKey: string;
  reasons: string[];
}

export const DEFAULT_PHYLOGENY_POLICY: PhylogenyPolicy = {
  schemaVersion: "pi-phylogeny-policy.v1",
  relationWeights: {
    one_to_one: 1,
    one_to_many: 0.82,
    many_to_one: 0.82,
    many_to_many: 0.68,
    coortholog: 0.76,
    unresolved_ortholog: 0.55,
    post_duplication_paralog: 0.25,
  },
  // Molecular mechanisms are generally more conserved than process and
  // localization labels, so MF decays least strongly with OMA distance.
  aspectDistanceDecay: {
    molecular_function: 0.12,
    biological_process: 0.28,
    cellular_component: 0.22,
  },
  lineageFloor: 0.72,
  lineageRange: 0.28,
  paralogLeafTransferAllowed: false,
  cladeCollapseDepth: 6,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(clamp01(value) * 1_000_000) / 1_000_000;
}

function positiveTaxon(value: number | null): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

const SYNTHETIC_LINEAGE_ROOTS = new Set(["root", "cellular organisms"]);

/**
 * Canonicalize lineage labels without inventing or reordering biological
 * ranks. OMA/UniProt providers differ in case, whitespace, duplicate ranks,
 * and whether they include a synthetic database root; those representation
 * differences must not look like evolutionary distance.
 */
export function normalizeLineage(values: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const token = value.trim().toLowerCase().replace(/\s+/g, " ");
    if (!token || SYNTHETIC_LINEAGE_ROOTS.has(token) || seen.has(token)) continue;
    seen.add(token);
    normalized.push(token);
  }
  return normalized;
}

/**
 * Ordered longest-common-subsequence Dice overlap. Unlike prefix matching,
 * this tolerates one provider publishing a denser set of intervening ranks
 * while still requiring shared taxa to occur in biological order.
 *
 * `null` deliberately means "lineage unavailable" rather than either a
 * perfect match or a biological mismatch.
 */
export function orderedLineageDiceOverlap(
  targetLineage: readonly string[],
  donorLineage: readonly string[],
): number | null {
  const target = normalizeLineage(targetLineage);
  const donor = normalizeLineage(donorLineage);
  if (target.length === 0 || donor.length === 0) return null;

  let previous = new Array<number>(donor.length + 1).fill(0);
  for (const targetToken of target) {
    const current = new Array<number>(donor.length + 1).fill(0);
    for (let donorIndex = 1; donorIndex <= donor.length; donorIndex += 1) {
      current[donorIndex] = targetToken === donor[donorIndex - 1]
        ? previous[donorIndex - 1] + 1
        : Math.max(previous[donorIndex], current[donorIndex - 1]);
    }
    previous = current;
  }
  const common = previous[donor.length];
  return (2 * common) / (target.length + donor.length);
}

export function normalizeOmaRelation(value: string): OrthologyRelation {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "1:1" || normalized === "one-to-one" || normalized === "one_to_one") return "one_to_one";
  if (normalized === "1:n" || normalized === "1:m" || normalized === "one-to-many" || normalized === "one_to_many") return "one_to_many";
  if (normalized === "n:1" || normalized === "m:1" || normalized === "many-to-one" || normalized === "many_to_one") return "many_to_one";
  if (normalized === "m:n" || normalized === "n:m" || normalized === "many-to-many" || normalized === "many_to_many") return "many_to_many";
  if (normalized.includes("paralog")) return "post_duplication_paralog";
  if (normalized.includes("coortholog") || normalized.includes("co-ortholog")) return "coortholog";
  return "unresolved_ortholog";
}

export function lineageOverlapFactor(
  targetLineage: readonly string[],
  donorLineage: readonly string[],
  policy: PhylogenyPolicy = DEFAULT_PHYLOGENY_POLICY,
): number {
  const overlap = orderedLineageDiceOverlap(targetLineage, donorLineage);
  if (overlap === null) return 1;
  return round(policy.lineageFloor + policy.lineageRange * overlap);
}

export function taxonConstraintAllows(
  targetTaxonId: number | null,
  targetLineageTaxonIds: number[],
  constraint?: GOTaxonConstraint,
): { status: "allowed" | "forbidden" | "unavailable"; reason: string } {
  if (!constraint || constraint.status === "unavailable" || !positiveTaxon(targetTaxonId)) {
    return { status: "unavailable", reason: "A release-bound GO taxon constraint or declared target TaxID was unavailable." };
  }
  const lineage = new Set([targetTaxonId, ...targetLineageTaxonIds.filter((item) => Number.isInteger(item) && item > 0)]);
  if (constraint.neverInTaxonIds.some((item) => lineage.has(item))) {
    return { status: "forbidden", reason: "The GO term is constrained as never-in-taxon for the declared target lineage." };
  }
  if (constraint.onlyInTaxonIds.length > 0 && !constraint.onlyInTaxonIds.some((item) => lineage.has(item))) {
    return { status: "forbidden", reason: "The declared target lineage does not satisfy the GO term's only-in-taxon constraint." };
  }
  return { status: "allowed", reason: "The declared target lineage passed the available GO taxon constraint." };
}

export function phylogenyCladeKey(evidence: Pick<PhylogenyEvidence, "donorTaxonId" | "donorLineage" | "hogId">, depth = DEFAULT_PHYLOGENY_POLICY.cladeCollapseDepth): string {
  const lineage = normalizeLineage(evidence.donorLineage);
  const clade = lineage.slice(0, Math.max(1, depth)).join("/").toLowerCase();
  const taxon = positiveTaxon(evidence.donorTaxonId) ? String(evidence.donorTaxonId) : "unknown";
  return `${evidence.hogId ?? "no_hog"}|${clade || `taxon:${taxon}`}`;
}

export function adjustByPhylogeny(input: {
  aspect: KnownGOAspect;
  evidence: PhylogenyEvidence;
  targetLineageTaxonIds?: number[];
  constraint?: GOTaxonConstraint;
  policy?: PhylogenyPolicy;
}): PhylogenyAdjustment {
  const policy = input.policy ?? DEFAULT_PHYLOGENY_POLICY;
  const evidence = input.evidence;
  const cladeKey = phylogenyCladeKey(evidence, policy.cladeCollapseDepth);
  if (evidence.queryLike) {
    return {
      status: "quarantined",
      relationFactor: 0,
      distanceFactor: 0,
      lineageFactor: 0,
      taxonConstraintFactor: 0,
      combinedFactor: 0,
      leafTransferAllowed: false,
      cladeKey,
      reasons: ["The mapped anchor or donor is query-like and is quarantined before GO transfer."],
    };
  }
  if (!positiveTaxon(evidence.targetTaxonId)) {
    return {
      status: "unavailable_target_taxon",
      relationFactor: 1,
      distanceFactor: 1,
      lineageFactor: 1,
      taxonConstraintFactor: 1,
      combinedFactor: 1,
      leafTransferAllowed: false,
      cladeKey,
      reasons: ["No declared target TaxID was available; phylogeny reweighting was not guessed from similarity hits."],
    };
  }
  const taxon = taxonConstraintAllows(evidence.targetTaxonId, input.targetLineageTaxonIds ?? [], input.constraint);
  if (taxon.status === "forbidden") {
    return {
      status: "taxon_forbidden",
      relationFactor: policy.relationWeights[evidence.relation],
      distanceFactor: 1,
      lineageFactor: 1,
      taxonConstraintFactor: 0,
      combinedFactor: 0,
      leafTransferAllowed: false,
      cladeKey,
      reasons: [taxon.reason],
    };
  }
  const relationFactor = round(policy.relationWeights[evidence.relation]);
  const distance = evidence.evolutionaryDistance;
  const distanceFactor = distance === null || !Number.isFinite(distance) || distance < 0
    ? 1
    : round(Math.exp(-policy.aspectDistanceDecay[input.aspect] * distance));
  const sameDeclaredTaxon = positiveTaxon(evidence.targetTaxonId)
    && positiveTaxon(evidence.donorTaxonId)
    && evidence.targetTaxonId === evidence.donorTaxonId;
  const lineageFactor = sameDeclaredTaxon
    ? 1
    : lineageOverlapFactor(evidence.targetLineage, evidence.donorLineage, policy);
  const combinedFactor = round(relationFactor * distanceFactor * lineageFactor);
  const paralog = evidence.relation === "post_duplication_paralog";
  return {
    status: "applied",
    relationFactor,
    distanceFactor,
    lineageFactor,
    taxonConstraintFactor: taxon.status === "allowed" ? 1 : 1,
    combinedFactor,
    leafTransferAllowed: !paralog || policy.paralogLeafTransferAllowed,
    cladeKey,
    reasons: [
      `Applied ${evidence.relation} relation weighting before taxonomic proximity.`,
      ...(distance === null ? ["Evolutionary distance was unavailable; no distance penalty was invented."] : []),
      ...(paralog ? ["Post-duplication paralog evidence cannot independently authorize a leaf GO term."] : []),
      taxon.reason,
    ],
  };
}

export function collapseCorrelatedPhylogenySupports<T>(
  supports: readonly T[],
  score: (item: T) => number,
  clade: (item: T) => string,
): T[] {
  const best = new Map<string, T>();
  for (const item of supports) {
    const key = clade(item);
    const current = best.get(key);
    if (current === undefined || score(item) > score(current)) best.set(key, item);
  }
  return [...best.values()].sort((left, right) => score(right) - score(left) || clade(left).localeCompare(clade(right)));
}
