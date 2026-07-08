import { useEffect, useRef } from "react";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import {
	useTtsCatalogStore,
	useTtsModelStateStore,
} from "@/entities/tts-catalog";
import { useTtsModelPickerStore } from "@/features/tts-model-picker";
import type { TtsInstallPhase } from "@/shared/api/ipc-client";
import {
	resolveTtsEnabledModelPatch,
	type TtsEnabledReconcileInput,
} from "./use-tts-install-gate";

export interface TtsEnabledReconcilerInputs
	extends Omit<TtsEnabledReconcileInput, "cloudFallbackAllowed"> {
	cloudAllowed: boolean;
	installPhase: TtsInstallPhase | null;
	update: (
		patch: NonNullable<ReturnType<typeof resolveTtsEnabledModelPatch>>,
	) => void;
}

/**
 * Reconcile a hydrated-but-stale `enabled: true` (e.g. the model's files were
 * deleted from disk between sessions): fall back to another cached model, to
 * cloud, or force the toggle off. Destructive by design, so it must NEVER act
 * on STALE cache-state — the picker's enable-commit races the async state
 * refetch, and acting on the pre-download snapshot used to uncheck the toggle
 * right after a successful install (the on→off→on flicker). Three guards:
 *
 *   1. Skip while the picker is open or an install/warm-up is in flight — a
 *      model is about to land; `statesById` lags the files on disk.
 *   2. Verify before punishing: re-fetch the cache states and only apply the
 *      patch if FRESH data still warrants it.
 *   3. The state store coalesces in-flight refreshes, so the first await may
 *      join a fetch that started before the files landed — a second refresh is
 *      guaranteed to start afterwards.
 *
 * One confirm chain runs at a time; every re-check reads the stores directly
 * so the final decision uses the newest state, not the render that armed it.
 */
export function useTtsEnabledReconciler(
	inputs: TtsEnabledReconcilerInputs,
): void {
	const {
		cloudAllowed,
		enabled,
		installPhase,
		isCloud,
		model,
		models,
		statesById,
		statesLoaded,
		update,
	} = inputs;
	const reconcileInFlightRef = useRef(false);
	const mountedRef = useRef(true);
	useEffect(
		() => () => {
			mountedRef.current = false;
		},
		[],
	);
	useEffect(() => {
		if (reconcileInFlightRef.current) {
			return;
		}
		const wanted = resolveTtsEnabledModelPatch({
			cloudFallbackAllowed: cloudAllowed,
			enabled,
			isCloud,
			model,
			models,
			statesById,
			statesLoaded,
		});
		if (!wanted) {
			return;
		}
		if (useTtsModelPickerStore.getState().open || installPhase !== null) {
			return;
		}
		const confirmPatch = () => {
			const states = useTtsModelStateStore.getState();
			const tts = useSettingsStore.getState().settings.tts;
			return resolveTtsEnabledModelPatch({
				cloudFallbackAllowed: cloudAllowed,
				enabled: tts?.enabled ?? false,
				isCloud,
				model: tts?.model ?? DEFAULT_SETTINGS.tts.model,
				models: useTtsCatalogStore.getState().models,
				statesById: states.statesById,
				statesLoaded: states.isLoaded,
			});
		};
		reconcileInFlightRef.current = true;
		const run = async () => {
			await useTtsModelStateStore.getState().refresh();
			if (!(mountedRef.current && confirmPatch())) {
				return;
			}
			await useTtsModelStateStore.getState().refresh();
			if (!mountedRef.current) {
				return;
			}
			const patch = confirmPatch();
			if (patch) {
				update(patch);
			}
		};
		void run().finally(() => {
			reconcileInFlightRef.current = false;
		});
	}, [
		cloudAllowed,
		enabled,
		installPhase,
		isCloud,
		model,
		models,
		statesById,
		statesLoaded,
		update,
	]);
}
