import { create } from "zustand";
import type {
	TransformHistoryEntry,
	TranscriptionHistoryEntry,
} from "@/shared/api/ipc-client";

export type { TransformHistoryEntry, TranscriptionHistoryEntry };

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
	clear: () => void;
	clearTransforms: () => void;
	entries: TranscriptionHistoryEntry[];
	isLoaded: boolean;
	removeEntry: (id: string) => void;
	removeTransformEntry: (id: string) => void;
	setAll: (entries: TranscriptionHistoryEntry[]) => void;
	setTransformAll: (entries: TransformHistoryEntry[]) => void;
	transformEntries: TransformHistoryEntry[];
	transformsLoaded: boolean;
}

export const useTranscriptionHistoryStore = create<HistoryState>()((set) => ({
	entries: [],
	isLoaded: false,
	transformEntries: [],
	transformsLoaded: false,
	setAll: (entries) => set({ entries, isLoaded: true }),
	setTransformAll: (transformEntries) =>
		set({ transformEntries, transformsLoaded: true }),
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
	clear: () => set({ entries: [] }),
	clearTransforms: () => set({ transformEntries: [] }),
}));
