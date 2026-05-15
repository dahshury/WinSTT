"use client";

import { Tabs } from "@base-ui/react/tabs";
import {
	AiChat02Icon,
	Cancel01Icon,
	ChartHistogramIcon,
	CpuChargeIcon,
	KeyboardIcon,
	LaptopIcon,
	Mic01Icon,
	Note01Icon,
	SlidersHorizontalIcon,
	TextIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useSettingsStore } from "@/entities/setting";
import { useSyncSettings } from "@/features/update-settings";
import { windowCloseSelf } from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Tooltip } from "@/shared/ui/tooltip";
import { AudioSettingsPanel } from "@/widgets/audio-settings";
import { DesktopToolsSettingsPanel } from "@/widgets/desktop-tools-settings";
import { DictionarySettingsPanel } from "@/widgets/dictionary-settings";
import { GeneralSettingsPanel } from "@/widgets/general-settings";
import { HotkeySettingsPanel } from "@/widgets/hotkey-settings";
import { LlmSettingsPanel } from "@/widgets/llm-settings";
import { ModelSettingsPanel } from "@/widgets/model-settings";
import { OllamaModelManagerDialog } from "@/widgets/ollama-model-manager";
import { QualitySettingsPanel } from "@/widgets/quality-settings";
import { SnippetsSettingsPanel } from "@/widgets/snippets-settings";
import { TranscriptionHistoryPanel } from "@/widgets/transcription-history-settings";
import { SettingsSidebar, type SidebarLink } from "./SettingsSidebar";

const llmSettingsSlot = (
	<LlmSettingsPanel renderOllamaManager={(props) => <OllamaModelManagerDialog {...props} />} />
);

export function SettingsPage() {
	const resetSettings = useSettingsStore((s) => s.resetSettings);
	const isLoaded = useSettingsStore((s) => s.isLoaded);
	useSyncSettings();
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
		},
		{
			key: "hotkey",
			label: t("tabHotkey"),
			icon: KeyboardIcon,
			tooltip: t("tabHotkeyTooltip"),
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
		},
		{
			key: "desktop",
			label: t("tabDesktop"),
			icon: LaptopIcon,
			tooltip: t("tabDesktopTooltip"),
		},
		{
			key: "history",
			label: t("tabHistory"),
			icon: ChartHistogramIcon,
			tooltip: t("tabHistoryTooltip"),
		},
	];

	return (
		<div className="noise-overlay flex h-screen flex-col bg-surface-secondary">
			{/* Title bar — always visible so the window is draggable/closeable */}
			<header className="titlebar-drag flex h-8 shrink-0 items-stretch border-border border-b bg-surface-primary">
				<div className="flex items-center pl-3">
					<span className="font-mono text-foreground-muted text-xs-tight uppercase tracking-widest">
						{t("title")}
					</span>
				</div>
				<div className="flex-1" />
				<div className="titlebar-no-drag flex items-center">
					<Tooltip content={t("close")}>
						<Button
							aria-label={t("close")}
							className="flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-colors duration-150 hover:bg-error hover:text-white"
							onClick={windowCloseSelf}
						>
							<HugeiconsIcon icon={Cancel01Icon} size={12} />
						</Button>
					</Tooltip>
				</div>
			</header>

			{/* Content — hidden until electron-store settings are loaded to prevent default→saved flash */}
			{isLoaded ? (
				<Tabs.Root
					className="flex flex-1 overflow-hidden"
					defaultValue="general"
					orientation="vertical"
				>
					<SettingsSidebar links={links} onReset={resetSettings} />
					<ScrollArea className="flex-1 bg-surface" viewportClassName="p-4">
						<Tabs.Panel value="general">
							<GeneralSettingsPanel />
						</Tabs.Panel>
						<Tabs.Panel value="model">
							<ModelSettingsPanel llmSlot={llmSettingsSlot} />
						</Tabs.Panel>
						<Tabs.Panel value="audio">
							<AudioSettingsPanel />
						</Tabs.Panel>
						<Tabs.Panel value="quality">
							<QualitySettingsPanel />
						</Tabs.Panel>
						<Tabs.Panel value="hotkey">
							<HotkeySettingsPanel />
						</Tabs.Panel>
						<Tabs.Panel value="dictionary">
							<DictionarySettingsPanel />
						</Tabs.Panel>
						<Tabs.Panel value="snippets">
							<SnippetsSettingsPanel />
						</Tabs.Panel>
						<Tabs.Panel value="desktop">
							<DesktopToolsSettingsPanel />
						</Tabs.Panel>
						<Tabs.Panel value="history">
							<TranscriptionHistoryPanel />
						</Tabs.Panel>
					</ScrollArea>
				</Tabs.Root>
			) : (
				<div className="flex-1 bg-surface" />
			)}
		</div>
	);
}
