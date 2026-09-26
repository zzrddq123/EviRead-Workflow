import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import {
  RSI_CONTROLLER_ACTIVE_BUNDLE_ENV,
  installRsiControllerBundle,
  verifyRsiControllerBundleForRepository,
  type VerifiedRsiControllerBundle,
} from "./rsi_controller_bundle.js";
import {
  rsiVersionCommand,
  type RsiStableControllerBinding,
} from "./rsi_version_command.js";

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
      `RSI controller bootstrap requires exactly one explicit ${name}`,
    );
  }
  return values[0]!;
}

function prepareRepository(args: readonly string[]): string {
  const rawRepository = explicitOption(args, "--repo");
  if (!isAbsolute(rawRepository)) {
    throw new Error(
      "rsi-version-prepare requires exactly one explicit absolute --repo",
    );
  }
  explicitOption(args, "--remote");
  const contextOutput = explicitOption(
    args,
    "--developer-context-output",
  );
  if (!isAbsolute(contextOutput)) {
    throw new Error(
      "rsi-version-prepare requires an absolute --developer-context-output",
    );
  }
  return resolve(rawRepository);
}

function installRepository(args: readonly string[]): string {
  const rawRepository = args.length === 2 && args[0] === "--repo"
    ? args[1]
    : args.length === 1 && args[0]!.startsWith("--repo=")
      ? args[0]!.slice("--repo=".length)
      : undefined;
  if (!rawRepository || !isAbsolute(rawRepository)) {
    throw new Error(
      "rsi-controller-install requires exactly one absolute --repo",
    );
  }
  return resolve(rawRepository);
}

function binding(
  controller: VerifiedRsiControllerBundle,
  reusedExistingBundle: boolean,
): RsiStableControllerBinding {
  return {
    bundleHash: controller.manifest.canonicalHash,
    bundleRoot: controller.bundleRoot,
    manifestPath: controller.manifestPath,
    runnerPath: controller.runnerPath,
    nodeExecutablePath: controller.nodeExecutablePath,
    invocation: controller.invocation,
    controllerSourceRef:
      controller.manifest.controllerSource.sourceRef,
    controllerSourceCommit:
      controller.manifest.controllerSource.sourceCommit,
    controllerSourceTree:
      controller.manifest.controllerSource.sourceTree,
    reusedExistingBundle,
  };
}

async function activeOrInstall(
  repositoryRoot: string,
): Promise<RsiStableControllerBinding> {
  const activeBundle = process.env[RSI_CONTROLLER_ACTIVE_BUNDLE_ENV];
  if (activeBundle) {
    return binding(
      await verifyRsiControllerBundleForRepository(
        activeBundle,
        repositoryRoot,
      ),
      true,
    );
  }
  const installed = await installRsiControllerBundle({
    repositoryRoot,
  });
  return binding(installed, installed.reusedExistingBundle);
}

async function runStableController(
  controller: RsiStableControllerBinding,
  command: "rsi-version-prepare",
  args: readonly string[],
): Promise<number> {
  const environment = { ...process.env };
  for (const key of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
  ]) {
    delete environment[key];
  }
  environment[RSI_CONTROLLER_ACTIVE_BUNDLE_ENV] =
    controller.bundleRoot;
  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(
      controller.nodeExecutablePath,
      [controller.runnerPath, command, ...args],
      {
        stdio: "inherit",
        env: environment,
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(
          `stable RSI controller terminated by signal ${signal}`,
        ));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

export async function rsiControllerAwareVersionCommand(
  command: string,
  args: string[],
): Promise<number> {
  if (command === "rsi-controller-install") {
    const controller = await activeOrInstall(
      installRepository(args),
    );
    console.log(JSON.stringify(controller, null, 2));
    return 0;
  }
  if (command === "rsi-version-prepare") {
    const stableController = await activeOrInstall(
      prepareRepository(args),
    );
    return await runStableController(
      stableController,
      "rsi-version-prepare",
      args,
    );
  }
  if (command.startsWith("rsi-version-")) {
    throw new Error(
      `${command} requires the verified stable RSI controller runner; `
      + "the candidate checkout CLI is not graph authority",
    );
  }
  if (command === "rsi-retrospective-archive-create"
    || command === "rsi-retrospective-archive-verify") {
    return await rsiVersionCommand(command, args);
  }
  throw new Error(`unsupported RSI controller-aware command: ${command}`);
}
