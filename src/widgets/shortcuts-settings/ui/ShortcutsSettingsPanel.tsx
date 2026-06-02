import { KeyboardIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { type ForbiddenCombo, HotkeyRecorder } from "@/features/record-hotkey";
import { FormControl } from "@/shared/ui/form-control";
import { HotkeyShortcutsLegend } from "./HotkeyShortcutsLegend";

export function ShortcutsSettingsPanel() {
	const recordingMode = useSettingsStore((s) => s.settings.general?.recordingMode ?? "ptt");
	const hotkey = useSettingsStore((s) => s.settings.hotkey);
	const updateHotkey = useSettingsStore((s) => s.updateHotkeySettings);
	const repasteHotkey = useSettingsStore((s) => s.settings.general?.repasteHotkey ?? "");
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const ttsHotkey = useSettingsStore((s) => s.settings.tts?.hotkey ?? "");
	const updateTts = useSettingsStore((s) => s.updateTtsSettings);
	const transformHotkey = useSettingsStore((s) => s.settings.llm?.transforms?.hotkey ?? "");
	const updateTransforms = useSettingsStore((s) => s.updateLlmTransforms);
	const th = useTranslations("hotkey");
	const tt = useTranslations("tts");
	const tl = useTranslations("llm");
	const pttKey = hotkey?.pushToTalkKey ?? DEFAULT_SETTINGS.hotkey.pushToTalkKey;
	// Each recorder must reject anything equal-to / subset-of / superset-of the
	// OTHER three bindings — otherwise pressing one hotkey would also satisfy the
	// matcher for another. Labels are localized here so the inline error names
	// the colliding binding by its visible setting name.
	const pttLabel = th("conflictOtherPushToTalk");
	const repasteLabel = th("conflictOtherRepaste");
	const ttsLabel = th("conflictOtherTts");
	const transformLabel = tl("subTransformTitle");
	const pttForbidden: ForbiddenCombo[] = [
		{ combo: repasteHotkey, label: repasteLabel },
		{ combo: ttsHotkey, label: ttsLabel },
		{ combo: transformHotkey, label: transformLabel },
	];
	const repasteForbidden: ForbiddenCombo[] = [
		{ combo: pttKey, label: pttLabel },
		{ combo: ttsHotkey, label: ttsLabel },
		{ combo: transformHotkey, label: transformLabel },
	];
	const ttsForbidden: ForbiddenCombo[] = [
		{ combo: pttKey, label: pttLabel },
		{ combo: repasteHotkey, label: repasteLabel },
		{ combo: transformHotkey, label: transformLabel },
	];
	const transformForbidden: ForbiddenCombo[] = [
		{ combo: pttKey, label: pttLabel },
		{ combo: repasteHotkey, label: repasteLabel },
		{ combo: ttsHotkey, label: ttsLabel },
	];

	return (
		<div className="flex flex-col gap-2">
			{/* ── Hotkey (Push-to-Talk disabled in Listen mode — the hotkey
			    isn't used to start/stop a server-driven listen session) */}
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
					{/* ── Text-transformation hotkey — global combo that runs the
					    composed LLM transform on the current selection. Lives here
					    with the other global hotkeys; the transforms feature itself
					    is configured in the Text-transformation settings. */}
					<div className="py-2">
						<FormControl
							label={tl("subTransformTitle")}
							labelTrailing={
								<SettingResetButton
									isDefault={transformHotkey === DEFAULT_SETTINGS.llm.transforms.hotkey}
									onReset={() =>
										updateTransforms({ hotkey: DEFAULT_SETTINGS.llm.transforms.hotkey })
									}
								/>
							}
							tooltip={`${tl("transformHotkeyTooltip")} ${tl("transformHotkeyCaption")}`}
						>
							<HotkeyRecorder
								currentKey={transformHotkey}
								forbiddenCombos={transformForbidden}
								onKeyRecorded={(key) => updateTransforms({ hotkey: key })}
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
		</div>
	);
}
