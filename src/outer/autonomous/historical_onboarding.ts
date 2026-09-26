import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { hashCanonical } from "../../hash.js";
import type { AutonomousRsiHistoricalSeed } from "./contracts.js";

interface PublishedCampaignCandidate {
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

interface PublishedCampaignManifest extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-campaign-archive.v1";
  campaignId: string;
  baselineCommit: string;
  evaluatorContractHash: string | null;
  objective: { metricId: string; direction: "maximize" | "minimize"; minimumImprovement: number };
  selectedCandidateId: string;
  candidates: PublishedCampaignCandidate[];
  canonicalHash: string;
}

const HASH = /^[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40,64}$/;

function inside(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function parseManifest(value: unknown): PublishedCampaignManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("published campaign manifest must be an object");
  const item = value as Record<string, unknown>;
  const { canonicalHash, ...content } = item;
  if (item.schemaVersion !== "pi-autonomous-rsi-campaign-archive.v1"
    || typeof canonicalHash !== "string" || !HASH.test(canonicalHash) || canonicalHash !== hashCanonical(content)
    || typeof item.campaignId !== "string"
    || typeof item.baselineCommit !== "string" || !OID.test(item.baselineCommit)
    || (item.evaluatorContractHash !== null && (typeof item.evaluatorContractHash !== "string" || !HASH.test(item.evaluatorContractHash)))
    || !item.objective || typeof item.objective !== "object" || Array.isArray(item.objective)
    || !Array.isArray(item.candidates)) {
    throw new Error("published campaign manifest binding/hash is invalid");
  }
  return item as unknown as PublishedCampaignManifest;
}

async function git(repositoryRoot: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return (await promisify(execFile)("/usr/bin/git", args, {
    cwd: repositoryRoot,
    env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C.UTF-8" },
    maxBuffer: 8 * 1024 * 1024,
  })).stdout.trim();
}

async function discoverPublishedManifests(repositoryRoot: string): Promise<PublishedCampaignManifest[]> {
  const upstreamRemote = await git(repositoryRoot, ["for-each-ref", "--format=%(upstream:remotename)", "refs/heads/main"]).catch(() => "");
  if (upstreamRemote) {
    await git(repositoryRoot, ["fetch", "--no-tags", upstreamRemote, "+refs/campaigns/*:refs/campaigns/*"]).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/couldn't find remote ref|no such ref/i.test(message)) throw error;
      return "";
    });
  }
  const refs = (await git(repositoryRoot, ["for-each-ref", "--format=%(refname)", "refs/campaigns/*/archive"]))
    .split("\n").filter(Boolean).sort();
  const manifests: PublishedCampaignManifest[] = [];
  for (const ref of refs) {
    manifests.push(parseManifest(JSON.parse(await git(repositoryRoot, ["show", `${ref}:campaign_archive.json`])) as unknown));
  }
  return manifests;
}

export async function loadCompatibleHistoricalSeeds(input: {
  repositoryRoot: string;
  historyPath?: string;
  evaluatorContractHash: string;
  metricId: string;
  excludeSourceCommit?: string;
}): Promise<AutonomousRsiHistoricalSeed[]> {
  const repositoryRoot = await realpath(input.repositoryRoot);
  let manifests: PublishedCampaignManifest[];
  if (input.historyPath) {
    const historyPath = resolve(input.historyPath);
    if (!isAbsolute(historyPath) || inside(historyPath, repositoryRoot)) {
      throw new Error("published campaign history must be an explicit file outside the candidate repository");
    }
    const raw = JSON.parse(await readFile(historyPath, "utf8")) as unknown;
    manifests = Array.isArray(raw) ? raw.map(parseManifest) : [parseManifest(raw)];
  } else {
    manifests = await discoverPublishedManifests(repositoryRoot);
  }
  const seeds: AutonomousRsiHistoricalSeed[] = [];
  const seenCommits = new Set<string>();
  for (const manifest of manifests) {
    if (manifest.evaluatorContractHash !== input.evaluatorContractHash || manifest.objective.metricId !== input.metricId) continue;
    for (const candidate of manifest.candidates) {
      if (candidate.graphAdmission !== "evaluated" || candidate.verificationPassed !== true || !candidate.evaluation) continue;
      if (candidate.sourceCommit === input.excludeSourceCommit || seenCommits.has(candidate.sourceCommit)) continue;
      if (!OID.test(candidate.sourceCommit) || !OID.test(candidate.sourceTree)
        || !HASH.test(candidate.artifactHash) || !HASH.test(candidate.evaluation.outputHash)) {
        throw new Error(`published candidate ${candidate.candidateId} has invalid object/hash bindings`);
      }
      await git(repositoryRoot, ["cat-file", "-e", `${candidate.sourceCommit}^{commit}`]);
      if (await git(repositoryRoot, ["rev-parse", `${candidate.sourceCommit}^{tree}`]) !== candidate.sourceTree) {
        throw new Error(`published candidate ${candidate.candidateId} tree binding mismatch`);
      }
      if (candidate.parentSourceCommit) {
        const parents = (await git(repositoryRoot, ["show", "-s", "--format=%P", candidate.sourceCommit])).split(/\s+/).filter(Boolean);
        if (!parents.includes(candidate.parentSourceCommit)) throw new Error(`published candidate ${candidate.candidateId} parent binding mismatch`);
      }
      seenCommits.add(candidate.sourceCommit);
      seeds.push({
        seedId: `history-${manifest.campaignId.slice(0, 40)}-${candidate.candidateId.slice(0, 40)}-${candidate.sourceCommit.slice(0, 12)}`,
        originCampaignId: manifest.campaignId,
        originalCandidateId: candidate.candidateId,
        archiveManifestHash: manifest.canonicalHash,
        evaluatorContractHash: input.evaluatorContractHash,
        candidate: {
          candidateId: candidate.candidateId,
          artifactHash: candidate.artifactHash,
          sourceCommit: candidate.sourceCommit,
        },
        parentSourceCommit: candidate.parentSourceCommit,
        evaluation: candidate.evaluation,
        hypothesis: candidate.hypothesis,
        lesson: candidate.lesson,
        verificationPassed: true,
      });
    }
  }
  const duplicate = seeds.find((seed, index) => seeds.findIndex((other) => other.seedId === seed.seedId) !== index);
  if (duplicate) throw new Error(`published history contains duplicate candidate identity: ${duplicate.seedId}`);
  return seeds;
}

export function historicalCampaignManifestDirectory(historyPath: string): string {
  return dirname(resolve(historyPath));
}
