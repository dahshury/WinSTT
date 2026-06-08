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
	onTranscriptionStart,
	onTranscriptionFailed,
} from "@/shared/api/ipc-client";

export function useTranscriptionFeed(): void {
	const t = useTranslations("transcription");
	const addFinalSentence = useTranscriptionStore((s) => s.addFinalSentence);
	const attachSpeakerSegments = useTranscriptionStore(
		(s) => s.attachSpeakerSegments,
	);
	const beginRecordingSession = useTranscriptionStore(
		(s) => s.beginRecordingSession,
	);
	const setRealtimeText = useTranscriptionStore((s) => s.setRealtimeText);
	const setRecordingActive = useTranscriptionStore((s) => s.setRecordingActive);
	const setTranscribing = useTranscriptionStore((s) => s.setTranscribing);
	const showEphemeral = useTranscriptionStore((s) => s.showEphemeral);
	const clearEphemeral = useTranscriptionStore((s) => s.clearEphemeral);

	useEffect(() => {
		// On every new recording cycle, wipe the realtime/ephemeral state AND
		// arm `isRecordingActive`. The overlay pill is gated on that flag so a
		// freshly shown overlay window paints empty for one frame (before this
		// event lands) rather than flashing the previous session's text.
		const unsubStart = onRecordingStart(() => {
			beginRecordingSession();
		});

		// `recording_stop` arrives on PTT release / VAD endpoint. Mark the final
		// decode as pending immediately so cloud STT can swap the pill to
		// "Uploading" while the backend finishes packaging the utterance.
		const unsubStop = onRecordingStop(() => {
			if (useTranscriptionStore.getState().isRecordingActive) {
				setTranscribing(true, "uploading");
			}
		});

		const unsubRealtime = onRealtimeText(({ text }) => {
			setRealtimeText(text);
		});

		const unsubTranscriptionStart = onTranscriptionStart(() => {
			setTranscribing(true, "transcribing");
		});

		const unsubFinal = onFullSentence((text) => {
			setRecordingActive(false);
			setTranscribing(false);
			addFinalSentence(text);
		});

		const unsubNoAudio = onNoAudioDetected(() => {
			showEphemeral(t("noAudioDetected"));
			setRecordingActive(false);
			setTranscribing(false);
		});

		// Genuine backend transcriber error — report it honestly in the same
		// ephemeral pill slot instead of the misleading "(no audio detected)".
		const unsubTranscriptionFailed = onTranscriptionFailed(() => {
			showEphemeral(t("transcriptionFailed"));
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
			setRecordingActive(false);
			setTranscribing(false);
			setRealtimeText("");
			clearEphemeral();
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
			unsubTranscriptionStart();
			unsubFinal();
			unsubNoAudio();
			unsubTranscriptionFailed();
			unsubAborted();
			unsubSpeakerSegments();
		};
	}, [
		addFinalSentence,
		attachSpeakerSegments,
		beginRecordingSession,
		setRealtimeText,
		setRecordingActive,
		setTranscribing,
		showEphemeral,
		clearEphemeral,
		t,
	]);
}
