import type { Variants } from "motion/react";
import { useEffect, useReducer, useRef, useState } from "react";
import { exitFallbackMs, springs } from "@/shared/lib/springs";
// The glass material tokens now live in shared/ui so every floating pill (overlay,
// TTS island, tray-indicator) draws from ONE source; re-exported here so the
// overlay's existing `./overlay-shell.shared` imports are unchanged.
import {
	BUBBLE_SHADOW,
	CHIP_SHADOW,
	GLASS_SURFACE,
} from "@/shared/ui/glass-pill";

export { BUBBLE_SHADOW, CHIP_SHADOW, GLASS_SURFACE };

export type SizePreset = "xs" | "sm" | "md" | "lg" | "xl";

export const PRESET_HEIGHT_PX: Record<SizePreset, number> = {
	xs: 12,
	sm: 18,
	md: 27,
	lg: 40,
	xl: 60,
};

export const ICON_PRESET_PX = 24;

export const TEXT_FONT_SIZE_PX: Record<SizePreset, number> = {
	xs: 11,
	sm: 12,
	md: 14,
	lg: 16,
	xl: 20,
};

export const TRANSFORMING_WORDS = ["Transforming text"] as const;
export const TRANSCRIBING_WORDS = ["Transcribing"] as const;
export const UPLOADING_WORDS = ["Uploading"] as const;

export interface ElapsedState {
	elapsedMs: number;
	start: number | null;
}

export type ElapsedAction =
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

export function useRecordingElapsed(isRecordingActive: boolean): string {
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

export function toPreset(value: unknown): SizePreset {
	return value === "xs" ||
		value === "sm" ||
		value === "md" ||
		value === "lg" ||
		value === "xl"
		? value
		: "xs";
}

export const bubbleVariants: Variants = {
	initial: { opacity: 0 },
	animate: {
		opacity: 1,
		transition: springs.moderate,
	},
	exit: {
		opacity: 0,
		transition: springs.moderate.exit,
	},
};

export const chipVariants: Variants = {
	initial: { opacity: 0 },
	animate: {
		opacity: 1,
		transition: springs.moderate,
	},
	exit: {
		opacity: 0,
		transition: springs.moderate.exit,
	},
};

export const breatheVariants: Variants = {
	initial: { opacity: 0 },
	animate: {
		opacity: [0.0, 0.45, 0.0],
		transition: {
			duration: 2.2,
			ease: "easeInOut",
			repeat: Number.POSITIVE_INFINITY,
		},
	},
	exit: { opacity: 0, transition: springs.moderate.exit },
};

// Deferred-unmount window for panel closes (TTS island / transform island):
// the slow tier's exit tween plus the shared safety buffer, so the timer stays
// in step with the motion tokens.
export const OVERLAY_PANEL_CLOSE_MS = exitFallbackMs(springs.slow);

export function useDelayedUnmount(visible: boolean, exitMs: number): boolean {
	const [mounted, setMounted] = useState(visible);
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
