"use client";

import { useEffect } from "react";
import {
	onLlmProcessingEnd,
	onLlmProcessingStart,
	onRecordingStart,
} from "@/shared/api/ipc-client";
import { useLlmProcessingStore } from "../model/llm-processing-store";

export function useLlmProcessingFeed(): void {
	const setThinking = useLlmProcessingStore((s) => s.setThinking);

	useEffect(() => {
		// Reset on every new recording cycle so a stale thinking state from
		// a prior utterance can't leak into the next overlay show.
		const unsubReset = onRecordingStart(() => setThinking(false));
		const unsubStart = onLlmProcessingStart(() => setThinking(true));
		const unsubEnd = onLlmProcessingEnd(() => setThinking(false));

		return () => {
			unsubReset();
			unsubStart();
			unsubEnd();
		};
	}, [setThinking]);
}
