import { create } from "zustand";
import { useLlmCatalogStore } from "@/entities/llm-catalog";
import { useSettingsStore } from "@/entities/setting";

/** Every consumer that can open the picker. Read aloud used to be folded into
 *  `"dictation"` here, which meant a picker opened from the Read aloud row
 *  committed (and, on dismissal, disabled) DICTATION instead. */
type LlmPickerFeature = "dictation" | "readAloud" | "transforms";

/** The subset of a consumer's slice the picker ever writes. Structurally
 *  assignable to all three per-feature updaters, which take different partials. */
interface PickerFeaturePatch {
	enabled?: boolean;
	model?: string;
	provider?: "ollama";
}

function writeFeature(feature: LlmPickerFeature, patch: PickerFeaturePatch) {
	const settings = useSettingsStore.getState();
	if (feature === "dictation") {
		settings.updateLlmPostProcessing(patch);
		return;
	}
	if (feature === "transforms") {
		settings.updateLlmTransforms(patch);
		return;
	}
	settings.updateLlmReadAloud(patch);
}

interface LlmModelPickerState {
	close: () => void;
	/**
	 * A model finished installing (or an already-installed one was selected) in
	 * the picker. Write it to the pending feature, enabling that feature ONLY
	 * when the open was a turn-on request. This is the single commit point that
	 * upholds the invariant "LLM cleanup is never enabled without a real model":
	 * the toggle opens the picker but never flips `enabled` itself — only a
	 * landed model does, here. While the dialog is CLOSED it only acts when a
	 * turn-on intent was parked in `pendingFeature` (a pull that outlived the
	 * dialog), so nothing else can silently flip a toggle on.
	 */
	commitInstalled: (model: string) => void;
	/** When true, a model that installs/selects commits `enabled: true` for the
	 *  pending feature — the toggle-driven "turn this on" path. When false the
	 *  picker only writes the model (a plain "change my model" browse), leaving
	 *  `enabled` untouched. */
	enableOnInstall: boolean;
	/** Which LLM feature opened the picker (null when closed). */
	feature: LlmPickerFeature | null;
	open: boolean;
	openFor: (feature: LlmPickerFeature, enableOnInstall: boolean) => void;
	/** Turn-on intent parked at close time while an Ollama pull is still
	 *  streaming: the pull's success callback (`commitInstalled`, bound in the
	 *  dialog's `handlePull` closure) survives the dialog unmount, and this
	 *  field lets it still enable the feature the user asked to turn on — so
	 *  the user can switch to other apps while the download finishes instead of
	 *  the toggle silently staying off. Cleared by any commit. */
	pendingFeature: LlmPickerFeature | null;
}

/**
 * Coordinates the Ollama model-picker modal for the three LLM consumers
 * (dictation cleanup / text transforms / read aloud). The modal itself
 * (`OllamaModelManagerDialog`) is a widget, so — per the FSD widget→widget ban
 * — it is rendered at the VIEW layer (SettingsPage, OnboardingPage) while this
 * feature store is the shared coordination point both the settings widget and
 * the onboarding widget drive. One store, identical behavior in both surfaces.
 */
export const useLlmModelPickerStore = create<LlmModelPickerState>(
	(set, get) => ({
		enableOnInstall: false,
		feature: null,
		open: false,
		pendingFeature: null,
		openFor: (feature, enableOnInstall) =>
			set({ open: true, feature, enableOnInstall }),
		close: () => {
			const { enableOnInstall, feature, pendingFeature } = get();
			// A pull still streaming when a turn-on session closes carries the
			// enable intent forward; otherwise keep whatever intent an earlier
			// session parked (its pull may still be running).
			const pullInFlight =
				Object.keys(useLlmCatalogStore.getState().pulls).length > 0;
			const abandonedTurnOn =
				enableOnInstall && feature !== null && !pullInFlight;
			set({
				open: false,
				feature: null,
				enableOnInstall: false,
				pendingFeature:
					enableOnInstall && feature !== null && pullInFlight
						? feature
						: pendingFeature,
			});
			// Dismissed without downloading anything, on a turn-on request: the
			// feature must end up OFF. The toggle that opened this picker never
			// committed `enabled` (only a landed model does), but an ALREADY-enabled
			// feature whose model went missing would otherwise be left on with
			// nothing to run — so switch it off explicitly rather than assuming.
			if (abandonedTurnOn) {
				writeFeature(feature, { enabled: false });
			}
		},
		commitInstalled: (model) => {
			const { feature, enableOnInstall, pendingFeature } = get();
			const target = feature ?? pendingFeature;
			if (target === null) {
				return;
			}
			// A parked intent is always a turn-on request; a live session keeps
			// its own flag. Any commit resolves the outstanding intent.
			const enable = feature === null ? true : enableOnInstall;
			set({ pendingFeature: null });
			const settings = useSettingsStore.getState();
			// A model that just landed becomes THE shared local model, and the store
			// action pushes it onto every locally-running consumer in one write —
			// writing `localModel` alone left the other consumers on the previous
			// model, which is exactly the second resident model the rule forbids.
			settings.updateLlmSharedLocalModel(model);
			const patch = enable
				? { model, provider: "ollama" as const, enabled: true }
				: { model, provider: "ollama" as const };
			writeFeature(target, patch);
			if (enable && target === "dictation") {
				// Mutual exclusion with Smart Endpoint — mirrors the panel's
				// `disableSmartEndpoint`: turning dictation cleanup on turns the
				// Smart Endpoint heuristic off. Dictation only: the other consumers
				// run nowhere near the finalization heuristic.
				settings.updateQualitySettings({ smartEndpoint: false });
			}
		},
	}),
);
