"use client";

import { useEffect } from "react";
import { useConnectionStore } from "@/entities/connection";
import { useModelSwapStore } from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";

/**
 * Reconcile the locally-persisted ``settings.model.model`` with the server's
 * actually-loaded model name.
 *
 * On startup, the server may fall back to a different model than the one
 * persisted in the renderer's settings (e.g. the user's chosen model is
 * corrupted on disk and can't be refetched). The server signals this via:
 *
 *   1. ``runtime_info.model`` on ``server_ready`` — the truth about what's
 *      actually loaded.
 *   2. ``model_swap_failed`` — fires the existing :file:`SwapFailureToast`
 *      so the user sees a clear "swap failed" notification.
 *
 * This hook drives the first half: when the server's runtime snapshot
 * disagrees with our local setting, push the server's choice into settings.
 * That:
 *
 *   - flips the picker to the actually-active model so the user isn't
 *     looking at a lie,
 *   - persists the fallback to electron-store so the next launch starts
 *     where this one ended up (matching the server-side persist),
 *   - keeps the in-window UI in sync between restarts.
 *
 * **Triggers only on a fresh ``runtime_info`` push from the server** —
 * crucially NOT on local ``settings.model`` changes. If the user picks a
 * new model in the picker, that changes ``settings.model`` first and the
 * stored ``runtime_info`` lags until the swap completes (server-pushed via
 * the renderer-side ``model_swap_completed`` → fetchRuntimeInfo refresh).
 * Re-running the reconciler on local settings change would revert the
 * user's brand-new selection back to the lagging ``runtime_info.model`` —
 * exactly the regression we hit when the deps array first included
 * ``settingsModel``. Reading settings via ref keeps the comparison live
 * without making it a re-fire trigger.
 */
export function useSyncActiveModel(): void {
	const serverStatus = useConnectionStore((s) => s.serverStatus);
	const runtimeModel = useConnectionStore((s) => s.runtimeInfo?.model ?? null);
	const isLoaded = useSettingsStore((s) => s.isLoaded);
	const updateModelSettings = useSettingsStore((s) => s.updateModelSettings);

	useEffect(() => {
		if (!isLoaded || serverStatus !== "running" || !runtimeModel) {
			return;
		}
		// Defensive: skip while a main-model swap is mid-flight. The server's
		// runtime_info push lands AFTER swap_completed, so during the window
		// between ``swap_started`` and that push, ``runtimeModel`` lags. The
		// store is read via ``getState()`` (not a hook subscription) on
		// purpose: subscribing would put ``mainSwapping`` in the dep array,
		// and a transition from ``true`` → ``false`` would re-fire the effect
		// against the still-stale ``runtimeModel`` and revert the user's
		// pick. The effect must fire ONLY when ``runtimeModel`` itself
		// changes — that's when we know we have a fresh server snapshot.
		if (useModelSwapStore.getState().activeMain !== null) {
			return;
		}
		const settingsModel = useSettingsStore.getState().settings.model?.model;
		if (runtimeModel === settingsModel) {
			return;
		}
		updateModelSettings({ model: runtimeModel });
	}, [isLoaded, serverStatus, runtimeModel, updateModelSettings]);
}
