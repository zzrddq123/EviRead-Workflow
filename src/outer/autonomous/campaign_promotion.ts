import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { canonicalJson, hashCanonical } from "../../hash.js";
import {
  findCapabilityCampaignRoot,
  readCandidateCapabilityUsage,
  resolvePromotionCapabilityClosure,
  type PromotionCapabilityClosure,
} from "../../experiment/baseline_governance.js";
import {
  assertAutonomousRsiCampaignIdentity,
  campaignIdentityPath,
  discoverAutonomousRsiCampaignIdentity,
  updateAutonomousRsiCampaignIdentity,
  type AutonomousRsiCampaignIdentity,
} from "./campaign_identity.js";
import { assertAutonomousCandidateGraph, type AutonomousRsiCandidateGraph, type AutonomousRsiCandidateNode } from "./candidate_graph.js";
import { assertAutonomousCandidate, assertAutonomousRsiSpec, type AutonomousRsiCandidate, type AutonomousRsiSpec } from "./contracts.js";
import { verifyAutonomousRsiCampaign } from "./orchestrator.js";

const exec = promisify(execFile);
const HASH = /^[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40,64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRIVATE_TEXT = /(?:^|[\/._-])(?:evaluator[_-]?private|private|gold|known[_-]?mask|target[_-]?identity|vault)(?:$|[\/._-])/i;

interface ArchiveCandidate {
  candidateId: string;
  artifactHash: string;
  sourceCommit: string;
  sourceTree: string;
  parentSourceCommit: string | null;
  graphAdmission: "evaluated" | "pending_evaluation" | "unadmitted_ref";
  verificationPassed: boolean;
  evaluation: { metricId: string; value: number; iteration: number; outputHash: string } | null;
  hypothesis: string | null;
  lesson: string | null;
}

export interface AutonomousRsiCampaignArchive extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-campaign-archive.v1";
  campaignId: string;
  baselineCommit: string;
  evaluatorContractHash: string | null;
  objective: { metricId: string; direction: "maximize" | "minimize"; minimumImprovement: number };
  terminalStatus: string;
  stopReason: string;
  selectedCandidateId: string;
  selectedSourceCommit: string;
  candidateGraphHash: string;
  eventHeadHash: string | null;
  knowledgeHeadHash: string | null;
  candidates: ArchiveCandidate[];
  baseDecisions: AutonomousRsiCandidateGraph["baseDecisions"];
  knowledgeCards: AutonomousRsiCandidateGraph["knowledgeCards"];
  claimBoundary: "development campaign archive; complete code snapshots, aggregate evaluations, and sanitized lessons; not formal scientific promotion";
  canonicalHash: string;
}

export interface AutonomousRsiPromotionPreview extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-promotion-preview.v1";
  action: "archive" | "promote";
  campaignId: string;
  worktreePath: string;
  repositoryRoot: string;
  mainRef: string;
  remote: string | null;
  baselineCommit: string;
  currentMainCommit: string;
  selectedCandidateId: string;
  selectedSourceCommit: string;
  selectedSourceTree: string;
  candidateCount: number;
  evaluatorContractHash: string | null;
  campaignVerification: { valid: true; status: string; eventCount: number };
  mainBaselineCompatible: boolean;
  trackedPrimaryCheckoutClean: boolean;
  publicationRefs: string[];
  capabilityClosure: PromotionCapabilityClosure | null;
  warnings: string[];
  canonicalHash: string;
}

export interface AutonomousRsiPromotionReceipt extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-promotion-receipt.v1";
  action: "archive" | "promote";
  campaignId: string;
  previewHash: string;
  authorization: { source: "explicit_apply_flag"; previewHash: string };
  archiveManifestHash: string;
  archiveCommit: string;
  selectedCandidateId: string;
  selectedSourceCommit: string;
  mainBefore: string;
  mainAfter: string;
  remote: string | null;
  publishedRefs: string[];
  capabilityClosure: PromotionCapabilityClosure | null;
  status: "completed";
  canonicalHash: string;
}

interface LoadedPromotion {
  identity: AutonomousRsiCampaignIdentity;
  spec: AutonomousRsiSpec;
  graph: AutonomousRsiCandidateGraph;
  handoff: Record<string, unknown>;
  state: Record<string, unknown>;
  selected: AutonomousRsiCandidate;
  candidates: ArchiveCandidate[];
  archive: AutonomousRsiCampaignArchive;
  preview: AutonomousRsiPromotionPreview;
  capabilityClosure: PromotionCapabilityClosure | null;
}

function inside(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

async function git(repository: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return (await exec("/usr/bin/git", args, {
    cwd: repository,
    env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...env },
    maxBuffer: 16 * 1024 * 1024,
  })).stdout.trim();
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function canonicalRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const item = value as Record<string, unknown>;
  const { canonicalHash, ...content } = item;
  if (typeof canonicalHash !== "string" || !HASH.test(canonicalHash) || canonicalHash !== hashCanonical(content)) {
    throw new Error(`${label} canonicalHash mismatch`);
  }
  return item;
}

function sameCandidate(left: AutonomousRsiCandidate, right: AutonomousRsiCandidate): boolean {
  return left.candidateId === right.candidateId && left.artifactHash === right.artifactHash && left.sourceCommit === right.sourceCommit;
}

async function objectBinding(repository: string, commit: string): Promise<{ tree: string; parents: string[] }> {
  if (!OID.test(commit)) throw new Error(`invalid candidate commit: ${commit}`);
  await git(repository, ["cat-file", "-e", `${commit}^{commit}`]);
  const tree = await git(repository, ["rev-parse", `${commit}^{tree}`]);
  const parents = (await git(repository, ["show", "-s", "--format=%P", commit])).split(/\s+/).filter(Boolean);
  return { tree, parents };
}

function graphNodeCandidate(node: AutonomousRsiCandidateNode, tree: string, parentSourceCommit: string | null): ArchiveCandidate {
  return {
    candidateId: node.candidate.candidateId,
    artifactHash: node.candidate.artifactHash,
    sourceCommit: node.candidate.sourceCommit!,
    sourceTree: tree,
    parentSourceCommit,
    graphAdmission: node.status,
    verificationPassed: node.parentCandidateId === null || node.verification?.passed === true || node.provenance?.kind === "historical_seed",
    evaluation: node.evaluation ? {
      metricId: node.evaluation.metricId,
      value: node.evaluation.value,
      iteration: node.evaluation.iteration,
      outputHash: node.evaluation.outputHash,
    } : null,
    hypothesis: node.plan?.hypothesis ?? null,
    lesson: node.reflection?.lesson ?? null,
  };
}

function privacyScan(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (PRIVATE_TEXT.test(serialized)
    || /GO:\d{7}/i.test(serialized)
    || /(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-\d+)?/.test(serialized)) {
    throw new Error("campaign archive contains evaluator-private, Gold, target, accession, or GO-answer content");
  }
}

async function canonicalRemote(repository: string, mainRef: string): Promise<string | null> {
  try {
    const upstream = await git(repository, ["for-each-ref", "--format=%(upstream:remotename)", `refs/heads/${mainRef}`]);
    if (upstream) {
      await git(repository, ["remote", "get-url", upstream]);
      return upstream;
    }
    const remotes = (await git(repository, ["remote"])).split(/\s+/).filter(Boolean);
    if (remotes.length === 1) return remotes[0]!;
    if (remotes.includes("origin")) return "origin";
    return null;
  } catch {
    return null;
  }
}

async function primaryCheckoutTrackedClean(repository: string, mainRef: string): Promise<boolean> {
  const worktrees = (await git(repository, ["worktree", "list", "--porcelain"])).split("\n\n");
  for (const block of worktrees) {
    const lines = block.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
    if (path && branch === `refs/heads/${mainRef}`) {
      return (await git(path, ["status", "--porcelain", "--untracked-files=no"])) === "";
    }
  }
  return true;
}

async function archiveCandidates(repository: string, campaignId: string, graph: AutonomousRsiCandidateGraph): Promise<ArchiveCandidate[]> {
  const graphByCommit = new Map(graph.nodes.flatMap((node) => node.candidate.sourceCommit ? [[node.candidate.sourceCommit, node] as const] : []));
  const candidates: ArchiveCandidate[] = [];
  for (const node of graph.nodes) {
    if (!node.candidate.sourceCommit) throw new Error(`candidate ${node.candidate.candidateId} is not commit-bound`);
    const binding = await objectBinding(repository, node.candidate.sourceCommit);
    const parentSourceCommit = node.parentCandidateId
      ? graph.nodes.find((candidate) => candidate.candidate.candidateId === node.parentCandidateId)?.candidate.sourceCommit ?? null
      : null;
    if (parentSourceCommit && !binding.parents.includes(parentSourceCommit)) {
      throw new Error(`candidate ${node.candidate.candidateId} Git parent does not match the candidate graph`);
    }
    candidates.push(graphNodeCandidate(node, binding.tree, parentSourceCommit));
  }
  const refs = (await git(repository, ["for-each-ref", "--format=%(refname)%00%(objectname)", `refs/autonomous/${campaignId}/candidates/`]))
    .split("\n").filter(Boolean);
  for (const line of refs) {
    const [ref, commit] = line.split("\0");
    if (!ref || !commit || graphByCommit.has(commit)) continue;
    const binding = await objectBinding(repository, commit);
    const candidateId = ref.slice(ref.lastIndexOf("/") + 1);
    if (!SAFE_ID.test(candidateId)) throw new Error(`autonomous candidate ref has an unsafe identity: ${ref}`);
    candidates.push({
      candidateId,
      artifactHash: createHash("sha256").update(`unadmitted\0${commit}\0${binding.tree}`).digest("hex"),
      sourceCommit: commit,
      sourceTree: binding.tree,
      parentSourceCommit: binding.parents[0] ?? null,
      graphAdmission: "unadmitted_ref",
      verificationPassed: false,
      evaluation: null,
      hypothesis: null,
      lesson: "Candidate code preserved before software verification; not eligible as a historical executable base.",
    });
  }
  const byId = [...candidates].sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  if (new Set(byId.map((candidate) => candidate.candidateId)).size !== byId.length) throw new Error("campaign archive candidate IDs are not unique");
  return byId;
}

async function loadPromotion(input: { targetPath: string; action: "archive" | "promote"; mainRef: string; versionedBaselineRoot: string | null }): Promise<LoadedPromotion> {
  const identity = assertAutonomousRsiCampaignIdentity(await discoverAutonomousRsiCampaignIdentity(input.targetPath));
  const repository = await realpath(identity.repositoryRoot);
  const campaignDir = await realpath(identity.campaignDir);
  if (inside(campaignDir, repository)) throw new Error("campaign directory must remain outside the repository");
  if (identity.status === "promoted") {
    throw new Error("campaign is already promoted; immutable closeout is not replayed");
  }
  const top = await realpath(await git(repository, ["rev-parse", "--show-toplevel"]));
  if (top !== repository) throw new Error("campaign identity repository is not the Git top level");
  const verification = await verifyAutonomousRsiCampaign(campaignDir);
  if (!verification.valid || !["completed", "stopped"].includes(verification.status)) {
    throw new Error("only a terminal, verified campaign can be archived or promoted");
  }
  const spec = assertAutonomousRsiSpec(await json(join(campaignDir, "spec.json")));
  if (spec.campaignId !== identity.campaignId || spec.initialCandidate.sourceCommit !== identity.baselineCommit) {
    throw new Error("campaign identity differs from the sealed spec baseline");
  }
  const graph = assertAutonomousCandidateGraph(await json(join(campaignDir, "exploration", "candidate_graph.json")) as AutonomousRsiCandidateGraph, spec);
  const handoff = canonicalRecord(await json(join(campaignDir, "formal_handoff.json")), "formal handoff");
  const state = canonicalRecord(await json(join(campaignDir, "state.json")), "campaign state");
  const selected = assertAutonomousCandidate(handoff.selectedCandidate, "formal handoff selectedCandidate");
  if (!selected.sourceCommit || graph.bestCandidateId !== selected.candidateId) {
    throw new Error("formal handoff selected candidate is not the exact verified graph best");
  }
  const bestNode = graph.nodes.find((node) => node.candidate.candidateId === graph.bestCandidateId);
  if (!bestNode || bestNode.status !== "evaluated" || !bestNode.evaluation || !sameCandidate(bestNode.candidate, selected)) {
    throw new Error("selected candidate is not a completed evaluated graph node");
  }
  const candidates = await archiveCandidates(repository, identity.campaignId, graph);
  const selectedArchive = candidates.find((candidate) => candidate.candidateId === selected.candidateId);
  if (!selectedArchive || selectedArchive.graphAdmission !== "evaluated" || selectedArchive.verificationPassed !== true) {
    throw new Error("selected candidate does not pass the archive eligibility contract");
  }
  if (!identity.evaluatorContractHash || spec.evaluatorContractHash !== identity.evaluatorContractHash) {
    throw new Error("promotion requires one frozen evaluatorContractHash bound identically by campaign identity and spec");
  }
  const archiveBody = {
    schemaVersion: "pi-autonomous-rsi-campaign-archive.v1" as const,
    campaignId: identity.campaignId,
    baselineCommit: identity.baselineCommit,
    evaluatorContractHash: spec.evaluatorContractHash ?? identity.evaluatorContractHash,
    objective: { metricId: spec.objective.metricId, direction: spec.objective.direction, minimumImprovement: spec.objective.minimumImprovement },
    terminalStatus: verification.status,
    stopReason: String(state.stopReason),
    selectedCandidateId: selected.candidateId,
    selectedSourceCommit: selected.sourceCommit,
    candidateGraphHash: graph.canonicalHash,
    eventHeadHash: verification.eventHeadHash,
    knowledgeHeadHash: verification.knowledgeHeadHash,
    candidates,
    baseDecisions: graph.baseDecisions,
    knowledgeCards: graph.knowledgeCards,
    claimBoundary: "development campaign archive; complete code snapshots, aggregate evaluations, and sanitized lessons; not formal scientific promotion" as const,
  };
  privacyScan(archiveBody);
  const archive = { ...archiveBody, canonicalHash: hashCanonical(archiveBody) };
  const currentMainCommit = await git(repository, ["rev-parse", `refs/heads/${input.mainRef}`]);
  const selectedBinding = await objectBinding(repository, selected.sourceCommit);
  let capabilityClosure: PromotionCapabilityClosure | null = null;
  if (input.action === "promote") {
    const capabilityRoot = await findCapabilityCampaignRoot(campaignDir);
    const usage = await readCandidateCapabilityUsage(capabilityRoot, selected.candidateId);
    capabilityClosure = await resolvePromotionCapabilityClosure({ campaignRoot: capabilityRoot, candidate: { candidateId: selected.candidateId, sourceCommit: selected.sourceCommit, sourceTree: selectedBinding.tree }, usageManifest: usage, versionedBaselineRoot: input.versionedBaselineRoot });
  }
  const remote = await canonicalRemote(repository, input.mainRef);
  const publicationRefs = candidates.map((candidate) => `refs/campaigns/${identity.campaignId}/candidates/${candidate.candidateId}`);
  publicationRefs.push(`refs/campaigns/${identity.campaignId}/archive`);
  const warnings: string[] = [];
  if (currentMainCommit !== identity.baselineCommit) warnings.push("main has advanced since campaign start; promotion is blocked until a separately evaluated integration candidate exists");
  if (!remote) warnings.push("no unambiguous canonical remote was discovered; archive can remain local but cannot be published remotely");
  const trackedClean = await primaryCheckoutTrackedClean(repository, input.mainRef);
  if (!trackedClean) warnings.push("the primary main checkout has tracked changes; main ref updates are blocked");
  const expectedWorktreeHead = await git(identity.worktreePath, ["rev-parse", "HEAD"]);
  if (!candidates.some((candidate) => candidate.sourceCommit === expectedWorktreeHead)) {
    throw new Error("registered campaign worktree HEAD is not one of this campaign's preserved candidate commits");
  }
  if (await git(identity.worktreePath, ["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("registered campaign worktree has tracked changes; closeout refuses mutable uncommitted code");
  }
  const previewBody = {
    schemaVersion: "pi-autonomous-rsi-promotion-preview.v1" as const,
    action: input.action,
    campaignId: identity.campaignId,
    worktreePath: identity.worktreePath,
    repositoryRoot: repository,
    mainRef: input.mainRef,
    remote,
    baselineCommit: identity.baselineCommit,
    currentMainCommit,
    selectedCandidateId: selected.candidateId,
    selectedSourceCommit: selected.sourceCommit,
    selectedSourceTree: selectedBinding.tree,
    candidateCount: candidates.length,
    evaluatorContractHash: archive.evaluatorContractHash,
    campaignVerification: { valid: true as const, status: verification.status, eventCount: verification.eventCount },
    mainBaselineCompatible: currentMainCommit === identity.baselineCommit,
    trackedPrimaryCheckoutClean: trackedClean,
    publicationRefs,
    capabilityClosure,
    warnings,
  };
  const preview = { ...previewBody, canonicalHash: hashCanonical(previewBody) };
  return { identity, spec, graph, handoff, state, selected, candidates, archive, preview, capabilityClosure };
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function createArchiveCommit(repository: string, archive: AutonomousRsiCampaignArchive): Promise<string> {
  const message = `archive autonomous RSI campaign ${archive.campaignId}`;
  const archiveJson = `${JSON.stringify(archive, null, 2)}\n`;
  const { spawnSync } = await import("node:child_process");
  const blobResult = spawnSync("/usr/bin/git", ["hash-object", "-w", "--stdin"], {
    cwd: repository,
    env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C.UTF-8" },
    input: archiveJson,
    encoding: "utf8",
  });
  if (blobResult.status !== 0) throw new Error(`failed to write campaign archive blob: ${blobResult.stderr}`);
  const blobOid = blobResult.stdout.trim();
  const treeInput = `100644 blob ${blobOid}\tcampaign_archive.json\n`;
  const treeResult = spawnSync("/usr/bin/git", ["mktree"], {
    cwd: repository,
    env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C.UTF-8" },
    input: treeInput,
    encoding: "utf8",
  });
  if (treeResult.status !== 0) throw new Error(`failed to create campaign archive tree: ${treeResult.stderr}`);
  const commitResult = spawnSync("/usr/bin/git", ["commit-tree", treeResult.stdout.trim()], {
    cwd: repository,
    env: {
      HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C.UTF-8",
      GIT_AUTHOR_NAME: "Autonomous RSI Host", GIT_AUTHOR_EMAIL: "autonomous-rsi@local.invalid",
      GIT_COMMITTER_NAME: "Autonomous RSI Host", GIT_COMMITTER_EMAIL: "autonomous-rsi@local.invalid",
    },
    input: `${message}\n`,
    encoding: "utf8",
  });
  if (commitResult.status !== 0) throw new Error(`failed to create campaign archive commit: ${commitResult.stderr}`);
  return commitResult.stdout.trim();
}

async function mainCheckout(repository: string, mainRef: string): Promise<string> {
  const worktrees = (await git(repository, ["worktree", "list", "--porcelain"])).split("\n\n");
  for (const block of worktrees) {
    const lines = block.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
    if (path && branch === `refs/heads/${mainRef}`) return await realpath(path);
  }
  throw new Error(`no checkout owns refs/heads/${mainRef}; promotion requires the canonical main checkout`);
}

async function publishRefs(input: {
  repository: string;
  campaignId: string;
  candidates: ArchiveCandidate[];
  archiveCommit: string;
  remote: string | null;
  mainRef: string;
  mainBefore: string;
  mainAfter: string;
  action: "archive" | "promote";
}): Promise<string[]> {
  const refs = input.candidates.map((candidate) => ({
    ref: `refs/campaigns/${input.campaignId}/candidates/${candidate.candidateId}`,
    oid: candidate.sourceCommit,
  }));
  refs.push({ ref: `refs/campaigns/${input.campaignId}/archive`, oid: input.archiveCommit });
  for (const binding of refs) {
    await git(input.repository, ["check-ref-format", binding.ref]);
    try {
      const existing = await git(input.repository, ["rev-parse", "--verify", binding.ref]);
      if (existing !== binding.oid) throw new Error(`immutable campaign ref already points elsewhere: ${binding.ref}`);
    } catch (error) {
      if (!/Needed a single revision|unknown revision|ambiguous argument/i.test(error instanceof Error ? error.message : String(error))) throw error;
      await git(input.repository, ["update-ref", binding.ref, binding.oid, ""]);
    }
  }
  if (input.action === "promote") {
    const checkout = await mainCheckout(input.repository, input.mainRef);
    if (await git(checkout, ["rev-parse", "HEAD"]) !== input.mainBefore) throw new Error("main checkout moved after preview");
    if (await git(checkout, ["status", "--porcelain", "--untracked-files=no"])) throw new Error("main checkout gained tracked changes after preview");
    await git(checkout, ["merge", "--ff-only", input.mainAfter]);
  }
  if (input.remote) {
    const refspecs = refs.map((binding) => `${binding.ref}:${binding.ref}`);
    if (input.action === "promote") refspecs.push(`refs/heads/${input.mainRef}:refs/heads/${input.mainRef}`);
    try {
      await git(input.repository, ["push", "--atomic", input.remote, ...refspecs]);
    } catch (error) {
      throw new Error(`atomic remote publication failed; local refs remain recoverable and the command is safe to retry: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const binding of refs) {
      const remoteOid = (await git(input.repository, ["ls-remote", input.remote, binding.ref])).split(/\s+/)[0];
      if (remoteOid !== binding.oid) throw new Error(`remote campaign ref verification failed: ${binding.ref}`);
    }
    if (input.action === "promote") {
      const remoteMain = (await git(input.repository, ["ls-remote", input.remote, `refs/heads/${input.mainRef}`])).split(/\s+/)[0];
      if (remoteMain !== input.mainAfter) throw new Error("remote main verification failed after promotion");
    }
  }
  return refs.map((binding) => binding.ref);
}

export async function previewAutonomousRsiPromotion(input: {
  targetPath: string;
  action: "archive" | "promote";
  mainRef?: string;
  versionedBaselineRoot?: string | null;
}): Promise<AutonomousRsiPromotionPreview> {
  return (await loadPromotion({ targetPath: input.targetPath, action: input.action, mainRef: input.mainRef ?? "main", versionedBaselineRoot: input.versionedBaselineRoot ?? null })).preview;
}

export async function applyAutonomousRsiPromotion(input: {
  targetPath: string;
  action: "archive" | "promote";
  expectedPreviewHash: string;
  mainRef?: string;
  versionedBaselineRoot?: string | null;
}): Promise<AutonomousRsiPromotionReceipt> {
  if (!HASH.test(input.expectedPreviewHash)) throw new Error("apply requires the exact preview hash as authorization");
  const loaded = await loadPromotion({ targetPath: input.targetPath, action: input.action, mainRef: input.mainRef ?? "main", versionedBaselineRoot: input.versionedBaselineRoot ?? null });
  if (loaded.preview.canonicalHash !== input.expectedPreviewHash) throw new Error("promotion preview changed; review the new preview before applying");
  if (input.action === "promote" && (!loaded.preview.mainBaselineCompatible || !loaded.preview.trackedPrimaryCheckoutClean)) {
    throw new Error("promotion is blocked: main baseline drift or tracked primary-checkout changes require a separately verified integration candidate");
  }
  const repository = loaded.preview.repositoryRoot;
  const archiveCommit = await createArchiveCommit(repository, loaded.archive);
  const mainBefore = loaded.preview.currentMainCommit;
  const mainAfter = input.action === "promote" ? loaded.preview.selectedSourceCommit : mainBefore;
  let publishedRefs: string[] = [];
  try {
    publishedRefs = await publishRefs({
      repository,
      campaignId: loaded.identity.campaignId,
      candidates: loaded.candidates,
      archiveCommit,
      remote: loaded.preview.remote,
      mainRef: loaded.preview.mainRef,
      mainBefore,
      mainAfter,
      action: input.action,
    });
  } catch (error) {
    if (input.action === "promote") {
      const localMain = await git(repository, ["rev-parse", `refs/heads/${loaded.preview.mainRef}`]);
      if (localMain === mainAfter) {
        const checkout = await mainCheckout(repository, loaded.preview.mainRef);
        await git(checkout, ["checkout", "--detach", mainBefore]);
        await git(repository, ["update-ref", `refs/heads/${loaded.preview.mainRef}`, mainBefore, mainAfter]);
        await git(checkout, ["checkout", loaded.preview.mainRef]);
      }
    }
    throw error;
  }
  const receiptBody = {
    schemaVersion: "pi-autonomous-rsi-promotion-receipt.v1" as const,
    action: input.action,
    campaignId: loaded.identity.campaignId,
    previewHash: loaded.preview.canonicalHash,
    authorization: { source: "explicit_apply_flag" as const, previewHash: loaded.preview.canonicalHash },
    archiveManifestHash: loaded.archive.canonicalHash,
    archiveCommit,
    selectedCandidateId: loaded.preview.selectedCandidateId,
    selectedSourceCommit: loaded.preview.selectedSourceCommit,
    mainBefore,
    mainAfter,
    remote: loaded.preview.remote,
    publishedRefs,
    capabilityClosure: loaded.capabilityClosure,
    status: "completed" as const,
  };
  const receipt = { ...receiptBody, canonicalHash: hashCanonical(receiptBody) };
  const receiptPath = join(loaded.identity.campaignDir, "promotion", `${input.action}-receipt.json`);
  await atomicWrite(receiptPath, receipt);
  const archivePath = join(loaded.identity.campaignDir, "promotion", "campaign_archive.json");
  await atomicWrite(archivePath, loaded.archive);
  const nextIdentity = await updateAutonomousRsiCampaignIdentity(loaded.identity, {
    status: input.action === "promote" ? "promoted" : "archived",
    archiveManifestHash: loaded.archive.canonicalHash,
    promotionReceiptHash: receipt.canonicalHash,
  });
  if (canonicalJson(nextIdentity) !== canonicalJson(await json(campaignIdentityPath(nextIdentity.workspaceRoot, nextIdentity.campaignId)))) {
    throw new Error("campaign identity readback verification failed");
  }
  return receipt;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function autonomousRsiPromotionCommand(command: string, args: string[]): Promise<number> {
  const action = command === "autonomous-rsi-archive" ? "archive" as const : "promote" as const;
  const allowed = new Set(["--worktree", "--main-ref", "--baseline-root", "--apply", "--expected-preview-hash"]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!allowed.has(value)) throw new Error(`invalid ${command} argument: ${value}`);
    if (value !== "--apply") index += 1;
  }
  const targetPath = resolve(option(args, "--worktree") ?? ".");
  const mainRef = option(args, "--main-ref") ?? "main";
  const versionedBaselineRoot = option(args, "--baseline-root") ?? null;
  if (!args.includes("--apply")) {
    const preview = await previewAutonomousRsiPromotion({ targetPath, action, mainRef, versionedBaselineRoot });
    console.log(JSON.stringify({ ok: true, mode: "preview", preview }, null, 2));
    return 0;
  }
  const expectedPreviewHash = option(args, "--expected-preview-hash");
  if (!expectedPreviewHash) throw new Error(`${command} --apply requires --expected-preview-hash from the reviewed preview`);
  const receipt = await applyAutonomousRsiPromotion({ targetPath, action, mainRef, expectedPreviewHash, versionedBaselineRoot });
  console.log(JSON.stringify({ ok: true, mode: "apply", receipt }, null, 2));
  return 0;
}
