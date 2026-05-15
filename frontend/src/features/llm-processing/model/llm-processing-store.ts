import { create } from "zustand";

interface LlmProcessingState {
	isThinking: boolean;
	setThinking: (value: boolean) => void;
}

export const useLlmProcessingStore = create<LlmProcessingState>()((set) => ({
	isThinking: false,
	setThinking: (value) => set({ isThinking: value }),
}));
