import { BrainCircuitIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { Button } from "@/shared/ui/button";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	type LlmSettingsPanelModel,
	useLlmSettingsPanel,
} from "../model/use-llm-settings-panel";
import { FeatureBlock } from "./FeatureBlock";
import { LlmSettingsDialogs } from "./LlmSettingsDialogs";
import {
	ConfigurationsCombobox,
	FeaturePresetControls,
} from "./modifier-presets";
import { PlaygroundModal } from "./playground-modal";

export type { LlmSettingsPanelModel };

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
		transforms,
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
		updateDictation,
		updateTransforms,
		setShowOllamaDialogFor,
		setShowApiKeyDialogFor,
		setShowModelPickerFor,
	} = model;

	return (
		<>
			<SettingSection
				headerAction={
					isListenMode ? (
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
					)
				}
				icon={BrainCircuitIcon}
				title={t("title")}
			>
				{/* Provider connection inputs (Ollama endpoint, OpenRouter API
				    key) live in the dedicated Integrations settings tab — both
				    feature subsections read the same shared values. The shared,
				    detached Playground (header action above) replaces the old
				    per-feature inline playground blocks. */}
				<FeatureBlock
					checkOllamaReachable={checkOllamaReachable}
					endpoint={endpoint}
					feature="dictation"
					featureSnapshot={dictation}
					forceDisabled={isListenMode}
					forceDisabledTooltip={listenModeLlmTooltip}
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
					t={t}
					tc={tc}
					update={updateDictation}
					updateShared={updateShared}
					warmupStatus={warmupStatus}
				>
					<FeaturePresetControls
						configControl={
							<ConfigurationsCombobox
								snapshot={dictation}
								t={t}
								update={updateDictation}
							/>
						}
						feature="dictation"
						model={model}
						snapshot={dictation}
						update={updateDictation}
					/>
				</FeatureBlock>

				<FeatureBlock
					checkOllamaReachable={checkOllamaReachable}
					endpoint={endpoint}
					feature="transforms"
					featureSnapshot={transforms}
					forceDisabled={isListenMode}
					forceDisabledTooltip={listenModeLlmTooltip}
					librarySearch={librarySearchProps}
					ollamaCatalog={ollamaCatalogState}
					ollamaPullBundle={ollamaPullBundle}
					ollamaReachable={ollamaReachable}
					openrouterApiKey={openrouterApiKey}
					openrouterCatalog={openrouterCatalogState}
					providerOpts={providerOpts}
					retryOllamaWarmup={retryOllamaWarmup}
					setShowApiKeyDialog={setShowApiKeyDialogFor("transforms")}
					setShowModelPicker={setShowModelPickerFor("transforms")}
					setShowOllamaDialog={setShowOllamaDialogFor("transforms")}
					t={t}
					tc={tc}
					update={updateTransforms}
					updateShared={updateShared}
					warmupStatus={warmupStatus}
				>
					<FeaturePresetControls
						configControl={
							<ConfigurationsCombobox
								snapshot={transforms}
								t={t}
								update={updateTransforms}
							/>
						}
						feature="transforms"
						model={model}
						snapshot={transforms}
						update={updateTransforms}
					/>
				</FeatureBlock>
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
