import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Remembers which STT models the dictation-cleanup auto-enable has already
 * evaluated, PERSISTED across app restarts and settings-window re-mounts.
 *
 * `useModelAssistanceAutoEnable` nudges dictation cleanup on once per model that
 * needs it. The guard used to be an in-memory `useRef`, which reset every time
 * the settings view mounted — so restarting the app (or just reopening
 * Settings) re-ran the nudge and silently flipped `dictation.enabled` back on,
 * overriding a user who had deliberately turned it off. Persisting the marker
 * makes "auto-suggest once per model, then respect the user's choice" hold for
 * real. See project memory: the PTT-default-divergence bug is the same shape.
 */
interface ModelAssistanceState {
	/** STT model ids the cleanup auto-enable has already run for. */
	autoAppliedModelIds: string[];
	hasAutoApplied: (modelId: string) => boolean;
	markAutoApplied: (modelId: string) => void;
	/** Clear all markers (test isolation only — there is no UI for this). */
	reset: () => void;
}

export const useModelAssistanceStore = create<ModelAssistanceState>()(
	persist(
		(set, get) => ({
			autoAppliedModelIds: [],
			hasAutoApplied: (modelId) =>
				get().autoAppliedModelIds.includes(modelId),
			markAutoApplied: (modelId) =>
				set((state) =>
					state.autoAppliedModelIds.includes(modelId)
						? state
						: {
								autoAppliedModelIds: [
									...state.autoAppliedModelIds,
									modelId,
								],
							},
				),
			reset: () => set({ autoAppliedModelIds: [] }),
		}),
		{ name: "winstt-model-assistance" },
	),
);
