"use client";

import { AnimatePresence, domAnimation, LazyMotion, m, type Variants } from "motion/react";
import { useEffect } from "react";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import {
	AudioVisualizer,
	useVisualizerStore,
	useVisualizerSync,
} from "@/features/audio-visualizer";
import { useTranscriptionFeed } from "@/features/live-transcription";
import { useLlmProcessingFeed, useLlmProcessingStore } from "@/features/llm-processing";
import { onSettingsChanged } from "@/shared/api/ipc-client";
import { decodeSettingsPayload } from "@/shared/api/settings-codec";
import { ScrollingText } from "@/shared/ui/scrolling-text";
import { ThinkingIndicator } from "@/shared/ui/thinking-indicator";

/**
 * Reset every store the pill reads from the moment the overlay BrowserWindow
 * becomes visible — before the renderer's first post-show paint.
 *
 * Why this is needed in addition to the IPC-driven clear in
 * `useTranscriptionFeed` (which runs on STT_RECORDING_START): the IPC is
 * asynchronous, so on a "press → release → wait → press again" cycle the
 * renderer can paint at least one frame with the previous session's
 * `currentRealtime` / `ephemeral` text before the start event lands. The
 * `visibilitychange` event, by contrast, fires synchronously on the renderer's
 * main thread when Chromium sees the BrowserWindow transition to visible, and
 * a synchronous Zustand `setState` here is guaranteed to be applied before any
 * paint can run, so the very first frame after the window appears is empty.
 *
 * `isRecordingActive` is intentionally reset to `false` too — it will be
 * re-armed by STT_RECORDING_START a beat later, and starting from `false`
 * matches the pill's gating contract: "hidden until a real recording arms us".
 */
function useResetOnOverlayShow(): void {
	useEffect(() => {
		const handler = () => {
			if (document.visibilityState !== "visible") {
				return;
			}
			useTranscriptionStore.setState({
				currentRealtime: "",
				ephemeral: null,
				isRecordingActive: false,
			});
			useLlmProcessingStore.setState({ isThinking: false });
			// Belt-and-suspenders: `recordingStopped` in the visualizer
			// store already clears `isSpeaking`, but if a session ended
			// abnormally (connection drop, app crash recovery) a stale
			// `true` here would flash the pill the moment the overlay
			// re-appears.
			useVisualizerStore.setState({ isSpeaking: false });
		};
		document.addEventListener("visibilitychange", handler);
		return () => document.removeEventListener("visibilitychange", handler);
	}, []);
}

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
	md: 27,
	lg: 40,
	xl: 60,
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

// Variants live at module scope so their references stay stable across
// renders (Framer Motion treats a new object identity as a prop change).
//
// Mount is intentionally instant for both pieces — the pill arrives on the
// same paint as the first transcribed token. Exits keep an ease-in
// departure so cleanup still feels polished.
const bubbleVariants: Variants = {
	initial: { opacity: 1, scale: 1, y: 0 },
	animate: { opacity: 1, scale: 1, y: 0 },
	exit: {
		opacity: 0,
		y: 4,
		scale: 0.97,
		transition: { duration: 0.16, ease: [0.4, 0, 1, 1] },
	},
};

const chipVariants: Variants = {
	initial: { opacity: 1, y: 0 },
	animate: { opacity: 1, y: 0 },
	exit: {
		opacity: 0,
		y: 4,
		transition: { duration: 0.16, ease: [0.4, 0, 1, 1] },
	},
};

// Crossfade between text and thinking content inside the bubble. Faster
// than the bubble's own exit so swaps feel snappy. `initial={false}` on
// the parent AnimatePresence suppresses this on first paint.
const contentVariants: Variants = {
	initial: { opacity: 0 },
	animate: { opacity: 1, transition: { duration: 0.12 } },
	exit: { opacity: 0, transition: { duration: 0.08 } },
};

// Inset breathing glow used only while VAD says the user is speaking.
// Opacity-only keyframes (no scale) so the chip's bounding box stays
// pixel-identical to its resting state.
const breatheVariants: Variants = {
	initial: { opacity: 0 },
	animate: {
		opacity: [0.0, 0.45, 0.0],
		transition: { duration: 2.2, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
	},
	exit: { opacity: 0, transition: { duration: 0.2 } },
};

// Shared glass surface — theme-token gradient + double-bezel hairline ring
// + tinted drop shadow + backdrop-blur with a saturation kick. Reused by
// both the visualizer chip and the text bubble so they read as a single
// material system. Concentric-radius (per chip vs. bubble) is the only
// thing that differentiates them visually.
const GLASS_SURFACE =
	"bg-gradient-to-b from-[var(--color-surface-3)]/65 to-[var(--color-surface-1)]/92 ring-1 ring-white/[0.08] ring-inset backdrop-blur-md backdrop-saturate-150";
const BUBBLE_SHADOW =
	"shadow-[inset_0_1px_0_0_rgba(255,255,255,0.10),inset_0_-1px_0_0_rgba(0,0,0,0.40),0_8px_24px_-8px_rgba(2,3,8,0.65)]";
const CHIP_SHADOW =
	"shadow-[inset_0_1px_0_0_rgba(255,255,255,0.10),inset_0_-1px_0_0_rgba(0,0,0,0.40),0_4px_14px_-6px_rgba(2,3,8,0.6)]";

export function OverlayPage() {
	useTransparentBody();
	useResetOnOverlayShow();
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
	const isRecordingActive = useTranscriptionStore((s) => s.isRecordingActive);
	const isThinking = useLlmProcessingStore((s) => s.isThinking);
	// `isSpeaking` (VAD) is still read for the breathing overlay, but it
	// deliberately no longer gates pill mount — that fired hundreds of ms
	// before the first transcribed word, making the pill appear "early".
	const isSpeaking = useVisualizerStore((s) => s.isSpeaking);

	useEffect(() => {
		const unsub = onSettingsChanged((incoming) => {
			setSettings(decodeSettingsPayload(incoming));
		});
		return unsub;
	}, [setSettings]);

	const text = realtime.trim() || ephemeral?.text || "";
	const hasText = text.length > 0;
	const showText = showLiveTranscription && hasText;
	// Pill mount is gated strictly on transcribed text (or LLM thinking).
	// VAD pre-mount was removed so the pill lands on the same paint as the
	// first word — `hasText` (the raw text presence) is used instead of
	// `showText` so that users who've hidden in-pill transcription still
	// get the visualizer the moment the model emits its first token.
	//
	// `isRecordingActive` guards against painting stale state from a prior
	// session in the brief window between the main process calling
	// `showOverlay()` and STT_RECORDING_START arriving. `isThinking`
	// bypasses it so the pill survives the recording → LLM-thinking
	// transition (when `isRecordingActive` has already flipped off).
	const showPill = (isRecordingActive && hasText) || isThinking;

	const heightPx = PRESET_HEIGHT_PX[sizePreset];
	// CSS `zoom` (Chromium-supported, including Electron) scales both visual and
	// layout box, so the surrounding flex container auto-sizes around the visualizer.
	const zoom = heightPx / ICON_PRESET_PX;

	// Bubble respects the in-pill transcription setting: if the user routed
	// live text to "in-app" only, the bubble stays hidden for transcription
	// but still appears for the LLM-thinking state (that's a system signal,
	// not "live captions"). Chip remains independent so a recording without
	// in-pill captions still shows the instrument.
	const showBubble = showPill && (showText || isThinking);

	return (
		<LazyMotion features={domAnimation} strict>
			<div className="flex h-screen w-screen items-end justify-center overflow-hidden pb-3">
				{/* Two-piece stack. The visualizer chip is pinned to the screen
				    bottom and never moves; the text bubble lives above it and
				    can grow upward without dragging the chip's shadows along
				    for the ride. They share one glass material so the pair
				    still reads as one device — the radius is the only thing
				    that diverges (organic capsule chip vs. editorial bubble). */}
				<div className="flex flex-col items-center gap-1">
					{/* TEXT BUBBLE — appears with first transcribed word or
					    when LLM is thinking. `layout` smooths the height
					    growth as new lines wrap via Framer's FLIP, so the
					    1→N line transition no longer pops. */}
					<AnimatePresence>
						{showBubble && (
							<m.div
								animate="animate"
								className={`relative inline-flex max-w-[460px] flex-col items-center overflow-hidden rounded-2xl px-3 py-2 ${GLASS_SURFACE} ${BUBBLE_SHADOW}`}
								exit="exit"
								initial="initial"
								key="text-bubble"
								layout
								style={{ willChange: "transform, opacity" }}
								variants={bubbleVariants}
							>
								{/* Brand-accent hairline — single Docker-blue
								    moment, sentence-case design. */}
								<div
									aria-hidden="true"
									className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-[oklch(62%_0.19_260/0.5)] to-transparent"
								/>
								<AnimatePresence initial={false} mode="wait">
									{isThinking ? (
										<m.div
											animate="animate"
											exit="exit"
											initial="initial"
											key="thinking"
											variants={contentVariants}
										>
											<ThinkingIndicator />
										</m.div>
									) : (
										<m.div
											animate="animate"
											exit="exit"
											initial="initial"
											key="text"
											variants={contentVariants}
										>
											<ScrollingText
												className="text-center font-medium text-foreground text-sm tracking-tight"
												fadeColor="oklch(8% 0.015 265 / 0.95)"
												lineHeight={1.25}
												maxLines={5}
												text={text}
											/>
										</m.div>
									)}
								</AnimatePresence>
							</m.div>
						)}
					</AnimatePresence>

					{/* VISUALIZER CHIP — bottom-anchored, never moves. The
					    capsule (rounded-full) reads as the persistent
					    "instrument" while the bubble above is the
					    transient "output". */}
					<AnimatePresence>
						{showPill && (
							<m.div
								animate="animate"
								className={`relative inline-flex items-center justify-center overflow-hidden rounded-full px-2.5 py-1 ${GLASS_SURFACE} ${CHIP_SHADOW}`}
								exit="exit"
								initial="initial"
								key="visualizer-chip"
								style={{ willChange: "transform, opacity" }}
								variants={chipVariants}
							>
								{/* Glass refraction hairline at the very top
								    of the capsule. */}
								<div
									aria-hidden="true"
									className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent"
								/>
								{/* Breathing inset glow while user is
								    actively speaking. Opacity-only — chip
								    dimensions stay pixel-identical. */}
								<AnimatePresence>
									{isSpeaking && !isThinking && (
										<m.div
											animate="animate"
											aria-hidden="true"
											className="pointer-events-none absolute inset-0 rounded-full"
											exit="exit"
											initial="initial"
											key="speaking-breathe"
											style={{
												boxShadow:
													"inset 0 0 18px 0 oklch(62% 0.19 260 / 0.28), inset 0 0 1px 0 oklch(75% 0.15 260 / 0.4)",
											}}
											variants={breatheVariants}
										/>
									)}
								</AnimatePresence>
								<div className="flex items-center justify-center" style={{ zoom }}>
									<AudioVisualizer size="icon" />
								</div>
							</m.div>
						)}
					</AnimatePresence>
				</div>
			</div>
		</LazyMotion>
	);
}
