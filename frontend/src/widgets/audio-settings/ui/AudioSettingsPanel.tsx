import {
	DashboardCircleIcon,
	KeyboardIcon,
	Mic01Icon,
	VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { useInputDevices, useOutputDevices } from "@/entities/audio-device";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { type ForbiddenCombo, HotkeyRecorder } from "@/features/record-hotkey";
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
	// Each recorder must reject anything equal-to / subset-of / superset-of the
	// OTHER two bindings — otherwise pressing one hotkey would also satisfy the
	// matcher for another. Labels are localized here so the inline error names
	// the colliding binding by its visible setting name.
	const pttLabel = th("conflictOtherPushToTalk");
	const repasteLabel = th("conflictOtherRepaste");
	const ttsLabel = th("conflictOtherTts");
	const pttForbidden: ForbiddenCombo[] = [
		{ combo: repasteHotkey, label: repasteLabel },
		{ combo: ttsHotkey, label: ttsLabel },
	];
	const repasteForbidden: ForbiddenCombo[] = [
		{ combo: pttKey, label: pttLabel },
		{ combo: ttsHotkey, label: ttsLabel },
	];
	const ttsForbidden: ForbiddenCombo[] = [
		{ combo: pttKey, label: pttLabel },
		{ combo: repasteHotkey, label: repasteLabel },
	];
	const { devices, defaultDevice } = useInputDevices();
	const deviceOptions: SelectOption[] = (() => {
		const defaultLabel = defaultDevice
			? `${t("systemDefault")} (${defaultDevice.name})`
			: t("systemDefault");
		const opts: SelectOption[] = [{ id: "default", label: defaultLabel }];
		for (const d of devices) {
			opts.push({ id: String(d.index), label: d.name });
		}
		return opts;
	})();

	// Clamshell picker shares the device list but uses a "disabled" sentinel
	// instead of "default" — null = feature off (don't poll), whereas a
	// configured index = mic to swap to when the lid closes.
	const clamshellOptions: SelectOption[] = (() => {
		const opts: SelectOption[] = [{ id: "disabled", label: t("clamshellDisabled") }];
		for (const d of devices) {
			opts.push({ id: String(d.index), label: d.name });
		}
		return opts;
	})();

	const currentDeviceId =
		audio?.inputDeviceIndex == null ? "default" : String(audio.inputDeviceIndex);
	const currentClamshellId =
		audio?.clamshellMicrophone == null ? "disabled" : String(audio.clamshellMicrophone);
	const microphoneRelease = audio?.microphoneRelease ?? DEFAULT_SETTINGS.audio.microphoneRelease;
	const microphoneReleaseOptions: SelectOption[] = [
		{ id: "always", label: t("microphoneReleaseAlways") },
		{ id: "immediate", label: t("microphoneReleaseImmediate") },
		{ id: "sec30", label: t("microphoneReleaseSec30") },
		{ id: "min1", label: t("microphoneReleaseMin1") },
		{ id: "min5", label: t("microphoneReleaseMin5") },
	];

	// Renderer-side audio-output picker. Visible only when either the
	// recording chimes are enabled or TTS is enabled — those are the only
	// paths that actually emit playback. Hidden otherwise so the panel
	// doesn't carry a dead picker. Empty string == "system default"
	// (sentinel). The TTS player + the recording-chime player both call
	// setSinkId(deviceId) and treat the empty string as "leave at default."
	const outputDeviceId = useSettingsStore((s) => s.settings.general?.outputDeviceId ?? "");
	const recordingSoundEnabled = useSettingsStore((s) => s.settings.general?.recordingSound ?? true);
	const ttsEnabled = useSettingsStore((s) => s.settings.tts?.enabled ?? false);
	const { devices: outputDevices, defaultDevice: defaultOutputDevice } = useOutputDevices();
	const showOutputDevice = recordingSoundEnabled || ttsEnabled;
	const outputDeviceOptions: SelectOption[] = (() => {
		const defaultLabel = defaultOutputDevice
			? `${t("systemDefault")} (${defaultOutputDevice.label})`
			: t("systemDefault");
		const opts: SelectOption[] = [{ id: "", label: defaultLabel }];
		for (const d of outputDevices) {
			// Skip the "default" sentinel — Chromium emits a dedicated row
			// for it before the real default device. The empty string above
			// already represents the same concept.
			if (d.deviceId === "default" || d.deviceId === "") {
				continue;
			}
			opts.push({ id: d.deviceId, label: d.label });
		}
		return opts;
	})();

	return (
		<div className="flex flex-col gap-2">
			{/* ── Input Device (hidden in Listen mode — loopback device is used instead) */}
			{recordingMode !== "listen" && (
				<SettingSection icon={Mic01Icon} title={t("inputDevice")}>
					<div className="flex flex-col divide-y divide-surface-1">
						<FormControl label={t("device")} layout="row" tooltip={t("deviceTooltip")}>
							<ElevatedSurface className="w-52" inline>
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
						{/* Clamshell mic — auto-swap when the laptop lid closes. The
						    polling detector lives in the Electron main process; the
						    setting persists across launches. macOS + Linux supported;
						    Windows is a documented v1.1 deferral. */}
						<FormControl label={t("clamshellLabel")} layout="row" tooltip={t("clamshellTooltip")}>
							<ElevatedSurface className="w-52" inline>
								<Select
									onChange={(v) =>
										update({
											clamshellMicrophone: v === "disabled" ? null : Number.parseInt(v, 10),
										})
									}
									options={clamshellOptions}
									value={currentClamshellId}
								/>
							</ElevatedSurface>
						</FormControl>
					</div>
				</SettingSection>
			)}

			{/* ── Output Device (renderer-side; deviceId is consumed by
			    HTMLAudioElement.setSinkId for chimes and AudioContext for TTS).
			    Independent of recording mode — TTS runs regardless. */}
			{showOutputDevice && (
				<SettingSection icon={VolumeHighIcon} title={t("outputDevice")}>
					<div className="flex flex-col divide-y divide-surface-1">
						<FormControl label={t("outputDevice")} layout="row" tooltip={t("outputDeviceTooltip")}>
							<ElevatedSurface className="w-52" inline>
								<Select
									onChange={(v) => updateGeneral({ outputDeviceId: v })}
									options={outputDeviceOptions}
									value={outputDeviceId}
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
								forbiddenCombos={pttForbidden}
								onKeyRecorded={(key) => updateHotkey({ pushToTalkKey: key })}
							/>
						</FormControl>
					</div>
					<div className="py-2">
						<FormControl
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
								forbiddenCombos={repasteForbidden}
								onKeyRecorded={(key) => updateGeneral({ repasteHotkey: key })}
							/>
						</FormControl>
					</div>
					<div className="py-2">
						<FormControl
							label={tt("hotkeyLabel")}
							labelTrailing={
								<SettingResetButton
									isDefault={ttsHotkey === DEFAULT_SETTINGS.tts.hotkey}
									onReset={() => updateTts({ hotkey: DEFAULT_SETTINGS.tts.hotkey })}
								/>
							}
							tooltip={tt("hotkeyHint")}
						>
							<HotkeyRecorder
								currentKey={ttsHotkey}
								forbiddenCombos={ttsForbidden}
								onKeyRecorded={(key) => updateTts({ hotkey: key })}
							/>
						</FormControl>
					</div>
					<div className="py-3">
						<FormControl
							label={th("shortcutsLegendLabel")}
							tooltip={`${th("shortcutsLegendTooltip")} ${th("shortcutsLegendCaption")}`}
						>
							{/* The legend reads the same hotkey state the recorder
							    above writes, so changing the binding above
							    instantly re-tints the central hub here. */}
							<HotkeyShortcutsLegend disabled={recordingMode === "listen"} />
						</FormControl>
					</div>
				</div>
			</SettingSection>

			{/* ── Advanced — consolidated mic-release picker. Replaces the
			    original "always-on toggle + dependent lazy
			    toggle" pair with a single Select that covers the five
			    discrete behaviors (always / immediate / 30s / 1m / 5m).
			    STARTUP_ONLY — PyAudioSource reads the resulting flags
			    once at construction. */}
			<SettingSection icon={DashboardCircleIcon} title={t("advancedTitle")}>
				<div className="flex flex-col divide-y divide-surface-1">
					<FormControl
						label={t("microphoneRelease")}
						layout="row"
						tooltip={t("microphoneReleaseTooltip")}
					>
						<ElevatedSurface className="w-52" inline>
							<Select
								onChange={(v) =>
									update({
										microphoneRelease: v as "always" | "immediate" | "sec30" | "min1" | "min5",
									})
								}
								options={microphoneReleaseOptions}
								value={microphoneRelease}
							/>
						</ElevatedSurface>
					</FormControl>
				</div>
			</SettingSection>
		</div>
	);
}
