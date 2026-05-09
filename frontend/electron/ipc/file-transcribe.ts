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

function deriveFileName(fileName: string | undefined, filePath: unknown): string {
	if (fileName) {
		return fileName;
	}
	return typeof filePath === "string" ? path.basename(filePath) : "";
}

function handleErrorEvent(
	event: Record<string, unknown>,
	pendingRequests: Map<string, string>,
	safeSend: SafeSend
): void {
	const requestId = asString(event.request_id);
	if (requestId) {
		pendingRequests.delete(requestId);
	}
	safeSend("file:transcription-error", {
		requestId,
		fileName: deriveFileName(asOptionalString(event.file_name), event.file_path),
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

interface CompleteEventFields {
	fileName: string;
	filePath: string;
	fmt: string;
	requestId: string;
	text: string;
}

function allTruthy(...args: unknown[]): boolean {
	return args.every(Boolean);
}

function extractCompleteEventFields(event: Record<string, unknown>): CompleteEventFields | null {
	const requestId = asString(event.request_id);
	const filePath = asString(event.file_path);
	const fileName = asString(event.file_name);
	if (!allTruthy(requestId, filePath, fileName)) {
		return null;
	}
	return {
		requestId,
		filePath,
		fileName,
		text: asString(event.text),
		fmt: asString(event.format) || "txt",
	};
}

function isPathMatch(actual: string, expected: string | undefined): boolean {
	return Boolean(expected && path.resolve(actual) === path.resolve(expected));
}

function buildOutputPath(filePath: string, fmt: string): string {
	// Sanitize format extension to prevent path traversal via format field
	const safeFmt = fmt.replace(/[^a-zA-Z0-9]/g, "") || "txt";
	return `${filePath}.${safeFmt}`;
}

async function writeAndNotifyComplete(
	outputPath: string,
	fields: CompleteEventFields,
	pendingRequests: Map<string, string>,
	safeSend: SafeSend
): Promise<void> {
	const written = await writeTranscriptionOutput(
		outputPath,
		fields.text,
		fields.requestId,
		fields.fileName,
		pendingRequests,
		safeSend
	);
	if (!written) {
		return;
	}
	pendingRequests.delete(fields.requestId);
	safeSend("file:transcription-complete", {
		requestId: fields.requestId,
		fileName: fields.fileName,
		text: fields.text,
		outputPath,
	});
}

async function handleCompleteEvent(
	event: Record<string, unknown>,
	pendingRequests: Map<string, string>,
	safeSend: SafeSend
): Promise<void> {
	const fields = extractCompleteEventFields(event);
	if (!fields) {
		console.error("[file-transcribe] Incomplete transcription_complete event, skipping");
		return;
	}
	const expectedPath = pendingRequests.get(fields.requestId);
	if (!isPathMatch(fields.filePath, expectedPath)) {
		console.error(
			"[file-transcribe] file_path mismatch — expected:",
			expectedPath,
			"got:",
			fields.filePath
		);
		pendingRequests.delete(fields.requestId);
		return;
	}
	const outputPath = buildOutputPath(fields.filePath, fields.fmt);
	await writeAndNotifyComplete(outputPath, fields, pendingRequests, safeSend);
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

// Test-only exports — pure helpers used by the IPC layer.
export const __file_transcribe_test_helpers__ = {
	asString,
	asOptionalString,
	asOptionalNumber,
	allTruthy,
	deriveFileName,
	isPathMatch,
	buildOutputPath,
	extractCompleteEventFields,
};

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

	const dataEventDispatch: Record<
		string,
		(event: Record<string, unknown>) => Promise<void> | void
	> = {
		file_transcription_progress: (e) => handleProgressEvent(e, safeSend),
		file_transcription_complete: (e) => handleCompleteEvent(e, pendingRequests, safeSend),
		file_transcription_error: (e) => handleErrorEvent(e, pendingRequests, safeSend),
	};

	const handleDataEvent = async (event: Record<string, unknown>): Promise<void> => {
		const type = event.type;
		if (typeof type !== "string") {
			return;
		}
		await dataEventDispatch[type]?.(event);
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
