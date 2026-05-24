export type LiveTranscriptionDisplay = "none" | "in-app" | "in-pill" | "both";
export type RecordingMode = "ptt" | "toggle" | "listen" | "wakeword";

interface DisplayState {
	liveTranscriptionDisplay: LiveTranscriptionDisplay;
	showRecordingOverlay: boolean;
}

// The recording pill is visible iff the floating overlay is on AND the live-
// transcription mode includes the pill ("in-pill" or "both"). Pure predicate
// on the General-tab toggles — independent of recording mode.
export function isPillVisible({
	showRecordingOverlay,
	liveTranscriptionDisplay,
}: DisplayState): boolean {
	return (
		showRecordingOverlay &&
		(liveTranscriptionDisplay === "in-pill" || liveTranscriptionDisplay === "both")
	);
}

// True iff at least one consumer of realtime text actually renders. Realtime
// has three possible surfaces — the recording pill, the main-window in-app
// panel, and the listen-mode subtitle overlay — and all three gate on
// `liveTranscriptionDisplay`. The in-app/listen paths consume "in-app" or
// "both"; the pill path consumes "in-pill" or "both" but only when the
// overlay window is shown. If no path is reachable the realtime model has no
// observable output and shouldn't run.
//
// The realtime engine is the SOLE source of live preview text — there is no
// "I want the panel but not the engine" configuration to preserve. So this
// function (composed with no other state) IS the effective on/off switch.
export function isRealtimeEnabled({
	showRecordingOverlay,
	liveTranscriptionDisplay,
}: DisplayState): boolean {
	if (liveTranscriptionDisplay === "none") {
		return false;
	}
	if (liveTranscriptionDisplay === "in-app" || liveTranscriptionDisplay === "both") {
		return true;
	}
	// liveTranscriptionDisplay === "in-pill" — requires the overlay window to
	// be visible for the pill to render.
	return showRecordingOverlay;
}
