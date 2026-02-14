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
import { store } from "../lib/store";
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

/**
 * Start a file transcription request.
 * Can be called from IPC handlers or directly from main process code (e.g., tray menu).
 */
export function transcribeFile(
	client: SttClient,
	filePath: string,
	pendingRequests: Map<string, string>
): { requestId: string } {
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

	if (!fs.existsSync(filePath)) {
		throw new NotFoundError("File", filePath);
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

	const format = (store.get("general.fileTranscriptionFormat") as string) ?? "txt";

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

	const handler = (_event: Electron.IpcMainInvokeEvent, payload: { filePath: string }) => {
		try {
			return transcribeFile(client, payload.filePath, pendingRequests);
		} catch (error) {
			console.error("[file-transcribe] Transcription request failed:", getErrorMessage(error));
			throw error;
		}
	};

	ipcMain.handle("file:transcribe", handler);

	const safeSend = (channel: string, ...args: unknown[]) => {
		if (!win.isDestroyed()) {
			win.webContents.send(channel, ...args);
		}
	};

	const onDataEvent = (event: Record<string, unknown>) => {
		const type = event.type as string;

		if (type === "file_transcription_progress") {
			safeSend("file:transcription-progress", {
				fileName: event.file_name,
				progress: event.progress,
				message: event.message,
			});
		} else if (type === "file_transcription_complete") {
			const requestId = event.request_id as string;
			const filePath = event.file_path as string;
			const text = event.text as string;
			const fileName = event.file_name as string;
			const fmt = (event.format as string) ?? "txt";

			// Write output file next to source with correct extension
			const outputPath = `${filePath}.${fmt}`;
			try {
				fs.writeFileSync(outputPath, text, "utf-8");
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
				return;
			}

			pendingRequests.delete(requestId);
			safeSend("file:transcription-complete", {
				requestId,
				fileName,
				text,
				outputPath,
			});
		} else if (type === "file_transcription_error") {
			const requestId = event.request_id as string;
			const fileName = event.file_name as string | undefined;
			pendingRequests.delete(requestId);
			safeSend("file:transcription-error", {
				requestId,
				fileName: fileName ?? path.basename(String(event.file_path)),
				error: event.error,
			});
		}
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
