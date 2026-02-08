"use client";

import { SettingSection } from "@/entities/setting";
import { HotkeyRecorder } from "@/features/record-hotkey";
import { useSettingsStore } from "@/features/update-settings";
import { FormControl } from "@/shared/ui/form-control";

export function HotkeySettingsPanel() {
	const hotkey = useSettingsStore((s) => s.settings.hotkey);
	const updateHotkey = useSettingsStore((s) => s.updateHotkeySettings);

	return (
		<SettingSection title="Hotkey Configuration">
			<div style={{ padding: "8px 0" }}>
				<FormControl caption="Press to start recording, release to stop" label="Push-to-Talk Key">
					<HotkeyRecorder
						currentKey={hotkey?.pushToTalkKey ?? "Space"}
						onKeyRecorded={(key) => updateHotkey({ pushToTalkKey: key })}
					/>
				</FormControl>
			</div>
		</SettingSection>
	);
}
