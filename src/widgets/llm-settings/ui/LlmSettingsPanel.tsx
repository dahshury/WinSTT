import { BrainCircuitIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { Button } from "@/shared/ui/button";
import { Tooltip } from "@/shared/ui/tooltip";
import { Toggle } from "@/shared/ui/toggle";
import { performFeatureToggle } from "../lib/llm-settings-panel-test-helpers";
import { useLlmSettingsPanel } from "../model/use-llm-settings-panel";
import { FeatureBlock } from "./FeatureBlock";
import { LlmSettingsDialogs } from "./LlmSettingsDialogs";
import {
	FeaturePresetControls,
	PostProcessingProfilesCombobox,
} from "./modifier-presets";
import { PlaygroundModal } from "./playground-modal";

export function LlmSettingsPanel() {
	const model = useLlmSettingsPanel();
	const [playgroundOpen, setPlaygroundOpen] = useState(false);
	const isListenMode = useSettingsStore(
		(s) => (s.settings.general?.recordingMode ?? "ptt") === "listen",
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
					disableDictationConflicts();
				}
			},
			setShowOllamaDialog: setShowOllamaDialogFor("dictation"),
			setShowApiKeyDialog: setShowApiKeyDialogFor("dictation"),
			setShowModelPicker: setShowModelPickerFor("dictation"),
		});
	};

	const playgroundButton = isListenMode ? (
		<Tooltip content={listenModeLlmTooltip}>
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
						<PostProcessingProfilesCombobox
							disabled={!effectivePostProcessingEnabled}
							snapshot={dictation}
							t={t}
							update={updatePostProcessing}
						/>
						<Toggle
							aria-label="Toggle post-processing"
							checked={effectivePostProcessingEnabled}
							disabled={isListenMode}
							onCheckedChange={handlePostProcessingToggle}
						/>
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
