"use client";

import { useTranslations } from "next-intl";
import { type DragEvent, useCallback, useRef, useState } from "react";
import { WaveformBars } from "@/features/audio-visualizer";
import { useFileTranscriptionStore } from "@/features/file-transcription";
import { useSettingsStore } from "@/features/update-settings";
import { fileTranscribe, getFilePath } from "@/shared/api/ipc-client";
import { DownloadOverlay } from "./DownloadOverlay";
import { FileOverlay } from "./FileOverlay";
import { SubtitleOverlay } from "./SubtitleOverlay";

const SUPPORTED_EXTENSIONS = new Set([
	".mp3",
	".wav",
	".flac",
	".m4a",
	".aac",
	".ogg",
	".wma",
	".mp4",
	".mkv",
	".avi",
	".mov",
	".wmv",
	".flv",
	".webm",
]);

function getExtension(name: string): string {
	const i = name.lastIndexOf(".");
	return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export function AudioDisplay() {
	const isListenMode = useSettingsStore((s) => s.settings.general?.recordingMode) === "listen";
	const setProcessing = useFileTranscriptionStore((s) => s.setProcessing);
	const setError = useFileTranscriptionStore((s) => s.setError);
	const t = useTranslations("audioDisplay");
	const tf = useTranslations("fileOverlay");

	const [isDragOver, setIsDragOver] = useState(false);
	const dragCounter = useRef(0);

	const handleDragEnter = useCallback((e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounter.current++;
		if (e.dataTransfer.types.includes("Files")) {
			setIsDragOver(true);
		}
	}, []);

	const handleDragOver = useCallback((e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = "copy";
	}, []);

	const handleDragLeave = useCallback((e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounter.current--;
		if (dragCounter.current <= 0) {
			dragCounter.current = 0;
			setIsDragOver(false);
		}
	}, []);

	const handleDrop = useCallback(
		async (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			dragCounter.current = 0;
			setIsDragOver(false);

			const files = Array.from(e.dataTransfer.files);
			const file = files[0];
			if (!file) {
				return;
			}

			const ext = getExtension(file.name);
			if (!SUPPORTED_EXTENSIONS.has(ext)) {
				setError(file.name, tf("unsupportedFormat", { ext }));
				return;
			}

			const filePath = getFilePath(file);
			if (!filePath) {
				setError(file.name, tf("cannotDetermineFilePath"));
				return;
			}

			setProcessing(file.name);
			try {
				await fileTranscribe(filePath);
			} catch (err) {
				setError(file.name, err instanceof Error ? err.message : tf("transcriptionFailed"));
			}
		},
		[setProcessing, setError, tf]
	);

	return (
		// biome-ignore lint/a11y/noNoninteractiveElementInteractions: drop zone for file transcription
		<section
			aria-label="Audio display and file drop zone"
			className={`relative flex flex-1 flex-col items-center justify-center overflow-hidden bg-surface-secondary ${isListenMode ? "" : "rounded-lg border border-border"}`}
			onDragEnter={handleDragEnter}
			onDragLeave={handleDragLeave}
			onDragOver={handleDragOver}
			onDrop={handleDrop}
		>
			<WaveformBars />

			{/* Drag-over drop zone overlay */}
			{isDragOver && (
				<div className="absolute inset-0 z-20 flex items-center justify-center border-2 border-accent border-dashed bg-surface-secondary/90">
					<p className="font-medium text-accent text-sm">{t("dropToTranscribe")}</p>
				</div>
			)}

			<DownloadOverlay />
			<FileOverlay />
			<SubtitleOverlay />
		</section>
	);
}
