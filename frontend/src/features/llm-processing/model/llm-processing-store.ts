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

export const useLlmProcessingStore = create<LlmProcessingState>()((set) => ({
	isThinking: false,
	thinkingStartedAt: null,
	thinkingText: "",
	setThinking: (value) =>
		set((state) => {
			if (value) {
				return {
					isThinking: true,
					// Don't reset on a no-op true→true; keep the original start
					// so the timer is monotonic even if start fires twice.
					thinkingStartedAt: state.thinkingStartedAt ?? Date.now(),
				};
			}
			return { isThinking: false, thinkingStartedAt: null };
		}),
	appendThinking: (chunk) =>
		set((state) => (chunk ? { thinkingText: state.thinkingText + chunk } : state)),
	clearThinking: () => set({ thinkingText: "" }),
}));
