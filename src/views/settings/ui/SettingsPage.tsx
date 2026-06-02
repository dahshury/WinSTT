import { Tabs } from "@base-ui/react/tabs";
import {
	AiChat02Icon,
	Cancel01Icon,
	ChartHistogramIcon,
	DashboardCircleIcon,
	InformationCircleIcon,
	KeyboardIcon,
	MagicWand01Icon,
	Mic01Icon,
	PlugSocketIcon,
	TextIcon,
	VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { useSettingsStore, useSettingsTabStore } from "@/entities/setting";
import { useLlmModelPickerStore } from "@/features/llm-model-picker";
import { useDownloadListener } from "@/features/model-download";
import { useCloudKeyAutoRevert } from "@/features/revert-cloud-on-key-removal";
import { useSyncActiveModel } from "@/features/sync-active-model";
import { useSyncSettings } from "@/features/update-settings";
import { windowCloseSelf } from "@/shared/api/ipc-client";
import { Elevated, SurfaceProvider } from "@/shared/lib/surface";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { AboutSettingsPanel } from "@/widgets/about-settings";
import { AppearanceSettingsPanel } from "@/widgets/appearance-settings";
import { DictionarySettingsPanel } from "@/widgets/dictionary-settings";
import { IntegrationsSettingsPanel } from "@/widgets/integrations-settings";
import { LlmSettingsPanel } from "@/widgets/llm-settings";
import { ModelSettingsPanel } from "@/widgets/model-settings";
import { OllamaModelManagerDialog } from "@/widgets/ollama-model-manager";
import { OutputSettingsPanel } from "@/widgets/output-settings";
import { ProcessingExtrasPanel } from "@/widgets/processing-extras";
import { RecordingSettingsPanel } from "@/widgets/recording-settings";
import { ShortcutsSettingsPanel } from "@/widgets/shortcuts-settings";
import { SnippetsSettingsPanel } from "@/widgets/snippets-settings";
import { TranscriptionHistoryPanel } from "@/widgets/transcription-history-settings";
import { TtsModelSection } from "@/widgets/tts-settings";
import { useSettingsSearchKeywords } from "../lib/settings-search";
import { SettingsSidebar, type SidebarLink } from "./SettingsSidebar";

/**
 * Host for the LLM Ollama model-picker modal. The dialog is a widget, so it
 * can't be rendered from the LLM settings *widget* (FSD widget→widget ban) —
 * the LLM panel only drives `useLlmModelPickerStore`, and this view-level host
 * renders the actual modal. On install it commits the model (and `enabled` when
 * the open was a toggle-driven turn-on), so the feature is never enabled
 * without a model.
 */
function LlmModelPickerHost() {
	const open = useLlmModelPickerStore((s) => s.open);
	const feature = useLlmModelPickerStore((s) => s.feature);
	const close = useLlmModelPickerStore((s) => s.close);
	const commitInstalled = useLlmModelPickerStore((s) => s.commitInstalled);
	const currentModel = useSettingsStore((s) =>
		feature === "transforms" ? s.settings.llm.transforms.model : s.settings.llm.dictation.model
	);
	return (
		<OllamaModelManagerDialog
			currentModel={currentModel}
			isOpen={open}
			onClose={close}
			onModelInstalled={commitInstalled}
		/>
	);
}

export function SettingsPage() {
	const isLoaded = useSettingsStore((s) => s.isLoaded);
	useSyncSettings();
	// Mount the model-download IPC listener here so the dictation model
	// download modal can subscribe to live progress / completion events in
	// the settings window (main window mounts this via IpcProvider).
	useDownloadListener();
	// Mirror the server's actually-loaded model into the settings store,
	// so the picker reflects reality when the server has fallen back from
	// an unloadable user choice. Idempotent when the two already agree.
	useSyncActiveModel();
	// Auto-revert any cloud surface (STT model / LLM provider / cloud TTS) to a
	// local engine when its API key is removed. Mounted HERE (not the main
	// window) because keys are edited in this window and the OpenRouter key
	// shares the `llm` section with the LLM provider/enabled flags — a revert
	// from another window loses the cross-window user-dirty merge.
	useCloudKeyAutoRevert();
	const t = useTranslations("settings");
	// Per-tab search keywords (section headings + setting names) so the sidebar
	// search surfaces a tab by its contents, not just its label/tooltip.
	const keywords = useSettingsSearchKeywords();
	// Controlled tab state so siblings (e.g. the Cloud-disabled badge in
	// ModelSettingsPanel) can navigate the sidebar by calling setActiveTab.
	const activeTab = useSettingsTabStore((s) => s.activeTab);
	const setActiveTab = useSettingsTabStore((s) => s.setActiveTab);

	const links: SidebarLink[] = [
		{
			key: "recording",
			label: t("tabRecording"),
			icon: Mic01Icon,
			tooltip: t("tabRecordingTooltip"),
			keywords: keywords.recording,
		},
		{
			key: "model",
			label: t("tabModel"),
			icon: AiChat02Icon,
			tooltip: t("tabModelTooltip"),
			keywords: keywords.model,
		},
		{
			key: "processing",
			label: t("tabProcessing"),
			icon: MagicWand01Icon,
			tooltip: t("tabProcessingTooltip"),
			keywords: keywords.processing,
		},
		{
			key: "vocabulary",
			label: t("tabVocabulary"),
			icon: TextIcon,
			tooltip: t("tabVocabularyTooltip"),
			keywords: keywords.vocabulary,
		},
		{
			key: "output",
			label: t("tabOutput"),
			icon: VolumeHighIcon,
			tooltip: t("tabOutputTooltip"),
			keywords: keywords.output,
			groupEnd: true,
		},
		{
			key: "shortcuts",
			label: t("tabShortcuts"),
			icon: KeyboardIcon,
			tooltip: t("tabShortcutsTooltip"),
			keywords: keywords.shortcuts,
		},
		{
			key: "appearance",
			label: t("tabAppearance"),
			icon: DashboardCircleIcon,
			tooltip: t("tabAppearanceTooltip"),
			keywords: keywords.appearance,
			groupEnd: true,
		},
		{
			key: "history",
			label: t("tabHistory"),
			icon: ChartHistogramIcon,
			tooltip: t("tabHistoryTooltip"),
			keywords: keywords.history,
			groupEnd: true,
		},
		{
			key: "integrations",
			label: t("tabIntegrations"),
			icon: PlugSocketIcon,
			tooltip: t("tabIntegrationsTooltip"),
			keywords: keywords.integrations,
		},
		{
			key: "about",
			label: t("tabAbout"),
			icon: InformationCircleIcon,
			tooltip: t("tabAboutTooltip"),
			keywords: keywords.about,
		},
	];

	return (
		<SurfaceProvider value={1}>
			<div className="noise-overlay flex h-dvh min-h-dvh bg-surface-1">
				{/* Content — hidden until electron-store settings are loaded to prevent default→saved flash */}
				{isLoaded ? (
					<Tabs.Root
						className="flex flex-1 overflow-hidden"
						onValueChange={(v) => setActiveTab(String(v))}
						orientation="vertical"
						value={activeTab}
					>
						<SettingsSidebar links={links} />
						{/* Content card — a rounded, shadowed panel inset with a small margin
						    so the surface-1 substrate shows around it. The sidebar reads as
						    built into the window while each tab's content floats a layer above.
						    Lifts to surface-3 (a clear ~8% step above the surface-1 sidebar) so
						    the colour difference is obvious; nested SettingSection controls lift
						    from there as usual. */}
						<div className="relative min-w-0 flex-1 py-2.5 ps-2 pe-2.5">
							{/* Drag strip — the thin surface-1 margin above the content card. The
							    window is frameless, so this gives the right (content) side a grab
							    handle that lines up with the sidebar's own top drag strip, making
							    the whole top edge draggable. The close button opts out via
							    titlebar-no-drag. */}
							<div
								aria-hidden="true"
								className="titlebar-drag absolute inset-x-0 top-0 z-titlebar h-2.5"
							/>
							<Elevated
								className="relative flex h-full flex-col overflow-hidden rounded-xl ring-1 ring-divider-strong"
								offset={2}
								shadowLevel={5}
							>
								{/* No title band — the active tab's name lives in the sidebar rail,
								    not repeated here. The window close button floats at the card's
								    very top-right corner, above the scrolling content. */}
								<button
									aria-label={t("close")}
									className="titlebar-no-drag group absolute end-1.5 top-1.5 z-raised flex size-7 items-center justify-center rounded-full bg-surface-4 text-foreground-muted outline-none transition-colors duration-150 hover:bg-error/85 hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
									onClick={windowCloseSelf}
									type="button"
								>
									<HugeiconsIcon
										className="transition-transform duration-150 ease-out group-hover:scale-110"
										icon={Cancel01Icon}
										size={15}
									/>
								</button>
								{/* Top padding clears the floating close button (~44px tall from
								    the card top) so the first section starts just below it. */}
								<ScrollArea
									className="min-h-0 flex-1"
									verticalOnly
									verticalScrollbarClassName="mt-9 mb-3 me-1"
									viewportClassName="px-6 pt-9 pb-6"
								>
									<Tabs.Panel value="recording">
										<RecordingSettingsPanel />
									</Tabs.Panel>
									<Tabs.Panel value="model">
										<ModelSettingsPanel />
									</Tabs.Panel>
									<Tabs.Panel value="processing">
										<LlmSettingsPanel />
										<ProcessingExtrasPanel />
									</Tabs.Panel>
									<Tabs.Panel value="vocabulary">
										<DictionarySettingsPanel />
										<SnippetsSettingsPanel />
									</Tabs.Panel>
									<Tabs.Panel value="output">
										<OutputSettingsPanel />
										<TtsModelSection />
									</Tabs.Panel>
									<Tabs.Panel value="shortcuts">
										<ShortcutsSettingsPanel />
									</Tabs.Panel>
									<Tabs.Panel value="appearance">
										<AppearanceSettingsPanel />
									</Tabs.Panel>
									<Tabs.Panel value="history">
										<TranscriptionHistoryPanel />
									</Tabs.Panel>
									<Tabs.Panel value="integrations">
										<IntegrationsSettingsPanel />
									</Tabs.Panel>
									<Tabs.Panel value="about">
										<AboutSettingsPanel />
									</Tabs.Panel>
								</ScrollArea>
							</Elevated>
						</div>
					</Tabs.Root>
				) : (
					<div className="flex-1 bg-surface-1" />
				)}
				<LlmModelPickerHost />
			</div>
		</SurfaceProvider>
	);
}
