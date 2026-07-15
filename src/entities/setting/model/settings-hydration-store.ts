import { create } from "zustand";

export type SettingsHydrationStatus =
	| "idle"
	| "loading"
	| "ready"
	| "unavailable"
	| "error";

/**
 * A non-fatal settings warning surfaced to the user (a toast renderer consumes
 * these). Distinct from the fatal `error` status:
 *   - `defaulted-sections`: a persisted section failed to parse and fell back to
 *     defaults on decode (audit #45) — the user's data for it couldn't be read.
 *   - `hotkey-rewrite`: colliding hotkeys were reset to defaults on load
 *     (audit #26).
 *   - `save-failed`: a backend settings save was rejected (audit #46); the
 *     change is kept dirty and retried.
 */
export type SettingsWarningKind =
	| "defaulted-sections"
	| "hotkey-rewrite"
	| "save-failed";

export interface SettingsWarning {
	detail?: string | null;
	id: number;
	kind: SettingsWarningKind;
}

interface SettingsHydrationState {
	/** Warnings the user hasn't dismissed yet (consumed by a toast renderer). */
	warnings: SettingsWarning[];
	dismissWarning: (id: number) => void;
	error: string | null;
	/**
	 * Monotonic counter bumped by the import path (or any full-tree broadcast
	 * that must win over in-flight writes). A pending debounced save captures
	 * the generation when it is armed; if the generation advanced by the time it
	 * fires, the save re-diffs against the freshly-imported state instead of
	 * persisting a snapshot captured before the import (audit #37).
	 */
	importGeneration: number;
	bumpImportGeneration: () => void;
	pushWarning: (kind: SettingsWarningKind, detail?: string | null) => void;
	reset: () => void;
	/**
	 * Bumped to request a re-hydration attempt after a transient load failure.
	 * `useSyncSettings` re-runs `settingsLoadStrict` whenever this changes, so a
	 * hydration `error` no longer permanently disables persistence + server sync
	 * for the window session (audit #39).
	 */
	retryToken: number;
	requestRetry: () => void;
	setStatus: (status: SettingsHydrationStatus, error?: string | null) => void;
	status: SettingsHydrationStatus;
}

let nextWarningId = 0;

export const useSettingsHydrationStore = create<SettingsHydrationState>(
	(set) => ({
		warnings: [],
		dismissWarning: (id) =>
			set((s) => ({ warnings: s.warnings.filter((w) => w.id !== id) })),
		error: null,
		importGeneration: 0,
		bumpImportGeneration: () =>
			set((s) => ({ importGeneration: s.importGeneration + 1 })),
		pushWarning: (kind, detail = null) =>
			set((s) => {
				// Collapse repeats of the same kind so a retry loop can't stack
				// identical toasts.
				const filtered = s.warnings.filter((w) => w.kind !== kind);
				nextWarningId += 1;
				return {
					warnings: [...filtered, { id: nextWarningId, kind, detail }],
				};
			}),
		reset: () =>
			set({
				error: null,
				importGeneration: 0,
				retryToken: 0,
				status: "idle",
				warnings: [],
			}),
		retryToken: 0,
		requestRetry: () => set((s) => ({ retryToken: s.retryToken + 1 })),
		setStatus: (status, error = null) => set({ error, status }),
		status: "idle",
	}),
);
