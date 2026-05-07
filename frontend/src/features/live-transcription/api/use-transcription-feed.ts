"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { onFullSentence, onNoAudioDetected, onRealtimeText } from "@/shared/api/ipc-client";
import { useTranscriptionStore } from "../model/transcription-store";

export function useTranscriptionFeed(): void {
	const t = useTranslations("transcription");
	const addFinalSentence = useTranscriptionStore((s) => s.addFinalSentence);
	const setRealtimeText = useTranscriptionStore((s) => s.setRealtimeText);
	const showEphemeral = useTranscriptionStore((s) => s.showEphemeral);

	useEffect(() => {
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
			unsubRealtime();
			unsubFinal();
			unsubNoAudio();
		};
	}, [addFinalSentence, setRealtimeText, showEphemeral, t]);
}
