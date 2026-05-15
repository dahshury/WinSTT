import { create } from "zustand";
import type { TranscriptionHistoryEntry } from "@/shared/api/ipc-client";

export type { TranscriptionHistoryEntry };

interface HistoryState {
	addEntry: (entry: TranscriptionHistoryEntry) => void;
	clear: () => void;
	entries: TranscriptionHistoryEntry[];
	isLoaded: boolean;
	setAll: (entries: TranscriptionHistoryEntry[]) => void;
}

export const useTranscriptionHistoryStore = create<HistoryState>()((set) => ({
	entries: [],
	isLoaded: false,
	setAll: (entries) => set({ entries, isLoaded: true }),
	addEntry: (entry) =>
		set((state) => {
			if (state.entries.some((e) => e.id === entry.id)) {
				return state;
			}
			return { entries: [...state.entries, entry] };
		}),
	clear: () => set({ entries: [] }),
}));
