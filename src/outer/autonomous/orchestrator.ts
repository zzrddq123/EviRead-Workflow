import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { canonicalJson, hashCanonical } from "../../hash.js";
import { initializeExperimentStore, readExperimentRecords, verifyExperimentStore } from "../../experiment/store.js";
import { freezeLoopExperiment, recordLoopEvaluation, recordLoopPrecommit, recordLoopResource } from "../../experiment/loop_adapter.js";
import {
  applyAutonomousCandidateGraphStage,
  assertAutonomousCandidateGraph,
  autonomousCandidateFromGraph,
  initialAutonomousCandidateGraph,
  type AutonomousRsiCandidateGraph,
} from "./candidate_graph.js";
import {
  assertAutonomousHistoryContext,
  createAutonomousHistoryContext,
  resetAutonomousHistoryContext,
  shuffledAutonomousHistoryContext,
  type AutonomousRsiHistoryContext,
  type AutonomousRsiHistoryRecord,
} from "./history_context.js";
import {
  AUTONOMOUS_RSI_STAGES,
  assertAutonomousCandidate,
  assertAutonomousRsiSpec,
  assertAutonomousStageOutput,
  autonomousStageRole,
  metricImproved,
  projectAutonomousRsiCandidateLifecycle,
  withAutonomousCanonicalHash,
  type AutonomousRsiCandidate,
  type AutonomousRsiEvent,
  type AutonomousRsiFailureClass,
  type AutonomousRsiFormalHandoff,
  type AutonomousRsiKnowledgeEntry,
  type AutonomousRsiKnowledgeIndex,
  type AutonomousRsiRecoveryReceipt,
  type AutonomousRsiHistoricalSeed,
  type AutonomousRsiSpec,
  type AutonomousRsiStage,
  type AutonomousRsiStageInput,
  type AutonomousRsiStageOutput,
  type AutonomousRsiState,
  type AutonomousRsiWorkerSpec,
} from "./contracts.js";


export interface AutonomousRsiWorkerRequest {
  campaignDir: string;
  projectRoot: string;
  iteration: number;
  stage: AutonomousRsiStage;
  attempt: number;
  inputPath: string;
  outputPath: string;
  stdoutPath: string;
  stderrPath: string;
  worker: AutonomousRsiWorkerSpec;
}

export type AutonomousRsiWorkerRunner = (request: AutonomousRsiWorkerRequest) => Promise<number>;

export interface AutonomousRsiRunResult {
  state: AutonomousRsiState;
  transitions: number;
}

function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  await rename(temporary, path);
}

async function writeOrVerifyJson(path: string, value: unknown, label: string): Promise<void> {
  if (await exists(path)) {
    const stored = await readJson(path);
    if (canonicalJson(stored) !== canonicalJson(value)) throw new Error(`existing ${label} conflicts with this run`);
    return;
  }
  await writeJsonAtomic(path, value);
}

function canonicalRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const item = value as Record<string, unknown>;
  const { canonicalHash, ...content } = item;
  if (typeof canonicalHash !== "string" || canonicalHash !== hashCanonical(content)) throw new Error(`${label} canonical hash mismatch`);
  return item;
}

function statePath(campaignDir: string): string {
  return join(campaignDir, "state.json");
}

function specPath(campaignDir: string): string {
  return join(campaignDir, "spec.json");
}

function knowledgeIndexPath(campaignDir: string): string {
  return join(campaignDir, "knowledge", "index.json");
}

function handoffPath(campaignDir: string): string {
  return join(campaignDir, "formal_handoff.json");
}

function candidateGraphPath(campaignDir: string): string {
  return join(campaignDir, "exploration", "candidate_graph.json");
}

function historyContextPath(campaignDir: string, iteration: number, stage: AutonomousRsiStage): string {
  return join(campaignDir, "history", "contexts", `${String(iteration).padStart(4, "0")}-${stage}.json`);
}

function iterationName(iteration: number): string {
  return String(iteration).padStart(4, "0");
}

function stageRoot(campaignDir: string, iteration: number, stage: AutonomousRsiStage): string {
  return join(campaignDir, "iterations", iterationName(iteration), stage);
}

function stageInputPath(campaignDir: string, iteration: number, stage: AutonomousRsiStage): string {
  return join(stageRoot(campaignDir, iteration, stage), "input.json");
}

function stageResultPath(campaignDir: string, iteration: number, stage: AutonomousRsiStage): string {
  return join(stageRoot(campaignDir, iteration, stage), "result.json");
}

function attemptRoot(campaignDir: string, iteration: number, stage: AutonomousRsiStage, attempt: number): string {
  return join(stageRoot(campaignDir, iteration, stage), "attempts", String(attempt).padStart(3, "0"));
}

function recoveryRoot(campaignDir: string): string {
  return join(campaignDir, "recoveries");
}

function recoveryReceiptPath(campaignDir: string, iteration: number, stage: AutonomousRsiStage, attempt: number): string {
  return join(recoveryRoot(campaignDir), `${iterationName(iteration)}-${stage}-attempt-${String(attempt).padStart(3, "0")}.json`);
}

function relativeCampaignPath(campaignDir: string, path: string): string {
  const output = relative(campaignDir, path);
  if (!output || output.startsWith("..") || resolve(campaignDir, output) !== resolve(path)) throw new Error("autonomous artifact escapes the campaign directory");
  return output.split(sep).join("/");
}

function assertState(value: unknown, spec: AutonomousRsiSpec): AutonomousRsiState {
  const item = canonicalRecord(value, "autonomous RSI state") as unknown as AutonomousRsiState;
  if (item.schemaVersion !== "pi-autonomous-rsi-state.v1" || item.campaignId !== spec.campaignId || item.specHash !== spec.canonicalHash) {
    throw new Error("autonomous RSI state does not bind the stored spec");
  }
  if (!["initialized", "running", "stopped", "completed", "failed"].includes(item.status)) {
    throw new Error("autonomous RSI state status is invalid");
  }
  if (!Number.isInteger(item.nextIteration) || item.nextIteration < 1 || !AUTONOMOUS_RSI_STAGES.includes(item.nextStage)) {
    throw new Error("autonomous RSI state cursor is invalid");
  }
  assertAutonomousCandidate(item.currentCandidate, "state.currentCandidate");
  if (!Number.isInteger(item.plateauRounds) || item.plateauRounds < 0) throw new Error("state plateauRounds is invalid");
  if (!item.attempts || typeof item.attempts !== "object" || Array.isArray(item.attempts)) throw new Error("state attempts are invalid");
  for (const [stage, count] of Object.entries(item.attempts)) {
    if (!AUTONOMOUS_RSI_STAGES.includes(stage as AutonomousRsiStage)
      || !Number.isInteger(count) || Number(count) < 1 || Number(count) > spec.budget.maxStageAttempts) {
      throw new Error("state attempts contain an invalid stage or count");
    }
  }
  if (item.bestMetric !== null) {
    if (item.bestMetric.metricId !== spec.objective.metricId
      || !Number.isFinite(item.bestMetric.value)
      || !Number.isInteger(item.bestMetric.iteration)
      || item.bestMetric.iteration < 1) {
      throw new Error("state bestMetric is invalid");
    }
    assertAutonomousCandidate(item.bestMetric.candidate, "state.bestMetric.candidate");
  }
  for (const [label, candidate] of [["lastError", item.lastError], ["stopReason", item.stopReason]] as const) {
    if (candidate !== null && (typeof candidate !== "string" || candidate.length < 1 || candidate.length > 4000)) {
      throw new Error(`state ${label} is invalid`);
    }
  }
  if (item.lastFailureClass !== undefined
    && item.lastFailureClass !== null
    && !["candidate", "framework", "policy"].includes(item.lastFailureClass)) {
    throw new Error("state lastFailureClass is invalid");
  }
  if (item.recoveryReceipts !== undefined) {
    if (!Array.isArray(item.recoveryReceipts) || item.recoveryReceipts.length > 256) {
      throw new Error("state recoveryReceipts are invalid");
    }
    item.recoveryReceipts.forEach((receipt, index) => {
      const { canonicalHash, ...content } = receipt;
      if (receipt.schemaVersion !== "pi-autonomous-rsi-recovery.v1"
        || !Number.isInteger(receipt.iteration) || receipt.iteration < 1
        || !AUTONOMOUS_RSI_STAGES.includes(receipt.stage)
        || !Number.isInteger(receipt.attempt) || receipt.attempt < 1
        || typeof receipt.inputPath !== "string" || receipt.inputPath.startsWith("/")
        || typeof receipt.sourceAttemptPath !== "string" || receipt.sourceAttemptPath.startsWith("/")
        || typeof receipt.resultPath !== "string" || receipt.resultPath.startsWith("/")
        || receipt.inputPath.split("/").includes("..")
        || receipt.sourceAttemptPath.split("/").includes("..")
        || receipt.resultPath.split("/").includes("..")
        || !/^[a-f0-9]{64}$/.test(receipt.inputHash)
        || !/^[a-f0-9]{64}$/.test(receipt.sourceOutputHash)
        || !/^[a-f0-9]{64}$/.test(receipt.resultHash)
        || !["candidate", "framework", "policy"].includes(receipt.classification)
        || receipt.reason !== "worker_output_promoted_after_controller_interruption"
        || typeof receipt.recoveredAt !== "string"
        || canonicalHash !== hashCanonical(content)) {
        throw new Error(`state recovery receipt ${index + 1} is invalid`);
      }
    });
  }
  if (item.handoffHash !== null && !/^[a-f0-9]{64}$/.test(item.handoffHash)) throw new Error("state handoffHash is invalid");
  if (!Array.isArray(item.events)) throw new Error("autonomous RSI state events are invalid");
  let previous: string | null = null;
  item.events.forEach((event, index) => {
    const { eventHash, ...content } = event;
    if (event.schemaVersion !== "pi-autonomous-rsi-event.v1"
      || event.sequence !== index + 1
      || !Number.isInteger(event.iteration) || event.iteration < 1
      || !AUTONOMOUS_RSI_STAGES.includes(event.stage)
      || !Number.isInteger(event.attempt) || event.attempt < 1
      || typeof event.inputPath !== "string" || typeof event.outputPath !== "string"
      || event.inputPath.startsWith("/") || event.outputPath.startsWith("/")
      || event.inputPath.split("/").includes("..") || event.outputPath.split("/").includes("..")
      || !/^[a-f0-9]{64}$/.test(event.inputHash) || !/^[a-f0-9]{64}$/.test(event.outputHash)
      || event.previousEventHash !== previous || eventHash !== hashCanonical(content)) {
      throw new Error(`autonomous RSI event ${index + 1} chain is invalid`);
    }
    previous = eventHash;
  });
  if (item.eventHeadHash !== previous) throw new Error("state event head does not match the event chain");
  if (item.knowledgeHeadHash !== null && !/^[a-f0-9]{64}$/.test(item.knowledgeHeadHash)) {
    throw new Error("state knowledge head is invalid");
  }
  const terminal = ["stopped", "completed", "failed"].includes(item.status);
  if (terminal !== (item.handoffHash !== null) || terminal !== (item.stopReason !== null)) {
    throw new Error("state terminal status, stop reason, and handoff hash are inconsistent");
  }
  return item;
}

function initialState(spec: AutonomousRsiSpec): AutonomousRsiState {
  const historicalBest = (spec.historicalSeeds ?? []).reduce<AutonomousRsiHistoricalSeed | null>((incumbent, seed) => {
    if (!incumbent) return seed;
    return spec.objective.direction === "maximize"
      ? seed.evaluation.value > incumbent.evaluation.value ? seed : incumbent
      : seed.evaluation.value < incumbent.evaluation.value ? seed : incumbent;
  }, null);
  return withAutonomousCanonicalHash({
    schemaVersion: "pi-autonomous-rsi-state.v1" as const,
    campaignId: spec.campaignId,
    specHash: spec.canonicalHash,
    status: "initialized" as const,
    nextIteration: 1,
    nextStage: "evaluate" as const,
    currentCandidate: spec.initialCandidate,
    bestMetric: historicalBest ? {
      metricId: historicalBest.evaluation.metricId,
      value: historicalBest.evaluation.value,
      iteration: historicalBest.evaluation.iteration,
      candidate: { ...historicalBest.candidate, candidateId: historicalBest.seedId },
    } : null,
    plateauRounds: 0,
    attempts: {},
    lastError: null,
    lastFailureClass: null,
    recoveryReceipts: [],
    events: [],
    eventHeadHash: null,
    knowledgeHeadHash: null,
    stopReason: null,
    handoffHash: null,
  });
}

function initialKnowledge(spec: AutonomousRsiSpec): AutonomousRsiKnowledgeIndex {
  return withAutonomousCanonicalHash({
    schemaVersion: "pi-autonomous-rsi-knowledge-index.v1" as const,
    campaignId: spec.campaignId,
    specHash: spec.canonicalHash,
    entries: [],
    headEntryHash: null,
  });
}

export async function initializeAutonomousRsiCampaign(input: {
  campaignDir: string;
  spec: unknown;
}): Promise<AutonomousRsiState> {
  const campaignDir = resolve(input.campaignDir);
  if (!input.spec || typeof input.spec !== "object" || Array.isArray(input.spec)) {
    throw new Error("autonomous RSI spec must be an object");
  }
  const supplied = input.spec as Record<string, unknown>;
  const sealed = supplied.canonicalHash === undefined
    ? withAutonomousCanonicalHash(supplied)
    : supplied;
  const spec = assertAutonomousRsiSpec(sealed);
  if (await exists(statePath(campaignDir))) {
    const storedSpec = assertAutonomousRsiSpec(await readJson(specPath(campaignDir)));
    if (storedSpec.canonicalHash !== spec.canonicalHash) throw new Error("campaign already exists with a different autonomous RSI spec");
    return assertState(await readJson(statePath(campaignDir)), storedSpec);
  }
  if (await exists(campaignDir)) {
    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(campaignDir));
    if (entries.length > 0) throw new Error("autonomous RSI campaign directory already exists and is not initialized");
  }
  await mkdir(campaignDir, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(specPath(campaignDir), spec);
  if (spec.experiment) await initializeExperimentStore(campaignDir, spec.experiment);
  await writeJsonAtomic(knowledgeIndexPath(campaignDir), initialKnowledge(spec));
  await writeJsonAtomic(candidateGraphPath(campaignDir), initialAutonomousCandidateGraph(spec));
  const state = initialState(spec);
  await writeJsonAtomic(statePath(campaignDir), state);
  return state;
}

async function loadCampaign(campaignDirInput: string): Promise<{ campaignDir: string; spec: AutonomousRsiSpec; state: AutonomousRsiState }> {
  const campaignDir = resolve(campaignDirInput);
  const spec = assertAutonomousRsiSpec(await readJson(specPath(campaignDir)));
  const state = assertState(await readJson(statePath(campaignDir)), spec);
  return { campaignDir, spec, state };
}

function priorStages(stage: AutonomousRsiStage): AutonomousRsiStage[] {
  return AUTONOMOUS_RSI_STAGES.slice(0, AUTONOMOUS_RSI_STAGES.indexOf(stage));
}

async function replayCandidateGraph(input: {
  campaignDir: string;
  spec: AutonomousRsiSpec;
  state: AutonomousRsiState;
}): Promise<{
  graph: AutonomousRsiCandidateGraph;
  records: AutonomousRsiHistoryRecord[];
}> {
  let graph = initialAutonomousCandidateGraph(input.spec);
  let activeCandidate = input.spec.initialCandidate;
  const records: AutonomousRsiHistoryRecord[] = [];
  for (const event of input.state.events) {
    const decision = graph.baseDecisions.find((item) => item.iteration === event.iteration);
    const baseCandidate = decision
      ? autonomousCandidateFromGraph(graph, decision.baseCandidateId)
      : undefined;
    const output = assertAutonomousStageOutput(
      await readJson(join(input.campaignDir, event.outputPath)),
      {
        campaignId: input.spec.campaignId,
        iteration: event.iteration,
        stage: event.stage,
        spec: input.spec,
        candidate: activeCandidate,
        ...(baseCandidate ? { baseCandidate } : {}),
      },
    );
    graph = applyAutonomousCandidateGraphStage({
      graph,
      output,
      currentCandidate: activeCandidate,
      spec: input.spec,
    });
    records.push({
      iteration: event.iteration,
      stage: event.stage,
      status: output.status,
      summary: output.summary,
      payload: structuredClone(output.payload),
      outputHash: output.canonicalHash,
    });
    if (event.stage === "verify" && output.status === "completed" && output.payload.passed === true) {
      activeCandidate = outputCandidate(output);
    }
  }
  graph = assertAutonomousCandidateGraph(graph, input.spec);
  await writeJsonAtomic(candidateGraphPath(input.campaignDir), graph);
  return { graph, records };
}

async function validateCandidateGraphResult(input: {
  campaignDir: string;
  spec: AutonomousRsiSpec;
  currentCandidate: AutonomousRsiCandidate;
  output: AutonomousRsiStageOutput;
}): Promise<void> {
  const graph = assertAutonomousCandidateGraph(
    await readJson(candidateGraphPath(input.campaignDir)) as AutonomousRsiCandidateGraph,
    input.spec,
  );
  applyAutonomousCandidateGraphStage({
    graph,
    output: input.output,
    currentCandidate: input.currentCandidate,
    spec: input.spec,
  });
}

function selectedBaseForIteration(
  graph: AutonomousRsiCandidateGraph,
  iteration: number,
): AutonomousRsiCandidate | null {
  const decision = graph.baseDecisions.find((item) => item.iteration === iteration);
  return decision ? autonomousCandidateFromGraph(graph, decision.baseCandidateId) : null;
}

async function loadExistingStageInput(
  path: string,
  expected: { campaignId: string; iteration: number; stage: AutonomousRsiStage; candidate: AutonomousRsiCandidate; spec: AutonomousRsiSpec },
): Promise<AutonomousRsiStageInput | undefined> {
  if (!(await exists(path))) return undefined;
  const item = canonicalRecord(await readJson(path), `${expected.stage} input`) as unknown as AutonomousRsiStageInput;
  if (item.schemaVersion !== "pi-autonomous-rsi-stage-input.v1"
    || item.campaignId !== expected.campaignId
    || item.iteration !== expected.iteration
    || item.stage !== expected.stage
    || canonicalJson(item.currentCandidate) !== canonicalJson(expected.candidate)) {
    throw new Error(`existing ${expected.stage} input does not bind the active stage`);
  }
  if (item.historyContext) {
    const historyPath = resolve(dirname(path), "..", "..", "..", item.historyContext.relativePath);
    const history = assertAutonomousHistoryContext(
      await readJson(historyPath) as AutonomousRsiHistoryContext,
      expected.spec,
    );
    if (history.canonicalHash !== item.historyContext.canonicalHash) {
      throw new Error(`existing ${expected.stage} input history binding mismatch`);
    }
  }
  return item;
}

async function buildStageInput(input: {
  campaignDir: string;
  spec: AutonomousRsiSpec;
  state: AutonomousRsiState;
}): Promise<AutonomousRsiStageInput> {
  const frozenPath = stageInputPath(input.campaignDir, input.state.nextIteration, input.state.nextStage);
  const existing = await loadExistingStageInput(frozenPath, {
    campaignId: input.spec.campaignId,
    iteration: input.state.nextIteration,
    stage: input.state.nextStage,
    candidate: input.state.currentCandidate,
    spec: input.spec,
  });
  if (existing) return existing;

  const replay = await replayCandidateGraph(input);
  const selectedBaseCandidate = selectedBaseForIteration(replay.graph, input.state.nextIteration);
  const sourceArtifacts: AutonomousRsiStageInput["sourceArtifacts"] = {};
  const repairOf = input.state.repairOf;
  if (repairOf && input.state.nextStage === "verify") {
    const planPath = stageResultPath(input.campaignDir, repairOf.planIteration ?? repairOf.failedIteration, "plan");
    const failedVerifyPath = stageResultPath(input.campaignDir, repairOf.failedIteration, "verify");
    const developPath = stageResultPath(input.campaignDir, input.state.nextIteration, "develop");
    for (const [stage, path] of [["plan", planPath], ["verify", failedVerifyPath], ["develop", developPath]] as const) {
      if (!(await exists(path))) throw new Error(`missing repair ${stage} result`);
      const value = await readJson(path) as { canonicalHash: string };
      sourceArtifacts[stage] = { relativePath: relativeCampaignPath(input.campaignDir, path), canonicalHash: value.canonicalHash };
    }
  } else if (input.state.nextStage === "develop" && repairOf) {
    const failedVerifyPath = stageResultPath(input.campaignDir, repairOf.failedIteration, "verify");
    if (!(await exists(failedVerifyPath))) throw new Error("missing failed verification result for automatic repair");
    const failedVerify = assertAutonomousStageOutput(await readJson(failedVerifyPath), {
      campaignId: input.spec.campaignId,
      iteration: repairOf.failedIteration,
      stage: "verify",
      spec: input.spec,
      candidate: repairOf.failedCandidate,
      baseCandidate: input.state.currentCandidate,
    });
    sourceArtifacts.plan = {
      relativePath: relativeCampaignPath(input.campaignDir, stageResultPath(input.campaignDir, repairOf.planIteration ?? repairOf.failedIteration, "plan")),
      canonicalHash: (await readJson(stageResultPath(input.campaignDir, repairOf.planIteration ?? repairOf.failedIteration, "plan")) as { canonicalHash: string }).canonicalHash,
    };
    sourceArtifacts.verify = {
      relativePath: relativeCampaignPath(input.campaignDir, failedVerifyPath),
      canonicalHash: failedVerify.canonicalHash,
    };
  } else {
    for (const stage of priorStages(input.state.nextStage)) {
      const path = stageResultPath(input.campaignDir, input.state.nextIteration, stage);
      if (!(await exists(path))) throw new Error(`missing prior ${stage} result for iteration ${input.state.nextIteration}`);
      const result = assertAutonomousStageOutput(await readJson(path), {
        campaignId: input.spec.campaignId,
        iteration: input.state.nextIteration,
        stage,
        spec: input.spec,
        candidate: input.state.currentCandidate,
        ...(selectedBaseCandidate ? { baseCandidate: selectedBaseCandidate } : {}),
      });
      sourceArtifacts[stage] = {
        relativePath: relativeCampaignPath(input.campaignDir, path),
        canonicalHash: result.canonicalHash,
      };
    }
  }
  let history = createAutonomousHistoryContext({
    spec: input.spec,
    graph: replay.graph,
    iteration: input.state.nextIteration,
    stage: input.state.nextStage,
    currentCandidate: input.state.currentCandidate,
    selectedBaseCandidate,
    records: replay.records,
  });
  if (input.spec.experiment?.historyPolicy === "reset") {
    history = resetAutonomousHistoryContext(history, input.spec);
  } else if (input.spec.experiment?.historyPolicy === "shuffled") {
    const artifactPath = join(input.campaignDir, "experiment", "shuffled-history.json");
    if (!(await exists(artifactPath))) throw new Error("shuffled-history condition requires experiment/shuffled-history.json before the first stage");
    history = shuffledAutonomousHistoryContext(history, await readJson(artifactPath), input.spec);
  }
  const historyPath = historyContextPath(input.campaignDir, input.state.nextIteration, input.state.nextStage);
  await writeOrVerifyJson(historyPath, history, `${input.state.nextStage} history context`);
  return withAutonomousCanonicalHash({
    schemaVersion: "pi-autonomous-rsi-stage-input.v1" as const,
    campaignId: input.spec.campaignId,
    iteration: input.state.nextIteration,
    stage: input.state.nextStage,
    currentCandidate: input.state.currentCandidate,
    selectedBaseCandidate,
    objective: input.spec.objective,
    knowledgeHeadHash: input.state.knowledgeHeadHash,
    historyContext: {
      relativePath: relativeCampaignPath(input.campaignDir, historyPath),
      canonicalHash: history.canonicalHash,
    },
    sourceArtifacts,
    ...(repairOf ? {
      repairContext: {
        failedIteration: repairOf.failedIteration,
        ...(repairOf.planIteration !== undefined ? { planIteration: repairOf.planIteration } : {}),
        failedCandidate: repairOf.failedCandidate,
        verification: sourceArtifacts.verify!,
        instruction: "repair_verification_failure_then_reverify" as const,
      },
    } : {}),
    ...(input.spec.experiment ? { experimentContext: {
      manifestHash: input.spec.experiment.canonicalHash,
      experimentId: input.spec.experiment.experimentId,
      conditionId: input.spec.experiment.conditionId,
      replicateId: input.spec.experiment.replicateId,
      blockId: input.spec.experiment.blockId,
      phase: input.spec.experiment.phase,
      feedbackPolicy: input.spec.experiment.feedbackPolicy,
      historyPolicy: input.spec.experiment.historyPolicy as "reset" | "persistent" | "shuffled",
      targetValidUpdates: input.spec.experiment.budget.targetValidUpdates,
      maxPatchAttempts: input.spec.experiment.budget.maxPatchAttempts,
    } } : {}),
  });
}

function replaceTokens(value: string, request: AutonomousRsiWorkerRequest): string {
  const replacements: Record<string, string> = {
    "{{input}}": request.inputPath,
    "{{output}}": request.outputPath,
    "{{campaign}}": request.campaignDir,
    "{{project}}": request.projectRoot,
    "{{iteration}}": String(request.iteration),
    "{{stage}}": request.stage,
    "{{attempt}}": String(request.attempt),
  };
  return Object.entries(replacements).reduce((output, [token, replacement]) => output.replaceAll(token, replacement), value);
}

export async function runAutonomousRsiWorker(request: AutonomousRsiWorkerRequest): Promise<number> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    PI_AUTONOMOUS_RSI_INPUT: request.inputPath,
    PI_AUTONOMOUS_RSI_OUTPUT: request.outputPath,
    PI_AUTONOMOUS_RSI_CAMPAIGN: request.campaignDir,
    PI_AUTONOMOUS_RSI_PROJECT_ROOT: request.projectRoot,
    PI_AUTONOMOUS_RSI_ITERATION: String(request.iteration),
    PI_AUTONOMOUS_RSI_STAGE: request.stage,
    PI_AUTONOMOUS_RSI_ROLE: autonomousStageRole(request.stage),
    PI_AUTONOMOUS_RSI_NETWORK_ACCESS: request.worker.networkAccess,
  };
  for (const name of new Set([
    ...request.worker.inheritEnv,
    // Preserve the Codex transport for historical worker contracts as well.
    "CODEX_HOME", "CHATGPT_BASE_URL", "OPENAI_CHATGPT_BASE_URL",
    "CODEX_OPENAI_BASE_URL", "CODEX_CHATGPT_BASE_URL", "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
  ])) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  let command = replaceTokens(request.worker.command, request);
  const args = request.worker.args.map((item) => replaceTokens(item, request));
  let cwd = request.worker.workingDirectory === "project" ? request.projectRoot : request.campaignDir;
  // Existing sealed specs contain the historical launcher path. Resolve that
  // launcher to the immutable campaign-owned framework snapshot before any
  // stage starts, so the main checkout cannot change a running campaign.
  const campaignRoot = dirname(dirname(resolve(request.campaignDir)));
  const campaignId = basename(campaignRoot);
  const frameworkRoot = join(campaignRoot, "workspaces", campaignId, "framework-runtime");
  const frameworkLauncher = join(frameworkRoot, "pi-agent");
  if (basename(command) === "pi-agent") {
    try {
      await access(frameworkLauncher);
      command = frameworkLauncher;
      cwd = frameworkRoot;
      env.PI_AUTONOMOUS_RSI_RUNTIME_ACTIVE = "1";
    } catch { /* legacy launcher remains the fallback for old campaigns */ }
  }
  const output = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (code: number, suffix = "") => {
      if (finished) return;
      finished = true;
      if (suffix) stderr += `${suffix}\n`;
      resolveResult({ code, stdout, stderr });
    };
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-8 * 1024 * 1024); });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8 * 1024 * 1024); });
    child.once("error", (error) => finish(1, error.message));
    child.once("close", (code, signal) => finish(typeof code === "number" ? code : 1, signal ? `worker terminated by ${signal}` : ""));
    const timeoutMs = Math.max(1_000, request.worker.timeoutSeconds * 1000);
    setTimeout(() => {
      if (finished) return;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* process already exited */ }
      finish(1, `worker watchdog timed out after ${timeoutMs}ms; stage will be retried from its checkpoint`);
    }, timeoutMs).unref();
  });
  await Promise.all([
    writeFile(request.stdoutPath, output.stdout, { encoding: "utf8", mode: 0o600 }),
    writeFile(request.stderrPath, output.stderr, { encoding: "utf8", mode: 0o600 }),
  ]);
  return output.code;
}

function appendEvent(input: {
  state: AutonomousRsiState;
  iteration: number;
  stage: AutonomousRsiStage;
  attempt: number;
  campaignDir: string;
  inputPath: string;
  stageInput: AutonomousRsiStageInput;
  outputPath: string;
  output: AutonomousRsiStageOutput;
}): { events: AutonomousRsiEvent[]; head: string } {
  const previousEventHash = input.state.events.at(-1)?.eventHash ?? null;
  const content = {
    schemaVersion: "pi-autonomous-rsi-event.v1" as const,
    sequence: input.state.events.length + 1,
    iteration: input.iteration,
    stage: input.stage,
    attempt: input.attempt,
    inputPath: relativeCampaignPath(input.campaignDir, input.inputPath),
    inputHash: input.stageInput.canonicalHash,
    outputPath: relativeCampaignPath(input.campaignDir, input.outputPath),
    outputHash: input.output.canonicalHash,
    previousEventHash,
  };
  const event: AutonomousRsiEvent = { ...content, eventHash: hashCanonical(content) };
  return { events: [...input.state.events, event], head: event.eventHash };
}

function nextStage(stage: AutonomousRsiStage): AutonomousRsiStage | null {
  const index = AUTONOMOUS_RSI_STAGES.indexOf(stage);
  return index === AUTONOMOUS_RSI_STAGES.length - 1 ? null : AUTONOMOUS_RSI_STAGES[index + 1];
}

async function writeKnowledgeEntry(input: {
  campaignDir: string;
  spec: AutonomousRsiSpec;
  iteration: number;
  evaluatedCandidate: AutonomousRsiCandidate;
  baseCandidate: AutonomousRsiCandidate;
  nextCandidate: AutonomousRsiCandidate;
}): Promise<AutonomousRsiKnowledgeIndex> {
  const indexValue = canonicalRecord(await readJson(knowledgeIndexPath(input.campaignDir)), "autonomous knowledge index") as unknown as AutonomousRsiKnowledgeIndex;
  if (indexValue.campaignId !== input.spec.campaignId || indexValue.specHash !== input.spec.canonicalHash) throw new Error("knowledge index is bound to another campaign");
  const existing = indexValue.entries.find((entry) => entry.iteration === input.iteration);
  if (existing) return indexValue;
  if (indexValue.entries.some((entry) => entry.iteration > input.iteration)) throw new Error("knowledge index iteration order is invalid");
  const stageHashes = {} as Record<AutonomousRsiStage, string>;
  for (const stage of AUTONOMOUS_RSI_STAGES) {
    const output = assertAutonomousStageOutput(await readJson(stageResultPath(input.campaignDir, input.iteration, stage)), {
      campaignId: input.spec.campaignId,
      iteration: input.iteration,
      stage,
      spec: input.spec,
      candidate: input.evaluatedCandidate,
      baseCandidate: input.baseCandidate,
    });
    stageHashes[stage] = output.canonicalHash;
  }
  const entryContent = {
    schemaVersion: "pi-autonomous-rsi-knowledge-entry.v1" as const,
    iteration: input.iteration,
    evaluatedCandidate: input.evaluatedCandidate,
    nextCandidate: input.nextCandidate,
    stageHashes,
    previousEntryHash: indexValue.headEntryHash,
  };
  const entry: AutonomousRsiKnowledgeEntry = { ...entryContent, entryHash: hashCanonical(entryContent) };
  await writeOrVerifyJson(join(input.campaignDir, "knowledge", "iterations", `${iterationName(input.iteration)}.json`), entry, `knowledge entry ${input.iteration}`);
  const nextIndex = withAutonomousCanonicalHash({
    schemaVersion: "pi-autonomous-rsi-knowledge-index.v1" as const,
    campaignId: input.spec.campaignId,
    specHash: input.spec.canonicalHash,
    entries: [...indexValue.entries, entry],
    headEntryHash: entry.entryHash,
  });
  await writeJsonAtomic(knowledgeIndexPath(input.campaignDir), nextIndex);
  return nextIndex;
}

async function writeFormalHandoff(input: {
  campaignDir: string;
  spec: AutonomousRsiSpec;
  state: AutonomousRsiState;
  status: "stopped" | "completed" | "failed";
  reason: string;
}): Promise<AutonomousRsiFormalHandoff> {
  const replay = await replayCandidateGraph(input);
  const selectedCandidate = input.state.bestMetric?.candidate ?? input.state.currentCandidate;
  const content = {
    schemaVersion: "pi-autonomous-rsi-formal-handoff.v1" as const,
    campaignId: input.spec.campaignId,
    specHash: input.spec.canonicalHash,
    campaignStatus: input.status,
    stopReason: input.reason,
    bestMetric: input.state.bestMetric,
    currentCandidate: input.state.currentCandidate,
    selectedCandidate,
    candidateGraphHash: replay.graph.canonicalHash,
    eventHeadHash: input.state.eventHeadHash,
    knowledgeHeadHash: input.state.knowledgeHeadHash,
    formalGovernance: input.spec.formalGovernance,
    requiredNextAction: input.spec.formalGovernance.terminalStopEventSequence === null
      ? "review_only" as const
      : "explicit_resume_new_epoch_then_plan_register_open" as const,
    claimBoundary: "development evidence only; not a formal RSI version, evaluation opening, selection, or promotion" as const,
  };
  const handoff = withAutonomousCanonicalHash(content);
  await writeOrVerifyJson(handoffPath(input.campaignDir), handoff, "formal RSI handoff");
  return handoff;
}

function evaluationMetric(output: AutonomousRsiStageOutput): number {
  const metric = output.payload.metric as Record<string, unknown>;
  return Number(metric.value);
}

function isPolicyViolation(value: string): boolean {
  return /(?:online\s+(?:database|uniprot)|(?:validation|test)\s+gold|private\s+evaluator|evaluator[-_ ]private|governance\s+(?:violation|changed)|network\s+(?:violation|forbidden)|identity\s+leak|target[-\s]+specific\s+(?:fact|label|answer))/i.test(value);
}

function failureClass(input: {
  stage: AutonomousRsiStage;
  reason: string;
  output?: AutonomousRsiStageOutput;
}): AutonomousRsiFailureClass {
  if (isPolicyViolation(input.reason) || (input.output && isPolicyViolation(input.output.summary))) return "policy";
  if (input.stage === "verify" && input.output?.status === "completed" && input.output.payload.passed === false) return "candidate";
  return "framework";
}

/**
 * A worker can finish and persist its output immediately before the controller
 * is interrupted. Promote only a fully validated completed/stop artifact; this
 * makes resume idempotent and avoids rerunning an expensive protein evaluation.
 */
async function recoverCompletedAttempt(input: {
  campaignDir: string;
  spec: AutonomousRsiSpec;
  state: AutonomousRsiState;
  stageInput: AutonomousRsiStageInput;
  iteration: number;
  stage: AutonomousRsiStage;
  resultPath: string;
}): Promise<{ result: AutonomousRsiStageOutput; attempt: number; receipt: AutonomousRsiRecoveryReceipt } | undefined> {
  if (await exists(input.resultPath)) return undefined;
  const attemptsPath = join(stageRoot(input.campaignDir, input.iteration, input.stage), "attempts");
  if (!(await exists(attemptsPath))) return undefined;
  const entries = await readdir(attemptsPath, { withFileTypes: true });
  const attempts = entries
    .filter((entry) => entry.isDirectory() && /^\d{3}$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((attempt) => Number.isInteger(attempt) && attempt > 0)
    .sort((left, right) => right - left);
  for (const attempt of attempts) {
    const sourceAttemptPath = join(attemptRoot(input.campaignDir, input.iteration, input.stage, attempt), "output.json");
    if (!(await exists(sourceAttemptPath))) continue;
    let result: AutonomousRsiStageOutput;
    try {
      result = assertAutonomousStageOutput(await readJson(sourceAttemptPath), {
        campaignId: input.spec.campaignId,
        iteration: input.iteration,
        stage: input.stage,
        spec: input.spec,
        candidate: input.state.currentCandidate,
        ...(input.stageInput.selectedBaseCandidate ? { baseCandidate: input.stageInput.selectedBaseCandidate } : {}),
      });
      if (result.status !== "completed" && result.status !== "stop") continue;
      await validateCandidateGraphResult({
        campaignDir: input.campaignDir,
        spec: input.spec,
        currentCandidate: input.state.currentCandidate,
        output: result,
      });
    } catch {
      // An incomplete or malformed attempt is not promoted; normal bounded
      // retry handling below remains responsible for it.
      continue;
    }
    await writeOrVerifyJson(input.resultPath, result, `${input.stage} recovered result`);
    const receiptContent = {
      schemaVersion: "pi-autonomous-rsi-recovery.v1" as const,
      iteration: input.iteration,
      stage: input.stage,
      attempt,
      inputPath: relativeCampaignPath(input.campaignDir, stageInputPath(input.campaignDir, input.iteration, input.stage)),
      inputHash: input.stageInput.canonicalHash,
      sourceAttemptPath: relativeCampaignPath(input.campaignDir, sourceAttemptPath),
      sourceOutputHash: result.canonicalHash,
      resultPath: relativeCampaignPath(input.campaignDir, input.resultPath),
      resultHash: result.canonicalHash,
      classification: "framework" as const,
      reason: "worker_output_promoted_after_controller_interruption" as const,
      recoveredAt: new Date().toISOString(),
    };
    const receipt = withAutonomousCanonicalHash(receiptContent) as AutonomousRsiRecoveryReceipt;
    await writeOrVerifyJson(recoveryReceiptPath(input.campaignDir, input.iteration, input.stage, attempt), receipt, `${input.stage} recovery receipt`);
    return { result, attempt, receipt };
  }
  return undefined;
}

/** Infrastructure/worker faults are resumable interruptions, not RSI terminals. */
async function deferStageFailure(input: {
  campaignDir: string;
  state: AutonomousRsiState;
  reason: string;
  classification: AutonomousRsiFailureClass;
}): Promise<AutonomousRsiState> {
  const next = withAutonomousCanonicalHash({
    ...input.state,
    status: "running" as const,
    stopReason: null,
    handoffHash: null,
    lastError: input.reason,
    lastFailureClass: input.classification,
    attempts: {},
    canonicalHash: undefined,
  });
  await writeJsonAtomic(statePath(input.campaignDir), next);
  const configured = Number(process.env.PI_AUTONOMOUS_RSI_FAILURE_BACKOFF_MS ?? 30_000);
  const delay = Number.isFinite(configured) && configured >= 0 ? Math.min(configured, 3_600_000) : 30_000;
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delay));
  return next;
}

function outputCandidate(output: AutonomousRsiStageOutput): AutonomousRsiCandidate {
  return assertAutonomousCandidate(output.payload.candidate, `${output.stage}.payload.candidate`);
}

async function stopCampaign(input: {
  campaignDir: string;
  spec: AutonomousRsiSpec;
  state: AutonomousRsiState;
  status: "stopped" | "completed" | "failed";
  reason: string;
  classification?: AutonomousRsiFailureClass;
}): Promise<AutonomousRsiState> {
  const handoff = await writeFormalHandoff(input);
  const next = withAutonomousCanonicalHash({
    ...input.state,
    status: input.status,
    stopReason: input.reason,
    handoffHash: handoff.canonicalHash,
    lastError: input.status === "failed" ? input.reason : null,
    lastFailureClass: input.classification ?? input.state.lastFailureClass ?? null,
    canonicalHash: undefined,
  }) as unknown as AutonomousRsiState;
  await writeJsonAtomic(statePath(input.campaignDir), next);
  if (input.spec.experiment && input.status !== "failed") {
    const replay = await replayCandidateGraph({ campaignDir: input.campaignDir, spec: input.spec, state: next });
    const validUpdateCount = replay.graph.nodes.filter((entry) => entry.createdIteration > 0 && entry.parentCandidateId !== null && entry.status === "evaluated").length;
    if (input.spec.experiment.phase === "pilot" || validUpdateCount >= input.spec.experiment.budget.targetValidUpdates) {
      const finalCandidate = next.bestMetric?.candidate ?? next.currentCandidate;
      if (!finalCandidate.sourceCommit || !next.eventHeadHash) throw new Error("instrumented campaign freeze requires commit/event bindings");
      await freezeLoopExperiment({
        campaignDir: input.campaignDir, manifest: input.spec.experiment,
        finalCandidate: finalCandidate as import("../../experiment/contracts.js").CandidateBinding,
        selectionRule: "highest development primary metric; deterministic candidate identity tie-break",
        validUpdateCount, patchAttemptCount: next.events.filter((entry) => entry.stage === "verify").length,
        evaluatorCallCount: next.events.filter((entry) => entry.stage === "evaluate").length,
        eventHeadHash: next.eventHeadHash,
      });
    }
  }
  return next;
}

export async function runAutonomousRsiCampaign(input: {
  campaignDir: string;
  projectRoot: string;
  maxTransitions?: number;
  runner?: AutonomousRsiWorkerRunner;
}): Promise<AutonomousRsiRunResult> {
  const projectRoot = resolve(input.projectRoot);
  const loaded = await loadCampaign(input.campaignDir);
  let { state } = loaded;
  const { campaignDir, spec } = loaded;
  const maximum = input.maxTransitions ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error("maxTransitions must be a positive integer");
  const runner = input.runner ?? runAutonomousRsiWorker;
  if (!(await exists(candidateGraphPath(campaignDir)))) {
    await replayCandidateGraph({ campaignDir, spec, state });
  }
  if (["stopped", "completed"].includes(state.status)) return { state, transitions: 0 };
  if (state.status === "failed") {
    if (process.env.PI_AUTONOMOUS_RSI_RESUME_FAILED !== "1") return { state, transitions: 0 };
    // Explicit operator-authorized recovery: the failed stage's append-only
    // receipts remain intact, while the controller reopens the recorded next
    // stage using the already completed evaluation artifacts.
    state = withAutonomousCanonicalHash({ ...state, status: "running" as const, stopReason: null, handoffHash: null, lastError: null, attempts: {}, canonicalHash: undefined });
    await writeJsonAtomic(statePath(campaignDir), state);
  }
  let transitions = 0;
  if (state.status === "initialized") {
    state = withAutonomousCanonicalHash({ ...state, status: "running" as const, canonicalHash: undefined });
    await writeJsonAtomic(statePath(campaignDir), state);
  }
  while (transitions < maximum && state.status === "running") {
    const stage = state.nextStage;
    const iteration = state.nextIteration;
    const inputPath = stageInputPath(campaignDir, iteration, stage);
    const stageInput = await buildStageInput({ campaignDir, spec, state });
    await writeOrVerifyJson(inputPath, stageInput, `${stage} input`);
    const frozenEvent = state.events.at(-1);
    const stageEventAlreadyRecorded = frozenEvent?.iteration === iteration && frozenEvent.stage === stage;
    let result: AutonomousRsiStageOutput;
    let attempt = state.attempts[stage] ?? 0;
    const resultPath = stageResultPath(campaignDir, iteration, stage);
    const recovered = await recoverCompletedAttempt({
      campaignDir,
      spec,
      state,
      stageInput,
      iteration,
      stage,
      resultPath,
    });
    if (recovered) {
      result = recovered.result;
      attempt = recovered.attempt;
      state = withAutonomousCanonicalHash({
        ...state,
        lastError: null,
        lastFailureClass: "framework",
        recoveryReceipts: [...(state.recoveryReceipts ?? []), recovered.receipt],
        canonicalHash: undefined,
      });
      await writeJsonAtomic(statePath(campaignDir), state);
    }
    if (await exists(resultPath)) {
      result = assertAutonomousStageOutput(await readJson(resultPath), {
        campaignId: spec.campaignId,
        iteration,
        stage,
        spec,
        candidate: state.currentCandidate,
        ...(stageInput.selectedBaseCandidate ? { baseCandidate: stageInput.selectedBaseCandidate } : {}),
      });
      if (!stageEventAlreadyRecorded) {
        await validateCandidateGraphResult({ campaignDir, spec, currentCandidate: state.currentCandidate, output: result });
      }
    } else {
      attempt += 1;
      state = withAutonomousCanonicalHash({
        ...state,
        attempts: { ...state.attempts, [stage]: attempt },
        lastError: null,
        canonicalHash: undefined,
      });
      await writeJsonAtomic(statePath(campaignDir), state);
      const attemptDir = attemptRoot(campaignDir, iteration, stage, attempt);
      await mkdir(attemptDir, { recursive: true, mode: 0o700 });
      const request: AutonomousRsiWorkerRequest = {
        campaignDir,
        projectRoot,
        iteration,
        stage,
        attempt,
        inputPath,
        outputPath: join(attemptDir, "output.json"),
        stdoutPath: join(attemptDir, "stdout.log"),
        stderrPath: join(attemptDir, "stderr.log"),
        worker: spec.workers[stage],
      };
      const resourceStartedAt = new Date().toISOString();
      const resourceStartedMs = Date.now();
      const exitCode = await runner(request);
      const recordResource = async (status: "completed" | "retryable_failure" | "fatal_failure" | "invalid_candidate", output?: AutonomousRsiStageOutput, errorClass?: string): Promise<void> => {
        if (!spec.experiment) return;
        await recordLoopResource({
          campaignDir, manifest: spec.experiment,
          updateIndex: stage === "evaluate" ? Math.max(0, iteration - 1) : iteration,
          patchAttempt: stage === "evaluate" ? Math.max(0, iteration - 1) : iteration,
          stage, attempt, startedAt: resourceStartedAt, finishedAt: new Date().toISOString(),
          wallClockMs: Date.now() - resourceStartedMs, exitCode, status, output,
          stdoutPath: request.stdoutPath, stderrPath: request.stderrPath, errorClass: errorClass ?? null,
        });
      };
      if (exitCode !== 0 || !(await exists(request.outputPath))) {
        const message = `${stage} attempt ${attempt} failed with exit code ${exitCode}${await exists(request.outputPath) ? "" : " and no output"}`;
        const classification = failureClass({ stage, reason: message });
        await recordResource("retryable_failure", undefined, "worker_process_failure");
        if (classification === "policy") {
          state = await stopCampaign({ campaignDir, spec, state, status: "failed", reason: `${stage}: ${message}`, classification });
          break;
        }
        if (attempt >= spec.budget.maxStageAttempts) {
          state = await deferStageFailure({ campaignDir, state, reason: message, classification });
          continue;
        }
        state = withAutonomousCanonicalHash({ ...state, lastError: message, lastFailureClass: classification, canonicalHash: undefined });
        await writeJsonAtomic(statePath(campaignDir), state);
        continue;
      }
      try {
        result = assertAutonomousStageOutput(await readJson(request.outputPath), {
          campaignId: spec.campaignId,
          iteration,
          stage,
          spec,
          candidate: state.currentCandidate,
          ...(stageInput.selectedBaseCandidate ? { baseCandidate: stageInput.selectedBaseCandidate } : {}),
        });
        await validateCandidateGraphResult({ campaignDir, spec, currentCandidate: state.currentCandidate, output: result });
      } catch (error) {
        const message = `${stage} attempt ${attempt} returned invalid output: ${error instanceof Error ? error.message : String(error)}`;
        const classification = failureClass({ stage, reason: message });
        await recordResource("retryable_failure", undefined, "invalid_stage_output");
        if (classification === "policy") {
          state = await stopCampaign({ campaignDir, spec, state, status: "failed", reason: `${stage}: ${message}`, classification });
          break;
        }
        if (attempt >= spec.budget.maxStageAttempts) {
          state = await deferStageFailure({ campaignDir, state, reason: message, classification });
          continue;
        }
        state = withAutonomousCanonicalHash({ ...state, lastError: message, lastFailureClass: classification, canonicalHash: undefined });
        await writeJsonAtomic(statePath(campaignDir), state);
        continue;
      }
      if (result.status === "retryable_failure") {
        const message = `${stage} requested retry: ${result.summary}`;
        const classification = failureClass({ stage, reason: message, output: result });
        await recordResource("retryable_failure", result, "worker_requested_retry");
        if (classification === "policy") {
          state = await stopCampaign({ campaignDir, spec, state, status: "failed", reason: `${stage}: ${message}`, classification });
          break;
        }
        if (attempt >= spec.budget.maxStageAttempts) {
          state = await deferStageFailure({ campaignDir, state, reason: message, classification });
          continue;
        }
        state = withAutonomousCanonicalHash({ ...state, lastError: message, lastFailureClass: classification, canonicalHash: undefined });
        await writeJsonAtomic(statePath(campaignDir), state);
        continue;
      }
      if (result.status === "fatal_failure") {
        const classification = failureClass({ stage, reason: result.summary, output: result });
        await recordResource("fatal_failure", result, classification === "policy" ? "policy_violation" : "worker_reported_fatal");
        state = withAutonomousCanonicalHash({ ...state, lastError: `${stage}: ${result.summary}`, lastFailureClass: classification, canonicalHash: undefined });
        await writeJsonAtomic(statePath(campaignDir), state);
        state = await stopCampaign({ campaignDir, spec, state, status: "failed", reason: `${stage}: ${result.summary}` });
        break;
      }
      await recordResource(stage === "verify" && result.payload.passed !== true ? "invalid_candidate" : "completed", result, stage === "verify" && result.payload.passed !== true ? "candidate_verification_failed" : undefined);
      await writeOrVerifyJson(resultPath, result, `${stage} result`);
    }
    const lastEvent = state.events.at(-1);
    const eventAlreadyRecorded = lastEvent?.iteration === iteration && lastEvent.stage === stage;
    if (eventAlreadyRecorded) {
      if (lastEvent.inputHash !== stageInput.canonicalHash || lastEvent.outputHash !== result.canonicalHash) {
        throw new Error(`recorded ${stage} event does not match the resumable artifacts`);
      }
      attempt = lastEvent.attempt;
    } else {
      if (state.events.some((event) => event.iteration === iteration && event.stage === stage)) {
        throw new Error(`state cursor moved backwards to already-recorded ${stage} stage`);
      }
      const appended = appendEvent({ state, iteration, stage, attempt: Math.max(attempt, 1), campaignDir, inputPath, stageInput, outputPath: resultPath, output: result });
      state = withAutonomousCanonicalHash({
        ...state,
        events: appended.events,
        eventHeadHash: appended.head,
        attempts: {},
        lastError: null,
        lastFailureClass: null,
        canonicalHash: undefined,
      });
      await writeJsonAtomic(statePath(campaignDir), state);
    }
    const replayAfterEvent = await replayCandidateGraph({ campaignDir, spec, state });
    if (spec.experiment && !eventAlreadyRecorded && stage === "evaluate") {
      if (!state.currentCandidate.sourceCommit) throw new Error("instrumented evaluation requires a commit-bound candidate");
      const node = replayAfterEvent.graph.nodes.find((entry) => entry.candidate.candidateId === state.currentCandidate.candidateId);
      if (!node?.evaluation) throw new Error("instrumented evaluation is absent from the replayed candidate graph");
      const parent = node.parentCandidateId ? replayAfterEvent.graph.nodes.find((entry) => entry.candidate.candidateId === node.parentCandidateId) ?? null : null;
      const root = replayAfterEvent.graph.nodes.find((entry) => entry.candidate.candidateId === replayAfterEvent.graph.rootCandidateId) ?? null;
      const initialValue = root?.evaluation?.value ?? node.evaluation.value;
      await recordLoopEvaluation({
        campaignDir, manifest: spec.experiment, repositoryRoot: projectRoot,
        updateIndex: node.parentCandidateId === null ? 0 : replayAfterEvent.graph.nodes.filter((entry) => entry.createdIteration > 0 && entry.parentCandidateId !== null && entry.status === "evaluated").length,
        evaluatorCallIndex: state.events.filter((entry) => entry.stage === "evaluate").length,
        candidate: state.currentCandidate as import("../../experiment/contracts.js").CandidateBinding,
        parentCandidateId: node.parentCandidateId, parentCommit: parent?.candidate.sourceCommit ?? null, output: result,
        deltaFromParent: node.evaluation.deltaFromParent, deltaFromInitial: node.evaluation.value - initialValue,
        deltaFromBestBefore: node.evaluation.deltaFromBestBefore,
        decision: node.evaluation.outcome === "initial" ? "initial" : node.evaluation.outcome === "improved" ? "promote" : "retain_parent",
      });
    }
    if (spec.experiment && !eventAlreadyRecorded && stage === "plan") {
      if (!state.currentCandidate.sourceCommit) throw new Error("instrumented plan requires a commit-bound current candidate");
      const baseCandidate = stageInput.selectedBaseCandidate ?? state.currentCandidate;
      if (!baseCandidate.sourceCommit) throw new Error("instrumented plan requires a commit-bound base candidate");
      const evaluateOutput = assertAutonomousStageOutput(await readJson(stageResultPath(campaignDir, iteration, "evaluate")), { campaignId: spec.campaignId, iteration, stage: "evaluate", spec, candidate: state.currentCandidate, baseCandidate });
      const diagnosisOutput = assertAutonomousStageOutput(await readJson(stageResultPath(campaignDir, iteration, "diagnose")), { campaignId: spec.campaignId, iteration, stage: "diagnose", spec, candidate: state.currentCandidate, baseCandidate });
      let historyRecordCount = 0;
      let matchedHistoryHash: string | null = null;
      if (stageInput.historyContext) {
        const historyValue = assertAutonomousHistoryContext(await readJson(join(campaignDir, stageInput.historyContext.relativePath)) as AutonomousRsiHistoryContext, spec);
        historyRecordCount = historyValue.explorationRecords.length + historyValue.knowledgeCards.length + historyValue.candidateTree.length;
      }
      if (spec.experiment.historyPolicy === "shuffled") {
        const shuffled = canonicalRecord(await readJson(join(campaignDir, "experiment", "shuffled-history.json")), "shuffled history artifact");
        matchedHistoryHash = String(shuffled.canonicalHash);
      }
      await recordLoopPrecommit({
        campaignDir, manifest: spec.experiment,
        updateIndex: replayAfterEvent.graph.nodes.filter((entry) => entry.createdIteration > 0 && entry.parentCandidateId !== null && entry.status === "evaluated").length + 1,
        patchAttempt: state.events.filter((entry) => entry.stage === "verify").length + 1,
        currentCandidate: state.currentCandidate as import("../../experiment/contracts.js").CandidateBinding,
        baseCandidate: baseCandidate as import("../../experiment/contracts.js").CandidateBinding,
        evaluateOutput, diagnosisOutput, planOutput: result,
        historyContextHash: stageInput.historyContext?.canonicalHash ?? null,
        historyRecordCount, matchedHistoryHash,
      });
    }
    transitions += 1;
    if (result.status === "stop") {
      state = await stopCampaign({ campaignDir, spec, state, status: "stopped", reason: `${stage}: ${result.summary}` });
      break;
    }
    if (stage === "diagnose" && typeof result.payload.stopReason === "string") {
      state = await stopCampaign({ campaignDir, spec, state, status: "stopped", reason: "reflection_stop" });
      break;
    }
    if (stage === "evaluate") {
      const value = evaluationMetric(result);
      const first = state.bestMetric === null;
      const improved = first || metricImproved(spec.objective.direction, state.bestMetric!.value, value, spec.objective.minimumImprovement);
      const bestMetric = improved
        ? { metricId: spec.objective.metricId, value, iteration, candidate: state.currentCandidate }
        : state.bestMetric;
      const plateauRounds = improved ? 0 : state.plateauRounds + 1;
      state = withAutonomousCanonicalHash({ ...state, bestMetric, plateauRounds, canonicalHash: undefined });
      const experimentValidUpdates = replayAfterEvent.graph.nodes.filter((entry) => entry.parentCandidateId !== null && entry.status === "evaluated").length;
      const evaluatorCalls = state.events.filter((entry) => entry.stage === "evaluate").length;
      if (result.payload.decision === "stop" && (!spec.experiment || spec.experiment.stopping.allowEvaluatorStop)) {
        state = await stopCampaign({ campaignDir, spec, state, status: "stopped", reason: "evaluator_stop" });
        break;
      }
      if (spec.experiment && experimentValidUpdates >= spec.experiment.budget.targetValidUpdates) {
        state = await stopCampaign({ campaignDir, spec, state, status: "completed", reason: "target_valid_updates_complete" });
        break;
      }
      if (spec.experiment && evaluatorCalls >= spec.experiment.budget.maxEvaluatorCalls) {
        state = await stopCampaign({ campaignDir, spec, state, status: "failed", reason: "evaluator_call_budget_exhausted_before_target" });
        break;
      }
      if (!spec.experiment && iteration >= spec.budget.maxIterations) {
        state = await stopCampaign({ campaignDir, spec, state, status: "completed", reason: "iteration_budget_complete" });
        break;
      }
      if ((!spec.experiment || spec.experiment.stopping.allowPlateauStop) && !first && plateauRounds >= spec.objective.plateauPatience) {
        state = await stopCampaign({ campaignDir, spec, state, status: "completed", reason: "objective_plateau" });
        break;
      }
    }
    const following = nextStage(stage);
    if (following) {
      state = withAutonomousCanonicalHash({ ...state, nextStage: following, canonicalHash: undefined });
      await writeJsonAtomic(statePath(campaignDir), state);
      continue;
    }
    const verification = result;
    const baseCandidate = stageInput.selectedBaseCandidate ?? state.currentCandidate;
    const developed = assertAutonomousStageOutput(await readJson(stageResultPath(campaignDir, iteration, "develop")), {
      campaignId: spec.campaignId,
      iteration,
      stage: "develop",
      spec,
      candidate: state.currentCandidate,
      baseCandidate,
    });
    const developedCandidate = outputCandidate(developed);
    const verifiedCandidate = outputCandidate(verification);
    if (developedCandidate.candidateId !== verifiedCandidate.candidateId
      || developedCandidate.artifactHash !== verifiedCandidate.artifactHash) {
      state = await stopCampaign({ campaignDir, spec, state, status: "failed", reason: "verification_candidate_binding_mismatch" });
      break;
    }
    if (verification.payload.passed !== true) {
      // Generic instrumented workers promise rollback and a fresh precommit.
      // Only the production worker supports continuing a bound plan as a repair.
      const productionRepair = spec.workers.develop.args.includes("autonomous-rsi-production-worker");
      if (!productionRepair && spec.experiment) {
        const patchAttempts = state.events.filter((entry) => entry.stage === "verify").length;
        if (patchAttempts >= spec.experiment.budget.maxPatchAttempts) {
          state = await stopCampaign({ campaignDir, spec, state, status: "failed", reason: "patch_attempt_budget_exhausted_before_target" });
          break;
        }
        state = withAutonomousCanonicalHash({
          ...state,
          nextIteration: iteration + 1,
          nextStage: "evaluate" as const,
          currentCandidate: baseCandidate,
          lastError: "candidate verification failed; candidate retained in the experiment ledger and base restored",
          lastFailureClass: "candidate" as const,
          canonicalHash: undefined,
        });
        await writeJsonAtomic(statePath(campaignDir), state);
        continue;
      }
      if (spec.experiment && state.events.filter((entry) => entry.stage === "verify").length >= spec.experiment.budget.maxPatchAttempts) {
        state = await stopCampaign({ campaignDir, spec, state, status: "failed", reason: "patch_attempt_budget_exhausted_before_target" });
        break;
      }
      const repairAttempts = state.repairAttempts ?? 0;
      const repairBudget = spec.experiment?.budget.maxPatchAttempts ?? spec.budget.maxStageAttempts;
      if (repairAttempts >= repairBudget) {
        state = await stopCampaign({ campaignDir, spec, state, status: spec.experiment ? "failed" : "stopped", reason: "candidate_verification_failed" });
        break;
      }
      const failedCandidate = developedCandidate;
      const failedVerifyPath = stageResultPath(campaignDir, iteration, "verify");
      const failedVerifyBinding = { relativePath: relativeCampaignPath(campaignDir, failedVerifyPath), canonicalHash: verification.canonicalHash };
      state = withAutonomousCanonicalHash({
        ...state,
        nextIteration: iteration + 1,
        nextStage: "develop" as const,
        currentCandidate: baseCandidate,
        repairOf: {
          failedIteration: iteration,
          planIteration: state.repairOf?.planIteration ?? (state.repairOf?.failedIteration ?? iteration),
          failedCandidate,
          verification: failedVerifyBinding,
        },
        repairAttempts: repairAttempts + 1,
        lastError: "candidate verification failed; automatic bounded repair scheduled",
        lastFailureClass: "candidate" as const,
        canonicalHash: undefined,
      });
      await writeJsonAtomic(statePath(campaignDir), state);
      continue;
    }
    if (state.repairOf) {
      const repairedCandidate = outputCandidate(verification);
      state = withAutonomousCanonicalHash({
        ...state,
        nextIteration: iteration + 1,
        nextStage: "evaluate" as const,
        currentCandidate: repairedCandidate,
        repairOf: undefined,
        repairAttempts: state.repairAttempts,
        lastError: null,
        canonicalHash: undefined,
      });
      await writeJsonAtomic(statePath(campaignDir), state);
      continue;
    }
    const knowledge = await writeKnowledgeEntry({
      campaignDir,
      spec,
      iteration,
      evaluatedCandidate: state.currentCandidate,
      baseCandidate,
      nextCandidate: verifiedCandidate,
    });
    state = withAutonomousCanonicalHash({
      ...state,
      nextIteration: iteration + 1,
      nextStage: "evaluate" as const,
      currentCandidate: verifiedCandidate,
      knowledgeHeadHash: knowledge.headEntryHash,
      canonicalHash: undefined,
    });
    await writeJsonAtomic(statePath(campaignDir), state);
  }
  return { state, transitions };
}

export async function autonomousRsiCampaignStatus(campaignDir: string): Promise<Record<string, unknown>> {
  const loaded = await loadCampaign(campaignDir);
  const replay = await replayCandidateGraph(loaded);
  const selectedBaseCandidate = selectedBaseForIteration(replay.graph, loaded.state.nextIteration);
  let activeCandidate = loaded.state.currentCandidate;
  if (loaded.state.nextStage === "verify") {
    const developed = assertAutonomousStageOutput(
      await readJson(stageResultPath(
        loaded.campaignDir,
        loaded.state.nextIteration,
        "develop",
      )),
      {
        campaignId: loaded.spec.campaignId,
        iteration: loaded.state.nextIteration,
        stage: "develop",
        spec: loaded.spec,
        candidate: loaded.state.currentCandidate,
        ...(selectedBaseCandidate ? { baseCandidate: selectedBaseCandidate } : {}),
      },
    );
    activeCandidate = outputCandidate(developed);
  }
  return {
    schemaVersion: loaded.state.schemaVersion,
    campaignId: loaded.state.campaignId,
    status: loaded.state.status,
    nextIteration: loaded.state.nextIteration,
    nextStage: loaded.state.nextStage,
    lifecycle: projectAutonomousRsiCandidateLifecycle(
      loaded.state,
      activeCandidate,
    ),
    currentCandidate: loaded.state.currentCandidate,
    bestMetric: loaded.state.bestMetric,
    candidateGraph: {
      canonicalHash: replay.graph.canonicalHash,
      nodeCount: replay.graph.nodes.length,
      rootCandidateId: replay.graph.rootCandidateId,
      latestEvaluatedCandidateId: replay.graph.latestEvaluatedCandidateId,
      bestCandidateId: replay.graph.bestCandidateId,
      selectedBaseCandidateId: replay.graph.selectedBaseCandidateId,
      edges: replay.graph.nodes
        .filter((node) => node.parentCandidateId !== null)
        .map((node) => ({ parentCandidateId: node.parentCandidateId, candidateId: node.candidate.candidateId })),
    },
    plateauRounds: loaded.state.plateauRounds,
    eventCount: loaded.state.events.length,
    eventHeadHash: loaded.state.eventHeadHash,
    knowledgeHeadHash: loaded.state.knowledgeHeadHash,
    stopReason: loaded.state.stopReason,
    handoffHash: loaded.state.handoffHash,
    lastError: loaded.state.lastError,
    lastFailureClass: loaded.state.lastFailureClass ?? null,
    recoveryCount: loaded.state.recoveryReceipts?.length ?? 0,
  };
}

export async function verifyAutonomousRsiCampaign(campaignDirInput: string): Promise<{
  valid: true;
  campaignId: string;
  status: string;
  eventCount: number;
  knowledgeEntryCount: number;
  eventHeadHash: string | null;
  knowledgeHeadHash: string | null;
}> {
  const loaded = await loadCampaign(campaignDirInput);
  const { campaignDir, spec, state } = loaded;
  const storedGraph = await exists(candidateGraphPath(campaignDir))
    ? assertAutonomousCandidateGraph(
      await readJson(candidateGraphPath(campaignDir)) as AutonomousRsiCandidateGraph,
      spec,
    )
    : null;
  const replay = await replayCandidateGraph(loaded);
  if (storedGraph !== null && canonicalJson(storedGraph) !== canonicalJson(replay.graph)) {
    throw new Error("stored autonomous candidate graph differs from deterministic event replay");
  }
  for (const event of state.events) {
    const inputValue = canonicalRecord(await readJson(join(campaignDir, event.inputPath)), `event ${event.sequence} input`);
    const outputValue = canonicalRecord(await readJson(join(campaignDir, event.outputPath)), `event ${event.sequence} output`);
    if (inputValue.canonicalHash !== event.inputHash || outputValue.canonicalHash !== event.outputHash) {
      throw new Error(`event ${event.sequence} artifact hash mismatch`);
    }
    const historyBinding = inputValue.historyContext as Record<string, unknown> | undefined;
    if (historyBinding) {
      const history = assertAutonomousHistoryContext(
        await readJson(join(campaignDir, String(historyBinding.relativePath))) as AutonomousRsiHistoryContext,
        spec,
      );
      if (history.canonicalHash !== historyBinding.canonicalHash) {
        throw new Error(`event ${event.sequence} history context binding mismatch`);
      }
    }
  }
  for (const [index, receipt] of (state.recoveryReceipts ?? []).entries()) {
    const storedReceipt = canonicalRecord(
      await readJson(recoveryReceiptPath(campaignDir, receipt.iteration, receipt.stage, receipt.attempt)),
      `recovery receipt ${index + 1}`,
    );
    if (canonicalJson(storedReceipt) !== canonicalJson(receipt)) {
      throw new Error(`recovery receipt ${index + 1} differs from the state ledger`);
    }
    const source = canonicalRecord(await readJson(join(campaignDir, receipt.sourceAttemptPath)), `recovery receipt ${index + 1} source output`);
    const promoted = canonicalRecord(await readJson(join(campaignDir, receipt.resultPath)), `recovery receipt ${index + 1} result`);
    if (source.canonicalHash !== receipt.sourceOutputHash || promoted.canonicalHash !== receipt.resultHash) {
      throw new Error(`recovery receipt ${index + 1} artifact hash mismatch`);
    }
  }
  const index = canonicalRecord(await readJson(knowledgeIndexPath(campaignDir)), "autonomous knowledge index") as unknown as AutonomousRsiKnowledgeIndex;
  if (index.campaignId !== spec.campaignId || index.specHash !== spec.canonicalHash || !Array.isArray(index.entries)) {
    throw new Error("autonomous knowledge index does not bind the campaign");
  }
  let prior: string | null = null;
  let previousIteration = 0;
  for (const [offset, entry] of index.entries.entries()) {
    const { entryHash, ...content } = entry;
    if (entry.schemaVersion !== "pi-autonomous-rsi-knowledge-entry.v1"
      || entry.iteration <= previousIteration
      || entry.previousEntryHash !== prior
      || entryHash !== hashCanonical(content)) {
      throw new Error(`knowledge entry ${offset + 1} chain is invalid`);
    }
    assertAutonomousCandidate(entry.evaluatedCandidate, `knowledge entry ${offset + 1} evaluatedCandidate`);
    assertAutonomousCandidate(entry.nextCandidate, `knowledge entry ${offset + 1} nextCandidate`);
    for (const stage of AUTONOMOUS_RSI_STAGES) {
      if (!/^[a-f0-9]{64}$/.test(entry.stageHashes[stage] ?? "")) {
        throw new Error(`knowledge entry ${offset + 1} has an invalid ${stage} hash`);
      }
      const result = canonicalRecord(
        await readJson(stageResultPath(campaignDir, entry.iteration, stage)),
        `knowledge entry ${offset + 1} ${stage} result`,
      );
      if (result.canonicalHash !== entry.stageHashes[stage]) {
        throw new Error(`knowledge entry ${offset + 1} ${stage} result hash mismatch`);
      }
    }
    const rawFile = await readJson(join(campaignDir, "knowledge", "iterations", `${iterationName(entry.iteration)}.json`));
    if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) {
      throw new Error(`knowledge entry ${offset + 1} file is not an object`);
    }
    const file = rawFile as Record<string, unknown>;
    if (canonicalJson(file) !== canonicalJson(entry)) throw new Error(`knowledge entry ${offset + 1} file/index mismatch`);
    prior = entryHash;
    previousIteration = entry.iteration;
  }
  if (index.headEntryHash !== prior) throw new Error("knowledge index head mismatch");
  if (index.headEntryHash !== state.knowledgeHeadHash) throw new Error("state knowledge head does not match the knowledge index");
  if (["stopped", "completed", "failed"].includes(state.status)) {
    const handoff = canonicalRecord(await readJson(handoffPath(campaignDir)), "formal handoff");
    const requiredNextAction = spec.formalGovernance.terminalStopEventSequence === null
      ? "review_only"
      : "explicit_resume_new_epoch_then_plan_register_open";
    if (handoff.canonicalHash !== state.handoffHash
      || handoff.schemaVersion !== "pi-autonomous-rsi-formal-handoff.v1"
      || handoff.campaignId !== spec.campaignId
      || handoff.specHash !== spec.canonicalHash
      || handoff.campaignStatus !== state.status
      || handoff.stopReason !== state.stopReason
      || handoff.eventHeadHash !== state.eventHeadHash
      || handoff.knowledgeHeadHash !== state.knowledgeHeadHash
      || canonicalJson(handoff.currentCandidate) !== canonicalJson(state.currentCandidate)
      || canonicalJson(handoff.bestMetric) !== canonicalJson(state.bestMetric)
      || (handoff.selectedCandidate !== undefined
        && canonicalJson(handoff.selectedCandidate) !== canonicalJson(state.bestMetric?.candidate ?? state.currentCandidate))
      || (handoff.candidateGraphHash !== undefined && handoff.candidateGraphHash !== replay.graph.canonicalHash)
      || canonicalJson(handoff.formalGovernance) !== canonicalJson(spec.formalGovernance)
      || handoff.requiredNextAction !== requiredNextAction) {
      throw new Error("formal handoff does not bind the terminal campaign state");
    }
  }
  if (spec.experiment) {
    const experimentVerification = await verifyExperimentStore(campaignDir);
    const experimentRecords = (await readExperimentRecords(campaignDir)).records;
    const resourceCount = experimentRecords.filter((record) => record.schemaVersion === "pi-rsi-resource-usage-receipt.v1").length;
    const evaluationCount = experimentRecords.filter((record) => record.schemaVersion === "pi-rsi-evaluation-receipt.v1" && record.split === "development").length;
    const precommitCount = experimentRecords.filter((record) => record.schemaVersion === "pi-rsi-iteration-precommit.v1").length;
    if (resourceCount < state.events.length || evaluationCount !== state.events.filter((event) => event.stage === "evaluate").length || precommitCount !== state.events.filter((event) => event.stage === "plan").length) throw new Error("experiment records do not cover every successful stage/evaluation/plan event");
    if (state.status === "completed" && state.stopReason === "target_valid_updates_complete" && !experimentVerification.frozen) throw new Error("completed instrumented campaign is not frozen");
  }
  return {
    valid: true,
    campaignId: state.campaignId,
    status: state.status,
    eventCount: state.events.length,
    knowledgeEntryCount: index.entries.length,
    eventHeadHash: state.eventHeadHash,
    knowledgeHeadHash: state.knowledgeHeadHash,
  };
}
