import { AnimatePresence, domAnimation, domMax, LazyMotion, m, type Variants } from "motion/react";
import { useEffect, useState } from "react";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import {
	AudioVisualizer,
	useVisualizerStore,
	useVisualizerSync,
} from "@/features/audio-visualizer";
import { useTranscriptionFeed } from "@/features/live-transcription";
import { useLlmProcessingFeed, useLlmProcessingStore } from "@/features/llm-processing";
import {
	onSettingsChanged,
	overlaySetIgnoreMouse,
	sttAbortOperation,
} from "@/shared/api/ipc-client";
import { decodeSettingsPayload } from "@/shared/api/settings-codec";
import {
	DynamicIsland,
	DynamicIslandProvider,
	type DynamicIslandSize,
	useDynamicIslandSize,
} from "@/shared/ui/dynamic-island";
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
function useRecordingElapsed(isRecordingActive: boolean): string {
	const [elapsedMs, setElapsedMs] = useState(0);

	useEffect(() => {
		if (!isRecordingActive) {
			setElapsedMs(0);
			return;
		}
		const start = Date.now();
		setElapsedMs(0);
		const interval = setInterval(() => {
			setElapsedMs(Date.now() - start);
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
 *   1. `isThinking` always wins — the LLM-thinking state survives the
 *      recording → post-processing transition. `long` gives the
 *      ThinkingIndicator a comfortable wide surface; height grows to fit.
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
		return "long";
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

interface IslandStateArgs {
	isRecordingActive: boolean;
	isSpeaking: boolean;
	isThinking: boolean;
	showLiveTranscription: boolean;
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
	isRecordingActive,
	isSpeaking,
	isThinking,
	sizePreset,
	text,
	thinkingText,
	thinkingStartedAt,
	showLiveTranscription,
}: IslandStateArgs) {
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
					<ThinkingIndicator reasoning={thinkingText} startedAt={thinkingStartedAt} />
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
	const handleClick = () => {
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
			onClick={handleClick}
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
			className="inline-block h-2 w-2 shrink-0 rounded-full bg-[oklch(62%_0.19_260)]"
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
	const { setSize } = useDynamicIslandSize();
	const target = computeIslandSize({
		isRecordingActive: args.isRecordingActive,
		isSpeaking: args.isSpeaking,
		isThinking: args.isThinking,
		hasShownText: args.showLiveTranscription && args.text.length > 0,
	});

	useEffect(() => {
		setSize(target);
	}, [target, setSize]);

	return (
		<DynamicIsland fitContent flatTop id="winstt-overlay-island">
			{/* X cancel anchored to the top-right of the island, just inside the
			    rounded bottom-right area. Absolute-positioned so it stays visible
			    in both the recording state (alongside the timer) and the LLM-
			    thinking state (which hides the header row entirely). The 8px
			    top inset matches the island's `pt-1` content padding. */}
			<div className="pointer-events-auto absolute top-2 right-3 z-10">
				<CancelButton size={14} />
			</div>
			<DynamicIslandPillContent {...args} />
		</DynamicIsland>
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

	useEffect(() => {
		const unsub = onSettingsChanged((incoming) => {
			setSettings(decodeSettingsPayload(incoming));
		});
		return unsub;
	}, [setSettings]);

	// While the X cancel button is visible (a recording or LLM-thinking pass
	// is in flight), make the whole overlay window interactive so taps land.
	// The default is click-through (set in electron/main.ts createOverlayWindow
	// and re-asserted by overlay.ts) so the empty pill never blocks clicks to
	// the app underneath. The hover-based flip in CancelButton works for mouse
	// users (mouseenter → ignore=false → click) but FAILS on touch: a touch
	// device emits no preceding mousemove the renderer can react to in time —
	// the synthesized mouse-down arrives at the OS before the renderer's
	// `overlaySetIgnoreMouse(false)` IPC roundtrip completes, so the click
	// falls through to the app underneath and the X is unreachable.
	// Proactively disabling click-through during the active window is the
	// only way to make the X tappable on touch.
	useEffect(() => {
		const interactive = isRecordingActive || isThinking;
		overlaySetIgnoreMouse(!interactive);
	}, [isRecordingActive, isThinking]);

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
	const [showPill, setShowPill] = useState(false);
	useEffect(() => {
		if (sessionShouldShow) {
			setShowPill(true);
		} else if (!(isRecordingActive || isThinking)) {
			setShowPill(false);
		}
	}, [sessionShouldShow, isRecordingActive, isThinking]);

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
		return (
			<LazyMotion features={domMax} strict>
				<div className="flex h-screen w-screen items-start justify-center overflow-hidden">
					<DynamicIslandProvider initialSize="empty">
						<DynamicIslandPill
							isRecordingActive={isRecordingActive}
							isSpeaking={isSpeaking}
							isThinking={isThinking}
							showLiveTranscription={showLiveTranscription}
							sizePreset={sizePreset}
							text={text}
							thinkingStartedAt={thinkingStartedAt}
							thinkingText={thinkingText}
						/>
					</DynamicIslandProvider>
				</div>
			</LazyMotion>
		);
	}

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
							{showPill && (
								<m.div
									animate="animate"
									className="absolute -top-1 -right-3 z-10"
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
							{showPill && (
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
