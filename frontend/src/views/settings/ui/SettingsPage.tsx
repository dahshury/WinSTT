import { Tabs } from "@base-ui/react/tabs";
import {
	AiChat02Icon,
	Cancel01Icon,
	ChartHistogramIcon,
	CpuChargeIcon,
	InformationCircleIcon,
	Mic01Icon,
	Note01Icon,
	PlugSocketIcon,
	SlidersHorizontalIcon,
	TextIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useSettingsStore } from "@/entities/setting";
import { useDownloadListener } from "@/features/model-download";
import { useSyncActiveModel } from "@/features/sync-active-model";
import { useSyncSettings } from "@/features/update-settings";
import { windowCloseSelf } from "@/shared/api/ipc-client";
import { Elevated, SurfaceProvider } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Tooltip } from "@/shared/ui/tooltip";
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

	const links: SidebarLink[] = [
		{
			key: "general",
			label: t("tabGeneral"),
			icon: SlidersHorizontalIcon,
			tooltip: t("tabGeneralTooltip"),
		},
		{
			key: "model",
			label: t("tabModel"),
			icon: AiChat02Icon,
			tooltip: t("tabModelTooltip"),
		},
		{
			key: "audio",
			label: t("tabAudio"),
			icon: Mic01Icon,
			tooltip: t("tabAudioTooltip"),
		},
		{
			key: "quality",
			label: t("tabProcessing"),
			icon: CpuChargeIcon,
			tooltip: t("tabProcessingTooltip"),
			groupEnd: true,
		},
		{
			key: "dictionary",
			label: t("tabDictionary"),
			icon: TextIcon,
			tooltip: t("tabDictionaryTooltip"),
		},
		{
			key: "snippets",
			label: t("tabSnippets"),
			icon: Note01Icon,
			tooltip: t("tabSnippetsTooltip"),
			groupEnd: true,
		},
		{
			key: "history",
			label: t("tabHistory"),
			icon: ChartHistogramIcon,
			tooltip: t("tabHistoryTooltip"),
			groupEnd: true,
		},
		{
			key: "integrations",
			label: t("tabIntegrations"),
			icon: PlugSocketIcon,
			tooltip: t("tabIntegrationsTooltip"),
			groupEnd: true,
		},
		{
			key: "about",
			label: t("tabAbout"),
			icon: InformationCircleIcon,
			tooltip: t("tabAboutTooltip"),
		},
	];

	return (
		<SurfaceProvider value={1}>
			<div className="noise-overlay flex h-dvh min-h-dvh flex-col bg-surface-1">
				{/* Title bar — surface-2 substrate with a top-light gradient
				    overlay, a Docker-blue accent hairline at the top edge
				    (single brand moment, matching the pill + model selector),
				    and a small accent dot anchoring the title text. */}
				<Elevated
					className="titlebar-drag relative flex h-8 shrink-0 items-stretch border-border border-b bg-gradient-to-b from-[var(--color-surface-3)]/45 to-transparent"
					offset={1}
					shadowLevel={1}
				>
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent"
					/>
					<div className="flex items-center gap-2 pl-3">
						<span
							aria-hidden="true"
							className="size-1.5 rounded-full bg-accent shadow-[0_0_6px_var(--color-accent-glow-strong)]"
						/>
						<span className="font-mono text-foreground-secondary text-xs-tight uppercase tracking-[0.18em]">
							{t("title")}
						</span>
					</div>
					<div className="flex-1" />
					<div className="titlebar-no-drag flex items-center">
						<Tooltip content={t("close")}>
							<Button
								aria-label={t("close")}
								className="group flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-[background-color,color] duration-150 hover:bg-error/85 hover:text-white"
								onClick={windowCloseSelf}
							>
								<HugeiconsIcon
									className="transition-transform duration-150 ease-out group-hover:scale-110"
									icon={Cancel01Icon}
									size={12}
								/>
							</Button>
						</Tooltip>
					</div>
				</Elevated>

				{/* Content — hidden until electron-store settings are loaded to prevent default→saved flash */}
				{isLoaded ? (
					<Tabs.Root
						className="flex flex-1 overflow-hidden"
						defaultValue="general"
						orientation="vertical"
					>
						<SettingsSidebar links={links} />
						{/* Content viewport — lifts to surface-2 so section cards (offset 2) read at surface-4 */}
						<Elevated className="flex-1 overflow-hidden" offset={1} shadowLevel={1}>
							<ScrollArea className="h-full w-full" viewportClassName="p-4">
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
					</Tabs.Root>
				) : (
					<div className="flex-1 bg-surface-1" />
				)}
			</div>
		</SurfaceProvider>
	);
}
