"use client";

import { useEffect } from "react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { useKeyRecorder } from "../model/use-key-recorder";

export interface HotkeyRecorderProps {
	currentKey: string;
	onKeyRecorded: (key: string) => void;
}

export function HotkeyRecorder({ currentKey, onKeyRecorded }: HotkeyRecorderProps) {
	const { recording, key, startRecording } = useKeyRecorder();

	useEffect(() => {
		if (key && !recording) {
			onKeyRecorded(key);
		}
	}, [key, recording, onKeyRecorded]);

	return (
		<Button
			className={cn(
				"h-8 min-w-[100px] rounded-md border px-3 font-medium font-mono text-xs transition-all duration-150",
				recording
					? "animate-pulse-glow border-border-accent bg-accent-dim text-accent"
					: "border-border bg-surface-tertiary text-foreground hover:bg-surface-hover"
			)}
			onClick={startRecording}
		>
			{recording ? "Press a key..." : currentKey}
		</Button>
	);
}
