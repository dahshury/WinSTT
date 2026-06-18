import { useState } from "react";
import { type DynamicIslandSize } from "@/shared/ui/dynamic-island";

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
 *   2. `!isRecordingActive` collapses to `empty` (0Ã—0) unless thinking —
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
	isTranscribing?: boolean;
	hasShownText: boolean;
}): DynamicIslandSize {
	if (args.isThinking || args.isTranscribing) {
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

/**
 * Whether the overlay pill (floating-bottom chip/bubble OR dynamic island)
 * should be revealed this frame.
 *
 * The pill must NOT appear on the bare recording-start — pressing PTT and
 * holding through the silent lead-in before actually speaking used to pop the
 * pill instantly ("it shows before I've said anything"). It reveals only when
 * the recorder's real smoothed-Silero VAD reports speech onset (`isSpeaking`).
 * Realtime text is deliberately not a first-reveal fallback: the overlay should
 * not display unless VAD detects voice. The VAD signal is gated on
 * `isRecordingActive` so stale state from a prior session can't flash the pill
 * before the next recording arms.
 *
 * The caller latches this sticky for the rest of the session (see
 * `useStickyPillReveal`) so brief inter-word VAD gaps / realtime-text drops
 * don't make the pill flicker, and so final decode / LLM thinking can reuse an
 * already-revealed pill without creating one from silence.
 *
 * Exported for unit testing without mounting the motion-heavy pill tree.
 */
export function computePillReveal(args: {
	isRecordingActive: boolean;
	isSpeaking: boolean;
	hasText: boolean;
	isThinking: boolean;
	isTranscribing?: boolean;
}): boolean {
	return args.isRecordingActive && args.isSpeaking;
}

export function computeStickyPillReveal(args: {
	latchSessionId: number;
	latched: boolean;
	recordingSessionId: number;
	sessionActive: boolean;
	sessionShouldShow: boolean;
}): boolean {
	if (!args.sessionActive) {
		return false;
	}
	return (
		(args.latchSessionId === args.recordingSessionId && args.latched) ||
		args.sessionShouldShow
	);
}

export function useStickyPillReveal({
	recordingSessionId,
	sessionActive,
	sessionShouldShow,
}: {
	recordingSessionId: number;
	sessionActive: boolean;
	sessionShouldShow: boolean;
}): boolean {
	// Adjust the latch DURING render (React's "storing information from previous
	// renders" pattern) rather than in an effect: the sticky `shown` value is
	// genuine hysteresis state (its own prior value feeds back as `latched`), so
	// it can't be a pure render-time derivation — but mutating it via setState in
	// an effect forced a wasted second render before paint. Setting state while
	// rendering lets React re-render in place without committing the stale frame.
	const [latch, setLatch] = useState({
		sessionId: recordingSessionId,
		shown: false,
	});
	const stickyShow = computeStickyPillReveal({
		latchSessionId: latch.sessionId,
		latched: latch.shown,
		recordingSessionId,
		sessionActive,
		sessionShouldShow,
	});
	if (latch.sessionId !== recordingSessionId || latch.shown !== stickyShow) {
		setLatch({ sessionId: recordingSessionId, shown: stickyShow });
	}

	return stickyShow;
}
