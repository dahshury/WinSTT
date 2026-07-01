import { create } from "zustand";

interface LlmProcessingState {
	appendThinking: (chunk: string) => void;
	clearThinking: () => void;
	isThinking: boolean;
	isTransforming: boolean;
	setThinking: (value: boolean) => void;
	setTransforming: (value: boolean) => void;
	/**
	 * Wall-clock timestamp at which the current selected-text transform started
	 * (`null` when not active). Kept separate from dictation thinking so the
	 * overlay can show a transform-only pill without arming an STT session.
	 */
	transformStartedAt: number | null;
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
 * monotonic across duplicate START events. */
export function nextThinkingStart(
	currentStart: number | null,
	now: number = Date.now(),
): { isThinking: true; thinkingStartedAt: number } {
	return {
		isThinking: true,
		thinkingStartedAt: currentStart ?? now,
	};
}

/** Patch for `setThinking(false)`: clear both flags. */
export function thinkingStopPatch(): {
	isThinking: false;
	thinkingStartedAt: null;
} {
	return { isThinking: false, thinkingStartedAt: null };
}

/** Pick the right patch for a `setThinking(value)` call. */
export function thinkingPatch(
	value: boolean,
	currentStart: number | null,
): { isThinking: boolean; thinkingStartedAt: number | null } {
	return value ? nextThinkingStart(currentStart) : thinkingStopPatch();
}

/** Patch for `setTransforming(true)`: duplicate START events keep one timer. */
export function nextTransformStart(
	currentStart: number | null,
	now: number = Date.now(),
): { isTransforming: true; transformStartedAt: number } {
	return {
		isTransforming: true,
		transformStartedAt: currentStart ?? now,
	};
}

/** Patch for `setTransforming(false)`: clear transform-only processing state. */
export function transformStopPatch(): {
	isTransforming: false;
	transformStartedAt: null;
} {
	return { isTransforming: false, transformStartedAt: null };
}

/** Pick the right patch for a `setTransforming(value)` call. */
export function transformPatch(
	value: boolean,
	currentStart: number | null,
): { isTransforming: boolean; transformStartedAt: number | null } {
	return value ? nextTransformStart(currentStart) : transformStopPatch();
}

/** Patch for `appendThinking(chunk)`: empty chunks are no-ops. */
export function appendThinkingPatch(
	currentText: string,
	chunk: string,
): { thinkingText: string } | null {
	return chunk ? { thinkingText: currentText + chunk } : null;
}

export const useLlmProcessingStore = create<LlmProcessingState>()((set) => ({
	isThinking: false,
	isTransforming: false,
	thinkingStartedAt: null,
	thinkingText: "",
	transformStartedAt: null,
	setThinking: (value) =>
		set((state) => thinkingPatch(value, state.thinkingStartedAt)),
	setTransforming: (value) =>
		set((state) => transformPatch(value, state.transformStartedAt)),
	appendThinking: (chunk) =>
		set((state) => appendThinkingPatch(state.thinkingText, chunk) ?? state),
	clearThinking: () => set({ thinkingText: "" }),
}));
