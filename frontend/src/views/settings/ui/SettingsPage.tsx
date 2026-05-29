import { Tabs } from "@base-ui/react/tabs";
import {
	AiChat02Icon,
	ChartHistogramIcon,
	CpuChargeIcon,
	InformationCircleIcon,
	Mic01Icon,
	Note01Icon,
	PlugSocketIcon,
	SlidersHorizontalIcon,
	TextIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { useSettingsStore, useSettingsTabStore } from "@/entities/setting";
import { useDownloadListener } from "@/features/model-download";
import { useSyncActiveModel } from "@/features/sync-active-model";
import { useSyncSettings } from "@/features/update-settings";
import { windowCloseSelf } from "@/shared/api/ipc-client";
import { Elevated, SurfaceProvider } from "@/shared/lib/surface";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { AboutSettingsPanel } from "@/widgets/about-settings";
import { AudioSettingsPanel } from "@/widgets/audio-settings";
import { DictionarySettingsPanel } from "@/widgets/dictionary-settings";
import { GeneralSettingsPanel } from "@/widgets/general-settings";
import { IntegrationsSettingsPanel } from "@/widgets/integrations-settings";
import { LlmSettingsPanel } from "@/widgets/llm-settings";
import { ModelSettingsPanel } from "@/widgets/model-settings";
import { QualitySettingsPanel } from "@/widgets/quality-settings";
import { SnippetsSettingsPanel } from "@/widgets/snippets-settings";
import { TranscriptionHistoryPanel } from "@/widgets/transcription-history-settings";
import { TtsModelSection } from "@/widgets/tts-settings";
import { useSettingsSearchKeywords } from "../lib/settings-search";
import { SettingsSidebar, type SidebarLink } from "./SettingsSidebar";

const llmSettingsSlot = <LlmSettingsPanel />;
const ttsSettingsSlot = <TtsModelSection />;

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
			key: "general",
			label: t("tabGeneral"),
			icon: SlidersHorizontalIcon,
			tooltip: t("tabGeneralTooltip"),
			keywords: keywords.general,
		},
		{
			key: "model",
			label: t("tabModel"),
			icon: AiChat02Icon,
			tooltip: t("tabModelTooltip"),
			keywords: keywords.model,
		},
		{
			key: "audio",
			label: t("tabAudio"),
			icon: Mic01Icon,
			tooltip: t("tabAudioTooltip"),
			keywords: keywords.audio,
		},
		{
			key: "quality",
			label: t("tabProcessing"),
			icon: CpuChargeIcon,
			tooltip: t("tabProcessingTooltip"),
			keywords: keywords.quality,
			groupEnd: true,
		},
		{
			key: "dictionary",
			label: t("tabDictionary"),
			icon: TextIcon,
			tooltip: t("tabDictionaryTooltip"),
			keywords: keywords.dictionary,
		},
		{
			key: "snippets",
			label: t("tabSnippets"),
			icon: Note01Icon,
			tooltip: t("tabSnippetsTooltip"),
			keywords: keywords.snippets,
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
			groupEnd: true,
		},
		{
			key: "about",
			label: t("tabAbout"),
			icon: InformationCircleIcon,
			tooltip: t("tabAboutTooltip"),
			keywords: keywords.about,
		},
	];

	const activeLink = links.find((l) => l.key === activeTab);

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
						<SettingsSidebar links={links} onClose={windowCloseSelf} />
						{/* Content card — a rounded, shadowed panel inset with a small margin
						    so the surface-1 substrate shows around it. The sidebar reads as
						    built into the window while each tab's content floats a layer above.
						    Lifts to surface-3 (a clear ~8% step above the surface-1 sidebar) so
						    the colour difference is obvious; nested SettingSection controls lift
						    from there as usual. */}
						<div className="min-w-0 flex-1 py-2.5 ps-2 pe-2.5">
							<Elevated
								className="flex h-full flex-col overflow-hidden rounded-xl ring-1 ring-divider-strong"
								offset={2}
								shadowLevel={5}
							>
								{/* Per-tab title — sits in a fixed band whose height matches the
								    sidebar's "Settings" band so the two wordmarks share a baseline.
								    Doubles as a window drag region for the frameless window. */}
								<div className="titlebar-drag flex h-14 shrink-0 items-center px-6">
									<h2 className="font-semibold text-foreground text-title tracking-[-0.02em]">
										{activeLink?.label ?? ""}
									</h2>
								</div>
								<ScrollArea className="min-h-0 flex-1" viewportClassName="px-6 pb-6">
									{activeLink?.tooltip ? (
										<p className="pb-3 text-body text-foreground-muted">{activeLink.tooltip}</p>
									) : null}
									<Tabs.Panel value="general">
										<GeneralSettingsPanel />
									</Tabs.Panel>
									<Tabs.Panel value="model">
										<ModelSettingsPanel llmSlot={llmSettingsSlot} ttsSlot={ttsSettingsSlot} />
									</Tabs.Panel>
									<Tabs.Panel value="audio">
										<AudioSettingsPanel />
									</Tabs.Panel>
									<Tabs.Panel value="quality">
										<QualitySettingsPanel />
									</Tabs.Panel>
									<Tabs.Panel value="dictionary">
										<DictionarySettingsPanel />
									</Tabs.Panel>
									<Tabs.Panel value="snippets">
										<SnippetsSettingsPanel />
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
			</div>
		</SurfaceProvider>
	);
}
