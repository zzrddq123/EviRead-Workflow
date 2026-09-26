import { access, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { hashCanonical } from "../../hash.js";

export interface AutonomousRsiCampaignIdentity extends Record<string, unknown> {
  schemaVersion: "pi-autonomous-rsi-campaign-identity.v1";
  campaignId: string;
  campaignDir: string;
  repositoryRoot: string;
  workspaceRoot: string;
  worktreePath: string;
  baselineCommit: string;
  evaluatorContractHash: string | null;
  status: "running" | "terminal" | "archived" | "promoted";
  archiveManifestHash: string | null;
  promotionReceiptHash: string | null;
  canonicalHash: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const HASH = /^[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40,64}$/;
export const AUTONOMOUS_RSI_CAMPAIGN_IDENTITY_FILE = "campaign_identity.json";

function inside(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} keys mismatch`);
  }
}

export function assertAutonomousRsiCampaignIdentity(value: unknown): AutonomousRsiCampaignIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("campaign identity must be an object");
  const item = value as Record<string, unknown>;
  exactKeys(item, [
    "archiveManifestHash", "baselineCommit", "campaignDir", "campaignId", "canonicalHash",
    "evaluatorContractHash", "promotionReceiptHash", "repositoryRoot", "schemaVersion", "status",
    "workspaceRoot", "worktreePath",
  ], "campaign identity");
  const { canonicalHash, ...content } = item;
  if (item.schemaVersion !== "pi-autonomous-rsi-campaign-identity.v1"
    || typeof item.campaignId !== "string" || !SAFE_ID.test(item.campaignId)
    || typeof canonicalHash !== "string" || !HASH.test(canonicalHash) || canonicalHash !== hashCanonical(content)
    || typeof item.baselineCommit !== "string" || !OID.test(item.baselineCommit)
    || (item.evaluatorContractHash !== null && (typeof item.evaluatorContractHash !== "string" || !HASH.test(item.evaluatorContractHash)))
    || (item.archiveManifestHash !== null && (typeof item.archiveManifestHash !== "string" || !HASH.test(item.archiveManifestHash)))
    || (item.promotionReceiptHash !== null && (typeof item.promotionReceiptHash !== "string" || !HASH.test(item.promotionReceiptHash)))
    || !["running", "terminal", "archived", "promoted"].includes(String(item.status))) {
    throw new Error("campaign identity binding/hash is invalid");
  }
  for (const key of ["campaignDir", "repositoryRoot", "workspaceRoot", "worktreePath"] as const) {
    if (typeof item[key] !== "string" || !isAbsolute(item[key])) throw new Error(`campaign identity ${key} must be absolute`);
  }
  if (!inside(String(item.worktreePath), String(item.workspaceRoot))) throw new Error("campaign identity worktree escapes workspaceRoot");
  return item as unknown as AutonomousRsiCampaignIdentity;
}

export function campaignIdentityPath(workspaceRoot: string, campaignId: string): string {
  return join(resolve(workspaceRoot), campaignId, AUTONOMOUS_RSI_CAMPAIGN_IDENTITY_FILE);
}

async function atomicWrite(path: string, value: AutonomousRsiCampaignIdentity): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function writeAutonomousRsiCampaignIdentity(input: Omit<AutonomousRsiCampaignIdentity, "canonicalHash">): Promise<AutonomousRsiCampaignIdentity> {
  const value = assertAutonomousRsiCampaignIdentity({ ...input, canonicalHash: hashCanonical(input) });
  await atomicWrite(campaignIdentityPath(value.workspaceRoot, value.campaignId), value);
  return value;
}

export async function updateAutonomousRsiCampaignIdentity(
  identity: AutonomousRsiCampaignIdentity,
  changes: Pick<AutonomousRsiCampaignIdentity, "status" | "archiveManifestHash" | "promotionReceiptHash">,
): Promise<AutonomousRsiCampaignIdentity> {
  const { canonicalHash: _canonicalHash, ...body } = identity;
  return await writeAutonomousRsiCampaignIdentity({ ...body, ...changes });
}

async function load(path: string): Promise<AutonomousRsiCampaignIdentity> {
  return assertAutonomousRsiCampaignIdentity(JSON.parse(await readFile(path, "utf8")) as unknown);
}

/** Resolve an explicitly selected campaign worktree or one of its descendants. */
export async function discoverAutonomousRsiCampaignIdentity(targetPath: string): Promise<AutonomousRsiCampaignIdentity> {
  let cursor = await realpath(resolve(targetPath));
  for (;;) {
    const candidates = [
      join(cursor, AUTONOMOUS_RSI_CAMPAIGN_IDENTITY_FILE),
      join(dirname(cursor), AUTONOMOUS_RSI_CAMPAIGN_IDENTITY_FILE),
    ];
    for (const candidate of candidates) {
      try {
        await access(candidate);
        const identity = await load(candidate);
        const selected = await realpath(resolve(targetPath));
        const worktree = await realpath(identity.worktreePath);
        if (!inside(selected, worktree) && selected !== worktree) {
          throw new Error("selected path does not belong to the discovered campaign worktree");
        }
        if (await realpath(resolve(candidate)) !== await realpath(campaignIdentityPath(identity.workspaceRoot, identity.campaignId))) {
          throw new Error("campaign identity is not at its canonical workspace location");
        }
        return identity;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error("no autonomous RSI campaign identity found for the selected worktree; specify an exact registered campaign worktree");
}
