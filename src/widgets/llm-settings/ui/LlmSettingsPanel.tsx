import { BrainCircuitIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { Button } from "@/shared/ui/button";
import { PendingBadge } from "@/shared/ui/pending";
import { Tooltip } from "@/shared/ui/tooltip";
import { Toggle } from "@/shared/ui/toggle";
import { performFeatureToggle } from "../lib/llm-settings-panel-test-helpers";
import { useLlmSettingsPanel } from "../model/use-llm-settings-panel";
import { useAppProfileIndicatorStore } from "../model/use-app-profile-indicator";
import { AppProfileRulesSection } from "./AppProfileRulesSection";
import { FeatureBlock } from "./FeatureBlock";
import { LlmSettingsDialogs } from "./LlmSettingsDialogs";
import {
	FeaturePresetControls,
	PostProcessingProfilesCombobox,
} from "./modifier-presets";
import { PlaygroundModal } from "./playground-modal";
import {
	useOllamaUnloadTracker,
	useOllamaWarmTracker,
} from "./use-ollama-lifecycle-trackers";

export function LlmSettingsPanel() {
	const model = useLlmSettingsPanel();
	const [playgroundOpen, setPlaygroundOpen] = useState(false);
	const activeRule = useAppProfileIndicatorStore((state) => state.current);
	const isListenMode = useSettingsStore(
		(s) => (s.settings.general?.recordingMode ?? "ptt") === "listen",
	);
	// Under the "immediately" unload policy the backend deliberately never
	// pre-warms (the model loads on demand per dictation), so there is no
	// warmup broadcast to settle a "Loading…" chip — don't arm one.
	const warmupRunsOnEnable = useSettingsStore(
		(s) => s.settings.global?.modelUnloadTimeout !== "immediately",
	);
	const listenModeLlmTooltip =
		"Listen mode does not run LLM post-processing or transforms; it only transcribes speaker audio inside the app window.";
	const {
		t,
		tc,
		endpoint,
		openrouterApiKey,
		dictation,
		warmupStatus,
		librarySearchProps,
		ollamaPullBundle,
		ollamaReachable,
		ollamaCatalogState,
		openrouterCatalogState,
		providerOpts,
		checkOllamaReachable,
		retryOllamaWarmup,
		disableDictationConflicts,
		updateShared,
		updatePostProcessing,
		setShowOllamaDialogFor,
		setShowApiKeyDialogFor,
		setShowModelPickerFor,
	} = model;
	const effectivePostProcessingEnabled = !isListenMode && dictation.enabled;
	// The toggle flips instantly, but the local (Ollama) model only lands in /
	// leaves VRAM once the backend warm/evict actually completes. While that
	// transition runs, the toggle shows the user's choice but LOCKS, and the
	// section content stays disabled — the settings "enable fully" only when
	// the model is genuinely ready (no spinner; the state itself is the signal).
	const warmTracker = useOllamaWarmTracker({
		enabled: effectivePostProcessingEnabled,
		model: dictation.model,
		provider: dictation.provider,
		warmupStatus,
	});
	const unloadTracker = useOllamaUnloadTracker({
		enabled: effectivePostProcessingEnabled,
		provider: dictation.provider,
	});
	const handlePostProcessingToggle = async (next: boolean) => {
		if (isListenMode) {
			return;
		}
		await performFeatureToggle(next, {
			provider: dictation.provider,
			openrouterApiKey,
			ollamaLoaded: ollamaCatalogState.isLoaded,
			ollamaModels: ollamaCatalogState.models,
			openrouterLoaded: openrouterCatalogState.isLoaded,
			currentOllamaModel: dictation.model,
			currentOpenRouterModel: dictation.openrouterModel,
			checkOllamaReachable,
			scanOllama: ollamaCatalogState.scanModels,
			scanOpenRouter: openrouterCatalogState.scanModels,
			apply: (patch) => {
				updatePostProcessing(patch);
				if (patch.enabled === true) {
					if (warmupRunsOnEnable) {
						warmTracker.beginWarm(patch.model ?? dictation.model);
					}
					disableDictationConflicts();
				} else if (patch.enabled === false) {
					unloadTracker.beginUnload(dictation.model);
				}
			},
			setShowOllamaDialog: setShowOllamaDialogFor("dictation"),
			setShowApiKeyDialog: setShowApiKeyDialogFor("dictation"),
			setShowModelPicker: setShowModelPickerFor("dictation"),
		});
	};
	const lifecyclePending = warmTracker.isWarming || unloadTracker.isUnloading;
	const headerControlsDisabled =
		!effectivePostProcessingEnabled || warmTracker.isWarming;
	const playgroundDisabled = headerControlsDisabled;
	const playgroundDisabledTooltip = isListenMode
		? listenModeLlmTooltip
		: t("playgroundDisabled");

	const playgroundButton = playgroundDisabled ? (
		<Tooltip content={playgroundDisabledTooltip}>
			<span className="inline-flex">
				<Button
					className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 font-medium text-foreground-secondary text-sm transition-colors hover:border-accent hover:text-accent"
					disabled
				>
					<HugeiconsIcon icon={PlayIcon} size={14} />
					{t("playgroundTitle")}
				</Button>
			</span>
		</Tooltip>
	) : (
		<Button
			className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 font-medium text-foreground-secondary text-sm transition-colors hover:border-accent hover:text-accent"
			onClick={() => setPlaygroundOpen(true)}
		>
			<HugeiconsIcon icon={PlayIcon} size={14} />
			{t("playgroundTitle")}
		</Button>
	);

	return (
		<>
			<SettingSection
				headerAction={
					<div className="flex flex-wrap items-center justify-end gap-2">
						{playgroundButton}
						{activeRule ? (
							<span className="rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-accent text-caption">
								{t("appProfileIndicator", {
									app: activeRule.appExe,
									configuration: activeRule.configurationName,
								})}
							</span>
						) : null}
						<PostProcessingProfilesCombobox
							disabled={headerControlsDisabled}
							snapshot={dictation}
							t={t}
							update={updatePostProcessing}
						/>
						{/* The toggle shows the user's choice immediately but LOCKS
						    while the model warms into / drains out of memory — it
						    unlocks (and the content enables) only when the backend
						    confirms the transition finished. A corner spinner badge
						    makes that background load/evict visible (rather than
						    letting the locked toggle look inert). */}
						<PendingBadge pending={lifecyclePending}>
							<Toggle
								aria-label="Toggle post-processing"
								checked={effectivePostProcessingEnabled}
								disabled={isListenMode || lifecyclePending}
								onCheckedChange={handlePostProcessingToggle}
							/>
						</PendingBadge>
					</div>
				}
				boxed
				icon={BrainCircuitIcon}
				title={t("title")}
			>
				{/* Provider connection inputs (Ollama endpoint, OpenRouter API
				    key) live in the dedicated Integrations settings tab — both
				    feature subsections read the same shared values. The shared,
				    detached Playground (header action above) replaces the old
				    per-feature inline playground blocks. The py wrapper keeps the
				    two subsections off the boxed card's top/bottom ring (unlike
				    SettingField rows, SettingSubsection doesn't self-pad its
				    outer edges). */}
				<div className="flex flex-col py-1.5">
					<FeatureBlock
						busy={warmTracker.isWarming}
						checkOllamaReachable={checkOllamaReachable}
						endpoint={endpoint}
						feature="dictation"
						featureSnapshot={dictation}
						forceDisabled={isListenMode}
						forceDisabledTooltip={listenModeLlmTooltip}
						headerless
						librarySearch={librarySearchProps}
						ollamaCatalog={ollamaCatalogState}
						ollamaPullBundle={ollamaPullBundle}
						ollamaReachable={ollamaReachable}
						onEnabled={disableDictationConflicts}
						openrouterApiKey={openrouterApiKey}
						openrouterCatalog={openrouterCatalogState}
						providerOpts={providerOpts}
						retryOllamaWarmup={retryOllamaWarmup}
						setShowApiKeyDialog={setShowApiKeyDialogFor("dictation")}
						setShowModelPicker={setShowModelPickerFor("dictation")}
						setShowOllamaDialog={setShowOllamaDialogFor("dictation")}
						showToggle={false}
						t={t}
						tc={tc}
						caption="Clean up dictated speech and selected text with the same provider, model, tone, and modifiers."
						update={updatePostProcessing}
						updateShared={updateShared}
						warmupStatus={warmupStatus}
					>
						<FeaturePresetControls
							feature="dictation"
							model={model}
							snapshot={dictation}
							update={updatePostProcessing}
						/>
					</FeatureBlock>
					<AppProfileRulesSection
						enabled={effectivePostProcessingEnabled && !warmTracker.isWarming}
					/>
				</div>
			</SettingSection>

			<LlmSettingsDialogs model={model} />
			{/* Modal pins the surface baseline internally, so the playground gets a
			    settings-like elevation ramp (popup → cards → inputs) regardless of
			    how deeply this panel is nested — no wrapper needed here. */}
			<PlaygroundModal
				model={model}
				onClose={() => setPlaygroundOpen(false)}
				open={playgroundOpen}
			/>
		</>
	);
}
