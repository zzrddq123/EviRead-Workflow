import { resolve } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
} from "./codex_runtime.js";
import { Type } from "typebox";

import { PROJECT_ROOT } from "./config.js";
let answer: string | undefined;
const tool = defineTool({
  name: "submit_smoke",
  label: "Submit Codex smoke result",
  description: "Submit the exact smoke-test result.",
  parameters: Type.Object({ answer: Type.String() }, { additionalProperties: false }),
  async execute(_id, params) {
    answer = params.answer;
    return { content: [{ type: "text" as const, text: "Smoke result captured." }], details: params, terminate: true };
  },
});
const loader = new DefaultResourceLoader({
  cwd: PROJECT_ROOT,
  agentDir: getAgentDir(),
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  systemPromptOverride: () => "You are a Codex connectivity test. Always finish with submit_smoke.",
  appendSystemPromptOverride: () => [],
});
await loader.reload();
const { session } = await createAgentSession({
  cwd: PROJECT_ROOT,
  resourceLoader: loader,
  tools: ["submit_smoke"],
  customTools: [tool],
  thinkingLevel: "high",
  sessionManager: SessionManager.inMemory(PROJECT_ROOT),
});
const timeout = setTimeout(() => { void session.abort(); }, 90_000);
try {
  await session.prompt("Call submit_smoke with answer exactly CODEX_RUNTIME_OK.");
  const last = session.state.messages.at(-1) as unknown as { stopReason?: string; errorMessage?: string } | undefined;
  if (last?.stopReason === "error") throw new Error(last.errorMessage ?? "provider error");
  if (answer !== "CODEX_RUNTIME_OK") throw new Error(`Unexpected smoke result: ${String(answer)}`);
  console.log(JSON.stringify({ ok: true, answer, model: `${session.model?.provider}/${session.model?.id}` }));
} finally {
  clearTimeout(timeout);
  session.dispose();
}
