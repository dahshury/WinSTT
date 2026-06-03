import { create } from "zustand";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";

interface TtsModelPickerState {
	close: () => void;
	/**
	 * A model finished installing (or an already-cached one was picked) in the
	 * read-aloud model selector. Write it to `tts.model`, enabling read-aloud
	 * ONLY when the open was a turn-on request. This is the single commit point
	 * that upholds the invariant "read-aloud is never enabled without a real
	 * model on disk": the toggle opens the picker but never flips `enabled`
	 * itself — only a landed model does, here. No-op when the picker is closed
	 * so a late download-complete event (from the inline section selector, say)
	 * can't silently flip the toggle on.
	 */
	commitInstalled: (modelId: string) => void;
	/** When true, a model that installs/selects commits `enabled: true` for
	 *  read-aloud — the toggle-driven "turn this on" path. When false the picker
	 *  only writes the model (a plain "change my voice model" browse), leaving
	 *  `enabled` untouched. */
	enableOnInstall: boolean;
	open: boolean;
	openFor: (enableOnInstall: boolean) => void;
}

/**
 * Coordinates the read-aloud (TTS) model-picker modal. The modal itself is a
 * widget, so — per the FSD widget→widget ban — it is rendered at the VIEW layer
 * (SettingsPage) while this feature store is the shared coordination point the
 * settings widget drives. Mirrors {@link useLlmModelPickerStore}: turning the
 * read-aloud toggle on opens the picker (without enabling); only a downloaded /
 * selected model commits `enabled: true`, so closing the picker empty leaves the
 * toggle off.
 */
export const useTtsModelPickerStore = create<TtsModelPickerState>((set, get) => ({
	enableOnInstall: false,
	open: false,
	openFor: (enableOnInstall) => set({ open: true, enableOnInstall }),
	close: () => set({ open: false, enableOnInstall: false }),
	commitInstalled: (modelId) => {
		if (!get().open) {
			return;
		}
		const settings = useSettingsStore.getState();
		if (!get().enableOnInstall) {
			settings.updateTtsSettings({ model: modelId });
			return;
		}
		// Fold the default Speak-selection hotkey in alongside `enabled: true`
		// when the user has no binding yet, so the combo is always armed once
		// read-aloud turns on (parity with the old install-gate enable patch).
		const currentHotkey = settings.settings.tts?.hotkey ?? "";
		const patch = currentHotkey.trim()
			? { model: modelId, enabled: true as const }
			: { model: modelId, enabled: true as const, hotkey: DEFAULT_SETTINGS.tts.hotkey };
		settings.updateTtsSettings(patch);
	},
}));
