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

	useEffect(
		() =>
			onFileTranscriptionProgress((data) => {
				setProgress(data.progress, data.message);
			}),
		[setProgress]
	);

	useEffect(
		() =>
			onFileTranscriptionComplete((data) => {
				setComplete(data.fileName);
			}),
		[setComplete]
	);

	useEffect(
		() =>
			onFileTranscriptionError((data) => {
				setError(data.fileName, data.error);
			}),
		[setError]
	);
}
