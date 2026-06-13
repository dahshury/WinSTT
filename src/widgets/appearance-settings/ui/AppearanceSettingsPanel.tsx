import { MonitorDotIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { useCatalogStore, useModelStateStore } from "@/entities/model-catalog";
import { resolveRealtimeLanguageGuardPatch } from "@/features/realtime-preview-fallback";
import { useLocaleStore } from "@/shared/i18n";
import { shouldSuppressPillPreviewForWordByWordPaste } from "@/shared/lib/realtime-enabled";
import { computeDisplayFlags } from "../lib/appearance-settings-helpers";
import {
	LISTEN_MODE_DISPLAY_TOOLTIP,
	LanguageControl,
	LiveTranscriptionDisplayControl,
	OverlayControl,
	OverlayModeControl,
	VisualizerTypeControl,
} from "./DisplayControls";
import { VisualizerShapeControls } from "./VisualizerShapeControls";

export function AppearanceSettingsPanel() {
	const general = useSettingsStore((s) => s.settings.general);
	const modelSettings = useSettingsStore((s) => s.settings.model);
	const mainModelId = modelSettings?.model ?? "";
	const realtimeModelId = modelSettings?.realtimeModel ?? "";
	const useMainModelForRealtime = useSettingsStore(
		(s) => s.settings.quality?.useMainModelForRealtime ?? false,
	);
	const llmDictationEnabled = useSettingsStore(
		(s) => s.settings.llm.dictation.enabled,
	);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const t = useTranslations("general");
	const catalogLoaded = useCatalogStore((s) => s.isLoaded);
	const catalogModels = useCatalogStore((s) => s.models);
	const statesLoaded = useModelStateStore((s) => s.isLoaded);
	const statesById = useModelStateStore((s) => s.statesById);

	const locale = useLocaleStore((s) => s.locale);
	const setLocale = useLocaleStore((s) => s.setLocale);

	const recordingMode = general?.recordingMode ?? "ptt";
	const isListenMode = recordingMode === "listen";
	const flags = computeDisplayFlags(isListenMode, general);
	const suppressWordByWordPillPreview =
		shouldSuppressPillPreviewForWordByWordPaste({
			llmDictationEnabled,
			mainModelId,
			realtimeModelId,
			useMainModelForRealtime,
			wordByWordPasting: general?.wordByWordPasting ?? false,
		});
	const realtimeLanguageUnavailable =
		resolveRealtimeLanguageGuardPatch({
			catalogLoaded,
			catalogModels,
			currentMainModel: mainModelId,
			currentRealtimeModel: realtimeModelId,
			liveTranscriptionDisplay: "both",
			realtimeEnabled: true,
			sourceLanguageSelection: modelSettings,
			statesById,
			statesLoaded,
			wordByWordPasting: false,
		}) !== null;

	return (
		<div className="flex flex-col gap-2">
			<SettingSection divided icon={MonitorDotIcon} title={t("display")}>
				<LanguageControl locale={locale} setLocale={setLocale} t={t} />
				<VisualizerTypeControl general={general} t={t} update={update} />
				<VisualizerShapeControls general={general} t={t} update={update} />
				<OverlayControl
					general={general}
					isListenMode={isListenMode}
					t={t}
					update={update}
				/>
				<OverlayModeControl
					disabledTooltip={
						isListenMode ? LISTEN_MODE_DISPLAY_TOOLTIP : undefined
					}
					general={general}
					subDisabled={flags.subDisabled}
					t={t}
					update={update}
				/>
				<LiveTranscriptionDisplayControl
					general={general}
					isListenMode={isListenMode}
					realtimeLanguageUnavailable={realtimeLanguageUnavailable}
					suppressWordByWordPillPreview={suppressWordByWordPillPreview}
					t={t}
					update={update}
				/>
			</SettingSection>
		</div>
	);
}
