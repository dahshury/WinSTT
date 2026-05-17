"use client";

import { useTranslations } from "next-intl";
import { type DragEvent, useCallback, useRef, useState } from "react";
import { useSettingsStore } from "@/entities/setting";
import { AudioVisualizer } from "@/features/audio-visualizer";
import { useFileTranscriptionStore } from "@/features/file-transcription";
import { fileTranscribe, getFilePath } from "@/shared/api/ipc-client";
import { Elevated, surfaceBg90, useSurface } from "@/shared/lib/surface";
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

type TranslateFn = ReturnType<typeof useTranslations>;

interface DropValidation {
	errorMessage?: string;
	fileName?: string;
	filePath?: string;
	ok: boolean;
}

function checkExtension(file: File, tf: TranslateFn): DropValidation | null {
	const ext = getExtension(file.name);
	if (SUPPORTED_EXTENSIONS.has(ext)) {
		return null;
	}
	return { ok: false, fileName: file.name, errorMessage: tf("unsupportedFormat", { ext }) };
}

function checkFilePath(file: File, tf: TranslateFn): DropValidation {
	const filePath = getFilePath(file);
	if (!filePath) {
		return { ok: false, fileName: file.name, errorMessage: tf("cannotDetermineFilePath") };
	}
	return { ok: true, fileName: file.name, filePath };
}

function validateDroppedFile(file: File | undefined, tf: TranslateFn): DropValidation {
	if (!file) {
		return { ok: false };
	}
	return checkExtension(file, tf) ?? checkFilePath(file, tf);
}

function extractErrorMessage(err: unknown, tf: TranslateFn): string {
	return err instanceof Error ? err.message : tf("transcriptionFailed");
}

interface RunTranscriptionDeps {
	setError: (name: string, msg: string) => void;
	setProcessing: (name: string) => void;
	tf: TranslateFn;
}

async function runTranscription(
	fileName: string,
	filePath: string,
	deps: RunTranscriptionDeps
): Promise<void> {
	deps.setProcessing(fileName);
	try {
		await fileTranscribe(filePath);
	} catch (err) {
		deps.setError(fileName, extractErrorMessage(err, deps.tf));
	}
}

function getContainerClassName(isListenMode: boolean): string {
	const base = "relative flex flex-1 flex-col items-center justify-center overflow-hidden";
	const border = isListenMode ? "" : "rounded-lg";
	return `${base} ${border}`;
}

function DropZoneOverlay({ visible, label }: { visible: boolean; label: string }) {
	const substrate = useSurface();
	if (!visible) {
		return null;
	}
	return (
		<div
			className={`absolute inset-0 z-overlay flex items-center justify-center border-2 border-accent border-dashed ${surfaceBg90(substrate)}`}
		>
			<p className="font-medium text-accent text-sm">{label}</p>
		</div>
	);
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

			const file = Array.from(e.dataTransfer.files)[0];
			const result = validateDroppedFile(file, tf);
			if (!result.ok) {
				if (result.errorMessage && result.fileName) {
					setError(result.fileName, result.errorMessage);
				}
				return;
			}
			await runTranscription(result.fileName as string, result.filePath as string, {
				setProcessing,
				setError,
				tf,
			});
		},
		[setProcessing, setError, tf]
	);

	return (
		<Elevated
			aria-label={t("ariaLabel")}
			className={getContainerClassName(isListenMode)}
			offset={2}
			onDragEnter={handleDragEnter}
			onDragLeave={handleDragLeave}
			onDragOver={handleDragOver}
			onDrop={handleDrop}
			role="region"
		>
			<div className="absolute inset-0 flex items-center justify-center">
				<AudioVisualizer size="auto" />
			</div>

			<DropZoneOverlay label={t("dropToTranscribe")} visible={isDragOver} />

			<DownloadOverlay />
			<FileOverlay />
			<SubtitleOverlay />
		</Elevated>
	);
}

// Test-only exports — pure helpers extracted from drag/drop handling.
export const __audio_display_test_helpers__ = {
	getExtension,
	validateDroppedFile,
	extractErrorMessage,
	runTranscription,
	getContainerClassName,
	SUPPORTED_EXTENSIONS,
};
