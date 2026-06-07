import { Button as BaseButton } from "@base-ui/react/button";
import { type Variants } from "motion/react";
import { useEffect, useReducer, useRef, useState } from "react";
import { sttAbortOperation } from "@/shared/api/ipc-client";

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

const TRANSCRIBING_WORDS = ["Transcribing"] as const;
const TRANSFORMING_WORDS = ["Transforming text"] as const;

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

function elapsedReducer(
	state: ElapsedState,
	action: ElapsedAction,
): ElapsedState {
	switch (action.type) {
		case "reset":
			return state.start === null && state.elapsedMs === 0
				? state
				: { start: null, elapsedMs: 0 };
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
	const [{ elapsedMs }, dispatch] = useReducer(elapsedReducer, {
		start: null,
		elapsedMs: 0,
	});

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
	return value === "xs" ||
		value === "sm" ||
		value === "md" ||
		value === "lg" ||
		value === "xl"
		? value
		: "xs";
}

// Variants live at module scope so their references stay stable across
// renders (Framer Motion treats a new object identity as a prop change).
//
// Floating-bottom is intentionally only opacity: no lift, no scale, no layout
// motion. The chip and bubble fade together, matching the user's "just fade"
// direction and avoiding bottom-anchor shimmer.
const bubbleVariants: Variants = {
	initial: { opacity: 0 },
	animate: {
		opacity: 1,
		transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
	},
	exit: {
		opacity: 0,
		transition: { duration: 0.18, ease: [0.4, 0, 1, 1] },
	},
};

const chipVariants: Variants = {
	initial: { opacity: 0 },
	animate: {
		opacity: 1,
		transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
	},
	exit: {
		opacity: 0,
		transition: { duration: 0.18, ease: [0.4, 0, 1, 1] },
	},
};

// Inset breathing glow used only while VAD says the user is speaking.
// Opacity-only keyframes (no scale) so the chip's bounding box stays
// pixel-identical to its resting state.
const breatheVariants: Variants = {
	initial: { opacity: 0 },
	animate: {
		opacity: [0.0, 0.45, 0.0],
		transition: {
			duration: 2.2,
			ease: "easeInOut",
			repeat: Number.POSITIVE_INFINITY,
		},
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
const OVERLAY_PANEL_CLOSE_MS = 380;

/**
 * Small X button that cancels the in-flight dictation session. Routes through
 * the same `handleAbortOperation` pipeline the Escape shortcut uses
 * (markSessionAborted + abort Ollama chats + recorder.abort + clear queue +
 * hide overlay).
 *
 * The overlay window starts click-through, but the Tauri show lifecycle makes
 * it cursor-interactive while STT is visible. If the native window remains
 * click-through, this DOM button never receives mouse/touch input.
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
		<BaseButton
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
		</BaseButton>
	);
}

function LivePulse({ isSpeaking }: { isSpeaking: boolean }) {
	return (
		<span
			aria-hidden="true"
			className="inline-block size-2 shrink-0 rounded-full bg-[oklch(62%_0.19_260)]"
			style={
				isSpeaking
					? { boxShadow: "0 0 8px 0 oklch(62% 0.19 260 / 0.7)" }
					: undefined
			}
		/>
	);
}

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

export {
	GLASS_SURFACE,
	BUBBLE_SHADOW,
	CHIP_SHADOW,
	OVERLAY_PANEL_CLOSE_MS,
	type SizePreset,
	PRESET_HEIGHT_PX,
	ICON_PRESET_PX,
	TEXT_FONT_SIZE_PX,
	toPreset,
	bubbleVariants,
	chipVariants,
	breatheVariants,
	TRANSCRIBING_WORDS,
	TRANSFORMING_WORDS,
	CancelButton,
	LivePulse,
	useDelayedUnmount,
	type ElapsedState,
	type ElapsedAction,
	useRecordingElapsed,
};
