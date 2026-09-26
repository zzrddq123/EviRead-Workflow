/** Admission and sanitization for a CAFA/LAFA-style inner evidence plane. */

import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hashCanonical } from "./hash.js";

const REQUIRED_PATH_KEYS = [
  "TEMPORAL_RESOURCE_CONTRACT",
  "TEMPORAL_RESOURCE_PROFILE",
  "TEMPORAL_T0_SEQUENCE_FASTA",
  "TEMPORAL_T0_TERMS",
  "TEMPORAL_T0_ANNOTATION_STORE",
  "TEMPORAL_T0_ANNOTATION_MANIFEST",
  "TEMPORAL_BLAST_MANIFEST",
  "GO_ONTOLOGY_OBO",
  "BLAST_DB",
] as const;

const REMOTE_EVIDENCE_KEYS = [
  "EVIDENCE_API_URL",
  "EVIDENCE_API_TOKEN",
  "NCBI_BLAST_URL",
  "NCBI_BLAST_EMAIL",
  "FOLDSEEK_REMOTE_URL",
  "FOLDSEEK_REMOTE_DATABASES",
  "INTERPROSCAN_REST_URL",
  "INTERPROSCAN_EMAIL",
  "GO_EXTERNAL2GO_BASE_URL",
  "OMA_REST_URL",
  "OMA_FASTMAP_REST_URL",
  "REMOTE_CANDIDATE_CACHE_DIR",
] as const;

type TemporalPipelineProfile = "sequence" | "sequence_structure";

type ExternalResourceProfile = {
  schemaVersion: "pi-external-resource-profile.v1";
  profileId: "strict_t0" | "t0_afdb_v5" | "method_optimization_structure_companion" | "z86_t0_afdb_v5_early" | "z86_t0_afdb_v5_r09" | "z86_t0_afdb_v5_swissprot_2025_03_full_early" | "z86_t0_afdb_v5_swissprot_2025_03_full_r09" | "current_discovery";
  mode: "strict_t0_evidence_plane" | "current_discovery";
  knowledgeCutoff: string | null;
  networkPolicy: string;
  candidateProviders: Record<string, string>;
  resources?: Array<Record<string, unknown>>;
  canonicalHash: string;
};

function loadResourceProfile(env: NodeJS.ProcessEnv): ExternalResourceProfile {
  const configured = env.TEMPORAL_RESOURCE_PROFILE?.trim();
  if (!configured) throw new Error("strict temporal inner mode requires TEMPORAL_RESOURCE_PROFILE");
  const path = resolve(configured);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("TEMPORAL_RESOURCE_PROFILE must be an ordinary file");
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TEMPORAL_RESOURCE_PROFILE must contain an object");
  }
  const profile = parsed as ExternalResourceProfile;
  const { canonicalHash, ...content } = profile;
  if (profile.schemaVersion !== "pi-external-resource-profile.v1"
    || !/^[a-f0-9]{64}$/.test(canonicalHash)
    || canonicalHash !== hashCanonical(content)
    || !["strict_t0", "t0_afdb_v5", "method_optimization_structure_companion", "z86_t0_afdb_v5_early", "z86_t0_afdb_v5_r09", "z86_t0_afdb_v5_swissprot_2025_03_full_early", "z86_t0_afdb_v5_swissprot_2025_03_full_r09", "current_discovery"].includes(profile.profileId)) {
    throw new Error("TEMPORAL_RESOURCE_PROFILE is invalid or non-canonical");
  }
  const requestedId = env.TEMPORAL_RESOURCE_PROFILE_ID?.trim();
  if (requestedId && requestedId !== profile.profileId) {
    throw new Error("TEMPORAL_RESOURCE_PROFILE_ID differs from the loaded resource profile");
  }
  if (profile.profileId === "t0_afdb_v5") {
    const acquisitions = (profile.resources ?? []).filter(
      (item) => item.role === "target_structure_acquisition",
    );
    if (acquisitions.length !== 1
      || !/^[a-f0-9]{64}$/.test(String(acquisitions[0]!.archiveSha256 ?? ""))) {
      throw new Error("t0_afdb_v5 is not activated with a verified archive SHA256");
    }
  }
  return profile;
}

function normalized(env: NodeJS.ProcessEnv, key: string, fallback = ""): string {
  return (env[key] ?? fallback).trim().toLowerCase();
}

function requireMode(
  env: NodeJS.ProcessEnv,
  key: string,
  expected: string,
  fallback = "",
): void {
  const value = normalized(env, key, fallback);
  if (value !== expected) {
    throw new Error(
      `strict temporal inner mode requires ${key}=${expected}; observed ${value || "<empty>"}`,
    );
  }
}

/**
 * Keep model-transport credentials/network settings, but close every
 * biological evidence/provider route other than the hash-bound local T0 lane.
 * The Python evidence process performs content-hash validation of the resource,
 * BLAST, and annotation-store manifests before it executes a search.
 */
export function temporalPredictionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const mode = normalized(env, "TEMPORAL_INNER_MODE", "disabled");
  if (mode === "" || mode === "disabled") {
    if (!env.TEMPORAL_RESOURCE_PROFILE?.trim()) return env;
    const profile = loadResourceProfile(env);
    if (profile.profileId !== "current_discovery"
      || profile.mode !== "current_discovery"
      || profile.networkPolicy !== "current_biological_resources_allowed") {
      throw new Error("a non-temporal prediction may only select current_discovery");
    }
    return { ...env, TEMPORAL_RESOURCE_PROFILE_ID: profile.profileId };
  }
  if (mode !== "strict") {
    throw new Error("TEMPORAL_INNER_MODE must be disabled or strict");
  }
  requireMode(env, "EVIDENCE_BACKEND", "local", "local");
  const resourceProfile = loadResourceProfile(env);
  if (!["strict_t0", "t0_afdb_v5", "method_optimization_structure_companion", "z86_t0_afdb_v5_early", "z86_t0_afdb_v5_r09", "z86_t0_afdb_v5_swissprot_2025_03_full_early", "z86_t0_afdb_v5_swissprot_2025_03_full_r09"].includes(resourceProfile.profileId)
    || resourceProfile.mode !== "strict_t0_evidence_plane"
    || !["biological_network_disabled", "acquisition_only_then_offline"].includes(resourceProfile.networkPolicy)) {
    throw new Error("TEMPORAL_RESOURCE_PROFILE is not admitted for strict benchmark use");
  }
  const pipelineProfile = normalized(env, "TEMPORAL_PIPELINE_PROFILE", "sequence");
  if (pipelineProfile !== "sequence" && pipelineProfile !== "sequence_structure") {
    throw new Error("TEMPORAL_PIPELINE_PROFILE must be sequence or sequence_structure");
  }
  requireMode(env, "EVIDENCE_PROFILE", pipelineProfile);
  requireMode(env, "SEQUENCE_SEARCH_BACKEND", "local", "local");
  requireMode(env, "STRUCTURE_SEARCH_BACKEND", "local", "local");
  for (const key of ["CANDIDATE_PROVIDER_MODE", "INTERPROSCAN_MODE", "OMA_FASTMAP_MODE"] as const) {
    requireMode(env, key, "disabled", "disabled");
  }
  const omaMode = normalized(env, "OMA_MODE", "disabled");
  if (["local_hash_bound_primates_only", "local_hash_bound_all_species_hog"].includes(
    resourceProfile.candidateProviders.oma,
  )) {
    requireMode(env, "OMA_MODE", "local", "disabled");
    for (const key of ["OMA_LOCAL_PYTHON", "OMA_LOCAL_RUNNER", "OMA_LOCAL_BIN", "OMA_LOCAL_DATABASE", "OMA_LOCAL_STORE", "OMA_LOCAL_MANIFEST"] as const) {
      if (!env[key]?.trim()) throw new Error(`strict temporal local OMAmer requires ${key}`);
    }
  } else if (omaMode !== "disabled") {
    throw new Error("the selected strict resource profile does not admit local OMAmer");
  }
  const deepGoMode = normalized(env, "DEEPGOPLUS_MODE", "disabled");
  if (!["disabled", "local"].includes(deepGoMode)) {
    throw new Error("strict temporal inner mode permits DEEPGOPLUS_MODE=disabled or local only");
  }
  if (deepGoMode === "local") {
    if (resourceProfile.candidateProviders.deepgoplus_cnn !== "local_hash_bound_only") {
      throw new Error("the selected resource profile does not admit local DeepGOPlus");
    }
    if (env.DEEPGOPLUS_DATA_RELEASE?.trim() !== "1.0.25") {
      throw new Error("strict temporal DeepGOPlus requires DEEPGOPLUS_DATA_RELEASE=1.0.25");
    }
  }
  requireMode(env, "DEEPGOPLUS_HYBRID_MODE", "disabled", "disabled");
  requireMode(env, "INTERPROSCAN_EXTERNAL2GO_ENABLED", "false", "false");
  if (resourceProfile.candidateProviders.taxonomy_lineage === "local_hash_bound_only") {
    for (const key of ["TEMPORAL_T0_TAXONOMY_STORE", "TEMPORAL_T0_TAXONOMY_MANIFEST"] as const) {
      if (!env[key]?.trim()) throw new Error(`strict temporal taxonomy calibration requires ${key}`);
    }
  }
  for (const key of REQUIRED_PATH_KEYS) {
    if (!env[key]?.trim()) throw new Error(`strict temporal inner mode requires ${key}`);
  }
  if (pipelineProfile === "sequence_structure") {
    for (const key of [
      "TEMPORAL_LOCAL_EVIDENCE_SNAPSHOT",
      "TEMPORAL_TARGET_STRUCTURE_MANIFEST",
      "TEMPORAL_TARGET_STRUCTURE_ROOT",
      "FOLDSEEK_BIN",
    ] as const) {
      if (!env[key]?.trim()) {
        throw new Error(`strict temporal sequence_structure mode requires ${key}`);
      }
    }
    requireMode(
      env,
      "TEMPORAL_TARGET_STRUCTURE_POLICY",
      resourceProfile.profileId === "method_optimization_structure_companion"
        || resourceProfile.profileId.startsWith("z86_t0_afdb_v5_")
        ? "structure_companion" : "t0_only",
      "",
    );
    requireMode(env, "TEMPORAL_STRUCTURE_REQUIREMENT", "required", "");
    if (!env.FOLDSEEK_SWISSPROT_DB?.trim() && !env.FOLDSEEK_PDB_DB?.trim()) {
      throw new Error(
        "strict temporal sequence_structure mode requires at least one local Foldseek database",
      );
    }
  }

  const output: NodeJS.ProcessEnv = {
    ...env,
    EVIDENCE_BACKEND: "local",
    TEMPORAL_PIPELINE_PROFILE: pipelineProfile as TemporalPipelineProfile,
    EVIDENCE_PROFILE: pipelineProfile,
    SEQUENCE_SEARCH_BACKEND: "local",
    STRUCTURE_SEARCH_BACKEND: "local",
    CANDIDATE_PROVIDER_MODE: "disabled",
    INTERPROSCAN_MODE: "disabled",
    OMA_MODE: omaMode,
    OMA_FASTMAP_MODE: "disabled",
    INTERPROSCAN_EXTERNAL2GO_ENABLED: "false",
    DEEPGOPLUS_MODE: "disabled",
    DEEPGOPLUS_HYBRID_MODE: "disabled",
  };
  output.TEMPORAL_RESOURCE_PROFILE_ID = resourceProfile.profileId;
  output.DEEPGOPLUS_MODE = deepGoMode;
  for (const key of REMOTE_EVIDENCE_KEYS) delete output[key];
  return output;
}
