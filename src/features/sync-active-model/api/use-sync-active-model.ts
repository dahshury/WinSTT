import { useEffect } from "react";
import { useConnectionStore } from "@/entities/connection";
import {
	type ModelInfo,
	useCatalogStore,
	useModelSwapStore,
} from "@/entities/model-catalog";
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
 *   - persists the fallback to persisted store so the next launch starts
 *     where this one ended up (matching the server-side persist),
 *   - keeps the in-window UI in sync between restarts.
 *
 * Fires on a fresh ``runtime_info`` push from the server **and** on
 * ``settings.model`` changes — the latter so that an async
 * ``settingsLoad()`` in ``useSyncSettings`` (which replaces the whole
 * settings object from persisted store after the renderer mounts) can't
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
/** True when the server is the authoritative reporter of model state. */
function serverIsAuthoritative(
	isLoaded: boolean,
	serverStatus: string,
	runtimeModel: string | null,
): runtimeModel is string {
	return isLoaded && serverStatus === "running" && runtimeModel !== null;
}

/** True when no main swap is in flight and runtime differs from settings. */
function reconciliationWouldChangeSettings(
	runtimeModel: string,
	settingsModel: string | null,
	activeMain: string | null,
): boolean {
	return activeMain === null && runtimeModel !== settingsModel;
}

/**
 * True only when the renderer should adopt the server's runtime-reported
 * model. Composed from two narrow predicates so each stays low-CC and the
 * rule is reusable in tests.
 *
 * Reads ``activeMain`` from the swap store via getState() rather than a
 * subscription so the cleared-on-completion transition does NOT re-fire
 * the effect against a still-stale ``runtimeModel`` push.
 */
function shouldAdoptRuntimeModel(
	isLoaded: boolean,
	serverStatus: string,
	runtimeModel: string | null,
	settingsModel: string | null,
	activeMain: string | null,
): runtimeModel is string {
	if (!serverIsAuthoritative(isLoaded, serverStatus, runtimeModel)) {
		return false;
	}
	return reconciliationWouldChangeSettings(
		runtimeModel,
		settingsModel,
		activeMain,
	);
}

/**
 * Build the ``ModelPatch`` that adopts a just-completed swap's model into
 * settings, or ``null`` when nothing should change.
 *
 * This is the fix for the "all surfaces stuck on the previous model after a
 * detached-picker swap" bug. The detached picker window commits the pick on
 * its OWN stores and closes the instant the swap starts — so its debounced
 * ``settings:changed`` broadcast is raced/lost and the other windows never
 * learn the new ``settings.model``. They DO receive the global
 * ``model-swap-completed`` event (``app.emit`` reaches every window) which
 * carries the authoritative loaded model ``name`` — but the runtime-info
 * reconciler below can't act on it: it reads ``activeMain`` via ``getState()``
 * (not a dependency) precisely so it never re-fires on the ``true → false``
 * clear transition, so the adoption that should flip the picker to the new
 * model never runs. Driving the adoption straight off the completion event
 * makes every window converge on the loaded model deterministically.
 *
 * - No-op when the slot already shows ``name`` (the initiating window).
 * - No-op for an empty ``name`` (e.g. a realtime clear — handled by the
 *   normal broadcast path; we never write a bare ``{ model }`` couple).
 * - Main picks resolve their paired ``backend`` from the catalog (cloud ids
 *   have no entry → the benign cloud backend); a genuinely-unknown local id
 *   yields ``null`` rather than an inconsistent ``{ model }``-without-backend.
 */
/**
 * The precision override to fold into a main-model adoption patch, or ``null``
 * when the carried quantization is already valid for the model being adopted.
 *
 * The persisted ``onnxQuantization`` belongs to the PREVIOUS main model. When a
 * different main model is adopted (post-swap completion, or a runtime fallback)
 * the catalog list for the NEW model may not offer that precision — e.g. a
 * ``fp16`` carried onto a model that only ships ``["", "int8"]``. Writing
 * ``{ model }`` without reconciling the quant persists an invalid
 * ``{ model, onnxQuantization }`` couple, which the backend's
 * ``validate_quantization`` (checked against ``model.model``) REJECTS — silently
 * dropping the WHOLE model-section save so the model change never reaches disk.
 * That is the "chosen main model reverts to the old one after restart" bug: the
 * detached picker resolves the quant in its own store, but the main window
 * adopts via the completion event and kept the stale precision.
 *
 * Returns ``""`` (the universal default — every catalog entry ships it and the
 * server re-resolves it per model) to reset an unavailable precision; ``null``
 * to leave the carried value untouched. The ``""``/``auto`` sentinels are always
 * valid, and an unknown/cloud id (no catalog entry / no precision list) can't be
 * proven invalid, so both keep the carried value.
 */
function reconcileAdoptedQuant(
	modelId: string,
	currentQuant: string,
	catalogModels: readonly ModelInfo[],
): "" | null {
	if (currentQuant === "" || currentQuant === "auto") {
		return null;
	}
	const entry = catalogModels.find((m) => m.id === modelId);
	if (!(entry && Array.isArray(entry.availableQuantizations))) {
		return null;
	}
	return entry.availableQuantizations.includes(currentQuant) ? null : "";
}

export function useSyncActiveModel(): void {
	const serverStatus = useConnectionStore((s) => s.serverStatus);
	const runtimeModel = useConnectionStore((s) => s.runtimeInfo?.model ?? null);
	const isLoaded = useSettingsStore((s) => s.isLoaded);
	const settingsModel = useSettingsStore(
		(s) => s.settings.model?.model ?? null,
	);
	const updateModelSettings = useSettingsStore((s) => s.updateModelSettings);

	useEffect(() => {
		const activeMain = useModelSwapStore.getState().activeMain;
		if (
			shouldAdoptRuntimeModel(
				isLoaded,
				serverStatus,
				runtimeModel,
				settingsModel,
				activeMain,
			)
		) {
			// Resolve the runtime model in the catalog so we can reconcile the
			// carried precision before adopting it.
			const catalogModels = useCatalogStore.getState().models;
			const catalogEntry = catalogModels.find((m) => m.id === runtimeModel);
			if (catalogEntry) {
				// Reconcile the carried precision the same way the completion-event
				// adoption does: a fallback model that doesn't offer the persisted
				// quant would otherwise persist an invalid pair that
				// `validate_quantization` rejects (dropping the whole save).
				const quantOverride = reconcileAdoptedQuant(
					runtimeModel,
					useSettingsStore.getState().settings.model?.onnxQuantization ?? "",
					catalogModels,
				);
				updateModelSettings({
					model: runtimeModel,
					...(quantOverride === null
						? {}
						: { onnxQuantization: quantOverride }),
				});
			}
			// If we can't resolve the runtime model in the catalog we deliberately
			// SKIP the adoption — the picker's fallback effect will pick a valid
			// model once the catalog refreshes.
		}
	}, [
		isLoaded,
		serverStatus,
		runtimeModel,
		settingsModel,
		updateModelSettings,
	]);
}
