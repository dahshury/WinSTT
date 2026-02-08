"use client";

import { useEffect } from "react";
import { onFullSentence, onRealtimeText } from "@/shared/api/ipc-client";
import { useTranscriptionStore } from "../model/transcription-store";

export function useTranscriptionFeed() {
	const addFinalSentence = useTranscriptionStore((s) => s.addFinalSentence);
	const setRealtimeText = useTranscriptionStore((s) => s.setRealtimeText);

	useEffect(() => {
		const unsubRealtime = onRealtimeText((text) => {
			setRealtimeText(text);
		});

		const unsubFinal = onFullSentence((text) => {
			addFinalSentence(text);
		});

		return () => {
			unsubRealtime();
			unsubFinal();
		};
	}, [addFinalSentence, setRealtimeText]);
}
