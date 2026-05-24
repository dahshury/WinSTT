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
 * Fires on a fresh ``runtime_info`` push from the server **and** on
 * ``settings.model`` changes — the latter so that an async
 * ``settingsLoad()`` in ``useSyncSettings`` (which replaces the whole
 * settings object from electron-store after the renderer mounts) can't
 * silently revert a reconciliation that already happened. Without
 * ``settingsModel`` in deps, the race is: runtime_info arrives → we write
 * "tiny" → settingsLoad resolves later → setSettings overwrites with the
 * stored "nemo-canary-1b-v2" → nothing in our deps changed → picker stays
 * on canary even though the server is running tiny.
 *
 * Regression guard: when the user picks a new model in the picker, the
 * picker first writes ``settings.model`` and then ``beginSwap`` sets
 * ``activeMain``. Both are synchronous, so by the time this effect
 * runs both stores have already committed and the ``activeMain !== null``
 * check below short-circuits — preventing the revert-to-lagging-runtime
 * regression that earlier versions of this hook hit. ``activeMain`` is
 * intentionally read via ``getState()`` (not subscribed) so its
 * ``true → false`` transition on ``model_swap_completed`` does NOT
 * re-fire the effect against still-stale ``runtimeModel``.
 */
export function useSyncActiveModel(): void {
	const serverStatus = useConnectionStore((s) => s.serverStatus);
	const runtimeModel = useConnectionStore((s) => s.runtimeInfo?.model ?? null);
	const isLoaded = useSettingsStore((s) => s.isLoaded);
	const settingsModel = useSettingsStore((s) => s.settings.model?.model ?? null);
	const updateModelSettings = useSettingsStore((s) => s.updateModelSettings);

	useEffect(() => {
		if (!isLoaded || serverStatus !== "running" || !runtimeModel) {
			return;
		}
		if (useModelSwapStore.getState().activeMain !== null) {
			return;
		}
		if (runtimeModel === settingsModel) {
			return;
		}
		updateModelSettings({ model: runtimeModel });
	}, [isLoaded, serverStatus, runtimeModel, settingsModel, updateModelSettings]);
}
