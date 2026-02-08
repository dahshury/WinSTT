"use client";

import { Tabs } from "@base-ui/react/tabs";
import { Tooltip } from "@base-ui/react/tooltip";
import {
	AiChat02Icon,
	Cancel01Icon,
	Configuration01Icon,
	KeyboardIcon,
	Mic01Icon,
	MinusSignIcon,
	Note01Icon,
	SlidersHorizontalIcon,
	TextIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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

const LINKS: SidebarLink[] = [
	{ key: "general", label: "General", icon: Configuration01Icon },
	{ key: "model", label: "Model", icon: AiChat02Icon },
	{ key: "audio", label: "Audio", icon: Mic01Icon },
	{ key: "quality", label: "Processing", icon: SlidersHorizontalIcon },
	{ key: "hotkey", label: "Hotkey", icon: KeyboardIcon },
	{ key: "dictionary", label: "Dictionary", icon: TextIcon },
	{ key: "snippets", label: "Snippets", icon: Note01Icon },
];

export function SettingsPage() {
	const resetSettings = useSettingsStore((s) => s.resetSettings);
	useSyncSettings();

	return (
		<Tooltip.Provider closeDelay={0} delay={400}>
			<div className="noise-overlay flex h-screen flex-col bg-surface-secondary">
				{/* Title bar */}
				<header className="titlebar-drag flex h-8 shrink-0 items-stretch border-border border-b bg-surface-primary">
					<div className="flex items-center pl-3">
						<span className="font-mono text-[11px] text-foreground-muted uppercase tracking-widest">
							Settings
						</span>
					</div>
					<div className="flex-1" />
					<div className="titlebar-no-drag flex items-center">
						<Button
							className="flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground-secondary"
							onClick={windowMinimize}
						>
							<HugeiconsIcon icon={MinusSignIcon} size={12} />
						</Button>
						<Button
							className="flex h-full w-10 rounded-none bg-transparent p-0 text-foreground-muted transition-colors duration-150 hover:bg-[#dc2626] hover:text-white"
							onClick={windowCloseSelf}
						>
							<HugeiconsIcon icon={Cancel01Icon} size={12} />
						</Button>
					</div>
				</header>

				{/* Content */}
				<Tabs.Root
					className="flex flex-1 overflow-hidden"
					defaultValue="general"
					orientation="vertical"
				>
					<SettingsSidebar links={LINKS} onReset={resetSettings} />
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
			</div>
		</Tooltip.Provider>
	);
}
