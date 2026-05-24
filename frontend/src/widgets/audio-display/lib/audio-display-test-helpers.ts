import type { useTranslations } from "next-intl";
import { fileTranscribe, getFilePath } from "@/shared/api/ipc-client";

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

export type { DropValidation, RunTranscriptionDeps, TranslateFn };
export {
	checkExtension,
	checkFilePath,
	extractErrorMessage,
	getContainerClassName,
	getExtension,
	runTranscription,
	SUPPORTED_EXTENSIONS,
	validateDroppedFile,
};

// Test-only exports — pure helpers extracted from drag/drop handling.
export const __audio_display_test_helpers__ = {
	getExtension,
	validateDroppedFile,
	extractErrorMessage,
	runTranscription,
	getContainerClassName,
	SUPPORTED_EXTENSIONS,
};
