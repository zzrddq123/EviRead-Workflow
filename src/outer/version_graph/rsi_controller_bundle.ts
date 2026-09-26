import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { builtinModules } from "node:module";
import { promisify } from "node:util";

import { canonicalJson, hashCanonical } from "../../hash.js";

const execFileAsync = promisify(execFile);
const HASH = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const BUNDLE_SCHEMA = "pi-rsi-controller-bundle.v1" as const;
const CONTROLLER_ENTRY_PATH =
  "src/outer/version_graph/rsi_controller_entry.ts";
const RUNNER_PATH = "dist/controller.mjs";
const MANIFEST_PATH = "controller_manifest.json";
const ESBUILD_VERSION = "0.28.1";
const RUNNER_MODE = 0o500;
const DATA_MODE = 0o400;
const DIRECTORY_MODE = 0o500;
export const RSI_CONTROLLER_ACTIVE_BUNDLE_ENV =
  "PI_RSI_CONTROLLER_BUNDLE";

export interface RsiControllerBundleInventoryEntry {
  path: string;
  sha256: string;
  size: number;
  mode: number;
}

export interface RsiControllerBundleManifest {
  schemaVersion: typeof BUNDLE_SCHEMA;
  controllerSource: {
    sourceRef: string;
    sourceCommit: string;
    sourceTree: string;
    sourceArchiveSha256: string;
  };
  build: {
    entryPath: typeof CONTROLLER_ENTRY_PATH;
    format: "esm";
    platform: "node";
    target: "node22";
    esbuildVersion: typeof ESBUILD_VERSION;
    packageLockSha256: string;
  };
  runtime: {
    nodeVersion: string;
    nodeExecutableSha256: string;
    platform: NodeJS.Platform;
    architecture: string;
  };
  runner: {
    path: typeof RUNNER_PATH;
    invocation:
      "self_verifying_executable_requires_explicit_absolute_repo_v1";
  };
  files: RsiControllerBundleInventoryEntry[];
  policies: {
    source:
      "exact_clean_committed_git_archive_not_worktree_or_dist_v1";
    dependencies:
      "fully_bundled_no_candidate_node_modules_at_runtime_v1";
    schemas:
      "complete_controller_commit_schema_tree_v1";
    installation:
      "git_common_dir_content_addressed_atomic_immutable_v1";
  };
  canonicalHash: string;
}

export interface VerifiedRsiControllerBundle {
  bundleRoot: string;
  manifestPath: string;
  runnerPath: string;
  nodeExecutablePath: string;
  invocation: readonly [string, string];
  manifest: RsiControllerBundleManifest;
}

export interface InstalledRsiControllerBundle
  extends VerifiedRsiControllerBundle {
  reusedExistingBundle: boolean;
}

export interface InstallRsiControllerBundleInput {
  repositoryRoot: string;
  /**
   * Package resolution is needed only while esbuild creates the self-contained
   * artifact. Production callers should omit this so dependencies come from
   * the exact clean controller checkout. Tests may point at a separately
   * verified dependency installation.
   */
  buildDependencyRoot?: string;
}

interface ControllerRepository {
  repositoryRoot: string;
  commonDir: string;
  sourceRef: string;
  sourceCommit: string;
  sourceTree: string;
}

function sha256(bytes: Buffer | string): string {
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

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new Error(`${label} has an invalid field set`);
  }
}

function assertHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function assertOid(value: unknown, label: string): string {
  if (typeof value !== "string" || !OID.test(value)) {
    throw new Error(`${label} must be a Git object ID`);
  }
  return value;
}

function assertSourceRef(value: unknown, label: string): string {
  if (typeof value !== "string"
    || !value.startsWith("refs/heads/")
    || value.length > 1024
    || value.includes("\0")
    || value.includes("\\")
    || value.includes("..")
    || value.endsWith("/")
    || value.endsWith(".")) {
    throw new Error(`${label} must be a canonical local branch ref`);
  }
  return value;
}

function safeInventoryPath(value: unknown, label: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 4096
    || isAbsolute(value)
    || value.includes("\\")
    || value.includes("\0")
    || posix.normalize(value) !== value
    || value === "."
    || value === ".."
    || value.startsWith("../")
    || value.startsWith("./")) {
    throw new Error(`${label} must be a normalized safe relative path`);
  }
  return value;
}

async function stableRegularFile(
  pathInput: string,
  label: string,
  maximumBytes = 512 * 1024 * 1024,
): Promise<{
  path: string;
  bytes: Buffer;
  sha256: string;
  size: number;
  mode: number;
}> {
  const path = resolve(pathInput);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()
    || before.size < 1 || before.size > maximumBytes) {
    throw new Error(`${label} must be a bounded regular non-symlink file`);
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()
      || before.dev !== opened.dev
      || before.ino !== opened.ino
      || before.size !== opened.size
      || before.mtimeMs !== opened.mtimeMs
      || before.ctimeMs !== opened.ctimeMs) {
      throw new Error(`${label} changed before it was opened`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile()
      || opened.dev !== after.dev
      || opened.ino !== after.ino
      || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs
      || opened.ctimeMs !== after.ctimeMs
      || bytes.length !== opened.size) {
      throw new Error(`${label} changed while it was read`);
    }
    return {
      path,
      bytes,
      sha256: sha256(bytes),
      size: bytes.length,
      mode: permissionBits(opened.mode),
    };
  } finally {
    await handle.close();
  }
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_SYSTEM",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_REPLACE_REF_BASE",
    "GIT_WORK_TREE",
  ]) {
    delete environment[key];
  }
  return {
    ...environment,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

async function git(
  repositoryRoot: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFileAsync(
    "git",
    [
      "-C",
      repositoryRoot,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: sanitizedGitEnvironment(),
    },
  );
  return result.stdout.trim();
}

async function inspectRepositoryLocation(
  repositoryInput: string,
): Promise<{
  repositoryRoot: string;
  commonDir: string;
}> {
  const requested = await realpath(resolve(repositoryInput));
  const repositoryRoot = await realpath(await git(requested, [
    "rev-parse",
    "--show-toplevel",
  ]));
  if (requested !== repositoryRoot) {
    throw new Error(
      "RSI controller bundle installation requires the canonical Git worktree top-level",
    );
  }
  if (await git(repositoryRoot, [
    "rev-parse",
    "--is-shallow-repository",
  ]) !== "false") {
    throw new Error("RSI controller bundle rejects a shallow repository");
  }
  const replacementRefs = await git(repositoryRoot, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/replace/",
  ]);
  if (replacementRefs !== "") {
    throw new Error("RSI controller bundle rejects Git replacement refs");
  }
  const commonDirRaw = await git(repositoryRoot, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const commonDir = await realpath(
    isAbsolute(commonDirRaw)
      ? commonDirRaw
      : resolve(repositoryRoot, commonDirRaw),
  );
  const graftsPath = join(commonDir, "info", "grafts");
  try {
    const grafts = await lstat(graftsPath);
    if (!grafts.isFile() || grafts.isSymbolicLink() || grafts.size > 0) {
      throw new Error("RSI controller bundle rejects Git grafts");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    repositoryRoot,
    commonDir,
  };
}

async function inspectControllerRepository(
  repositoryInput: string,
): Promise<ControllerRepository> {
  const {
    repositoryRoot,
    commonDir,
  } = await inspectRepositoryLocation(repositoryInput);
  const status = await git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status !== "") {
    throw new Error(
      "RSI controller bundle requires a clean index, worktree, and non-ignored untracked set",
    );
  }
  const indexFlags = await git(repositoryRoot, [
    "ls-files",
    "-v",
    "-z",
  ]);
  for (const entry of indexFlags.split("\0")) {
    if (entry === "") continue;
    const marker = entry[0]!;
    if (marker === "S" || marker === marker.toLowerCase()) {
      throw new Error(
        "RSI controller bundle rejects assume-unchanged and skip-worktree index flags",
      );
    }
  }
  const sourceCommit = assertOid(
    await git(repositoryRoot, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]),
    "RSI controller source commit",
  );
  const sourceTree = assertOid(
    await git(repositoryRoot, [
      "rev-parse",
      "--verify",
      "HEAD^{tree}",
    ]),
    "RSI controller source tree",
  );
  const sourceRef = await git(repositoryRoot, [
    "symbolic-ref",
    "--quiet",
    "HEAD",
  ]).catch(() => "");
  if (!sourceRef.startsWith("refs/heads/")
    || !await git(repositoryRoot, [
      "check-ref-format",
      sourceRef,
    ]).then(() => true, () => false)) {
    throw new Error(
      "RSI controller bundle installation requires a named source branch",
    );
  }
  const tree = await git(repositoryRoot, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    sourceCommit,
  ]);
  for (const entry of tree.split("\0")) {
    if (entry === "") continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) {
      throw new Error("RSI controller source tree is malformed");
    }
    const [mode, type] = entry.slice(0, tab).split(" ");
    if (mode === "120000" || mode === "160000"
      || type === "commit") {
      throw new Error(
        "RSI controller bundle rejects tracked symlinks and submodules",
      );
    }
    if (mode !== "100644" && mode !== "100755") {
      throw new Error(
        `RSI controller source tree uses unsupported Git mode ${mode}`,
      );
    }
  }
  return {
    repositoryRoot,
    commonDir,
    sourceRef,
    sourceCommit,
    sourceTree,
  };
}

async function ensurePrivateOrdinaryDirectory(
  parentInput: string,
  name: string,
): Promise<string> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error("RSI controller directory name is invalid");
  }
  const parent = await realpath(resolve(parentInput));
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(
      "RSI controller directory parent must be an ordinary directory",
    );
  }
  const target = join(parent, name);
  if (!isInsideOrEqual(target, parent) || target === parent) {
    throw new Error("RSI controller directory escaped its parent");
  }
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const before = await lstat(target);
  if (!before.isDirectory() || before.isSymbolicLink()
    || await realpath(target) !== target) {
    throw new Error(
      "RSI controller state path must be an ordinary non-symlink directory",
    );
  }
  const handle = await open(
    target,
    constants.O_RDONLY
      | constants.O_DIRECTORY
      | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory()
      || opened.dev !== before.dev
      || opened.ino !== before.ino) {
      throw new Error(
        "RSI controller state directory changed while it was opened",
      );
    }
    await handle.chmod(0o700);
    const after = await handle.stat();
    if (!after.isDirectory()
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || permissionBits(after.mode) !== 0o700) {
      throw new Error(
        "RSI controller state directory changed while it was secured",
      );
    }
  } finally {
    await handle.close();
  }
  return target;
}

async function verifyOrdinaryDirectory(
  pathInput: string,
  label: string,
  expectedMode?: number,
): Promise<string> {
  const requested = resolve(pathInput);
  const before = await lstat(requested);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`${label} must be an ordinary non-symlink directory`);
  }
  const canonical = await realpath(requested);
  if (canonical !== requested) {
    throw new Error(`${label} must use its canonical path`);
  }
  if (expectedMode !== undefined
    && permissionBits(before.mode) !== expectedMode) {
    throw new Error(`${label} mode is invalid`);
  }
  const handle = await open(
    requested,
    constants.O_RDONLY
      | constants.O_DIRECTORY
      | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || (expectedMode !== undefined
        && permissionBits(opened.mode) !== expectedMode)) {
      throw new Error(`${label} changed while it was opened`);
    }
  } finally {
    await handle.close();
  }
  return canonical;
}

async function archiveCommittedSource(
  repository: ControllerRepository,
  stagingRoot: string,
): Promise<{
  sourceRoot: string;
  archiveSha256: string;
}> {
  const archivePath = join(stagingRoot, "controller-source.tar");
  const sourceRoot = join(stagingRoot, "source");
  await mkdir(sourceRoot, { mode: 0o700 });
  await git(repository.repositoryRoot, [
    "archive",
    "--format=tar",
    `--output=${archivePath}`,
    repository.sourceCommit,
  ]);
  const archive = await stableRegularFile(
    archivePath,
    "RSI controller source archive",
  );
  await execFileAsync("tar", [
    "-xf",
    archivePath,
    "-C",
    sourceRoot,
  ], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    sourceRoot,
    archiveSha256: archive.sha256,
  };
}

async function filesUnder(
  rootInput: string,
): Promise<Array<{
  absolutePath: string;
  relativePath: string;
}>> {
  const root = resolve(rootInput);
  const output: Array<{
    absolutePath: string;
    relativePath: string;
  }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const file = await lstat(absolutePath);
      if (file.isSymbolicLink()) {
        throw new Error(
          `RSI controller bundle rejects symbolic links: ${absolutePath}`,
        );
      }
      if (file.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!file.isFile()) {
        throw new Error(
          `RSI controller bundle rejects non-regular files: ${absolutePath}`,
        );
      }
      const nativeRelative = relative(root, absolutePath);
      const relativePath = nativeRelative.split(sep).join("/");
      safeInventoryPath(relativePath, "RSI controller inventory path");
      output.push({ absolutePath, relativePath });
    }
  };
  await visit(root);
  return output;
}

async function writeBundleFile(
  root: string,
  relativePath: string,
  bytes: Buffer | string,
  mode: number,
): Promise<void> {
  safeInventoryPath(relativePath, "RSI controller output path");
  const destination = resolve(
    root,
    ...relativePath.split("/"),
  );
  if (!isInsideOrEqual(destination, root)) {
    throw new Error("RSI controller output escaped its bundle root");
  }
  await mkdir(dirname(destination), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(destination, bytes, {
    flag: "wx",
    mode,
  });
  await chmod(destination, mode);
}

async function copySchemaTree(
  sourceRoot: string,
  bundleRoot: string,
): Promise<void> {
  const sourceSchemas = join(sourceRoot, "schemas");
  const schemasStat = await lstat(sourceSchemas);
  if (!schemasStat.isDirectory() || schemasStat.isSymbolicLink()) {
    throw new Error(
      "RSI controller source commit has no ordinary schemas directory",
    );
  }
  const schemas = await filesUnder(sourceSchemas);
  if (schemas.length === 0) {
    throw new Error("RSI controller source commit has an empty schema tree");
  }
  for (const schema of schemas) {
    const file = await stableRegularFile(
      schema.absolutePath,
      `RSI controller schema ${schema.relativePath}`,
      16 * 1024 * 1024,
    );
    await writeBundleFile(
      bundleRoot,
      `schemas/${schema.relativePath}`,
      file.bytes,
      DATA_MODE,
    );
  }
}

async function executableBinding(): Promise<{
  nodeVersion: string;
  nodeExecutableSha256: string;
  platform: NodeJS.Platform;
  architecture: string;
}> {
  const executable = await stableRegularFile(
    await realpath(process.execPath),
    "RSI controller Node executable",
  );
  return {
    nodeVersion: process.version,
    nodeExecutableSha256: executable.sha256,
    platform: process.platform,
    architecture: process.arch,
  };
}

async function buildControllerRunner(input: {
  sourceRoot: string;
  dependencyRoot: string;
  bundleRoot: string;
}): Promise<string> {
  const entry = resolve(
    input.sourceRoot,
    ...CONTROLLER_ENTRY_PATH.split("/"),
  );
  if (!isInsideOrEqual(entry, input.sourceRoot)) {
    throw new Error("RSI controller entry escaped its source archive");
  }
  const entryFile = await stableRegularFile(
    entry,
    "RSI controller entry",
    4 * 1024 * 1024,
  );
  void entryFile;
  const requestedNodeModules = join(
    resolve(input.dependencyRoot),
    "node_modules",
  );
  const nodeModulesStat = await lstat(requestedNodeModules);
  if (!nodeModulesStat.isDirectory()
    || nodeModulesStat.isSymbolicLink()) {
    throw new Error(
      "RSI controller build requires an ordinary installed node_modules directory",
    );
  }
  const nodeModules = await realpath(requestedNodeModules);
  if (nodeModules !== requestedNodeModules) {
    throw new Error(
      "RSI controller build rejects a non-canonical node_modules directory",
    );
  }
  const esbuild = await import("esbuild");
  if (esbuild.version !== ESBUILD_VERSION) {
    throw new Error(
      `RSI controller build requires esbuild ${ESBUILD_VERSION}`,
    );
  }
  const result = await esbuild.build({
    absWorkingDir: input.sourceRoot,
    entryPoints: [CONTROLLER_ENTRY_PATH],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    nodePaths: [nodeModules],
    write: false,
    outfile: RUNNER_PATH,
    sourcemap: false,
    legalComments: "none",
    treeShaking: true,
    logLevel: "silent",
    metafile: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  });
  if (result.outputFiles.length !== 1) {
    throw new Error(
      "RSI controller build did not produce exactly one executable",
    );
  }
  const externalImports = Object.values(
    result.metafile.outputs,
  ).flatMap((output) => output.imports)
    .filter((item) =>
      item.external
      && !item.path.startsWith("node:")
      && !builtinModules.includes(item.path));
  if (externalImports.length > 0) {
    throw new Error(
      `RSI controller build retained non-Node runtime imports: ${
        externalImports.map((item) => item.path).join(", ")
      }`,
    );
  }
  const bytes = Buffer.from(result.outputFiles[0]!.contents);
  await writeBundleFile(
    input.bundleRoot,
    RUNNER_PATH,
    bytes,
    RUNNER_MODE,
  );
  return esbuild.version;
}

async function inventoryBundlePayload(
  bundleRoot: string,
): Promise<RsiControllerBundleInventoryEntry[]> {
  const files = await filesUnder(bundleRoot);
  const inventory: RsiControllerBundleInventoryEntry[] = [];
  for (const file of files) {
    if (file.relativePath === MANIFEST_PATH) continue;
    const stable = await stableRegularFile(
      file.absolutePath,
      `RSI controller bundle file ${file.relativePath}`,
    );
    inventory.push({
      path: file.relativePath,
      sha256: stable.sha256,
      size: stable.size,
      mode: stable.mode,
    });
  }
  inventory.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return inventory;
}

async function lockBundleDirectories(root: string): Promise<void> {
  const directories: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    directories.push(directory);
    const entries = await readdir(directory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await visit(join(directory, entry.name));
    }
  };
  await visit(root);
  directories.sort((left, right) => right.length - left.length);
  for (const directory of directories) {
    await chmod(directory, DIRECTORY_MODE);
  }
}

async function makeDirectoriesOwnerWritable(root: string): Promise<void> {
  const rootStat = await lstat(root).catch(() => null);
  if (!rootStat) return;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(
      "RSI controller staging cleanup encountered an unsafe root",
    );
  }
  const visit = async (directory: string): Promise<void> => {
    await chmod(directory, 0o700);
    const entries = await readdir(directory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          "RSI controller staging cleanup rejects symbolic links",
        );
      }
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name));
      }
    }
  };
  await visit(root);
}

function parseManifest(
  value: unknown,
): RsiControllerBundleManifest {
  const manifest = asRecord(value, "RSI controller bundle manifest");
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "controllerSource",
      "build",
      "runtime",
      "runner",
      "files",
      "policies",
      "canonicalHash",
    ],
    "RSI controller bundle manifest",
  );
  if (manifest.schemaVersion !== BUNDLE_SCHEMA) {
    throw new Error("unsupported RSI controller bundle manifest");
  }
  const controllerSource = asRecord(
    manifest.controllerSource,
    "RSI controller source binding",
  );
  exactKeys(
    controllerSource,
    [
      "sourceRef",
      "sourceCommit",
      "sourceTree",
      "sourceArchiveSha256",
    ],
    "RSI controller source binding",
  );
  const build = asRecord(manifest.build, "RSI controller build binding");
  exactKeys(
    build,
    [
      "entryPath",
      "format",
      "platform",
      "target",
      "esbuildVersion",
      "packageLockSha256",
    ],
    "RSI controller build binding",
  );
  if (build.entryPath !== CONTROLLER_ENTRY_PATH
    || build.format !== "esm"
    || build.platform !== "node"
    || build.target !== "node22"
    || build.esbuildVersion !== ESBUILD_VERSION) {
    throw new Error("RSI controller build binding is invalid");
  }
  const runtime = asRecord(
    manifest.runtime,
    "RSI controller runtime binding",
  );
  exactKeys(
    runtime,
    [
      "nodeVersion",
      "nodeExecutableSha256",
      "platform",
      "architecture",
    ],
    "RSI controller runtime binding",
  );
  if (typeof runtime.nodeVersion !== "string"
    || !/^v22\.[0-9]+\.[0-9]+$/.test(runtime.nodeVersion)
    || typeof runtime.platform !== "string"
    || typeof runtime.architecture !== "string"
    || runtime.platform.length === 0
    || runtime.architecture.length === 0) {
    throw new Error("RSI controller runtime binding is invalid");
  }
  const runner = asRecord(
    manifest.runner,
    "RSI controller runner binding",
  );
  exactKeys(
    runner,
    ["path", "invocation"],
    "RSI controller runner binding",
  );
  if (runner.path !== RUNNER_PATH
    || runner.invocation
      !== "self_verifying_executable_requires_explicit_absolute_repo_v1") {
    throw new Error("RSI controller runner binding is invalid");
  }
  const policies = asRecord(
    manifest.policies,
    "RSI controller policies",
  );
  exactKeys(
    policies,
    ["source", "dependencies", "schemas", "installation"],
    "RSI controller policies",
  );
  if (policies.source
      !== "exact_clean_committed_git_archive_not_worktree_or_dist_v1"
    || policies.dependencies
      !== "fully_bundled_no_candidate_node_modules_at_runtime_v1"
    || policies.schemas
      !== "complete_controller_commit_schema_tree_v1"
    || policies.installation
      !== "git_common_dir_content_addressed_atomic_immutable_v1") {
    throw new Error("RSI controller policies are invalid");
  }
  if (!Array.isArray(manifest.files)
    || manifest.files.length < 2) {
    throw new Error("RSI controller bundle inventory is incomplete");
  }
  const seen = new Set<string>();
  let previousPath = "";
  const files = manifest.files.map((raw, index) => {
    const entry = asRecord(
      raw,
      `RSI controller inventory entry ${index}`,
    );
    exactKeys(
      entry,
      ["path", "sha256", "size", "mode"],
      `RSI controller inventory entry ${index}`,
    );
    const path = safeInventoryPath(
      entry.path,
      `RSI controller inventory entry ${index}.path`,
    );
    if (seen.has(path) || (previousPath !== "" && path <= previousPath)) {
      throw new Error(
        "RSI controller inventory paths must be unique and sorted",
      );
    }
    seen.add(path);
    previousPath = path;
    if (!Number.isSafeInteger(entry.size)
      || (entry.size as number) < 1
      || !Number.isSafeInteger(entry.mode)
      || ![DATA_MODE, RUNNER_MODE].includes(entry.mode as number)) {
      throw new Error(
        `RSI controller inventory entry ${index} has invalid size or mode`,
      );
    }
    return {
      path,
      sha256: assertHash(
        entry.sha256,
        `RSI controller inventory entry ${index}.sha256`,
      ),
      size: entry.size as number,
      mode: entry.mode as number,
    };
  });
  if (!seen.has(RUNNER_PATH)
    || !files.some((entry) =>
      entry.path.startsWith("schemas/"))) {
    throw new Error(
      "RSI controller inventory lacks its runner or schema tree",
    );
  }
  const canonicalHash = assertHash(
    manifest.canonicalHash,
    "RSI controller manifest canonicalHash",
  );
  const { canonicalHash: _ignored, ...content } = manifest;
  if (canonicalHash !== hashCanonical(content)) {
    throw new Error("RSI controller manifest canonical hash is invalid");
  }
  return {
    schemaVersion: BUNDLE_SCHEMA,
    controllerSource: {
      sourceRef: assertSourceRef(
        controllerSource.sourceRef,
        "RSI controller source ref",
      ),
      sourceCommit: assertOid(
        controllerSource.sourceCommit,
        "RSI controller source commit",
      ),
      sourceTree: assertOid(
        controllerSource.sourceTree,
        "RSI controller source tree",
      ),
      sourceArchiveSha256: assertHash(
        controllerSource.sourceArchiveSha256,
        "RSI controller source archive hash",
      ),
    },
    build: {
      entryPath: CONTROLLER_ENTRY_PATH,
      format: "esm",
      platform: "node",
      target: "node22",
      esbuildVersion: ESBUILD_VERSION,
      packageLockSha256: assertHash(
        build.packageLockSha256,
        "RSI controller package-lock hash",
      ),
    },
    runtime: {
      nodeVersion: runtime.nodeVersion,
      nodeExecutableSha256: assertHash(
        runtime.nodeExecutableSha256,
        "RSI controller Node executable hash",
      ),
      platform: runtime.platform as NodeJS.Platform,
      architecture: runtime.architecture,
    },
    runner: {
      path: RUNNER_PATH,
      invocation:
        "self_verifying_executable_requires_explicit_absolute_repo_v1",
    },
    files,
    policies: {
      source:
        "exact_clean_committed_git_archive_not_worktree_or_dist_v1",
      dependencies:
        "fully_bundled_no_candidate_node_modules_at_runtime_v1",
      schemas:
        "complete_controller_commit_schema_tree_v1",
      installation:
        "git_common_dir_content_addressed_atomic_immutable_v1",
    },
    canonicalHash,
  };
}

export async function verifyRsiControllerBundle(
  bundleInput: string,
  options: {
    requireContentAddressedDirectory?: boolean;
    verifyRuntime?: boolean;
  } = {},
): Promise<VerifiedRsiControllerBundle> {
  const requested = resolve(bundleInput);
  const bundleRoot = await realpath(requested);
  if (bundleRoot !== requested) {
    throw new Error(
      "RSI controller bundle path must be canonical and must not use a symlink",
    );
  }
  const rootStat = await lstat(bundleRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(
      "RSI controller bundle root must be an ordinary directory",
    );
  }
  if (permissionBits(rootStat.mode) !== DIRECTORY_MODE) {
    throw new Error("RSI controller bundle root mode is invalid");
  }
  const verifyDirectoryTree = async (
    directory: string,
  ): Promise<void> => {
    await verifyOrdinaryDirectory(
      directory,
      "RSI controller bundle directory",
      DIRECTORY_MODE,
    );
    const entries = await readdir(directory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          "RSI controller bundle rejects symbolic links",
        );
      }
      if (entry.isDirectory()) {
        await verifyDirectoryTree(join(directory, entry.name));
      }
    }
  };
  await verifyDirectoryTree(bundleRoot);
  const manifestFile = await stableRegularFile(
    join(bundleRoot, MANIFEST_PATH),
    "RSI controller bundle manifest",
    8 * 1024 * 1024,
  );
  if (manifestFile.mode !== DATA_MODE) {
    throw new Error("RSI controller bundle manifest mode is invalid");
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(
      manifestFile.bytes.toString("utf8"),
    ) as unknown;
  } catch {
    throw new Error("RSI controller bundle manifest is not valid JSON");
  }
  const manifest = parseManifest(manifestValue);
  if ((options.requireContentAddressedDirectory ?? true)
    && basename(bundleRoot) !== manifest.canonicalHash) {
    throw new Error(
      "RSI controller bundle directory does not match its content hash",
    );
  }
  const actualFiles = await filesUnder(bundleRoot);
  const expectedPaths = [
    MANIFEST_PATH,
    ...manifest.files.map((entry) => entry.path),
  ].sort();
  const actualPaths = actualFiles
    .map((entry) => entry.relativePath)
    .sort();
  if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)) {
    throw new Error(
      "RSI controller bundle contains missing or unbound extra files",
    );
  }
  const byPath = new Map(
    actualFiles.map((entry) => [entry.relativePath, entry]),
  );
  for (const expected of manifest.files) {
    const actualPath = byPath.get(expected.path)?.absolutePath;
    if (!actualPath) {
      throw new Error(
        `RSI controller bundle file is missing: ${expected.path}`,
      );
    }
    const actual = await stableRegularFile(
      actualPath,
      `RSI controller bundle file ${expected.path}`,
    );
    if (actual.sha256 !== expected.sha256
      || actual.size !== expected.size
      || actual.mode !== expected.mode) {
      throw new Error(
        `RSI controller bundle file binding is invalid: ${expected.path}`,
      );
    }
  }
  if (options.verifyRuntime ?? true) {
    const runtime = await executableBinding();
    if (runtime.nodeVersion !== manifest.runtime.nodeVersion
      || runtime.nodeExecutableSha256
        !== manifest.runtime.nodeExecutableSha256
      || runtime.platform !== manifest.runtime.platform
      || runtime.architecture !== manifest.runtime.architecture) {
      throw new Error(
        "RSI controller bundle is running under an unbound Node runtime",
      );
    }
  }
  return {
    bundleRoot,
    manifestPath: join(bundleRoot, MANIFEST_PATH),
    runnerPath: join(bundleRoot, ...RUNNER_PATH.split("/")),
    nodeExecutablePath: await realpath(process.execPath),
    invocation: [
      await realpath(process.execPath),
      join(bundleRoot, ...RUNNER_PATH.split("/")),
    ],
    manifest,
  };
}

/**
 * Verify both the bundle contents and its authority for one repository.
 *
 * A content-addressed bundle is only self-consistent by itself. Formal graph
 * operations additionally require it to live below this repository's Git
 * common directory and to be bound to a still-existing local controller ref
 * at the exact committed source tree.
 */
export async function verifyRsiControllerBundleForRepository(
  bundleInput: string,
  repositoryInput: string,
): Promise<VerifiedRsiControllerBundle> {
  if (!isAbsolute(repositoryInput)) {
    throw new Error(
      "RSI controller repository verification requires an absolute --repo",
    );
  }
  const repository = await inspectRepositoryLocation(repositoryInput);
  const controllerStateRoot = await verifyOrdinaryDirectory(
    join(repository.commonDir, "rsi"),
    "RSI controller state root",
    0o700,
  );
  const controllersRoot = await verifyOrdinaryDirectory(
    join(controllerStateRoot, "controllers"),
    "RSI controller installation root",
    0o700,
  );
  const requestedBundle = resolve(bundleInput);
  if (dirname(requestedBundle) !== controllersRoot) {
    throw new Error(
      "RSI controller bundle is not installed for the target repository",
    );
  }
  const verified = await verifyRsiControllerBundle(requestedBundle);
  const sourceRef = verified.manifest.controllerSource.sourceRef;
  await git(repository.repositoryRoot, [
    "check-ref-format",
    sourceRef,
  ]);
  const sourceCommit = assertOid(
    await git(repository.repositoryRoot, [
      "rev-parse",
      "--verify",
      `${sourceRef}^{commit}`,
    ]),
    "installed RSI controller source ref commit",
  );
  const sourceTree = assertOid(
    await git(repository.repositoryRoot, [
      "rev-parse",
      "--verify",
      `${sourceRef}^{tree}`,
    ]),
    "installed RSI controller source ref tree",
  );
  if (sourceCommit !== verified.manifest.controllerSource.sourceCommit
    || sourceTree !== verified.manifest.controllerSource.sourceTree) {
    throw new Error(
      "RSI controller source ref no longer identifies the installed controller",
    );
  }
  return verified;
}

async function createBundlePayload(input: {
  repository: ControllerRepository;
  sourceRoot: string;
  archiveSha256: string;
  dependencyRoot: string;
  payloadRoot: string;
}): Promise<RsiControllerBundleManifest> {
  const packageLock = await stableRegularFile(
    join(input.sourceRoot, "package-lock.json"),
    "RSI controller package-lock",
    64 * 1024 * 1024,
  );
  const esbuildVersion = await buildControllerRunner({
    sourceRoot: input.sourceRoot,
    dependencyRoot: input.dependencyRoot,
    bundleRoot: input.payloadRoot,
  });
  await copySchemaTree(input.sourceRoot, input.payloadRoot);
  const files = await inventoryBundlePayload(input.payloadRoot);
  const runtime = await executableBinding();
  const content: Omit<
    RsiControllerBundleManifest,
    "canonicalHash"
  > = {
    schemaVersion: BUNDLE_SCHEMA,
    controllerSource: {
      sourceRef: input.repository.sourceRef,
      sourceCommit: input.repository.sourceCommit,
      sourceTree: input.repository.sourceTree,
      sourceArchiveSha256: input.archiveSha256,
    },
    build: {
      entryPath: CONTROLLER_ENTRY_PATH,
      format: "esm" as const,
      platform: "node" as const,
      target: "node22" as const,
      esbuildVersion: esbuildVersion as typeof ESBUILD_VERSION,
      packageLockSha256: packageLock.sha256,
    },
    runtime,
    runner: {
      path: RUNNER_PATH,
      invocation:
        "self_verifying_executable_requires_explicit_absolute_repo_v1" as const,
    },
    files,
    policies: {
      source:
        "exact_clean_committed_git_archive_not_worktree_or_dist_v1" as const,
      dependencies:
        "fully_bundled_no_candidate_node_modules_at_runtime_v1" as const,
      schemas:
        "complete_controller_commit_schema_tree_v1" as const,
      installation:
        "git_common_dir_content_addressed_atomic_immutable_v1" as const,
    },
  };
  const manifest: RsiControllerBundleManifest = {
    ...content,
    canonicalHash: hashCanonical(content),
  };
  await writeBundleFile(
    input.payloadRoot,
    MANIFEST_PATH,
    `${JSON.stringify(manifest, null, 2)}\n`,
    DATA_MODE,
  );
  await lockBundleDirectories(input.payloadRoot);
  await verifyRsiControllerBundle(input.payloadRoot, {
    requireContentAddressedDirectory: false,
  });
  return manifest;
}

export async function installRsiControllerBundle(
  input: InstallRsiControllerBundleInput,
): Promise<InstalledRsiControllerBundle> {
  const repository = await inspectControllerRepository(
    input.repositoryRoot,
  );
  const dependencyRoot = await realpath(resolve(
    input.buildDependencyRoot ?? repository.repositoryRoot,
  ));
  const controllerStateRoot = await ensurePrivateOrdinaryDirectory(
    repository.commonDir,
    "rsi",
  );
  const controllersRoot = await ensurePrivateOrdinaryDirectory(
    controllerStateRoot,
    "controllers",
  );
  const lockPath = join(
    controllerStateRoot,
    "controller-install.lock",
  );
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `RSI controller installation is locked; inspect the fail-closed stale lock at ${lockPath}`,
      );
    }
    throw error;
  }
  let stagingRoot: string | undefined;
  try {
    await lock.writeFile(`${JSON.stringify({
      schemaVersion: "pi-rsi-controller-install-lock.v1",
      pid: process.pid,
      sourceRef: repository.sourceRef,
      sourceCommit: repository.sourceCommit,
    })}\n`, "utf8");
    stagingRoot = await mkdtemp(join(
      controllersRoot,
      ".staging-",
    ));
    const archived = await archiveCommittedSource(
      repository,
      stagingRoot,
    );
    const payloadRoot = join(stagingRoot, "payload");
    await mkdir(payloadRoot, { mode: 0o700 });
    const manifest = await createBundlePayload({
      repository,
      sourceRoot: archived.sourceRoot,
      archiveSha256: archived.archiveSha256,
      dependencyRoot,
      payloadRoot,
    });
    // macOS may reject renaming an owner-read/execute-only directory even
    // when both parents are writable. The content has already been verified;
    // temporarily restore owner write permission for the atomic rename (or
    // staging cleanup), then lock the installed root again.
    await chmod(payloadRoot, 0o700);
    const destination = join(
      controllersRoot,
      manifest.canonicalHash,
    );
    let reusedExistingBundle = false;
    try {
      await lstat(destination);
      const existing = await verifyRsiControllerBundleForRepository(
        destination,
        repository.repositoryRoot,
      );
      if (canonicalJson(existing.manifest)
        !== canonicalJson(manifest)) {
        throw new Error(
          "existing RSI controller content-hash directory has different manifest bytes",
        );
      }
      reusedExistingBundle = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await rename(payloadRoot, destination);
      await chmod(destination, DIRECTORY_MODE);
    }
    const installed = await verifyRsiControllerBundleForRepository(
      destination,
      repository.repositoryRoot,
    );
    const after = await inspectControllerRepository(
      repository.repositoryRoot,
    );
    if (after.sourceRef !== repository.sourceRef
      || after.sourceCommit !== repository.sourceCommit
      || after.sourceTree !== repository.sourceTree
      || after.commonDir !== repository.commonDir) {
      throw new Error(
        "RSI controller source repository changed during installation",
      );
    }
    return {
      ...installed,
      reusedExistingBundle,
    };
  } finally {
    try {
      if (stagingRoot !== undefined) {
        await makeDirectoriesOwnerWritable(stagingRoot);
        await rm(stagingRoot, {
          recursive: true,
          force: true,
        });
      }
    } finally {
      try {
        await lock.close();
      } finally {
        await rm(lockPath);
      }
    }
  }
}

export const RSI_CONTROLLER_BUNDLE_SCHEMA = BUNDLE_SCHEMA;
export const RSI_CONTROLLER_ENTRY_RELATIVE_PATH =
  CONTROLLER_ENTRY_PATH;
