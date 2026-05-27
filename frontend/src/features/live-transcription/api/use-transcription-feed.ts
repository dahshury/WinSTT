import { useEffect } from "react";
import { useTranslations } from "use-intl";
import { useTranscriptionStore } from "@/entities/transcription";
import {
	onFullSentence,
	onNoAudioDetected,
	onRealtimeText,
	onRecordingStart,
	onSpeakerSegments,
	onSttSessionAborted,
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
		// `isRecordingActive` deliberately stays `true` across `recording_stop`
		// so the pill remains visible through the LLM "thinking" transition;
		// it's reset only on terminal events (full_sentence / no_audio_detected).
		const unsubStart = onRecordingStart(() => {
			setRealtimeText("");
			clearEphemeral();
			setRecordingActive(true);
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
			unsubRealtime();
			unsubFinal();
			unsubNoAudio();
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
