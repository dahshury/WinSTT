"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/shared/lib/cn";
import { formatKeyName } from "@/shared/lib/format-key-name";
import { Button } from "@/shared/ui/button";
import { useKeyRecorder } from "../model/use-key-recorder";

export interface HotkeyRecorderProps {
	currentKey: string;
	onKeyRecorded: (key: string) => void;
}

export function formatCombo(combo: string): string {
	return combo.split("+").map(formatKeyName).join(" + ");
}

/**
 * Resolves the text shown in the hotkey display box.
 * Extracted as a pure function for testability.
 */
export function resolveDisplayText(
	recording: boolean,
	liveKeys: string[],
	currentKey: string,
	pressKeysLabel: string
): string {
	if (!recording) {
		return formatCombo(currentKey);
	}
	if (liveKeys.length > 0) {
		return liveKeys.map(formatKeyName).join(" + ");
	}
	return pressKeysLabel;
}

const DISPLAY_CLASS_RECORDING = "border-orange/30 bg-orange-dim text-orange";
const DISPLAY_CLASS_IDLE = "border-border bg-surface-tertiary text-foreground";
const BTN_CLASS_RECORDING = "border-error/40 bg-error-dim text-error hover:bg-error/20";
const BTN_CLASS_IDLE =
	"border-border bg-surface-tertiary text-foreground-secondary hover:bg-surface-hover";

interface RecorderDisplayState {
	btnAction: () => void;
	btnClass: string;
	btnLabel: string;
	displayClass: string;
}

const RECORDER_STATE_RECORDING: Pick<RecorderDisplayState, "displayClass" | "btnClass"> = {
	displayClass: DISPLAY_CLASS_RECORDING,
	btnClass: BTN_CLASS_RECORDING,
};

const RECORDER_STATE_IDLE: Pick<RecorderDisplayState, "displayClass" | "btnClass"> = {
	displayClass: DISPLAY_CLASS_IDLE,
	btnClass: BTN_CLASS_IDLE,
};

export function resolveRecorderState(
	recording: boolean,
	stopFn: () => void,
	startFn: () => void,
	stopLabel: string,
	recordLabel: string
): RecorderDisplayState {
	const classes = recording ? RECORDER_STATE_RECORDING : RECORDER_STATE_IDLE;
	const btnLabel = recording ? stopLabel : recordLabel;
	const btnAction = recording ? stopFn : startFn;
	return { ...classes, btnLabel, btnAction };
}

export function HotkeyRecorder({ currentKey, onKeyRecorded }: HotkeyRecorderProps) {
	const { recording, liveKeys, startRecording, stopRecording } = useKeyRecorder({
		onKeyRecorded,
	});
	const t = useTranslations("hotkey");
	const displayText = resolveDisplayText(recording, liveKeys, currentKey, t("pressKeys"));
	const { displayClass, btnClass, btnLabel, btnAction } = resolveRecorderState(
		recording,
		stopRecording,
		startRecording,
		t("stop"),
		t("record")
	);

	return (
		<div className="flex items-center gap-2">
			{/* Display box */}
			<div
				className={cn(
					"flex h-8 min-w-[140px] items-center justify-center rounded-md border px-3 font-mono text-xs transition-[border-color,background-color,color] duration-150",
					displayClass
				)}
			>
				{displayText}
			</div>

			{/* Record / Stop toggle */}
			<Button
				className={cn(
					"h-8 rounded-md border px-3 font-medium text-xs transition-[border-color,background-color,color] duration-150",
					btnClass
				)}
				onClick={btnAction}
			>
				{btnLabel}
			</Button>
		</div>
	);
}
