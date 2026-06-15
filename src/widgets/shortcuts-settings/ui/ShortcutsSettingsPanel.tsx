import { CommandIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { type ForbiddenCombo, HotkeyRecorder } from "@/features/record-hotkey";
import { FormControl } from "@/shared/ui/form-control";
import { HotkeyShortcutsLegend } from "./HotkeyShortcutsLegend";

export function ShortcutsSettingsPanel() {
	const recordingMode = useSettingsStore(
		(s) => s.settings.general?.recordingMode ?? "ptt",
	);
	const hotkey = useSettingsStore((s) => s.settings.hotkey);
	const updateHotkey = useSettingsStore((s) => s.updateHotkeySettings);
	const repasteHotkey = useSettingsStore(
		(s) => s.settings.general?.repasteHotkey ?? "",
	);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const ttsHotkey = useSettingsStore((s) => s.settings.tts?.hotkey ?? "");
	const updateTts = useSettingsStore((s) => s.updateTtsSettings);
	const transformHotkey = useSettingsStore(
		(s) => s.settings.llm?.transforms?.hotkey ?? "",
	);
	const updateTransforms = useSettingsStore((s) => s.updateLlmTransforms);
	// A hotkey is meaningless while its feature is off — the backend doesn't even
	// register it (see `reconcile_winstt_hotkeys`, gated on the same flags). Mirror
	// that here: keep the row VISIBLE (so users know the shortcut exists) but
	// disabled (dimmed + non-interactive) until the feature is enabled.
	const ttsEnabled = useSettingsStore((s) => s.settings.tts?.enabled ?? false);
	const transformsEnabled = useSettingsStore(
		(s) => s.settings.llm?.transforms?.enabled ?? false,
	);
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
			<SettingSection icon={CommandIcon} title={th("configuration")}>
				<div className="flex flex-col">
					<div className="py-2">
						<SettingField
							disabled={recordingMode === "listen"}
							isDefault={pttKey === DEFAULT_SETTINGS.hotkey.pushToTalkKey}
							label={th("pushToTalkKey")}
							onReset={() =>
								updateHotkey({
									pushToTalkKey: DEFAULT_SETTINGS.hotkey.pushToTalkKey,
								})
							}
							tooltip={th("pushToTalkKeyTooltip")}
						>
							<HotkeyRecorder
								currentKey={pttKey}
								forbiddenCombos={pttForbidden}
								onKeyRecorded={(key) => updateHotkey({ pushToTalkKey: key })}
							/>
						</SettingField>
					</div>
					<div className="py-2">
						<SettingField
							isDefault={
								repasteHotkey === DEFAULT_SETTINGS.general.repasteHotkey
							}
							label={th("repasteKey")}
							onReset={() =>
								updateGeneral({
									repasteHotkey: DEFAULT_SETTINGS.general.repasteHotkey,
								})
							}
							tooltip={th("repasteKeyTooltip")}
						>
							<HotkeyRecorder
								currentKey={repasteHotkey}
								forbiddenCombos={repasteForbidden}
								onKeyRecorded={(key) => updateGeneral({ repasteHotkey: key })}
							/>
						</SettingField>
					</div>
					<div className="py-2">
						<SettingField
							disabled={!ttsEnabled}
							isDefault={ttsHotkey === DEFAULT_SETTINGS.tts.hotkey}
							label={tt("hotkeyLabel")}
							onReset={() => updateTts({ hotkey: DEFAULT_SETTINGS.tts.hotkey })}
							tooltip={tt("hotkeyHint")}
						>
							<HotkeyRecorder
								currentKey={ttsHotkey}
								forbiddenCombos={ttsForbidden}
								onKeyRecorded={(key) => updateTts({ hotkey: key })}
							/>
						</SettingField>
					</div>
					{/* ── Text-transformation hotkey — global combo that runs the
					    composed LLM transform on the current selection. Lives here
					    with the other global hotkeys; the transforms feature itself
					    is configured in the Text-transformation settings. */}
					<div className="py-2">
						<SettingField
							disabled={!transformsEnabled}
							isDefault={
								transformHotkey === DEFAULT_SETTINGS.llm.transforms.hotkey
							}
							label={tl("subTransformTitle")}
							onReset={() =>
								updateTransforms({
									hotkey: DEFAULT_SETTINGS.llm.transforms.hotkey,
								})
							}
							tooltip={`${tl("transformHotkeyTooltip")} ${tl("transformHotkeyCaption")}`}
						>
							<HotkeyRecorder
								currentKey={transformHotkey}
								forbiddenCombos={transformForbidden}
								onKeyRecorded={(key) => updateTransforms({ hotkey: key })}
							/>
						</SettingField>
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
