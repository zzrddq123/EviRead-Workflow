import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hashCanonical, sha256File } from "./hash.js";

type Json = Record<string, unknown>;

export interface ReadOptions {
  artifactPath: string;
  runDir?: string;
  modelOnly?: boolean;
  expectedSequenceSha256?: string;
}

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
function array(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}
function text(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Validate and render the first EviRead Read interface. The artifact is
 * deliberately model-agnostic: a GPU worker may produce it online, or a
 * previously verified observation cache may provide it.
 */
export async function loadReadArtifact(options: ReadOptions): Promise<{ bundle: Json; text: string; artifactHash: string }> {
  const raw = await readFile(options.artifactPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const artifact = object(parsed);
  if (artifact.schema !== "biolm-evidence.v1") throw new Error("EviRead BioLM artifact must use schema biolm-evidence.v1");
  if (options.expectedSequenceSha256 && typeof artifact.sequence_sha256 === "string"
    && artifact.sequence_sha256 !== options.expectedSequenceSha256) {
    throw new Error("EviRead BioLM artifact sequence hash does not match the anonymous query");
  }
  const models = array(artifact.models);
  if (models.length === 0) throw new Error("EviRead BioLM artifact contains no model observations");
  const candidates = array(artifact.candidates);
  for (const candidate of candidates) {
    const goId = text(candidate.go_id, "");
    if (!/^GO:\d{7}$/.test(goId)) throw new Error(`Invalid BioLM GO candidate: ${goId}`);
    const score = number(candidate.score ?? candidate.base_score);
    if (score === null || score < 0 || score > 1) throw new Error(`Invalid BioLM candidate score for ${goId}`);
  }

  const lines: string[] = [
    "EviRead biological-model evidence",
    "This is a grounded interface generated from frozen or explicitly requested BioLM observations.",
    "Similarity is evidence for candidate generation and ranking, not calibrated probability or proof of homology.",
    "",
  ];
  for (const model of models) {
    const modelName = text(model.model);
    const neighbors = array(model.neighbors);
    const predictions = array(model.predictions);
    lines.push(`Model: ${modelName}`);
    lines.push(`Observation scope: ${text(model.observation_scope, "whole_protein")}`);
    if (model.input_sequence_sha256) lines.push(`Input sequence hash: ${text(model.input_sequence_sha256)}`);
    if (model.domain_range) lines.push(`Domain/crop range: ${text(model.domain_range)}`);
    lines.push(`Retrieved neighbors: ${neighbors.length}; candidate GO terms: ${predictions.length}`);
    const top = neighbors.slice(0, 10).map((neighbor) => `${text(neighbor.id, "anonymous-donor")} (similarity=${number(neighbor.cosine)?.toFixed(4) ?? "unknown"})`);
    for (const neighbor of neighbors.slice(0, 10)) {
      const context = object(neighbor.donor_context);
      if (Object.keys(context).length) {
        lines.push(`Donor context ${text(neighbor.id)}: ${text(context.protein_name)}; gene=${text(context.gene_symbol, "unknown")}; taxon=${text(context.taxon_id, "unknown")}`);
        const c = object(context.context);
        for (const key of ["function", "catalytic_activity", "domain", "pathway", "subcellular_location", "similarity", "keywords"]) if (c[key]) lines.push(`  ${key}: ${text(c[key])}`);
        const gos = Array.isArray(context.go_evidence) ? context.go_evidence : [];
        if (gos.length) lines.push(`  direct GO evidence: ${gos.slice(0, 20).map((g) => text((g as Json).go_id)).join(", ")}`);
        const neg = Array.isArray(context.negative_constraints) ? context.negative_constraints : [];
        if (neg.length) lines.push(`  negative GO constraints: ${neg.slice(0, 20).map((g) => text((g as Json).go_id)).join(", ")}`);
      }
    }
    if (top.length) lines.push(`Top retrieval observations: ${top.join("; ")}`);
    for (const prediction of predictions.slice(0, 30)) {
      lines.push(`GO hypothesis ${text(prediction.go_id)} (${text(prediction.aspect)}): model support=${number(prediction.score ?? prediction.base_score)?.toFixed(6) ?? "unknown"}`);
    }
    lines.push(`Limitation: ${text(model.limitation, "donor annotations may be correlated")}`);
    lines.push("");
  }
  const limitations = array(artifact.limitations).map((item) => text(item.message ?? item));
  if (limitations.length) {
    lines.push("Global limitations:");
    limitations.forEach((item) => lines.push(`- ${item}`));
  }
  const rendered = `${lines.join("\n").trimEnd()}\n`;
  const artifactHash = hashCanonical(artifact);
  const bundle: Json = {
    schema_version: "pi-function-evidence.v3",
    candidate_sources: {
      providers: [{ provider: "BioLM", status: "completed", endpoint_or_path: options.artifactPath, release: "artifact-bound", request_sha256: null, payload_sha256: artifactHash, cache_hit: true, reason: null }],
      go_candidates: candidates.map((candidate) => ({
        schema_version: "pi-go-candidate.v1",
        go_id: text(candidate.go_id),
        term_name: text(candidate.term_name, "GO name available in frozen ontology"),
        aspect: text(candidate.aspect, "unknown"),
        source_type: "biolm_retrieval",
        source_id: text(candidate.source_id ?? candidate.model, "biolm"),
        mapping_id: text(candidate.mapping_id ?? candidate.evidence_id),
        provider: "BioLM",
        provider_release: text(candidate.provider_release, "artifact-bound"),
        provider_payload_sha256: text(candidate.provider_payload_sha256, artifactHash),
        evidence_id: text(candidate.evidence_id, `biolm:${text(candidate.go_id)}`),
        provenance_root: text(candidate.provenance_root, `biolm:${artifactHash}`),
        base_score: number(candidate.base_score ?? candidate.score) ?? 0,
        query_coverage: null,
        domain_range: candidate.domain_range ?? null,
        query_like: false,
        annotation_evidence_code: "MODEL",
        donor_accession: null,
        phylogeny: null,
        donor_context: candidate.donor_context ?? null,
      })),
    },
    eviread_read: {
      schema: "eviread-read.v1",
      artifact_hash: artifactHash,
      models: models.map((model) => text(model.model)),
      text: rendered,
      limitations,
    },
    evidence_ids: candidates.map((candidate) => text(candidate.evidence_id, `biolm:${text(candidate.go_id)}`)),
  };
  if (options.runDir) {
    const evidenceDir = join(options.runDir, "evidence");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, "eviread_read.txt"), rendered, "utf8");
    await writeFile(join(evidenceDir, "eviread_read.json"), `${JSON.stringify({ artifact_hash: artifactHash, source: options.artifactPath, text: rendered }, null, 2)}\n`, "utf8");
    bundle.eviread_read = { ...(bundle.eviread_read as Json), artifact_path: options.artifactPath, artifact_file_sha256: await sha256File(options.artifactPath) };
  }
  return { bundle, text: rendered, artifactHash };
}

export function mergeReadBundle(base: Json, read: Json): Json {
  const baseSources = object(base.candidate_sources);
  const readSources = object(read.candidate_sources);
  const providers = [...array(baseSources.providers), ...array(readSources.providers)];
  const candidates = [...array(baseSources.go_candidates ?? baseSources.candidates), ...array(readSources.go_candidates ?? readSources.candidates)];
  const evidenceIds = [...new Set([
    ...(Array.isArray(base.evidence_ids) ? base.evidence_ids.map(String) : []),
    ...(Array.isArray(read.evidence_ids) ? read.evidence_ids.map(String) : []),
  ])];
  return {
    ...base,
    candidate_sources: { ...baseSources, providers, go_candidates: candidates },
    eviread_read: read.eviread_read,
    eviread_read_text: object(read.eviread_read).text,
    evidence_ids: evidenceIds,
  };
}
