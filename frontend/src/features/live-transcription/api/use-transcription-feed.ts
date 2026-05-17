"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useTranscriptionStore } from "@/entities/transcription";
import {
	onFullSentence,
	onNoAudioDetected,
	onRealtimeText,
	onRecordingStart,
	onSpeakerSegments,
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
