import { readFile } from "node:fs/promises";

import { hashCanonical } from "./hash.js";
import type { AgentGenome, GenomeSnapshot } from "./types.js";

export const IMMUTABLE_SCIENTIFIC_CONTRACT = {
  version: "pi-function-immutable-contract.v1",
  rules: [
    "GO identifiers, numeric factors, provenance, hard gates, and final score application are produced only by deterministic host code; an optional bounded inner agent may emit categorical verdicts over opaque allowlisted candidates.",
    "The narrative model cannot execute evidence tools or mutate evidence and GO artifacts.",
    "Only explicitly declared query-like annotations are quarantined before GO scoring and narrative inference; similarity and coverage alone never infer query identity.",
    "Scores are uncalibrated heuristics until an external frozen evaluator fits calibration.",
    "Self-evolution requires external biological feedback, held-out promotion, lineage, and rollback.",
  ],
} as const;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label} has unsupported fields: ${unexpected.join(", ")}`);
}

function unit(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${label} must be within [0,1]`);
  return parsed;
}

export function validateGenome(value: unknown): AgentGenome {
  const root = object(value, "genome");
  onlyKeys(root, ["schemaVersion", "genomeId", "parentGenomeId", "generation", "evidencePolicy", "goPolicy", "narrativePolicy", "improvementPolicy", "claimBoundary"], "genome");
  if (root.schemaVersion !== "pi-agent-genome.v1") throw new Error("Unsupported genome schemaVersion");
  if (typeof root.genomeId !== "string" || !root.genomeId) throw new Error("genomeId is required");
  if (root.parentGenomeId !== null && typeof root.parentGenomeId !== "string") throw new Error("parentGenomeId must be a string or null");
  if (!Number.isInteger(root.generation) || Number(root.generation) < 0) throw new Error("generation must be a non-negative integer");
  const evidence = object(root.evidencePolicy, "evidencePolicy");
  onlyKeys(evidence, ["mode", "requiredInputs"], "evidencePolicy");
  if (evidence.mode !== "fixed_full_pipeline") throw new Error("MVP genome must use fixed_full_pipeline");
  if (!Array.isArray(evidence.requiredInputs) || evidence.requiredInputs.length < 1 || evidence.requiredInputs.some((item) => typeof item !== "string")) {
    throw new Error("evidencePolicy.requiredInputs must name the required inputs");
  }
  const go = object(root.goPolicy, "goPolicy");
  onlyKeys(go, ["methodId", "evidenceWeights", "unknownEvidenceWeight", "lineageFloor", "lineageRange", "domainStructurePenalty", "globalStructureCoverageFloor", "minimumDonorGroupSupport", "minimumIndependentProvenanceRoots", "thresholds", "maxSelectedTermsPerAspect", "requireTwoStructureDonorGroups", "sequenceEligibilityMode", "selectionPolicy", "ontologyPolicy", "candidateSourcePolicy", "learnedPredictorPolicy", "phylogenyPolicy", "goJudgePolicy", "scoreFusionPolicy"], "goPolicy");
  if (typeof go.methodId !== "string" || !go.methodId) throw new Error("goPolicy.methodId is required");
  const weights = object(go.evidenceWeights, "goPolicy.evidenceWeights");
  if (Object.keys(weights).length === 0) throw new Error("goPolicy.evidenceWeights cannot be empty");
  for (const [code, weight] of Object.entries(weights)) unit(weight, `evidence weight ${code}`);
  unit(go.unknownEvidenceWeight, "unknownEvidenceWeight");
  const lineageFloor = unit(go.lineageFloor, "lineageFloor");
  const lineageRange = unit(go.lineageRange, "lineageRange");
  if (lineageFloor + lineageRange > 1) throw new Error("lineageFloor + lineageRange cannot exceed 1");
  unit(go.domainStructurePenalty, "domainStructurePenalty");
  unit(go.globalStructureCoverageFloor, "globalStructureCoverageFloor");
  unit(go.minimumDonorGroupSupport, "minimumDonorGroupSupport");
  if (!Number.isInteger(go.minimumIndependentProvenanceRoots) || Number(go.minimumIndependentProvenanceRoots) < 1) throw new Error("minimumIndependentProvenanceRoots must be a positive integer");
  const thresholds = object(go.thresholds, "goPolicy.thresholds");
  for (const aspect of ["molecular_function", "biological_process", "cellular_component"]) {
    const threshold = Number(thresholds[aspect]);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error(`Invalid GO threshold: ${aspect}`);
  }
  if (!Number.isInteger(go.maxSelectedTermsPerAspect) || Number(go.maxSelectedTermsPerAspect) < 1 || Number(go.maxSelectedTermsPerAspect) > 100) {
    throw new Error("maxSelectedTermsPerAspect must be an integer from 1 to 100");
  }
  if (go.requireTwoStructureDonorGroups !== true) throw new Error("bootstrap-v0 must require two structure donor groups");
  if (go.sequenceEligibilityMode !== undefined
    && go.sequenceEligibilityMode !== "primary_only"
    && go.sequenceEligibilityMode !== "retained_sequence") {
    throw new Error("sequenceEligibilityMode must be primary_only or retained_sequence");
  }
  if (go.selectionPolicy !== undefined) {
    const selection = object(go.selectionPolicy, "goPolicy.selectionPolicy");
    onlyKeys(selection, ["mode", "aspects"], "goPolicy.selectionPolicy");
    if (selection.mode !== "disabled" && selection.mode !== "evidence_frontier_v1") {
      throw new Error("selectionPolicy.mode must be disabled or evidence_frontier_v1");
    }
    if (selection.aspects !== undefined) {
      if (selection.mode !== "evidence_frontier_v1"
        || !Array.isArray(selection.aspects)
        || selection.aspects.length < 1
        || new Set(selection.aspects).size !== selection.aspects.length
        || selection.aspects.some((aspect) => !["molecular_function", "biological_process", "cellular_component"].includes(String(aspect)))) {
        throw new Error("selectionPolicy.aspects must be a non-empty unique GO-aspect list for evidence_frontier_v1");
      }
    }
  }
  if (go.ontologyPolicy !== undefined) {
    const ontology = object(go.ontologyPolicy, "goPolicy.ontologyPolicy");
    onlyKeys(ontology, ["mode", "maxDepth", "scoreDecay", "excludeRoots", "relations"], "goPolicy.ontologyPolicy");
    if (ontology.mode !== "disabled" && ontology.mode !== "ancestor_closure") {
      throw new Error("ontologyPolicy.mode must be disabled or ancestor_closure");
    }
    if (!Number.isInteger(ontology.maxDepth) || Number(ontology.maxDepth) < 1 || Number(ontology.maxDepth) > 32) {
      throw new Error("ontologyPolicy.maxDepth must be an integer from 1 to 32");
    }
    unit(ontology.scoreDecay, "ontologyPolicy.scoreDecay");
    if (ontology.excludeRoots !== true) throw new Error("ontologyPolicy.excludeRoots must remain true");
    if (!Array.isArray(ontology.relations)
      || ontology.relations.length !== 2
      || ontology.relations[0] !== "is_a"
      || ontology.relations[1] !== "part_of") {
      throw new Error("ontologyPolicy.relations must be exactly [is_a, part_of]");
    }
  }
  if (go.candidateSourcePolicy !== undefined) {
    const candidate = object(go.candidateSourcePolicy, "goPolicy.candidateSourcePolicy");
    onlyKeys(candidate, ["mode", "allowedAspects", "minimumBaseScore", "minimumQueryCoverage", "minimumEvidenceWeight", "requireIndependentRoots", "allowedSources"], "goPolicy.candidateSourcePolicy");
    if (candidate.mode !== "disabled" && candidate.mode !== "storage_light") {
      throw new Error("candidateSourcePolicy.mode must be disabled or storage_light");
    }
    unit(candidate.minimumBaseScore, "candidateSourcePolicy.minimumBaseScore");
    unit(candidate.minimumQueryCoverage, "candidateSourcePolicy.minimumQueryCoverage");
    if (candidate.minimumEvidenceWeight !== undefined) unit(candidate.minimumEvidenceWeight, "candidateSourcePolicy.minimumEvidenceWeight");
    if (candidate.allowedAspects !== undefined) {
      const canonicalAspects = ["molecular_function", "biological_process", "cellular_component"];
      const allowedAspects = candidate.allowedAspects;
      if (candidate.mode !== "storage_light"
        || !Array.isArray(allowedAspects)
        || allowedAspects.length < 1
        || new Set(allowedAspects).size !== allowedAspects.length
        || allowedAspects.some((aspect) => !canonicalAspects.includes(String(aspect)))
        || JSON.stringify(allowedAspects) !== JSON.stringify(
          canonicalAspects.filter((aspect) => allowedAspects.includes(aspect)),
        )) {
        throw new Error("candidateSourcePolicy.allowedAspects must be a non-empty canonical GO-aspect list for storage_light");
      }
    }
    if (!Number.isInteger(candidate.requireIndependentRoots) || Number(candidate.requireIndependentRoots) < 1 || Number(candidate.requireIndependentRoots) > 3) {
      throw new Error("candidateSourcePolicy.requireIndependentRoots must be an integer from 1 to 3");
    }
    const legacySources = ["interpro", "pfam", "panther", "ec", "oma_ortholog"];
    const expandedSources = [...legacySources, "oma_fastmap"];
    const strictTemporalSources = ["pfam", "panther", "ec", "oma_ortholog", "oma_fastmap"];
    const codebase1Sources = ["biolm_retrieval"];
    const codebase2Sources = ["interpro", "pfam", "panther", "ec"];
    const allowedSources = candidate.allowedSources;
    const canonical = (expected: string[]) => Array.isArray(allowedSources)
      && allowedSources.length === expected.length
      && allowedSources.every((item, index) => item === expected[index]);
    if (!canonical(codebase1Sources) && !canonical(codebase2Sources) && !canonical(legacySources) && !canonical(expandedSources) && !canonical(strictTemporalSources)) {
      throw new Error("candidateSourcePolicy.allowedSources must be a canonical CodeBase1 BioLM or legacy source list");
    }
  }
  if (go.learnedPredictorPolicy !== undefined) {
    const learned = object(go.learnedPredictorPolicy, "goPolicy.learnedPredictorPolicy");
    onlyKeys(learned, ["mode", "allowedSources", "expectedMethodHash", "allowedAspects", "activationMode", "maxCandidatesPerAspect", "minimumScore", "scoreScale", "requireIndependentRoots"], "goPolicy.learnedPredictorPolicy");
    if (learned.mode !== "disabled" && learned.mode !== "candidate_channel") {
      throw new Error("learnedPredictorPolicy.mode must be disabled or candidate_channel");
    }
    if (!Array.isArray(learned.allowedSources)
      || learned.allowedSources.length !== 1
      || !["mdeepfri_cnn", "mdeepfri_gcn", "deepgoplus_cnn", "deepgoplus_hybrid"].includes(String(learned.allowedSources[0]))) {
      throw new Error("learnedPredictorPolicy.allowedSources must select exactly one supported learned predictor");
    }
    if (learned.expectedMethodHash !== undefined
      && (typeof learned.expectedMethodHash !== "string"
        || !/^[a-f0-9]{64}$/.test(learned.expectedMethodHash))) {
      throw new Error("learnedPredictorPolicy.expectedMethodHash must be a canonical SHA-256 digest");
    }
    if (learned.activationMode !== undefined
      && learned.activationMode !== "always"
      && learned.activationMode !== "direct_annotation_gap_only"
      && learned.activationMode !== "prediction_aspect_gap_only"
      && learned.activationMode !== "host_term_agreement_only") {
      throw new Error("learnedPredictorPolicy.activationMode must be always, direct_annotation_gap_only, prediction_aspect_gap_only, or host_term_agreement_only");
    }
    if (learned.maxCandidatesPerAspect !== undefined
      && (!Number.isInteger(learned.maxCandidatesPerAspect)
        || Number(learned.maxCandidatesPerAspect) < 1
        || Number(learned.maxCandidatesPerAspect) > 512)) {
      throw new Error("learnedPredictorPolicy.maxCandidatesPerAspect must be an integer from 1 to 512");
    }
    const canonicalAspects = ["molecular_function", "biological_process", "cellular_component"];
    const allowedAspects = learned.allowedAspects;
    if (!Array.isArray(allowedAspects)
      || allowedAspects.length < 1
      || new Set(allowedAspects).size !== allowedAspects.length
      || allowedAspects.some((aspect) => !canonicalAspects.includes(String(aspect)))
      || JSON.stringify(allowedAspects) !== JSON.stringify(
        canonicalAspects.filter((aspect) => allowedAspects.includes(aspect)),
      )) {
      throw new Error("learnedPredictorPolicy.allowedAspects must be a non-empty canonical GO-aspect list");
    }
    if (learned.activationMode === "host_term_agreement_only"
      && JSON.stringify(allowedAspects) !== JSON.stringify(["molecular_function"])) {
      throw new Error("learnedPredictorPolicy.host_term_agreement_only is restricted to molecular_function");
    }
    unit(learned.minimumScore, "learnedPredictorPolicy.minimumScore");
    unit(learned.scoreScale, "learnedPredictorPolicy.scoreScale");
    if (learned.requireIndependentRoots !== 1) {
      throw new Error("learnedPredictorPolicy.requireIndependentRoots must remain 1 because one model/query is one provenance root");
    }
  }
  if (go.phylogenyPolicy !== undefined) {
    const phylogeny = object(go.phylogenyPolicy, "goPolicy.phylogenyPolicy");
    onlyKeys(phylogeny, ["mode", "relationWeights", "aspectDistanceDecay", "lineageFloor", "lineageRange", "paralogLeafTransferAllowed", "cladeCollapseDepth"], "goPolicy.phylogenyPolicy");
    if (phylogeny.mode !== "disabled" && phylogeny.mode !== "orthology_aware") {
      throw new Error("phylogenyPolicy.mode must be disabled or orthology_aware");
    }
    const relationWeights = object(phylogeny.relationWeights, "goPolicy.phylogenyPolicy.relationWeights");
    const relations = ["one_to_one", "one_to_many", "many_to_one", "many_to_many", "coortholog", "unresolved_ortholog", "post_duplication_paralog"];
    onlyKeys(relationWeights, relations, "goPolicy.phylogenyPolicy.relationWeights");
    for (const relation of relations) unit(relationWeights[relation], `phylogenyPolicy.relationWeights.${relation}`);
    const distanceDecay = object(phylogeny.aspectDistanceDecay, "goPolicy.phylogenyPolicy.aspectDistanceDecay");
    const aspects = ["molecular_function", "biological_process", "cellular_component"];
    onlyKeys(distanceDecay, aspects, "goPolicy.phylogenyPolicy.aspectDistanceDecay");
    for (const aspect of aspects) unit(distanceDecay[aspect], `phylogenyPolicy.aspectDistanceDecay.${aspect}`);
    const phylogenyFloor = unit(phylogeny.lineageFloor, "phylogenyPolicy.lineageFloor");
    const phylogenyRange = unit(phylogeny.lineageRange, "phylogenyPolicy.lineageRange");
    if (phylogenyFloor + phylogenyRange > 1) throw new Error("phylogenyPolicy lineageFloor + lineageRange cannot exceed 1");
    if (phylogeny.paralogLeafTransferAllowed !== false) throw new Error("phylogenyPolicy.paralogLeafTransferAllowed must remain false");
    if (!Number.isInteger(phylogeny.cladeCollapseDepth) || Number(phylogeny.cladeCollapseDepth) < 1 || Number(phylogeny.cladeCollapseDepth) > 32) {
      throw new Error("phylogenyPolicy.cladeCollapseDepth must be an integer from 1 to 32");
    }
  }
  if (go.goJudgePolicy !== undefined) {
    const judge = object(go.goJudgePolicy, "goPolicy.goJudgePolicy");
    onlyKeys(judge, ["mode", "executionMode", "candidateBudgetMode", "candidateRetentionMode", "maxCandidates", "maxDonorContexts", "modelProvider", "modelId", "thinkingLevel"], "goPolicy.goJudgePolicy");
    if (judge.mode !== "disabled" && judge.mode !== "evidence_consistency" && judge.mode !== "semantic_reasoning") {
      throw new Error("goJudgePolicy.mode must be disabled, evidence_consistency, or semantic_reasoning");
    }
    if (judge.executionMode !== undefined && judge.executionMode !== "deterministic" && judge.executionMode !== "pi") {
      throw new Error("goJudgePolicy.executionMode must be deterministic or pi");
    }
    if (judge.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(judge.thinkingLevel))) {
      throw new Error("goJudgePolicy.thinkingLevel is invalid");
    }
    if (judge.candidateBudgetMode !== undefined
      && judge.candidateBudgetMode !== "global_ranked_v1"
      && judge.candidateBudgetMode !== "aspect_stratified_v1") {
      throw new Error("goJudgePolicy.candidateBudgetMode must be global_ranked_v1 or aspect_stratified_v1");
    }
    if (judge.candidateRetentionMode !== undefined
      && judge.candidateRetentionMode !== "fail_closed_v1"
      && judge.candidateRetentionMode !== "preserve_ranked_evidence_v1") {
      throw new Error("goJudgePolicy.candidateRetentionMode must be fail_closed_v1 or preserve_ranked_evidence_v1");
    }
    if (!Number.isInteger(judge.maxCandidates) || Number(judge.maxCandidates) < 1 || Number(judge.maxCandidates) > 128) {
      throw new Error("goJudgePolicy.maxCandidates must be an integer from 1 to 128");
    }
    if (judge.maxDonorContexts !== undefined
      && (!Number.isInteger(judge.maxDonorContexts) || Number(judge.maxDonorContexts) < 0 || Number(judge.maxDonorContexts) > 48)) {
      throw new Error("goJudgePolicy.maxDonorContexts must be an integer from 0 to 48 when specified");
    }
    if (judge.mode === "semantic_reasoning") {
      if (!Number.isInteger(judge.maxDonorContexts) || Number(judge.maxDonorContexts) < 1) throw new Error("semantic_reasoning requires at least one donor context");
      if (judge.executionMode !== "pi") throw new Error("semantic_reasoning requires goJudgePolicy.executionMode=pi");
      if (judge.modelProvider !== "openai-codex" || judge.modelId !== "gpt-5.6-sol" || judge.thinkingLevel !== "high") {
        throw new Error("semantic_reasoning is pinned to the openai-codex/gpt-5.6-sol high model contract");
      }
      if (judge.candidateBudgetMode !== undefined || judge.candidateRetentionMode !== undefined) {
        throw new Error("semantic_reasoning does not accept evidence-consistency budget/retention options");
      }
      const fusion = object(go.scoreFusionPolicy, "goPolicy.scoreFusionPolicy");
      if (fusion.mode !== "disabled") throw new Error("semantic_reasoning requires post-judge score fusion to remain disabled");
    }
  }
  if (go.scoreFusionPolicy !== undefined) {
    const fusion = object(go.scoreFusionPolicy, "goPolicy.scoreFusionPolicy");
    onlyKeys(fusion, ["mode", "anchorWeights"], "goPolicy.scoreFusionPolicy");
    if (fusion.mode !== "disabled" && fusion.mode !== "deepgoplus_anchor_v1") {
      throw new Error("scoreFusionPolicy.mode must be disabled or deepgoplus_anchor_v1");
    }
    const weights = object(fusion.anchorWeights, "goPolicy.scoreFusionPolicy.anchorWeights");
    onlyKeys(weights, ["molecular_function", "biological_process", "cellular_component"], "goPolicy.scoreFusionPolicy.anchorWeights");
    for (const [aspect, value] of Object.entries(weights)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1.5) {
        throw new Error(`scoreFusionPolicy anchor weight must be in [0,1.5]: ${aspect}`);
      }
    }
  }
  const narrative = object(root.narrativePolicy, "narrativePolicy");
  onlyKeys(narrative, ["defaultMode", "maxRevisionCycles"], "narrativePolicy");
  if (!(["pi", "deterministic"] as unknown[]).includes(narrative.defaultMode)) throw new Error("Invalid default narrative mode");
  if (!Number.isInteger(narrative.maxRevisionCycles) || Number(narrative.maxRevisionCycles) < 0 || Number(narrative.maxRevisionCycles) > 5) {
    throw new Error("maxRevisionCycles must be an integer from 0 to 5");
  }
  const improvement = object(root.improvementPolicy, "improvementPolicy");
  onlyKeys(improvement, ["enabled", "externalFeedbackRequired", "promotionEvaluator"], "improvementPolicy");
  if (improvement.enabled !== false || improvement.externalFeedbackRequired !== true) {
    throw new Error("MVP improvement policy must remain disabled and require external feedback");
  }
  if (typeof root.claimBoundary !== "string" || !root.claimBoundary) throw new Error("claimBoundary is required");
  return value as AgentGenome;
}

/**
 * Accept the deployable genome documents produced by both supported paths:
 *
 * - committed `genomes/*.json` files contain a raw AgentGenome; and
 * - the outer RSI harness writes a hash-bound GenomeSnapshot wrapper.
 *
 * Snapshot support must not weaken the contract.  In particular, do not
 * unwrap first and silently ignore stale/tampered wrapper hashes: validate the
 * complete wrapper and both of its bindings before returning it.
 */
export function validateGenomeDocument(value: unknown): GenomeSnapshot {
  const root = object(value, "genome document");
  if (root.schemaVersion === "pi-agent-genome-snapshot.v1") {
    onlyKeys(root, ["schemaVersion", "genome", "genomeHash", "immutableContractHash"], "genome snapshot");
    const genome = validateGenome(root.genome);
    const genomeHash = hashCanonical(genome);
    if (root.genomeHash !== genomeHash) throw new Error("Genome snapshot genomeHash mismatch");
    const immutableContractHash = hashCanonical(IMMUTABLE_SCIENTIFIC_CONTRACT);
    if (root.immutableContractHash !== immutableContractHash) {
      throw new Error("Genome snapshot immutableContractHash mismatch");
    }
    return {
      schemaVersion: "pi-agent-genome-snapshot.v1",
      genome,
      genomeHash,
      immutableContractHash,
    };
  }

  const genome = validateGenome(root);
  return {
    schemaVersion: "pi-agent-genome-snapshot.v1",
    genome,
    genomeHash: hashCanonical(genome),
    immutableContractHash: hashCanonical(IMMUTABLE_SCIENTIFIC_CONTRACT),
  };
}

export async function loadGenome(path: string): Promise<GenomeSnapshot> {
  return validateGenomeDocument(JSON.parse(await readFile(path, "utf8")) as unknown);
}
