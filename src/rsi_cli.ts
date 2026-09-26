import { capabilityCommand, capabilityUsage, isCapabilityCommand } from "./experiment/capability_command.js";
import { experimentCommand, experimentUsage, isExperimentCommand } from "./experiment/command.js";
import { autonomousRsiCommand } from "./outer/autonomous/command.js";
import { autonomousRsiFormalBridgeCommand } from "./outer/autonomous/formal_bridge.js";
import { autonomousRsiPromotionCommand } from "./outer/autonomous/campaign_promotion.js";
import { productionAutonomousRsiInitCommand } from "./outer/autonomous/production_init.js";
import { productionAutonomousRsiStartCommand } from "./outer/autonomous/production_start.js";
import { productionAutonomousRsiWorkerCommand } from "./outer/autonomous/production_worker.js";
import { rsiControllerAwareVersionCommand } from "./outer/version_graph/rsi_controller_command.js";

const AUTONOMOUS_CORE = new Set([
  "autonomous-rsi-init",
  "autonomous-rsi-run",
  "autonomous-rsi-status",
  "autonomous-rsi-verify",
]);

const VERSION_COMMANDS = new Set([
  "rsi-controller-install",
  "rsi-retrospective-archive-create",
  "rsi-retrospective-archive-verify",
  "rsi-version-register",
  "rsi-version-evaluation-open",
  "rsi-version-evaluation-complete",
  "rsi-version-evaluation-publish",
  "rsi-version-decide",
  "rsi-version-exploration-record",
  "rsi-version-retrospective-record",
  "rsi-version-epoch-resume",
  "rsi-version-incumbent-adopt",
  "rsi-version-exploration-export",
  "rsi-version-fork",
  "rsi-version-prepare",
  "rsi-version-developer-context",
  "rsi-version-paper-export",
  "rsi-version-tree",
  "rsi-version-verify",
]);

function usage(): string {
  return `Protein Function Prediction RSI controller

Autonomous development loop:
  ./pi-agent rsi autonomous-rsi-init --spec SPEC --campaign-dir DIR
  ./pi-agent rsi autonomous-rsi-run --campaign-dir DIR --project-root REPO
  ./pi-agent rsi autonomous-rsi-status --campaign-dir DIR
  ./pi-agent rsi autonomous-rsi-verify --campaign-dir DIR
  ./pi-agent rsi autonomous-rsi-production-start --profile PROFILE
  ./pi-agent rsi autonomous-rsi-production-init [options]
  ./pi-agent rsi autonomous-rsi-promote|autonomous-rsi-archive [options]

Experiment instrumentation:
${experimentUsage()}

Capability governance:
${capabilityUsage()}

Version governance:
  ./pi-agent rsi rsi-controller-install --repo /absolute/repo
  Installed stable controller handles rsi-version-* commands.
`;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }
  if (isExperimentCommand(command)) return await experimentCommand(command, args);
  if (isCapabilityCommand(command)) return await capabilityCommand(command, args);
  if (AUTONOMOUS_CORE.has(command)) return await autonomousRsiCommand(command, args);
  if (command === "autonomous-rsi-production-start") return await productionAutonomousRsiStartCommand(args);
  if (command === "autonomous-rsi-production-init") return await productionAutonomousRsiInitCommand(args);
  if (command === "autonomous-rsi-production-worker") return await productionAutonomousRsiWorkerCommand(args);
  if (command === "autonomous-rsi-promote" || command === "autonomous-rsi-archive") {
    return await autonomousRsiPromotionCommand(command, args);
  }
  if (command === "autonomous-rsi-formal-bridge") return await autonomousRsiFormalBridgeCommand(args);
  if (VERSION_COMMANDS.has(command)) return await rsiControllerAwareVersionCommand(command, args);
  throw new Error(`unknown RSI command: ${command}`);
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
