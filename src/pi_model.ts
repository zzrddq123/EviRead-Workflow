import { ModelRuntime } from "./codex_runtime.js";

/** Compatibility names retained for existing callers; execution uses Codex CLI. */
export function registerManagedPiProvider(modelRuntime: ModelRuntime): void {
  // Execution is exclusively handled by codex_runtime.ts; no Pi transport is registered.
  void modelRuntime;
}

export async function registerManagedPiProviderFromCodexAuth(modelRuntime: ModelRuntime): Promise<void> {
  // Codex CLI owns authentication; no Pi sidecar or credential conversion.
  registerManagedPiProvider(modelRuntime);
}

export const DEFAULT_PI_PROVIDER = "openai-codex" as const;
export const DEFAULT_PI_MODEL = "gpt-5.6-sol" as const;

export async function resolveDefaultPiModel() {
  return { modelRuntime: {} as ModelRuntime, model: { provider: DEFAULT_PI_PROVIDER, id: DEFAULT_PI_MODEL } as any };
}
