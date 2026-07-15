import { create } from "zustand";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";

/** Turn-on intent kept alive after the picker closes while a download the user
 *  started from the picker is still running. Snapshotted at download-start so
 *  a later browse session can't repurpose it. */
interface PendingTtsEnable {
	/** Model ids whose downloads were started from a turn-on picker session. */
	models: string[];
	sourceOnInstall: "local" | null;
}

interface TtsModelPickerState {
	close: () => void;
	/**
	 * A model finished installing (or an already-cached one was picked) in the
	 * read-aloud model selector. Write it to `tts.model`, enabling read-aloud
	 * ONLY when the open was a turn-on request. This is the single commit point
	 * that upholds the invariant "read-aloud is never enabled without a real
	 * model on disk": the toggle opens the picker but never flips `enabled`
	 * itself — only a landed model does, here. While the picker is CLOSED it
	 * only acts on a `pendingEnable` hit (a download the user started from a
	 * turn-on session that outlived the picker), so a stray download-complete
	 * event (from the inline section selector, say) can't silently flip the
	 * toggle on.
	 */
	commitInstalled: (modelId: string, quantization?: string) => void;
	/** When true, a model that installs/selects commits `enabled: true` for
	 *  read-aloud — the toggle-driven "turn this on" path. When false the picker
	 *  only writes the model (a plain "change my voice model" browse), leaving
	 *  `enabled` untouched. */
	enableOnInstall: boolean;
	open: boolean;
	openFor: (enableOnInstall: boolean, sourceOnInstall?: "local") => void;
	/** Survives `close()` so the user can leave the picker (or the whole app in
	 *  the background) while the download runs — the toggle still flips on when
	 *  it lands. Cleared by any commit, or when its last download is cancelled. */
	pendingEnable: PendingTtsEnable | null;
	sourceOnInstall: "local" | null;
	/** Record a download the user started (or resumed) from the picker. Only a
	 *  turn-on session arms the pending intent; browse downloads never do. */
	trackEnableDownload: (modelId: string) => void;
	/** Drop a cancelled download from the pending intent (clears it entirely
	 *  when that was the last one). */
	untrackEnableDownload: (modelId: string) => void;
}

/**
 * Coordinates the read-aloud (TTS) model-picker modal. The modal itself is a
 * widget, so — per the FSD widget→widget ban — it is rendered at the VIEW layer
 * (SettingsPage) while this feature store is the shared coordination point the
 * settings widget drives. Mirrors {@link useLlmModelPickerStore}: turning the
 * read-aloud toggle on opens the picker (without enabling); only a downloaded /
 * selected model commits `enabled: true`. Closing the picker empty leaves the
 * toggle off — UNLESS a download started from that turn-on session is still
 * running, in which case the intent is parked in `pendingEnable` and the
 * landing download still commits the enable.
 */
export const useTtsModelPickerStore = create<TtsModelPickerState>(
	(set, get) => ({
		enableOnInstall: false,
		open: false,
		pendingEnable: null,
		sourceOnInstall: null,
		openFor: (enableOnInstall, sourceOnInstall) =>
			set({
				open: true,
				enableOnInstall,
				sourceOnInstall: sourceOnInstall ?? null,
			}),
		// Deliberately leaves `pendingEnable` alone: a download armed by an
		// earlier turn-on session keeps its commit rights across close.
		close: () =>
			set({ open: false, enableOnInstall: false, sourceOnInstall: null }),
		trackEnableDownload: (modelId) => {
			const { open, enableOnInstall, sourceOnInstall, pendingEnable } = get();
			if (!(open && enableOnInstall)) {
				return;
			}
			const models = pendingEnable?.models ?? [];
			set({
				pendingEnable: {
					models: models.includes(modelId) ? models : [...models, modelId],
					sourceOnInstall,
				},
			});
		},
		untrackEnableDownload: (modelId) => {
			const { pendingEnable } = get();
			if (!pendingEnable) {
				return;
			}
			const models = pendingEnable.models.filter((m) => m !== modelId);
			set({
				pendingEnable: models.length > 0 ? { ...pendingEnable, models } : null,
			});
		},
		commitInstalled: (modelId, quantization) => {
			const { open, enableOnInstall, sourceOnInstall, pendingEnable } = get();
			const pendingHit =
				!open && (pendingEnable?.models.includes(modelId) ?? false);
			if (!(open || pendingHit)) {
				return;
			}
			// Any commit resolves the outstanding turn-on intent — the latest
			// user interaction wins, so an older parked download can't flip the
			// toggle after the user has already settled on a model.
			set({ pendingEnable: null });
			const settings = useSettingsStore.getState();
			const source = open
				? sourceOnInstall
				: (pendingEnable?.sourceOnInstall ?? null);
			const sourcePatch = source ? { source } : {};
			// Persist an explicit precision pick alongside the model so the backend
			// loads the chosen quant (parity with the inline section selector).
			const quantPatch = quantization === undefined ? {} : { quantization };
			const enable = open ? enableOnInstall : true;
			if (!enable) {
				settings.updateTtsSettings({
					model: modelId,
					...quantPatch,
					...sourcePatch,
				});
				return;
			}
			// Fold the default Speak-selection hotkey in alongside `enabled: true`
			// when the user has no binding yet, so the combo is always armed once
			// read-aloud turns on (parity with the old install-gate enable patch).
			const currentHotkey = settings.settings.tts?.hotkey ?? "";
			const patch = currentHotkey.trim()
				? {
						model: modelId,
						enabled: true as const,
						...quantPatch,
						...sourcePatch,
					}
				: {
						model: modelId,
						enabled: true as const,
						hotkey: DEFAULT_SETTINGS.tts.hotkey,
						...quantPatch,
						...sourcePatch,
					};
			settings.updateTtsSettings(patch);
		},
	}),
);
