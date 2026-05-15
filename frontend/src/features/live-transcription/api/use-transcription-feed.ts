"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useTranscriptionStore } from "@/entities/transcription";
import {
	onFullSentence,
	onNoAudioDetected,
	onRealtimeText,
	onRecordingStart,
} from "@/shared/api/ipc-client";

export function useTranscriptionFeed(): void {
	const t = useTranslations("transcription");
	const addFinalSentence = useTranscriptionStore((s) => s.addFinalSentence);
	const setRealtimeText = useTranscriptionStore((s) => s.setRealtimeText);
	const showEphemeral = useTranscriptionStore((s) => s.showEphemeral);
	const clearEphemeral = useTranscriptionStore((s) => s.clearEphemeral);

	useEffect(() => {
		// On every new recording cycle, wipe the realtime/ephemeral state.
		// Without this, the pill briefly flashes the previous cycle's
		// transcription (or a stale "no audio detected" ephemeral) when it
		// re-shows for the next PTT press, until new audio arrives and
		// drives fresh updates.
		const unsubStart = onRecordingStart(() => {
			setRealtimeText("");
			clearEphemeral();
		});

		const unsubRealtime = onRealtimeText((text) => {
			setRealtimeText(text);
		});

		const unsubFinal = onFullSentence((text) => {
			addFinalSentence(text);
		});

		const unsubNoAudio = onNoAudioDetected(() => {
			showEphemeral(t("noAudioDetected"));
		});

		return () => {
			unsubStart();
			unsubRealtime();
			unsubFinal();
			unsubNoAudio();
		};
	}, [addFinalSentence, setRealtimeText, showEphemeral, clearEphemeral, t]);
}
