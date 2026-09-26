import { loadReadArtifact, mergeReadBundle } from "./eviread_read.js";

const REQUIRED_MODELS = ["esm2", "esmc", "protrek"] as const;
const FORBIDDEN_SOURCES = new Set([
  "blast", "blastp", "foldseek", "interpro", "pfam", "panther", "ec",
  "oma", "oma_ortholog", "oma_fastmap", "deepgoplus_cnn", "deepgoplus_hybrid",
  "mdeepfri_cnn", "mdeepfri_gcn",
]);

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
function array(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter((x): x is JsonObject => Boolean(x) && typeof x === "object" && !Array.isArray(x)) : [];
}

/** CodeBase1 resource-plane gate: BioLM channels only, no external search/tools. */
export async function loadModelOnlyEvidence(args: {
  artifactPath: string;
  runDir: string;
  sequenceSha256: string;
  sequenceLength: number;
  sequenceInputSha256: string;
  structureInputSha256?: string | null;
  proteinId: string;
}): Promise<JsonObject> {
  const read = await loadReadArtifact({
    artifactPath: args.artifactPath,
    runDir: args.runDir,
    expectedSequenceSha256: args.sequenceSha256,
  });
  const models = Array.isArray(object(read.bundle.eviread_read).models)
    ? (object(read.bundle.eviread_read).models as unknown[]).map(String)
    : [];
  const declared = new Set(models.map((x) => x.toLowerCase()));
  for (const model of REQUIRED_MODELS) {
    if (!declared.has(model)) throw new Error(`CodeBase1 requires BioLM model channel: ${model}`);
  }
  const sources = object(read.bundle.candidate_sources);
  for (const provider of array(sources.providers)) {
    const name = String(provider.provider ?? "").toLowerCase();
    if (name !== "biolm") throw new Error(`CodeBase1 rejects non-BioLM provider: ${name}`);
  }
  for (const candidate of array(sources.go_candidates)) {
    const sourceType = String(candidate.source_type ?? candidate.sourceType ?? "").toLowerCase();
    if (FORBIDDEN_SOURCES.has(sourceType)) throw new Error(`CodeBase1 rejects forbidden evidence source: ${sourceType}`);
    if (sourceType !== "biolm_retrieval") throw new Error(`CodeBase1 accepts only biolm_retrieval candidates, got ${sourceType}`);
  }
  const merged = mergeReadBundle({
    schema_version: "pi-function-evidence.v3",
    sequence_hits: [],
    structure_hits: [],
    uniprot_annotations: [],
    domain_annotations: [],
    evidence_ids: [],
    protein: {
      header: "anonymous_query",
      protein_id: args.proteinId,
      sequence_length: args.sequenceLength,
      sequence_sha256: args.sequenceSha256,
      sequence_input_sha256: args.sequenceInputSha256,
      structure_available: args.structureInputSha256 !== undefined && args.structureInputSha256 !== null,
      structure_input_sha256: args.structureInputSha256 ?? null,
      query_taxon_id: null,
      query_taxon_id_source: "unavailable",
      query_like_accessions: [],
      query_lineage: [],
      query_lineage_source: "unavailable",
    },
    model_only_profile: {
      profile: "eviread-codebase1-biolm-only.v1",
      allowed_models: [...REQUIRED_MODELS],
      forbidden_tools: [...FORBIDDEN_SOURCES],
    },
  }, read.bundle) as JsonObject;
  const mergedSources = object(merged.candidate_sources);
  merged.candidate_sources = {
    ...mergedSources,
    providers: array(mergedSources.providers).map((provider) => ({ ...provider, endpoint_or_path: "artifact-bound" })),
  };
  if (merged.eviread_read && typeof merged.eviread_read === "object" && !Array.isArray(merged.eviread_read)) {
    merged.eviread_read = { ...(merged.eviread_read as JsonObject), artifact_path: "artifact-bound" };
  }
  return merged;
}

export function assertModelOnlyEnvironment(env: Record<string, string | undefined>): void {
  const profile = env.EVIREAD_PROFILE ?? "";
  if (profile !== "model_only") throw new Error("CodeBase1 requires EVIREAD_PROFILE=model_only");
  for (const key of ["BLASTP_BIN", "BLAST_DB", "FOLDSEEK_BIN", "FOLDSEEK_SWISSPROT_DB", "OMA_MODE", "DEEPGOPLUS_MODE"]) {
    if (env[key] && env[key] !== "disabled") throw new Error(`CodeBase1 refuses tool configuration ${key}; CodeBase1 is BioLM-only`);
  }
}
