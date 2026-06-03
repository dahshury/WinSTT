import { fileQueueEnqueue, getFilePath } from "@/shared/api/ipc-client";

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

export interface DroppedFile {
	fileName: string;
	filePath: string;
}

/**
 * Filter a raw drop to the audio/video files we can actually transcribe and
 * resolve each to a native path. Unsupported types (a stray image, a folder)
 * and files we can't get a path for are dropped silently — the queue only ever
 * sees real, transcribable inputs. Order is preserved so the queue reflects the
 * drop order.
 */
function collectDroppedFiles(files: readonly File[]): DroppedFile[] {
	const out: DroppedFile[] = [];
	for (const file of files) {
		if (!SUPPORTED_EXTENSIONS.has(getExtension(file.name))) {
			continue;
		}
		const filePath = getFilePath(file);
		if (!filePath) {
			continue;
		}
		out.push({ filePath, fileName: file.name });
	}
	return out;
}

/**
 * Enqueue every transcribable file from a drop. Appends to the existing queue
 * (the main process never clears on a new drop), so repeated drops accumulate.
 * Returns the number of files actually enqueued.
 */
async function enqueueDroppedFiles(files: readonly File[]): Promise<number> {
	const collected = collectDroppedFiles(files);
	if (collected.length > 0) {
		await fileQueueEnqueue(collected);
	}
	return collected.length;
}

function getContainerClassName(isListenMode: boolean): string {
	const base = "relative flex flex-1 flex-col items-center justify-center overflow-hidden";
	const border = isListenMode ? "" : "rounded-lg";
	return `${base} ${border}`;
}

export { enqueueDroppedFiles, getContainerClassName };

// Test-only exports — pure helpers extracted from drag/drop handling.
export const __audio_display_test_helpers__ = {
	getExtension,
	collectDroppedFiles,
	enqueueDroppedFiles,
	getContainerClassName,
	SUPPORTED_EXTENSIONS,
};
