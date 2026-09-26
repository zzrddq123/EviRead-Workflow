import { isAbsolute, resolve } from "node:path";

import { PROJECT_ROOT } from "./config.js";
import {
  collectRemoteCandidateSources,
  DirectoryRemoteCandidateCache,
  mergeRemoteCandidateBundles,
  type RemoteProviderDependencies,
  type RemoteProviderMode,
  type SnakeCaseCandidateSourceBundle,
} from "./remote_candidate_providers.js";
import {
  collectDeepGoPlusCandidateSource,
  type DeepGoPlusDependencies,
} from "./deepgoplus.js";
import {
  collectDeepGoPlusHybridCandidateSource,
  type DeepGoPlusHybridDependencies,
} from "./deepgoplus_hybrid.js";
import { collectLocalCandidateSources, type LocalCandidateDependencies } from "./local_candidate_providers.js";

type JsonObject = Record<string, unknown>;
type CandidateProviderMode = RemoteProviderMode | "local";

export interface CandidateStageConfig {
  interproMode: CandidateProviderMode;
  omaMode: CandidateProviderMode;
  omaFastMapMode: RemoteProviderMode;
  interproEmail?: string;
  interproBaseUrl?: string;
  interproApplications?: string[];
  interproExternal2GoEnabled: boolean;
  external2GoBaseUrl?: string;
  interproRequestTimeoutMs: number;
  interproPollIntervalMs: number;
  interproMaxPolls: number;
  omaBaseUrl?: string;
  omaRequestTimeoutMs: number;
  omaMinQueryCoverage: number;
  omaMinIdentity: number;
  omaMaxOrthologs: number;
  omaMaxConcurrentRequests: number;
  omaFastMapBaseUrl?: string;
  omaFastMapRequestTimeoutMs: number;
  omaFastMapMaxCandidates: number;
  cacheDirectory: string;
}

function providerMode(value: string | undefined, fallback: CandidateProviderMode): CandidateProviderMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "disabled" || normalized === "remote" || normalized === "local") return normalized;
  throw new Error(`Unsupported candidate provider mode: ${value}. Use disabled, local, or remote.`);
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be ${integer ? "an integer" : "a number"} in [${minimum}, ${maximum}].`);
  }
  return parsed;
}

function configuredPath(value: string | undefined): string {
  const configured = value?.trim() || ".runtime/cache/candidate_sources";
  return isAbsolute(configured) ? configured : resolve(PROJECT_ROOT, configured);
}

function configuredBoolean(value: string | undefined, fallback: boolean, label: string): boolean {
  if (!value?.trim()) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${label} must be true or false.`);
}

export function candidateStageConfigFromEnv(env: NodeJS.ProcessEnv): CandidateStageConfig {
  const globalMode = providerMode(env.CANDIDATE_PROVIDER_MODE, "disabled");
  const applications = env.INTERPROSCAN_APPLICATIONS?.split(",").map((item) => item.trim()).filter(Boolean);
  const omaFastMapMode = providerMode(
    env.OMA_FASTMAP_MODE,
    globalMode === "local" ? "disabled" : globalMode,
  );
  if (omaFastMapMode === "local") {
    throw new Error("OMA FastMap has no local frozen mode; use disabled or remote.");
  }
  return {
    interproMode: providerMode(env.INTERPROSCAN_MODE, globalMode),
    omaMode: providerMode(env.OMA_MODE, globalMode),
    omaFastMapMode,
    interproEmail: env.INTERPROSCAN_EMAIL?.trim() || undefined,
    interproBaseUrl: env.INTERPROSCAN_REST_URL?.trim() || undefined,
    interproApplications: applications && applications.length > 0 ? applications : undefined,
    interproExternal2GoEnabled: configuredBoolean(env.INTERPROSCAN_EXTERNAL2GO_ENABLED, true, "INTERPROSCAN_EXTERNAL2GO_ENABLED"),
    external2GoBaseUrl: env.GO_EXTERNAL2GO_BASE_URL?.trim() || undefined,
    interproRequestTimeoutMs: boundedNumber(env.INTERPROSCAN_REQUEST_TIMEOUT_MS, 30_000, "INTERPROSCAN_REQUEST_TIMEOUT_MS", 1, 600_000, true),
    interproPollIntervalMs: boundedNumber(env.INTERPROSCAN_POLL_INTERVAL_MS, 5_000, "INTERPROSCAN_POLL_INTERVAL_MS", 0, 60_000, true),
    interproMaxPolls: boundedNumber(env.INTERPROSCAN_MAX_POLLS, 90, "INTERPROSCAN_MAX_POLLS", 1, 1_000, true),
    omaBaseUrl: env.OMA_REST_URL?.trim() || undefined,
    omaRequestTimeoutMs: boundedNumber(env.OMA_REQUEST_TIMEOUT_MS, 30_000, "OMA_REQUEST_TIMEOUT_MS", 1, 600_000, true),
    omaMinQueryCoverage: boundedNumber(env.OMA_MIN_QUERY_COVERAGE, 0.65, "OMA_MIN_QUERY_COVERAGE", 0, 1),
    omaMinIdentity: boundedNumber(env.OMA_MIN_IDENTITY, 0.25, "OMA_MIN_IDENTITY", 0, 1),
    omaMaxOrthologs: boundedNumber(env.OMA_MAX_ORTHOLOGS, 25, "OMA_MAX_ORTHOLOGS", 1, 100, true),
    omaMaxConcurrentRequests: boundedNumber(env.OMA_MAX_CONCURRENT_REQUESTS, 4, "OMA_MAX_CONCURRENT_REQUESTS", 1, 8, true),
    omaFastMapBaseUrl: env.OMA_FASTMAP_REST_URL?.trim() || env.OMA_REST_URL?.trim() || undefined,
    omaFastMapRequestTimeoutMs: boundedNumber(env.OMA_FASTMAP_REQUEST_TIMEOUT_MS, 30_000, "OMA_FASTMAP_REQUEST_TIMEOUT_MS", 1, 600_000, true),
    omaFastMapMaxCandidates: boundedNumber(env.OMA_FASTMAP_MAX_CANDIDATES, 120, "OMA_FASTMAP_MAX_CANDIDATES", 1, 250, true),
    cacheDirectory: configuredPath(env.REMOTE_CANDIDATE_CACHE_DIR),
  };
}

function records(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

/**
 * A caller declaration, direct taxonomy lookup, or a hash-bound conservative
 * frozen-donor consensus may define provider lineage context. The consensus is
 * explicitly coarse and never masquerades as a declared target TaxID.
 */
export function trustedTargetLineageFromEvidence(protein: JsonObject): string[] {
  const source = String(protein.query_lineage_source ?? "").trim();
  if (!["target_taxonomy_provider", "declared_taxid_lookup", "frozen_donor_consensus"].includes(source)) return [];
  return Array.isArray(protein.query_lineage)
    ? protein.query_lineage
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
    : [];
}

/**
 * Bind provider candidates into the immutable evidence object consumed by GO
 * inference. Candidate and phylogeny IDs become first-class citation IDs.
 */
export function attachCandidateSources(
  bundle: JsonObject,
  sourceBundle: SnakeCaseCandidateSourceBundle,
): JsonObject {
  const candidates = records(sourceBundle.candidate_sources.go_candidates);
  const candidateIds = candidates.flatMap((candidate) => {
    const ids = [String(candidate.evidence_id ?? "")];
    const phylogeny = candidate.phylogeny;
    if (phylogeny && typeof phylogeny === "object" && !Array.isArray(phylogeny)) {
      ids.push(String((phylogeny as JsonObject).evidence_id ?? ""));
    }
    return ids;
  }).filter(Boolean);
  // Preserve the exact pre-candidate evidence-ID order. Learned receipts bind
  // hashCanonical(bundle) before this attachment, so globally re-sorting the
  // base array would make the pre-candidate object impossible to reconstruct
  // at validation time. Provider candidate rows are already deterministic.
  const evidenceIds = [...new Set([
    ...(Array.isArray(bundle.evidence_ids) ? bundle.evidence_ids.map(String) : []),
    ...candidateIds,
  ])];
  return {
    ...bundle,
    candidate_sources: sourceBundle.candidate_sources,
    evidence_ids: evidenceIds,
  };
}

export async function collectConfiguredCandidateSources(input: {
  sequence: string;
  targetTaxonId: number | null;
  targetLineage?: readonly string[];
  excludedAccessions: readonly string[];
  /**
   * Learned source explicitly requested by the active genome. Local learned
   * executables must never run merely because workstation configuration is
   * present.
   */
  requestedLearnedSource?: "mdeepfri_cnn" | "mdeepfri_gcn" | "deepgoplus_cnn" | "deepgoplus_hybrid" | null;
  /** Hash of fixed evidence before candidate providers are attached. */
  baseFrozenEvidenceSetHash?: string;
  env: NodeJS.ProcessEnv;
  dependencies?: RemoteProviderDependencies;
  deepGoPlusDependencies?: DeepGoPlusDependencies;
  deepGoPlusHybridDependencies?: DeepGoPlusHybridDependencies;
  localCandidateDependencies?: LocalCandidateDependencies;
}): Promise<SnakeCaseCandidateSourceBundle> {
  const config = candidateStageConfigFromEnv(input.env);
  const dependencies = input.dependencies ?? {
    cache: new DirectoryRemoteCandidateCache(config.cacheDirectory),
  };
  const [remoteRaw, local, deepGoPlus] = await Promise.all([
    collectRemoteCandidateSources({
      sequence: {
        sequence: input.sequence,
        targetTaxonId: input.targetTaxonId,
        targetLineage: (input.targetLineage ?? []).map((item) => item.trim()).filter(Boolean),
      },
      interpro: {
        mode: config.interproMode === "remote" ? "remote" : "disabled",
        email: config.interproEmail,
        baseUrl: config.interproBaseUrl,
        applications: config.interproApplications,
        useExternal2Go: config.interproExternal2GoEnabled,
        external2GoBaseUrl: config.external2GoBaseUrl,
        requestTimeoutMs: config.interproRequestTimeoutMs,
        pollIntervalMs: config.interproPollIntervalMs,
        maxPolls: config.interproMaxPolls,
      },
      oma: {
        mode: config.omaMode === "remote" ? "remote" : "disabled",
        baseUrl: config.omaBaseUrl,
        requestTimeoutMs: config.omaRequestTimeoutMs,
        minQueryCoverage: config.omaMinQueryCoverage,
        minIdentity: config.omaMinIdentity,
        maxOrthologs: config.omaMaxOrthologs,
        maxConcurrentRequests: config.omaMaxConcurrentRequests,
        queryLikeAccessions: [...input.excludedAccessions],
      },
      omaFastMap: {
        mode: config.omaFastMapMode,
        baseUrl: config.omaFastMapBaseUrl,
        requestTimeoutMs: config.omaFastMapRequestTimeoutMs,
        maxCandidates: config.omaFastMapMaxCandidates,
        queryLikeAccessions: [...input.excludedAccessions],
      },
      dependencies,
    }),
    collectLocalCandidateSources({
      sequence: input.sequence,
      targetLineage: input.targetLineage ?? [],
      excludedAccessions: input.excludedAccessions,
      interproMode: config.interproMode === "local" ? "local" : "disabled",
      omaMode: config.omaMode === "local" ? "local" : "disabled",
      env: input.env,
      dependencies: input.localCandidateDependencies,
    }),
    input.requestedLearnedSource === "deepgoplus_cnn"
      ? collectDeepGoPlusCandidateSource({
        sequence: input.sequence,
        baseFrozenEvidenceSetHash: input.baseFrozenEvidenceSetHash ?? "",
        env: input.env,
        dependencies: input.deepGoPlusDependencies,
      })
      : input.requestedLearnedSource === "deepgoplus_hybrid"
        ? collectDeepGoPlusHybridCandidateSource({
          sequence: input.sequence,
          baseFrozenEvidenceSetHash: input.baseFrozenEvidenceSetHash ?? "",
          env: input.env,
          dependencies: input.deepGoPlusHybridDependencies,
        })
      : Promise.resolve(null),
  ]);
  const localProviders = new Set(local.candidate_sources.providers
    .filter((provider) => provider.status !== "unavailable" || provider.endpoint_or_path.startsWith("local:"))
    .map((provider) => provider.provider));
  const remote = {
    candidate_sources: {
      providers: remoteRaw.candidate_sources.providers.filter((provider) => !localProviders.has(provider.provider)),
      go_candidates: remoteRaw.candidate_sources.go_candidates,
    },
  } satisfies SnakeCaseCandidateSourceBundle;
  const base = mergeRemoteCandidateBundles([remote, local]);
  if (!deepGoPlus) return base;
  const merged = mergeRemoteCandidateBundles([base, deepGoPlus]);
  return {
    candidate_sources: {
      ...merged.candidate_sources,
      ...(deepGoPlus.candidate_sources.deepgoplus_receipt
        ? { deepgoplus_receipt: deepGoPlus.candidate_sources.deepgoplus_receipt }
        : {}),
    },
  };
}
