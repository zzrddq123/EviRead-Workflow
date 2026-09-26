import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  type BigIntStats,
} from "node:fs";
import {
  lstat,
  readFile,
  readlink,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { parseEnvFile, PROJECT_ROOT } from "./config.js";
import { hashCanonical } from "./hash.js";
import type { BatchManifest } from "./benchmark_io.js";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;

export const LOCAL_DEVELOPER_EXECUTION_SCOPE = "developer_local_snapshot" as const;
export type LocalDeveloperExecutionScope = typeof LOCAL_DEVELOPER_EXECUTION_SCOPE;

export interface LocalSnapshotFile {
  name: string;
  kind: "file" | "symlink";
  /** Present only for a safe relative in-family database symlink. */
  linkTarget?: string;
  sizeBytes: number;
  sha256: string;
}

export interface LocalSnapshotDatabase {
  label: "blast_swissprot" | "foldseek_swissprot" | "foldseek_pdb";
  configured: boolean;
  prefixLabel: "BLAST_DB" | "FOLDSEEK_SWISSPROT_DB" | "FOLDSEEK_PDB_DB";
  fingerprintKind: "full_file_sha256_with_safe_relative_symlinks_v1";
  files: LocalSnapshotFile[];
  fileCount: number;
  totalBytes: number;
  sourceHash: string;
}

export interface LocalSnapshotTool {
  label: "python" | "blastp" | "blastdbcmd" | "foldseek" | "merizo_python" | "chainsaw_python";
  configuredPathKind: "file" | "symlink";
  sizeBytes: number;
  sha256: string;
  version: string;
}

export interface LocalSnapshotOptionalTool {
  label: "merizo" | "chainsaw";
  configured: boolean;
  fingerprintKind: "full_required_artifact_sha256_v1";
  artifacts: Array<{ relativePath: string; sizeBytes: number; sha256: string }>;
  sourceHash: string;
}

export interface LocalEvidenceSnapshot {
  schemaVersion: "pi-local-evidence-snapshot.v1" | "pi-local-evidence-snapshot.v2";
  executionScope: LocalDeveloperExecutionScope;
  profile: "sequence_structure";
  portability: "nonportable_developer_override";
  resourceProfile?: { profileId: string; canonicalHash: string };
  configBinding: { label: string; sha256: string };
  runtimeContract: {
    sequenceSearchBackend: "local";
    structureSearchBackend: "local";
    /** Legacy shared search budget retained when reading v1 snapshots. */
    topK: number;
    sequenceTopK?: number;
    structureFullTopK?: number;
    structureDomainTopK?: number;
    annotationLimit: number;
    pdbEnabled: boolean;
    merizoEnabled: boolean;
    chainsawEnabled: boolean;
  };
  ontology: {
    label: "go-basic.obo";
    dataVersion: string;
    sizeBytes: number;
    sha256: string;
  };
  tools: LocalSnapshotTool[];
  optionalTools: LocalSnapshotOptionalTool[];
  databases: LocalSnapshotDatabase[];
  claimBoundary: string;
  canonicalHash: string;
}

function configPath(value: string): string {
  return resolve(PROJECT_ROOT, value);
}

function required(config: Record<string, string>, key: string): string {
  const value = config[key]?.trim();
  if (!value) throw new Error(`developer local snapshot requires ${key}`);
  return configPath(value);
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

async function sha256FileStreaming(path: string): Promise<string> {
  const digest = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

function sameStableStat(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function hashStableOrdinaryFile(path: string, label: string): Promise<{ sizeBytes: number; sha256: string }> {
  const before = await stat(path, { bigint: true });
  if (!before.isFile()) throw new Error(`${label} must resolve to an ordinary file`);
  const sha256 = await sha256FileStreaming(path);
  const after = await stat(path, { bigint: true });
  if (!sameStableStat(before, after)) {
    throw new Error(`${label} changed while its snapshot hash was being computed`);
  }
  const sizeBytes = Number(after.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error(`${label} has an unsafe file size`);
  return { sizeBytes, sha256 };
}

async function executableSnapshot(
  label: LocalSnapshotTool["label"],
  path: string,
  versionArgs: string[],
): Promise<LocalSnapshotTool> {
  const configured = await lstat(path).catch(() => null);
  if (!configured || (!configured.isFile() && !configured.isSymbolicLink())) {
    throw new Error(`${label} executable is missing or is not a file/symlink`);
  }
  const resolved = await realpath(path).catch(() => null);
  if (!resolved) throw new Error(`${label} executable symlink is dangling or cyclic`);
  const hashed = await hashStableOrdinaryFile(resolved, `${label} executable`);
  const executable = await stat(resolved);
  if ((executable.mode & 0o111) === 0) throw new Error(`${label} executable has no execute bit`);
  let version: string;
  try {
    const result = await execFileAsync(path, versionArgs, {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH ?? "" },
    });
    version = `${result.stdout || result.stderr}`.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  } catch (error) {
    throw new Error(`${label} version command failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!version || isAbsolute(version) || /(?:file:\/\/|[A-Za-z]:[\\/]|\/[Uu]sers\/|\/home\/)/.test(version)) {
    throw new Error(`${label} returned an empty or path-bearing version string`);
  }
  return {
    label,
    configuredPathKind: configured.isSymbolicLink() ? "symlink" : "file",
    ...hashed,
    version,
  };
}

function inside(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

async function databaseFile(prefix: string, path: string): Promise<LocalSnapshotFile> {
  const root = dirname(prefix);
  const prefixName = basename(prefix);
  const name = basename(path);
  const first = await lstat(path, { bigint: true });
  if (first.isFile()) {
    const hashed = await hashStableOrdinaryFile(path, `database file ${name}`);
    const after = await lstat(path, { bigint: true });
    if (!sameStableStat(first, after)) {
      throw new Error(`database file ${name} changed while its snapshot was built`);
    }
    return { name, kind: "file", ...hashed };
  }
  if (!first.isSymbolicLink()) throw new Error(`database prefix family contains a non-file entry: ${name}`);
  const linkTarget = await readlink(path);
  if (isAbsolute(linkTarget)) throw new Error(`database symlink ${name} must use a relative target`);
  const normalizedTarget = relative(root, resolve(root, linkTarget)).split(sep).join("/");
  if (!normalizedTarget || normalizedTarget === ".." || normalizedTarget.startsWith("../")) {
    throw new Error(`database symlink ${name} escapes its database directory`);
  }
  const rootReal = await realpath(root);
  const resolvedTarget = await realpath(path).catch(() => null);
  if (!resolvedTarget) throw new Error(`database symlink ${name} is dangling or cyclic`);
  if (!inside(rootReal, resolvedTarget) || !basename(resolvedTarget).startsWith(prefixName)) {
    throw new Error(`database symlink ${name} resolves outside its database prefix family`);
  }
  const hashed = await hashStableOrdinaryFile(resolvedTarget, `database symlink target ${name}`);
  const after = await lstat(path, { bigint: true });
  if (!sameStableStat(first, after)
    || await readlink(path) !== linkTarget) {
    throw new Error(`database symlink ${name} changed while its snapshot was built`);
  }
  return { name, kind: "symlink", linkTarget: normalizedTarget, ...hashed };
}

async function databaseSnapshot(
  label: LocalSnapshotDatabase["label"],
  prefixLabel: LocalSnapshotDatabase["prefixLabel"],
  prefix: string | null,
): Promise<LocalSnapshotDatabase> {
  if (!prefix) {
    const content = {
      label,
      configured: false,
      prefixLabel,
      fingerprintKind: "full_file_sha256_with_safe_relative_symlinks_v1" as const,
      files: [] as LocalSnapshotFile[],
      fileCount: 0,
      totalBytes: 0,
    };
    return { ...content, sourceHash: hashCanonical(content) };
  }
  const parent = dirname(prefix);
  const parentStat = await lstat(parent).catch(() => null);
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`${label} parent must be an ordinary directory`);
  }
  const prefixName = basename(prefix);
  const names = (await readdir(parent)).filter((name) => name.startsWith(prefixName)).sort();
  if (names.length === 0) throw new Error(`${label} database prefix has no files`);
  const files: LocalSnapshotFile[] = [];
  for (const name of names) files.push(await databaseFile(prefix, join(parent, name)));
  const content = {
    label,
    configured: true,
    prefixLabel,
    fingerprintKind: "full_file_sha256_with_safe_relative_symlinks_v1" as const,
    files,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
  };
  return { ...content, sourceHash: hashCanonical(content) };
}

const OPTIONAL_ARTIFACTS = {
  merizo: [
    "predict.py",
    "weights/weights_part_0.pt",
    "weights/weights_part_1.pt",
    "weights/weights_part_2.pt",
  ],
  chainsaw: [
    "get_predictions.py",
    "saved_models/model_v3/weights.pt",
    "stride/stride",
  ],
} as const;

async function optionalToolSnapshot(
  label: LocalSnapshotOptionalTool["label"],
  rootValue: string | undefined,
): Promise<LocalSnapshotOptionalTool> {
  const root = rootValue?.trim() ? configPath(rootValue) : null;
  if (!root) {
    const content = {
      label,
      configured: false,
      fingerprintKind: "full_required_artifact_sha256_v1" as const,
      artifacts: [] as LocalSnapshotOptionalTool["artifacts"],
    };
    return { ...content, sourceHash: hashCanonical(content) };
  }
  const rootStat = await lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} root must be an ordinary directory`);
  }
  const artifacts = [];
  for (const relativePath of OPTIONAL_ARTIFACTS[label]) {
    const path = resolve(root, relativePath);
    if (!inside(root, path)) throw new Error(`${label} artifact path escapes its root`);
    const pathStat = await lstat(path).catch(() => null);
    if (!pathStat?.isFile() || pathStat.isSymbolicLink()) {
      throw new Error(`${label} required artifact is missing or not ordinary: ${relativePath}`);
    }
    artifacts.push({ relativePath, ...await hashStableOrdinaryFile(path, `${label}/${relativePath}`) });
  }
  const content = {
    label,
    configured: true,
    fingerprintKind: "full_required_artifact_sha256_v1" as const,
    artifacts,
  };
  return { ...content, sourceHash: hashCanonical(content) };
}

function assertRedacted(value: unknown): void {
  const visit = (item: unknown, key: string): void => {
    if (typeof item === "string") {
      if (isAbsolute(item) || item.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(item)
        || item.includes("/Users/") || item.includes("/home/")) {
        throw new Error(`local snapshot contains a path-bearing value at ${key}`);
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${key}[${index}]`));
      return;
    }
    if (item && typeof item === "object") {
      for (const [childKey, child] of Object.entries(item as Record<string, unknown>)) {
        visit(child, `${key}.${childKey}`);
      }
    }
  };
  visit(value, "snapshot");
}

export async function buildLocalEvidenceSnapshot(input: {
  configPath: string;
  ontologyPath: string;
}): Promise<LocalEvidenceSnapshot> {
  const config = parseEnvFile(input.configPath);
  if (config.EVIDENCE_PROFILE !== "sequence_structure"
    || (config.SEQUENCE_SEARCH_BACKEND ?? "local") !== "local"
    || (config.STRUCTURE_SEARCH_BACKEND ?? "local") !== "local") {
    throw new Error("developer local snapshot requires EVIDENCE_PROFILE=sequence_structure and explicit local search backends");
  }
  const configuredOntology = required(config, "GO_ONTOLOGY_OBO");
  if (resolve(configuredOntology) !== resolve(input.ontologyPath)) {
    throw new Error("developer local snapshot ontology argument does not match GO_ONTOLOGY_OBO");
  }
  const ontologyBody = await readFile(input.ontologyPath, "utf8");
  const dataVersion = ontologyBody.match(/^data-version:\s*(.+)$/m)?.[1]?.trim();
  if (!dataVersion) throw new Error("GO ontology has no data-version binding");
  const ontologyStat = await lstat(input.ontologyPath);
  if (!ontologyStat.isFile() || ontologyStat.isSymbolicLink()) throw new Error("GO ontology must be an ordinary file");
  const ontology = await hashStableOrdinaryFile(input.ontologyPath, "GO ontology");
  const optionalTools = await Promise.all([
    optionalToolSnapshot("merizo", config.MERIZO_ROOT),
    optionalToolSnapshot("chainsaw", config.CHAINSAW_ROOT),
  ]);
  const tools: LocalSnapshotTool[] = await Promise.all([
    executableSnapshot("python", required(config, "PYTHON_BIN"), ["--version"]),
    executableSnapshot("blastp", required(config, "BLASTP_BIN"), ["-version"]),
    executableSnapshot("blastdbcmd", required(config, "BLASTDBCMD_BIN"), ["-version"]),
    executableSnapshot("foldseek", required(config, "FOLDSEEK_BIN"), ["version"]),
    ...(optionalTools[0].configured
      ? [executableSnapshot("merizo_python", required(config, "MERIZO_PYTHON"), ["--version"])]
      : []),
    ...(optionalTools[1].configured
      ? [executableSnapshot("chainsaw_python", required(config, "CHAINSAW_PYTHON"), ["--version"])]
      : []),
  ]);
  tools.sort((left, right) => left.label.localeCompare(right.label));
  const databases: LocalSnapshotDatabase[] = await Promise.all([
    databaseSnapshot("blast_swissprot", "BLAST_DB", required(config, "BLAST_DB")),
    databaseSnapshot(
      "foldseek_swissprot",
      "FOLDSEEK_SWISSPROT_DB",
      config.FOLDSEEK_SWISSPROT_DB?.trim() ? configPath(config.FOLDSEEK_SWISSPROT_DB) : null,
    ),
    databaseSnapshot(
      "foldseek_pdb",
      "FOLDSEEK_PDB_DB",
      config.FOLDSEEK_PDB_DB?.trim() ? configPath(config.FOLDSEEK_PDB_DB) : null,
    ),
  ]);
  if (!databases.some((item) => item.label !== "blast_swissprot" && item.configured)) {
    throw new Error("developer local snapshot requires at least one configured Foldseek database");
  }
  const resourceProfileDocument = await readOrdinaryJson(
    required(config, "TEMPORAL_RESOURCE_PROFILE"),
    "external resource profile",
  );
  const { canonicalHash: profileHash, ...profileContent } = resourceProfileDocument;
  if (resourceProfileDocument.schemaVersion !== "pi-external-resource-profile.v1"
    || typeof resourceProfileDocument.profileId !== "string"
    || typeof profileHash !== "string"
    || !SHA256.test(profileHash)
    || profileHash !== hashCanonical(profileContent)) {
    throw new Error("external resource profile is invalid or non-canonical");
  }
  const content = {
    schemaVersion: "pi-local-evidence-snapshot.v2" as const,
    executionScope: LOCAL_DEVELOPER_EXECUTION_SCOPE,
    profile: "sequence_structure" as const,
    portability: "nonportable_developer_override" as const,
    resourceProfile: {
      profileId: resourceProfileDocument.profileId,
      canonicalHash: profileHash,
    },
    configBinding: { label: basename(input.configPath), sha256: await sha256FileStreaming(input.configPath) },
    runtimeContract: {
      sequenceSearchBackend: "local" as const,
      structureSearchBackend: "local" as const,
      topK: positiveInteger(config.TOP_K, "TOP_K"),
      sequenceTopK: positiveInteger(config.SEQUENCE_TOP_K ?? config.TOP_K, "SEQUENCE_TOP_K"),
      structureFullTopK: positiveInteger(
        config.STRUCTURE_FULL_TOP_K ?? config.TOP_K,
        "STRUCTURE_FULL_TOP_K",
      ),
      structureDomainTopK: positiveInteger(
        config.STRUCTURE_DOMAIN_TOP_K ?? config.TOP_K,
        "STRUCTURE_DOMAIN_TOP_K",
      ),
      annotationLimit: positiveInteger(config.ANNOTATION_LIMIT, "ANNOTATION_LIMIT"),
      pdbEnabled: databases.find((item) => item.label === "foldseek_pdb")?.configured === true,
      merizoEnabled: optionalTools.find((item) => item.label === "merizo")?.configured === true,
      chainsawEnabled: optionalTools.find((item) => item.label === "chainsaw")?.configured === true,
    },
    ontology: { label: "go-basic.obo" as const, dataVersion, ...ontology },
    tools,
    optionalTools,
    databases,
    claimBoundary: "This full-content snapshot is valid only as an explicit workstation developer override. It proves byte identity within one run, not portable installation or a public database release.",
  };
  assertRedacted(content);
  return { ...content, canonicalHash: hashCanonical(content) };
}

export function assertLocalEvidenceSnapshot(value: unknown): LocalEvidenceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("local evidence snapshot must be an object");
  }
  const typed = value as LocalEvidenceSnapshot;
  const { canonicalHash, ...content } = typed;
  if (!["pi-local-evidence-snapshot.v1", "pi-local-evidence-snapshot.v2"].includes(typed.schemaVersion)
    || typed.executionScope !== LOCAL_DEVELOPER_EXECUTION_SCOPE
    || typed.profile !== "sequence_structure"
    || typed.portability !== "nonportable_developer_override"
    || !SHA256.test(canonicalHash)
    || canonicalHash !== hashCanonical(content)
    || !Array.isArray(typed.tools)
    || !Array.isArray(typed.optionalTools)
    || !Array.isArray(typed.databases)) {
    throw new Error("local evidence snapshot is invalid or non-canonical");
  }
  const runtime = typed.runtimeContract;
  if (!runtime || typeof runtime !== "object"
    || runtime.sequenceSearchBackend !== "local"
    || runtime.structureSearchBackend !== "local"
    || typeof runtime.pdbEnabled !== "boolean"
    || typeof runtime.merizoEnabled !== "boolean"
    || typeof runtime.chainsawEnabled !== "boolean") {
    throw new Error("local evidence snapshot runtime contract is invalid");
  }
  if (typed.schemaVersion === "pi-local-evidence-snapshot.v2"
    && (!typed.resourceProfile
      || typeof typed.resourceProfile.profileId !== "string"
      || !SHA256.test(typed.resourceProfile.canonicalHash))) {
    throw new Error("local evidence snapshot resource profile binding is invalid");
  }
  const databaseContracts = new Map<
    LocalSnapshotDatabase["label"],
    LocalSnapshotDatabase["prefixLabel"]
  >([
    ["blast_swissprot", "BLAST_DB"],
    ["foldseek_swissprot", "FOLDSEEK_SWISSPROT_DB"],
    ["foldseek_pdb", "FOLDSEEK_PDB_DB"],
  ]);
  if (typed.databases.some((item) => !item || typeof item !== "object")
    || typed.databases.length !== databaseContracts.size
    || new Set(typed.databases.map((item) => item.label)).size
      !== databaseContracts.size
    || typed.databases.some((item) => !databaseContracts.has(item.label))) {
    throw new Error("local evidence snapshot database set is invalid");
  }
  for (const database of typed.databases) {
    const { sourceHash, ...sourceContent } = database;
    if (database.prefixLabel !== databaseContracts.get(database.label)
      || database.fingerprintKind
        !== "full_file_sha256_with_safe_relative_symlinks_v1"
      || typeof database.configured !== "boolean"
      || !Array.isArray(database.files)
      || database.fileCount !== database.files.length
      || new Set(database.files.map((file) => file.name)).size
        !== database.files.length
      || database.totalBytes !== database.files.reduce((sum, file) => sum + file.sizeBytes, 0)
      || !SHA256.test(database.sourceHash)
      || sourceHash !== hashCanonical(sourceContent)
      || (database.configured
        ? database.files.length === 0 || database.totalBytes <= 0
        : database.files.length !== 0
          || database.fileCount !== 0
          || database.totalBytes !== 0)) {
      throw new Error("local evidence snapshot database accounting is invalid");
    }
    for (const file of database.files) {
      if (!file.name || file.name.includes("/") || file.name.includes("\\")
        || !["file", "symlink"].includes(file.kind)
        || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || !SHA256.test(file.sha256)
        || (file.kind === "symlink" && (!file.linkTarget || isAbsolute(file.linkTarget)
          || file.linkTarget.split(/[\\/]/).includes("..")))
        || (file.kind === "file" && file.linkTarget !== undefined)) {
        throw new Error("local evidence snapshot database file is invalid");
      }
    }
  }
  const databasesByLabel = new Map(
    typed.databases.map((item) => [item.label, item]),
  );
  if (!databasesByLabel.get("blast_swissprot")!.configured
    || (!databasesByLabel.get("foldseek_swissprot")!.configured
      && !databasesByLabel.get("foldseek_pdb")!.configured)
    || runtime.pdbEnabled
      !== databasesByLabel.get("foldseek_pdb")!.configured) {
    throw new Error(
      "local evidence snapshot runtime/database configuration is inconsistent",
    );
  }

  const optionalLabels = ["merizo", "chainsaw"] as const;
  if (typed.optionalTools.some((item) => !item || typeof item !== "object")
    || typed.optionalTools.length !== optionalLabels.length
    || new Set(typed.optionalTools.map((item) => item.label)).size
      !== optionalLabels.length
    || typed.optionalTools.some(
      (item) => !optionalLabels.includes(item.label),
    )) {
    throw new Error("local evidence snapshot optional-tool set is invalid");
  }
  for (const optional of typed.optionalTools) {
    const { sourceHash, ...sourceContent } = optional;
    const expectedArtifacts = OPTIONAL_ARTIFACTS[optional.label];
    if (optional.fingerprintKind
        !== "full_required_artifact_sha256_v1"
      || typeof optional.configured !== "boolean"
      || !Array.isArray(optional.artifacts)
      || !SHA256.test(sourceHash)
      || sourceHash !== hashCanonical(sourceContent)
      || (optional.configured
        ? optional.artifacts.length !== expectedArtifacts.length
          || new Set(optional.artifacts.map((item) => item.relativePath)).size
            !== expectedArtifacts.length
          || expectedArtifacts.some(
            (path) => !optional.artifacts.some(
              (artifact) => artifact.relativePath === path,
            ),
          )
        : optional.artifacts.length !== 0)
      || optional.artifacts.some((artifact) => artifact.relativePath.split(/[\\/]/).includes("..")
        || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0 || !SHA256.test(artifact.sha256))) {
      throw new Error("local evidence snapshot optional-tool binding is invalid");
    }
  }
  const optionalByLabel = new Map(
    typed.optionalTools.map((item) => [item.label, item]),
  );
  if (runtime.merizoEnabled !== optionalByLabel.get("merizo")!.configured
    || runtime.chainsawEnabled
      !== optionalByLabel.get("chainsaw")!.configured) {
    throw new Error(
      "local evidence snapshot runtime/optional-tool configuration is inconsistent",
    );
  }

  const expectedToolLabels = new Set<LocalSnapshotTool["label"]>([
    "python",
    "blastp",
    "blastdbcmd",
    "foldseek",
    ...(runtime.merizoEnabled ? ["merizo_python" as const] : []),
    ...(runtime.chainsawEnabled ? ["chainsaw_python" as const] : []),
  ]);
  if (typed.tools.some((item) => !item || typeof item !== "object")
    || typed.tools.length !== expectedToolLabels.size
    || new Set(typed.tools.map((item) => item.label)).size
      !== expectedToolLabels.size
    || typed.tools.some((item) => !expectedToolLabels.has(item.label))) {
    throw new Error("local evidence snapshot tool set is invalid");
  }
  for (const tool of typed.tools) {
    if (!["file", "symlink"].includes(tool.configuredPathKind)
      || !SHA256.test(tool.sha256)
      || !Number.isSafeInteger(tool.sizeBytes) || tool.sizeBytes <= 0
      || !tool.version || isAbsolute(tool.version)) {
      throw new Error("local evidence snapshot tool binding is invalid");
    }
  }
  if (!SHA256.test(typed.configBinding.sha256) || !SHA256.test(typed.ontology.sha256)
    || !Number.isSafeInteger(typed.ontology.sizeBytes) || typed.ontology.sizeBytes <= 0
    || !Number.isSafeInteger(typed.runtimeContract.topK) || typed.runtimeContract.topK <= 0
    || !Number.isSafeInteger(typed.runtimeContract.annotationLimit) || typed.runtimeContract.annotationLimit <= 0
    || (typed.schemaVersion === "pi-local-evidence-snapshot.v2"
      && (!Number.isSafeInteger(typed.runtimeContract.sequenceTopK)
        || typed.runtimeContract.sequenceTopK! <= 0
        || !Number.isSafeInteger(typed.runtimeContract.structureFullTopK)
        || typed.runtimeContract.structureFullTopK! <= 0
        || !Number.isSafeInteger(typed.runtimeContract.structureDomainTopK)
        || typed.runtimeContract.structureDomainTopK! <= 0))) {
    throw new Error("local evidence snapshot runtime/ontology binding is invalid");
  }
  assertRedacted(content);
  return typed;
}

async function readOrdinaryJson(path: string, label: string): Promise<Record<string, unknown>> {
  const pathStat = await lstat(path).catch(() => null);
  if (!pathStat?.isFile() || pathStat.isSymbolicLink()) throw new Error(`${label} must be an ordinary file`);
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

async function recursiveFileInventory(root: string, runRoot: string): Promise<{
  file_count: number;
  files: Array<{ path: string; size: number; sha256: string }>;
  canonical_sha256: string;
}> {
  // Python's `sorted()` compares Unicode code points. Do not use
  // `localeCompare()` here: collation rules can place `_` before `.`, which
  // changes the canonical raw-artifact hash produced by evidence_pipeline.py.
  const compareCodePoints = (left: string, right: string): number => {
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < left.length && rightIndex < right.length) {
      const leftCodePoint = left.codePointAt(leftIndex)!;
      const rightCodePoint = right.codePointAt(rightIndex)!;
      if (leftCodePoint !== rightCodePoint) return leftCodePoint < rightCodePoint ? -1 : 1;
      leftIndex += leftCodePoint > 0xffff ? 2 : 1;
      rightIndex += rightCodePoint > 0xffff ? 2 : 1;
    }
    if (leftIndex === left.length && rightIndex === right.length) return 0;
    return leftIndex === left.length ? -1 : 1;
  };
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  const rootReal = await realpath(root);
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCodePoints(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        const resolvedTarget = !isAbsolute(target) ? await realpath(path).catch(() => null) : null;
        if (!resolvedTarget || !inside(rootReal, resolvedTarget)) {
          throw new Error("local raw artifact tree contains an unsafe symlink");
        }
        const targetStat = await stat(resolvedTarget);
        // Foldseek creates a safe in-tree `latest` directory symlink. Python's
        // source inventory ignores it (`Path.is_file()` is false) and does not
        // recurse through it, so validate and skip it here too.
        if (targetStat.isDirectory()) continue;
        if (!targetStat.isFile()) throw new Error("local raw artifact symlink resolves to a special file");
        const hashed = await hashStableOrdinaryFile(resolvedTarget, "local raw symlink artifact");
        files.push({
          path: relative(runRoot, path).split(sep).join("/"),
          size: hashed.sizeBytes,
          sha256: hashed.sha256,
        });
      } else if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const hashed = await hashStableOrdinaryFile(path, "local raw artifact");
        files.push({
          path: relative(runRoot, path).split(sep).join("/"),
          size: hashed.sizeBytes,
          sha256: hashed.sha256,
        });
      } else throw new Error("local raw artifact tree contains a special file");
    }
  };
  await visit(root);
  files.sort((left, right) => compareCodePoints(left.path, right.path));
  return { file_count: files.length, files, canonical_sha256: hashCanonical(files) };
}

function databaseWeakInventoryMatches(
  observed: unknown,
  snapshot: LocalSnapshotDatabase,
): boolean {
  const value = record(observed, `${snapshot.label} runtime inventory`);
  const files = Array.isArray(value.files) ? value.files : [];
  const expected = snapshot.files.map((file) => ({ name: file.name, size: file.sizeBytes }));
  const actual = files.map((item) => {
    const file = record(item, `${snapshot.label} runtime inventory file`);
    return { name: file.name, size: file.size };
  });
  return value.file_count === expected.length && hashCanonical(actual) === hashCanonical(expected);
}

function optionalRuntimeMatches(observed: unknown, expected: LocalSnapshotOptionalTool): boolean {
  const value = record(observed, `${expected.label} runtime identity`);
  if (value.configured !== expected.configured) return false;
  const artifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
  return hashCanonical(artifacts.map((item) => {
    const artifact = record(item, `${expected.label} runtime artifact`);
    return { relativePath: artifact.relative_path, sizeBytes: artifact.size, sha256: artifact.sha256 };
  })) === hashCanonical(expected.artifacts);
}

function assertCommandBinding(command: unknown, executable: string, database: string, label: string): void {
  if (!Array.isArray(command) || command.some((item) => typeof item !== "string")
    || command[0] !== executable || !command.includes(database)) {
    throw new Error(`${label} command is not bound to the configured local executable/database`);
  }
}

/**
 * Validate the local-only runtime surfaces after the batch finishes. The
 * snapshot itself is rebuilt separately; this check prevents a run from being
 * relabelled local while its manifests/raw artifacts show a different backend.
 */
export async function validateLocalBatchAgainstSnapshot(input: {
  snapshot: LocalEvidenceSnapshot;
  configPath: string;
  batchDir: string;
  batchManifest: BatchManifest;
}): Promise<Array<{ caseId: string; localProviderCount: number }>> {
  const snapshot = assertLocalEvidenceSnapshot(input.snapshot);
  const config = parseEnvFile(input.configPath);
  const blastp = required(config, "BLASTP_BIN");
  const blastDb = required(config, "BLAST_DB");
  const foldseek = required(config, "FOLDSEEK_BIN");
  const foldseekSwissprot = config.FOLDSEEK_SWISSPROT_DB?.trim()
    ? configPath(config.FOLDSEEK_SWISSPROT_DB)
    : null;
  const foldseekPdb = config.FOLDSEEK_PDB_DB?.trim() ? configPath(config.FOLDSEEK_PDB_DB) : null;
  const databaseByLabel = new Map(snapshot.databases.map((item) => [item.label, item]));
  const toolByLabel = new Map(snapshot.tools.map((item) => [item.label, item]));
  const optionalByLabel = new Map(snapshot.optionalTools.map((item) => [item.label, item]));
  const cases: Array<{ caseId: string; localProviderCount: number }> = [];
  for (const item of input.batchManifest.cases) {
    if (item.status !== "completed" || !item.validationOk) throw new Error(`local snapshot cannot attest incomplete case ${item.caseId}`);
    const runRoot = resolve(input.batchDir, item.runDir);
    if (!inside(resolve(input.batchDir), runRoot)) throw new Error("batch run path escapes its batch root");
    const runRootStat = await lstat(runRoot).catch(() => null);
    if (!runRootStat?.isDirectory() || runRootStat.isSymbolicLink()) throw new Error(`${item.caseId} run root is unsafe`);
    const run = await readOrdinaryJson(join(runRoot, "run_manifest.json"), `${item.caseId} run manifest`);
    const evidence = await readOrdinaryJson(join(runRoot, "evidence_manifest.json"), `${item.caseId} evidence manifest`);
    const bundle = await readOrdinaryJson(join(runRoot, "evidence", "evidence_bundle.json"), `${item.caseId} evidence bundle`);
    const acquisition = record(run.evidenceAcquisition, `${item.caseId} acquisition binding`);
    if (run.status !== "completed" || acquisition.planHash !== input.batchManifest.evidenceAcquisitionPlanHash
      || acquisition.epochId !== input.batchManifest.evidenceAcquisitionEpochId || evidence.status !== "completed") {
      throw new Error(`${item.caseId} is not bound to the local acquisition epoch`);
    }
    const inputs = record(run.inputs, `${item.caseId} run inputs`);
    const runtime = record(bundle.runtime, `${item.caseId} evidence runtime`);
    const backends = record(runtime.search_backends, `${item.caseId} search backends`);
    if (backends.sequence !== "local"
      || (inputs.structure === null ? backends.structure !== null : backends.structure !== "local")) {
      throw new Error(`${item.caseId} did not use the required local search backends`);
    }
    if (runtime.blast_database !== blastDb
      || runtime.foldseek_swissprot_database !== (inputs.structure === null ? null : foldseekSwissprot)
      || runtime.foldseek_pdb_database !== (inputs.structure === null || !foldseekPdb ? null : foldseekPdb)) {
      throw new Error(`${item.caseId} runtime database identity differs from the snapshotted config`);
    }
    const toolVersions = record(runtime.tool_versions, `${item.caseId} tool versions`);
    const pythonVersion = toolByLabel.get("python")?.version.replace(/^Python\s+/i, "");
    if (toolVersions.python !== pythonVersion
      || toolVersions.blastp !== toolByLabel.get("blastp")?.version
      || (inputs.structure !== null && toolVersions.foldseek !== toolByLabel.get("foldseek")?.version)) {
      throw new Error(`${item.caseId} runtime tool versions differ from the local snapshot`);
    }
    const inventories = record(runtime.database_inventories, `${item.caseId} database inventories`);
    const blastSnapshot = databaseByLabel.get("blast_swissprot")!;
    const swissprotSnapshot = databaseByLabel.get("foldseek_swissprot")!;
    const pdbSnapshot = databaseByLabel.get("foldseek_pdb")!;
    if (!databaseWeakInventoryMatches(inventories.blast_swissprot, blastSnapshot)
      || (inputs.structure !== null && swissprotSnapshot.configured
        && !databaseWeakInventoryMatches(inventories.foldseek_swissprot, swissprotSnapshot))
      || (inputs.structure !== null && pdbSnapshot.configured && !databaseWeakInventoryMatches(inventories.foldseek_pdb, pdbSnapshot))) {
      throw new Error(`${item.caseId} runtime database inventory differs from the local snapshot`);
    }
    const optionalIdentities = record(runtime.optional_tool_identities, `${item.caseId} optional tool identities`);
    for (const label of ["merizo", "chainsaw"] as const) {
      if (!optionalRuntimeMatches(optionalIdentities[label], optionalByLabel.get(label)!)) {
        throw new Error(`${item.caseId} ${label} identity differs from the local snapshot`);
      }
    }
    const stages = record(evidence.stages, `${item.caseId} evidence stages`);
    const sequence = record(stages.sequence_search, `${item.caseId} sequence search`);
    if (sequence.status !== "completed") throw new Error(`${item.caseId} local BLAST did not complete`);
    assertCommandBinding(sequence.command, blastp, blastDb, `${item.caseId} BLAST`);
    let providerCount = 1;
    if (inputs.structure !== null) {
      const structure = record(stages.structure_search, `${item.caseId} structure search`);
      const searches = record(structure.searches, `${item.caseId} structure searches`);
      if (structure.status !== "completed") {
        throw new Error(`${item.caseId} local Foldseek did not complete`);
      }
      if (foldseekSwissprot) {
        const swissprot = record(searches.swissprot_full_length, `${item.caseId} Swiss-Prot Foldseek search`);
        if (swissprot.status !== "completed") {
          throw new Error(`${item.caseId} local Swiss-Prot Foldseek did not complete`);
        }
        assertCommandBinding(swissprot.command, foldseek, foldseekSwissprot, `${item.caseId} Swiss-Prot Foldseek`);
        providerCount += 1;
      }
      if (foldseekPdb) {
        const pdb = record(searches.pdb_full_length, `${item.caseId} PDB Foldseek search`);
        if (pdb.status !== "completed") throw new Error(`${item.caseId} local PDB Foldseek did not complete`);
        assertCommandBinding(pdb.command, foldseek, foldseekPdb, `${item.caseId} PDB Foldseek`);
        providerCount += 1;
      }
    }
    const rawRoot = join(runRoot, "raw");
    const rawStat = await lstat(rawRoot).catch(() => null);
    if (!rawStat?.isDirectory() || rawStat.isSymbolicLink()) throw new Error(`${item.caseId} raw output root is unsafe`);
    const actualRaw = await recursiveFileInventory(rawRoot, runRoot);
    if (hashCanonical(actualRaw) !== hashCanonical(runtime.raw_artifact_inventory)) {
      throw new Error(`${item.caseId} raw artifact inventory is missing, stale, or tampered`);
    }
    const requiredRaw = [
      "raw/sequence/blast_swissprot.tsv",
      ...(inputs.structure === null || !foldseekSwissprot ? [] : ["raw/foldseek/swissprot/full_length/results.tsv"]),
      ...(inputs.structure === null || !foldseekPdb ? [] : ["raw/foldseek/pdb/full_length/results.tsv"]),
    ];
    const actualPaths = new Set(actualRaw.files.map((file) => file.path));
    if (requiredRaw.some((path) => !actualPaths.has(path))) throw new Error(`${item.caseId} is missing a required local raw search output`);
    cases.push({ caseId: item.caseId, localProviderCount: providerCount });
  }
  return cases;
}
