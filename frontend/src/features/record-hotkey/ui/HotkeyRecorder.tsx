"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { cn } from "@/shared/lib/cn";
import { formatKeyName } from "@/shared/lib/format-key-name";
import { Button } from "@/shared/ui/button";
import { useKeyRecorder } from "../model/use-key-recorder";

export interface HotkeyRecorderProps {
	currentKey: string;
	onKeyRecorded: (key: string) => void;
}

function formatCombo(combo: string): string {
	return combo.split("+").map(formatKeyName).join(" + ");
}

export function HotkeyRecorder({ currentKey, onKeyRecorded }: HotkeyRecorderProps) {
	const { recording, key, liveKeys, startRecording, stopRecording } = useKeyRecorder();
	const t = useTranslations("hotkey");

	useEffect(() => {
		if (key && !recording) {
			onKeyRecorded(key);
		}
	}, [key, recording, onKeyRecorded]);

	function getDisplayText(): string {
		if (!recording) {
			return formatCombo(currentKey);
		}
		if (liveKeys.length > 0) {
			return liveKeys.map(formatKeyName).join(" + ");
		}
		return t("pressKeys");
	}

	return (
		<div className="flex items-center gap-2">
			{/* Display box */}
			<div
				className={cn(
					"flex h-8 min-w-[140px] items-center justify-center rounded-md border px-3 font-mono text-xs transition-all duration-150",
					recording
						? "border-border-accent bg-accent-dim text-accent"
						: "border-border bg-surface-tertiary text-foreground"
				)}
			>
				{getDisplayText()}
			</div>

			{/* Record / Stop toggle */}
			<Button
				className={cn(
					"h-8 rounded-md border px-3 font-medium text-xs transition-all duration-150",
					recording
						? "border-red-500/40 bg-red-950 text-red-400 hover:bg-red-900"
						: "border-border bg-surface-tertiary text-foreground-secondary hover:bg-surface-hover"
				)}
				onClick={recording ? stopRecording : startRecording}
			>
				{recording ? t("stop") : t("record")}
			</Button>
		</div>
	);
}
