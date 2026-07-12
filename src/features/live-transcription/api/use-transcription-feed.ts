import { useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { IPC } from "@/shared/api/ipc-channels";
import {
	ipcOn,
	onFullSentence,
	onNoAudioDetected,
	onRealtimeText,
	onRecordingStart,
	onRecordingStop,
	onSttSessionAborted,
	onTranscriptionStart,
	onTranscriptionFailed,
	onVadStart,
} from "@/shared/api/ipc-client";

/** Payload of `stt:pipeline-unavailable` — a cloud STT pipeline that can't run offline. */
interface PipelineUnavailablePayload {
	reason?: string;
}
/** How long the offline "no internet & no local model" pill stays up (matches the backend hide). */
const OFFLINE_NOTICE_HOLD_MS = 4000;

const COMPLETED_SESSION_CLEAR_MS = 1200;
let completedSessionClearTimer: ReturnType<typeof setTimeout> | null = null;

function clearCompletedSessionTimer(): void {
	if (completedSessionClearTimer !== null) {
		clearTimeout(completedSessionClearTimer);
		completedSessionClearTimer = null;
	}
}

function scheduleCompletedSessionClear(sessionId: number): void {
	clearCompletedSessionTimer();
	completedSessionClearTimer = setTimeout(() => {
		const state = useTranscriptionStore.getState();
		if (
			state.recordingSessionId === sessionId &&
			!state.isRecordingActive &&
			!state.isTranscribing
		) {
			state.clearItems();
		}
		completedSessionClearTimer = null;
	}, COMPLETED_SESSION_CLEAR_MS);
}

function shouldIgnoreEmptyRealtimeDrop(
	text: string,
	recordingMode: string,
): boolean {
	if (recordingMode === "listen") {
		return false;
	}
	const state = useTranscriptionStore.getState();
	// Cold realtime can briefly publish text -> empty -> text before two
	// windows agree. Keep the visible words until a real lifecycle reset lands.
	return (
		state.isRecordingActive &&
		state.currentRealtime.trim().length > 0 &&
		text.trim().length === 0
	);
}

export function useTranscriptionFeed(): void {
	const t = useTranslations("transcription");
	const voiceActivitySeenRef = useRef(false);
	const recordingMode = useSettingsStore(
		(s) => s.settings.general?.recordingMode ?? "ptt",
	);
	// Initialised with a stable literal (not the reactive `recordingMode`) so
	// the ref isn't touched with render-time reactive state — which
	// `react-hooks-js/refs` flags. The effect below syncs the live value before
	// any IPC handler (subscribed in the later effect) can read it.
	const recordingModeRef = useRef<string>("ptt");
	useEffect(() => {
		recordingModeRef.current = recordingMode;
	}, [recordingMode]);
	const addFinalSentence = useTranscriptionStore((s) => s.addFinalSentence);
	const beginRecordingSession = useTranscriptionStore(
		(s) => s.beginRecordingSession,
	);
	const setRealtimeText = useTranscriptionStore((s) => s.setRealtimeText);
	const setRecordingActive = useTranscriptionStore((s) => s.setRecordingActive);
	const setTranscribing = useTranscriptionStore((s) => s.setTranscribing);
	const showEphemeral = useTranscriptionStore((s) => s.showEphemeral);
	const clearEphemeral = useTranscriptionStore((s) => s.clearEphemeral);

	// Switching recording modes emits no recording-lifecycle IPC event today,
	// so state that only clears on terminal events (full_sentence,
	// no_audio_detected, stt_session_aborted, transcription_failed) can carry
	// over into the new mode. Listen mode is the sharpest case: it's
	// continuous, so its `recording_start` just latches `isRecordingActive`
	// and nothing ever fires a terminal event to release it -- switching away
	// left the overlay pill stuck revealed. Reset the per-session UI state at
	// every mode boundary; harmlessly idempotent alongside terminal-event
	// resets and the backend's own mode-exit teardown.
	const prevRecordingModeRef = useRef<string | null>(null);
	useEffect(() => {
		const previousMode = prevRecordingModeRef.current;
		prevRecordingModeRef.current = recordingMode;
		if (previousMode === null || previousMode === recordingMode) {
			return;
		}
		voiceActivitySeenRef.current = false;
		clearCompletedSessionTimer();
		setRecordingActive(false);
		setTranscribing(false);
		setRealtimeText("");
		clearEphemeral();
	}, [
		recordingMode,
		setRecordingActive,
		setTranscribing,
		setRealtimeText,
		clearEphemeral,
	]);

	useEffect(() => {
		// On every non-listen recording cycle, wipe the realtime/ephemeral state
		// and arm `isRecordingActive`. Listen mode is continuous, so
		// recording_start only means "loopback capture is armed"; deleting visible
		// captions there makes long-form subtitles jump.
		const unsubStart = onRecordingStart(() => {
			voiceActivitySeenRef.current = false;
			clearCompletedSessionTimer();
			if (recordingModeRef.current === "listen") {
				setRecordingActive(true);
				return;
			}
			beginRecordingSession();
		});

		// `recording_stop` arrives on PTT release / VAD endpoint. Mark the final
		// decode as pending immediately so cloud STT can swap the pill to
		// "Uploading" while the backend finishes packaging the utterance, but only
		// once this session has seen VAD-confirmed speech. A silent press still emits
		// recording_stop before the backend can classify samples, and should wait
		// for no_audio_detected instead of flashing processing UI.
		const unsubStop = onRecordingStop(() => {
			if (
				useTranscriptionStore.getState().isRecordingActive &&
				voiceActivitySeenRef.current
			) {
				setTranscribing(true, "uploading");
			}
		});

		const unsubRealtime = onRealtimeText(({ text }) => {
			const isListenMode = recordingModeRef.current === "listen";
			if (isListenMode && text.trim().length === 0) {
				setRealtimeText("");
				return;
			}
			if (shouldIgnoreEmptyRealtimeDrop(text, recordingModeRef.current)) {
				return;
			}
			if (isListenMode) {
				clearEphemeral();
			}
			setRealtimeText(text);
		});

		const unsubVadStart = onVadStart(() => {
			voiceActivitySeenRef.current = true;
			if (recordingModeRef.current === "listen") {
				clearEphemeral();
			}
		});

		const unsubTranscriptionStart = onTranscriptionStart(() => {
			if (voiceActivitySeenRef.current) {
				setTranscribing(true, "transcribing");
			}
		});

		const unsubFinal = onFullSentence((text) => {
			voiceActivitySeenRef.current = false;
			const isListenMode = recordingModeRef.current === "listen";
			const sessionId = useTranscriptionStore.getState().recordingSessionId;
			if (!isListenMode) {
				setRecordingActive(false);
			}
			setTranscribing(false);
			addFinalSentence(text);
			if (sessionId > 0 && !isListenMode) {
				scheduleCompletedSessionClear(sessionId);
			}
		});

		const unsubNoAudio = onNoAudioDetected(() => {
			voiceActivitySeenRef.current = false;
			clearCompletedSessionTimer();
			setRealtimeText("");
			clearEphemeral();
			setRecordingActive(false);
			setTranscribing(false);
		});

		// Genuine backend transcriber error — report it honestly in the same
		// ephemeral pill slot instead of the misleading "(no audio detected)".
		const unsubTranscriptionFailed = onTranscriptionFailed((payload = {}) => {
			voiceActivitySeenRef.current = false;
			clearCompletedSessionTimer();
			const message = payload.message?.trim() || t("transcriptionFailed");
			setRealtimeText("");
			showEphemeral(message);
			setRecordingActive(false);
			setTranscribing(false);
		});

		// User-initiated cancel. The relay's session-aborted gate drops the
		// terminal events that would normally reset isRecordingActive
		// (no_audio_detected during the abort epilogue, fullSentence from
		// an in-flight transcribe). Without resetting here, the visualizer
		// in the main window stays armed on isRecordingActive=true and the
		// pill / waveform animate as if the recording were still live,
		// even though the server has fully shut it down. Treat the abort
		// as a terminal event so the renderer state matches the server's
		// post-abort INACTIVE state.
		const unsubAborted = onSttSessionAborted(() => {
			voiceActivitySeenRef.current = false;
			clearCompletedSessionTimer();
			setRecordingActive(false);
			setTranscribing(false);
			setRealtimeText("");
			clearEphemeral();
		});

		// Offline graceful degradation: the selected cloud STT model is unreachable
		// and no local model is installed to fall back to. Surface it as an error
		// ephemeral so the overlay pill reveals (even with no active recording) and
		// says "no internet & no local model" instead of failing silently.
		const unsubUnavailable = ipcOn(IPC.STT_PIPELINE_UNAVAILABLE, (data) => {
			const reason = (data as PipelineUnavailablePayload).reason;
			const message =
				reason === "offline_no_local"
					? t("offlineNoLocalModel")
					: t("transcriptionFailed");
			voiceActivitySeenRef.current = false;
			clearCompletedSessionTimer();
			setRealtimeText("");
			setRecordingActive(false);
			setTranscribing(false);
			showEphemeral(message, OFFLINE_NOTICE_HOLD_MS, "error");
		});

		return () => {
			unsubStart();
			unsubStop();
			unsubRealtime();
			unsubVadStart();
			unsubTranscriptionStart();
			unsubFinal();
			unsubNoAudio();
			unsubTranscriptionFailed();
			unsubAborted();
			unsubUnavailable();
		};
	}, [
		addFinalSentence,
		beginRecordingSession,
		setRealtimeText,
		setRecordingActive,
		setTranscribing,
		showEphemeral,
		clearEphemeral,
		t,
	]);
}
