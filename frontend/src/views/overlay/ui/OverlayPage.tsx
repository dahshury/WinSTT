"use client";

import { useEffect } from "react";
import { useSettingsStore } from "@/entities/setting";
import { AudioVisualizer, useVisualizerSync } from "@/features/audio-visualizer";
import { useTranscriptionFeed, useTranscriptionStore } from "@/features/live-transcription";
import { onSettingsChanged } from "@/shared/api/ipc-client";
import { decodeSettingsPayload } from "@/shared/api/settings-codec";

type SizePreset = "xs" | "sm" | "md" | "lg" | "xl";

// Visible visualizer height in pixels for each preset.
const PRESET_HEIGHT_PX: Record<SizePreset, number> = {
	xs: 12,
	sm: 18,
	md: 24,
	lg: 32,
	xl: 44,
};

// Native height of the visualizer's `icon` preset (matches `barContainerVariants`
// in AudioVisualizerBar.tsx). Used to compute the zoom factor.
const ICON_PRESET_PX = 24;

// Older builds persisted `visualizerSize` as an integer pixel value; zustand's
// localStorage hydration runs before the IPC settingsLoad reconciles, so we
// can briefly observe a stale number here. Coerce anything unrecognized to xs.
function toPreset(value: unknown): SizePreset {
	return value === "xs" || value === "sm" || value === "md" || value === "lg" || value === "xl"
		? value
		: "xs";
}

export function OverlayPage() {
	useVisualizerSync();
	useTranscriptionFeed();

	const setSettings = useSettingsStore((s) => s.setSettings);
	const sizePreset = useSettingsStore((s) => toPreset(s.settings.general?.visualizerSize));
	const showLiveTranscription = useSettingsStore(
		(s) => s.settings.general?.showLiveTranscription ?? true
	);

	const realtime = useTranscriptionStore((s) => s.currentRealtime);
	const ephemeral = useTranscriptionStore((s) => s.ephemeral);

	useEffect(() => {
		const unsub = onSettingsChanged((incoming) => {
			setSettings(decodeSettingsPayload(incoming));
		});
		return unsub;
	}, [setSettings]);

	const text = realtime.trim() || ephemeral?.text || "";
	const showText = showLiveTranscription && text.length > 0;

	const heightPx = PRESET_HEIGHT_PX[sizePreset];
	// CSS `zoom` (Chromium-supported, including Electron) scales both visual and
	// layout box, so the surrounding flex container auto-sizes around the visualizer.
	const zoom = heightPx / ICON_PRESET_PX;

	return (
		<div className="flex h-screen w-screen items-end justify-center overflow-hidden pb-2">
			{/* Single rounded rectangle wraps visualizer + text. `inline-flex` makes it
			    auto-size to its content; the rectangle grows downward as text wraps. */}
			<div className="inline-flex max-w-[460px] flex-col items-center gap-1 overflow-hidden rounded-2xl bg-black/60 px-2.5 py-1 backdrop-blur-md">
				<div className="flex items-center justify-center" style={{ zoom }}>
					<AudioVisualizer size="icon" />
				</div>
				{showText && (
					<div className="line-clamp-5 break-words text-center text-sm text-white leading-tight">
						{text}
					</div>
				)}
			</div>
		</div>
	);
}
