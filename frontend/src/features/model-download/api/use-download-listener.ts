import { useEffect } from "react";
import {
	onModelDownloadComplete,
	onModelDownloadProgress,
	onModelDownloadStart,
} from "@/shared/api/ipc-client";
import { useDownloadStore } from "../model/download-store";

export function useDownloadListener(): void {
	const setDownloadStart = useDownloadStore((s) => s.setDownloadStart);
	const setDownloadProgress = useDownloadStore((s) => s.setDownloadProgress);
	const setDownloadComplete = useDownloadStore((s) => s.setDownloadComplete);

	useEffect(
		() =>
			onModelDownloadStart((model) => {
				setDownloadStart(model);
			}),
		[setDownloadStart]
	);

	useEffect(
		() =>
			onModelDownloadProgress((payload) => {
				setDownloadProgress(payload);
			}),
		[setDownloadProgress]
	);

	useEffect(
		() =>
			onModelDownloadComplete((_model, cancelled) => {
				setDownloadComplete(cancelled);
			}),
		[setDownloadComplete]
	);
}
