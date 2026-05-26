/**
 * Renderer-side cache of the SQLite history rows for the `/history` view.
 *
 * The view reads pages on mount + on scroll-to-end; this store dedups by `id`
 * and exposes a single `entries` array sorted newest-first. Wire-up to the
 * main-process `history:row-added` / `history:row-deleted` /
 * `history:row-toggled` broadcasts lives in the view itself so the entity
 * stays IPC-free (FSD: entities only depend on `shared`).
 */

import { create } from "zustand";
import type { HistoryEntry } from "./types";

interface HistoryViewState {
	appendPage: (page: { entries: HistoryEntry[]; hasMore: boolean }) => void;
	clear: () => void;
	entries: HistoryEntry[];
	error: string | null;
	hasMore: boolean;
	insertRow: (entry: HistoryEntry) => void;
	loading: boolean;
	removeRow: (id: number) => void;
	replaceFirstPage: (page: { entries: HistoryEntry[]; hasMore: boolean }) => void;
	setError: (error: string | null) => void;
	setLoading: (loading: boolean) => void;
	toggleRow: (id: number, saved: boolean) => void;
}

export const useHistoryViewStore = create<HistoryViewState>()((set) => ({
	entries: [],
	hasMore: false,
	loading: false,
	error: null,
	appendPage: ({ entries, hasMore }) =>
		set((state) => {
			const seen = new Set(state.entries.map((e) => e.id));
			const fresh = entries.filter((e) => !seen.has(e.id));
			return { entries: [...state.entries, ...fresh], hasMore };
		}),
	replaceFirstPage: ({ entries, hasMore }) =>
		set({ entries, hasMore, loading: false, error: null }),
	insertRow: (entry) =>
		set((state) => {
			if (state.entries.some((e) => e.id === entry.id)) {
				return state;
			}
			return { entries: [entry, ...state.entries] };
		}),
	removeRow: (id) =>
		set((state) => {
			const next = state.entries.filter((e) => e.id !== id);
			if (next.length === state.entries.length) {
				return state;
			}
			return { entries: next };
		}),
	toggleRow: (id, saved) =>
		set((state) => ({
			entries: state.entries.map((e) => (e.id === id ? { ...e, saved } : e)),
		})),
	clear: () => set({ entries: [], hasMore: false }),
	setLoading: (loading) => set({ loading }),
	setError: (error) => set({ error }),
}));
