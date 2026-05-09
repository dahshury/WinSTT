import type { components } from "@spec/schema";
import { create } from "zustand";

type TranscriptionItem = components["schemas"]["TranscriptionItem"];

interface EphemeralMessage {
	text: string;
	timestamp: number;
}

interface TranscriptionState {
	addFinalSentence: (text: string) => void;
	clearAll: () => void;
	clearEphemeral: () => void;
	currentRealtime: string;
	ephemeral: EphemeralMessage | null;
	items: TranscriptionItem[];
	setRealtimeText: (text: string) => void;
	showEphemeral: (text: string) => void;
}

export const useTranscriptionStore = create<TranscriptionState>()((set) => ({
	items: [],
	currentRealtime: "",
	ephemeral: null,
	addFinalSentence: (text) => {
		const id = crypto.randomUUID();
		const timestamp = Date.now();
		set((state) => ({
			items: [...state.items, { id, type: "final", text, timestamp }],
			currentRealtime: "",
		}));
	},
	setRealtimeText: (text) => set({ currentRealtime: text }),
	showEphemeral: (text) => set({ ephemeral: { text, timestamp: Date.now() } }),
	clearEphemeral: () => set({ ephemeral: null }),
	clearAll: () => set({ items: [], currentRealtime: "", ephemeral: null }),
}));
