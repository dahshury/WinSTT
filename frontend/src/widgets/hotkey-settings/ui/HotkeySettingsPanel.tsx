"use client";

import { useTranslations } from "next-intl";
import { SettingSection } from "@/entities/setting";
import { HotkeyRecorder } from "@/features/record-hotkey";
import { useSettingsStore } from "@/features/update-settings";
import { FormControl } from "@/shared/ui/form-control";

export function HotkeySettingsPanel() {
	const hotkey = useSettingsStore((s) => s.settings.hotkey);
	const updateHotkey = useSettingsStore((s) => s.updateHotkeySettings);
	const t = useTranslations("hotkey");

	return (
		<SettingSection title={t("configuration")}>
			<div className="py-2">
				<FormControl caption={t("pushToTalkKeyCaption")} label={t("pushToTalkKey")}>
					<HotkeyRecorder
						currentKey={hotkey?.pushToTalkKey ?? "LCtrl+LMeta"}
						onKeyRecorded={(key) => updateHotkey({ pushToTalkKey: key })}
					/>
				</FormControl>
			</div>
		</SettingSection>
	);
}
