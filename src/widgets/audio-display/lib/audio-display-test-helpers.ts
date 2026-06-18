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

export function getExtension(name: string): string {
	const i = name.lastIndexOf(".");
	return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export interface DroppedFile {
	fileName: string;
	filePath: string;
}

function baseName(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Filter a raw drop to the audio/video files we can actually transcribe and
 * resolve each to a native path. Unsupported types and files without a native
 * path are ignored. Order is preserved so the queue reflects the drop order.
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

export function collectDroppedFilePaths(
	paths: readonly string[],
): DroppedFile[] {
	const out: DroppedFile[] = [];
	for (const filePath of paths) {
		const fileName = baseName(filePath);
		if (!SUPPORTED_EXTENSIONS.has(getExtension(fileName))) {
			continue;
		}
		out.push({ filePath, fileName });
	}
	return out;
}

/** Enqueue supported dropped files and return the number of backend-assigned rows. */
export async function enqueueDroppedFiles(
	files: readonly File[],
): Promise<number> {
	const dropped = collectDroppedFiles(files);
	if (dropped.length === 0) {
		return 0;
	}
	const ids = await fileQueueEnqueue(dropped);
	return Array.isArray(ids) ? ids.length : 0;
}

export async function enqueueDroppedFilePaths(
	paths: readonly string[],
): Promise<number> {
	const dropped = collectDroppedFilePaths(paths);
	if (dropped.length === 0) {
		return 0;
	}
	const ids = await fileQueueEnqueue(dropped);
	return Array.isArray(ids) ? ids.length : 0;
}

export function getContainerClassName(isListenMode: boolean): string {
	const base =
		"relative flex flex-1 flex-col items-center justify-center overflow-hidden";
	const border = isListenMode ? "" : "rounded-lg";
	return `${base} ${border}`;
}

export { SUPPORTED_EXTENSIONS };
