import type { AnyExternalGoPredictorOverlay } from "./external_go_predictor.js";
import { hashCanonical, sha256Text } from "./hash.js";
import type { AgentGenome } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const GO_ID = /^GO:\d{7}$/;
const DEEPGOPLUS_RECEIPT_FIELDS = [
  "schema_version",
  "provider",
  "source_type",
  "architecture",
  "package_version",
  "data_release",
  "runner_sha256",
  "model_sha256",
  "terms_sha256",
  "ontology_sha256",
  "method_hash",
  "request_sha256",
  "prediction_set_hash",
  "base_frozen_evidence_set_hash",
  "score_semantics",
  "homology_component",
  "ontology_propagation",
  "canonical_hash",
] as const;

const DEEPGOPLUS_HYBRID_RECEIPT_FIELDS = [
  "schema_version",
  "provider",
  "source_type",
  "architecture",
  "package_version",
  "python_executable_sha256",
  "tensorflow_version",
  "numpy_version",
  "pandas_version",
  "data_release",
  "runner_sha256",
  "model_sha256",
  "terms_sha256",
  "ontology_sha256",
  "annotations_sha256",
  "diamond_database_sha256",
  "training_fasta_sha256",
  "metadata_sha256",
  "diamond_executable_sha256",
  "method_hash",
  "request_sha256",
  "prediction_set_hash",
  "base_frozen_evidence_set_hash",
  "score_semantics",
  "stock_score_semantics",
  "agent_candidate_score_semantics",
  "homology_component",
  "ontology_propagation",
  "diamond_hit_count",
  "exact_training_sequence_match_count",
  "near_exact_training_sequence_match_count",
  "query_like_policy",
  "agent_direct_candidate_floor",
  "agent_direct_candidate_count",
  "agent_direct_candidate_set_hash",
  "top_diamond_donors",
  "canonical_hash",
] as const;

export type LearnedPredictorSource =
  | "mdeepfri_cnn"
  | "mdeepfri_gcn"
  | "deepgoplus_cnn"
  | "deepgoplus_hybrid";
export type LearnedPredictorExecutionBoundary =
  | "frozen evidence replay"
  | "legacy outer evaluator replay"
  | "legacy RSI replay"
  | "strict artifact recomputation"
  | "live prediction";

/**
 * The minimum receipt-bearing identity needed to prove that an enabled
 * learned channel is present. The overlay loaders validate the full document;
 * this smaller interface lets every execution boundary enforce completeness
 * without knowing how the predictor was acquired.
 */
export interface LearnedPredictorBinding {
  provider: "mDeepFRI" | "DeepGOPlus";
  sourceType: LearnedPredictorSource;
  overlayHash: string;
  methodHash: string;
  predictionSetHash: string;
  baseFrozenEvidenceSetHash: string;
}

export function learnedPredictorBindingFromOverlay(
  overlay: AnyExternalGoPredictorOverlay,
): LearnedPredictorBinding {
  return {
    provider: overlay.method.provider,
    sourceType: overlay.method.sourceType,
    overlayHash: overlay.canonicalHash,
    methodHash: overlay.method.methodHash,
    predictionSetHash: overlay.predictionSetHash,
    baseFrozenEvidenceSetHash: overlay.base.baseFrozenEvidenceSetHash,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function deepGoPlusBinding(
  bundle: Record<string, unknown>,
  candidateSources: Record<string, unknown>,
  providers: Record<string, unknown>[],
  receipt: Record<string, unknown>,
): LearnedPredictorBinding | null {
  const actualReceiptFields = Object.keys(receipt).sort();
  const expectedReceiptFields = [...DEEPGOPLUS_RECEIPT_FIELDS].sort();
  if (actualReceiptFields.length !== expectedReceiptFields.length
    || actualReceiptFields.some((field, index) => field !== expectedReceiptFields[index])) return null;

  if (receipt.schema_version !== "pi-deepgoplus-candidate-receipt.v1"
    || receipt.provider !== "DeepGOPlus"
    || receipt.source_type !== "deepgoplus_cnn"
    || receipt.architecture !== "sequence_cnn"
    || receipt.score_semantics !== "direct_cnn_head_pre_ontology"
    || receipt.homology_component !== "not_executed"
    || receipt.ontology_propagation !== "host_only") return null;
  for (const field of [
    "runner_sha256",
    "model_sha256",
    "terms_sha256",
    "ontology_sha256",
    "method_hash",
    "request_sha256",
    "prediction_set_hash",
    "base_frozen_evidence_set_hash",
    "canonical_hash",
  ]) {
    if (!SHA256.test(String(receipt[field] ?? ""))) return null;
  }
  const { canonical_hash: canonicalHash, ...receiptContent } = receipt;
  if (canonicalHash !== hashCanonical(receiptContent)) return null;

  const packageVersion = String(receipt.package_version ?? "");
  const dataRelease = String(receipt.data_release ?? "");
  if (!packageVersion || !dataRelease) return null;
  const release = `${packageVersion};data-${dataRelease}`;
  const completedProviders = providers.filter(
    (provider) => provider.provider === "DeepGOPlus" && provider.status === "completed",
  );
  if (completedProviders.length !== 1) return null;
  const provider = completedProviders[0];
  if (provider.release !== release
    || provider.request_sha256 !== receipt.request_sha256
    || provider.payload_sha256 !== receipt.prediction_set_hash
    || provider.endpoint_or_path !== `local:model-bound:${String(receipt.prediction_set_hash).slice(0, 16)}`) {
    return null;
  }

  const candidates = Array.isArray(candidateSources.go_candidates)
    ? candidateSources.go_candidates.map(record)
    : [];
  if (candidates.some((candidate) => candidate === undefined)) return null;
  const candidateRows = candidates.filter(
    (candidate): candidate is Record<string, unknown> => candidate !== undefined,
  );
  const deepRows = candidateRows.filter(
    (candidate) => candidate.source_type === "deepgoplus_cnn" || candidate.provider === "DeepGOPlus",
  );
  const protein = record(bundle.protein);
  const sequenceSha256 = String(protein?.sequence_sha256 ?? "");
  if (!SHA256.test(sequenceSha256)) return null;
  const expectedRoot = `deepgoplus-cnn:${sha256Text(`${String(receipt.method_hash)}\0${sequenceSha256}`)}`;
  const seenGoIds = new Set<string>();
  const seenEvidenceIds = new Set<string>();
  for (const candidate of deepRows) {
    const goId = String(candidate.go_id ?? "");
    const termName = String(candidate.term_name ?? "");
    const aspect = String(candidate.aspect ?? "");
    const score = candidate.base_score;
    const evidenceId = String(candidate.evidence_id ?? "");
    if (candidate.source_type !== "deepgoplus_cnn"
      || candidate.provider !== "DeepGOPlus"
      || candidate.provider_release !== release
      || candidate.provider_payload_sha256 !== receipt.prediction_set_hash
      || candidate.source_id !== `deepgoplus_cnn:${String(receipt.model_sha256).slice(0, 16)}`
      || candidate.mapping_id !== `deepgoplus_cnn:${goId}`
      || candidate.provenance_root !== expectedRoot
      || candidate.annotation_evidence_code !== "MODEL"
      || candidate.query_like !== false
      || candidate.donor_accession !== null
      || candidate.phylogeny !== null
      || !GO_ID.test(goId)
      || termName.trim() === ""
      || !["molecular_function", "biological_process", "cellular_component"].includes(aspect)
      || typeof score !== "number"
      || !Number.isFinite(score)
      || score < 0
      || score > 1
      || seenGoIds.has(goId)
      || seenEvidenceIds.has(evidenceId)) return null;
    const token = sha256Text(`${expectedRoot}\0${goId}\0${score}`);
    if (evidenceId !== `CAND-DGP-${token.slice(0, 20).toUpperCase()}`) return null;
    seenGoIds.add(goId);
    seenEvidenceIds.add(evidenceId);
  }
  const caseId = `DGP_${sequenceSha256.slice(0, 16).toUpperCase()}`;
  if (receipt.request_sha256 !== hashCanonical({
    schemaVersion: "pi-deepgoplus-cnn-run-request.v1",
    methodHash: receipt.method_hash,
    cases: [{ caseId, sequenceSha256 }],
  })) return null;
  if (receipt.prediction_set_hash !== hashCanonical([{
    caseId,
    sequenceSha256,
    predictions: deepRows.map((candidate) => ({
      goId: candidate.go_id,
      termName: String(candidate.term_name).trim(),
      aspect: candidate.aspect,
      score: candidate.base_score,
    })),
  }])) return null;

  // Reconstruct the exact pre-candidate evidence object used by the live
  // adapter. This binds the receipt to the private evidence bundle rather
  // than accepting a self-consistent but transplanted receipt/provider pair.
  if (!Array.isArray(bundle.evidence_ids)) return null;
  const allCandidateIds = new Set<string>();
  for (const candidate of candidateRows) {
    const evidenceId = String(candidate.evidence_id ?? "");
    if (!evidenceId) return null;
    allCandidateIds.add(evidenceId);
    const phylogeny = record(candidate.phylogeny);
    if (phylogeny) {
      const phylogenyEvidenceId = String(phylogeny.evidence_id ?? "");
      if (phylogenyEvidenceId) allCandidateIds.add(phylogenyEvidenceId);
    }
  }
  const evidenceIds = bundle.evidence_ids.map(String);
  if ([...allCandidateIds].some((evidenceId) => !evidenceIds.includes(evidenceId))) return null;
  const { candidate_sources: _candidateSources, ...baseWithoutCandidates } = bundle;
  const reconstructedBase = {
    ...baseWithoutCandidates,
    evidence_ids: evidenceIds.filter((evidenceId) => !allCandidateIds.has(evidenceId)),
  };
  if (hashCanonical(reconstructedBase) !== receipt.base_frozen_evidence_set_hash) return null;

  return {
    provider: "DeepGOPlus",
    sourceType: "deepgoplus_cnn",
    overlayHash: String(receipt.canonical_hash),
    methodHash: String(receipt.method_hash),
    predictionSetHash: String(receipt.prediction_set_hash),
    baseFrozenEvidenceSetHash: String(receipt.base_frozen_evidence_set_hash),
  };
}

function deepGoPlusHybridBinding(
  bundle: Record<string, unknown>,
  candidateSources: Record<string, unknown>,
  providers: Record<string, unknown>[],
  receipt: Record<string, unknown>,
): LearnedPredictorBinding | null {
  const actualReceiptFields = Object.keys(receipt).sort();
  const expectedReceiptFields = [...DEEPGOPLUS_HYBRID_RECEIPT_FIELDS].sort();
  if (actualReceiptFields.length !== expectedReceiptFields.length
    || actualReceiptFields.some(
      (field, index) => field !== expectedReceiptFields[index],
    )) return null;
  if (receipt.schema_version !== "pi-deepgoplus-hybrid-candidate-receipt.v1"
    || receipt.provider !== "DeepGOPlus"
    || receipt.source_type !== "deepgoplus_hybrid"
    || receipt.architecture !== "sequence_cnn_plus_diamond"
    || receipt.score_semantics
      !== "raw_stock_final_for_audit_and_unpropagated_agent_direct_for_candidates"
    || receipt.stock_score_semantics
      !== "stock_prop_annotations_diamond_plus_cnn_post_all_relation_ontology"
    || receipt.agent_candidate_score_semantics
      !== "raw_annotations_diamond_plus_cnn_direct_pre_ontology"
    || receipt.homology_component !== "diamond_executed"
    || receipt.ontology_propagation !== "host_safe_closure_from_agent_direct_rows"
    || receipt.query_like_policy
      !== "quarantine_all_rows_for_exact_training_sequence_case") return null;
  for (const field of [
    "runner_sha256",
    "model_sha256",
    "terms_sha256",
    "ontology_sha256",
    "annotations_sha256",
    "diamond_database_sha256",
    "training_fasta_sha256",
    "metadata_sha256",
    "diamond_executable_sha256",
    "python_executable_sha256",
    "method_hash",
    "request_sha256",
    "prediction_set_hash",
    "base_frozen_evidence_set_hash",
    "agent_direct_candidate_set_hash",
    "canonical_hash",
  ]) {
    if (!SHA256.test(String(receipt[field] ?? ""))) return null;
  }
  for (const field of [
    "tensorflow_version",
    "numpy_version",
    "pandas_version",
  ]) {
    if (typeof receipt[field] !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_.+@-]{0,127}$/.test(receipt[field])) {
      return null;
    }
  }
  if (!Number.isSafeInteger(receipt.diamond_hit_count)
    || Number(receipt.diamond_hit_count) < 0
    || !Number.isSafeInteger(receipt.exact_training_sequence_match_count)
    || Number(receipt.exact_training_sequence_match_count) < 0
    || !Number.isSafeInteger(receipt.near_exact_training_sequence_match_count)
    || Number(receipt.near_exact_training_sequence_match_count) < 0
    || !Number.isSafeInteger(receipt.agent_direct_candidate_count)
    || Number(receipt.agent_direct_candidate_count) < 0
    || typeof receipt.agent_direct_candidate_floor !== "number"
    || !Number.isFinite(receipt.agent_direct_candidate_floor)
    || Number(receipt.agent_direct_candidate_floor) < 0
    || Number(receipt.agent_direct_candidate_floor) > 1
    || !Array.isArray(receipt.top_diamond_donors)
    || receipt.top_diamond_donors.length > 20) return null;
  const donorSubjects = new Set<string>();
  for (const rawDonor of receipt.top_diamond_donors) {
    const donor = record(rawDonor);
    if (!donor
      || Object.keys(donor).sort().join("\0") !== [
        "accession",
        "alignmentLength",
        "bitScore",
        "nearExact",
        "percentIdentity",
        "queryCoverage",
        "queryLength",
        "subjectCoverage",
        "subjectId",
        "subjectLength",
        "taxonId",
      ].sort().join("\0")
      || typeof donor.subjectId !== "string"
      || donor.subjectId.trim() === ""
      || donorSubjects.has(donor.subjectId)
      || (donor.accession !== null
        && (typeof donor.accession !== "string" || donor.accession.trim() === ""))
      || (donor.taxonId !== null
        && (typeof donor.taxonId !== "string" || !/^[1-9]\d*$/.test(donor.taxonId)))
      || typeof donor.nearExact !== "boolean") return null;
    for (const field of [
      "bitScore",
      "percentIdentity",
      "alignmentLength",
      "queryLength",
      "subjectLength",
      "queryCoverage",
      "subjectCoverage",
    ]) {
      const number = donor[field];
      if (typeof number !== "number" || !Number.isFinite(number) || number < 0) {
        return null;
      }
    }
    if (Number(donor.percentIdentity) > 100
      || Number(donor.queryCoverage) > 1
      || Number(donor.subjectCoverage) > 1
      || !Number.isSafeInteger(donor.alignmentLength)
      || !Number.isSafeInteger(donor.queryLength)
      || !Number.isSafeInteger(donor.subjectLength)
      || Number(donor.alignmentLength) < 1
      || Number(donor.queryLength) < 1
      || Number(donor.subjectLength) < 1) return null;
    const expectedNearExact = Number(donor.percentIdentity) >= 99
      && Number(donor.queryCoverage) >= 0.95
      && Number(donor.subjectCoverage) >= 0.95;
    if (donor.nearExact !== expectedNearExact) return null;
    donorSubjects.add(donor.subjectId);
  }
  const { canonical_hash: canonicalHash, ...receiptContent } = receipt;
  if (canonicalHash !== hashCanonical(receiptContent)) return null;

  const release =
    `${String(receipt.package_version)};data-${String(receipt.data_release)}`;
  const completedProviders = providers.filter(
    (provider) => provider.provider === "DeepGOPlus"
      && provider.status === "completed",
  );
  if (completedProviders.length !== 1) return null;
  const provider = completedProviders[0];
  if (provider.release !== release
    || provider.request_sha256 !== receipt.request_sha256
    || provider.payload_sha256 !== receipt.prediction_set_hash
    || provider.endpoint_or_path
      !== `local:hybrid-bound:${String(receipt.prediction_set_hash).slice(0, 16)}`) {
    return null;
  }

  const candidates = Array.isArray(candidateSources.go_candidates)
    ? candidateSources.go_candidates.map(record)
    : [];
  if (candidates.some((candidate) => candidate === undefined)) return null;
  const candidateRows = candidates.filter(
    (candidate): candidate is Record<string, unknown> => candidate !== undefined,
  );
  const deepRows = candidateRows.filter(
    (candidate) =>
      candidate.source_type === "deepgoplus_hybrid"
      || candidate.provider === "DeepGOPlus",
  );
  const protein = record(bundle.protein);
  const sequenceSha256 = String(protein?.sequence_sha256 ?? "");
  if (!SHA256.test(sequenceSha256)) return null;
  const expectedRoot =
    `deepgoplus-hybrid:${sha256Text(`${String(receipt.method_hash)}\0${sequenceSha256}`)}`;
  const expectedQueryLike =
    Number(receipt.exact_training_sequence_match_count) > 0;
  const seenGoIds = new Set<string>();
  const seenEvidenceIds = new Set<string>();
  for (const candidate of deepRows) {
    const goId = String(candidate.go_id ?? "");
    const score = candidate.base_score;
    const evidenceId = String(candidate.evidence_id ?? "");
    if (candidate.source_type !== "deepgoplus_hybrid"
      || candidate.provider !== "DeepGOPlus"
      || candidate.provider_release !== release
      || candidate.provider_payload_sha256 !== receipt.prediction_set_hash
      || candidate.source_id
        !== `deepgoplus_hybrid:${String(receipt.method_hash).slice(0, 16)}`
      || candidate.mapping_id !== `deepgoplus_hybrid:${goId}`
      || candidate.provenance_root !== expectedRoot
      || candidate.annotation_evidence_code !== "MODEL_HOMOLOGY"
      || candidate.query_like !== expectedQueryLike
      || candidate.donor_accession !== null
      || candidate.phylogeny !== null
      || !GO_ID.test(goId)
      || String(candidate.term_name ?? "").trim() === ""
      || !["molecular_function", "biological_process", "cellular_component"]
        .includes(String(candidate.aspect ?? ""))
      || typeof score !== "number"
      || !Number.isFinite(score)
      || score <= Number(receipt.agent_direct_candidate_floor)
      || score > 1
      || seenGoIds.has(goId)
      || seenEvidenceIds.has(evidenceId)) return null;
    const token = sha256Text(`${expectedRoot}\0${goId}\0${score}`);
    if (evidenceId !== `CAND-DGPH-${token.slice(0, 20).toUpperCase()}`) {
      return null;
    }
    seenGoIds.add(goId);
    seenEvidenceIds.add(evidenceId);
  }
  if (deepRows.length !== Number(receipt.agent_direct_candidate_count)) return null;
  const candidateProjection = deepRows.map((candidate) => ({
    go_id: candidate.go_id,
    term_name: String(candidate.term_name).trim(),
    aspect: candidate.aspect,
    base_score: candidate.base_score,
    query_like: candidate.query_like,
    evidence_id: candidate.evidence_id,
    provenance_root: candidate.provenance_root,
  }));
  if (hashCanonical(candidateProjection)
    !== receipt.agent_direct_candidate_set_hash) return null;
  const caseId = `DGPH_${sequenceSha256.slice(0, 16).toUpperCase()}`;
  if (receipt.request_sha256 !== hashCanonical({
    schemaVersion: "pi-deepgoplus-hybrid-run-request.v1",
    methodHash: receipt.method_hash,
    cases: [{ caseId, sequenceSha256 }],
  })) return null;

  if (!Array.isArray(bundle.evidence_ids)) return null;
  const allCandidateIds = new Set<string>();
  for (const candidate of candidateRows) {
    const evidenceId = String(candidate.evidence_id ?? "");
    if (!evidenceId) return null;
    allCandidateIds.add(evidenceId);
    const phylogeny = record(candidate.phylogeny);
    const phylogenyEvidenceId = String(phylogeny?.evidence_id ?? "");
    if (phylogenyEvidenceId) allCandidateIds.add(phylogenyEvidenceId);
  }
  const evidenceIds = bundle.evidence_ids.map(String);
  if ([...allCandidateIds].some(
    (evidenceId) => !evidenceIds.includes(evidenceId),
  )) return null;
  const { candidate_sources: _candidateSources, ...baseWithoutCandidates } = bundle;
  const reconstructedBase = {
    ...baseWithoutCandidates,
    evidence_ids: evidenceIds.filter(
      (evidenceId) => !allCandidateIds.has(evidenceId),
    ),
  };
  if (hashCanonical(reconstructedBase)
    !== receipt.base_frozen_evidence_set_hash) return null;

  return {
    provider: "DeepGOPlus",
    sourceType: "deepgoplus_hybrid",
    overlayHash: String(receipt.canonical_hash),
    methodHash: String(receipt.method_hash),
    predictionSetHash: String(receipt.prediction_set_hash),
    baseFrozenEvidenceSetHash: String(receipt.base_frozen_evidence_set_hash),
  };
}

/**
 * Recover the receipt identity persisted in a completed evidence bundle.
 *
 * Strict run validation does not have the original cohort overlay document,
 * and must not require it just to inspect historical artifacts. The merge
 * boundary therefore persists the four canonical hashes plus a completed
 * mDeepFRI provider record. GCN overlays additionally persist the exact
 * structure hash, which distinguishes their binding from the CNN form.
 *
 * Missing or malformed provenance returns null and is handled by the shared
 * completeness assertion. It never manufactures a binding from candidate
 * rows alone.
 */
export function learnedPredictorBindingFromEvidenceBundle(
  bundle: Record<string, unknown>,
): LearnedPredictorBinding | null {
  const candidateSources = record(bundle.candidate_sources);
  if (!candidateSources) return null;
  const providers = Array.isArray(candidateSources.providers)
    ? candidateSources.providers.map(record).filter((item): item is Record<string, unknown> => item !== undefined)
    : [];
  const deepGoReceipt = record(candidateSources.deepgoplus_receipt);
  if (deepGoReceipt) {
    return deepGoReceipt.source_type === "deepgoplus_hybrid"
      ? deepGoPlusHybridBinding(
        bundle,
        candidateSources,
        providers,
        deepGoReceipt,
      )
      : deepGoPlusBinding(bundle, candidateSources, providers, deepGoReceipt);
  }
  const overlay = record(candidateSources.external_predictor_overlay);
  if (!overlay) return null;
  const learnedProviders = providers.filter(
    (provider) => provider.provider === "mDeepFRI" && provider.status === "completed",
  );
  if (learnedProviders.length !== 1) return null;
  return {
    provider: "mDeepFRI",
    sourceType: Object.hasOwn(overlay, "structure_sha256")
      ? "mdeepfri_gcn"
      : "mdeepfri_cnn",
    overlayHash: String(overlay.overlay_hash ?? ""),
    methodHash: String(overlay.method_hash ?? ""),
    predictionSetHash: String(overlay.prediction_set_hash ?? ""),
    baseFrozenEvidenceSetHash: String(overlay.base_frozen_evidence_set_hash ?? ""),
  };
}

/**
 * Fail closed when a deployable genome enables a learned phenotype but the
 * execution boundary cannot prove that the matching hash-bound predictor is
 * present. A missing or incompatible binding must never become a donor-only
 * prediction that merely looks like the learned genome ran successfully.
 *
 * Disabled and legacy genomes intentionally remain unchanged. A caller may
 * also carry an unused overlay alongside such a genome; this contract only
 * governs phenotypes that explicitly enable the learned candidate channel.
 */
export function assertLearnedPredictorCompleteness(input: {
  genome: Pick<AgentGenome, "genomeId" | "goPolicy">;
  binding?: LearnedPredictorBinding | null;
  boundary: LearnedPredictorExecutionBoundary;
}): void {
  const policy = input.genome.goPolicy.learnedPredictorPolicy;
  if (!policy || policy.mode === "disabled") return;

  const requiredSource = policy.allowedSources[0];
  const expectedProvider = requiredSource === "deepgoplus_cnn"
    || requiredSource === "deepgoplus_hybrid"
    ? "DeepGOPlus"
    : "mDeepFRI";
  const prefix = `Learned predictor completeness violation in ${input.boundary} for genome ${input.genome.genomeId}:`;
  if (!input.binding) {
    throw new Error(
      `${prefix} ${requiredSource} is enabled, but no hash-bound ${expectedProvider} predictor binding was supplied; refusing silent donor-only fallback.`,
    );
  }
  if (input.binding.provider !== expectedProvider) {
    throw new Error(
      `${prefix} expected provider ${expectedProvider}, received ${input.binding.provider}; refusing predictor substitution.`,
    );
  }
  if (input.binding.sourceType !== requiredSource) {
    throw new Error(
      `${prefix} policy requires ${requiredSource}, but the supplied binding is ${input.binding.sourceType}; refusing architecture fallback.`,
    );
  }
  if (policy.expectedMethodHash !== undefined
    && input.binding.methodHash !== policy.expectedMethodHash) {
    throw new Error(
      `${prefix} policy requires method ${policy.expectedMethodHash}, but the supplied binding is ${input.binding.methodHash}; refusing model substitution.`,
    );
  }
  for (const [field, value] of Object.entries({
    overlayHash: input.binding.overlayHash,
    methodHash: input.binding.methodHash,
    predictionSetHash: input.binding.predictionSetHash,
    baseFrozenEvidenceSetHash: input.binding.baseFrozenEvidenceSetHash,
  })) {
    if (!SHA256.test(value)) {
      throw new Error(`${prefix} ${field} is not a canonical SHA-256 binding.`);
    }
  }
}
