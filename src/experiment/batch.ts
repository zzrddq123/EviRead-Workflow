import { hashCanonical } from "../hash.js";
import { assertCandidateBinding, assertExperimentManifest, withExperimentHash, type CandidateBinding, type RsiExperimentManifest } from "./contracts.js";

export interface FiveCellDesignInput {
  schemaVersion: "pi-rsi-five-cell-design-input.v1";
  experimentId: string;
  phase: "pilot" | "confirmatory";
  replicateCount: number;
  blockPrefix: string;
  latestInitialCandidate: CandidateBinding;
  earlyInitialCandidate: CandidateBinding;
  bindings: RsiExperimentManifest["bindings"];
  budget: RsiExperimentManifest["budget"];
  stopping: RsiExperimentManifest["stopping"];
  seedRootHash: string;
}

export interface FiveCellBatchManifest extends Record<string, unknown> {
  schemaVersion: "pi-rsi-five-cell-batch-manifest.v1";
  experimentId: string;
  design: "latest_2x2_plus_early_native";
  cells: Array<{
    conditionId: string;
    framework: RsiExperimentManifest["framework"];
    feedbackPolicy: RsiExperimentManifest["feedbackPolicy"];
    historyPolicy: RsiExperimentManifest["historyPolicy"];
    estimandRole: "latest_factorial" | "latest_factorial_and_native_framework_comparison" | "native_framework_comparison";
  }>;
  campaigns: RsiExperimentManifest[];
  claimBoundary: "framework comparison and LatestRSI mechanism factorial are separate estimands";
  canonicalHash: string;
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertInput(value: unknown): FiveCellDesignInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("five-cell design input must be an object");
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== "pi-rsi-five-cell-design-input.v1" || typeof item.experimentId !== "string" || !ID.test(item.experimentId) || !["pilot", "confirmatory"].includes(String(item.phase)) || !Number.isInteger(item.replicateCount) || Number(item.replicateCount) < 1 || Number(item.replicateCount) > 100 || typeof item.blockPrefix !== "string" || !ID.test(item.blockPrefix) || typeof item.seedRootHash !== "string" || !HASH.test(item.seedRootHash)) throw new Error("five-cell design identity is invalid");
  assertCandidateBinding(item.latestInitialCandidate, "latestInitialCandidate"); assertCandidateBinding(item.earlyInitialCandidate, "earlyInitialCandidate");
  if (!item.bindings || typeof item.bindings !== "object" || !item.budget || typeof item.budget !== "object" || !item.stopping || typeof item.stopping !== "object") throw new Error("five-cell design contracts are absent");
  return item as unknown as FiveCellDesignInput;
}

function derivedSeed(root: string, conditionId: string, replicateId: string): string { return hashCanonical({ root, conditionId, replicateId }); }

export function createFiveCellBatch(value: unknown): FiveCellBatchManifest {
  const input = assertInput(value);
  const cells: FiveCellBatchManifest["cells"] = [
    { conditionId: "latest_metric_reset", framework: "latest_autonomous", feedbackPolicy: "metric_only", historyPolicy: "reset", estimandRole: "latest_factorial" },
    { conditionId: "latest_structured_reset", framework: "latest_autonomous", feedbackPolicy: "structured_diagnostic", historyPolicy: "reset", estimandRole: "latest_factorial" },
    { conditionId: "latest_metric_persistent", framework: "latest_autonomous", feedbackPolicy: "metric_only", historyPolicy: "persistent", estimandRole: "latest_factorial" },
    { conditionId: "latest_structured_persistent", framework: "latest_autonomous", feedbackPolicy: "structured_diagnostic", historyPolicy: "persistent", estimandRole: "latest_factorial_and_native_framework_comparison" },
    { conditionId: "early_native", framework: "early_cumulative", feedbackPolicy: "structured_diagnostic", historyPolicy: "native_linear", estimandRole: "native_framework_comparison" },
  ];
  const campaigns: RsiExperimentManifest[] = [];
  for (let replicate = 1; replicate <= input.replicateCount; replicate += 1) {
    const replicateId = `r${String(replicate).padStart(2, "0")}`;
    for (const cell of cells) {
      const campaignId = `${input.experimentId}-${cell.conditionId}-${replicateId}`.slice(0, 128);
      const body = {
        schemaVersion: "pi-rsi-experiment-manifest.v1" as const,
        experimentId: input.experimentId,
        conditionId: cell.conditionId,
        replicateId,
        blockId: `${input.blockPrefix}-${replicateId}`.slice(0, 128),
        campaignId,
        phase: input.phase,
        framework: cell.framework,
        feedbackPolicy: cell.feedbackPolicy,
        historyPolicy: cell.historyPolicy,
        initialCandidate: cell.framework === "latest_autonomous" ? input.latestInitialCandidate : input.earlyInitialCandidate,
        bindings: structuredClone(input.bindings),
        budget: structuredClone(input.budget),
        stopping: structuredClone(input.stopping),
        randomization: { campaignSeedHash: derivedSeed(input.seedRootHash, cell.conditionId, replicateId), matchedBlock: true },
        claimBoundary: "development-only selection; sealed evaluation cannot influence candidate selection" as const,
      };
      campaigns.push(assertExperimentManifest(withExperimentHash(body)));
    }
  }
  const body = {
    schemaVersion: "pi-rsi-five-cell-batch-manifest.v1" as const,
    experimentId: input.experimentId,
    design: "latest_2x2_plus_early_native" as const,
    cells,
    campaigns,
    claimBoundary: "framework comparison and LatestRSI mechanism factorial are separate estimands" as const,
  };
  return { ...body, canonicalHash: hashCanonical(body) };
}

export function assertFiveCellBatch(value: unknown): FiveCellBatchManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("five-cell batch must be an object");
  const item = value as FiveCellBatchManifest;
  const { canonicalHash, ...body } = item;
  if (item.schemaVersion !== "pi-rsi-five-cell-batch-manifest.v1" || item.design !== "latest_2x2_plus_early_native" || item.claimBoundary !== "framework comparison and LatestRSI mechanism factorial are separate estimands" || canonicalHash !== hashCanonical(body) || !Array.isArray(item.cells) || item.cells.length !== 5 || !Array.isArray(item.campaigns) || item.campaigns.length < 5) throw new Error("five-cell batch identity/hash mismatch");
  item.campaigns.forEach(assertExperimentManifest);
  return item;
}
