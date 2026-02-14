"use client";

import { Tabs } from "@base-ui/react/tabs";
import { Tooltip } from "@base-ui/react/tooltip";
import {
	AiChat02Icon,
	Cancel01Icon,
	CpuChargeIcon,
	KeyboardIcon,
	ListSettingIcon,
	Mic01Icon,
	MinusSignIcon,
	Note01Icon,
	TextIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useSettingsStore, useSyncSettings } from "@/features/update-settings";
import { windowCloseSelf, windowMinimize } from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import { AudioSettingsPanel } from "@/widgets/audio-settings";
import { DictionarySettingsPanel } from "@/widgets/dictionary-settings";
import { GeneralSettingsPanel } from "@/widgets/general-settings";
import { HotkeySettingsPanel } from "@/widgets/hotkey-settings";
import { ModelSettingsPanel } from "@/widgets/model-settings";
import { QualitySettingsPanel } from "@/widgets/quality-settings";
import { SnippetsSettingsPanel } from "@/widgets/snippets-settings";
import { SettingsSidebar, type SidebarLink } from "./SettingsSidebar";

export function SettingsPage() {
	const resetSettings = useSettingsStore((s) => s.resetSettings);
	const isLoaded = useSettingsStore((s) => s.isLoaded);
	useSyncSettings();
	const t = useTranslations("settings");

	const links: SidebarLink[] = [
		{ key: "general", label: t("tabGeneral"), icon: ListSettingIcon },
		{ key: "model", label: t("tabModel"), icon: AiChat02Icon },
		{ key: "audio", label: t("tabAudio"), icon: Mic01Icon },
		{ key: "quality", label: t("tabProcessing"), icon: CpuChargeIcon },
		{ key: "hotkey", label: t("tabHotkey"), icon: KeyboardIcon },
		{ key: "dictionary", label: t("tabDictionary"), icon: TextIcon },
		{ key: "snippets", label: t("tabSnippets"), icon: Note01Icon },
	];

	return (
		<Tooltip.Provider closeDelay={0} delay={400}>
			<div className="noise-overlay flex h-screen flex-col bg-surface-secondary">
				{/* Title bar — always visible so the window is draggable/closeable */}
				<header className="titlebar-drag flex h-8 shrink-0 items-stretch border-border border-b bg-surface-primary">
					<div className="flex items-center pl-3">
						<span className="font-mono text-[11px] text-foreground-muted uppercase tracking-widest">
							{t("title")}
						</span>
					</div>
					<div className="flex-1" />
					<div className="titlebar-no-drag flex items-center">
						<Button
							aria-label={t("minimize")}
							className="flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground-secondary"
							onClick={windowMinimize}
						>
							<HugeiconsIcon icon={MinusSignIcon} size={12} />
						</Button>
						<Button
							aria-label={t("close")}
							className="flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-colors duration-150 hover:bg-error hover:text-white"
							onClick={windowCloseSelf}
						>
							<HugeiconsIcon icon={Cancel01Icon} size={12} />
						</Button>
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
						<div className="flex-1 overflow-auto bg-surface p-4">
							<Tabs.Panel value="general">
								<GeneralSettingsPanel />
							</Tabs.Panel>
							<Tabs.Panel value="model">
								<ModelSettingsPanel />
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
						</div>
					</Tabs.Root>
				) : (
					<div className="flex-1 bg-surface" />
				)}
			</div>
		</Tooltip.Provider>
	);
}
