"use client";

import { useEffect } from "react";
import { onFullSentence, onRealtimeText } from "@/shared/api/ipc-client";
import { useTranscriptionStore } from "../model/transcription-store";

export function useTranscriptionFeed() {
	const addFinalSentence = useTranscriptionStore((s) => s.addFinalSentence);
	const setRealtimeText = useTranscriptionStore((s) => s.setRealtimeText);

	useEffect(() => {
		console.log("[useTranscriptionFeed] Subscribing to realtime + fullSentence");
		const unsubRealtime = onRealtimeText((text) => {
			console.log("[useTranscriptionFeed] realtime:", text.slice(0, 60));
			setRealtimeText(text);
		});

		const unsubFinal = onFullSentence((text) => {
			console.log("[useTranscriptionFeed] FINAL:", text);
			addFinalSentence(text);
		});

		return () => {
			unsubRealtime();
			unsubFinal();
		};
	}, [addFinalSentence, setRealtimeText]);
}
