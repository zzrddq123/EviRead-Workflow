import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import { PROJECT_ROOT } from "../../config.js";
import { canonicalJson, hashCanonical } from "../../hash.js";

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const SPEC_PATH = "archive_spec.json";
const SEAL_PATH = "archive_seal.json";
const PUBLIC_MANIFEST_PATH = "public/public_manifest.json";
const PUBLIC_ARTIFACTS_PATH = "public/artifacts";
const PRIVATE_MANIFEST_PATH = "private/private_manifest.json";
const PRIVATE_ARTIFACTS_PATH = "private/artifacts";

export const RSI_RETROSPECTIVE_ARCHIVE_SPEC_SCHEMA =
  "pi-rsi-retrospective-archive-spec.v1" as const;
export const RSI_RETROSPECTIVE_ARCHIVE_PUBLIC_MANIFEST_SCHEMA =
  "pi-rsi-retrospective-archive-public-manifest.v1" as const;
export const RSI_RETROSPECTIVE_ARCHIVE_PRIVATE_MANIFEST_SCHEMA =
  "pi-rsi-retrospective-archive-private-manifest.v1" as const;
export const RSI_RETROSPECTIVE_ARCHIVE_SEAL_SCHEMA =
  "pi-rsi-retrospective-archive-seal.v1" as const;

export type RsiRetrospectiveArchiveVisibility = "public" | "private";

export interface RsiRetrospectiveArchiveArtifactSpec {
  artifactId: string;
  visibility: RsiRetrospectiveArchiveVisibility;
  sourceRelativePath: string;
}

export interface RsiRetrospectiveArchiveSpec
  extends Record<string, unknown> {
  schemaVersion: typeof RSI_RETROSPECTIVE_ARCHIVE_SPEC_SCHEMA;
  artifacts: RsiRetrospectiveArchiveArtifactSpec[];
  canonicalHash: string;
}

export interface RsiRetrospectiveArchiveFile {
  relativePath: string;
  sha256: string;
  size: number;
}

export interface RsiRetrospectiveArchiveArtifact {
  artifactId: string;
  sourceRelativePath: string;
  sourceKind: "file" | "directory";
  directories: string[];
  files: RsiRetrospectiveArchiveFile[];
}

export interface RsiRetrospectiveArchivePublicManifest
  extends Record<string, unknown> {
  schemaVersion:
    typeof RSI_RETROSPECTIVE_ARCHIVE_PUBLIC_MANIFEST_SCHEMA;
  archiveKind: "rsi_retrospective_public_artifacts";
  specHash: string;
  artifacts: RsiRetrospectiveArchiveArtifact[];
  canonicalHash: string;
}

export interface RsiRetrospectiveArchivePrivateManifest
  extends Record<string, unknown> {
  schemaVersion:
    typeof RSI_RETROSPECTIVE_ARCHIVE_PRIVATE_MANIFEST_SCHEMA;
  archiveKind: "rsi_retrospective_private_artifacts";
  specHash: string;
  publicManifestHash: string;
  artifacts: RsiRetrospectiveArchiveArtifact[];
  canonicalHash: string;
}

interface RsiRetrospectiveArchiveSealBinding {
  path: string;
  fileSha256: string;
  canonicalHash: string;
}

export interface RsiRetrospectiveArchiveSeal
  extends Record<string, unknown> {
  schemaVersion: typeof RSI_RETROSPECTIVE_ARCHIVE_SEAL_SCHEMA;
  spec: RsiRetrospectiveArchiveSealBinding & {
    path: typeof SPEC_PATH;
  };
  publicManifest: RsiRetrospectiveArchiveSealBinding & {
    path: typeof PUBLIC_MANIFEST_PATH;
  };
  privateManifest: (
    RsiRetrospectiveArchiveSealBinding & {
      path: typeof PRIVATE_MANIFEST_PATH;
    }
  ) | null;
  canonicalHash: string;
}

export interface CreateRsiRetrospectiveArchiveInput {
  sourceRoot: string;
  outputDir: string;
  spec: RsiRetrospectiveArchiveSpec;
}

export interface RsiRetrospectiveArchiveResult {
  archiveDir: string;
  specHash: string;
  sealHash: string;
  publicManifestHash: string;
  privateManifestHash: string | null;
  publicArtifactCount: number;
  privateArtifactCount: number;
  publicFileCount: number;
  privateFileCount: number;
}

export interface RsiRetrospectiveArchiveDependencies {
  /**
   * Test/embedding hook invoked after the first source inventory. The second
   * inventory still must match, so callers cannot use this to authorize a
   * mutable source.
   */
  afterSourceInventory?: (input: {
    sourceRoot: string;
    artifacts: readonly RsiRetrospectiveArchiveArtifactSpec[];
  }) => Promise<void>;
}

interface LocatedFile {
  absolutePath: string;
  relativePath: string;
}

interface TreeListing {
  directories: string[];
  files: LocatedFile[];
}

interface ResolvedSourceArtifact {
  spec: RsiRetrospectiveArchiveArtifactSpec;
  absolutePath: string;
  sourceKind: "file" | "directory";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function permissionBits(mode: number): number {
  return mode & 0o777;
}

function isInsideOrEqual(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === ""
    || (path !== ".." && !path.startsWith(`..${sep}`));
}

function asRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function canonicalDocument<T extends Record<string, unknown>>(
  value: T,
  label: string,
): T {
  const { canonicalHash, ...content } = value;
  if (typeof canonicalHash !== "string"
    || !HASH.test(canonicalHash)
    || canonicalHash !== hashCanonical(content)) {
    throw new Error(`${label} canonical hash is invalid`);
  }
  return value;
}

function withCanonicalHash<T extends Record<string, unknown>>(
  value: T,
): T & { canonicalHash: string } {
  return {
    ...value,
    canonicalHash: hashCanonical(value),
  };
}

function assertSafeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} must be a safe artifact ID`);
  }
  return value;
}

function assertSafeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 4096
    || isAbsolute(value)
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a safe relative path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) =>
    segment.length === 0 || segment === "." || segment === "..")
    || segments.join("/") !== value) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return value;
}

function safeRelativePath(
  segments: readonly string[],
  label: string,
): string {
  if (segments.length === 0
    || segments.some((segment) =>
      segment.length === 0
      || segment === "."
      || segment === ".."
      || segment.includes("/")
      || segment.includes("\\")
      || /[\u0000-\u001f\u007f]/u.test(segment))) {
    throw new Error(`${label} contains an unsafe path`);
  }
  return segments.join("/");
}

function assertHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new Error(`${label} must be a SHA-256 hash`);
  }
  return value;
}

function assertSafeSize(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

async function assertSchema(
  filename: string,
  value: unknown,
  label: string,
): Promise<void> {
  const schema = JSON.parse(
    await readFile(join(PROJECT_ROOT, "schemas", filename), "utf8"),
  ) as TSchema;
  if (!Value.Check(schema, value)) {
    throw new Error(`${label} does not satisfy ${filename}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalDirectory(
  path: string,
  label: string,
): Promise<string> {
  const resolved = resolve(path);
  const entry = await lstat(resolved);
  if (entry.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
  return await realpath(resolved);
}

async function readStableFile(
  path: string,
  label: string,
  containmentRoot?: string,
): Promise<Buffer> {
  const pathBefore = await lstat(path);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (containmentRoot) {
    const canonical = await realpath(path);
    if (!isInsideOrEqual(canonical, containmentRoot)) {
      throw new Error(`${label} escapes its declared root`);
    }
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()
      || before.dev !== pathBefore.dev
      || before.ino !== pathBefore.ino
      || !Number.isSafeInteger(before.size)
      || before.size < 0) {
      throw new Error(`${label} changed before it could be read`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (!pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || before.dev !== pathAfter.dev
      || before.ino !== pathAfter.ino
      || before.size !== pathAfter.size
      || bytes.length !== after.size) {
      throw new Error(`${label} changed while it was being read`);
    }
    if (containmentRoot) {
      const canonical = await realpath(path);
      if (!isInsideOrEqual(canonical, containmentRoot)) {
        throw new Error(`${label} escaped its declared root while read`);
      }
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function listTree(root: string, label: string): Promise<TreeListing> {
  const directories: string[] = [];
  const files: LocatedFile[] = [];
  const canonicalRoot = await canonicalDirectory(root, label);

  async function visit(
    directory: string,
    segments: string[],
  ): Promise<void> {
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error(`${label} contains a non-directory path component`);
    }
    const canonical = await realpath(directory);
    if (!isInsideOrEqual(canonical, canonicalRoot)) {
      throw new Error(`${label} contains a path that escapes its root`);
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const nextSegments = [...segments, entry.name];
      const relativePath = safeRelativePath(nextSegments, label);
      const absolutePath = join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`${label} rejects symlink: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        directories.push(relativePath);
        await visit(absolutePath, nextSegments);
      } else if (metadata.isFile()) {
        files.push({ absolutePath, relativePath });
      } else {
        throw new Error(
          `${label} rejects non-regular entry: ${relativePath}`,
        );
      }
    }
    const after = await lstat(directory);
    if (!after.isDirectory()
      || after.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`${label} changed while it was inventoried`);
    }
  }

  await visit(canonicalRoot, []);
  return {
    directories: directories.sort(compareText),
    files: files.sort((left, right) =>
      compareText(left.relativePath, right.relativePath)),
  };
}

async function resolveSourceArtifact(
  sourceRoot: string,
  spec: RsiRetrospectiveArchiveArtifactSpec,
): Promise<ResolvedSourceArtifact> {
  const relativePath = assertSafeRelativePath(
    spec.sourceRelativePath,
    `artifact ${spec.artifactId} sourceRelativePath`,
  );
  let current = sourceRoot;
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `artifact ${spec.artifactId} source path must not contain a symlink`,
      );
    }
  }
  const entry = await lstat(current);
  if (!entry.isFile() && !entry.isDirectory()) {
    throw new Error(
      `artifact ${spec.artifactId} source must be a regular file or directory`,
    );
  }
  const canonical = await realpath(current);
  if (!isInsideOrEqual(canonical, sourceRoot)) {
    throw new Error(`artifact ${spec.artifactId} source escapes sourceRoot`);
  }
  return {
    spec,
    absolutePath: canonical,
    sourceKind: entry.isFile() ? "file" : "directory",
  };
}

async function snapshotSourceArtifact(
  sourceRoot: string,
  resolvedArtifact: ResolvedSourceArtifact,
): Promise<RsiRetrospectiveArchiveArtifact> {
  const current = await resolveSourceArtifact(
    sourceRoot,
    resolvedArtifact.spec,
  );
  if (current.absolutePath !== resolvedArtifact.absolutePath
    || current.sourceKind !== resolvedArtifact.sourceKind) {
    throw new Error(
      `artifact ${resolvedArtifact.spec.artifactId} source changed while archived`,
    );
  }
  if (current.sourceKind === "file") {
    const bytes = await readStableFile(
      current.absolutePath,
      `artifact ${current.spec.artifactId}`,
      sourceRoot,
    );
    return {
      artifactId: current.spec.artifactId,
      sourceRelativePath: current.spec.sourceRelativePath,
      sourceKind: "file",
      directories: [],
      files: [{
        relativePath: basename(current.spec.sourceRelativePath),
        sha256: sha256(bytes),
        size: bytes.length,
      }],
    };
  }

  const listing = await listTree(
    current.absolutePath,
    `artifact ${current.spec.artifactId}`,
  );
  const files: RsiRetrospectiveArchiveFile[] = [];
  for (const file of listing.files) {
    const bytes = await readStableFile(
      file.absolutePath,
      `artifact ${current.spec.artifactId}/${file.relativePath}`,
      current.absolutePath,
    );
    files.push({
      relativePath: file.relativePath,
      sha256: sha256(bytes),
      size: bytes.length,
    });
  }
  return {
    artifactId: current.spec.artifactId,
    sourceRelativePath: current.spec.sourceRelativePath,
    sourceKind: "directory",
    directories: listing.directories,
    files,
  };
}

async function makeDirectory(
  path: string,
  privateMode: boolean,
): Promise<void> {
  await mkdir(path, {
    recursive: true,
    mode: privateMode ? 0o700 : 0o755,
  });
  if (privateMode) await chmod(path, 0o700);
}

async function writeBytes(
  path: string,
  bytes: Uint8Array,
  privateMode: boolean,
): Promise<void> {
  await makeDirectory(dirname(path), privateMode);
  await writeFile(path, bytes, {
    flag: "wx",
    mode: privateMode ? 0o600 : 0o644,
  });
  await chmod(path, privateMode ? 0o600 : 0o644);
}

async function copySourceArtifact(
  sourceRoot: string,
  resolvedArtifact: ResolvedSourceArtifact,
  destinationRoot: string,
  privateMode: boolean,
): Promise<RsiRetrospectiveArchiveArtifact> {
  const current = await resolveSourceArtifact(
    sourceRoot,
    resolvedArtifact.spec,
  );
  if (current.absolutePath !== resolvedArtifact.absolutePath
    || current.sourceKind !== resolvedArtifact.sourceKind) {
    throw new Error(
      `artifact ${resolvedArtifact.spec.artifactId} source changed while archived`,
    );
  }
  const artifactRoot = join(destinationRoot, current.spec.artifactId);
  await makeDirectory(artifactRoot, privateMode);

  if (current.sourceKind === "file") {
    const relativePath = basename(current.spec.sourceRelativePath);
    const bytes = await readStableFile(
      current.absolutePath,
      `artifact ${current.spec.artifactId}`,
      sourceRoot,
    );
    await writeBytes(
      join(artifactRoot, relativePath),
      bytes,
      privateMode,
    );
    return {
      artifactId: current.spec.artifactId,
      sourceRelativePath: current.spec.sourceRelativePath,
      sourceKind: "file",
      directories: [],
      files: [{
        relativePath,
        sha256: sha256(bytes),
        size: bytes.length,
      }],
    };
  }

  const listing = await listTree(
    current.absolutePath,
    `artifact ${current.spec.artifactId}`,
  );
  for (const directory of listing.directories) {
    await makeDirectory(
      join(artifactRoot, ...directory.split("/")),
      privateMode,
    );
  }
  const files: RsiRetrospectiveArchiveFile[] = [];
  for (const file of listing.files) {
    const bytes = await readStableFile(
      file.absolutePath,
      `artifact ${current.spec.artifactId}/${file.relativePath}`,
      current.absolutePath,
    );
    await writeBytes(
      join(artifactRoot, ...file.relativePath.split("/")),
      bytes,
      privateMode,
    );
    files.push({
      relativePath: file.relativePath,
      sha256: sha256(bytes),
      size: bytes.length,
    });
  }
  return {
    artifactId: current.spec.artifactId,
    sourceRelativePath: current.spec.sourceRelativePath,
    sourceKind: "directory",
    directories: listing.directories,
    files,
  };
}

async function readJson(path: string, label: string): Promise<unknown> {
  const bytes = await readStableFile(path, label);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function writeJson(
  path: string,
  value: unknown,
  privateMode: boolean,
): Promise<Buffer> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeBytes(path, bytes, privateMode);
  return bytes;
}

async function readCanonicalManifest<
  T extends Record<string, unknown>,
>(
  path: string,
  label: string,
  schemaFilename: string,
): Promise<T> {
  const value = canonicalDocument(
    asRecord(await readJson(path, label), label),
    label,
  );
  await assertSchema(schemaFilename, value, label);
  return value as T;
}

function assertUniqueSortedPaths(
  paths: readonly string[],
  label: string,
): void {
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const rawPath of paths) {
    const path = assertSafeRelativePath(rawPath, label);
    if (seen.has(path)) throw new Error(`${label} contains a duplicate path`);
    if (previous !== undefined && compareText(previous, path) >= 0) {
      throw new Error(`${label} paths must be ASCII-sorted`);
    }
    seen.add(path);
    previous = path;
  }
}

function assertArtifactShape(
  artifact: RsiRetrospectiveArchiveArtifact,
  label: string,
): void {
  assertSafeId(artifact.artifactId, `${label}.artifactId`);
  assertSafeRelativePath(
    artifact.sourceRelativePath,
    `${label}.sourceRelativePath`,
  );
  if (artifact.sourceKind !== "file"
    && artifact.sourceKind !== "directory") {
    throw new Error(`${label}.sourceKind is invalid`);
  }
  assertUniqueSortedPaths(artifact.directories, `${label}.directories`);
  const filePaths = artifact.files.map((file) => {
    assertHash(file.sha256, `${label} file sha256`);
    assertSafeSize(file.size, `${label} file size`);
    return assertSafeRelativePath(
      file.relativePath,
      `${label} file relativePath`,
    );
  });
  assertUniqueSortedPaths(filePaths, `${label}.files`);
  if (artifact.sourceKind === "file") {
    if (artifact.directories.length !== 0
      || artifact.files.length !== 1
      || artifact.files[0]!.relativePath
        !== basename(artifact.sourceRelativePath)) {
      throw new Error(`${label} has an invalid file artifact shape`);
    }
  }
  const directorySet = new Set(artifact.directories);
  for (const filePath of filePaths) {
    if (directorySet.has(filePath)) {
      throw new Error(`${label} uses one path as both file and directory`);
    }
    const segments = filePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (!directorySet.has(segments.slice(0, index).join("/"))) {
        throw new Error(`${label} omits a parent directory`);
      }
    }
  }
  for (const directory of artifact.directories) {
    const segments = directory.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (!directorySet.has(segments.slice(0, index).join("/"))) {
        throw new Error(`${label} omits a parent directory`);
      }
    }
  }
}

async function validateSpec(
  rawSpec: RsiRetrospectiveArchiveSpec,
): Promise<RsiRetrospectiveArchiveSpec> {
  await assertSchema(
    "rsi_retrospective_archive_spec.schema.json",
    rawSpec,
    "retrospective archive spec",
  );
  canonicalDocument(rawSpec, "retrospective archive spec");
  const artifactIds = new Set<string>();
  const paths: string[] = [];
  for (const artifact of rawSpec.artifacts) {
    const artifactId = assertSafeId(
      artifact.artifactId,
      "retrospective archive artifactId",
    );
    if (artifactIds.has(artifactId)) {
      throw new Error(
        `retrospective archive spec has duplicate artifactId: ${artifactId}`,
      );
    }
    artifactIds.add(artifactId);
    const path = assertSafeRelativePath(
      artifact.sourceRelativePath,
      `artifact ${artifactId} sourceRelativePath`,
    );
    paths.push(path);
  }
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      const leftPath = paths[left]!;
      const rightPath = paths[right]!;
      if (leftPath === rightPath
        || leftPath.startsWith(`${rightPath}/`)
        || rightPath.startsWith(`${leftPath}/`)) {
        throw new Error(
          "retrospective archive source paths must not overlap",
        );
      }
    }
  }
  return JSON.parse(
    canonicalJson(rawSpec),
  ) as RsiRetrospectiveArchiveSpec;
}

function buildPublicManifest(
  specHash: string,
  artifacts: RsiRetrospectiveArchiveArtifact[],
): RsiRetrospectiveArchivePublicManifest {
  const value = {
    schemaVersion:
      RSI_RETROSPECTIVE_ARCHIVE_PUBLIC_MANIFEST_SCHEMA,
    archiveKind: "rsi_retrospective_public_artifacts" as const,
    specHash,
    artifacts: artifacts
      .map((artifact) => ({
        ...artifact,
        directories: [...artifact.directories],
        files: artifact.files.map((file) => ({ ...file })),
      }))
      .sort((left, right) =>
        compareText(left.artifactId, right.artifactId)),
  };
  return withCanonicalHash(
    value,
  ) as RsiRetrospectiveArchivePublicManifest;
}

function buildPrivateManifest(
  specHash: string,
  publicManifestHash: string,
  artifacts: RsiRetrospectiveArchiveArtifact[],
): RsiRetrospectiveArchivePrivateManifest {
  const value = {
    schemaVersion:
      RSI_RETROSPECTIVE_ARCHIVE_PRIVATE_MANIFEST_SCHEMA,
    archiveKind: "rsi_retrospective_private_artifacts" as const,
    specHash,
    publicManifestHash,
    artifacts: artifacts
      .map((artifact) => ({
        ...artifact,
        directories: [...artifact.directories],
        files: artifact.files.map((file) => ({ ...file })),
      }))
      .sort((left, right) =>
        compareText(left.artifactId, right.artifactId)),
  };
  return withCanonicalHash(
    value,
  ) as RsiRetrospectiveArchivePrivateManifest;
}

function buildSeal(input: {
  specBytes: Uint8Array;
  spec: RsiRetrospectiveArchiveSpec;
  publicManifestBytes: Uint8Array;
  publicManifest: RsiRetrospectiveArchivePublicManifest;
  privateManifestBytes?: Uint8Array;
  privateManifest?: RsiRetrospectiveArchivePrivateManifest;
}): RsiRetrospectiveArchiveSeal {
  const value = {
    schemaVersion: RSI_RETROSPECTIVE_ARCHIVE_SEAL_SCHEMA,
    spec: {
      path: SPEC_PATH,
      fileSha256: sha256(input.specBytes),
      canonicalHash: input.spec.canonicalHash,
    },
    publicManifest: {
      path: PUBLIC_MANIFEST_PATH,
      fileSha256: sha256(input.publicManifestBytes),
      canonicalHash: input.publicManifest.canonicalHash,
    },
    privateManifest: input.privateManifest && input.privateManifestBytes
      ? {
        path: PRIVATE_MANIFEST_PATH,
        fileSha256: sha256(input.privateManifestBytes),
        canonicalHash: input.privateManifest.canonicalHash,
      }
      : null,
  };
  return withCanonicalHash(value) as RsiRetrospectiveArchiveSeal;
}

function assertManifestMatchesSpec(
  manifestArtifacts: readonly RsiRetrospectiveArchiveArtifact[],
  spec: RsiRetrospectiveArchiveSpec,
  visibility: RsiRetrospectiveArchiveVisibility,
  label: string,
): void {
  const expected = spec.artifacts
    .filter((artifact) => artifact.visibility === visibility)
    .map((artifact) => ({
      artifactId: artifact.artifactId,
      sourceRelativePath: artifact.sourceRelativePath,
    }))
    .sort((left, right) => compareText(left.artifactId, right.artifactId));
  const actual = manifestArtifacts.map((artifact) => {
    assertArtifactShape(artifact, `${label} ${artifact.artifactId}`);
    return {
      artifactId: artifact.artifactId,
      sourceRelativePath: artifact.sourceRelativePath,
    };
  });
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} artifacts do not match the archive spec`);
  }
}

async function inventoryArchivedArtifact(
  artifactRoot: string,
  manifestArtifact: RsiRetrospectiveArchiveArtifact,
  label: string,
): Promise<RsiRetrospectiveArchiveArtifact> {
  const listing = await listTree(artifactRoot, label);
  const files: RsiRetrospectiveArchiveFile[] = [];
  for (const file of listing.files) {
    const bytes = await readStableFile(
      file.absolutePath,
      `${label}/${file.relativePath}`,
      artifactRoot,
    );
    files.push({
      relativePath: file.relativePath,
      sha256: sha256(bytes),
      size: bytes.length,
    });
  }
  return {
    artifactId: manifestArtifact.artifactId,
    sourceRelativePath: manifestArtifact.sourceRelativePath,
    sourceKind: manifestArtifact.sourceKind,
    directories: listing.directories,
    files,
  };
}

async function assertOwnerOnlyFile(
  path: string,
  label: string,
): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isFile()
    || entry.isSymbolicLink()
    || permissionBits(entry.mode) !== 0o600) {
    throw new Error(`${label} must be an owner-only 0600 regular file`);
  }
}

async function assertOwnerOnlyDirectoryTree(
  root: string,
  label: string,
): Promise<void> {
  const entry = await lstat(root);
  if (!entry.isDirectory()
    || entry.isSymbolicLink()
    || permissionBits(entry.mode) !== 0o700) {
    throw new Error(`${label} must be an owner-only 0700 directory`);
  }
  for (const child of await readdir(root, { withFileTypes: true })) {
    const path = join(root, child.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink`);
    }
    if (metadata.isDirectory()) {
      await assertOwnerOnlyDirectoryTree(path, label);
    } else if (metadata.isFile()) {
      await assertOwnerOnlyFile(path, label);
    } else {
      throw new Error(`${label} contains a non-regular entry`);
    }
  }
}

function artifactExpectedPaths(
  base: string,
  artifact: RsiRetrospectiveArchiveArtifact,
): { directories: string[]; files: string[] } {
  const artifactBase = `${base}/${artifact.artifactId}`;
  return {
    directories: [
      artifactBase,
      ...artifact.directories.map((path) => `${artifactBase}/${path}`),
    ],
    files: artifact.files.map(
      (file) => `${artifactBase}/${file.relativePath}`,
    ),
  };
}

function expectedArchivePaths(
  publicArtifacts: readonly RsiRetrospectiveArchiveArtifact[],
  privateArtifacts: readonly RsiRetrospectiveArchiveArtifact[],
): { directories: string[]; files: string[] } {
  const directories = ["public", PUBLIC_ARTIFACTS_PATH];
  const files = [SPEC_PATH, SEAL_PATH, PUBLIC_MANIFEST_PATH];
  for (const artifact of publicArtifacts) {
    const paths = artifactExpectedPaths(PUBLIC_ARTIFACTS_PATH, artifact);
    directories.push(...paths.directories);
    files.push(...paths.files);
  }
  if (privateArtifacts.length > 0) {
    directories.push("private", PRIVATE_ARTIFACTS_PATH);
    files.push(PRIVATE_MANIFEST_PATH);
    for (const artifact of privateArtifacts) {
      const paths = artifactExpectedPaths(
        PRIVATE_ARTIFACTS_PATH,
        artifact,
      );
      directories.push(...paths.directories);
      files.push(...paths.files);
    }
  }
  return {
    directories: directories.sort(compareText),
    files: files.sort(compareText),
  };
}

function assertSameDocument(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} does not match archived artifacts`);
  }
}

/**
 * Verifies only the sealed archive. No sourceRoot is accepted, which makes
 * verification meaningful after the producing worktree or source tree has
 * been removed.
 */
export async function verifyRsiRetrospectiveArchive(
  archiveDir: string,
): Promise<RsiRetrospectiveArchiveResult> {
  const archiveRoot = await canonicalDirectory(
    archiveDir,
    "retrospective archive",
  );
  if (permissionBits((await lstat(archiveRoot)).mode) !== 0o700) {
    throw new Error(
      "retrospective archive root must be an owner-only 0700 directory",
    );
  }
  await assertOwnerOnlyFile(
    join(archiveRoot, SPEC_PATH),
    "retrospective archive spec",
  );
  await assertOwnerOnlyFile(
    join(archiveRoot, SEAL_PATH),
    "retrospective archive seal",
  );

  const specPath = join(archiveRoot, SPEC_PATH);
  const specBytes = await readStableFile(
    specPath,
    "retrospective archive spec",
    archiveRoot,
  );
  const spec = await readCanonicalManifest<RsiRetrospectiveArchiveSpec>(
    specPath,
    "retrospective archive spec",
    "rsi_retrospective_archive_spec.schema.json",
  );
  await validateSpec(spec);

  const publicManifestPath = join(
    archiveRoot,
    ...PUBLIC_MANIFEST_PATH.split("/"),
  );
  const publicManifestBytes = await readStableFile(
    publicManifestPath,
    "retrospective public manifest",
    archiveRoot,
  );
  const publicManifest = await readCanonicalManifest<
    RsiRetrospectiveArchivePublicManifest
  >(
    publicManifestPath,
    "retrospective public manifest",
    "rsi_retrospective_archive_public_manifest.schema.json",
  );
  if (publicManifest.specHash !== spec.canonicalHash) {
    throw new Error("retrospective public manifest specHash is invalid");
  }
  assertManifestMatchesSpec(
    publicManifest.artifacts,
    spec,
    "public",
    "retrospective public manifest",
  );

  const publicArtifactsRoot = await canonicalDirectory(
    join(archiveRoot, ...PUBLIC_ARTIFACTS_PATH.split("/")),
    "retrospective public artifacts",
  );
  const actualPublicArtifacts: RsiRetrospectiveArchiveArtifact[] = [];
  for (const artifact of publicManifest.artifacts) {
    const actual = await inventoryArchivedArtifact(
      join(publicArtifactsRoot, artifact.artifactId),
      artifact,
      `retrospective public artifact ${artifact.artifactId}`,
    );
    assertSameDocument(
      actual,
      artifact,
      `retrospective public artifact ${artifact.artifactId}`,
    );
    actualPublicArtifacts.push(actual);
  }

  const privateSpecs = spec.artifacts.filter(
    (artifact) => artifact.visibility === "private",
  );
  let privateManifest:
    RsiRetrospectiveArchivePrivateManifest | undefined;
  let privateManifestBytes: Buffer | undefined;
  const actualPrivateArtifacts: RsiRetrospectiveArchiveArtifact[] = [];
  if (privateSpecs.length > 0) {
    await assertOwnerOnlyDirectoryTree(
      join(archiveRoot, "private"),
      "retrospective private archive",
    );
    const privateManifestPath = join(
      archiveRoot,
      ...PRIVATE_MANIFEST_PATH.split("/"),
    );
    privateManifestBytes = await readStableFile(
      privateManifestPath,
      "retrospective private manifest",
      archiveRoot,
    );
    privateManifest = await readCanonicalManifest<
      RsiRetrospectiveArchivePrivateManifest
    >(
      privateManifestPath,
      "retrospective private manifest",
      "rsi_retrospective_archive_private_manifest.schema.json",
    );
    if (privateManifest.specHash !== spec.canonicalHash
      || privateManifest.publicManifestHash
        !== publicManifest.canonicalHash) {
      throw new Error(
        "retrospective private manifest bindings are invalid",
      );
    }
    assertManifestMatchesSpec(
      privateManifest.artifacts,
      spec,
      "private",
      "retrospective private manifest",
    );
    const privateArtifactsRoot = await canonicalDirectory(
      join(archiveRoot, ...PRIVATE_ARTIFACTS_PATH.split("/")),
      "retrospective private artifacts",
    );
    for (const artifact of privateManifest.artifacts) {
      const actual = await inventoryArchivedArtifact(
        join(privateArtifactsRoot, artifact.artifactId),
        artifact,
        `retrospective private artifact ${artifact.artifactId}`,
      );
      assertSameDocument(
        actual,
        artifact,
        `retrospective private artifact ${artifact.artifactId}`,
      );
      actualPrivateArtifacts.push(actual);
    }
  }

  const seal = await readCanonicalManifest<
    RsiRetrospectiveArchiveSeal
  >(
    join(archiveRoot, SEAL_PATH),
    "retrospective archive seal",
    "rsi_retrospective_archive_seal.schema.json",
  );
  const expectedSeal = buildSeal({
    specBytes,
    spec,
    publicManifestBytes,
    publicManifest,
    privateManifestBytes,
    privateManifest,
  });
  assertSameDocument(
    seal,
    expectedSeal,
    "retrospective archive seal",
  );

  const archiveListing = await listTree(
    archiveRoot,
    "retrospective archive",
  );
  const expectedPaths = expectedArchivePaths(
    actualPublicArtifacts,
    actualPrivateArtifacts,
  );
  if (canonicalJson(archiveListing.directories)
      !== canonicalJson(expectedPaths.directories)
    || canonicalJson(
      archiveListing.files.map((file) => file.relativePath),
    ) !== canonicalJson(expectedPaths.files)) {
    throw new Error(
      "retrospective archive contains missing or extra paths",
    );
  }

  return {
    archiveDir: archiveRoot,
    specHash: spec.canonicalHash,
    sealHash: seal.canonicalHash,
    publicManifestHash: publicManifest.canonicalHash,
    privateManifestHash: privateManifest?.canonicalHash ?? null,
    publicArtifactCount: actualPublicArtifacts.length,
    privateArtifactCount: actualPrivateArtifacts.length,
    publicFileCount: actualPublicArtifacts.reduce(
      (total, artifact) => total + artifact.files.length,
      0,
    ),
    privateFileCount: actualPrivateArtifacts.reduce(
      (total, artifact) => total + artifact.files.length,
      0,
    ),
  };
}

/**
 * Copies a closed set of retrospective artifacts into a fresh, sealed
 * archive. Sources are inventoried before copying, during copying, and after
 * copying; any mutation aborts creation and removes the partial output.
 */
export async function createRsiRetrospectiveArchive(
  input: CreateRsiRetrospectiveArchiveInput,
  dependencies: RsiRetrospectiveArchiveDependencies = {},
): Promise<RsiRetrospectiveArchiveResult> {
  const spec = await validateSpec(input.spec);
  const sourceRoot = await canonicalDirectory(
    input.sourceRoot,
    "retrospective archive sourceRoot",
  );
  const requestedOutput = resolve(input.outputDir);
  const outputName = basename(requestedOutput);
  if (!SAFE_OUTPUT_NAME.test(outputName)) {
    throw new Error(
      "retrospective archive output directory has an unsafe name",
    );
  }
  const outputParent = await canonicalDirectory(
    dirname(requestedOutput),
    "retrospective archive output parent",
  );
  const outputDir = join(outputParent, outputName);
  if (isInsideOrEqual(outputDir, sourceRoot)) {
    throw new Error(
      "retrospective archive output must be outside sourceRoot",
    );
  }
  if (await pathExists(outputDir)) {
    throw new Error(
      "retrospective archive output already exists; overwrite is forbidden",
    );
  }

  const resolvedArtifacts: ResolvedSourceArtifact[] = [];
  for (const artifactSpec of spec.artifacts) {
    resolvedArtifacts.push(
      await resolveSourceArtifact(sourceRoot, artifactSpec),
    );
  }
  for (let left = 0; left < resolvedArtifacts.length; left += 1) {
    for (
      let right = left + 1;
      right < resolvedArtifacts.length;
      right += 1
    ) {
      const leftPath = resolvedArtifacts[left]!.absolutePath;
      const rightPath = resolvedArtifacts[right]!.absolutePath;
      if (isInsideOrEqual(leftPath, rightPath)
        || isInsideOrEqual(rightPath, leftPath)) {
        throw new Error(
          "retrospective archive resolved sources must not overlap",
        );
      }
    }
  }

  const before = new Map<string, RsiRetrospectiveArchiveArtifact>();
  for (const artifact of resolvedArtifacts) {
    before.set(
      artifact.spec.artifactId,
      await snapshotSourceArtifact(sourceRoot, artifact),
    );
  }
  await dependencies.afterSourceInventory?.({
    sourceRoot,
    artifacts: spec.artifacts.map((artifact) => ({ ...artifact })),
  });

  try {
    await mkdir(outputDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "retrospective archive output already exists; overwrite is forbidden",
      );
    }
    throw error;
  }
  try {
    await chmod(outputDir, 0o700);
    const publicRoot = join(
      outputDir,
      ...PUBLIC_ARTIFACTS_PATH.split("/"),
    );
    await makeDirectory(publicRoot, false);
    const privateArtifacts = resolvedArtifacts.filter(
      (artifact) => artifact.spec.visibility === "private",
    );
    const privateRoot = privateArtifacts.length > 0
      ? join(outputDir, ...PRIVATE_ARTIFACTS_PATH.split("/"))
      : undefined;
    if (privateRoot) await makeDirectory(privateRoot, true);

    const copied = new Map<
      string,
      RsiRetrospectiveArchiveArtifact
    >();
    for (const artifact of resolvedArtifacts) {
      copied.set(
        artifact.spec.artifactId,
        await copySourceArtifact(
          sourceRoot,
          artifact,
          artifact.spec.visibility === "public"
            ? publicRoot
            : privateRoot!,
          artifact.spec.visibility === "private",
        ),
      );
    }

    const after = new Map<string, RsiRetrospectiveArchiveArtifact>();
    for (const artifact of resolvedArtifacts) {
      after.set(
        artifact.spec.artifactId,
        await snapshotSourceArtifact(sourceRoot, artifact),
      );
    }
    for (const artifact of resolvedArtifacts) {
      const artifactId = artifact.spec.artifactId;
      if (canonicalJson(before.get(artifactId))
          !== canonicalJson(copied.get(artifactId))
        || canonicalJson(before.get(artifactId))
          !== canonicalJson(after.get(artifactId))) {
        throw new Error(
          `artifact ${artifactId} source changed while archived`,
        );
      }
    }

    const publicArtifacts = spec.artifacts
      .filter((artifact) => artifact.visibility === "public")
      .map((artifact) => copied.get(artifact.artifactId)!);
    const copiedPrivateArtifacts = spec.artifacts
      .filter((artifact) => artifact.visibility === "private")
      .map((artifact) => copied.get(artifact.artifactId)!);

    const publicManifest = buildPublicManifest(
      spec.canonicalHash,
      publicArtifacts,
    );
    await assertSchema(
      "rsi_retrospective_archive_public_manifest.schema.json",
      publicManifest,
      "retrospective public manifest",
    );
    const publicManifestBytes = await writeJson(
      join(outputDir, ...PUBLIC_MANIFEST_PATH.split("/")),
      publicManifest,
      false,
    );

    let privateManifest:
      RsiRetrospectiveArchivePrivateManifest | undefined;
    let privateManifestBytes: Buffer | undefined;
    if (copiedPrivateArtifacts.length > 0) {
      privateManifest = buildPrivateManifest(
        spec.canonicalHash,
        publicManifest.canonicalHash,
        copiedPrivateArtifacts,
      );
      await assertSchema(
        "rsi_retrospective_archive_private_manifest.schema.json",
        privateManifest,
        "retrospective private manifest",
      );
      privateManifestBytes = await writeJson(
        join(outputDir, ...PRIVATE_MANIFEST_PATH.split("/")),
        privateManifest,
        true,
      );
    }

    const specBytes = await writeJson(
      join(outputDir, SPEC_PATH),
      spec,
      true,
    );
    const seal = buildSeal({
      specBytes,
      spec,
      publicManifestBytes,
      publicManifest,
      privateManifestBytes,
      privateManifest,
    });
    await assertSchema(
      "rsi_retrospective_archive_seal.schema.json",
      seal,
      "retrospective archive seal",
    );
    await writeJson(join(outputDir, SEAL_PATH), seal, true);
    return await verifyRsiRetrospectiveArchive(outputDir);
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}
