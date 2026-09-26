/** Codex CLI execution bridge pinned to GPT-5.6-sol; tools remain Host-owned. */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import type { createAgentSession as PiSessionFactory } from "@earendil-works/pi-coding-agent";
export { DefaultResourceLoader, defineTool, getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

export const CODEX_MODEL = "gpt-5.6-sol";
export interface CodexRuntimeOptions {
  /** Root directory for native Codex tools. Defaults to the response scratch directory. */
  cwd?: string;
  /** Permit Codex native shell/workspace tools inside cwd. */
  allowNativeTools?: boolean;
  /** Permit a bounded Codex helper-agent call inside the same sandbox. */
  allowMultiAgent?: boolean;
}

export async function runCodexJson(
  prompt: string,
  schema: object,
  signal?: AbortSignal,
  modelId = CODEX_MODEL,
  runtimeOptions: CodexRuntimeOptions = {},
) {
  const scratch = await mkdtemp(join(tmpdir(), "eviread-codex-"));
  try {
    const schemaPath = join(scratch, "response.schema.json");
    await writeFile(schemaPath, JSON.stringify(schema));
    const outputPath = join(scratch, "response.json");
    const stdout = await new Promise<string>((resolve, reject) => {
      const codexEnv = {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        LANG: process.env.LANG ?? "C.UTF-8",
        CODEX_HOME: process.env.CODEX_HOME,
        HTTP_PROXY: process.env.HTTP_PROXY,
        HTTPS_PROXY: process.env.HTTPS_PROXY,
        ALL_PROXY: process.env.ALL_PROXY,
        NO_PROXY: process.env.NO_PROXY,
        CHATGPT_BASE_URL: process.env.CHATGPT_BASE_URL,
        OPENAI_CHATGPT_BASE_URL: process.env.OPENAI_CHATGPT_BASE_URL,
        CODEX_CHATGPT_BASE_URL: process.env.CODEX_CHATGPT_BASE_URL,
        CODEX_OPENAI_BASE_URL: process.env.CODEX_OPENAI_BASE_URL,
        CODEX_REFRESH_TOKEN_URL_OVERRIDE: process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE,
      };
      // The RSI worker prepends its isolated node_modules bins to PATH.  Those
      // bins can contain a raw Codex binary which bypasses this machine's
      // authenticated local proxy.  Prefer the configured local launcher so
      // workers and interactive runs use the same authenticated transport.
      const localLauncher = process.env.EVIREAD_CODEX_LAUNCHER ?? join(homedir(), ".local", "bin", "codex");
      const executable = existsSync(localLauncher) ? localLauncher
        : (process.env.PATH ?? "").split(":").map(dir => join(dir, "codex")).find(path => existsSync(path))
          ?? localLauncher;
      const nativeTools = runtimeOptions.allowNativeTools === true;
      const childCwd = runtimeOptions.cwd ?? scratch;
      const child = spawn(executable, ["exec", "--model", modelId,
        "--skip-git-repo-check", "--ephemeral", "--sandbox", nativeTools ? "workspace-write" : "read-only",
        "--cd", childCwd, "--json", "--output-schema", schemaPath,
        "--output-last-message", outputPath,
        "-c", 'model_reasoning_effort="high"',
        "-c", 'web_search="disabled"',
        "-c", `features.shell_tool=${nativeTools ? "true" : "false"}`,
        "-c", `features.multi_agent=${runtimeOptions.allowMultiAgent === true ? "true" : "false"}`,
        "-c", "features.plugins=false", "-c", "features.hooks=false",
        "-c", "features.apps=false", "-c", "features.memories=false",
        "-c", "features.skill_search=false", "-c", "features.skip_host_skill_discovery=true",
        "-c", "features.browser_use=false", "-c", "features.computer_use=false",
        "-c", "features.image_generation=false", "-c", "features.code_mode=false",
        "-c", "check_for_update_on_startup=false",
        "-c", "project_doc_max_bytes=0", "-"],
        // Keep the agent in the worker's process group so the stage watchdog
        // can terminate the complete tree on a real hang.
        { cwd: scratch, stdio: ["pipe", "pipe", "pipe"], detached: false, env: codexEnv });
      let out = "", err = "";
      let stopped: Error | undefined;
      const stop = (error: Error) => {
        stopped = error;
        try {
          child.kill("SIGKILL");
        } catch (killError: any) { if (killError.code !== "ESRCH") reject(killError); }
      };
      const abort = () => stop(new Error("Codex request aborted"));
      // The recovery timeout only covers a Codex process that never starts.
      // Once the child has emitted `spawn`, the agent is considered active and
      // may take as long as needed to finish its task.  In particular, do not
      // kill a healthy long-running reasoning/tool loop after eight minutes.
      const startupTimeoutMs = Number(process.env.EVIREAD_CODEX_STARTUP_TIMEOUT_MS
        ?? process.env.EVIREAD_CODEX_TIMEOUT_MS ?? 480_000);
      let startupTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        stop(new Error("Codex startup timed out"));
      }, Number.isFinite(startupTimeoutMs) && startupTimeoutMs > 0 ? startupTimeoutMs : 480_000);
      child.once("spawn", () => {
        if (startupTimer !== undefined) clearTimeout(startupTimer);
        startupTimer = undefined;
      });
      async function processTreeCpuTicks(rootPid: number): Promise<number> {
        const seen = new Set<number>();
        const visit = async (pid: number): Promise<number> => {
          if (seen.has(pid)) return 0;
          seen.add(pid);
          let ticks = 0;
          try {
            const stat = await readFile(`/proc/${pid}/stat`, "utf8");
            const close = stat.lastIndexOf(")");
            const fields = stat.slice(close + 2).trim().split(/\s+/);
            ticks += Number(fields[11] ?? 0) + Number(fields[12] ?? 0);
            const children = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
            for (const childPid of children.trim().split(/\s+/).filter(Boolean)) ticks += await visit(Number(childPid));
          } catch { /* process exited between /proc reads */ }
          return ticks;
        };
        return visit(rootPid);
      }
      let lastProgressAt = Date.now();
      let lastCpuTicks = -1;
      let lastOutputLength = 0;
      const stallTimeoutMs = Number(process.env.EVIREAD_CODEX_STALL_TIMEOUT_MS ?? 900_000);
      const stallTimer = setInterval(() => {
        void (async () => {
          if (!child.pid || process.platform === "win32") return;
          try {
            const cpuTicks = await processTreeCpuTicks(child.pid);
            const outputLength = out.length + err.length;
            if (cpuTicks !== lastCpuTicks || outputLength !== lastOutputLength) {
              lastCpuTicks = cpuTicks;
              lastOutputLength = outputLength;
              lastProgressAt = Date.now();
            } else if (Number.isFinite(stallTimeoutMs) && stallTimeoutMs > 0 && Date.now() - lastProgressAt >= stallTimeoutMs) {
              stop(new Error("Codex stalled without CPU or output progress"));
            }
          } catch { /* process exited or /proc unavailable */ }
        })();
      }, 30_000);
      stallTimer.unref();
      const cleanup = () => {
        if (startupTimer !== undefined) clearTimeout(startupTimer);
        clearInterval(stallTimer);
        signal?.removeEventListener("abort", abort);
      };
      child.stdout.on("data", chunk => { out += String(chunk); });
      child.stderr.on("data", chunk => { err = (err + String(chunk)).slice(-4000); });
      child.on("error", error => { cleanup(); reject(error); });
      child.on("close", code => {
        cleanup();
        if (stopped) reject(new Error(`${stopped.message}: ${err}`));
        else if (code === 0) resolve(out);
        else reject(new Error(`Codex exited ${code}: ${err}`));
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdin.on("error", () => {});
      child.stdin.end(`Use only the supplied data. Do not use shell, files, web, MCP, skills, collaboration, subagents, or any other built-in/native tools. Never emit a collaboration or subagent tool call. Return the requested JSON.\n${prompt}`);
    });
    const events = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
    if (events.some(e => e.type === "turn.failed" || e.type === "error")) {
      throw new Error("Codex failed before completing the structured response");
    }
    // CLI item.error can be a non-fatal warning; require turn.completed and a valid
    // response below. Actual tool events remain forbidden.
    if (!runtimeOptions.allowNativeTools && events.some(e => e.item && !["agent_message", "reasoning", "error"].includes(e.item.type))) {
      throw new Error(`Codex attempted a non-Host tool action: ${events.filter(e => e.item && !["agent_message", "reasoning", "error"].includes(e.item.type)).map(e => e.item.type).join(", ")}`);
    }
    if (!events.some(e => e.type === "turn.completed")) throw new Error("Codex returned no completed turn");
    const value = JSON.parse(await readFile(outputPath, "utf8"));
    if (!Check(schema as any, value)) throw new Error("Codex returned a response outside the requested schema");
    const usage = events.filter(e => e.type === "turn.completed").at(-1)?.usage ?? {};
    return { value: value as Record<string, any>, usage: { input: Number(usage.input_tokens ?? 0), output: Number(usage.output_tokens ?? 0), totalTokens: Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0) } };

  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Preserve host-owned tool dispatch, allowlists, validation and termination. */
export const createAgentSession: typeof PiSessionFactory = async (options: any = {}) => {
  const tools = (options.customTools ?? []).filter((t: any) => !options.tools || options.tools.includes(t.name));
  const messages: any[] = [];
  const controller = new AbortController();
  const totals = { input: 0, output: 0, total: 0, toolCalls: 0 };
  const system = options.resourceLoader?.getSystemPrompt() ?? "";
  const session: any = {
    model: { provider: "openai-codex", id: typeof options.model?.id === "string" ? options.model.id : CODEX_MODEL }, thinkingLevel: "high", sessionFile: undefined,
    state: { messages }, agent: { state: { messages } },
    subscribe: () => () => {}, abort: async () => controller.abort(), dispose: () => controller.abort(),
    getSessionStats: () => ({ userMessages: messages.filter(x => x.role === "user").length,
      assistantMessages: messages.filter(x => x.role === "assistant").length, toolCalls: totals.toolCalls,
      tokens: { input: totals.input, output: totals.output, total: totals.total, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
    prompt: async (prompt: string) => {
      messages.push({ role: "user", content: prompt });
      for (let turn = 0; turn < 64; turn++) {
        const schema = {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["tool", "final"] },
            tool: { type: "string", enum: tools.map((t: any) => t.name) },
            argumentsJson: { type: "string" },
            summary: { type: "string" },
          },
          required: ["kind", "tool", "argumentsJson", "summary"],
          additionalProperties: false,
        };
        const nativeTools = options.allowNativeTools === true;
        const nativeInstruction = nativeTools
          ? "Native Codex tools are allowed only within the current campaign worktree. Do not access or modify the main repository, another worktree, evaluator-private data, Git refs, tags, or unrelated paths. Helper agents, if used, must obey the same worktree boundary and may not delegate further."
          : "Never call built-in/native tools or collaboration/subagent tools.";
        const result = await runCodexJson(`${system}\nReturn either {kind:"tool", tool, argumentsJson} to invoke an allowlisted Host tool, or {kind:"final", summary} when the task is complete. argumentsJson must be a JSON-encoded object matching that tool's schema. ${nativeInstruction}\nTOOLS:\n${JSON.stringify(tools.map((t: any) => ({ name: t.name, description: t.description, parameters: t.parameters })))}\nCONVERSATION:\n${JSON.stringify(messages)}`, schema, controller.signal, typeof options.model?.id === "string" ? options.model.id : CODEX_MODEL, { cwd: typeof options.cwd === "string" ? options.cwd : undefined, allowNativeTools: nativeTools, allowMultiAgent: options.allowMultiAgent === true });
        totals.input += result.usage.input; totals.output += result.usage.output; totals.total += result.usage.totalTokens;
        if (result.value.kind === "final") {
          if (typeof result.value.summary !== "string" || result.value.summary.length > 4000) throw new Error("Codex final response is missing a bounded summary");
          messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: result.value.summary }], usage: result.usage });
          return;
        }
        if (result.value.kind !== "tool" || typeof result.value.tool !== "string" || typeof result.value.argumentsJson !== "string") {
          throw new Error("Codex tool response must include kind=tool, tool, and argumentsJson");
        }
        const tool = tools.find((t: any) => t.name === result.value.tool);
        if (!tool) throw new Error("Codex selected a non-allowlisted host tool");
        // Tool validation and execution failures are recoverable development
        // feedback.  Return them to the same Codex conversation so it can
        // reread the file, correct its JSON, or choose a unique replacement
        // block.  Previously these exceptions escaped the session and forced
        // the stage watchdog to restart the entire Codex session.
        let args: any;
        let toolError: string | undefined;
        try {
          args = JSON.parse(result.value.argumentsJson);
          if (!Check(tool.parameters, args)) throw new Error(`Codex returned invalid arguments for ${tool.name}`);
        } catch (error) {
          toolError = error instanceof Error ? error.message : String(error);
        }
        const toolCallArguments = args ?? { argumentsJson: result.value.argumentsJson };
        messages.push({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: tool.name, arguments: toolCallArguments }], usage: result.usage });
        if (toolError) {
          messages.push({ role: "toolResult", toolName: tool.name, content: [{ type: "text", text: `Host tool rejected this request: ${toolError}. Re-read the relevant file or directory and retry with arguments matching the tool schema. This is recoverable; continue the same task.` }] });
          continue;
        }
        totals.toolCalls += 1;
        try {
          const response = await tool.execute(`codex-${totals.toolCalls}`, args, controller.signal);
          messages.push({ role: "toolResult", toolName: tool.name, content: response.content });
          if (response.terminate || tool.name.startsWith("submit_")) return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          messages.push({ role: "toolResult", toolName: tool.name, content: [{ type: "text", text: `Host tool execution failed: ${message}. Re-read the current state and retry or choose a safer edit. This is recoverable; do not abandon the task.` }] });
        }
      }
      throw new Error("Codex exceeded bounded host tool turns");
    },
  };
  return { session } as any;
};
