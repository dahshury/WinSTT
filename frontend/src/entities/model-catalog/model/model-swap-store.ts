"use client";

import { create } from "zustand";
import {
	type ModelSwapKind,
	onModelSwapCompleted,
	onModelSwapFailed,
	onModelSwapStarted,
} from "@/shared/api/ipc-client";

/**
 * Tracks in-flight `sttReloadModel` swaps per kind. The server emits
 * `model_swap_started` when it begins loading new weights and either
 * `model_swap_completed` or `model_swap_failed` when it's done — during
 * that window the WebSocket / control-plane briefly stalls, so the UI
 * needs to tell the user a switch is in progress rather than letting the
 * app look frozen.
 *
 * Consumed by:
 *   - `StatusBar` — flips the model chip into a spinner + "Switching to
 *     {name}..." label while `activeMain` is set.
 *   - `ModelSettingsPanel` — passes `isLoading` to the relevant
 *     `SttModelSelector` so the picker is disabled until the swap
 *     resolves.
 */
interface ModelSwapStore {
	activeMain: string | null;
	activeRealtime: string | null;
	clear: (kind: ModelSwapKind) => void;
	isSwapping: (kind: ModelSwapKind) => boolean;
	setActive: (kind: ModelSwapKind, name: string) => void;
}

export const useModelSwapStore = create<ModelSwapStore>()((set, get) => ({
	activeMain: null,
	activeRealtime: null,
	setActive: (kind, name) => set(kind === "main" ? { activeMain: name } : { activeRealtime: name }),
	clear: (kind) => set(kind === "main" ? { activeMain: null } : { activeRealtime: null }),
	isSwapping: (kind) =>
		kind === "main" ? get().activeMain !== null : get().activeRealtime !== null,
}));

/**
 * Subscribe to swap lifecycle pushes. Called once on module load in
 * Electron windows; exported so tests can wire it manually.
 */
export function initModelSwapStore(): () => void {
	const unsubStarted = onModelSwapStarted(({ kind, name }) => {
		useModelSwapStore.getState().setActive(kind, name);
	});
	const unsubCompleted = onModelSwapCompleted(({ kind }) => {
		useModelSwapStore.getState().clear(kind);
	});
	const unsubFailed = onModelSwapFailed(({ kind }) => {
		useModelSwapStore.getState().clear(kind);
	});
	return () => {
		unsubStarted();
		unsubCompleted();
		unsubFailed();
	};
}

if (typeof window !== "undefined" && window.electronAPI != null) {
	initModelSwapStore();
}
