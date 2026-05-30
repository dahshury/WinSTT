import { AnimatePresence, domAnimation, domMax, LazyMotion, m, type Variants } from "motion/react";
import { type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import {
	AudioVisualizer,
	useVisualizerStore,
	useVisualizerSync,
} from "@/features/audio-visualizer";
import { useTranscriptionFeed } from "@/features/live-transcription";
import { useLlmProcessingFeed, useLlmProcessingStore } from "@/features/llm-processing";
import { onSettingsChanged, sttAbortOperation, ttsSetSpeed } from "@/shared/api/ipc-client";
import { decodeSettingsPayload } from "@/shared/api/settings-codec";
import {
	DynamicIsland,
	DynamicIslandProvider,
	type DynamicIslandSize,
	useDynamicIslandSize,
} from "@/shared/ui/dynamic-island";
import { ScrollingText } from "@/shared/ui/scrolling-text";
import { ThinkingIndicator } from "@/shared/ui/thinking-indicator";
import {
	discardTts,
	getTtsLevel,
	pauseTts,
	resumeTts,
	type TtsPlaybackStatus,
	useTtsPlaybackStore,
} from "../model/tts-playback-store";
import { TtsPlaybackMount } from "./TtsPlaybackMount";

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
		Object.assign(document.body.style, { background: "transparent" });
		Object.assign(document.documentElement.style, { background: "transparent" });
		return () => {
			Object.assign(document.body.style, { background: prevBody });
			Object.assign(document.documentElement.style, { background: prevHtml });
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

// Text font-size (px) per `visualizerSize` for dynamic-island mode. Chosen
// to track the same growth curve as the visualizer chip: small enough at xs
// to keep a chip-sized island legible, large enough at xl to read like a
// caption from across the room.
const TEXT_FONT_SIZE_PX: Record<SizePreset, number> = {
	xs: 11,
	sm: 12,
	md: 14,
	lg: 16,
	xl: 20,
};

/**
 * Live mm:ss elapsed-time string for the dynamic island's recording timer
 * (mirrors Apple's notch readout). Resets to 00:00 the moment recording
 * starts and stops ticking when it ends. Updates every second — that's
 * enough fidelity for a notch readout and saves the overlay window the
 * cost of a per-frame timer.
 *
 * Hook MUST be called unconditionally (rules-of-hooks), so the consumer
 * always pays the setState cost while the recording is live; when
 * `isRecordingActive` is false the interval doesn't run.
 */
interface ElapsedState {
	elapsedMs: number;
	start: number | null;
}

type ElapsedAction =
	| { type: "reset" }
	| { type: "start"; at: number }
	| { type: "tick"; now: number };

function elapsedReducer(state: ElapsedState, action: ElapsedAction): ElapsedState {
	switch (action.type) {
		case "reset":
			return state.start === null && state.elapsedMs === 0 ? state : { start: null, elapsedMs: 0 };
		case "start":
			return { start: action.at, elapsedMs: 0 };
		case "tick":
			return state.start === null
				? state
				: { start: state.start, elapsedMs: action.now - state.start };
		default:
			return state;
	}
}

function useRecordingElapsed(isRecordingActive: boolean): string {
	// Single reducer-driven state (instead of two cascading useState slots)
	// keeps reset+start+tick as one dispatch each — no setState waterfall
	// inside the effect.
	const [{ elapsedMs }, dispatch] = useReducer(elapsedReducer, { start: null, elapsedMs: 0 });

	useEffect(() => {
		if (!isRecordingActive) {
			dispatch({ type: "reset" });
			return;
		}
		const startedAt = Date.now();
		dispatch({ type: "start", at: startedAt });
		const interval = setInterval(() => {
			dispatch({ type: "tick", now: Date.now() });
		}, 1000);
		return () => clearInterval(interval);
	}, [isRecordingActive]);

	const seconds = Math.floor(elapsedMs / 1000);
	const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
	const ss = String(seconds % 60).padStart(2, "0");
	return `${mm}:${ss}`;
}

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

/**
 * Pure mapping from the renderer's live state to a Dynamic-Island size
 * preset. Drives ONLY the shell's WIDTH (and the `empty` collapse) in
 * dynamic-island mode — height is intrinsic (see `DynamicIsland`'s
 * `fitContent` prop), so the island grows by exactly one text-line per
 * wrap instead of jumping between height presets.
 *
 *   1. `isThinking` resolves first — the LLM-thinking state survives the
 *      recording → post-processing transition (isRecordingActive flips off
 *      the moment recording ends, before the thinking callback fires). But
 *      it only widens to `long` when there's CAPTIONED TEXT to wrap
 *      alongside it (`hasShownText` — the realtime model streamed words into
 *      the pill). With no captions (the main-model-only path, where the pill
 *      never showed live text) the thinking indicator is just a chip-sized
 *      rotating-word readout, so we stay at the compact recording footprint
 *      (`compactMedium`) and let the indicator replace the visualizer in
 *      place — ballooning to the full-width text surface for content that
 *      doesn't need it is the "island grows for nothing" regression.
 *   2. `!isRecordingActive` collapses to `empty` (0×0) unless thinking —
 *      same gate as the legacy floating pill, so the island disappears
 *      between dictation sessions.
 *   3. Captioned recording uses `long` (460px wide) — the natural width
 *      for legible text wrap. Height adds one line per wrap, no jump.
 *   4. Otherwise grow with VAD: `compactMedium` while speaking, `compact`
 *      at rest. This is the "just-started, no words yet" state.
 *
 * Exported for unit testing without mounting the motion-heavy pill tree.
 */
export function computeIslandSize(args: {
	isRecordingActive: boolean;
	isSpeaking: boolean;
	isThinking: boolean;
	hasShownText: boolean;
}): DynamicIslandSize {
	if (args.isThinking) {
		return args.hasShownText ? "long" : "compactMedium";
	}
	if (!args.isRecordingActive) {
		return "empty";
	}
	if (args.hasShownText) {
		return "long";
	}
	if (args.isSpeaking) {
		return "compactMedium";
	}
	return "compact";
}

/** Boolean flags collapsed into one nested object so the island's content
 *  component takes a single `state` arg instead of 4+ standalone booleans
 *  (avoids `no-many-boolean-props`). The four flags interact closely
 *  (recording / VAD / thinking / live-transcription policy) so the grouping
 *  reads naturally at the call site. */
interface IslandFlags {
	isRecordingActive: boolean;
	isSpeaking: boolean;
	isThinking: boolean;
	showLiveTranscription: boolean;
}

interface IslandStateArgs {
	flags: IslandFlags;
	sizePreset: SizePreset;
	text: string;
	thinkingStartedAt: number | null;
	thinkingText: string;
}

/**
 * Inner content of the Dynamic Island — Apple-style two-zone layout:
 *
 *   ┌──────────────────────────────────────┐
 *   │ [waveform]              ● 00:32      │  ← top row, while recording
 *   │ transcribed text wraps here...       │  ← fills remaining space
 *   └──────────────────────────────────────┘
 *
 * Top row uses `justify-between` so the visualizer hugs the LEFT edge
 * and the recording dot + elapsed-time timer hug the RIGHT edge, with
 * the dead space between them swallowed by the flex gap. Mirrors the
 * iPhone Dynamic Island's "voice memo" look (see the reference shot).
 *
 * Both the visualizer and the text scale with `visualizerSize`:
 *   - visualizer zoom = `PRESET_HEIGHT_PX[sizePreset] / ICON_PRESET_PX`
 *     (matches the floating-bottom chip's scale curve)
 *   - text + timer fontSize = `TEXT_FONT_SIZE_PX[sizePreset]` (the timer
 *     uses `tabular-nums` so digit width doesn't jitter every second)
 *
 * Padding is asymmetric — `pt-1` keeps the visualizer almost flush with
 * the island's top edge (the iPhone look the user asked for), while
 * `pb-1.5` gives the trailing text room to breathe.
 */
function DynamicIslandPillContent({
	flags,
	sizePreset,
	text,
	thinkingText,
	thinkingStartedAt,
}: IslandStateArgs) {
	const { isRecordingActive, isSpeaking, isThinking, showLiveTranscription } = flags;
	// Hook runs unconditionally — the early `null` return below would
	// otherwise violate rules-of-hooks. The timer's interval only ticks
	// when `isRecordingActive` is true (see `useRecordingElapsed`).
	const elapsed = useRecordingElapsed(isRecordingActive);

	if (!(isRecordingActive || isThinking)) {
		// Belt-and-suspenders — the shell's `empty` preset (width 0) already
		// hides the island; this guard prevents stale renders from leaking
		// an empty padded box during the brief transition out.
		return null;
	}

	const visualizerZoom = PRESET_HEIGHT_PX[sizePreset] / ICON_PRESET_PX;
	const textFontSize = TEXT_FONT_SIZE_PX[sizePreset];
	// Timer is secondary information — render it slightly smaller than
	// the transcription, like Apple's notch readout.
	const timerFontSize = Math.max(10, Math.round(textFontSize * 0.8));
	const showText = isRecordingActive && showLiveTranscription && text.length > 0;

	// Padding tuned to the shell's 28px bottom-corner radius:
	//   - `pt-1`  (4px) keeps the top row almost flush with the flat top
	//     edge — the iPhone-notch look the user asked for.
	//   - `px-5` (20px) keeps the rightmost char of the timer and the
	//     last word of wrapped text clear of the bottom-corner curves.
	//   - `pb-3` (12px) leaves a comfortable gap between the bottom text
	//     line and the rounded bottom edge.
	// Inner `gap-1` separates the top row from the transcription/thinking
	// block by ~4px so they don't visually touch.
	return (
		<div className="flex flex-col gap-1 px-5 pt-1 pb-3">
			{isRecordingActive ? (
				<div className="flex items-center justify-between gap-3">
					{/* Visualizer hugged to the top-left, scaled per setting */}
					<div className="flex items-center" style={{ zoom: visualizerZoom }}>
						<AudioVisualizer size="icon" />
					</div>
					{/* Recording dot + mm:ss timer, hugged to the top-right. The
					    X cancel button is rendered separately (absolute-positioned
					    in the parent shell) so it stays visible during LLM-thinking
					    too — the header row hides in that state. */}
					<div className="flex items-center gap-1.5">
						<LivePulse isSpeaking={isSpeaking} />
						<span
							className="font-mono text-white/70 tabular-nums"
							style={{ fontSize: timerFontSize }}
						>
							{elapsed}
						</span>
						{/* Spacer reserves room for the absolute-positioned X so the
						    timer doesn't sit flush against the right corner curve. */}
						<span aria-hidden="true" className="inline-block w-3 shrink-0" />
					</div>
				</div>
			) : null}
			{showText ? (
				<div className="w-full" style={{ fontSize: textFontSize }}>
					<ScrollingText
						className="text-left font-medium text-white tracking-tight"
						// Solid black fade-mask matches the island's bg so the
						// edge fade reads as "more text" rather than a band.
						fadeColor="rgb(0 0 0 / 0.95)"
						lineHeight={1.25}
						maxLines={5}
						text={text}
					/>
				</div>
			) : null}
			{isThinking ? (
				<div className="w-full" style={{ fontSize: textFontSize }}>
					{/* `fluidWidth` lets the streamed-reasoning band fill the
					    island width instead of its intrinsic clamp — so when the
					    island sits at the compact `compactMedium` footprint (the
					    main-model-only thinking path) the reasoning tracks that
					    width rather than overflowing and getting clipped. */}
					<ThinkingIndicator fluidWidth reasoning={thinkingText} startedAt={thinkingStartedAt} />
				</div>
			) : null}
		</div>
	);
}

/**
 * Small X button that cancels the in-flight dictation session. Routes through
 * the same `handleAbortOperation` pipeline the hotkey+Backspace combo uses
 * (markSessionAborted + abort Ollama chats + recorder.abort + clear queue +
 * hide overlay).
 *
 * The overlay BrowserWindow is click-through by default
 * (`setIgnoreMouseEvents(true, { forward: true })`), so the renderer flips
 * ignore off while the cursor hovers the button — otherwise the click would
 * fall through to the app underneath. Leaving the button restores click-
 * through so the rest of the pill never blocks input.
 */
function CancelButton({ size = 16 }: { size?: number }) {
	// Click-through is managed at the WINDOW level by OverlayPage's
	// isRecordingActive/isThinking effect: ignore=false while the pill is
	// active, ignore=true once the session ends. We deliberately do NOT
	// flip ignore on hover / leave here — the hover-based dance was the
	// reason touch input couldn't reach the X (no preceding mouseenter
	// to flip ignore off before the synthesized mouse-down on touch).
	// Letting the window stay interactive for the whole recording also
	// removes the per-click IPC roundtrip race on mouse devices.
	const cancelTranscription = () => {
		sttAbortOperation();
	};
	// Wrap in the same glass material as the chip/island shell so the button
	// reads as a sibling capsule — same gradient + hairline ring + drop shadow
	// — instead of a floating raw glyph. `overflow-hidden` clips the hover
	// tint to the circle. Size includes its own padding via `box-sizing`.
	return (
		<button
			aria-label="Cancel transcription"
			className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full text-white/70 transition-colors hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-white/40 ${GLASS_SURFACE} ${CHIP_SHADOW}`}
			onClick={cancelTranscription}
			style={{ width: size, height: size, boxSizing: "border-box" }}
			type="button"
		>
			{/* Subtle hover wash inside the capsule — same tint logic the chip's
			    breathing glow uses, but driven by :hover instead of VAD. */}
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 rounded-full bg-white/0 transition-colors duration-150 hover:bg-white/[0.08]"
			/>
			<svg
				aria-hidden="true"
				className="relative"
				fill="none"
				height={Math.round(size * 0.55)}
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth={2}
				viewBox="0 0 24 24"
				width={Math.round(size * 0.55)}
				xmlns="http://www.w3.org/2000/svg"
			>
				<line x1="6" x2="18" y1="6" y2="18" />
				<line x1="6" x2="18" y1="18" y2="6" />
			</svg>
		</button>
	);
}

function LivePulse({ isSpeaking }: { isSpeaking: boolean }) {
	return (
		<span
			aria-hidden="true"
			className="inline-block size-2 shrink-0 rounded-full bg-[oklch(62%_0.19_260)]"
			style={isSpeaking ? { boxShadow: "0 0 8px 0 oklch(62% 0.19 260 / 0.7)" } : undefined}
		/>
	);
}

/**
 * Provider-aware wrapper: pulls the target size from external state, drives
 * `setSize` via effect, and renders the shell + content. Sits inside
 * `DynamicIslandProvider` so the hook context is available.
 *
 * `flatTop` removes the top corner radius so the island visually hangs from
 * the top bezel; `fitContent` lets each transcribed line extend the shell
 * by exactly one line's height.
 */
function DynamicIslandPill(args: IslandStateArgs) {
	const { setSize, state } = useDynamicIslandSize();
	const { flags, text } = args;
	const target = computeIslandSize({
		isRecordingActive: flags.isRecordingActive,
		isSpeaking: flags.isSpeaking,
		isThinking: flags.isThinking,
		hasShownText: flags.showLiveTranscription && text.length > 0,
	});

	// Push the derived size into the DynamicIsland's reducer during render
	// (React-documented "store info from previous renders" pattern, see
	// https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
	// The reducer's `set` action short-circuits when `state.size === target`,
	// so this is a cheap no-op once we're already in sync — and the island
	// no longer needs a setState-in-effect to mirror derived state.
	if (state.size !== target) {
		setSize(target);
	}

	return (
		<DynamicIsland fitContent flatTop id="winstt-overlay-island">
			{/* X cancel anchored to the top-right of the island, just inside the
			    rounded bottom-right area. Absolute-positioned so it stays visible
			    in both the recording state (alongside the timer) and the LLM-
			    thinking state (which hides the header row entirely). The 8px
			    top inset matches the island's `pt-1` content padding. */}
			<div className="pointer-events-auto absolute top-2 right-3 z-raised">
				<CancelButton size={14} />
			</div>
			<DynamicIslandPillContent {...args} />
		</DynamicIsland>
	);
}

/**
 * SVG glyph for a TTS pill control. `pause`/`play` are filled; `discard` is the
 * same X stroke as {@link CancelButton}.
 */
function IslandControlGlyph({ kind, size }: { kind: "pause" | "play" | "discard"; size: number }) {
	if (kind === "discard") {
		return (
			<svg
				aria-hidden="true"
				className="relative"
				fill="none"
				height={size}
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth={2}
				viewBox="0 0 24 24"
				width={size}
				xmlns="http://www.w3.org/2000/svg"
			>
				<line x1="6" x2="18" y1="6" y2="18" />
				<line x1="6" x2="18" y1="18" y2="6" />
			</svg>
		);
	}
	if (kind === "play") {
		return (
			<svg
				aria-hidden="true"
				className="relative"
				fill="currentColor"
				height={size}
				viewBox="0 0 24 24"
				width={size}
				xmlns="http://www.w3.org/2000/svg"
			>
				<path d="M8 5v14l11-7z" />
			</svg>
		);
	}
	return (
		<svg
			aria-hidden="true"
			className="relative"
			fill="currentColor"
			height={size}
			viewBox="0 0 24 24"
			width={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<rect height="14" rx="1" width="4" x="6" y="5" />
			<rect height="14" rx="1" width="4" x="14" y="5" />
		</svg>
	);
}

/**
 * Glass control button for the read-aloud pill — pause / resume / discard. Same
 * capsule material as {@link CancelButton} so the controls read as siblings.
 */
function IslandControlButton({
	kind,
	label,
	onClick,
	size = 18,
}: {
	kind: "pause" | "play" | "discard";
	label: string;
	onClick: () => void;
	size?: number;
}) {
	return (
		<button
			aria-label={label}
			className={`pointer-events-auto relative flex shrink-0 items-center justify-center overflow-hidden rounded-full text-white/75 transition-colors hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-white/40 ${GLASS_SURFACE} ${CHIP_SHADOW}`}
			onClick={onClick}
			style={{ width: size, height: size, boxSizing: "border-box" }}
			type="button"
		>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 rounded-full bg-white/0 transition-colors duration-150 hover:bg-white/[0.08]"
			/>
			<IslandControlGlyph kind={kind} size={Math.round(size * 0.5)} />
		</button>
	);
}

// Read-aloud speed steps per source. Local Kokoro accepts 0.5–2.0; ElevenLabs
// clamps `voice_settings.speed` to 0.7–1.2. Mirrors `electron/ipc/tts-reader.ts`
// (separate runtimes can't share the const); electron re-clamps defensively.
const TTS_LOCAL_SPEEDS = [1, 1.25, 1.5, 2] as const;
const TTS_CLOUD_SPEEDS = [0.9, 1, 1.1, 1.2] as const;

function nextTtsSpeed(current: number, cloud: boolean): number {
	const steps = cloud ? TTS_CLOUD_SPEEDS : TTS_LOCAL_SPEEDS;
	const idx = steps.findIndex((s) => Math.abs(s - current) < 0.001);
	if (idx !== -1) {
		return steps[(idx + 1) % steps.length] ?? current;
	}
	return steps.find((s) => s > current) ?? steps[0] ?? current;
}

/**
 * Speed pill — shows the current read-aloud rate (e.g. `1.5×`) and cycles to the
 * next step on tap. The new speed applies to the read's UPCOMING sentences
 * (natural pitch) and is persisted by the main process.
 */
function SpeedButton({ speed, cloud }: { speed: number; cloud: boolean }) {
	return (
		<button
			aria-label={`Reading speed ${speed}×, tap to change`}
			className={`pointer-events-auto flex h-[18px] shrink-0 items-center justify-center rounded-full px-1.5 font-medium text-[10px] text-white/75 tabular-nums transition-colors hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-white/40 ${GLASS_SURFACE} ${CHIP_SHADOW}`}
			onClick={() => ttsSetSpeed(nextTtsSpeed(speed, cloud))}
			type="button"
		>
			{speed}×
		</button>
	);
}

/**
 * Forced dynamic-island pill for a TTS read-aloud — a live visualiser of the
 * spoken audio (fed via the shared visualiser store by `useTtsIslandBridge`)
 * plus speed / pause-resume / discard controls. Fixed `compactMedium` footprint
 * so it stays compact ("doesn't grow much"). pause/resume/discard are local to
 * this window's queue; discard also cancels the server-side run; speed is routed
 * to the reader via IPC.
 */
function TtsIslandPill({ status }: { status: TtsPlaybackStatus }) {
	const { setSize, state } = useDynamicIslandSize();
	if (state.size !== "compactMedium") {
		setSize("compactMedium");
	}
	const cloud = useSettingsStore((s) => s.settings.tts?.source) === "cloud";
	const speed = useSettingsStore((s) =>
		cloud ? (s.settings.tts?.cloud?.speed ?? 1) : (s.settings.tts?.speed ?? 1)
	);
	const paused = status === "paused";
	return (
		<DynamicIsland flatTop id="winstt-tts-island">
			<div className="flex h-full items-center justify-between gap-2 px-4">
				<div className="flex items-center">
					<AudioVisualizer size="icon" />
				</div>
				<div className="pointer-events-auto flex items-center gap-2">
					<SpeedButton cloud={cloud} speed={speed} />
					<IslandControlButton
						kind={paused ? "play" : "pause"}
						label={paused ? "Resume reading" : "Pause reading"}
						onClick={paused ? resumeTts : pauseTts}
					/>
					<IslandControlButton kind="discard" label="Stop reading" onClick={discardTts} />
				</div>
			</div>
		</DynamicIsland>
	);
}

// Panel-reveal for the TTS island (transitions.dev "panel reveal", from the
// top): slides down from the top bezel, cross-fading opacity and blur on one
// ease. Asymmetric durations (slower open, snappier close) mirror Apple's notch
// feel. The island is ALWAYS mounted and animates between `open`/`closed` — a
// property transition on a persistent element ALWAYS plays both directions,
// unlike an AnimatePresence unmount-exit (which can be dropped by React 19's
// unmount timing AND, sliding up into the top-edge clip, reads as an instant
// vanish). `y` is a % of the island's own height.
const TTS_PANEL_EASE = [0.22, 1, 0.36, 1] as const;
const ttsPanelVariants: Variants = {
	closed: {
		y: "-72%",
		opacity: 0,
		filter: "blur(2px)",
		transition: { duration: 0.35, ease: TTS_PANEL_EASE },
	},
	open: {
		y: 0,
		opacity: 1,
		filter: "blur(0px)",
		transition: { duration: 0.4, ease: TTS_PANEL_EASE },
	},
};

/**
 * Keep `visible` content mounted for `exitMs` after it turns false so a close
 * animation can play, then unmount. Returns whether to render. Unlike
 * `AnimatePresence`, the close is a property transition on a still-mounted
 * element (reliable across React 19's unmount timing); unlike always-mounting,
 * it's unmounted at rest so the island's visualiser rAF never runs idle (which
 * loops happy-dom in the OverlayPage tests).
 */
function useDelayedUnmount(visible: boolean, exitMs: number): boolean {
	const [mounted, setMounted] = useState(visible);
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	// Latch `mounted` true during render the instant `visible` flips true, so the
	// exit timer below has something to keep on screen while it animates out.
	if (visible && !mounted) {
		setMounted(true);
	}
	useEffect(() => {
		if (visible) {
			clearTimeout(timerRef.current);
			return;
		}
		timerRef.current = setTimeout(() => setMounted(false), exitMs);
		return () => clearTimeout(timerRef.current);
	}, [visible, exitMs]);
	return visible || mounted;
}

/**
 * Layer hosting the forced TTS read-aloud island. The island slides in AND out
 * from the top by animating a persistent element between `open`/`closed`; it's
 * mounted only while open + during the close (`useDelayedUnmount`) so its
 * visualiser never runs at rest. The overlay window is kept composited through
 * the close by `hideOverlay({ forceGrace: true })` in `tts.ts`. Top-anchored +
 * click-through container (only the controls capture pointer events).
 */
function TtsIslandLayer({ show, status }: { show: boolean; status: TtsPlaybackStatus }) {
	const mounted = useDelayedUnmount(show, 380);
	return (
		<LazyMotion features={domMax} strict>
			<div className="pointer-events-none fixed inset-x-0 top-0 flex justify-center overflow-hidden">
				{mounted && (
					<m.div animate={show ? "open" : "closed"} initial="closed" variants={ttsPanelVariants}>
						<DynamicIslandProvider initialSize="compactMedium">
							<TtsIslandPill status={status} />
						</DynamicIslandProvider>
					</m.div>
				)}
			</div>
		</LazyMotion>
	);
}

/**
 * Bridges the overlay's TTS playback into the visuals: (1) feeds the shared
 * `useVisualizerStore.audioLevel` the live RMS off the TTS analyser each frame
 * while a read plays — STT and TTS never overlap (STT discards TTS), so reusing
 * the one visualiser is safe and maximally DRY; (2) enforces STT precedence — the
 * instant a dictation session opens, any in-flight read is discarded so the pill
 * flips to the STT view and the audio stops.
 */
function useTtsIslandBridge(sessionActive: boolean): void {
	const status = useTtsPlaybackStore((s) => s.status);
	const setAudioLevel = useVisualizerStore((s) => s.setAudioLevel);
	const rafRef = useRef(0);

	useEffect(() => {
		if (sessionActive && useTtsPlaybackStore.getState().status !== "idle") {
			discardTts();
		}
	}, [sessionActive]);

	useEffect(() => {
		const playing = (status === "speaking" || status === "paused") && !sessionActive;
		if (!playing) {
			setAudioLevel(0);
			cancelAnimationFrame(rafRef.current);
			return;
		}
		const tick = () => {
			setAudioLevel(getTtsLevel());
			rafRef.current = requestAnimationFrame(tick);
		};
		rafRef.current = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafRef.current);
	}, [status, sessionActive, setAudioLevel]);
}

interface FloatingPillProps {
	flags: { isSpeaking: boolean; isThinking: boolean; showBubble: boolean; stickyShow: boolean };
	heightPx: number;
	text: string;
	thinkingStartedAt: number | null;
	thinkingText: string;
	zoom: number;
}

/**
 * Floating-bottom STT pill (the pre-DynamicIsland look): a text/thinking bubble
 * above a fixed visualizer chip, bottom-anchored. Extracted verbatim from
 * `OverlayPage` so the page's pill-selection branch stays under the
 * cognitive-complexity gate.
 */
function FloatingBottomPill({
	flags,
	heightPx,
	text,
	thinkingStartedAt,
	thinkingText,
	zoom,
}: FloatingPillProps) {
	const { isSpeaking, isThinking, showBubble, stickyShow } = flags;
	return (
		// Floating-bottom keeps `domAnimation` (no layout animations). The
		// text bubble carries a `layout` prop for historical reasons; under
		// `domMax` it would activate framer's layout-tween system and the
		// bubble's per-line growth would suddenly animate every keystroke —
		// the "weird expansion" we don't want. `domAnimation` ignores
		// `layout`, restoring the pre-DynamicIsland floating-pill behavior.
		<LazyMotion features={domAnimation} strict>
			<div className="flex h-screen w-screen items-end justify-center overflow-hidden pb-3">
				{/* `relative` wrapper anchors the absolute-positioned X cancel
				    button to the bottom-right of the bubble/chip column without
				    expanding the column itself. The button floats in the
				    transparent margin to the right of the pill. */}
				<div className="relative flex flex-col items-center gap-1">
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
											<ThinkingIndicator reasoning={thinkingText} startedAt={thinkingStartedAt} />
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
					    transient "output". The chip is wrapped in a `relative
					    w-fit` container so the X cancel button can be
					    absolutely positioned at the chip's top-right corner
					    without expanding the chip itself (the chip has
					    overflow-hidden for the breathing inset glow). `w-fit`
					    sizes the wrapper to the chip's intrinsic width so the
					    X stays anchored to the chip, not the column (which
					    would grow with the bubble's width). */}
					<div className="relative w-fit">
						<AnimatePresence>
							{stickyShow && (
								<m.div
									animate="animate"
									className="absolute -top-1 -right-3 z-raised"
									exit="exit"
									initial="initial"
									key="cancel-button"
									variants={chipVariants}
								>
									<CancelButton size={16} />
								</m.div>
							)}
						</AnimatePresence>
						<AnimatePresence>
							{stickyShow && (
								<m.div
									animate="animate"
									// Hard-locked chip dimensions. The visualizer is rendered as an
									// absolutely-positioned child below (`absolute inset-0`), so
									// nothing it does — bars swinging with voice amplitude, radial
									// dots oscillating, an SVG variant that draws outside its
									// nominal `h-[24px]` box — can contribute to this element's
									// layout. Width comes from `heightPx * 2.5 + 20`: enough room
									// for the bar variant's widest reasonable barCount (≤12 bars at
									// 4px + 2px gaps fits in 2.5× the icon height) plus 20px of
									// `px-2.5` padding. Height is `heightPx + 8` (visualizer +
									// py-1). `box-border` so the style values include padding.
									className={`relative block shrink-0 overflow-hidden rounded-full ${GLASS_SURFACE} ${CHIP_SHADOW}`}
									exit="exit"
									initial="initial"
									key="visualizer-chip"
									style={{
										width: Math.round(heightPx * 2.5 + 20),
										height: heightPx + 8,
										boxSizing: "border-box",
									}}
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
								    dimensions stay pixel-identical to its
								    resting state. */}
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
									{/* Visualizer rendered absolutely-positioned and centered.
									    Out-of-flow, so its zoom-scaled height never feeds back
									    into the chip's layout box. */}
									<div className="absolute inset-0 flex items-center justify-center">
										<div
											className="flex items-center justify-center"
											style={{ zoom, height: ICON_PRESET_PX }}
										>
											<AudioVisualizer size="icon" />
										</div>
									</div>
								</m.div>
							)}
						</AnimatePresence>
					</div>
				</div>
			</div>
		</LazyMotion>
	);
}

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
	const overlayMode = useSettingsStore((s) => s.settings.general?.overlayMode ?? "floating-bottom");
	const showLiveTranscription = liveDisplay === "in-pill" || liveDisplay === "both";

	const realtime = useTranscriptionStore((s) => s.currentRealtime);
	const ephemeral = useTranscriptionStore((s) => s.ephemeral);
	const isRecordingActive = useTranscriptionStore((s) => s.isRecordingActive);
	const isThinking = useLlmProcessingStore((s) => s.isThinking);
	const thinkingText = useLlmProcessingStore((s) => s.thinkingText);
	const thinkingStartedAt = useLlmProcessingStore((s) => s.thinkingStartedAt);
	// `isSpeaking` (VAD) is still read for the breathing overlay, but it
	// deliberately no longer gates pill mount — that fired hundreds of ms
	// before the first transcribed word, making the pill appear "early".
	const isSpeaking = useVisualizerStore((s) => s.isSpeaking);
	const ttsStatus = useTtsPlaybackStore((s) => s.status);
	// STT (recording or post-recording LLM-thinking) always owns the island.
	const sttOwnsIsland = isRecordingActive || isThinking;
	useTtsIslandBridge(sttOwnsIsland);

	useEffect(() => {
		const unsub = onSettingsChanged((incoming) => {
			setSettings(decodeSettingsPayload(incoming));
		});
		return unsub;
	}, [setSettings]);

	// Click-through is driven by main-process applyShow / applyHide in
	// overlay.ts so the flag flips on the SAME tick as window visibility,
	// no IPC roundtrip race between renderer state and OS pointer dispatch.
	// The previous effect-based flip raced the click itself ("press X
	// while talking → nothing happens" regression), because
	// `isRecordingActive` is a renderer-side mirror that lags the actual
	// window-shown event by however long the IPC + React reconcile takes.
	// `overlaySetIgnoreMouse` is intentionally not called from here.

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
	const sessionShouldShow = (isRecordingActive && hasText) || isThinking;
	// Sticky once-on: hold the pill mounted for the rest of the session even
	// if `currentRealtime` momentarily empties between realtime chunks.
	// Without this, the AnimatePresence around chip + bubble unmounts on every
	// brief text drop and the chip's chipVariants exit (`y: 4`) makes the
	// whole pill visibly bounce up/down as the user speaks. The flag clears
	// when the session truly ends (recording inactive AND not thinking) — the
	// `useResetOnOverlayShow` visibilitychange handler already clears the
	// underlying stores before the next session paints.
	//
	// Implemented with React's "store info from previous renders" pattern
	// (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
	// so the stickiness is captured in render-phase setState rather than a
	// setState-in-effect waterfall.
	const [showPill, setShowPill] = useState(false);
	const sessionActive = isRecordingActive || isThinking;
	const stickyShow = sessionActive ? showPill || sessionShouldShow : false;
	if (stickyShow !== showPill) {
		setShowPill(stickyShow);
	}

	const heightPx = PRESET_HEIGHT_PX[sizePreset];
	// CSS `zoom` (Chromium-supported, including Electron) scales both visual and
	// layout box, so the surrounding flex container auto-sizes around the visualizer.
	const zoom = heightPx / ICON_PRESET_PX;

	// Bubble respects the in-pill transcription setting: if the user routed
	// live text to "in-app" only, the bubble stays hidden for transcription
	// but still appears for the LLM-thinking state (that's a system signal,
	// not "live captions"). Chip remains independent so a recording without
	// in-pill captions still shows the instrument.
	const showBubble = stickyShow && (showText || isThinking);

	// STT pill vs forced TTS read-aloud pill. STT takes precedence: while a
	// dictation session owns the island, any in-flight read was already
	// discarded by `useTtsIslandBridge`, so `ttsStatus` is `idle` here.
	const showTtsIsland = !sttOwnsIsland && ttsStatus !== "idle";
	// STT pill (dynamic-island or floating-bottom). The forced TTS read-aloud pill
	// is a separate, always-mounted animated layer (`TtsIslandLayer`) so it can
	// slide in AND out from the top instead of popping.
	let sttPill: ReactNode;
	if (overlayMode === "dynamic-island") {
		// Top-flush layout: container anchors content to the *top* of the
		// renderer window (which is itself docked at `y = 0` of the primary
		// display via electron/ipc/overlay.ts), so the island sits against
		// the physical top bezel with no gap.
		//
		// Scaling is per-element inside the island (visualizer zoom + text
		// font-size) rather than a uniform outer `zoom`. The shell's width
		// stays bounded by the size preset (max 460px at `long`) regardless
		// of `visualizerSize`, while the visualizer and text grow / shrink
		// individually — same scale curve the floating-bottom pill uses.
		sttPill = (
			<LazyMotion features={domMax} strict>
				<div className="flex h-screen w-screen items-start justify-center overflow-hidden">
					<DynamicIslandProvider initialSize="empty">
						<DynamicIslandPill
							flags={{
								isRecordingActive,
								isSpeaking,
								isThinking,
								showLiveTranscription,
							}}
							sizePreset={sizePreset}
							text={text}
							thinkingStartedAt={thinkingStartedAt}
							thinkingText={thinkingText}
						/>
					</DynamicIslandProvider>
				</div>
			</LazyMotion>
		);
	} else {
		sttPill = (
			<FloatingBottomPill
				flags={{ isSpeaking, isThinking, showBubble, stickyShow }}
				heightPx={heightPx}
				text={text}
				thinkingStartedAt={thinkingStartedAt}
				thinkingText={thinkingText}
				zoom={zoom}
			/>
		);
	}

	return (
		<>
			{/* Owns the Web Audio queue + analyser for this (visible-during-reads)
			    window. Rendered at a STABLE position so switching the visible pill
			    never unmounts it (which would dispose the queue). */}
			<TtsPlaybackMount />
			{/* Forced TTS read-aloud island — always mounted so AnimatePresence can
			    slide it in/out from the top. STT takes precedence: while STT owns the
			    island `showTtsIsland` is false (the read was already discarded). */}
			<TtsIslandLayer show={showTtsIsland} status={ttsStatus} />
			{!showTtsIsland && sttPill}
		</>
	);
}
