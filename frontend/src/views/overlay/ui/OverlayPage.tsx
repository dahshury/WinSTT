"use client";

import { useEffect } from "react";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { AudioVisualizer, useVisualizerSync } from "@/features/audio-visualizer";
import { useTranscriptionFeed } from "@/features/live-transcription";
import { useLlmProcessingFeed, useLlmProcessingStore } from "@/features/llm-processing";
import { onSettingsChanged } from "@/shared/api/ipc-client";
import { decodeSettingsPayload } from "@/shared/api/settings-codec";
import { ThinkingIndicator } from "@/shared/ui/thinking-indicator";

/**
 * The overlay BrowserWindow is created with `transparent: true` so the
 * pill floats over other apps without a rectangular backdrop. globals.css
 * applies `body { background: var(--color-surface) }` for every renderer
 * route, which on the overlay route fills the whole window with a solid
 * dark rectangle. Scope the override here so the body becomes transparent
 * only while OverlayPage is mounted (cleanup restores the global default,
 * in case the renderer ever client-navigates away from /overlay).
 */
function useTransparentBody(): void {
	useEffect(() => {
		const prevBody = document.body.style.background;
		const prevHtml = document.documentElement.style.background;
		document.body.style.background = "transparent";
		document.documentElement.style.background = "transparent";
		return () => {
			document.body.style.background = prevBody;
			document.documentElement.style.background = prevHtml;
		};
	}, []);
}

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
	useTransparentBody();
	useVisualizerSync();
	useTranscriptionFeed();
	useLlmProcessingFeed();

	const setSettings = useSettingsStore((s) => s.setSettings);
	const sizePreset = useSettingsStore((s) => toPreset(s.settings.general?.visualizerSize));
	const liveDisplay = useSettingsStore(
		(s) => s.settings.general?.liveTranscriptionDisplay ?? "both"
	);
	const showLiveTranscription = liveDisplay === "in-pill" || liveDisplay === "both";

	const realtime = useTranscriptionStore((s) => s.currentRealtime);
	const ephemeral = useTranscriptionStore((s) => s.ephemeral);
	const isThinking = useLlmProcessingStore((s) => s.isThinking);

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
			<div className="relative inline-flex max-w-[460px] flex-col items-center gap-1 overflow-hidden rounded-2xl bg-black/60 px-2.5 py-1 backdrop-blur-md">
				<div className="flex items-center justify-center" style={{ zoom }}>
					<AudioVisualizer size="icon" />
				</div>
				{showText && (
					<div className="line-clamp-5 break-words text-center text-sm text-white leading-tight">
						{text}
					</div>
				)}
				{isThinking && (
					<div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-black/55 backdrop-blur-sm">
						<ThinkingIndicator />
					</div>
				)}
			</div>
		</div>
	);
}
