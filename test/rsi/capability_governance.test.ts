import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  initializeCapabilityCampaign,
  precommitToolAcquisition,
  sealCommonDataManifest,
  sealStartingToolboxManifest,
  verifyCapabilityCampaign,
} from "../../src/experiment/capability_governance.js";
import {
  materializeFrozenG0Baseline,
  materializeVersionedBaseline,
  resolvePromotionCapabilityClosure,
  sealCandidateCapabilityUsage,
  verifyVersionedBaseline,
} from "../../src/experiment/baseline_governance.js";
import { acquireToolArtifact, capabilityWorkerEnvironment, createToolAcquisitionTool } from "../../src/experiment/tool_acquisition_broker.js";

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

test("capability governance keeps independent decisions private while reusing invisible CAS bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "iclr-capability-"));
  const hostCasRoot = join(root, "host-cas");
  const common = sealCommonDataManifest({
    schemaVersion: "pi-rsi-common-data-manifest.v1",
    snapshotId: "fixture-common-v1",
    resources: [{ resourceId: "pdb100", release: "fixture", artifactHash: sha256("pdb-fixture"), licenseId: "fixture", sourceUrl: "https://example.invalid/pdb" }],
    readOnly: true,
  });
  const toolbox = sealStartingToolboxManifest({
    schemaVersion: "pi-rsi-starting-toolbox-manifest.v1",
    baselineId: "early-fixture",
    commonDataManifestHash: common.canonicalHash,
    visibleTools: [],
    acquisitionPolicy: {
      enabledFromUpdate: 1,
      allowedSourceSchemes: ["https"],
      maxAttempts: 2,
      maxSuccessfulTools: 2,
      maxBytes: 1024,
      requireIndependentPrecommit: true,
      candidateMayBrowseHostCas: false,
    },
  });

  const campaignA = join(root, "campaign-a");
  const campaignB = join(root, "campaign-b");
  await initializeCapabilityCampaign({ campaignRoot: campaignA, campaignId: "campaign-a", commonDataManifest: common, startingToolboxManifest: toolbox });
  await initializeCapabilityCampaign({ campaignRoot: campaignB, campaignId: "campaign-b", commonDataManifest: common, startingToolboxManifest: toolbox });

  const previousCapability = process.env.PI_ICLR_CAPABILITY_CAMPAIGN_ROOT, previousCas = process.env.PI_ICLR_HOST_CAS;
  process.env.PI_ICLR_CAPABILITY_CAMPAIGN_ROOT = campaignA; process.env.PI_ICLR_HOST_CAS = hostCasRoot;
  try {
    assert.equal(createToolAcquisitionTool({ campaignId: "campaign-a", updateIndex: 1 })?.name, "request_tool_acquisition");
    assert.equal(capabilityWorkerEnvironment().PI_ICLR_PRIVATE_TOOL_ROOT, join(campaignA, "private-tools"));
    assert.equal(JSON.stringify(capabilityWorkerEnvironment()).includes("host-cas"), false);
  } finally {
    if (previousCapability === undefined) delete process.env.PI_ICLR_CAPABILITY_CAMPAIGN_ROOT; else process.env.PI_ICLR_CAPABILITY_CAMPAIGN_ROOT = previousCapability;
    if (previousCas === undefined) delete process.env.PI_ICLR_HOST_CAS; else process.env.PI_ICLR_HOST_CAS = previousCas;
  }

  const artifact = Buffer.from("independently-selected-tool-v1\n");
  const request = {
    schemaVersion: "pi-rsi-tool-acquisition-precommit.v1" as const,
    updateIndex: 1,
    requestId: "deep-tool-v1",
    toolId: "independent-tool",
    purpose: "Test an independently proposed method improvement.",
    sourceUrl: "https://example.invalid/independent-tool",
    artifactKind: "executable" as const,
    expectedArtifactHash: sha256(artifact),
    maxBytes: 1024,
    recordedAt: "2026-08-18T00:00:00Z",
  };
  const precommitA = await precommitToolAcquisition(campaignA, request);
  const acquiredA = await acquireToolArtifact({ campaignRoot: campaignA, hostCasRoot, precommitHash: precommitA.canonicalHash, artifactBytes: artifact, acquiredAt: "2026-08-18T00:00:01Z" });
  assert.equal(acquiredA.reusedHostCasArtifact, false);
  assert.equal(acquiredA.artifactHash, sha256(artifact));
  assert.doesNotMatch(acquiredA.installedRelativePath, /host-cas|campaign-b/);

  await assert.rejects(() => acquireToolArtifact({ campaignRoot: campaignB, hostCasRoot, precommitHash: precommitA.canonicalHash, artifactBytes: artifact, acquiredAt: "2026-08-18T00:00:01Z" }), /precommit/i);
  const precommitB = await precommitToolAcquisition(campaignB, { ...request, requestId: "deep-tool-v1-b", recordedAt: "2026-08-18T00:00:02Z" });
  const acquiredB = await acquireToolArtifact({ campaignRoot: campaignB, hostCasRoot, precommitHash: precommitB.canonicalHash, artifactBytes: artifact, acquiredAt: "2026-08-18T00:00:03Z" });
  assert.equal(acquiredB.reusedHostCasArtifact, true);

  const verifiedA = await verifyCapabilityCampaign(campaignA);
  const verifiedB = await verifyCapabilityCampaign(campaignB);
  assert.equal(verifiedA.successfulTools, 1);
  assert.equal(verifiedB.successfulTools, 1);
  assert.notEqual(verifiedA.acquiredCapabilityHeadHash, verifiedB.acquiredCapabilityHeadHash);

  const installedA = join(campaignA, acquiredA.installedRelativePath);
  assert.equal(sha256(await readFile(installedA)), sha256(artifact));
  await chmod(installedA, 0o600);
  await writeFile(installedA, "tampered\n");
  await assert.rejects(() => verifyCapabilityCampaign(campaignA), /artifact hash/i);
});

test("promotion binds the selected code to its required acquired-tool closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "iclr-baseline-"));
  const hostCasRoot = join(root, "host-cas");
  const common = sealCommonDataManifest({
    schemaVersion: "pi-rsi-common-data-manifest.v1",
    snapshotId: "fixture-common-v1",
    resources: [{ resourceId: "pdb100", release: "fixture", artifactHash: sha256("pdb"), licenseId: "fixture", sourceUrl: "https://example.invalid/pdb" }],
    readOnly: true,
  });
  const toolbox = sealStartingToolboxManifest({
    schemaVersion: "pi-rsi-starting-toolbox-manifest.v1",
    baselineId: "early-fixture-v1",
    commonDataManifestHash: common.canonicalHash,
    visibleTools: [],
    acquisitionPolicy: { enabledFromUpdate: 1, allowedSourceSchemes: ["https"], maxAttempts: 3, maxSuccessfulTools: 3, maxBytes: 4096, requireIndependentPrecommit: true, candidateMayBrowseHostCas: false },
  });
  const frozenRoot = join(root, "frozen-g0");
  const frozen = await materializeFrozenG0Baseline({ destinationRoot: frozenRoot, baselineId: "early-fixture-v1", armId: "early-agent-latest-rsi", candidate: { candidateId: "g0", sourceCommit: "1".repeat(40), sourceTree: "2".repeat(40) }, commonDataManifestHash: common.canonicalHash, startingToolboxManifest: toolbox, verificationReceiptHashes: ["3".repeat(64)] });
  assert.equal((await verifyVersionedBaseline(frozenRoot)).canonicalHash, frozen.canonicalHash);
  const campaign = join(root, "campaign");
  await initializeCapabilityCampaign({ campaignRoot: campaign, campaignId: "baseline-campaign", commonDataManifest: common, startingToolboxManifest: toolbox });
  const artifact = Buffer.from("required-tool-v1\n");
  const precommit = await precommitToolAcquisition(campaign, {
    schemaVersion: "pi-rsi-tool-acquisition-precommit.v1", updateIndex: 1, requestId: "required-tool-request", toolId: "required-tool",
    purpose: "Required by the retained candidate.", sourceUrl: "https://example.invalid/required-tool", artifactKind: "executable", expectedArtifactHash: sha256(artifact), maxBytes: 1024, recordedAt: "2026-08-19T00:00:00Z",
  });
  const acquired = await acquireToolArtifact({ campaignRoot: campaign, hostCasRoot, precommitHash: precommit.canonicalHash, artifactBytes: artifact, acquiredAt: "2026-08-19T00:00:01Z" });
  const candidate = { candidateId: "candidate-b", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40) };

  await assert.rejects(
    () => resolvePromotionCapabilityClosure({ campaignRoot: campaign, candidate, usageManifest: null, versionedBaselineRoot: null }),
    /usage manifest/i,
  );

  const usage = await sealCandidateCapabilityUsage(campaign, {
    schemaVersion: "pi-rsi-candidate-capability-usage.v1",
    campaignId: "baseline-campaign",
    candidate,
    acquisitions: [{ receiptHash: acquired.canonicalHash, disposition: "required", evidenceHash: "c".repeat(64), rationale: "Candidate resolves this executable through the private tool root." }],
    verificationReceiptHash: "d".repeat(64),
    evaluationReceiptHash: "e".repeat(64),
  });
  await mkdir(join(campaign, "candidate-capabilities"), { recursive: true });
  await writeFile(join(campaign, "candidate-capabilities", `${candidate.candidateId}.json`), `${JSON.stringify(usage, null, 2)}\n`);
  await assert.rejects(
    () => resolvePromotionCapabilityClosure({ campaignRoot: campaign, candidate, usageManifest: usage, versionedBaselineRoot: null }),
    /versioned baseline/i,
  );

  const baselineRoot = join(root, "promoted-baseline");
  const baseline = await materializeVersionedBaseline({
    campaignRoot: campaign,
    destinationRoot: baselineRoot,
    usageManifest: usage,
    parentBaselineId: "early-fixture-v1",
    baselineId: "promoted-candidate-b-v1",
    armId: "early-agent-latest-rsi",
    toolMetadata: [{ receiptHash: acquired.canonicalHash, version: "1.0.0", licenseId: "MIT", executable: true }],
    verificationReceiptHashes: ["f".repeat(64)],
  });
  assert.equal((await verifyVersionedBaseline(baselineRoot)).canonicalHash, baseline.canonicalHash);
  const closure = await resolvePromotionCapabilityClosure({ campaignRoot: campaign, candidate, usageManifest: usage, versionedBaselineRoot: baselineRoot });
  assert.equal(closure.mode, "versioned_baseline");
  assert.equal(closure.versionedBaselineManifestHash, baseline.canonicalHash);
  assert.deepEqual(closure.requiredAcquisitionReceiptHashes, [acquired.canonicalHash]);

  const promotedArtifact = join(baselineRoot, baseline.requiredTools[0]!.installedRelativePath);
  await chmod(promotedArtifact, 0o600);
  await writeFile(promotedArtifact, "tampered\n");
  await assert.rejects(() => verifyVersionedBaseline(baselineRoot), /artifact hash/i);
});
