export type ConfidenceLabel = "high" | "medium" | "low" | "insufficient";

export interface KeyEvidence {
  evidenceId: string;
  supports: string;
}

export interface AlternativeFunction {
  function: string;
  rationale: string;
  evidenceIds: string[];
}

export interface FunctionPrediction {
  proteinId: string;
  mostLikelyFunction: string;
  functionalDescription: string;
  confidence: ConfidenceLabel;
  confidenceRationale: string;
  keyEvidence: KeyEvidence[];
  alternatives: AlternativeFunction[];
  conflictingEvidence: string[];
  limitations: string[];
  recommendedExperiments: string[];
}

export interface CriticReview {
  approved: boolean;
  summary: string;
  unsupportedClaims: string[];
  citationIssues: string[];
  doubleCountingRisks: string[];
  requiredRevisions: string[];
}

export interface AgentAudit {
  role: "synthesizer" | "critic";
  modelProvider: string;
  modelId: string;
  thinkingLevel: string;
  sessionFile?: string;
  stats: {
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
  };
}

export interface AgentResult<T> {
  value: T;
  audit: AgentAudit;
}

export type GOAspect = "molecular_function" | "biological_process" | "cellular_component" | "unknown";
export type GOTermDecision = "transfer_hypothesis" | "abstained";
export type NarrativeMode = "pi" | "deterministic";
export type TargetMode = "anonymous" | "named_uncharacterized";
export type TargetTaxonProvenance = "provided" | "unavailable";
export type PhylogenyMode = "optional" | "required";
export type PhylogenyRequestStatus = "requested" | "unavailable_missing_taxon";

/**
 * Identity-safe biological context declared by the caller. A TaxID is useful
 * for lineage/phylogeny-aware reasoning, but it never reveals or authorizes
 * use of a protein accession, name, or pre-existing target annotation.
 */
export interface TargetContext {
  taxon: {
    taxonId: number | null;
    provenance: TargetTaxonProvenance;
  };
  phylogeny: {
    mode: PhylogenyMode;
    status: PhylogenyRequestStatus;
  };
}

export interface GODonorSupport {
  accession: string;
  donorGroup: string;
  proteinName: string;
  organism: string;
  taxonId: number | null;
  annotationEvidenceId: string;
  matchEvidenceIds: string[];
  matchMode: "sequence" | "full_structure" | "local_structure" | "domain_structure" | "domain_mapping" | "sequence_mapping" | "ec_mapping" | "orthology" | "learned_sequence" | "learned_structure";
  /**
   * True when this donor has a retained sequence hit, even if a stronger
   * structure score is the primary matchMode. Optional for v2 artifact
   * compatibility; absent means matchMode === "sequence".
   */
  hasSequence?: boolean;
  /** Similarity contributed by sequence alone when both modalities exist. */
  sequenceSimilarityScore?: number;
  similarityScore: number;
  evidenceCode: string;
  provenanceRoots: string[];
  evidenceWeight: number;
  structureQualityFactor: number;
  lineageFactor: number;
  lineageStatus: "applied" | "unavailable";
  /** Present for direct domain/EC/orthology candidates. */
  candidateSourceType?: "biolm_retrieval" | "interpro" | "pfam" | "panther" | "ec" | "oma_ortholog" | "oma_fastmap" | "mdeepfri_cnn" | "mdeepfri_gcn" | "deepgoplus_cnn" | "deepgoplus_hybrid";
  sourceProvider?: "BioLM" | "InterProScan" | "GOA_mapping" | "OMA" | "mDeepFRI" | "DeepGOPlus";
  /** Raw provider support retained for candidate-pool audit. */
  candidateBaseScore?: number;
  /** Provider-reported query coverage; null means the provider did not expose it. */
  candidateQueryCoverage?: number | null;
  /** Selection gate result. False candidates stay visible as abstentions. */
  candidateSelectionEligible?: boolean;
  orthologyRelation?: "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many" | "coortholog" | "unresolved_ortholog" | "post_duplication_paralog";
  cladeKey?: string;
  leafTransferAllowed?: boolean;
  phylogenyComponents?: {
    relationFactor: number;
    distanceFactor: number;
    lineageFactor: number;
    taxonConstraintFactor: number;
  };
  rawSupport: number;
  adjustedSupport: number;
  /** Present only when a pinned GO DAG projected a donor assertion upward. */
  ontologyDepth?: number;
  /** Canonical donor GO term from which an ancestor candidate was derived. */
  sourceGoId?: string;
}

export interface GOTermPrediction {
  goId: string;
  termName: string;
  aspect: GOAspect;
  decision: GOTermDecision;
  selected: boolean;
  rawScore: number | null;
  phylogenyAdjustedScore: number | null;
  /** Final bounded score after an optional evidence-consistency judgment. */
  judgeAdjustedScore?: number | null;
  /** Exact r08 semantic-reasoner score for a direct candidate or its entailed ancestor. */
  semanticAdjustedScore?: number | null;
  /** Final bounded score after an optional, genome-bound score fusion. */
  fusionAdjustedScore?: number | null;
  /**
   * True when the deterministic evidence/threshold gates admitted this term
   * immediately before the current selection budget was applied.  Entailed
   * ancestors may be selected by the frontier even when their decayed score
   * did not independently clear the threshold.
   */
  preBudgetEligible?: boolean;
  /** Final selector role; ontology closure never masquerades as a primary hypothesis. */
  selectionRole?: "primary_direct" | "entailed_ancestor" | "not_selected";
  /** 1-based deterministic rank in the aspect's budgeted hypothesis list; null for closure-only/ineligible terms. */
  selectionRank?: number | null;
  calibrationStatus: "unavailable";
  confidenceLabel: "low_heuristic" | "abstained";
  evidenceCode: string;
  donorSupports: GODonorSupport[];
  evidenceIds: string[];
  reasons: string[];
  /** Machine-readable host gates; the inner judge cannot override them. */
  selectionBlockers?: Array<
    | "unknown_aspect"
    | "non_mf_structure_only"
    | "insufficient_structure_groups"
    | "insufficient_provenance_roots"
    | "candidate_provider_floor"
    | "candidate_independent_roots"
    | "candidate_term_threshold"
    | "phylogeny_leaf_forbidden"
    | "below_threshold"
    | "per_aspect_budget"
    | "judge_candidate_budget"
    | "source_hypothesis_not_selected"
  >;
  /** Present only for ontology-aware genomes; direct beats ancestor when both occur. */
  candidateOrigin?: "direct_annotation" | "direct_candidate_source" | "ontology_ancestor";
  /** Canonical direct GO assertions that generated this term. */
  sourceGoIds?: string[];
  /** Shortest safe is_a/part_of path from a direct donor assertion. */
  ontologyDepth?: number;
  /** Optional bounded inner-agent consistency judgment over this candidate. */
  agentJudgment?: {
    candidateToken: string;
    verdict: "support" | "uncertain" | "contradict";
    factor: number;
    citedEvidenceIds: string[];
  };
  /** Exact accepted/omitted decision from the r08 semantic reasoning layer. */
  semanticJudgment?: {
    candidateToken: string;
    status: "accepted" | "rejected" | "omitted";
    confidence: "high" | "medium" | "low" | null;
    citedEvidenceIds: string[];
    rationale: string | null;
  };
}

export interface GOPredictionSet {
  schemaVersion: "pi-go-prediction.v3";
  proteinId: string;
  targetMode: TargetMode;
  identityPolicy: "strict_blind_v1" | "temporal_t0_v1";
  queryAccession: string | null;
  queryLikeAccessions: string[];
  explicitlyExcludedAccessions: string[];
  queryTaxonId: number | null;
  queryLineage: string[];
  targetContext: TargetContext;
  genomeId: string;
  genomeHash: string;
  methodId: string;
  methodSummary: string;
  /** Omitted for the legacy fixed-cap selector. */
  selectionPolicyMode?: "evidence_frontier_v1";
  /** Omitted when the frontier applies to every GO aspect. */
  selectionPolicyAspects?: Array<"molecular_function" | "biological_process" | "cellular_component">;
  calibrationStatus: "unavailable";
  dagProjectionStatus: "not_applied" | "ancestor_closure_applied";
  ontologyBinding?: {
    dataVersion: string;
    sourceSha256: string;
    policy: "safe_is_a_part_of_ancestor_closure_v1";
    maxDepth: number;
    scoreDecay: number;
    rootsExcluded: true;
  };
  candidateSources: {
    bundleHash: string;
    providers: Array<{
      provider: "BioLM" | "InterProScan" | "GOA_mapping" | "OMA" | "mDeepFRI" | "DeepGOPlus";
      status: "completed" | "unavailable" | "failed" | "disabled";
      release: string | null;
      payloadSha256: string | null;
      reason: string | null;
    }>;
    candidateCount: number;
    /** Evidence-backed candidates admitted before selector thresholds. */
    admittedCandidateCount?: number;
    appliedCandidateCount: number;
    /** Candidate records that passed provider score/coverage gates. */
    selectionEligibleCandidateCount?: number;
    /** Unique selected GO terms carrying at least one candidate-source support. */
    selectedCandidateTermCount?: number;
    sourceStats?: Array<{
      sourceType: "biolm_retrieval" | "interpro" | "pfam" | "panther" | "ec" | "oma_ortholog" | "oma_fastmap" | "mdeepfri_cnn" | "mdeepfri_gcn" | "deepgoplus_cnn" | "deepgoplus_hybrid";
      normalized: number;
      admitted: number;
      selectionEligible: number;
      novelToDirectPool: number;
      selectedTerms: number;
    }>;
  };
  phylogenyStatus: {
    mode: "disabled" | "orthology_aware";
    targetTaxonStatus: "provided" | "unavailable";
    evidenceCount: number;
    appliedCount: number;
    quarantinedCount: number;
    /** Direct donor supports reweighted by a caller-TaxID taxonomy lineage. */
    lineageWeightedSupportCount?: number;
    selectedLineageWeightedSupportCount?: number;
  };
  goJudgeStatus?: {
    requestedMode: "deterministic" | "pi";
    modeUsed: "deterministic" | "pi";
    viewHash: string;
    decisionHash: string;
    judgedCandidateCount: number;
    candidateBudgetMode?: "global_ranked_v1" | "aspect_stratified_v1";
    candidateRetentionMode?: "fail_closed_v1" | "preserve_ranked_evidence_v1";
    fallbackReason: string | null;
  };
  semanticGoJudgeStatus?: {
    modeUsed: "pi";
    viewHash: string;
    decisionHash: string;
    candidateCount: number;
    acceptedCount: number;
    modelProvider: string;
    modelId: string;
    thinkingLevel: string;
    maxCandidates: number;
    maxDonorContexts: number;
    scoringPolicy: "r08_compact_acceptance_v1" | "r08_compact_acceptance_global_calibration_v1";
    failurePolicy: "fail_closed";
  };
  scoreFusionStatus?: {
    mode: "deepgoplus_anchor_v1";
    anchorWeights: Record<"molecular_function" | "biological_process" | "cellular_component", number>;
  };
  taxonConstraintStatus: "not_evaluated" | "unavailable" | "applied";
  thresholds: Record<"molecular_function" | "biological_process" | "cellular_component", number>;
  /** Query-identity quarantine; validated against query-like annotation rows. */
  quarantinedGoIds: string[];
  /**
   * Raw GO IDs excluded before scoring because a supplied pinned ontology
   * could not resolve them to an active canonical term. This includes
   * obsolete terms omitted from go-basic as well as unknown IDs.
   */
  ontologyQuarantinedGoIds?: string[];
  predictedGoIds: string[];
  terms: GOTermPrediction[];
  canonicalHash: string;
  limitations: string[];
}

export interface FinalPrediction extends FunctionPrediction {
  schemaVersion: "pi-function-prediction.v4";
  targetMode: TargetMode;
  targetContext: TargetContext;
  narrativeMode: NarrativeMode;
  goPrediction: GOPredictionSet;
}

export interface AgentGenome {
  schemaVersion: "pi-agent-genome.v1";
  genomeId: string;
  parentGenomeId: string | null;
  generation: number;
  evidencePolicy: {
    mode: "fixed_full_pipeline";
    requiredInputs: string[];
  };
  goPolicy: {
    methodId: string;
    evidenceWeights: Record<string, number>;
    unknownEvidenceWeight: number;
    lineageFloor: number;
    lineageRange: number;
    domainStructurePenalty: number;
    globalStructureCoverageFloor: number;
    minimumDonorGroupSupport: number;
    minimumIndependentProvenanceRoots: number;
    thresholds: Record<"molecular_function" | "biological_process" | "cellular_component", number>;
    maxSelectedTermsPerAspect: number;
    /** Defaults to disabled for v1 genome compatibility. */
    selectionPolicy?: {
      mode: "disabled" | "evidence_frontier_v1";
      /** Defaults to all three aspects when omitted. */
      aspects?: Array<"molecular_function" | "biological_process" | "cellular_component">;
    };
    requireTwoStructureDonorGroups: boolean;
    /** Defaults to primary_only for v1 genome compatibility. */
    sequenceEligibilityMode?: "primary_only" | "retained_sequence";
    /** Defaults to disabled for v1 genome compatibility. */
    ontologyPolicy?: {
      mode: "disabled" | "ancestor_closure";
      maxDepth: number;
      scoreDecay: number;
      excludeRoots: true;
      relations: ["is_a", "part_of"];
    };
    /** Defaults to disabled for v1 genome compatibility. */
    candidateSourcePolicy?: {
      mode: "disabled" | "storage_light";
      /** Defaults to all three aspects when omitted. */
      allowedAspects?: Array<"molecular_function" | "biological_process" | "cellular_component">;
      minimumBaseScore: number;
      minimumQueryCoverage: number;
      /**
       * Optional lower bound for the annotation-code weight used only after a
       * provider candidate has passed its own base-score and coverage gates.
       * This is a bounded calibration knob, not a replacement for those gates.
       */
      minimumEvidenceWeight?: number;
      requireIndependentRoots: number;
      allowedSources: Array<"biolm_retrieval" | "interpro" | "pfam" | "panther" | "ec" | "oma_ortholog" | "oma_fastmap">;
    };
    /** Independently scored learned GO candidates; disabled unless both the genome and a hash-bound overlay enable it. */
    learnedPredictorPolicy?: {
      mode: "disabled" | "candidate_channel";
      allowedSources: ["mdeepfri_cnn"] | ["mdeepfri_gcn"] | ["deepgoplus_cnn"] | ["deepgoplus_hybrid"];
      /** Optional immutable method/model binding required at execution time. */
      expectedMethodHash?: string;
      allowedAspects: Array<"molecular_function" | "biological_process" | "cellular_component">;
      /**
       * Defaults to always. direct_annotation_gap_only requires no direct
       * donor annotation in the aspect; prediction_aspect_gap_only requires
       * the host-only baseline to have no positive pre-budget hypothesis;
       * host_term_agreement_only admits only GO IDs that are already positive
       * host-only hypotheses.
       */
      activationMode?: "always" | "direct_annotation_gap_only" | "prediction_aspect_gap_only" | "host_term_agreement_only";
      /** Optional per-aspect cap applied to direct learned rows before ontology closure. */
      maxCandidatesPerAspect?: number;
      minimumScore: number;
      scoreScale: number;
      requireIndependentRoots: 1;
    };
    /** Defaults to disabled for v1 genome compatibility. */
    phylogenyPolicy?: {
      mode: "disabled" | "orthology_aware";
      relationWeights: Record<"one_to_one" | "one_to_many" | "many_to_one" | "many_to_many" | "coortholog" | "unresolved_ortholog" | "post_duplication_paralog", number>;
      aspectDistanceDecay: Record<"molecular_function" | "biological_process" | "cellular_component", number>;
      lineageFloor: number;
      lineageRange: number;
      paralogLeafTransferAllowed: false;
      cladeCollapseDepth: number;
    };
    /** Bounded inner-agent judgment over an opaque candidate allowlist. */
    goJudgePolicy?: {
      mode: "disabled" | "evidence_consistency" | "semantic_reasoning";
      /**
       * Execution mode is genome-bound so evaluation and deployment cannot
       * silently substitute a deterministic surrogate for a Pi judgment.
       * Missing means deterministic for backward-compatible v1 snapshots.
       */
      executionMode?: "deterministic" | "pi";
      /** Fixed per-aspect quotas prevent a new BP channel from displacing MF/CC hypotheses. */
      candidateBudgetMode?: "global_ranked_v1" | "aspect_stratified_v1";
      /**
       * Keep admissible evidence-backed hypotheses in the scored ranking even
       * when the bounded judge cannot review or operationally select them.
       * This never admits a term that fails a hard evidence/provenance gate.
       */
      candidateRetentionMode?: "fail_closed_v1" | "preserve_ranked_evidence_v1";
      maxCandidates: number;
      /** Semantic mode is pinned to the exact 128/12 model process recorded in the genome. */
      maxDonorContexts?: number;
      modelProvider?: string;
      modelId?: string;
      thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    };
    /** Development-fitted bounded affine fusion; the learned prior remains hash-bound. */
    scoreFusionPolicy?: {
      mode: "disabled" | "deepgoplus_anchor_v1";
      anchorWeights: Record<"molecular_function" | "biological_process" | "cellular_component", number>;
    };
  };
  narrativePolicy: {
    defaultMode: NarrativeMode;
    maxRevisionCycles: number;
  };
  improvementPolicy: {
    enabled: false;
    externalFeedbackRequired: true;
    promotionEvaluator: "not_configured_in_mvp";
  };
  claimBoundary: string;
}

export interface GenomeSnapshot {
  schemaVersion: "pi-agent-genome-snapshot.v1";
  genome: AgentGenome;
  genomeHash: string;
  immutableContractHash: string;
}

export interface EpisodeStep {
  name: string;
  status: "completed" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  evidenceIds: string[];
  outputHashes: Record<string, string>;
  note?: string;
}

export interface EpisodeTrace {
  schemaVersion: "pi-function-episode.v3";
  episodeId: string;
  runId: string;
  status: "completed" | "failed";
  genomeId: string;
  genomeHash: string;
  narrativeMode: NarrativeMode;
  target: {
    proteinId: string;
    targetMode: TargetMode;
    queryTaxonId: number | null;
    targetContext: TargetContext;
    sequenceSha256: string;
    structureSha256: string | null;
  };
  steps: EpisodeStep[];
  outputHashes: Record<string, string>;
  biologicalFeedback: {
    status: "unavailable";
    eligibleForEvolution: false;
    reason: string;
  };
  promotionDecision: "not_evaluated";
  startedAt: string;
  finishedAt: string;
}
