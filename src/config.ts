import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { temporalPredictionEnv } from "./temporal_inner.js";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`Invalid config line: ${raw}`);
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value.replace(/^~(?=\/)/, process.env.HOME ?? "~");
  }
  return values;
}

export function loadRuntimeEnv(configPath: string): NodeJS.ProcessEnv {
  const parsed = parseEnvFile(configPath);
  return { ...process.env, ...parsed };
}

/** Load runtime settings for the inner prediction agent, applying temporal admission when requested. */
export function loadPredictionRuntimeEnv(configPath: string): NodeJS.ProcessEnv {
  return temporalPredictionEnv(loadRuntimeEnv(configPath));
}

export function option(args: string[], name: string): string | undefined {
  const exact = args.indexOf(name);
  if (exact >= 0) {
    if (exact + 1 >= args.length) throw new Error(`${name} requires a value`);
    return args[exact + 1];
  }
  const prefix = `${name}=`;
  const inline = args.find((item) => item.startsWith(prefix));
  return inline?.slice(prefix.length);
}

export function sanitizeId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "") || "protein";
}

export function timestampId(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
