import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Redact identities and workstation roots before a failure enters public run metadata. */
export function sanitizePersistedError(
  message: string,
  sensitiveIdentities: readonly string[],
  privatePaths: readonly (string | undefined)[] = [],
): string {
  let output = message;
  const paths = [...new Set(privatePaths.filter((value): value is string => Boolean(value)))]
    .sort((left, right) => right.length - left.length);
  for (const path of paths) output = output.replaceAll(path, "<PRIVATE_PATH>");
  const identities = [...new Set(sensitiveIdentities.map((value) => value.trim()).filter((value) => value.length >= 4))]
    .sort((left, right) => right.length - left.length);
  for (const identity of identities) {
    output = output.replace(new RegExp(escapeRegExp(identity), "gi"), "<REDACTED_IDENTITY>");
  }
  return output;
}

async function jsonlFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const output: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await jsonlFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(path);
  }
  return output.sort();
}

/** Remove workstation paths from persisted Pi transcripts without altering scientific content. */
export async function sanitizePiSessionFiles(runDir: string, projectRoot: string): Promise<void> {
  for (const path of await jsonlFiles(join(runDir, "pi", "sessions"))) {
    let text = await readFile(path, "utf8");
    text = text.replaceAll(runDir, "<RUN_DIR>").replaceAll(projectRoot, "<PROJECT_ROOT>");
    const home = process.env.HOME;
    if (home) text = text.replaceAll(home, "<HOME>");
    await writeFile(path, text, "utf8");
  }
}
