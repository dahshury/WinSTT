"use client";

import { useEffect } from "react";
import {
	onFileTranscriptionComplete,
	onFileTranscriptionError,
	onFileTranscriptionProgress,
} from "@/shared/api/ipc-client";
import { useFileTranscriptionStore } from "./file-transcription-store";

export function useFileTranscriptionListener(): void {
	const setProgress = useFileTranscriptionStore((s) => s.setProgress);
	const setComplete = useFileTranscriptionStore((s) => s.setComplete);
	const setError = useFileTranscriptionStore((s) => s.setError);

	useEffect(() => {
		const unsubs = [
			onFileTranscriptionProgress((data) => {
				setProgress(data.progress, data.message);
			}),
			onFileTranscriptionComplete((data) => {
				setComplete(data.fileName);
			}),
			onFileTranscriptionError((data) => {
				setError(data.fileName, data.error);
			}),
		];
		return () => {
			for (const unsub of unsubs) {
				unsub();
			}
		};
	}, [setProgress, setComplete, setError]);
}
