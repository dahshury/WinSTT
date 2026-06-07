import { getFilePath } from "@/shared/api/ipc-client";

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

export function getExtension(name: string): string {
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
export function collectDroppedFiles(files: readonly File[]): DroppedFile[] {
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
 * Drag/drop exposes renderer-resolved file paths, which the backend no longer
 * accepts for file transcription. Keep collection helpers for tests/display, but
 * do not enqueue from dropped paths.
 */
export async function enqueueDroppedFiles(
	files: readonly File[],
): Promise<number> {
	const _collected = collectDroppedFiles(files);
	return 0;
}

export function getContainerClassName(isListenMode: boolean): string {
	const base =
		"relative flex flex-1 flex-col items-center justify-center overflow-hidden";
	const border = isListenMode ? "" : "rounded-lg";
	return `${base} ${border}`;
}

export { SUPPORTED_EXTENSIONS };
