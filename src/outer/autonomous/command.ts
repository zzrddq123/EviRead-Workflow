import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  autonomousRsiCampaignStatus,
  initializeAutonomousRsiCampaign,
  runAutonomousRsiCampaign,
  verifyAutonomousRsiCampaign,
} from "./orchestrator.js";

function options(args: string[]): Map<string, string> {
  const output = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (!raw.startsWith("--")) throw new Error(`unexpected autonomous RSI argument: ${raw}`);
    const separator = raw.indexOf("=");
    if (separator > 0) {
      const name = raw.slice(0, separator);
      if (output.has(name)) throw new Error(`duplicate autonomous RSI option: ${name}`);
      output.set(name, raw.slice(separator + 1));
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${raw} requires a value`);
    if (output.has(raw)) throw new Error(`duplicate autonomous RSI option: ${raw}`);
    output.set(raw, value);
    index += 1;
  }
  return output;
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`autonomous RSI command requires ${name}`);
  return value;
}

function assertAllowed(values: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  const known = new Set(allowed);
  for (const name of values.keys()) if (!known.has(name)) throw new Error(`unknown autonomous RSI option: ${name}`);
}

export async function autonomousRsiCommand(command: string, args: string[]): Promise<number> {
  const values = options(args);
  if (command === "autonomous-rsi-init") {
    assertAllowed(values, ["--spec", "--campaign-dir"]);
    const spec = JSON.parse(await readFile(resolve(required(values, "--spec")), "utf8")) as unknown;
    const state = await initializeAutonomousRsiCampaign({
      campaignDir: resolve(required(values, "--campaign-dir")),
      spec,
    });
    const status = await autonomousRsiCampaignStatus(
      resolve(required(values, "--campaign-dir")),
    );
    console.log(JSON.stringify({
      campaignId: state.campaignId,
      status: state.status,
      nextIteration: state.nextIteration,
      nextStage: state.nextStage,
      lifecycle: status.lifecycle,
      specHash: state.specHash,
    }, null, 2));
    return 0;
  }
  if (command === "autonomous-rsi-run") {
    assertAllowed(values, ["--campaign-dir", "--project-root", "--max-transitions"]);
    const maximum = values.has("--max-transitions") ? Number(values.get("--max-transitions")) : undefined;
    const result = await runAutonomousRsiCampaign({
      campaignDir: resolve(required(values, "--campaign-dir")),
      projectRoot: resolve(values.get("--project-root") ?? "."),
      maxTransitions: maximum,
    });
    const status = await autonomousRsiCampaignStatus(
      resolve(required(values, "--campaign-dir")),
    );
    console.log(JSON.stringify({
      campaignId: result.state.campaignId,
      status: result.state.status,
      transitions: result.transitions,
      nextIteration: result.state.nextIteration,
      nextStage: result.state.nextStage,
      lifecycle: status.lifecycle,
      bestMetric: result.state.bestMetric,
      stopReason: result.state.stopReason,
      handoffHash: result.state.handoffHash,
    }, null, 2));
    return result.state.status === "failed" ? 1 : 0;
  }
  if (command === "autonomous-rsi-status") {
    assertAllowed(values, ["--campaign-dir"]);
    console.log(JSON.stringify(await autonomousRsiCampaignStatus(resolve(required(values, "--campaign-dir"))), null, 2));
    return 0;
  }
  if (command === "autonomous-rsi-verify") {
    assertAllowed(values, ["--campaign-dir"]);
    console.log(JSON.stringify(await verifyAutonomousRsiCampaign(resolve(required(values, "--campaign-dir"))), null, 2));
    return 0;
  }
  throw new Error(`unknown autonomous RSI command: ${command}`);
}
