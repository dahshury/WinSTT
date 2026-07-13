import type { LlmProvider } from "./types";

/** Pure resolver for the disable-unload spinner. Once armed (the user disabled
 *  the feature), stays true until the backend's `llm:unload-status` broadcast
 *  confirms the eviction batch containing the model finished. Re-enabling (or
 *  leaving the Ollama provider) settles it immediately: the warm tracker owns
 *  the enable side. Kept in a sibling module so FeatureBlock.tsx only exports
 *  React components/hooks (fast-refresh friendliness). */
export function resolveUnloadPending(
	pendingModel: string | null,
	provider: LlmProvider,
	enabled: boolean,
): boolean {
	return pendingModel !== null && provider === "ollama" && !enabled;
}
