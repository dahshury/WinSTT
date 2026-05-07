"use client";

import { KeyboardIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { HotkeyRecorder } from "@/features/record-hotkey";
import { FormControl } from "@/shared/ui/form-control";

export function HotkeySettingsPanel() {
	const hotkey = useSettingsStore((s) => s.settings.hotkey);
	const updateHotkey = useSettingsStore((s) => s.updateHotkeySettings);
	const t = useTranslations("hotkey");

	return (
		<SettingSection icon={KeyboardIcon} title={t("configuration")}>
			<div className="py-2">
				<FormControl
					caption={t("pushToTalkKeyCaption")}
					label={t("pushToTalkKey")}
					tooltip={t("pushToTalkKeyTooltip")}
				>
					<HotkeyRecorder
						currentKey={hotkey?.pushToTalkKey ?? "LCtrl+LMeta"}
						onKeyRecorded={(key) => updateHotkey({ pushToTalkKey: key })}
					/>
				</FormControl>
			</div>
		</SettingSection>
	);
}
