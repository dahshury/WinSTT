import { create } from "zustand";
import type {
	TransformHistoryEntry,
	TranscriptionHistoryEntry,
	TtsHistoryEntry,
} from "@/shared/api/ipc-client";

export type {
	TransformHistoryEntry,
	TranscriptionHistoryEntry,
	TtsHistoryEntry,
};

interface HistoryRowWithId {
	id: string;
}

function appendUniqueById<TEntry extends HistoryRowWithId>(
	entries: TEntry[],
	entry: TEntry,
): TEntry[] {
	if (entries.some((e) => e.id === entry.id)) {
		return entries;
	}
	return [...entries, entry];
}

function removeById<TEntry extends HistoryRowWithId>(
	entries: TEntry[],
	id: string,
): TEntry[] {
	return entries.filter((e) => e.id !== id);
}

interface HistoryState {
	addEntry: (entry: TranscriptionHistoryEntry) => void;
	addTransformEntry: (entry: TransformHistoryEntry) => void;
	addTtsEntry: (entry: TtsHistoryEntry) => void;
	clear: () => void;
	clearTransforms: () => void;
	clearTts: () => void;
	entries: TranscriptionHistoryEntry[];
	isLoaded: boolean;
	removeEntry: (id: string) => void;
	removeTransformEntry: (id: string) => void;
	removeTtsEntry: (id: string) => void;
	setAll: (entries: TranscriptionHistoryEntry[]) => void;
	setTransformAll: (entries: TransformHistoryEntry[]) => void;
	setTtsAll: (entries: TtsHistoryEntry[]) => void;
	transformEntries: TransformHistoryEntry[];
	transformsLoaded: boolean;
	ttsEntries: TtsHistoryEntry[];
	ttsLoaded: boolean;
}

export const useTranscriptionHistoryStore = create<HistoryState>()((set) => ({
	entries: [],
	isLoaded: false,
	transformEntries: [],
	transformsLoaded: false,
	ttsEntries: [],
	ttsLoaded: false,
	setAll: (entries) => set({ entries, isLoaded: true }),
	setTransformAll: (transformEntries) =>
		set({ transformEntries, transformsLoaded: true }),
	setTtsAll: (ttsEntries) => set({ ttsEntries, ttsLoaded: true }),
	addEntry: (entry) =>
		set((state) => {
			const entries = appendUniqueById(state.entries, entry);
			if (entries === state.entries) {
				return state;
			}
			return { entries };
		}),
	addTransformEntry: (entry) =>
		set((state) => {
			const transformEntries = appendUniqueById(state.transformEntries, entry);
			if (transformEntries === state.transformEntries) {
				return state;
			}
			return { transformEntries };
		}),
	addTtsEntry: (entry) =>
		set((state) => {
			// Upsert: the backend re-emits the same row once the provider's
			// billed cost resolves (generation records can lag minutes), so a
			// repeated id replaces the earlier cost-less row in place.
			const index = state.ttsEntries.findIndex((e) => e.id === entry.id);
			if (index >= 0) {
				const ttsEntries = [...state.ttsEntries];
				ttsEntries[index] = entry;
				return { ttsEntries };
			}
			return { ttsEntries: [...state.ttsEntries, entry] };
		}),
	removeEntry: (id) =>
		set((state) => {
			const next = removeById(state.entries, id);
			if (next.length === state.entries.length) {
				return state;
			}
			return { entries: next };
		}),
	removeTransformEntry: (id) =>
		set((state) => {
			const next = removeById(state.transformEntries, id);
			if (next.length === state.transformEntries.length) {
				return state;
			}
			return { transformEntries: next };
		}),
	removeTtsEntry: (id) =>
		set((state) => {
			const next = removeById(state.ttsEntries, id);
			if (next.length === state.ttsEntries.length) {
				return state;
			}
			return { ttsEntries: next };
		}),
	clear: () => set({ entries: [] }),
	clearTransforms: () => set({ transformEntries: [] }),
	clearTts: () => set({ ttsEntries: [] }),
}));
