"use client";

import { useEffect } from "react";
import { useSettingsStore } from "@/entities/setting";
import { AudioVisualizer, useVisualizerSync } from "@/features/audio-visualizer";
import { useTranscriptionFeed, useTranscriptionStore } from "@/features/live-transcription";
import { onSettingsChanged } from "@/shared/api/ipc-client";
import { decodeSettingsPayload } from "@/shared/api/settings-codec";

export function OverlayPage() {
	useVisualizerSync();
	useTranscriptionFeed();

	const setSettings = useSettingsStore((s) => s.setSettings);
	const visualizerSize = useSettingsStore((s) => s.settings.general?.visualizerSize ?? 20);
	const showLiveTranscription = useSettingsStore(
		(s) => s.settings.general?.showLiveTranscription ?? true
	);

	const realtime = useTranscriptionStore((s) => s.currentRealtime);
	const ephemeral = useTranscriptionStore((s) => s.ephemeral);

	// Stay in sync when other windows save settings (settings window, tray, etc.).
	useEffect(() => {
		const unsub = onSettingsChanged((incoming) => {
			setSettings(decodeSettingsPayload(incoming));
		});
		return unsub;
	}, [setSettings]);

	const text = realtime.trim() || ephemeral?.text || "";

	// `icon` preset is 24px tall. Scale it to the user's chosen pixel size so the
	// visualizer stays crisp without clipping at sizes below the preset.
	const ICON_PRESET_PX = 24;
	const scale = visualizerSize / ICON_PRESET_PX;

	return (
		<div className="flex h-screen w-screen flex-col items-center justify-end gap-2 overflow-hidden pb-2">
			<div
				className="flex shrink-0 items-center justify-center rounded-full bg-black/60 backdrop-blur-md"
				style={{ width: visualizerSize, height: visualizerSize }}
			>
				<div style={{ transform: `scale(${scale})`, transformOrigin: "center" }}>
					<AudioVisualizer size="icon" />
				</div>
			</div>

			{showLiveTranscription && text && (
				<div className="max-w-[90%] truncate rounded-md bg-black/60 px-3 py-1 text-center text-sm text-white backdrop-blur-md">
					{text}
				</div>
			)}
		</div>
	);
}
