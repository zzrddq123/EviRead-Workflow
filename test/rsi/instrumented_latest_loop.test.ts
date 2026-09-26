import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { withExperimentHash, type RsiExperimentManifest } from "../../src/experiment/contracts.js";
import { readExperimentRecords, verifyExperimentStore } from "../../src/experiment/store.js";
import { withAutonomousCanonicalHash, type AutonomousRsiCandidate, type AutonomousRsiSpec, type AutonomousRsiStageOutput } from "../../src/outer/autonomous/contracts.js";
import { initializeAutonomousRsiCampaign, runAutonomousRsiCampaign, verifyAutonomousRsiCampaign, type AutonomousRsiWorkerRequest } from "../../src/outer/autonomous/orchestrator.js";

const exec = promisify(execFile); const hash = (c: string) => c.repeat(64).slice(0, 64);
async function git(root: string, ...args: string[]): Promise<string> { return (await exec("/usr/bin/git", args, { cwd: root })).stdout.trim(); }

async function commits(root: string): Promise<[string, string, string]> {
  await git(root, "init", "-q", "-b", "main"); await git(root, "config", "user.name", "RSI Test"); await git(root, "config", "user.email", "rsi@example.invalid");
  await writeFile(join(root, "method.txt"), "g0\n"); await git(root, "add", "."); await git(root, "commit", "-q", "-m", "g0"); const g0 = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "method.txt"), "bad\n"); await git(root, "commit", "-qam", "bad"); const bad = await git(root, "rev-parse", "HEAD");
  await git(root, "checkout", "-q", g0); await writeFile(join(root, "method.txt"), "good\n"); await git(root, "commit", "-qam", "good"); const good = await git(root, "rev-parse", "HEAD");
  return [g0, bad, good];
}

test("instrumented LatestRSI records reset-history precommits, invalid rollback, resources, evaluation and freeze", async () => {
  const root = await mkdtemp(join(tmpdir(), "latest-instrumented-")); const campaign = join(root, "campaign");
  try {
    const [g0, bad, good] = await commits(root); const initial: AutonomousRsiCandidate = { candidateId: "g0", artifactHash: hash("a"), sourceCommit: g0 };
    const experiment = withExperimentHash({ schemaVersion: "pi-rsi-experiment-manifest.v1" as const, experimentId: "e0", conditionId: "latest-reset", replicateId: "r01", blockId: "b01", campaignId: "latest-instrumented", phase: "pilot" as const, framework: "latest_autonomous" as const, feedbackPolicy: "structured_diagnostic" as const, historyPolicy: "reset" as const, initialCandidate: initial as Required<AutonomousRsiCandidate>, bindings: { scientificBaselineHash: hash("b"), evaluatorContractHash: hash("c"), developmentDataHash: hash("d"), sealedDataCommitmentHash: hash("e"), modelConfigHash: hash("f"), promptConfigHash: hash("1"), toolConfigHash: hash("2"), runtimeConfigHash: hash("3") }, budget: { targetValidUpdates: 1, maxPatchAttempts: 2, maxEvaluatorCalls: 3, maxStageAttempts: 1, maxWallClockSeconds: 3600 }, stopping: { allowEvaluatorStop: false, allowPlateauStop: false, plateauPatience: null, invalidCandidatePolicy: "record_rollback_continue" as const }, randomization: { campaignSeedHash: hash("4"), matchedBlock: true }, claimBoundary: "development-only selection; sealed evaluation cannot influence candidate selection" as const }) as RsiExperimentManifest;
    const worker = { command: "/usr/bin/false", args: [], workingDirectory: "project" as const, timeoutSeconds: 30, inheritEnv: [], networkAccess: "disabled" as const };
    const spec = withAutonomousCanonicalHash({ schemaVersion: "pi-autonomous-rsi-spec.v1" as const, campaignId: experiment.campaignId, mode: "development_only" as const, objective: { metricId: "overall_fmax", direction: "maximize" as const, minimumImprovement: 0.001, plateauPatience: 99 }, budget: { maxIterations: 3, maxStageAttempts: 1 }, initialCandidate: initial, evaluatorContractHash: experiment.bindings.evaluatorContractHash, historicalSeeds: [], experiment, workers: { evaluate: worker, diagnose: worker, research: worker, plan: worker, develop: worker, verify: worker }, formalGovernance: { mode: "handoff_only" as const, terminalStopEventSequence: null, terminalStopEventHash: null, resumeContract: "explicit_append_only_new_epoch_required" as const } }) as AutonomousRsiSpec;
    await initializeAutonomousRsiCampaign({ campaignDir: campaign, spec });
    const candidates = new Map<number, AutonomousRsiCandidate>([[1, { candidateId: "bad", artifactHash: hash("5"), sourceCommit: bad }], [2, { candidateId: "good", artifactHash: hash("6"), sourceCommit: good }]]);
    const runner = async (request: AutonomousRsiWorkerRequest): Promise<number> => {
      const stageInput = JSON.parse(await readFile(request.inputPath, "utf8")) as Record<string, unknown>; const current = stageInput.currentCandidate as AutonomousRsiCandidate; let payload: Record<string, unknown>;
      if (request.stage === "evaluate") payload = { candidate: current, metric: { metricId: "overall_fmax", value: current.candidateId === "good" ? 0.3 : 0.2 }, decision: "continue", feedback: { policy: "structured_diagnostic", structuredDiagnostic: { dominantLoss: "recall" } }, evaluationBinding: { evaluatorResultHash: hash("7"), developerFeedbackHash: hash("8"), feedbackPolicy: "structured_diagnostic" } };
      else if (request.stage === "diagnose") payload = { diagnoses: ["candidate recall is narrow"], prioritizedActions: ["expand candidates"], lesson: "test a bounded expansion", stopReason: null, primaryProblemSource: "parameter_or_hyperparameter", secondaryProblemSources: [], rootCauseRationale: "candidate filtering is conservative", researchRequired: false, researchScope: null, researchQuestions: [] };
      else if (request.stage === "research") payload = { disposition: "not_required", researchScope: null, sources: [], cards: [] };
      else if (request.stage === "plan") payload = { planId: `plan-${request.iteration}`, baseCandidateId: current.candidateId, branchAction: "continue", baseRationale: "continue retained parent", historyEvidenceIds: [current.candidateId], knowledgeEvidenceIds: [], hypothesis: "bounded expansion improves recall", changeTargets: ["method.txt"], changeFamily: "candidate_generation", predictedEffects: [{ metricId: "overall_fmax", sliceId: "overall", direction: "increase", minimumDelta: 0.001 }], controls: ["same evaluator"], falsifiers: ["no Fmax gain"], rollbackCondition: "verification or objective failure" };
      else if (request.stage === "develop") payload = { candidate: candidates.get(request.iteration) };
      else payload = { candidate: candidates.get(request.iteration), passed: request.iteration === 2, checks: [request.iteration === 2 ? "tests passed" : "seeded invalid candidate"] };
      const body = { schemaVersion: "pi-autonomous-rsi-stage-output.v1" as const, campaignId: experiment.campaignId, iteration: request.iteration, stage: request.stage, status: "completed" as const, summary: `${request.stage} test output`, payload };
      const output = withAutonomousCanonicalHash(body) as AutonomousRsiStageOutput; await writeFile(request.outputPath, `${JSON.stringify(output)}\n`); await writeFile(request.stdoutPath, "ok\n"); await writeFile(request.stderrPath, ""); return 0;
    };
    const result = await runAutonomousRsiCampaign({ campaignDir: campaign, projectRoot: root, runner });
    assert.equal(result.state.status, "completed", JSON.stringify({ stopReason: result.state.stopReason, lastError: result.state.lastError, nextIteration: result.state.nextIteration, nextStage: result.state.nextStage })); assert.equal(result.state.stopReason, "target_valid_updates_complete"); assert.equal(result.state.currentCandidate.candidateId, "good");
    assert.equal((await verifyAutonomousRsiCampaign(campaign)).valid, true); const store = await verifyExperimentStore(campaign); assert.equal(store.valid, true); assert.equal(store.frozen, true);
    const records = (await readExperimentRecords(campaign)).records; assert.equal(records.filter((entry) => entry.schemaVersion === "pi-rsi-iteration-precommit.v1").length, 2); assert.equal(records.filter((entry) => entry.schemaVersion === "pi-rsi-evaluation-receipt.v1").length, 3); assert.equal(records.filter((entry) => entry.schemaVersion === "pi-rsi-resource-usage-receipt.v1" && entry.status === "invalid_candidate").length, 1);
    const freeze = records.find((entry) => entry.schemaVersion === "pi-rsi-campaign-freeze-manifest.v1"); assert.equal(freeze?.validUpdateCount, 1); assert.equal(freeze?.patchAttemptCount, 2);
    const resetHistory = JSON.parse(await readFile(join(campaign, "history", "contexts", "0002-plan.json"), "utf8")) as Record<string, unknown>; assert.equal((resetHistory.candidateTree as unknown[]).length, 1); assert.equal((resetHistory.explorationRecords as unknown[]).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
