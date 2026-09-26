import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCodexJson } from "./codex_runtime.js";

// Exercise the process boundary without credentials or model requests.
test("Codex transport enforces schema, completion and native-tool rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-transport-test-"));
  const oldPath = process.env.PATH;
  const oldLauncher = process.env.EVIREAD_CODEX_LAUNCHER;
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
  async function stub(value: unknown, events: unknown[]) {
    await writeFile(join(root, "codex"), `#!${process.execPath}\nconst fs=require('node:fs'); const a=process.argv.slice(2);\nif(a[0]!=='exec'||a[a.indexOf('--model')+1]!=='gpt-5.6-sol'||!a.includes('--output-schema')||!a.includes('model_reasoning_effort="high"')) process.exit(23);\nJSON.parse(fs.readFileSync(a[a.indexOf('--output-schema')+1],'utf8'));\nprocess.stdin.resume(); process.stdin.on('end',()=>{fs.writeFileSync(a[a.indexOf('--output-last-message')+1],${JSON.stringify(JSON.stringify(value))}); for(const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));});\n`);
    await chmod(join(root, "codex"), 0o700);
  }
  const completed = { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } };
  try {
    process.env.PATH = `${root}:${oldPath}`;
    process.env.EVIREAD_CODEX_LAUNCHER = join(root, "codex");
    await stub({ ok: true }, [{ type: "item.completed", item: { type: "error", message: "non-fatal CLI warning" } }, completed]);
    assert.deepEqual(await runCodexJson("test", schema), { value: { ok: true }, usage: { input: 12, output: 3, totalTokens: 15 } });
    await stub({ ok: "wrong" }, [completed]);
    await assert.rejects(runCodexJson("test", schema), /outside the requested schema/);
    await stub({ ok: true }, [{ type: "turn.failed" }]);
    await assert.rejects(runCodexJson("test", schema), /failed before completing/);
    await stub({ ok: true }, []);
    await assert.rejects(runCodexJson("test", schema), /no completed turn/);
    await stub({ ok: true }, [{ type: "item.completed", item: { type: "command_execution" } }, completed]);
    await assert.rejects(runCodexJson("test", schema), /non-Host tool/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runCodexJson("test", schema, controller.signal), /abort/i);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldLauncher === undefined) delete process.env.EVIREAD_CODEX_LAUNCHER; else process.env.EVIREAD_CODEX_LAUNCHER = oldLauncher;
    await rm(root, { recursive: true, force: true });
  }
});
