import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
} from "./codex_runtime.js";
import { Type } from "typebox";

import { hashCanonical } from "./hash.js";
import { resolveDefaultPiModel } from "./pi_model.js";
import { applyGOSelection, hasGOHardSelectionBlocker } from "./go_selection.js";
import type { GOPredictionSet, GOTermPrediction } from "./types.js";

/**
 * The GO evidence judge is deliberately separated from the GO identifier map.
 * A caller must replace every GO identifier with an opaque, content-derived
 * token before constructing this view. The reverse map never enters Pi.
 */
export const GO_JUDGE_VERDICTS = ["support", "uncertain", "contradict"] as const;
export type GOJudgeVerdict = (typeof GO_JUDGE_VERDICTS)[number];

export const GO_JUDGE_CHANNELS = [
  "sequence",
  "structure",
  "domain",
  "orthology",
  "phylogeny",
  "taxonomy",
  "ontology",
] as const;
export type GOJudgeChannel = (typeof GO_JUDGE_CHANNELS)[number];

export const GO_JUDGE_DIRECTIONS = ["support", "neutral", "contradict"] as const;
export type GOJudgeDirection = (typeof GO_JUDGE_DIRECTIONS)[number];

export const GO_JUDGE_STRENGTHS = ["weak", "moderate", "strong"] as const;
export type GOJudgeStrength = (typeof GO_JUDGE_STRENGTHS)[number];

/**
 * Verdict multipliers are host policy, not model output. Keeping them small
 * prevents the judge from replacing the underlying evidence score.
 */
export const GO_JUDGE_FACTORS: Readonly<Record<GOJudgeVerdict, number>> = Object.freeze({
  support: 1.05,
  uncertain: 0.85,
  contradict: 0.4,
});

export interface GOJudgeEvidenceView {
  /** Opaque evidence token from the caller's allowlist. */
  evidenceId: string;
  channel: GOJudgeChannel;
  direction: GOJudgeDirection;
  strength: GOJudgeStrength;
  /** Correlated observations share a group and count only once in fallback. */
  independenceGroup: string;
}

export interface GOCandidateJudgeView {
  /** Opaque hash token; it must not contain or encode a visible GO identifier. */
  candidateToken: string;
  /** Human-readable ontology label; the GO identifier remains outside Pi. */
  hypothesisName: string;
  aspect: "molecular_function" | "biological_process" | "cellular_component" | "unknown";
  evidence: GOJudgeEvidenceView[];
}

export interface GOJudgeView {
  schemaVersion: "go-evidence-judge-view-v1";
  viewHash: string;
  candidates: GOCandidateJudgeView[];
}

export interface GOJudgeSubmissionItem {
  candidateToken: string;
  verdict: GOJudgeVerdict;
  citedEvidenceIds: string[];
}

export interface GOJudgeSubmission {
  judgments: GOJudgeSubmissionItem[];
}

export interface GOJudgeDecision extends GOJudgeSubmissionItem {
  /** Deterministically derived from verdict via GO_JUDGE_FACTORS. */
  factor: number;
}

export interface GOJudgeResult {
  schemaVersion: "go-evidence-judge-result-v1";
  viewHash: string;
  modeUsed: "deterministic" | "pi";
  decisions: GOJudgeDecision[];
}

export interface GOJudgeInput {
  projectRoot: string;
  mode: "deterministic" | "pi";
  view: unknown;
  onAudit?: (audit: GOJudgeExecutionAudit) => void;
}

export interface GOJudgeExecutionAudit {
  schemaVersion: "go-evidence-judge-execution-v1";
  requestedMode: "deterministic" | "pi";
  status: "completed" | "failed";
  modelProvider: string;
  modelId: string;
  thinkingLevel: string;
  stats: {
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  failureReason: string | null;
}

export interface GOJudgeBinding {
  view: GOJudgeView;
  /** Host-only reverse map. Never serialize this object into the Pi prompt. */
  tokenToGoId: Record<string, string>;
  /** Host-only evidence-token reverse map. Never serialize it into Pi. */
  evidenceTokenToId: Record<string, string>;
  candidateBudgetMode: "global_ranked_v1" | "aspect_stratified_v1";
}

const ASPECTS = ["molecular_function", "biological_process", "cellular_component", "unknown"] as const;
const VIEW_KEYS = new Set(["schemaVersion", "viewHash", "candidates"]);
const CANDIDATE_KEYS = new Set(["candidateToken", "hypothesisName", "aspect", "evidence"]);
const EVIDENCE_KEYS = new Set(["evidenceId", "channel", "direction", "strength", "independenceGroup"]);
const SUBMISSION_KEYS = new Set(["judgments"]);
const JUDGMENT_KEYS = new Set(["candidateToken", "verdict", "citedEvidenceIds"]);
const RESULT_KEYS = new Set(["schemaVersion", "viewHash", "modeUsed", "decisions"]);
const DECISION_KEYS = new Set(["candidateToken", "verdict", "citedEvidenceIds", "factor"]);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const OPAQUE_CANDIDATE = /^cand_[a-f0-9]{16,64}$/;
const GO_ID = /GO:\d{7}/i;
const SAFE_EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const SAFE_GROUP_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains an unexpected field`);
  }
  for (const key of allowed) {
    if (!(key in value)) throw new Error(`${label} is missing a required field`);
  }
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} is not an allowed enum value`);
  }
}

function assertEvidenceId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_EVIDENCE_ID.test(value) || GO_ID.test(value)) {
    throw new Error(`${label} must be a safe pre-existing evidence identifier without a GO ID`);
  }
}

function validateEvidence(value: unknown, label: string): GOJudgeEvidenceView {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertExactKeys(value, EVIDENCE_KEYS, label);
  assertEvidenceId(value.evidenceId, `${label}.evidenceId`);
  assertEnum(value.channel, GO_JUDGE_CHANNELS, `${label}.channel`);
  assertEnum(value.direction, GO_JUDGE_DIRECTIONS, `${label}.direction`);
  assertEnum(value.strength, GO_JUDGE_STRENGTHS, `${label}.strength`);
  if (typeof value.independenceGroup !== "string" || !SAFE_GROUP_ID.test(value.independenceGroup) || GO_ID.test(value.independenceGroup)) {
    throw new Error(`${label}.independenceGroup must be a safe opaque group identifier`);
  }
  return {
    evidenceId: value.evidenceId,
    channel: value.channel,
    direction: value.direction,
    strength: value.strength,
    independenceGroup: value.independenceGroup,
  };
}

/** Validate the complete closed view before it can be serialized into a prompt. */
export function validateGOJudgeView(value: unknown): GOJudgeView {
  if (!isRecord(value)) throw new Error("GO judge view must be an object");
  assertExactKeys(value, VIEW_KEYS, "GO judge view");
  if (value.schemaVersion !== "go-evidence-judge-view-v1") throw new Error("unsupported GO judge view schema");
  if (typeof value.viewHash !== "string" || !SHA256.test(value.viewHash)) {
    throw new Error("viewHash must be a SHA-256 content hash");
  }
  if (!Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > 128) {
    throw new Error("candidates must contain between 1 and 128 items");
  }

  const candidateTokens = new Set<string>();
  const candidates = value.candidates.map((raw, candidateIndex): GOCandidateJudgeView => {
    const label = `candidate ${candidateIndex}`;
    if (!isRecord(raw)) throw new Error(`${label} must be an object`);
    assertExactKeys(raw, CANDIDATE_KEYS, label);
    if (typeof raw.candidateToken !== "string" || !OPAQUE_CANDIDATE.test(raw.candidateToken)) {
      throw new Error(`${label}.candidateToken must be an opaque cand_<hex> token`);
    }
    if (candidateTokens.has(raw.candidateToken)) throw new Error("candidate tokens must be unique");
    candidateTokens.add(raw.candidateToken);
    if (typeof raw.hypothesisName !== "string"
      || raw.hypothesisName.trim().length < 1
      || raw.hypothesisName.length > 180
      || GO_ID.test(raw.hypothesisName)
      || /(?:https?|file):\/\//i.test(raw.hypothesisName)) {
      throw new Error(`${label}.hypothesisName must be a bounded GO label without an identifier or URL`);
    }
    assertEnum(raw.aspect, ASPECTS, `${label}.aspect`);
    if (!Array.isArray(raw.evidence) || raw.evidence.length < 1 || raw.evidence.length > 32) {
      throw new Error(`${label}.evidence must contain between 1 and 32 items`);
    }
    const evidenceIds = new Set<string>();
    const evidence = raw.evidence.map((item, evidenceIndex) => {
      const validated = validateEvidence(item, `${label}.evidence ${evidenceIndex}`);
      if (evidenceIds.has(validated.evidenceId)) throw new Error(`${label} contains a duplicate evidenceId`);
      evidenceIds.add(validated.evidenceId);
      return validated;
    });
    return { candidateToken: raw.candidateToken, hypothesisName: raw.hypothesisName.trim(), aspect: raw.aspect, evidence };
  });

  const expectedViewHash = `sha256:${hashCanonical({
    schemaVersion: "go-evidence-judge-view-v1",
    candidates,
  })}`;
  if (value.viewHash !== expectedViewHash) throw new Error("GO judge viewHash does not match canonical view content");

  return {
    schemaVersion: "go-evidence-judge-view-v1",
    viewHash: value.viewHash,
    candidates,
  };
}

export function serializeGOJudgeView(value: unknown): string {
  return JSON.stringify(validateGOJudgeView(value));
}

/**
 * Revalidate a Pi tool submission and attach host-computed factors. Every
 * candidate must occur exactly once and every citation must belong to that
 * candidate's input evidence allowlist.
 */
export function validateGOJudgeSubmission(viewValue: unknown, submissionValue: unknown): GOJudgeDecision[] {
  const view = validateGOJudgeView(viewValue);
  if (!isRecord(submissionValue)) throw new Error("GO judge submission must be an object");
  assertExactKeys(submissionValue, SUBMISSION_KEYS, "GO judge submission");
  if (!Array.isArray(submissionValue.judgments) || submissionValue.judgments.length !== view.candidates.length) {
    throw new Error("GO judge submission must contain exactly one judgment per candidate");
  }

  const candidatesByToken = new Map(view.candidates.map((candidate) => [candidate.candidateToken, candidate] as const));
  const seen = new Set<string>();
  const submitted = new Map<string, GOJudgeDecision>();
  for (const [index, raw] of submissionValue.judgments.entries()) {
    const label = `judgment ${index}`;
    if (!isRecord(raw)) throw new Error(`${label} must be an object`);
    assertExactKeys(raw, JUDGMENT_KEYS, label);
    if (typeof raw.candidateToken !== "string" || !candidatesByToken.has(raw.candidateToken)) {
      throw new Error(`${label} contains a non-allowlisted candidate token`);
    }
    if (seen.has(raw.candidateToken)) throw new Error("GO judge submission contains a duplicate candidate token");
    seen.add(raw.candidateToken);
    assertEnum(raw.verdict, GO_JUDGE_VERDICTS, `${label}.verdict`);
    if (!Array.isArray(raw.citedEvidenceIds) || raw.citedEvidenceIds.length < 1 || raw.citedEvidenceIds.length > 12) {
      throw new Error(`${label}.citedEvidenceIds must contain between 1 and 12 items`);
    }
    const allowedEvidence = new Set(candidatesByToken.get(raw.candidateToken)?.evidence.map((item) => item.evidenceId));
    const citedEvidenceIds: string[] = [];
    for (const evidenceId of raw.citedEvidenceIds) {
      assertEvidenceId(evidenceId, `${label}.citedEvidenceIds`);
      if (!allowedEvidence.has(evidenceId)) throw new Error(`${label} cites a non-allowlisted evidence ID`);
      if (citedEvidenceIds.includes(evidenceId)) throw new Error(`${label} contains a duplicate evidence citation`);
      citedEvidenceIds.push(evidenceId);
    }
    submitted.set(raw.candidateToken, {
      candidateToken: raw.candidateToken,
      verdict: raw.verdict,
      citedEvidenceIds,
      factor: GO_JUDGE_FACTORS[raw.verdict],
    });
  }

  // Canonicalize output to input candidate order, independent of model order.
  return view.candidates.map((candidate) => {
    const decision = submitted.get(candidate.candidateToken);
    if (!decision) throw new Error("GO judge submission omitted a candidate token");
    return decision;
  });
}

/** Validate a persisted judge result without trusting model-supplied factors. */
export function validateGOJudgeResult(viewValue: unknown, resultValue: unknown): GOJudgeResult {
  const view = validateGOJudgeView(viewValue);
  if (!isRecord(resultValue)) throw new Error("GO judge result must be an object");
  assertExactKeys(resultValue, RESULT_KEYS, "GO judge result");
  if (resultValue.schemaVersion !== "go-evidence-judge-result-v1") throw new Error("unsupported GO judge result schema");
  if (resultValue.viewHash !== view.viewHash) throw new Error("GO judge result/view hash mismatch");
  if (resultValue.modeUsed !== "deterministic" && resultValue.modeUsed !== "pi") {
    throw new Error("GO judge result has an unsupported modeUsed");
  }
  if (!Array.isArray(resultValue.decisions)) throw new Error("GO judge result decisions must be an array");
  const judgments = resultValue.decisions.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`GO judge result decision ${index} must be an object`);
    assertExactKeys(raw, DECISION_KEYS, `GO judge result decision ${index}`);
    return {
      candidateToken: raw.candidateToken,
      verdict: raw.verdict,
      citedEvidenceIds: raw.citedEvidenceIds,
    };
  });
  const decisions = validateGOJudgeSubmission(view, { judgments });
  const rawByToken = new Map(resultValue.decisions.map((raw) => {
    const item = raw as Record<string, unknown>;
    return [item.candidateToken, item] as const;
  }));
  for (const decision of decisions) {
    const raw = rawByToken.get(decision.candidateToken);
    if (!raw) throw new Error("GO judge result omitted an allowlisted candidate token");
    if (raw.factor !== decision.factor) throw new Error("GO judge result contains a non-host factor");
  }
  return {
    schemaVersion: "go-evidence-judge-result-v1",
    viewHash: view.viewHash,
    modeUsed: resultValue.modeUsed,
    decisions,
  };
}

const STRENGTH_WEIGHT: Readonly<Record<GOJudgeStrength, number>> = {
  weak: 1,
  moderate: 2,
  strong: 3,
};

interface GroupScore {
  support: number;
  contradict: number;
  supportIds: string[];
  contradictIds: string[];
  neutralIds: string[];
}

function deterministicDecision(candidate: GOCandidateJudgeView): GOJudgeDecision {
  const grouped = new Map<string, GroupScore>();
  for (const evidence of candidate.evidence) {
    const group = grouped.get(evidence.independenceGroup) ?? {
      support: 0,
      contradict: 0,
      supportIds: [],
      contradictIds: [],
      neutralIds: [],
    };
    const weight = STRENGTH_WEIGHT[evidence.strength];
    if (evidence.direction === "support") {
      group.support = Math.max(group.support, weight);
      group.supportIds.push(evidence.evidenceId);
    } else if (evidence.direction === "contradict") {
      group.contradict = Math.max(group.contradict, weight);
      group.contradictIds.push(evidence.evidenceId);
    } else {
      group.neutralIds.push(evidence.evidenceId);
    }
    grouped.set(evidence.independenceGroup, group);
  }

  const groups = [...grouped.values()];
  const support = groups.reduce((sum, group) => sum + group.support, 0);
  const contradict = groups.reduce((sum, group) => sum + group.contradict, 0);
  const independentSupport = groups.filter((group) => group.support > 0).length;
  let verdict: GOJudgeVerdict = "uncertain";
  if (support >= 4 && independentSupport >= 2 && support >= contradict + 2) verdict = "support";
  else if (contradict >= 3 && contradict >= support + 1) verdict = "contradict";

  const preferredIds = verdict === "support"
    ? groups.flatMap((group) => group.supportIds)
    : verdict === "contradict"
      ? groups.flatMap((group) => group.contradictIds)
      : candidate.evidence.map((evidence) => evidence.evidenceId);
  const citedEvidenceIds = [...new Set(preferredIds)].slice(0, 12);
  // A non-empty evidence view guarantees a citation even for a neutral-only case.
  if (citedEvidenceIds.length === 0) citedEvidenceIds.push(candidate.evidence[0].evidenceId);
  return {
    candidateToken: candidate.candidateToken,
    verdict,
    citedEvidenceIds,
    factor: GO_JUDGE_FACTORS[verdict],
  };
}

/** Pure fallback used for offline runs and Pi-provider failures at the caller boundary. */
export function judgeGOCandidatesDeterministically(viewValue: unknown): GOJudgeResult {
  const view = validateGOJudgeView(viewValue);
  return {
    schemaVersion: "go-evidence-judge-result-v1",
    viewHash: view.viewHash,
    modeUsed: "deterministic",
    decisions: view.candidates.map(deterministicDecision),
  };
}

const GO_JUDGE_SYSTEM_PROMPT = `You are a bounded evidence-consistency judge in a protein GO prediction pipeline.

You see opaque candidate tokens, bounded hypothesis labels, and categorical evidence only. You do not know, infer, request, or emit GO identifiers, protein identifiers, donor names, annotations, prose, URLs, paths, code, or new evidence identifiers.

For every candidate token, choose exactly one verdict: support, uncertain, or contradict. Support requires concordant evidence from at least two independent groups. Contradict requires material contradictory evidence. Otherwise choose uncertain. Cite only evidence IDs listed under that same candidate. Do not invent identifiers or numeric factors; the host deterministically assigns the factor. Your final and only action must be submit_go_judgments.`;

function providerError(session: Awaited<ReturnType<typeof createAgentSession>>["session"]): string | undefined {
  const last = session.state.messages.at(-1) as unknown as {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
  } | undefined;
  return last?.role === "assistant" && last.stopReason === "error"
    ? last.errorMessage ?? "unknown provider error"
    : undefined;
}

async function runPiGOJudge(input: GOJudgeInput): Promise<GOJudgeResult> {
  const view = validateGOJudgeView(input.view);
  const candidateTokens = view.candidates.map((candidate) => candidate.candidateToken);
  const evidenceIds = [...new Set(view.candidates.flatMap((candidate) => candidate.evidence.map((item) => item.evidenceId)))];
  const candidateLiterals = candidateTokens.map((token) => Type.Literal(token));
  const evidenceLiterals = evidenceIds.map((id) => Type.Literal(id));
  const candidateSchema = candidateLiterals.length === 1
    ? candidateLiterals[0]
    : Type.Union(candidateLiterals as [typeof candidateLiterals[number], typeof candidateLiterals[number], ...typeof candidateLiterals[number][]]);
  const evidenceSchema = evidenceLiterals.length === 1
    ? evidenceLiterals[0]
    : Type.Union(evidenceLiterals as [typeof evidenceLiterals[number], typeof evidenceLiterals[number], ...typeof evidenceLiterals[number][]]);

  let submitted: GOJudgeDecision[] | undefined;
  const submitTool = defineTool({
    name: "submit_go_judgments",
    label: "Submit bounded GO evidence judgments",
    description: "Submit one verdict per allowlisted candidate token with only its pre-existing evidence IDs.",
    promptSnippet: "Submit the bounded candidate judgments",
    promptGuidelines: ["Use submit_go_judgments as the final and only action."],
    parameters: Type.Object(
      {
        judgments: Type.Array(
          Type.Object(
            {
              candidateToken: candidateSchema,
              verdict: Type.Union([
                Type.Literal("support"),
                Type.Literal("uncertain"),
                Type.Literal("contradict"),
              ]),
              citedEvidenceIds: Type.Array(evidenceSchema, { minItems: 1, maxItems: 12, uniqueItems: true }),
            },
            { additionalProperties: false },
          ),
          { minItems: view.candidates.length, maxItems: view.candidates.length },
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params) {
      submitted = validateGOJudgeSubmission(view, params);
      return {
        content: [{ type: "text" as const, text: "Bounded candidate judgments captured." }],
        details: { judgments: submitted },
        terminate: true,
      };
    },
  });

  const loader = new DefaultResourceLoader({
    cwd: input.projectRoot,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => GO_JUDGE_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const { modelRuntime, model } = await resolveDefaultPiModel();
  const { session } = await createAgentSession({
    cwd: input.projectRoot,
    modelRuntime,
    model,
    resourceLoader: loader,
    tools: ["submit_go_judgments"],
    customTools: [submitTool],
    thinkingLevel: "high",
    sessionManager: SessionManager.inMemory(input.projectRoot),
  });
  const emitAudit = (status: "completed" | "failed", failureReason: string | null): void => {
    const stats = session.getSessionStats();
    input.onAudit?.({
      schemaVersion: "go-evidence-judge-execution-v1",
      requestedMode: "pi",
      status,
      modelProvider: session.model?.provider ?? "unknown",
      modelId: session.model?.id ?? "unknown",
      thinkingLevel: session.thinkingLevel,
      stats: {
        userMessages: stats.userMessages,
        assistantMessages: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        totalTokens: stats.tokens.total,
      },
      failureReason,
    });
  };
  try {
    const serialized = serializeGOJudgeView(view);
    await session.prompt(`Judge every candidate in this validated opaque view and call submit_go_judgments.\n\n${serialized}`);
    const firstError = providerError(session);
    if (firstError) throw new Error(`Pi GO evidence judge provider request failed: ${firstError}`);
    if (!submitted) {
      await session.prompt("Call submit_go_judgments now. Use each candidate token exactly once and cite only its listed evidence IDs.");
    }
    const secondError = providerError(session);
    if (secondError) throw new Error(`Pi GO evidence judge provider request failed: ${secondError}`);
    if (!submitted) throw new Error("GO evidence judge did not submit structured judgments after two attempts");
    const result: GOJudgeResult = {
      schemaVersion: "go-evidence-judge-result-v1",
      viewHash: view.viewHash,
      modeUsed: "pi",
      decisions: submitted,
    };
    emitAudit("completed", null);
    return result;
  } catch (error) {
    emitAudit("failed", (error instanceof Error ? error.message : String(error)).slice(0, 500));
    throw error;
  } finally {
    session.dispose();
  }
}

export async function runGOEvidenceJudge(input: GOJudgeInput): Promise<GOJudgeResult> {
  if (input.mode === "deterministic") {
    const result = judgeGOCandidatesDeterministically(input.view);
    input.onAudit?.({
      schemaVersion: "go-evidence-judge-execution-v1",
      requestedMode: "deterministic",
      status: "completed",
      modelProvider: "deterministic",
      modelId: "correlated-evidence-fallback-v1",
      thinkingLevel: "none",
      stats: { userMessages: 0, assistantMessages: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      failureReason: null,
    });
    return result;
  }
  if (input.mode !== "pi") throw new Error("unsupported GO evidence judge mode");
  return runPiGOJudge(input);
}

function judgeChannel(term: GOTermPrediction, support: GOTermPrediction["donorSupports"][number]): GOJudgeChannel {
  if (support.orthologyRelation) return "phylogeny";
  if (support.matchMode === "orthology") return "orthology";
  if (support.matchMode === "sequence" || support.matchMode === "sequence_mapping") return "sequence";
  if (support.matchMode === "domain_mapping" || support.matchMode === "ec_mapping" || support.matchMode === "domain_structure") return "domain";
  if (support.matchMode === "full_structure" || support.matchMode === "local_structure") return "structure";
  return term.candidateOrigin === "ontology_ancestor" ? "ontology" : "sequence";
}

function judgeStrength(value: number): GOJudgeStrength {
  if (value >= 0.55) return "strong";
  if (value >= 0.25) return "moderate";
  return "weak";
}

function safeHypothesisName(value: string): string {
  const sanitized = value
    .replace(/GO:\d{7}/gi, "ontology term")
    .replace(/(?:https?|file):\/\/\S+/gi, "reference")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return sanitized || "ontology hypothesis";
}

function hasCandidateSourceSupport(term: GOTermPrediction): boolean {
  return term.donorSupports.some((support) => support.candidateSourceType !== undefined
    && support.candidateSelectionEligible !== false);
}

function frontierAppliesToTerm(term: GOTermPrediction, prediction: GOPredictionSet): boolean {
  return prediction.selectionPolicyMode === "evidence_frontier_v1"
    && term.aspect !== "unknown"
    && (prediction.selectionPolicyAspects === undefined || prediction.selectionPolicyAspects.includes(term.aspect));
}

function isJudgeCandidate(term: GOTermPrediction, prediction: GOPredictionSet): boolean {
  return hasCandidateSourceSupport(term)
    && (!frontierAppliesToTerm(term, prediction) || term.candidateOrigin !== "ontology_ancestor");
}

/**
 * Build the only view an inner Pi judge may receive. Protein/donor identities,
 * GO IDs, scores, and reverse mappings stay on the deterministic host side.
 */
export function buildGOJudgeBinding(
  prediction: GOPredictionSet,
  maxCandidates = 128,
  candidateBudgetMode: "global_ranked_v1" | "aspect_stratified_v1" = "global_ranked_v1",
): GOJudgeBinding | undefined {
  const bounded = Math.max(1, Math.min(128, Math.floor(maxCandidates)));
  const eligibleCandidates = [...prediction.terms]
    .filter((term) => term.aspect !== "unknown" && isJudgeCandidate(term, prediction))
    .sort((left, right) => Number(right.selected) - Number(left.selected)
      || (right.phylogenyAdjustedScore ?? 0) - (left.phylogenyAdjustedScore ?? 0)
      || left.goId.localeCompare(right.goId));
  const ranked = candidateBudgetMode === "global_ranked_v1"
    ? eligibleCandidates.slice(0, bounded)
    : (["molecular_function", "biological_process", "cellular_component"] as const)
      .flatMap((aspect, index) => {
        const base = Math.floor(bounded / 3);
        const quota = base + (index < bounded % 3 ? 1 : 0);
        return eligibleCandidates.filter((term) => term.aspect === aspect).slice(0, quota);
      });
  if (ranked.length === 0) return undefined;
  const tokenToGoId: Record<string, string> = {};
  const evidenceTokenToId: Record<string, string> = {};
  const candidates = ranked.map((term): GOCandidateJudgeView => {
    const candidateToken = `cand_${hashCanonical({
      genomeHash: prediction.genomeHash,
      proteinId: prediction.proteinId,
      goId: term.goId,
    }).slice(0, 24)}`;
    tokenToGoId[candidateToken] = term.goId;
    const evidenceById = new Map<string, GOJudgeEvidenceView>();
    for (const support of term.donorSupports) {
      // Provider-floor failures remain visible in the host prediction audit,
      // but cannot activate, crowd, or influence the bounded judge.
      if (support.candidateSourceType !== undefined && support.candidateSelectionEligible === false) continue;
      const direction: GOJudgeDirection = support.leafTransferAllowed === false
        ? "contradict"
        : support.candidateSelectionEligible === false ? "neutral" : "support";
      const independenceGroup = `grp_${hashCanonical({ donorGroup: support.donorGroup, roots: support.provenanceRoots }).slice(0, 20)}`;
      const rawEvidence = [
        { id: support.annotationEvidenceId, channel: "ontology" as const, role: "annotation" },
        ...support.matchEvidenceIds.map((id) => ({ id, channel: judgeChannel(term, support), role: "match" })),
      ];
      for (const item of rawEvidence) {
        if (!item.id) continue;
        // The same provider record may legitimately play two bounded roles:
        // an ontology mapping and the sequence/domain/phylogeny observation
        // that produced it. Role-aware opaque tokens preserve both channels,
        // while independenceGroup still prevents them counting as two
        // independent biological observations.
        const evidenceToken = `ev_${hashCanonical({
          genomeHash: prediction.genomeHash,
          proteinId: prediction.proteinId,
          evidenceId: item.id,
          evidenceRole: item.role,
          channel: item.channel,
        }).slice(0, 24)}`;
        evidenceTokenToId[evidenceToken] = item.id;
        if (evidenceById.has(evidenceToken)) continue;
        evidenceById.set(evidenceToken, {
          evidenceId: evidenceToken,
          channel: item.channel,
          direction,
          strength: judgeStrength(support.adjustedSupport),
          independenceGroup,
        });
      }
    }
    if (evidenceById.size === 0) {
      const rawEvidenceId = term.evidenceIds[0];
      if (!rawEvidenceId) throw new Error(`GO candidate ${term.goId} has no evidence identifier for the bounded judge`);
      const evidenceToken = `ev_${hashCanonical({
        genomeHash: prediction.genomeHash,
        proteinId: prediction.proteinId,
        evidenceId: rawEvidenceId,
      }).slice(0, 24)}`;
      evidenceTokenToId[evidenceToken] = rawEvidenceId;
      evidenceById.set(evidenceToken, {
        evidenceId: evidenceToken,
        channel: "ontology",
        direction: "neutral",
        strength: "weak",
        independenceGroup: `grp_${hashCanonical({ evidenceId: rawEvidenceId }).slice(0, 20)}`,
      });
    }
    return {
      candidateToken,
      hypothesisName: safeHypothesisName(term.termName),
      aspect: term.aspect,
      evidence: [...evidenceById.values()].slice(0, 32),
    };
  });
  const viewContent = { schemaVersion: "go-evidence-judge-view-v1" as const, candidates };
  const view: GOJudgeView = { ...viewContent, viewHash: `sha256:${hashCanonical(viewContent)}` };
  validateGOJudgeView(view);
  return { view, tokenToGoId, evidenceTokenToId, candidateBudgetMode };
}

function roundedScore(value: number | null, factor: number): number | null {
  if (value === null) return null;
  return Math.round(Math.max(0, Math.min(1, value * factor)) * 1_000_000) / 1_000_000;
}

/**
 * Preserve the stock DeepGOPlus score while adding a bounded aspect-specific
 * residual from the evidence Agent. Coefficients in [0,1] are convex blends;
 * a coefficient just above 1 is an explicitly signed, development-fitted
 * correction that subtracts a small correlated evidence residual. The fusion
 * cannot mint GO IDs: it only re-scores hypotheses already admitted by the
 * authoritative candidate set.
 */
export function applyGOScoreFusion(input: {
  prediction: GOPredictionSet;
  policy: {
    mode: "disabled" | "deepgoplus_anchor_v1";
    anchorWeights: Record<"molecular_function" | "biological_process" | "cellular_component", number>;
  };
  maxSelectedTermsPerAspect: number;
}): GOPredictionSet {
  if (input.policy.mode === "disabled") return input.prediction;
  const terms = structuredClone(input.prediction.terms);
  for (const term of terms) {
    if (term.aspect === "unknown") continue;
    const evidenceScore = term.judgeAdjustedScore ?? term.phylogenyAdjustedScore ?? 0;
    const deepGoPlusScore = Math.max(0, ...term.donorSupports
      .filter((support) => support.candidateSourceType === "deepgoplus_cnn"
        && support.candidateSelectionEligible !== false)
      .map((support) => support.candidateBaseScore ?? 0));
    const anchorWeight = input.policy.anchorWeights[term.aspect];
    const fused = Math.max(0, Math.min(1,
      anchorWeight * deepGoPlusScore + (1 - anchorWeight) * evidenceScore));
    term.fusionAdjustedScore = Math.round(fused * 1_000_000) / 1_000_000;
    const clearsThreshold = term.fusionAdjustedScore >= input.prediction.thresholds[term.aspect];
    term.selectionBlockers = clearsThreshold
      ? (term.selectionBlockers ?? []).filter((blocker) => blocker !== "below_threshold")
      : [...new Set([...(term.selectionBlockers ?? []), "below_threshold" as const])];
    term.selected = clearsThreshold && !hasGOHardSelectionBlocker(term);
    term.decision = term.selected ? "transfer_hypothesis" : "abstained";
    term.confidenceLabel = term.selected ? "low_heuristic" : "abstained";
    // Keep the operational selector threshold-aware; restore ranked-output
    // eligibility only after the selection budget has been applied.
    term.preBudgetEligible = term.selected;
    term.reasons.push(
      `Aspect-specific DeepGOPlus anchor fusion applied with anchor weight ${anchorWeight.toFixed(2)}.`,
    );
  }
  applyGOSelection({
    terms,
    mode: input.prediction.selectionPolicyMode ?? "disabled",
    frontierAspects: input.prediction.selectionPolicyAspects,
    maxSelectedTermsPerAspect: input.maxSelectedTermsPerAspect,
    phase: "post_judge",
    protectedGoIds: new Set<string>(),
  });
  for (const term of terms) {
    term.preBudgetEligible = !hasGOHardSelectionBlocker(term);
  }
  terms.sort((left, right) => Number(right.selected) - Number(left.selected)
    || (right.fusionAdjustedScore ?? right.judgeAdjustedScore ?? right.phylogenyAdjustedScore ?? 0)
      - (left.fusionAdjustedScore ?? left.judgeAdjustedScore ?? left.phylogenyAdjustedScore ?? 0)
    || left.goId.localeCompare(right.goId));
  const predictedGoIds = [...new Set(terms.filter((term) => term.selected).map((term) => term.goId))].sort();
  const { canonicalHash: _priorHash, ...prior } = input.prediction;
  const content = {
    ...prior,
    methodSummary: `${input.prediction.methodSummary} A development-fitted aspect-specific DeepGOPlus anchor applied a bounded signed correction from the evidence ranking.`,
    scoreFusionStatus: {
      mode: input.policy.mode,
      anchorWeights: input.policy.anchorWeights,
    },
    predictedGoIds,
    terms,
  };
  return { ...content, canonicalHash: hashCanonical(content) };
}

/**
 * Apply a validated inner-agent signal. The model cannot set scores or IDs;
 * it only chooses a fixed host factor. Contradictions can demote, while a
 * support verdict may promote only a near-threshold term with no hard gate.
 */
export function applyGOJudgeResult(input: {
  prediction: GOPredictionSet;
  binding: GOJudgeBinding;
  result: GOJudgeResult;
  maxSelectedTermsPerAspect: number;
  requestedMode: "deterministic" | "pi";
  candidateRetentionMode?: "fail_closed_v1" | "preserve_ranked_evidence_v1";
  fallbackReason?: string | null;
}): GOPredictionSet {
  if (input.result.viewHash !== input.binding.view.viewHash) throw new Error("GO judge result/view binding mismatch");
  const validatedResult = validateGOJudgeResult(input.binding.view, input.result);
  const validatedDecisions = validatedResult.decisions;
  const decisionsByGoId = new Map(validatedDecisions.map((decision) => {
    const goId = input.binding.tokenToGoId[decision.candidateToken];
    if (!goId) throw new Error("GO judge host reverse map is incomplete");
    return [goId, decision] as const;
  }));
  const terms = structuredClone(input.prediction.terms);
  const retentionMode = input.candidateRetentionMode ?? "fail_closed_v1";
  const protectedGoIds = new Set(terms.filter((term) => term.selected
    && term.candidateOrigin !== "ontology_ancestor"
    && !hasCandidateSourceSupport(term)).map((term) => term.goId));
  for (const term of terms) {
    // The optional judge is scoped to hypotheses introduced or supported by a
    // candidate source. Direct-only baseline selections remain host decisions.
    if (!isJudgeCandidate(term, input.prediction)) continue;
    const decision = decisionsByGoId.get(term.goId);
    if (!decision) {
      if (retentionMode === "preserve_ranked_evidence_v1") {
        term.selectionBlockers = (term.selectionBlockers ?? []).filter((blocker) => blocker !== "judge_candidate_budget");
        term.reasons.push("The bounded GO evidence judge did not cover this hypothesis; its admissible evidence-derived score was retained in the ranked evaluation output without an Agent verdict.");
        continue;
      }
      term.selectionBlockers = [...new Set([...(term.selectionBlockers ?? []), "judge_candidate_budget" as const])];
      if (term.selected) {
        term.selected = false;
        term.decision = "abstained";
        term.confidenceLabel = "abstained";
        term.reasons.push("The bounded GO evidence judge did not cover this selected term within its candidate budget; it was fail-closed to abstention.");
      }
      continue;
    }
    term.selectionBlockers = (term.selectionBlockers ?? []).filter((blocker) => blocker !== "judge_candidate_budget");
    term.judgeAdjustedScore = roundedScore(term.phylogenyAdjustedScore, decision.factor);
    const citedEvidenceIds = [...new Set(decision.citedEvidenceIds.map((token) => {
      const evidenceId = input.binding.evidenceTokenToId[token];
      if (!evidenceId) throw new Error("GO judge host evidence reverse map is incomplete");
      return evidenceId;
    }))];
    term.agentJudgment = {
      candidateToken: decision.candidateToken,
      verdict: decision.verdict,
      factor: decision.factor,
      citedEvidenceIds,
    };
    const threshold = term.aspect === "unknown" ? 1 : input.prediction.thresholds[term.aspect];
    const clearsThreshold = (term.judgeAdjustedScore ?? 0) >= threshold;
    term.selectionBlockers = clearsThreshold
      ? (term.selectionBlockers ?? []).filter((blocker) => blocker !== "below_threshold")
      : [...new Set([...(term.selectionBlockers ?? []), "below_threshold" as const])];
    const selected = decision.verdict === "support"
      ? clearsThreshold && !hasGOHardSelectionBlocker(term)
      : decision.verdict === "uncertain"
        ? term.selected && clearsThreshold
        : false;
    term.selected = selected;
    term.decision = selected ? "transfer_hypothesis" : "abstained";
    term.confidenceLabel = selected ? "low_heuristic" : "abstained";
    term.reasons.push(`Bounded GO evidence judge verdict ${decision.verdict}; deterministic host factor ${decision.factor.toFixed(2)} was applied.`);
  }
  for (const term of terms) {
    // Only hypotheses in the judge's candidate-source scope acquire a new
    // post-judge eligibility decision.  Direct-only baseline terms keep their
    // pre-judge eligibility even when a candidate in another GO aspect causes
    // the optional judge to run.  Otherwise activating (for example) a BP-only
    // learned channel silently removes MF/CC terms from CAFA threshold sweeps.
    if (isJudgeCandidate(term, input.prediction)
      && (!frontierAppliesToTerm(term, input.prediction) || term.candidateOrigin !== "ontology_ancestor")) {
      // Operational selection still obeys the aspect threshold. Ranked-output
      // retention is applied only after the selector has finished, so a
      // scoreable low-ranked hypothesis cannot become an operational claim.
      term.preBudgetEligible = term.selected;
    }
  }
  applyGOSelection({
    terms,
    mode: input.prediction.selectionPolicyMode ?? "disabled",
    frontierAspects: input.prediction.selectionPolicyAspects,
    maxSelectedTermsPerAspect: input.maxSelectedTermsPerAspect,
    phase: "post_judge",
    protectedGoIds,
  });
  if (retentionMode === "preserve_ranked_evidence_v1") {
    for (const term of terms) {
      if (isJudgeCandidate(term, input.prediction)
        && (!frontierAppliesToTerm(term, input.prediction) || term.candidateOrigin !== "ontology_ancestor")) {
        term.preBudgetEligible = !hasGOHardSelectionBlocker(term);
      }
    }
  }
  terms.sort((left, right) => Number(right.selected) - Number(left.selected)
    || (right.judgeAdjustedScore ?? right.phylogenyAdjustedScore ?? 0)
      - (left.judgeAdjustedScore ?? left.phylogenyAdjustedScore ?? 0)
    || left.goId.localeCompare(right.goId));
  const predictedGoIds = [...new Set(terms.filter((term) => term.selected).map((term) => term.goId))].sort();
  const selectedCandidateTerms = terms.filter((term) => term.selected
    && term.donorSupports.some((support) => support.candidateSourceType !== undefined
      && support.candidateSelectionEligible !== false));
  const sourceStats = input.prediction.candidateSources.sourceStats?.map((stats) => ({
    ...stats,
    selectedTerms: selectedCandidateTerms.filter((term) => term.donorSupports
      .some((support) => support.candidateSourceType === stats.sourceType
        && support.candidateSelectionEligible !== false)).length,
  }));
  const decisionHash = hashCanonical(validatedDecisions);
  const { canonicalHash: _priorHash, ...prior } = input.prediction;
  const content = {
    ...prior,
    methodSummary: `${input.prediction.methodSummary} A bounded inner GO evidence judge reviewed opaque allowlisted candidates; it could not create GO IDs or numeric weights.`,
    candidateSources: {
      ...input.prediction.candidateSources,
      selectedCandidateTermCount: selectedCandidateTerms.length,
      ...(sourceStats ? { sourceStats } : {}),
    },
    goJudgeStatus: {
      requestedMode: input.requestedMode,
      modeUsed: validatedResult.modeUsed,
      viewHash: input.binding.view.viewHash,
      decisionHash,
      judgedCandidateCount: validatedDecisions.length,
      ...(input.binding.candidateBudgetMode === "aspect_stratified_v1"
        ? { candidateBudgetMode: input.binding.candidateBudgetMode }
        : {}),
      ...(retentionMode === "preserve_ranked_evidence_v1"
        ? { candidateRetentionMode: retentionMode }
        : {}),
      fallbackReason: input.fallbackReason ?? null,
    },
    phylogenyStatus: {
      ...input.prediction.phylogenyStatus,
      selectedLineageWeightedSupportCount: terms.filter((term) => term.selected)
        .flatMap((term) => term.donorSupports)
        .filter((support) => support.lineageStatus === "applied").length,
    },
    predictedGoIds,
    terms,
  };
  return { ...content, canonicalHash: hashCanonical(content) };
}
