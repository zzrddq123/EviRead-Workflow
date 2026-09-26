import { fileURLToPath } from "node:url";
import {
  dirname,
  isAbsolute,
  resolve,
} from "node:path";

import {
  RSI_CONTROLLER_ACTIVE_BUNDLE_ENV,
  verifyRsiControllerBundleForRepository,
} from "./rsi_controller_bundle.js";
import {
  rsiVersionCommand,
  type RsiStableControllerBinding,
} from "./rsi_version_command.js";

const STABLE_CONTROLLER_COMMANDS: ReadonlySet<string> = new Set([
  "rsi-version-register",
  "rsi-version-evaluation-open",
  "rsi-version-evaluation-complete",
  "rsi-version-evaluation-publish",
  "rsi-version-decide",
  "rsi-version-exploration-record",
  "rsi-version-epoch-resume",
  "rsi-version-incumbent-adopt",
  "rsi-version-retrospective-record",
  "rsi-version-exploration-export",
  "rsi-version-fork",
  "rsi-version-prepare",
  "rsi-version-developer-context",
  "rsi-version-paper-export",
  "rsi-version-tree",
  "rsi-version-verify",
]);

function explicitOption(
  args: readonly string[],
  name: "--repo" | "--remote" | "--developer-context-output",
): string {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]!;
    if (item === name) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${name} requires an explicit value`);
      }
      values.push(value);
      index += 1;
    } else if (item.startsWith(`${name}=`)) {
      values.push(item.slice(`${name}=`.length));
    }
  }
  if (values.length !== 1) {
    throw new Error(
      name === "--repo"
        ? "stable RSI controller requires exactly one explicit absolute --repo"
        : `stable RSI controller requires exactly one explicit ${name}`,
    );
  }
  if (name !== "--remote" && !isAbsolute(values[0]!)) {
    throw new Error(
      `stable RSI controller requires an absolute ${name}`,
    );
  }
  return values[0]!;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !STABLE_CONTROLLER_COMMANDS.has(command)) {
    throw new Error(
      "stable RSI controller command is not in the closed allowlist",
    );
  }
  const repositoryRoot = explicitOption(args, "--repo");
  explicitOption(args, "--remote");
  if (command === "rsi-version-prepare") {
    explicitOption(args, "--developer-context-output");
  }
  const runnerPath = fileURLToPath(import.meta.url);
  const bundleRoot = resolve(dirname(runnerPath), "..");
  const verified = await verifyRsiControllerBundleForRepository(
    bundleRoot,
    repositoryRoot,
  );
  process.env[RSI_CONTROLLER_ACTIVE_BUNDLE_ENV] =
    verified.bundleRoot;
  const stableController: RsiStableControllerBinding = {
    bundleHash: verified.manifest.canonicalHash,
    bundleRoot: verified.bundleRoot,
    manifestPath: verified.manifestPath,
    runnerPath: verified.runnerPath,
    nodeExecutablePath: verified.nodeExecutablePath,
    invocation: verified.invocation,
    controllerSourceRef:
      verified.manifest.controllerSource.sourceRef,
    controllerSourceCommit:
      verified.manifest.controllerSource.sourceCommit,
    controllerSourceTree:
      verified.manifest.controllerSource.sourceTree,
    reusedExistingBundle: true,
  };
  return await rsiVersionCommand(command, args, {
    stableController,
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
