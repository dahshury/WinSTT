import { KeyboardIcon, Mic01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { useInputDevices } from "@/entities/audio-device";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
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
	const repasteHotkey = useSettingsStore((s) => s.settings.general?.repasteHotkey ?? "");
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const ttsHotkey = useSettingsStore((s) => s.settings.tts?.hotkey ?? "");
	const updateTts = useSettingsStore((s) => s.updateTtsSettings);
	const t = useTranslations("audio");
	const th = useTranslations("hotkey");
	const tt = useTranslations("tts");
	const pttKey = hotkey?.pushToTalkKey ?? DEFAULT_SETTINGS.hotkey.pushToTalkKey;
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
							labelTrailing={
								<SettingResetButton
									isDefault={pttKey === DEFAULT_SETTINGS.hotkey.pushToTalkKey}
									onReset={() =>
										updateHotkey({ pushToTalkKey: DEFAULT_SETTINGS.hotkey.pushToTalkKey })
									}
								/>
							}
							tooltip={th("pushToTalkKeyTooltip")}
						>
							<HotkeyRecorder
								currentKey={pttKey}
								onKeyRecorded={(key) => updateHotkey({ pushToTalkKey: key })}
							/>
						</FormControl>
					</div>
					<div className="py-2">
						<FormControl
							caption={th("repasteKeyCaption")}
							label={th("repasteKey")}
							labelTrailing={
								<SettingResetButton
									isDefault={repasteHotkey === DEFAULT_SETTINGS.general.repasteHotkey}
									onReset={() =>
										updateGeneral({ repasteHotkey: DEFAULT_SETTINGS.general.repasteHotkey })
									}
								/>
							}
							tooltip={th("repasteKeyTooltip")}
						>
							<HotkeyRecorder
								currentKey={repasteHotkey}
								onKeyRecorded={(key) => updateGeneral({ repasteHotkey: key })}
							/>
						</FormControl>
					</div>
					<div className="py-2">
						<FormControl
							caption={tt("hotkeyHint")}
							label={tt("hotkeyLabel")}
							labelTrailing={
								<SettingResetButton
									isDefault={ttsHotkey === DEFAULT_SETTINGS.tts.hotkey}
									onReset={() => updateTts({ hotkey: DEFAULT_SETTINGS.tts.hotkey })}
								/>
							}
						>
							<HotkeyRecorder
								currentKey={ttsHotkey}
								onKeyRecorded={(key) => updateTts({ hotkey: key })}
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
