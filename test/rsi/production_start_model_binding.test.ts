import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadProductionStartProfile } from "../../src/outer/autonomous/production_start.js";

const base = {
  schemaVersion: "pi-autonomous-rsi-production-start-profile.v1",
  campaignId: "model-binding-r01",
  runRoot: "/tmp/model-binding/run",
  researchCommandFile: "/tmp/model-binding/research.json",
  evaluatorCommandFile: "/tmp/model-binding/evaluator.json",
  evaluatorContractHash: "a".repeat(64),
  publishedHistory: null,
  dataSplitManifest: "/tmp/model-binding/split.json",
  maxIterations: 2,
  experimentManifest: null,
};

test("LatestRSI production profiles bind an explicit model identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "latest-model-binding-"));
  try {
    const path = join(root, "profile.json");
    await writeFile(path, JSON.stringify({ ...base, modelProvider: "openai-codex", modelId: "gpt-5.6-sol", thinkingLevel: "high" }));
    const profile = await loadProductionStartProfile(path);
    assert.equal(profile.modelProvider, "openai-codex");
    assert.equal(profile.modelId, "gpt-5.6-sol");
    assert.equal(profile.thinkingLevel, "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LatestRSI production profiles reject invalid thinking levels", async () => {
  const root = await mkdtemp(join(tmpdir(), "latest-model-binding-invalid-"));
  try {
    const path = join(root, "profile.json");
    await writeFile(path, JSON.stringify({ ...base, thinkingLevel: "maximum" }));
    await assert.rejects(loadProductionStartProfile(path), /thinkingLevel is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex routing survives the worker environment allowlist", async () => {
  const { MODEL_CONTROL_ENV } = await import("../../src/outer/autonomous/production_init.js");
  const { spawnSync } = await import("node:child_process");
  const parent = { CODEX_HOME: "/tmp/operator-codex", CODEX_CHATGPT_BASE_URL: "http://localhost:1234/proxy/backend-api", UNRELATED_SECRET: "must-not-pass" };
  const env = Object.fromEntries(Object.entries(parent).filter(([name]) => MODEL_CONTROL_ENV.includes(name)));
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({route:process.env.CODEX_HOME,endpoint:process.env.CODEX_CHATGPT_BASE_URL,secret:process.env.UNRELATED_SECRET}))"], { env, encoding: "utf8" });
  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(child.stdout), { route: parent.CODEX_HOME, endpoint: parent.CODEX_CHATGPT_BASE_URL });
});
