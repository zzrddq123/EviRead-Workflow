import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sanitizePersistedError, sanitizePiSessionFiles } from "./privacy.js";

test("persisted error sanitizer removes discovered identities and private paths", () => {
  const message = "Artifact /Users/private/project/runs/x contains sp|Q9H9G7.2|PRIVATE and q9h9g7";
  const sanitized = sanitizePersistedError(message, ["Q9H9G7"], ["/Users/private/project"]);
  assert.doesNotMatch(sanitized, /Q9H9G7|\/Users\/private\/project/i);
  assert.match(sanitized, /<REDACTED_IDENTITY>/);
  assert.match(sanitized, /<PRIVATE_PATH>/);
});

test("Pi session sanitizer removes project, run, and home paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-privacy-"));
  try {
    const runDir = join(root, "project", "runs", "anonymous");
    const sessionDir = join(runDir, "pi", "sessions", "synthesis");
    await mkdir(sessionDir, { recursive: true });
    const session = join(sessionDir, "session.jsonl");
    await writeFile(session, JSON.stringify({ cwd: join(root, "project"), run: runDir, home: process.env.HOME }) + "\n", "utf8");
    await sanitizePiSessionFiles(runDir, join(root, "project"));
    const text = await readFile(session, "utf8");
    assert.doesNotMatch(text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (process.env.HOME) assert.doesNotMatch(text, new RegExp(process.env.HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text, /<RUN_DIR>|<PROJECT_ROOT>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
