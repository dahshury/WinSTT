import { create } from "zustand";

interface LlmProcessingState {
	appendThinking: (chunk: string) => void;
	clearThinking: () => void;
	isThinking: boolean;
	setThinking: (value: boolean) => void;
	/**
	 * Wall-clock timestamp at which the current LLM processing pass started
	 * (`null` when not active). The pill reads this to render a live
	 * "thinking duration" counter so long reasoning runs feel deliberate
	 * instead of stuck. Driven by `LLM_PROCESSING_START` / `_END` events.
	 */
	thinkingStartedAt: number | null;
	/**
	 * Accumulated `message.thinking` text streamed from the model during a
	 * single LLM call. Empty for non-reasoning models — the pill falls back
	 * to its rotating-words label in that case. Cleared on every new
	 * recording cycle and again when the LLM call ends.
	 */
	thinkingText: string;
}

/** Patch for `setThinking(true)`: preserve an existing start so the timer is
 * monotonic across duplicate START events (CC 1). */
export function nextThinkingStart(
	currentStart: number | null,
	now: number = Date.now()
): { isThinking: true; thinkingStartedAt: number } {
	return {
		isThinking: true,
		thinkingStartedAt: currentStart ?? now,
	};
}

/** Patch for `setThinking(false)`: clear both flags (CC 1). */
export function thinkingStopPatch(): { isThinking: false; thinkingStartedAt: null } {
	return { isThinking: false, thinkingStartedAt: null };
}

/** Pick the right patch for a `setThinking(value)` call (CC 1). */
export function thinkingPatch(
	value: boolean,
	currentStart: number | null
): { isThinking: boolean; thinkingStartedAt: number | null } {
	return value ? nextThinkingStart(currentStart) : thinkingStopPatch();
}

/** Patch for `appendThinking(chunk)`: empty chunks are no-ops (CC 1). */
export function appendThinkingPatch(
	currentText: string,
	chunk: string
): { thinkingText: string } | null {
	return chunk ? { thinkingText: currentText + chunk } : null;
}

export const useLlmProcessingStore = create<LlmProcessingState>()((set) => ({
	isThinking: false,
	thinkingStartedAt: null,
	thinkingText: "",
	setThinking: (value) => set((state) => thinkingPatch(value, state.thinkingStartedAt)),
	appendThinking: (chunk) =>
		set((state) => appendThinkingPatch(state.thinkingText, chunk) ?? state),
	clearThinking: () => set({ thinkingText: "" }),
}));
