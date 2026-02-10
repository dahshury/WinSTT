import type { components } from "@spec/schema";
import { create } from "zustand";

type TranscriptionItem = components["schemas"]["TranscriptionItem"];

interface TranscriptionState {
	items: TranscriptionItem[];
	currentRealtime: string;
	addFinalSentence: (text: string) => void;
	setRealtimeText: (text: string) => void;
	clearAll: () => void;
}

export const useTranscriptionStore = create<TranscriptionState>((set) => ({
	items: [],
	currentRealtime: "",
	addFinalSentence: (text) => {
		const id = crypto.randomUUID();
		const timestamp = Date.now();
		set((state) => ({
			items: [...state.items, { id, type: "final", text, timestamp }],
			currentRealtime: "",
		}));
	},
	setRealtimeText: (text) => set({ currentRealtime: text }),
	clearAll: () => set({ items: [], currentRealtime: "" }),
}));
