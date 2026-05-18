"use client";

import { KeyboardIcon, Mic01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { useInputDevices } from "@/entities/audio-device";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { HotkeyRecorder } from "@/features/record-hotkey";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Select, type SelectOption } from "@/shared/ui/select";
import { HotkeyShortcutsLegend } from "./HotkeyShortcutsLegend";

export function AudioSettingsPanel() {
	const audio = useSettingsStore((s) => s.settings.audio);
	const recordingMode = useSettingsStore((s) => s.settings.general?.recordingMode ?? "ptt");
	const update = useSettingsStore((s) => s.updateAudioSettings);
	const hotkey = useSettingsStore((s) => s.settings.hotkey);
	const updateHotkey = useSettingsStore((s) => s.updateHotkeySettings);
	const t = useTranslations("audio");
	const th = useTranslations("hotkey");
	const { devices, defaultDevice } = useInputDevices();
	const deviceOptions = useMemo<SelectOption[]>(() => {
		const defaultLabel = defaultDevice
			? `${t("systemDefault")} (${defaultDevice.name})`
			: t("systemDefault");
		const opts: SelectOption[] = [{ id: "default", label: defaultLabel }];
		for (const d of devices) {
			opts.push({ id: String(d.index), label: d.name });
		}
		return opts;
	}, [devices, defaultDevice, t]);

	const currentDeviceId =
		audio?.inputDeviceIndex == null ? "default" : String(audio.inputDeviceIndex);

	return (
		<div className="flex flex-col gap-2">
			{/* ── Input Device (hidden in Listen mode — loopback device is used instead) */}
			{recordingMode !== "listen" && (
				<SettingSection icon={Mic01Icon} title={t("inputDevice")}>
					<div className="flex flex-col divide-y divide-surface-1">
						<FormControl
							caption={t("deviceCaption")}
							label={t("device")}
							tooltip={t("deviceTooltip")}
						>
							<ElevatedSurface inline>
								<Select
									onChange={(v) =>
										update({
											inputDeviceIndex: v === "default" ? null : Number.parseInt(v, 10),
										})
									}
									options={deviceOptions}
									value={currentDeviceId}
								/>
							</ElevatedSurface>
						</FormControl>
					</div>
				</SettingSection>
			)}

			{/* ── Hotkey (disabled in Listen mode — the hotkey isn't used to
			    start/stop a server-driven listen session) */}
			<SettingSection icon={KeyboardIcon} title={th("configuration")}>
				<div className="flex flex-col divide-y divide-surface-1">
					<div className="py-2">
						<FormControl
							caption={
								recordingMode === "listen"
									? th("pushToTalkKeyCaptionDisabled")
									: th("pushToTalkKeyCaption")
							}
							disabled={recordingMode === "listen"}
							label={th("pushToTalkKey")}
							tooltip={th("pushToTalkKeyTooltip")}
						>
							<HotkeyRecorder
								currentKey={hotkey?.pushToTalkKey ?? "LCtrl+LMeta"}
								onKeyRecorded={(key) => updateHotkey({ pushToTalkKey: key })}
							/>
						</FormControl>
					</div>
					<div className="py-3">
						<FormControl
							caption={th("shortcutsLegendCaption")}
							label={th("shortcutsLegendLabel")}
							tooltip={th("shortcutsLegendTooltip")}
						>
							{/* The legend reads the same hotkey state the recorder
							    above writes, so changing the binding above
							    instantly re-tints the central hub here. */}
							<HotkeyShortcutsLegend disabled={recordingMode === "listen"} />
						</FormControl>
					</div>
				</div>
			</SettingSection>
		</div>
	);
}
