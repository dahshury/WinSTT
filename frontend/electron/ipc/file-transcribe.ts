import fs from "node:fs";
import path from "node:path";
import { type BrowserWindow, ipcMain } from "electron";
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

export function setupFileTranscribeHandlers(win: BrowserWindow, client: SttClient): () => void {
	const pendingRequests = new Map<string, string>(); // requestId → filePath

	const handler = (_event: Electron.IpcMainInvokeEvent, payload: { filePath: string }) => {
		const filePath = payload.filePath;
		const ext = path.extname(filePath).toLowerCase();

		if (!SUPPORTED_EXTENSIONS.has(ext)) {
			throw new Error(`Unsupported file format: ${ext}`);
		}

		if (!fs.existsSync(filePath)) {
			throw new Error("File not found");
		}

		if (!client.isConnected) {
			throw new Error("STT server is not connected");
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
				console.warn("[file-transcribe] Failed to write output:", err);
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

	return () => {
		ipcMain.removeHandler("file:transcribe");
		client.off("data-event", onDataEvent);
	};
}
