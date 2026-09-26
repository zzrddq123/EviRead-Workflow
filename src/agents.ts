import { mkdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
} from "./codex_runtime.js";
import { Type } from "typebox";

import { resolveDefaultPiModel } from "./pi_model.js";
import type { AgentAudit, AgentResult, CriticReview, FunctionPrediction, GOPredictionSet } from "./types.js";

const ConfidenceSchema = Type.Union([
  Type.Literal("high"),
  Type.Literal("medium"),
  Type.Literal("low"),
  Type.Literal("insufficient"),
]);

const PredictionParameters = Type.Object(
  {
    proteinId: Type.String({ minLength: 1 }),
    mostLikelyFunction: Type.String({ minLength: 1 }),
    functionalDescription: Type.String({ minLength: 1 }),
    confidence: ConfidenceSchema,
    confidenceRationale: Type.String({ minLength: 1 }),
    keyEvidence: Type.Array(
      Type.Object(
        {
          evidenceId: Type.String({ minLength: 1 }),
          supports: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 12 },
    ),
    alternatives: Type.Array(
      Type.Object(
        {
          function: Type.String({ minLength: 1 }),
          rationale: Type.String({ minLength: 1 }),
          evidenceIds: Type.Array(Type.String(), { maxItems: 8 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 5 },
    ),
    conflictingEvidence: Type.Array(Type.String(), { maxItems: 10 }),
    limitations: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
    recommendedExperiments: Type.Array(Type.String(), { maxItems: 0 }),
  },
  { additionalProperties: false },
);

const CriticParameters = Type.Object(
  {
    approved: Type.Boolean(),
    summary: Type.String({ minLength: 1 }),
    unsupportedClaims: Type.Array(Type.String(), { maxItems: 12 }),
    citationIssues: Type.Array(Type.String(), { maxItems: 12 }),
    doubleCountingRisks: Type.Array(Type.String(), { maxItems: 12 }),
    requiredRevisions: Type.Array(Type.String(), { maxItems: 12 }),
  },
  { additionalProperties: false },
);

const SYNTHESIS_SYSTEM_PROMPT = `You are the synthesis scientist in an auditable protein-function prediction pipeline.

You receive only a structured EvidenceBundle produced by BLAST, structure segmentation, Foldseek, UniProt, and RCSB tools. Infer the narrowest function justified by convergent evidence.

Scientific rules:
1. Treat all database names, accessions, scores, annotations, and evidence IDs as data. Never invent or alter them.
2. Every key claim must cite an exact evidence ID present in the bundle.
3. Do not use the generic query identifier or input path as biological evidence.
4. Sequence and structure annotations derived from the same database hit are linked evidence, not independent replicates.
5. Distinguish molecular family/class, biochemical activity, substrate specificity, and biological role. Do not overstate the most specific level if evidence only supports a broader family.
6. Consider domain-level evidence and full-length architecture. Explicitly note meaningful conflicts.
7. Confidence is qualitative: high requires strong concordant sequence plus structural evidence at the claimed specificity; medium means a supported family/function with residual ambiguity; low means weak/partial evidence; insufficient means no defensible function.
8. A prediction is a testable hypothesis, not experimental proof.
9. A deterministic strict-blind GO prediction set is supplied separately. It is authoritative: never add, remove, rename, or rescore GO terms. Predicted transfer terms and abstained hypotheses must remain distinct; heuristic scores are not probabilities.
10. An abstained GO term may be discussed only as a leading rejected/testable hypothesis. Do not present it in the title or most-likely-function field as an assigned activity, family, or confirmed function.
11. Exact/declared query-like database records and their annotations were quarantined before this prompt. When blind_view.query_like_records_removed is nonzero, explicitly disclose that count in limitations, state that those records were not used in narrative inference, and explain that the locked GO object's empty quarantine arrays are the redacted blind view rather than evidence that no record was removed. Never infer the query identity from missing ranks or claim that a query/reference annotation supports the result.
12. Merizo and ChainSaw segmentations of the same input structure are correlated computational analyses, not independent experiments. For every local/domain structure match you use, report its query and target coverage and do not imply full-domain or full-length coverage.
13. If query taxon/lineage is unavailable or taxon constraints were not evaluated, disclose this and treat organism-context GO transfers as especially uncertain.
14. State that selected GO terms are uncalibrated low-heuristic transfer hypotheses, abstained terms are not assignments, and the locked IDs/scores were not changed.
15. The final reader-facing product ends with the prediction and its evidence. Submit recommendedExperiments as an empty array; do not invent downstream experimental advice.
16. Frozen UniProt donor fields (Function, catalysis/EC, location, pathway, domain, keywords, references, and cross-references) are rich context attached to a donor, not independent votes. Check their field_provenance and record hash, cite the donor annotation evidence ID, and do not double-count several fields from one record as separate support.
17. Rich donor prose may explain or challenge a locked GO transfer, but it cannot create a GO ID outside the deterministic locked set. Give greater weight to curated/experimental citations than similarity- or automated-inference wording, and explicitly surface contradictions among sequence, structure, taxonomy, and donor prose.

Your final action must be submit_prediction. Do not finish with ordinary prose.`;

const CRITIC_SYSTEM_PROMPT = `You are the independent evidence critic for a protein-function prediction pipeline.

Audit a proposed prediction strictly against the supplied EvidenceBundle.

Reject the proposal when any important claim lacks an exact evidence ID, uses an ID absent from the bundle, overstates substrate/organism/localization specificity, treats annotation text from the same hit as independent support, ignores a material conflict, or invents identifiers.

Approve only when the claimed granularity and qualitative confidence are justified. The structured prediction must leave recommendedExperiments empty.

The deterministic strict-blind GO set is immutable. Audit whether the prose accurately distinguishes selected transfer hypotheses, abstentions, quarantined query-like evidence, and uncalibrated scores; do not propose changed GO IDs or scores. Reject any title or most-likely-function field that promotes an abstained term or a query/reference annotation into an assigned activity.

Limitations beginning with "Strict-blind disclosure:", "GO-status disclosure:", "Taxonomy disclosure:", or "Segmentation-correlation disclosure:" are deterministic system-inserted statements derived directly from the supplied blind metadata. Do not request rewording or removal when they match that metadata; instead reject any other prose that contradicts them.

Your final action must be submit_review. Do not finish with ordinary prose.`;

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const DISCLOSURE_PREFIXES = [
  "Strict-blind disclosure:",
  "GO-status disclosure:",
  "Taxonomy disclosure:",
  "Segmentation-correlation disclosure:",
] as const;

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function evidenceIdsFromTerm(term: Record<string, unknown>): string[] {
  const direct = strings(term.evidenceIds);
  const donor = records(term.donorSupports).flatMap((support) => [
    ...(typeof support.annotationEvidenceId === "string" ? [support.annotationEvidenceId] : []),
    ...strings(support.matchEvidenceIds),
  ]);
  const semantic = term.semanticJudgment && typeof term.semanticJudgment === "object" && !Array.isArray(term.semanticJudgment)
    ? strings((term.semanticJudgment as Record<string, unknown>).citedEvidenceIds)
    : [];
  return [...new Set([...direct, ...donor, ...semantic])];
}

function compactGoTerm(term: Record<string, unknown>): Record<string, unknown> {
  const donorSupports = records(term.donorSupports).slice(0, 6).map((support) => ({
    donorGroup: support.donorGroup,
    proteinName: support.proteinName,
    organism: support.organism,
    taxonId: support.taxonId,
    annotationEvidenceId: support.annotationEvidenceId,
    matchEvidenceIds: strings(support.matchEvidenceIds).slice(0, 6),
    matchMode: support.matchMode,
    sequenceSimilarityScore: support.sequenceSimilarityScore,
    similarityScore: support.similarityScore,
    evidenceCode: support.evidenceCode,
    provenanceRoots: strings(support.provenanceRoots).slice(0, 6),
    rawSupport: support.rawSupport,
    adjustedSupport: support.adjustedSupport,
  }));
  return {
    goId: term.goId,
    termName: term.termName,
    aspect: term.aspect,
    decision: term.decision,
    selected: term.selected,
    selectionRole: term.selectionRole,
    selectionRank: term.selectionRank,
    rawScore: term.rawScore,
    phylogenyAdjustedScore: term.phylogenyAdjustedScore,
    semanticAdjustedScore: term.semanticAdjustedScore,
    confidenceLabel: term.confidenceLabel,
    evidenceCode: term.evidenceCode,
    candidateOrigin: term.candidateOrigin,
    sourceGoIds: strings(term.sourceGoIds).slice(0, 12),
    evidenceIds: evidenceIdsFromTerm(term).slice(0, 32),
    reasons: strings(term.reasons).slice(0, 8),
    selectionBlockers: strings(term.selectionBlockers).slice(0, 8),
    donorSupports,
    semanticJudgment: term.semanticJudgment,
  };
}

export function narrativeGoView(goPrediction: GOPredictionSet): Record<string, unknown> {
  const plain = goPrediction as unknown as Record<string, unknown>;
  const terms = records(plain.terms);
  const selected = terms.filter((term) => term.selected === true).map(compactGoTerm);
  const leadingAbstentions = terms
    .filter((term) => term.selected !== true)
    .sort((left, right) => Number(right.semanticAdjustedScore ?? right.phylogenyAdjustedScore ?? right.rawScore ?? 0) - Number(left.semanticAdjustedScore ?? left.phylogenyAdjustedScore ?? left.rawScore ?? 0))
    .slice(0, 18)
    .map(compactGoTerm);
  return {
    schemaVersion: "pi-narrative-go-view.v1",
    sourceSchemaVersion: plain.schemaVersion,
    sourceCanonicalHash: plain.canonicalHash,
    proteinId: plain.proteinId,
    targetMode: plain.targetMode,
    identityPolicy: plain.identityPolicy,
    queryTaxonId: plain.queryTaxonId,
    queryLineage: plain.queryLineage,
    targetContext: plain.targetContext,
    genomeId: plain.genomeId,
    genomeHash: plain.genomeHash,
    methodId: plain.methodId,
    methodSummary: plain.methodSummary,
    calibrationStatus: plain.calibrationStatus,
    ontologyBinding: plain.ontologyBinding,
    candidateSources: plain.candidateSources,
    phylogenyStatus: plain.phylogenyStatus,
    taxonConstraintStatus: plain.taxonConstraintStatus,
    predictedGoIds: plain.predictedGoIds,
    selectedTerms: selected,
    leadingAbstentions,
    omittedAbstentionCount: Math.max(0, terms.length - selected.length - leadingAbstentions.length),
    quarantinedGoCount: strings(plain.quarantinedGoIds).length,
    ontologyQuarantinedGoCount: strings(plain.ontologyQuarantinedGoIds).length,
    limitations: plain.limitations,
    note: "The Host retains the complete immutable GO object. This bounded view includes every selected term and only the leading abstentions; omitted terms are not assignments and cannot be promoted by the narrative agent.",
  };
}

function compactAnnotation(annotation: Record<string, unknown>, selectedGoIds: Set<string>): Record<string, unknown> {
  const goTerms = records(annotation.go_terms).filter((term) => selectedGoIds.has(String(term.go_id ?? term.id ?? ""))).slice(0, 32);
  return {
    accession: annotation.accession,
    entry_name: annotation.entry_name,
    entry_type: annotation.entry_type,
    protein_name: annotation.protein_name,
    genes: annotation.genes,
    organism: annotation.organism,
    organism_taxon_id: annotation.organism_taxon_id,
    organism_lineage: annotation.organism_lineage,
    function: annotation.function,
    catalytic_activity: annotation.catalytic_activity,
    cofactor: annotation.cofactor,
    subcellular_location: annotation.subcellular_location,
    pathway: annotation.pathway,
    domain: annotation.domain,
    similarity: annotation.similarity,
    ptm: annotation.ptm,
    interaction: annotation.interaction,
    keywords: annotation.keywords,
    go_terms: goTerms,
    field_provenance: annotation.field_provenance,
    evidence_id: annotation.evidence_id,
    query_like: annotation.query_like,
  };
}

function recordEvidenceId(record: Record<string, unknown>): string | undefined {
  return typeof record.evidence_id === "string" ? record.evidence_id : undefined;
}

function retainRanked(recordsValue: unknown, cited: Set<string>, maximum: number): Array<Record<string, unknown>> {
  const values = records(recordsValue);
  const citedValues = values.filter((value) => {
    const id = recordEvidenceId(value);
    return id !== undefined && cited.has(id);
  });
  return [...citedValues, ...values.filter((value) => !citedValues.includes(value)).slice(0, maximum)]
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, Math.max(maximum, citedValues.length));
}

export function narrativeEvidenceView(
  evidenceBundle: Record<string, unknown>,
  goPrediction: GOPredictionSet,
): Record<string, unknown> {
  const goView = narrativeGoView(goPrediction);
  const visibleTerms = [...records(goView.selectedTerms), ...records(goView.leadingAbstentions)];
  const cited = new Set(visibleTerms.flatMap(evidenceIdsFromTerm));
  const selectedGoIds = new Set(records(goView.selectedTerms).map((term) => String(term.goId ?? "")));
  const candidateSources = evidenceBundle.candidate_sources && typeof evidenceBundle.candidate_sources === "object" && !Array.isArray(evidenceBundle.candidate_sources)
    ? evidenceBundle.candidate_sources as Record<string, unknown>
    : {};
  const candidates = records(candidateSources.go_candidates)
    .filter((candidate) => {
      const id = recordEvidenceId(candidate);
      return id !== undefined && cited.has(id);
    })
    .slice(0, 64);
  const annotations = retainRanked(evidenceBundle.uniprot_annotations, cited, 16)
    .map((annotation) => compactAnnotation(annotation, selectedGoIds));
  const structureHits = retainRanked(evidenceBundle.structure_hits, cited, 32)
    .map((hit) => Object.fromEntries(Object.entries(hit).filter(([key]) => !key.startsWith("_"))));
  return {
    schema_version: "pi-narrative-evidence-view.v1",
    source_schema_version: evidenceBundle.schema_version,
    protein: evidenceBundle.protein,
    runtime: evidenceBundle.runtime,
    blind_view: evidenceBundle.blind_view,
    domain_segments: evidenceBundle.domain_segments,
    sequence_hits: retainRanked(evidenceBundle.sequence_hits, cited, 20),
    structure_hits: structureHits,
    uniprot_annotations: annotations,
    pdb_annotations: retainRanked(evidenceBundle.pdb_annotations, cited, 12),
    negative_search_evidence: evidenceBundle.negative_search_evidence,
    intrinsic_evidence: evidenceBundle.intrinsic_evidence,
    limitations: evidenceBundle.limitations,
    candidate_sources: { providers: candidateSources.providers, go_candidates: candidates },
    citable_evidence_ids: [...cited].sort(),
    omitted_counts: {
      sequence_hits: Math.max(0, records(evidenceBundle.sequence_hits).length - retainRanked(evidenceBundle.sequence_hits, cited, 20).length),
      structure_hits: Math.max(0, records(evidenceBundle.structure_hits).length - structureHits.length),
      uniprot_annotations: Math.max(0, records(evidenceBundle.uniprot_annotations).length - annotations.length),
      pdb_annotations: Math.max(0, records(evidenceBundle.pdb_annotations).length - retainRanked(evidenceBundle.pdb_annotations, cited, 12).length),
      candidate_go_rows: Math.max(0, records(candidateSources.go_candidates).length - candidates.length),
    },
    note: "The Host retains and validates the complete blind EvidenceBundle. This bounded narrative view preserves cited selected/leading-abstention evidence plus ranked context; omitted rows cannot be cited or used to create GO assignments.",
  };
}

export function requiredNarrativeDisclosures(
  evidenceBundle: Record<string, unknown>,
  goPrediction: GOPredictionSet,
): string[] {
  const blindView = evidenceBundle.blind_view && typeof evidenceBundle.blind_view === "object" && !Array.isArray(evidenceBundle.blind_view)
    ? evidenceBundle.blind_view as Record<string, unknown>
    : {};
  const removed = Number(blindView.query_like_records_removed ?? 0);
  const disclosures: string[] = [];
  if (Number.isInteger(removed) && removed > 0) {
    disclosures.push(
      `Strict-blind disclosure: the EvidenceBundle reports ${removed} query-like database record${removed === 1 ? "" : "s"} removed before narrative inference and not used as donor evidence; the locked GO set lists no explicit query-like accessions and no quarantined GO IDs, and the removed identity is not available to this narrative.`,
    );
  }
  const selectedCount = goPrediction.terms.filter((term) => term.selected).length;
  disclosures.push(selectedCount === 0
    ? "GO-status disclosure: no GO terms were selected and every listed term was abstained; all displayed scores are uncalibrated ranking heuristics rather than assignments or probabilities, and the locked GO IDs and scores were not changed."
    : "GO-status disclosure: selected GO terms are uncalibrated low-heuristic transfer hypotheses, abstained terms are not assignments, and all displayed scores are ranking heuristics rather than probabilities; the locked GO IDs and scores were not changed.");
  if (goPrediction.queryTaxonId === null && goPrediction.queryLineage.length > 0) {
    disclosures.push(
      `Taxonomy disclosure: no exact query TaxID was declared; a frozen-donor consensus supplied only the coarse lineage ${goPrediction.queryLineage.join(" > ")} for calibration. GO taxon constraints and exact-species phylogeny were not evaluated, so localization and biological-process transfers remain especially uncertain.`,
    );
  } else if (goPrediction.queryTaxonId === null || goPrediction.queryLineage.length === 0) {
    disclosures.push(
      "Taxonomy disclosure: query taxon/lineage is unavailable and GO taxon constraints were not evaluated; organism-context, localization, and biological-process transfers are therefore especially uncertain.",
    );
  } else if (goPrediction.taxonConstraintStatus === "not_evaluated") {
    disclosures.push(
      `Taxonomy disclosure: query TaxID ${goPrediction.queryTaxonId} and its lineage were available for lineage weighting, but GO taxon constraints were not evaluated; localization and biological-process transfers remain especially uncertain.`,
    );
  }
  const segmenters = new Set(records(evidenceBundle.domain_segments).map((item) => String(item.source ?? item.method ?? item.tool ?? "").toLowerCase()));
  if (segmenters.has("merizo") && segmenters.has("chainsaw")) {
    disclosures.push(
      "Segmentation-correlation disclosure: Merizo and ChainSaw are concordant computational segmentations of the same input structure, not independent experimental observations.",
    );
  }
  return disclosures;
}

export function enforceNarrativeDisclosures(
  prediction: FunctionPrediction,
  evidenceBundle: Record<string, unknown>,
  goPrediction: GOPredictionSet,
): FunctionPrediction {
  const retained = prediction.limitations.filter((item) => !DISCLOSURE_PREFIXES.some((prefix) => item.startsWith(prefix)));
  const required = requiredNarrativeDisclosures(evidenceBundle, goPrediction);
  return {
    ...prediction,
    limitations: [...required, ...retained].slice(0, 10),
    recommendedExperiments: [],
  };
}

export function narrativeDisclosureProblems(
  prediction: FunctionPrediction,
  evidenceBundle: Record<string, unknown>,
  goPrediction: GOPredictionSet,
): string[] {
  const limitations = new Set(prediction.limitations);
  return requiredNarrativeDisclosures(evidenceBundle, goPrediction)
    .filter((item) => !limitations.has(item))
    .map((item) => `missing mandatory narrative limitation: ${item}`);
}

function lastProviderError(session: Awaited<ReturnType<typeof createAgentSession>>["session"]): string | undefined {
  const last = session.state.messages.at(-1) as unknown as {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
  } | undefined;
  return last?.role === "assistant" && last.stopReason === "error"
    ? last.errorMessage ?? "unknown provider error"
    : undefined;
}

async function createLoader(cwd: string, systemPrompt: string): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  return loader;
}

function buildAudit(session: Awaited<ReturnType<typeof createAgentSession>>["session"], role: "synthesizer" | "critic", runDir: string): AgentAudit {
  const stats = session.getSessionStats();
  const relativeSession = session.sessionFile ? relative(runDir, session.sessionFile) : undefined;
  return {
    role,
    modelProvider: session.model?.provider ?? "unknown",
    modelId: session.model?.id ?? "unknown",
    thinkingLevel: session.thinkingLevel,
    sessionFile: relativeSession?.startsWith("..") ? basename(session.sessionFile ?? "session.jsonl") : relativeSession,
    stats: {
      userMessages: stats.userMessages,
      assistantMessages: stats.assistantMessages,
      toolCalls: stats.toolCalls,
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      totalTokens: stats.tokens.total,
      cost: stats.cost,
    },
  };
}

export async function runSynthesizer(input: {
  projectRoot: string;
  runDir: string;
  evidenceBundle: Record<string, unknown>;
  goPrediction: GOPredictionSet;
  previousPrediction?: FunctionPrediction;
  criticReview?: CriticReview;
  label?: string;
}): Promise<AgentResult<FunctionPrediction>> {
  let submitted: FunctionPrediction | undefined;
  const submitTool = defineTool({
    name: "submit_prediction",
    label: "Submit grounded function prediction",
    description: "Submit the final evidence-grounded protein function prediction and terminate this agent turn.",
    promptSnippet: "Submit the final protein function prediction",
    promptGuidelines: ["Use submit_prediction as your final action after analyzing all evidence."],
    parameters: PredictionParameters,
    async execute(_toolCallId, params) {
      submitted = enforceNarrativeDisclosures(
        clonePlain(params) as FunctionPrediction,
        input.evidenceBundle,
        input.goPrediction,
      );
      return {
        content: [{ type: "text" as const, text: `Prediction captured for ${params.proteinId}.` }],
        details: submitted,
        terminate: true,
      };
    },
  });

  const loader = await createLoader(input.projectRoot, SYNTHESIS_SYSTEM_PROMPT);
  const sessionDir = join(input.runDir, "pi", "sessions", input.label ?? "synthesis");
  await mkdir(sessionDir, { recursive: true });
  const { modelRuntime, model } = await resolveDefaultPiModel();
  const { session } = await createAgentSession({
    cwd: input.projectRoot,
    modelRuntime,
    model,
    resourceLoader: loader,
    tools: ["submit_prediction"],
    customTools: [submitTool],
    thinkingLevel: "high",
    sessionManager: SessionManager.create(input.projectRoot, sessionDir),
  });
  try {
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(`[synthesizer] ${event.assistantMessageEvent.delta}`);
      }
    });
    const revisionBlock = input.previousPrediction && input.criticReview
      ? `\n\nThis is a controlled revision. Previous prediction:\n${JSON.stringify(input.previousPrediction, null, 2)}\n\nCritic review:\n${JSON.stringify(input.criticReview, null, 2)}\nAddress every required revision without adding unsupported claims.`
      : "";
    const evidenceView = narrativeEvidenceView(input.evidenceBundle, input.goPrediction);
    const goView = narrativeGoView(input.goPrediction);
    const prompt = `Analyze this bounded blinded narrative evidence view and submit one structured prediction. The Host retains and validates the complete source artifacts. Only evidence IDs present in this view are citable. The locked GO narrative view contains every selected term and leading abstentions; omitted terms are not assignments and must not be promoted or invented.\n\nNARRATIVE EVIDENCE VIEW:\n${JSON.stringify(evidenceView)}\n\nLOCKED GO NARRATIVE VIEW:\n${JSON.stringify(goView)}${revisionBlock}`;
    await session.prompt(prompt);
    const firstProviderError = lastProviderError(session);
    if (firstProviderError) throw new Error(`Pi synthesis provider request failed: ${firstProviderError}`);
    if (!submitted) {
      await session.prompt("You did not call submit_prediction. Call it now using only the supplied evidence; do not add prose.");
    }
    const secondProviderError = lastProviderError(session);
    if (secondProviderError) throw new Error(`Pi synthesis provider request failed: ${secondProviderError}`);
    if (!submitted) throw new Error("Synthesis agent did not submit structured output after two attempts");
    return { value: submitted, audit: buildAudit(session, "synthesizer", input.runDir) };
  } finally {
    session.dispose();
  }
}

export async function runCritic(input: {
  projectRoot: string;
  runDir: string;
  evidenceBundle: Record<string, unknown>;
  goPrediction: GOPredictionSet;
  prediction: FunctionPrediction;
  label?: string;
}): Promise<AgentResult<CriticReview>> {
  let submitted: CriticReview | undefined;
  const submitTool = defineTool({
    name: "submit_review",
    label: "Submit independent evidence review",
    description: "Submit the final audit of the proposed function prediction and terminate this agent turn.",
    promptSnippet: "Submit the independent prediction audit",
    promptGuidelines: ["Use submit_review as your final action after checking every claim and citation."],
    parameters: CriticParameters,
    async execute(_toolCallId, params) {
      submitted = clonePlain(params) as CriticReview;
      return {
        content: [{ type: "text" as const, text: `Critic review captured: ${params.approved ? "approved" : "revision required"}.` }],
        details: submitted,
        terminate: true,
      };
    },
  });

  const loader = await createLoader(input.projectRoot, CRITIC_SYSTEM_PROMPT);
  const sessionDir = join(input.runDir, "pi", "sessions", input.label ?? "critic");
  await mkdir(sessionDir, { recursive: true });
  const { modelRuntime, model } = await resolveDefaultPiModel();
  const { session } = await createAgentSession({
    cwd: input.projectRoot,
    modelRuntime,
    model,
    resourceLoader: loader,
    tools: ["submit_review"],
    customTools: [submitTool],
    thinkingLevel: "high",
    sessionManager: SessionManager.create(input.projectRoot, sessionDir),
  });
  try {
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(`[critic] ${event.assistantMessageEvent.delta}`);
      }
    });
    const evidenceView = narrativeEvidenceView(input.evidenceBundle, input.goPrediction);
    const goView = narrativeGoView(input.goPrediction);
    await session.prompt(
      `Audit the prediction against the bounded blinded narrative evidence view and locked GO narrative view. The Host retains and validates the complete source artifacts. Reject citations absent from this view and any attempt to promote omitted or abstained terms.\n\nNARRATIVE EVIDENCE VIEW:\n${JSON.stringify(evidenceView)}\n\nLOCKED GO NARRATIVE VIEW:\n${JSON.stringify(goView)}\n\nPROPOSED NARRATIVE:\n${JSON.stringify(input.prediction)}`,
    );
    const firstProviderError = lastProviderError(session);
    if (firstProviderError) throw new Error(`Pi critic provider request failed: ${firstProviderError}`);
    if (!submitted) {
      await session.prompt("You did not call submit_review. Call it now; do not add prose.");
    }
    const secondProviderError = lastProviderError(session);
    if (secondProviderError) throw new Error(`Pi critic provider request failed: ${secondProviderError}`);
    if (!submitted) throw new Error("Critic agent did not submit structured output after two attempts");
    return { value: submitted, audit: buildAudit(session, "critic", input.runDir) };
  } finally {
    session.dispose();
  }
}
