import { CommandIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { type ForbiddenCombo, HotkeyRecorder } from "@/features/record-hotkey";
import { FormControl } from "@/shared/ui/form-control";
import {
	claimDefaultShortcutBinding,
	type ShortcutBindingId,
} from "../lib/reset-shortcut";
import { HotkeyShortcutsLegend } from "./HotkeyShortcutsLegend";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function ShortcutsSettingsPanel() {
	const [resetErrors, setResetErrors] = useState<
		Partial<Record<ShortcutBindingId, string>>
	>({});
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
	const profileSwapHotkey = useSettingsStore(
		(s) => s.settings.llm?.profileSwapHotkey ?? "",
	);
	const updateLlm = useSettingsStore((s) => s.updateLlmSettings);
	const updateTransforms = useSettingsStore((s) => s.updateLlmTransforms);
	// A hotkey is meaningless while its feature is off — the backend doesn't even
	// register it (see `reconcile_winstt_hotkeys`, gated on the same flags). Mirror
	// that here: keep the row VISIBLE (so users know the shortcut exists) but
	// disabled (dimmed + non-interactive) until the feature is enabled.
	const ttsEnabled = useSettingsStore((s) => s.settings.tts?.enabled ?? false);
	const transformsEnabled = useSettingsStore(
		(s) => s.settings.llm?.transforms?.enabled ?? false,
	);
	const postProcessingEnabled = useSettingsStore(
		(s) =>
			Boolean(s.settings.llm?.dictation?.enabled) ||
			Boolean(s.settings.llm?.transforms?.enabled),
	);
	const th = useTranslations("hotkey");
	const tt = useTranslations("tts");
	const tl = useTranslations("llm");
	const pttKey = hotkey?.pushToTalkKey ?? DEFAULT_SETTINGS.hotkey.pushToTalkKey;
	// Each recorder must reject anything equal-to / subset-of / superset-of the
	// OTHER bindings — otherwise pressing one hotkey would also satisfy the
	// matcher for another. Labels are localized here so the inline error names
	// the colliding binding by its visible setting name.
	const pttLabel = th("conflictOtherPushToTalk");
	const repasteLabel = th("conflictOtherRepaste");
	const ttsLabel = th("conflictOtherTts");
	const transformLabel = tl("subTransformTitle");
	const profileSwapLabel = "Post processing profile swap";
	const pttForbidden: ForbiddenCombo[] = [
		{ combo: repasteHotkey, label: repasteLabel },
		{ combo: ttsHotkey, label: ttsLabel },
		{ combo: transformHotkey, label: transformLabel },
		{ combo: profileSwapHotkey, label: profileSwapLabel },
	];
	const repasteForbidden: ForbiddenCombo[] = [
		{ combo: pttKey, label: pttLabel },
		{ combo: ttsHotkey, label: ttsLabel },
		{ combo: transformHotkey, label: transformLabel },
		{ combo: profileSwapHotkey, label: profileSwapLabel },
	];
	const ttsForbidden: ForbiddenCombo[] = [
		{ combo: pttKey, label: pttLabel },
		{ combo: repasteHotkey, label: repasteLabel },
		{ combo: transformHotkey, label: transformLabel },
		{ combo: profileSwapHotkey, label: profileSwapLabel },
	];
	const transformForbidden: ForbiddenCombo[] = [
		{ combo: pttKey, label: pttLabel },
		{ combo: repasteHotkey, label: repasteLabel },
		{ combo: ttsHotkey, label: ttsLabel },
		{ combo: profileSwapHotkey, label: profileSwapLabel },
	];
	const profileSwapForbidden: ForbiddenCombo[] = [
		{ combo: pttKey, label: pttLabel },
		{ combo: repasteHotkey, label: repasteLabel },
		{ combo: ttsHotkey, label: ttsLabel },
		{ combo: transformHotkey, label: transformLabel },
	];
	const clearResetError = (id: ShortcutBindingId) => {
		setResetErrors((current) => {
			if (!(id in current)) {
				return current;
			}
			const next = { ...current };
			delete next[id];
			return next;
		});
	};
	const resetShortcut = (id: ShortcutBindingId, applyDefault: () => void) => {
		clearResetError(id);
		void claimDefaultShortcutBinding(id)
			.then(() => {
				clearResetError(id);
				applyDefault();
			})
			.catch((error: unknown) => {
				setResetErrors((current) => ({
					...current,
					[id]: errorMessage(error),
				}));
			});
	};

	return (
		<div className="flex flex-col gap-2">
			{/* ── Hotkey (Push-to-Talk disabled in Listen mode — the hotkey
			    isn't used to start/stop a server-driven listen session) */}
			<SettingSection
				boxed
				divided
				icon={CommandIcon}
				title={th("configuration")}
			>
				<SettingField
					disabled={recordingMode === "listen"}
					error={resetErrors.transcribe}
					isDefault={pttKey === DEFAULT_SETTINGS.hotkey.pushToTalkKey}
					label={th("pushToTalkKey")}
					layout="row"
					onReset={() =>
						resetShortcut("transcribe", () =>
							updateHotkey({
								pushToTalkKey: DEFAULT_SETTINGS.hotkey.pushToTalkKey,
							}),
						)
					}
					tooltip={th("pushToTalkKeyTooltip")}
				>
					<HotkeyRecorder
						currentKey={pttKey}
						forbiddenCombos={pttForbidden}
						hotkeyId="transcribe"
						onKeyRecorded={(key) => {
							clearResetError("transcribe");
							updateHotkey({ pushToTalkKey: key });
						}}
					/>
				</SettingField>
				<SettingField
					error={resetErrors.repaste}
					isDefault={repasteHotkey === DEFAULT_SETTINGS.general.repasteHotkey}
					label={th("repasteKey")}
					layout="row"
					onReset={() =>
						resetShortcut("repaste", () =>
							updateGeneral({
								repasteHotkey: DEFAULT_SETTINGS.general.repasteHotkey,
							}),
						)
					}
					tooltip={th("repasteKeyTooltip")}
				>
					<HotkeyRecorder
						currentKey={repasteHotkey}
						forbiddenCombos={repasteForbidden}
						hotkeyId="repaste"
						onKeyRecorded={(key) => {
							clearResetError("repaste");
							updateGeneral({ repasteHotkey: key });
						}}
					/>
				</SettingField>
				<SettingField
					disabled={!ttsEnabled}
					error={resetErrors.read_aloud}
					isDefault={ttsHotkey === DEFAULT_SETTINGS.tts.hotkey}
					label={tt("hotkeyLabel")}
					layout="row"
					onReset={() =>
						resetShortcut("read_aloud", () =>
							updateTts({ hotkey: DEFAULT_SETTINGS.tts.hotkey }),
						)
					}
					tooltip={tt("hotkeyHint")}
				>
					<HotkeyRecorder
						currentKey={ttsHotkey}
						forbiddenCombos={ttsForbidden}
						hotkeyId="read_aloud"
						onKeyRecorded={(key) => {
							clearResetError("read_aloud");
							updateTts({ hotkey: key });
						}}
					/>
				</SettingField>
				{/* Profile-swap hotkey: global combo that cycles saved post-processing
				    profiles using the order from the LLM settings profile picker. */}
				<SettingField
					disabled={!postProcessingEnabled}
					error={resetErrors.post_processing_profile_swap}
					isDefault={
						profileSwapHotkey === DEFAULT_SETTINGS.llm.profileSwapHotkey
					}
					label={profileSwapLabel}
					layout="row"
					onReset={() =>
						resetShortcut("post_processing_profile_swap", () =>
							updateLlm({
								profileSwapHotkey: DEFAULT_SETTINGS.llm.profileSwapHotkey,
							}),
						)
					}
					tooltip="Press this combo from any app to cycle through saved post-processing profiles in the order shown in LLM Post-Processing."
				>
					<HotkeyRecorder
						currentKey={profileSwapHotkey}
						forbiddenCombos={profileSwapForbidden}
						hotkeyId="post_processing_profile_swap"
						onKeyRecorded={(key) => {
							clearResetError("post_processing_profile_swap");
							updateLlm({ profileSwapHotkey: key });
						}}
					/>
				</SettingField>
				{/* ── Text-transformation hotkey — global combo that runs the
				    composed LLM transform on the current selection. Lives here
				    with the other global hotkeys; the transforms feature itself
				    is configured in the Text-transformation settings. */}
				<SettingField
					disabled={!transformsEnabled}
					error={resetErrors.transforms}
					isDefault={transformHotkey === DEFAULT_SETTINGS.llm.transforms.hotkey}
					label={tl("subTransformTitle")}
					layout="row"
					onReset={() =>
						resetShortcut("transforms", () =>
							updateTransforms({
								hotkey: DEFAULT_SETTINGS.llm.transforms.hotkey,
							}),
						)
					}
					tooltip={`${tl("transformHotkeyTooltip")} ${tl("transformHotkeyCaption")}`}
				>
					<HotkeyRecorder
						currentKey={transformHotkey}
						forbiddenCombos={transformForbidden}
						hotkeyId="transforms"
						onKeyRecorded={(key) => {
							clearResetError("transforms");
							updateTransforms({ hotkey: key });
						}}
					/>
				</SettingField>
				<FormControl
					label={th("shortcutsLegendLabel")}
					tooltip={`${th("shortcutsLegendTooltip")} ${th("shortcutsLegendCaption")}`}
				>
					{/* The legend reads the same hotkey state the recorder
					    above writes, so changing the binding above
					    instantly re-tints the central hub here. */}
					<HotkeyShortcutsLegend disabled={recordingMode === "listen"} />
				</FormControl>
			</SettingSection>
		</div>
	);
}
