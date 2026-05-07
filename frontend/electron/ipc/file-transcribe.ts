import fs from "node:fs";
import path from "node:path";
import { type BrowserWindow, ipcMain } from "electron";
import {
	ConnectionError,
	FileSystemError,
	getErrorMessage,
	NotFoundError,
	ValidationError,
} from "../../src/shared/lib/errors";
import { createSafeSender, type SafeSend } from "../lib/ipc-helpers";
import { getStoreValue } from "../lib/store";
import type { SttClient } from "../ws/stt-client";

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

let requestCounter = 0;

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function handleProgressEvent(event: Record<string, unknown>, safeSend: SafeSend): void {
	safeSend("file:transcription-progress", {
		fileName: asOptionalString(event.file_name),
		progress: asOptionalNumber(event.progress),
		message: asOptionalString(event.message),
	});
}

function handleErrorEvent(
	event: Record<string, unknown>,
	pendingRequests: Map<string, string>,
	safeSend: SafeSend
): void {
	const requestId = asString(event.request_id);
	const fileName = asOptionalString(event.file_name);
	if (requestId) {
		pendingRequests.delete(requestId);
	}
	safeSend("file:transcription-error", {
		requestId,
		fileName:
			fileName ?? (typeof event.file_path === "string" ? path.basename(event.file_path) : ""),
		error: asString(event.error) || "Unknown error",
	});
}

async function writeTranscriptionOutput(
	outputPath: string,
	text: string,
	requestId: string,
	fileName: string,
	pendingRequests: Map<string, string>,
	safeSend: SafeSend
): Promise<boolean> {
	try {
		await fs.promises.writeFile(outputPath, text, "utf-8");
		return true;
	} catch (err) {
		console.error(
			"[file-transcribe] Failed to write output:",
			getErrorMessage(err),
			"Path:",
			outputPath
		);
		const fileError = new FileSystemError(
			`Failed to write transcription output: ${getErrorMessage(err)}`,
			outputPath,
			"write",
			{ originalError: err }
		);
		safeSend("file:transcription-error", {
			requestId,
			fileName,
			error: fileError.message,
		});
		pendingRequests.delete(requestId);
		return false;
	}
}

async function handleCompleteEvent(
	event: Record<string, unknown>,
	pendingRequests: Map<string, string>,
	safeSend: SafeSend
): Promise<void> {
	const requestId = asString(event.request_id);
	const filePath = asString(event.file_path);
	const text = asString(event.text);
	const fileName = asString(event.file_name);
	const fmt = asString(event.format) || "txt";

	if (!(requestId && filePath && fileName)) {
		console.error("[file-transcribe] Incomplete transcription_complete event, skipping");
		return;
	}

	// Validate that the filePath was one we actually requested (prevent arbitrary writes)
	const expectedPath = pendingRequests.get(requestId);
	if (!expectedPath || path.resolve(filePath) !== path.resolve(expectedPath)) {
		console.error(
			"[file-transcribe] file_path mismatch — expected:",
			expectedPath,
			"got:",
			filePath
		);
		pendingRequests.delete(requestId);
		return;
	}

	// Sanitize format extension to prevent path traversal via format field
	const safeFmt = fmt.replace(/[^a-zA-Z0-9]/g, "") || "txt";
	const outputPath = `${filePath}.${safeFmt}`;

	const written = await writeTranscriptionOutput(
		outputPath,
		text,
		requestId,
		fileName,
		pendingRequests,
		safeSend
	);
	if (!written) {
		return;
	}

	pendingRequests.delete(requestId);
	safeSend("file:transcription-complete", {
		requestId,
		fileName,
		text,
		outputPath,
	});
}

/**
 * Start a file transcription request.
 * Can be called from IPC handlers or directly from main process code (e.g., tray menu).
 */
export async function transcribeFile(
	client: SttClient,
	filePath: string,
	pendingRequests: Map<string, string>
): Promise<{ requestId: string }> {
	// Validate input
	if (!filePath || typeof filePath !== "string") {
		throw new ValidationError("File path is required", "filePath");
	}

	const ext = path.extname(filePath).toLowerCase();

	if (!SUPPORTED_EXTENSIONS.has(ext)) {
		throw new ValidationError(
			`Unsupported file format: ${ext}. Supported formats: ${Array.from(SUPPORTED_EXTENSIONS).join(", ")}`,
			"filePath",
			{ extension: ext, filePath }
		);
	}

	try {
		await fs.promises.access(filePath, fs.constants.F_OK);
	} catch (error) {
		throw new NotFoundError("File", filePath, { originalError: error });
	}

	if (!client.isConnected) {
		throw new ConnectionError(
			"Cannot transcribe file: STT server is not connected",
			undefined,
			true
		);
	}

	const requestId = `file-${++requestCounter}-${Date.now()}`;
	pendingRequests.set(requestId, filePath);

	const format = getStoreValue("general.fileTranscriptionFormat");
	client.sendControl({
		command: "transcribe_file",
		request_id: requestId,
		file_path: filePath,
		format,
	});

	return { requestId };
}

export function setupFileTranscribeHandlers(
	win: BrowserWindow,
	client: SttClient
): { cleanup: () => void; pendingRequests: Map<string, string> } {
	const pendingRequests = new Map<string, string>(); // requestId → filePath

	const handler = async (_event: Electron.IpcMainInvokeEvent, payload: { filePath: string }) => {
		try {
			return await transcribeFile(client, payload.filePath, pendingRequests);
		} catch (error) {
			console.error("[file-transcribe] Transcription request failed:", getErrorMessage(error));
			throw error;
		}
	};

	ipcMain.handle("file:transcribe", handler);

	const safeSend = createSafeSender(win);

	const handleDataEvent = async (event: Record<string, unknown>): Promise<void> => {
		const type = event.type;
		if (typeof type !== "string") {
			return;
		}

		if (type === "file_transcription_progress") {
			handleProgressEvent(event, safeSend);
			return;
		}
		if (type === "file_transcription_complete") {
			await handleCompleteEvent(event, pendingRequests, safeSend);
			return;
		}
		if (type === "file_transcription_error") {
			handleErrorEvent(event, pendingRequests, safeSend);
		}
	};

	const onDataEvent = (event: Record<string, unknown>) => {
		handleDataEvent(event).catch((error) => {
			console.error("[file-transcribe] Failed to process data event:", getErrorMessage(error));
		});
	};

	client.on("data-event", onDataEvent);

	return {
		cleanup: () => {
			ipcMain.removeHandler("file:transcribe");
			client.off("data-event", onDataEvent);
		},
		pendingRequests,
	};
}
