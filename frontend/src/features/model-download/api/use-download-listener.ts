"use client";

import { useEffect } from "react";
import {
	onModelDownloadComplete,
	onModelDownloadProgress,
	onModelDownloadStart,
} from "@/shared/api/ipc-client";
import { useDownloadStore } from "../model/download-store";

export function useDownloadListener() {
	const setDownloadStart = useDownloadStore((s) => s.setDownloadStart);
	const setDownloadProgress = useDownloadStore((s) => s.setDownloadProgress);
	const setDownloadComplete = useDownloadStore((s) => s.setDownloadComplete);

	useEffect(() => {
		const unsub1 = onModelDownloadStart((model) => {
			setDownloadStart(model);
		});
		const unsub2 = onModelDownloadProgress((payload) => {
			setDownloadProgress(payload);
		});
		const unsub3 = onModelDownloadComplete((_model, cancelled) => {
			setDownloadComplete(cancelled);
		});
		return () => {
			unsub1();
			unsub2();
			unsub3();
		};
	}, [setDownloadStart, setDownloadProgress, setDownloadComplete]);
}
