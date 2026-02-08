"use client";

import { SettingSection } from "@/entities/setting";
import { useSettingsStore } from "@/features/update-settings";
import { FormControl } from "@/shared/ui/form-control";
import { Toggle } from "@/shared/ui/toggle";

export function GeneralSettingsPanel() {
	const general = useSettingsStore((s) => s.settings.general);
	const update = useSettingsStore((s) => s.updateGeneralSettings);

	return (
		<SettingSection title="General">
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
				<FormControl caption="Launch WinSTT when your device starts" label="Start on Login">
					<Toggle
						checked={general?.autoStart ?? false}
						onCheckedChange={(v) => update({ autoStart: v })}
					/>
				</FormControl>
				<FormControl caption="Keep running in system tray" label="Minimize to Tray">
					<Toggle
						checked={general?.minimizeToTray ?? true}
						onCheckedChange={(v) => update({ minimizeToTray: v })}
					/>
				</FormControl>
				<FormControl caption="Start in system tray" label="Start Minimized">
					<Toggle
						checked={general?.startMinimized ?? false}
						onCheckedChange={(v) => update({ startMinimized: v })}
					/>
				</FormControl>
				<FormControl
					caption="Mute speakers while dictating"
					label="Mute System Audio"
					tooltip="Silences your system speakers while you're dictating. Prevents feedback loops and keeps transcription clean if you use speakers instead of headphones."
				>
					<Toggle
						checked={general?.muteSystemAudioWhileDictating ?? false}
						onCheckedChange={(v) => update({ muteSystemAudioWhileDictating: v })}
					/>
				</FormControl>
			</div>
		</SettingSection>
	);
}
