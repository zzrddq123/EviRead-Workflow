import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertAutonomousStageOutput,
  withAutonomousCanonicalHash,
  type AutonomousRsiCandidate,
  type AutonomousRsiSpec,
  type AutonomousRsiStage,
  type AutonomousRsiStageOutput,
} from "../../src/outer/autonomous/contracts.js";
import {
  autonomousRsiCampaignStatus,
  initializeAutonomousRsiCampaign,
  runAutonomousRsiCampaign,
  verifyAutonomousRsiCampaign,
  type AutonomousRsiWorkerRequest,
} from "../../src/outer/autonomous/orchestrator.js";

const parent: AutonomousRsiCandidate = {
  candidateId: "baseline",
  artifactHash: "a".repeat(64),
  sourceCommit: null,
};

function spec(overrides: Partial<AutonomousRsiSpec["formalGovernance"]> = {}): AutonomousRsiSpec {
  const worker = {
    command: "worker",
    args: ["--input", "{{input}}", "--output", "{{output}}"],
    workingDirectory: "project" as const,
    timeoutSeconds: 30,
    inheritEnv: [],
    networkAccess: "disabled" as const,
  };
  return withAutonomousCanonicalHash({
    schemaVersion: "pi-autonomous-rsi-spec.v1" as const,
    campaignId: "orchestrator-test",
    mode: "development_only" as const,
    objective: {
      metricId: "development_overall_f1",
      direction: "maximize" as const,
      minimumImprovement: 0.01,
      plateauPatience: 2,
    },
    budget: { maxIterations: 2, maxStageAttempts: 2 },
    initialCandidate: parent,
    workers: {
      evaluate: worker,
      diagnose: worker,
      research: { ...worker, networkAccess: "enabled" as const },
      plan: worker,
      develop: worker,
      verify: worker,
    },
    formalGovernance: {
      mode: "handoff_only" as const,
      terminalStopEventSequence: null,
      terminalStopEventHash: null,
      resumeContract: "explicit_append_only_new_epoch_required" as const,
      ...overrides,
    },
  }) as AutonomousRsiSpec;
}

function nextCandidate(iteration: number): AutonomousRsiCandidate {
  return {
    candidateId: `candidate-${iteration + 1}`,
    artifactHash: (iteration === 1 ? "b" : "c").repeat(64),
    sourceCommit: "d".repeat(40),
  };
}

function payload(stage: AutonomousRsiStage, iteration: number, candidate: AutonomousRsiCandidate): Record<string, unknown> {
  if (stage === "evaluate") {
    return {
      candidate,
      metric: { metricId: "development_overall_f1", value: iteration === 1 ? 0.5 : 0.6 },
      decision: "continue",
      feedback: { signal: "candidate recall remains the main development weakness" },
    };
  }
  if (stage === "diagnose") {
    return {
      diagnoses: ["candidate generation has low development recall"],
      prioritizedActions: ["test a bounded candidate-source expansion"],
      stopReason: null,
    };
  }
  if (stage === "research") {
    return {
      cards: [{
        evidenceId: `literature-${iteration}`,
        finding: "A public method suggests a bounded candidate-source expansion.",
        limitations: ["The paper result is not evidence that this repository will improve."],
        supportedActions: ["run the change against the fixed development split"],
      }],
    };
  }
  if (stage === "plan") {
    return {
      planId: `plan-${iteration}`,
      hypothesis: "The bounded source expansion improves development recall without reducing precision.",
      changeTargets: ["src/go.ts"],
      controls: ["keep thresholds and split fixed"],
      falsifiers: ["overall development F1 does not improve"],
      rollbackCondition: "verification fails or the objective does not improve",
    };
  }
  if (stage === "develop") return { candidate: nextCandidate(iteration) };
  return { candidate: nextCandidate(iteration), passed: true, checks: ["typecheck", "unit tests"] };
}

function output(request: AutonomousRsiWorkerRequest, candidate: AutonomousRsiCandidate): AutonomousRsiStageOutput {
  return withAutonomousCanonicalHash({
    schemaVersion: "pi-autonomous-rsi-stage-output.v1" as const,
    campaignId: "orchestrator-test",
    iteration: request.iteration,
    stage: request.stage,
    status: "completed" as const,
    summary: `${request.stage} completed`,
    payload: payload(request.stage, request.iteration, candidate),
  });
}

test("autonomous RSI controller resumes a six-stage iteration and emits a verified formal handoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-autonomous-rsi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const campaignDir = join(root, "campaign");
  await initializeAutonomousRsiCampaign({ campaignDir, spec: spec() });
  let activeCandidate = parent;
  const attempts: string[] = [];
  const runner = async (request: AutonomousRsiWorkerRequest): Promise<number> => {
    attempts.push(`${request.iteration}:${request.stage}:${request.attempt}`);
    if (request.stage === "diagnose" && request.attempt === 1) return 1;
    await writeFile(request.outputPath, `${JSON.stringify(output(request, activeCandidate), null, 2)}\n`, "utf8");
    if (request.stage === "verify") activeCandidate = nextCandidate(request.iteration);
    return 0;
  };

  const partial = await runAutonomousRsiCampaign({ campaignDir, projectRoot: root, maxTransitions: 3, runner });
  assert.equal(partial.state.status, "running");
  assert.equal(partial.state.nextStage, "plan");
  assert.equal(partial.state.events.length, 3);
  assert.equal(partial.state.lastError, null);

  const finished = await runAutonomousRsiCampaign({ campaignDir, projectRoot: root, runner });
  assert.equal(finished.state.status, "completed");
  assert.equal(finished.state.stopReason, "iteration_budget_complete");
  assert.equal(finished.state.bestMetric?.value, 0.6);
  assert.equal(finished.state.events.length, 7);
  assert.ok(attempts.includes("1:diagnose:2"));

  const verification = await verifyAutonomousRsiCampaign(campaignDir);
  assert.deepEqual(verification, {
    valid: true,
    campaignId: "orchestrator-test",
    status: "completed",
    eventCount: 7,
    knowledgeEntryCount: 1,
    eventHeadHash: finished.state.eventHeadHash,
    knowledgeHeadHash: finished.state.knowledgeHeadHash,
  });
  const handoff = JSON.parse(await readFile(join(campaignDir, "formal_handoff.json"), "utf8")) as Record<string, unknown>;
  assert.equal(handoff.requiredNextAction, "review_only");
  assert.match(String(handoff.claimBoundary), /not a formal RSI version/);

  const idempotent = await runAutonomousRsiCampaign({ campaignDir, projectRoot: root, runner });
  assert.equal(idempotent.transitions, 0);
  assert.equal(idempotent.state.canonicalHash, finished.state.canonicalHash);
});

test("controller promotes a completed attempt output after an interruption without rerunning the stage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-autonomous-rsi-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const campaignDir = join(root, "campaign");
  await initializeAutonomousRsiCampaign({ campaignDir, spec: spec() });

  await assert.rejects(
    runAutonomousRsiCampaign({
      campaignDir,
      projectRoot: root,
      runner: async (request) => {
        await writeFile(request.outputPath, `${JSON.stringify(output(request, parent), null, 2)}\n`, "utf8");
        throw new Error("simulated controller interruption after worker output");
      },
    }),
    /simulated controller interruption/,
  );

  const resumed = await runAutonomousRsiCampaign({
    campaignDir,
    projectRoot: root,
    maxTransitions: 1,
    runner: async () => {
      throw new Error("evaluate must be recovered, not rerun");
    },
  });
  assert.equal(resumed.state.nextStage, "diagnose");
  assert.equal(resumed.state.events.length, 1);
  assert.equal(resumed.state.recoveryReceipts?.length, 1);
  assert.equal(resumed.state.recoveryReceipts?.[0]?.attempt, 1);
  assert.ok(await readFile(join(campaignDir, "iterations", "0001", "evaluate", "result.json"), "utf8"));
  assert.equal((await verifyAutonomousRsiCampaign(campaignDir)).valid, true);
});

test("status presents verify and evaluate as commit-bound gates of one Test phase", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-autonomous-rsi-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const campaignDir = join(root, "campaign");
  await initializeAutonomousRsiCampaign({ campaignDir, spec: spec() });
  const runner = async (
    request: AutonomousRsiWorkerRequest,
  ): Promise<number> => {
    await writeFile(
      request.outputPath,
      `${JSON.stringify(output(request, parent), null, 2)}\n`,
      "utf8",
    );
    return 0;
  };

  await runAutonomousRsiCampaign({
    campaignDir,
    projectRoot: root,
    maxTransitions: 5,
    runner,
  });
  const beforeSoftwareVerification =
    await autonomousRsiCampaignStatus(campaignDir);
  assert.deepEqual(beforeSoftwareVerification.lifecycle, {
    schemaVersion: "pi-autonomous-rsi-candidate-lifecycle.v1",
    phase: "test",
    testGate: "software_verification",
    internalNextStage: "verify",
    currentBestCandidate: parent,
    iterationBaseCandidate: parent,
    activeCandidate: nextCandidate(1),
    nextAction: "software_verify_commit_bound_candidate",
    lifecycle: [
      "plan_from_explicit_base",
      "develop_and_commit_candidate",
      "test.software_verification",
      "test.protein_evaluation",
      "diagnose",
      "research_and_distill_knowledge",
    ],
  });

  await runAutonomousRsiCampaign({
    campaignDir,
    projectRoot: root,
    maxTransitions: 1,
    runner,
  });
  const beforeProteinEvaluation =
    await autonomousRsiCampaignStatus(campaignDir);
  assert.equal(
    (beforeProteinEvaluation.lifecycle as Record<string, unknown>).phase,
    "test",
  );
  assert.equal(
    (beforeProteinEvaluation.lifecycle as Record<string, unknown>).testGate,
    "protein_evaluation",
  );
  assert.deepEqual(
    (beforeProteinEvaluation.lifecycle as Record<string, unknown>)
      .activeCandidate,
    nextCandidate(1),
  );
});

test("development cannot hand an uncommitted candidate to the Test phase", () => {
  const uncommitted = withAutonomousCanonicalHash({
    schemaVersion: "pi-autonomous-rsi-stage-output.v1" as const,
    campaignId: "orchestrator-test",
    iteration: 1,
    stage: "develop" as const,
    status: "completed" as const,
    summary: "candidate changed but was not committed",
    payload: {
      candidate: {
        candidateId: "uncommitted-candidate",
        artifactHash: "b".repeat(64),
        sourceCommit: null,
      },
    },
  });
  assert.throws(() => assertAutonomousStageOutput(uncommitted, {
    campaignId: "orchestrator-test",
    iteration: 1,
    stage: "develop",
    spec: spec(),
    candidate: parent,
  }), /commit the candidate before the Test phase/);
});

test("developer-stage output rejects gold/private identifiers", () => {
  const unsafe = withAutonomousCanonicalHash({
    schemaVersion: "pi-autonomous-rsi-stage-output.v1" as const,
    campaignId: "orchestrator-test",
    iteration: 1,
    stage: "diagnose" as const,
    status: "completed" as const,
    summary: "unsafe",
    payload: {
      diagnoses: ["inspect hidden labels"],
      prioritizedActions: [],
      stopReason: null,
      goldLabels: ["hidden"],
    },
  });
  assert.throws(() => assertAutonomousStageOutput(unsafe, {
    campaignId: "orchestrator-test",
    iteration: 1,
    stage: "diagnose",
    spec: spec(),
    candidate: parent,
  }), /forbidden key/);
});

test("candidate tree can return to an evaluated junction and supplies readable full history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-autonomous-rsi-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const campaignDir = join(root, "campaign");
  const original = spec();
  const { canonicalHash: _canonicalHash, ...body } = original;
  const treeSpec = withAutonomousCanonicalHash({
    ...body,
    objective: { ...original.objective, plateauPatience: 10 },
    budget: { ...original.budget, maxIterations: 3 },
  }) as AutonomousRsiSpec;
  await initializeAutonomousRsiCampaign({ campaignDir, spec: treeSpec });

  const candidates: Record<number, AutonomousRsiCandidate> = {
    1: { candidateId: "branch-b", artifactHash: "b".repeat(64), sourceCommit: "d".repeat(40) },
    2: { candidateId: "branch-c", artifactHash: "c".repeat(64), sourceCommit: "e".repeat(40) },
  };
  let secondPlanHistory: Record<string, unknown> | undefined;
  const runner = async (request: AutonomousRsiWorkerRequest): Promise<number> => {
    const stageInput = JSON.parse(await readFile(request.inputPath, "utf8")) as Record<string, unknown>;
    const current = stageInput.currentCandidate as AutonomousRsiCandidate;
    let stagePayload: Record<string, unknown>;
    if (request.stage === "evaluate") {
      const values: Record<number, number> = { 1: 0.5, 2: 0.4, 3: 0.45 };
      stagePayload = {
        candidate: current,
        metric: { metricId: "development_overall_f1", value: values[request.iteration] },
        decision: "continue",
        feedback: { signal: "aggregate development signal" },
      };
    } else if (request.stage === "diagnose") {
      stagePayload = {
        diagnoses: ["the latest route did not improve the objective"],
        prioritizedActions: ["return to the root and test a different mechanism"],
        lesson: `iteration ${request.iteration} route result is retained as reusable evidence`,
        researchRequired: false,
        researchQuestions: [],
        stopReason: null,
      };
    } else if (request.stage === "research") {
      stagePayload = { disposition: "not_required", cards: [] };
    } else if (request.stage === "plan") {
      const binding = stageInput.historyContext as { relativePath: string };
      if (request.iteration === 2) {
        secondPlanHistory = JSON.parse(
          await readFile(join(request.campaignDir, binding.relativePath), "utf8"),
        ) as Record<string, unknown>;
      }
      stagePayload = {
        planId: `tree-plan-${request.iteration}`,
        baseCandidateId: parent.candidateId,
        branchAction: request.iteration === 1 ? "continue" : "branch",
        baseRationale: request.iteration === 1
          ? "Start the first controlled child from the evaluated root."
          : "The first child regressed, so return to the evaluated root and open a sibling route.",
        historyEvidenceIds: [parent.candidateId, ...(request.iteration === 2 ? ["branch-b"] : [])],
        knowledgeEvidenceIds: [],
        hypothesis: `tree hypothesis ${request.iteration}`,
        changeTargets: ["src/go.ts"],
        controls: ["hold evaluator fixed"],
        falsifiers: ["objective does not improve"],
        rollbackCondition: "retain the best evaluated candidate",
      };
    } else if (request.stage === "develop") {
      stagePayload = { candidate: candidates[request.iteration] };
    } else {
      stagePayload = { candidate: candidates[request.iteration], passed: true, checks: ["typecheck"] };
    }
    const stageOutput = withAutonomousCanonicalHash({
      schemaVersion: "pi-autonomous-rsi-stage-output.v1" as const,
      campaignId: "orchestrator-test",
      iteration: request.iteration,
      stage: request.stage,
      status: "completed" as const,
      summary: `${request.stage} completed`,
      payload: stagePayload,
    });
    await writeFile(request.outputPath, `${JSON.stringify(stageOutput, null, 2)}\n`, "utf8");
    return 0;
  };

  const result = await runAutonomousRsiCampaign({ campaignDir, projectRoot: root, runner });
  assert.equal(result.state.status, "completed");
  assert.equal(result.state.currentCandidate.candidateId, "branch-c");
  assert.equal(result.state.bestMetric?.candidate.candidateId, parent.candidateId);
  const graph = JSON.parse(await readFile(join(campaignDir, "exploration", "candidate_graph.json"), "utf8")) as {
    nodes: Array<{ candidate: AutonomousRsiCandidate; parentCandidateId: string | null }>;
    bestCandidateId: string;
  };
  assert.equal(graph.bestCandidateId, parent.candidateId);
  assert.equal(graph.nodes.find((node) => node.candidate.candidateId === "branch-b")?.parentCandidateId, parent.candidateId);
  assert.equal(graph.nodes.find((node) => node.candidate.candidateId === "branch-c")?.parentCandidateId, parent.candidateId);
  const records = secondPlanHistory?.explorationRecords as Array<{ iteration: number; stage: string }>;
  assert.ok(records.some((record) => record.iteration === 1 && record.stage === "plan"));
  assert.ok(records.some((record) => record.iteration === 1 && record.stage === "verify"));
  const tree = secondPlanHistory?.candidateTree as Array<{ candidateId: string }>;
  assert.deepEqual(tree.map((node) => node.candidateId), [parent.candidateId, "branch-b"]);
  const handoff = JSON.parse(await readFile(join(campaignDir, "formal_handoff.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(handoff.selectedCandidate, parent);
  assert.notDeepEqual(handoff.selectedCandidate, handoff.currentCandidate);
  assert.equal(await verifyAutonomousRsiCampaign(campaignDir).then((value) => value.valid), true);
});

test("a history-aware reflection can stop early inside the hard operator budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-autonomous-rsi-reflection-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const campaignDir = join(root, "campaign");
  await initializeAutonomousRsiCampaign({ campaignDir, spec: spec() });
  const runner = async (request: AutonomousRsiWorkerRequest): Promise<number> => {
    const stagePayload = request.stage === "evaluate"
      ? {
        candidate: parent,
        metric: { metricId: "development_overall_f1", value: 0.5 },
        decision: "continue",
        feedback: { signal: "no safe aggregate improvement route remains" },
      }
      : {
        diagnoses: ["all admitted routes are exhausted"],
        prioritizedActions: ["stop within the sealed budget"],
        lesson: "Stop rather than repeat a falsified route.",
        researchRequired: false,
        researchQuestions: [],
        stopReason: "no safe non-duplicate development action remains",
      };
    const stageOutput = withAutonomousCanonicalHash({
      schemaVersion: "pi-autonomous-rsi-stage-output.v1" as const,
      campaignId: "orchestrator-test",
      iteration: 1,
      stage: request.stage,
      status: "completed" as const,
      summary: `${request.stage} completed`,
      payload: stagePayload,
    });
    await writeFile(request.outputPath, `${JSON.stringify(stageOutput, null, 2)}\n`, "utf8");
    return 0;
  };
  const result = await runAutonomousRsiCampaign({ campaignDir, projectRoot: root, runner });
  assert.equal(result.state.status, "stopped");
  assert.equal(result.state.stopReason, "reflection_stop");
  assert.equal(result.state.events.length, 2);
  await assert.rejects(readFile(join(campaignDir, "iterations", "0001", "research", "input.json"), "utf8"), /ENOENT/);
});

test("terminal formal stop binding requires an explicit append-only new epoch handoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-autonomous-rsi-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const campaignDir = join(root, "campaign");
  const bound = spec({ terminalStopEventSequence: 19, terminalStopEventHash: "e".repeat(64) });
  await initializeAutonomousRsiCampaign({ campaignDir, spec: bound });
  const runner = async (request: AutonomousRsiWorkerRequest): Promise<number> => {
    const stopped = withAutonomousCanonicalHash({
      schemaVersion: "pi-autonomous-rsi-stage-output.v1" as const,
      campaignId: "orchestrator-test",
      iteration: 1,
      stage: request.stage,
      status: "stop" as const,
      summary: "no safe development action",
      payload: {},
    });
    await writeFile(request.outputPath, `${JSON.stringify(stopped, null, 2)}\n`, "utf8");
    return 0;
  };
  const result = await runAutonomousRsiCampaign({ campaignDir, projectRoot: root, runner });
  assert.equal(result.state.status, "stopped");
  const handoff = JSON.parse(await readFile(join(campaignDir, "formal_handoff.json"), "utf8")) as Record<string, unknown>;
  assert.equal(handoff.requiredNextAction, "explicit_resume_new_epoch_then_plan_register_open");
});
