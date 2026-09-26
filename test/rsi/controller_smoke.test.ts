import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withAutonomousCanonicalHash } from "../../src/outer/autonomous/contracts.js";
import {
  autonomousRsiCampaignStatus,
  initializeAutonomousRsiCampaign,
  verifyAutonomousRsiCampaign,
} from "../../src/outer/autonomous/orchestrator.js";
import { inspectRsiVersionGraph } from "../../src/outer/version_graph/rsi_version_graph.js";

const hash = "a".repeat(64);
const commit = "1".repeat(40);

function worker(stage: string) {
  return {
    command: "/usr/bin/true",
    args: [stage],
    workingDirectory: "project" as const,
    timeoutSeconds: 30,
    inheritEnv: [] as string[],
    networkAccess: "disabled" as const,
  };
}

test("fresh LatestRSI campaign seals a generation-0 candidate and verifies", async () => {
  const root = await mkdtemp(join(tmpdir(), "iclr-latest-rsi-"));
  try {
    const spec = withAutonomousCanonicalHash({
      schemaVersion: "pi-autonomous-rsi-spec.v1" as const,
      campaignId: "smoke",
      mode: "development_only" as const,
      objective: { metricId: "overall_fmax", direction: "maximize" as const, minimumImprovement: 0.001, plateauPatience: 2 },
      budget: { maxIterations: 2, maxStageAttempts: 2 },
      initialCandidate: { candidateId: "strict-blind-go-bootstrap-v0-d24a111", artifactHash: hash, sourceCommit: commit },
      evaluatorContractHash: hash,
      historicalSeeds: [],
      workers: {
        evaluate: worker("evaluate"), diagnose: worker("diagnose"), research: worker("research"),
        plan: worker("plan"), develop: worker("develop"), verify: worker("verify"),
      },
      formalGovernance: {
        mode: "handoff_only" as const,
        terminalStopEventSequence: null,
        terminalStopEventHash: null,
        resumeContract: "explicit_append_only_new_epoch_required" as const,
      },
    });
    await initializeAutonomousRsiCampaign({ campaignDir: root, spec });
    const status = await autonomousRsiCampaignStatus(root);
    assert.equal(status.status, "initialized");
    assert.equal(status.candidateGraph.rootCandidateId, "strict-blind-go-bootstrap-v0-d24a111");
    assert.equal((await verifyAutonomousRsiCampaign(root)).valid, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh repository has an empty, non-complete formal RSI graph", async () => {
  const repository = await mkdtemp(join(tmpdir(), "iclr-version-graph-"));
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repository });
    const graph = await inspectRsiVersionGraph(repository);
    assert.equal(graph.versions.length, 0);
    assert.equal(graph.historyComplete, false);
    assert.equal(graph.paperComplete, false);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
