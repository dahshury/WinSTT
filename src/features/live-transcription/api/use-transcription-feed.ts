import { useEffect } from "react";
import { useTranslations } from "use-intl";
import { useTranscriptionStore } from "@/entities/transcription";
import {
	onFullSentence,
	onNoAudioDetected,
	onRealtimeText,
	onRecordingStart,
	onRecordingStop,
	onSpeakerSegments,
	onSttSessionAborted,
	onTranscriptionFailed,
} from "@/shared/api/ipc-client";

export function useTranscriptionFeed(): void {
	const t = useTranslations("transcription");
	const addFinalSentence = useTranscriptionStore((s) => s.addFinalSentence);
	const attachSpeakerSegments = useTranscriptionStore((s) => s.attachSpeakerSegments);
	const setRealtimeText = useTranscriptionStore((s) => s.setRealtimeText);
	const setRecordingActive = useTranscriptionStore((s) => s.setRecordingActive);
	const showEphemeral = useTranscriptionStore((s) => s.showEphemeral);
	const clearEphemeral = useTranscriptionStore((s) => s.clearEphemeral);

	useEffect(() => {
		// On every new recording cycle, wipe the realtime/ephemeral state AND
		// arm `isRecordingActive`. The overlay pill is gated on that flag so a
		// freshly shown overlay window paints empty for one frame (before this
		// event lands) rather than flashing the previous session's text.
		const unsubStart = onRecordingStart(() => {
			setRealtimeText("");
			clearEphemeral();
			setRecordingActive(true);
		});

		// Pill = the RECORDING indicator: hide it the instant the PTT key is released
		// (recording_stop), like Handy — NOT keep it up through the whole transcribe.
		// The pill's mount gate is `isRecordingActive || isThinking`, so when an Ollama/LLM
		// post-processor is connected the `isThinking` branch keeps it visible for the
		// reasoning phase; otherwise it vanishes immediately on release. The final text
		// lands via full_sentence (pasted), not in the pill.
		//
		// Also wipe the realtime/ephemeral preview here so it can't survive into the next
		// PTT session. The overlay is a persistent window (hidden, not destroyed), so its
		// store state lives across sessions; clearing on release enforces "the pill never
		// carries the previous transcription" at the consumer, independent of the backend's
		// per-recording reset. Invisible to the user — the pill is hidden the same tick
		// (and the live caption is gated on `isRecordingActive`, which just went false).
		const unsubStop = onRecordingStop(() => {
			setRecordingActive(false);
			setRealtimeText("");
			clearEphemeral();
		});

		const unsubRealtime = onRealtimeText((text) => {
			setRealtimeText(text);
		});

		const unsubFinal = onFullSentence((text) => {
			addFinalSentence(text);
			setRecordingActive(false);
		});

		const unsubNoAudio = onNoAudioDetected(() => {
			showEphemeral(t("noAudioDetected"));
			setRecordingActive(false);
		});

		// Genuine backend transcriber error — report it honestly in the same
		// ephemeral pill slot instead of the misleading "(no audio detected)".
		const unsubTranscriptionFailed = onTranscriptionFailed(() => {
			showEphemeral(t("transcriptionFailed"));
			setRecordingActive(false);
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
			setRealtimeText("");
			clearEphemeral();
			setRecordingActive(false);
		});

		// Diarization arrives a beat after fullSentence — the store attaches
		// segments to the most-recent item (same utterance by construction).
		const unsubSpeakerSegments = onSpeakerSegments((segments) => {
			attachSpeakerSegments(segments);
		});

		return () => {
			unsubStart();
			unsubStop();
			unsubRealtime();
			unsubFinal();
			unsubNoAudio();
			unsubTranscriptionFailed();
			unsubAborted();
			unsubSpeakerSegments();
		};
	}, [
		addFinalSentence,
		attachSpeakerSegments,
		setRealtimeText,
		setRecordingActive,
		showEphemeral,
		clearEphemeral,
		t,
	]);
}
