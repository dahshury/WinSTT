"use client";

import { useEffect } from "react";
import {
	onLlmProcessingEnd,
	onLlmProcessingStart,
	onLlmReasoningDelta,
	onRecordingStart,
} from "@/shared/api/ipc-client";
import { useLlmProcessingStore } from "../model/llm-processing-store";

export function useLlmProcessingFeed(): void {
	const setThinking = useLlmProcessingStore((s) => s.setThinking);
	const appendThinking = useLlmProcessingStore((s) => s.appendThinking);
	const clearThinking = useLlmProcessingStore((s) => s.clearThinking);

	useEffect(() => {
		// Reset on every new recording cycle so a stale thinking state from
		// a prior utterance can't leak into the next overlay show.
		const unsubReset = onRecordingStart(() => {
			setThinking(false);
			clearThinking();
		});
		const unsubStart = onLlmProcessingStart(() => {
			clearThinking();
			setThinking(true);
		});
		const unsubEnd = onLlmProcessingEnd(() => {
			setThinking(false);
			clearThinking();
		});
		const unsubDelta = onLlmReasoningDelta(({ delta }) => {
			appendThinking(delta);
		});

		return () => {
			unsubReset();
			unsubStart();
			unsubEnd();
			unsubDelta();
		};
	}, [setThinking, appendThinking, clearThinking]);
}
