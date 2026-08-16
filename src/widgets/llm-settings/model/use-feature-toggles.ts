import { useSettingsStore } from "@/entities/setting";
import { isSameOllamaTag } from "@/shared/lib/ollama-tag";
import { performFeatureToggle } from "../lib/llm-settings-panel-test-helpers";
import {
	useOllamaUnloadTracker,
	useOllamaWarmTracker,
} from "../ui/use-ollama-lifecycle-trackers";
import type { AssignableFeature } from "./configuration-assignment";
import { ASSIGNABLE_FEATURES } from "./feature-meta";
import type { ConfigurationWorkbench } from "./use-configuration-workbench";
import type { LlmSettingsPanelModel } from "./use-llm-settings-panel";

/**
 * The enable/disable behaviour of one consumer, with its model lifecycle.
 *
 * Two things live here that a bare `enabled` write cannot do, and whose loss was
 * a regression:
 *
 *   1. **Preflight** (`performFeatureToggle`) — is Ollama running? is a model
 *      installed? Enabling auto-picks the smallest installed model, or opens the
 *      model picker when there is none, and only commits `enabled` once a model
 *      is actually resolved. Without it a feature could be switched on with an
 *      empty model id: nothing to load, and the catalog reconcile silently
 *      switches it back off.
 *   2. **Pending state** — a local model does not become usable the moment the
 *      toggle flips; it has to warm into VRAM (and drain out again on disable).
 *      The toggle shows the user's choice, LOCKS, and wears a spinner until the
 *      backend confirms the transition.
 */
export interface FeatureToggleController {
	/** True while the model is warming in or draining out — the toggle locks and
	 *  wears a spinner rather than pretending the transition is instant. */
	pending: boolean;
	/** Runs the full preflight, then commits through the workbench. */
	toggle: (next: boolean) => Promise<void>;
}

export type FeatureToggleControllers = Record<
	AssignableFeature,
	FeatureToggleController
>;

function useFeatureToggle(
	feature: AssignableFeature,
	model: LlmSettingsPanelModel,
	workbench: ConfigurationWorkbench,
	/** Only dictation has cross-tab conflicts to clear (Smart Endpoint). */
	onEnabled?: () => void,
): FeatureToggleController {
	const llm = useSettingsStore((s) => s.settings.llm);
	const slice = llm[feature];

	/**
	 * Is `model` ALREADY resident because another enabled consumer is running it?
	 *
	 * Every locally-running feature shares one model by default, so the second
	 * feature you switch on loads nothing — and the third, and so on. Arming a
	 * warm-up spinner there would promise work that never happens and then hang
	 * until its 3-minute timeout, because no warmup broadcast is coming. The same
	 * holds in reverse on disable: the model only leaves VRAM once the LAST
	 * consumer of it stops.
	 */
	const sharedWithAnotherEnabledFeature = (model: string): boolean =>
		model.trim() !== "" &&
		ASSIGNABLE_FEATURES.some(
			(other) =>
				other !== feature &&
				llm[other].enabled &&
				llm[other].provider === "ollama" &&
				isSameOllamaTag(llm[other].model, model),
		);
	// Under the "immediately" unload policy the backend deliberately never
	// pre-warms (the model loads on demand per request), so there is no warmup
	// broadcast to settle a spinner — don't arm one.
	const warmupRunsOnEnable = useSettingsStore(
		(s) => s.settings.global?.modelUnloadTimeout !== "immediately",
	);
	const warmTracker = useOllamaWarmTracker({
		enabled: slice.enabled,
		model: slice.model,
		provider: slice.provider,
		warmupStatus: model.warmupStatus,
	});
	const unloadTracker = useOllamaUnloadTracker({
		enabled: slice.enabled,
		provider: slice.provider,
	});

	const toggle = async (next: boolean): Promise<void> => {
		await performFeatureToggle(next, {
			provider: slice.provider,
			openrouterApiKey: model.openrouterApiKey,
			ollamaLoaded: model.ollamaCatalogState.isLoaded,
			ollamaModels: model.ollamaCatalogState.models,
			openrouterLoaded: model.openrouterCatalogState.isLoaded,
			currentOllamaModel: slice.model,
			currentOpenRouterModel: slice.openrouterModel,
			checkOllamaReachable: model.checkOllamaReachable,
			scanOllama: model.ollamaCatalogState.scanModels,
			scanOpenRouter: model.openrouterCatalogState.scanModels,
			apply: (patch) => {
				workbench.applyFeatureTogglePatch(feature, patch);
				if (patch.enabled === true) {
					const target = patch.model ?? slice.model;
					if (
						warmupRunsOnEnable &&
						slice.provider === "ollama" &&
						!sharedWithAnotherEnabledFeature(target)
					) {
						warmTracker.beginWarm(target);
					}
					onEnabled?.();
				} else if (
					patch.enabled === false &&
					!sharedWithAnotherEnabledFeature(slice.model)
				) {
					unloadTracker.beginUnload(slice.model);
				}
			},
			// Every preflight dialog is keyed to THIS feature. Read aloud used to be
			// folded into dictation's here on the theory that both resolve to the
			// same shared local model — but the dialogs also commit `enabled`, so
			// completing (or dismissing) one from the Read aloud row turned
			// dictation on or off instead.
			setShowApiKeyDialog: model.setShowApiKeyDialogFor(feature),
			setShowModelPicker: model.setShowModelPickerFor(feature),
			setShowOllamaDialog: model.setShowOllamaDialogFor(feature),
		});
	};

	return {
		pending: warmTracker.isWarming || unloadTracker.isUnloading,
		toggle,
	};
}

/**
 * One controller per consumer. Called ONCE, at the panel level, and passed down:
 * the master switch drives dictation's controller so it gets the same preflight
 * and the same spinner as the row does, instead of a second, independent copy
 * whose pending state would not match.
 *
 * The three calls are unrolled rather than mapped so the hook order is fixed.
 */
export function useFeatureToggles(
	model: LlmSettingsPanelModel,
	workbench: ConfigurationWorkbench,
): FeatureToggleControllers {
	return {
		dictation: useFeatureToggle(
			"dictation",
			model,
			workbench,
			model.disableDictationConflicts,
		),
		transforms: useFeatureToggle("transforms", model, workbench),
		readAloud: useFeatureToggle("readAloud", model, workbench),
	};
}
