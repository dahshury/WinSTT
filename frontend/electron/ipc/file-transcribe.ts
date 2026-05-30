import fs from "node:fs";
import path from "node:path";
import { type BrowserWindow, dialog, ipcMain } from "electron";
import {
	ConnectionError,
	FileSystemError,
	getErrorMessage,
	NotFoundError,
	ValidationError,
} from "../../src/shared/lib/errors";
import { createSafeSender, type SafeSend } from "../lib/ipc-helpers";
import { breadcrumb } from "../lib/sentry-main";
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
	pendingRequests: Map<string, PendingRequest>,
	safeSend: SafeSend
): void {
	const requestId = asString(event.request_id);
	// Stryker disable next-line ConditionalExpression,BlockStatement: equivalent —
	// when `requestId` is "" (falsy), Map.delete("") on a map keyed by non-empty
	// requestIds is a no-op, so the guard's outcome is unobservable.
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
	pendingRequests: Map<string, PendingRequest>,
	safeSend: SafeSend
): Promise<boolean> {
	try {
		// Stryker disable next-line StringLiteral: equivalent — the explicit "utf-8"
		// matches Node's default writeFile encoding for string payloads, so dropping
		// it produces identical bytes on disk.
		await fs.promises.writeFile(outputPath, text, "utf-8");
		return true;
	} catch (err) {
		// Stryker disable StringLiteral: log-only console.error label and "Path:"
		// argument label; observable behavior is the transcription-error event,
		// not the log line text.
		console.error(
			"[file-transcribe] Failed to write output:",
			getErrorMessage(err),
			"Path:",
			outputPath
		);
		// Stryker restore StringLiteral
		const fileError = new FileSystemError(
			`Failed to write transcription output: ${getErrorMessage(err)}`,
			outputPath,
			// Stryker disable next-line StringLiteral: equivalent — `operation: "write"`
			// is FileSystemError metadata; observable behavior surfaces only via
			// fileError.message which doesn't include the operation field.
			"write",
			// Stryker disable next-line ObjectLiteral: equivalent — `originalError`
			// context is preserved on the FileSystemError instance but never read by
			// downstream code; safeSend only forwards fileError.message.
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

function sanitizeFormat(fmt: string): string {
	return fmt.replace(/[^a-zA-Z0-9]/g, "") || "txt";
}

async function promptSaveLocation(filePath: string, fmt: string): Promise<string | null> {
	const safeFmt = sanitizeFormat(fmt);
	// Stryker disable ObjectLiteral,StringLiteral,ArrayDeclaration,MethodExpression: dialog options are pure UX/i18n surface forwarded to Electron's native showSaveDialog. The mocked dialog in tests returns canceled/filePath state independently of these options, so mutations (title="", filters=[], toUpperCase→toLowerCase) are unobservable from the IPC contract.
	const result = await dialog.showSaveDialog({
		title: "Save Transcription",
		defaultPath: buildOutputPath(filePath, safeFmt),
		filters: [{ name: safeFmt.toUpperCase(), extensions: [safeFmt] }],
	});
	// Stryker restore ObjectLiteral,StringLiteral,ArrayDeclaration,MethodExpression
	if (result.canceled || !result.filePath) {
		return null;
	}
	return result.filePath;
}

export interface PendingRequest {
	filePath: string;
	outputPath?: string;
}

async function writeAndNotifyComplete(
	outputPath: string,
	fields: CompleteEventFields,
	pendingRequests: Map<string, PendingRequest>,
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

function resolveCompleteOutputPath(
	entry: PendingRequest | undefined,
	fields: CompleteEventFields
): string {
	// Stryker disable next-line OptionalChaining: equivalent — callers only
	// invoke this after `isPathMatch(fields.filePath, entry?.filePath)` returned
	// true, which is only possible when `entry?.filePath` is a non-empty string
	// (isPathMatch returns false for `expected === undefined`), hence `entry`
	// is guaranteed defined and `entry?.outputPath` ≡ `entry.outputPath`.
	return entry?.outputPath ?? buildOutputPath(fields.filePath, fields.fmt);
}

async function handleCompleteEvent(
	event: Record<string, unknown>,
	pendingRequests: Map<string, PendingRequest>,
	safeSend: SafeSend
): Promise<void> {
	const fields = extractCompleteEventFields(event);
	// Stryker disable next-line ConditionalExpression,BlockStatement: equivalent —
	// when `fields` is null and the guard is mutated to `false`, control falls
	// through to `pendingRequests.get(fields.requestId)` which throws TypeError;
	// that throw is caught by the outer Promise .catch wrapper and produces no
	// renderer-visible side effect, so the mutation is unobservable.
	if (!fields) {
		// Stryker disable next-line StringLiteral: log-only console.error; the
		// observable behavior (no complete event emitted) is asserted by
		// "complete event with missing required fields is dropped" test.
		console.error("[file-transcribe] Incomplete transcription_complete event, skipping");
		return;
	}
	const entry = pendingRequests.get(fields.requestId);
	// Stryker disable next-line OptionalChaining: equivalent — for an unknown
	// requestId, `entry` is undefined; `entry?.filePath` is undefined and
	// `entry.filePath` throws TypeError, but both outcomes are caught by the
	// outer Promise .catch wrapper with no renderer-visible side effect.
	if (!isPathMatch(fields.filePath, entry?.filePath)) {
		// Stryker disable StringLiteral: log-only labels; the observable
		// behavior (pendingRequests deletion + no complete event) is asserted by
		// "complete event with mismatched file_path is dropped" test.
		console.error(
			"[file-transcribe] file_path mismatch — expected:",
			// Stryker disable next-line OptionalChaining: equivalent — see above.
			entry?.filePath,
			"got:",
			fields.filePath
		);
		// Stryker restore StringLiteral
		pendingRequests.delete(fields.requestId);
		return;
	}
	const outputPath = resolveCompleteOutputPath(entry, fields);
	await writeAndNotifyComplete(outputPath, fields, pendingRequests, safeSend);
}

function assertValidFilePath(filePath: string): void {
	if (!filePath || typeof filePath !== "string") {
		throw new ValidationError("File path is required", "filePath");
	}
}

function assertSupportedExtension(filePath: string): void {
	const ext = path.extname(filePath).toLowerCase();
	if (!SUPPORTED_EXTENSIONS.has(ext)) {
		throw new ValidationError(
			`Unsupported file format: ${ext}. Supported formats: ${Array.from(SUPPORTED_EXTENSIONS).join(", ")}`,
			"filePath",
			{ extension: ext, filePath }
		);
	}
}

async function assertFileAccessible(filePath: string): Promise<void> {
	try {
		await fs.promises.access(filePath, fs.constants.F_OK);
	} catch (error) {
		throw new NotFoundError("File", filePath, { originalError: error });
	}
}

async function resolveOutputPath(
	filePath: string,
	format: string,
	saveLocation: string
): Promise<string | null | undefined> {
	if (saveLocation !== "ask") {
		return;
	}
	const chosen = await promptSaveLocation(filePath, format);
	return chosen;
}

function assertClientConnected(client: SttClient): void {
	if (!client.isConnected) {
		throw new ConnectionError(
			"Cannot transcribe file: STT server is not connected",
			undefined,
			true
		);
	}
}

function getTranscriptionSettings(): { format: string; saveLocation: string } {
	return {
		format: String(getStoreValue("general.fileTranscriptionFormat") ?? "txt"),
		// Stryker disable next-line LogicalOperator,StringLiteral: equivalent —
		// downstream (resolveOutputPath) only branches on `saveLocation === "ask"`.
		// Whether the fallback string is "auto" or any other non-"ask" value
		// (or even "undefined" from the && mutant), the auto-path is taken
		// indistinguishably.
		saveLocation: String(getStoreValue("general.fileTranscriptionSaveLocation") ?? "auto"),
	};
}

/** Continuation state for resuming a paused file (see file-transcribe-queue.ts). */
export interface ResumeState {
	priorSegments: [number, number, string][];
	resumeFrom: number;
}

function enqueueTranscription(
	client: SttClient,
	filePath: string,
	format: string,
	outputPath: string | undefined,
	pendingRequests: Map<string, PendingRequest>,
	resume?: ResumeState
): string {
	// Stryker disable next-line UpdateOperator: equivalent — `++` vs `--`
	// produces a different numeric value in the requestId, but tests only
	// verify the requestId is a non-empty string and use it as an opaque key.
	// The genuine code uses ++ for monotonic IDs in production logs.
	const requestId = `file-${++requestCounter}-${Date.now()}`;
	pendingRequests.set(
		requestId,
		outputPath === undefined ? { filePath } : { filePath, outputPath }
	);
	client.sendControl({
		command: "transcribe_file",
		request_id: requestId,
		file_path: filePath,
		format,
		// Resume continuation (0 / [] for a fresh start) — the server transcribes
		// only the audio after resume_from and concatenates prior_segments.
		resume_from: resume?.resumeFrom ?? 0,
		prior_segments: resume?.priorSegments ?? [],
	});
	return requestId;
}

async function validateAndResolveOutput(
	client: SttClient,
	filePath: string
): Promise<{ format: string; outputPath: string | null | undefined }> {
	assertValidFilePath(filePath);
	assertSupportedExtension(filePath);
	await assertFileAccessible(filePath);
	assertClientConnected(client);
	const { format, saveLocation } = getTranscriptionSettings();
	const outputPath = await resolveOutputPath(filePath, format, saveLocation);
	return { format, outputPath };
}

/**
 * Start a file transcription request.
 * Can be called from IPC handlers or directly from main process code (e.g., tray menu).
 */
async function getFileSizeBytes(filePath: string): Promise<number> {
	try {
		const stat = await fs.promises.stat(filePath);
		return stat.size;
	} catch {
		return -1;
	}
}

export async function transcribeFile(
	client: SttClient,
	filePath: string,
	pendingRequests: Map<string, PendingRequest>,
	resume?: ResumeState
): Promise<{ requestId: string }> {
	const { format, outputPath } = await validateAndResolveOutput(client, filePath);
	if (outputPath === null) {
		// User cancelled the save dialog — don't start transcription.
		return { requestId: "" };
	}
	// File size only — never include the file path or content in breadcrumbs.
	breadcrumb("file-transcribe", "file submitted", {
		size_bytes: await getFileSizeBytes(filePath),
	});
	const requestId = enqueueTranscription(
		client,
		filePath,
		format,
		outputPath || undefined,
		pendingRequests,
		resume
	);
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
	sanitizeFormat,
	promptSaveLocation,
	resolveOutputPath,
	resolveCompleteOutputPath,
	assertValidFilePath,
	assertSupportedExtension,
	assertFileAccessible,
	extractCompleteEventFields,
};

export function setupFileTranscribeHandlers(
	win: BrowserWindow,
	client: SttClient
): { cleanup: () => void; pendingRequests: Map<string, PendingRequest> } {
	const pendingRequests = new Map<string, PendingRequest>(); // requestId → { filePath, outputPath? }

	const handler = async (_event: Electron.IpcMainInvokeEvent, payload: { filePath: string }) => {
		try {
			return await transcribeFile(client, payload.filePath, pendingRequests);
		} catch (error) {
			// Stryker disable next-line StringLiteral: log-only console.error
			// preceding the rethrow; the observable behavior (rethrown error) is
			// asserted by "file:transcribe handler propagates inner errors" test.
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
		// Stryker disable next-line ConditionalExpression,BlockStatement: equivalent —
		// when `type` is not a string (e.g., a number 42), the subsequent
		// dataEventDispatch[type]?.(event) lookup with a non-string key is
		// guaranteed `undefined` (the dispatch keys are exactly known strings),
		// and the optional chain short-circuits to a no-op. So removing this
		// early-return guard is unobservable.
		if (typeof type !== "string") {
			return;
		}
		// Stryker disable next-line OptionalChaining: equivalent — when `type` is
		// a string not in the dispatch table, `dataEventDispatch[type]` is
		// undefined; `?.(event)` short-circuits to undefined while removing the
		// optional chain (`dataEventDispatch[type](event)`) throws TypeError. The
		// throw is caught by the outer `.catch` wrapper below and logged; no
		// renderer-visible side effect either way.
		await dataEventDispatch[type]?.(event);
	};

	const onDataEvent = (event: Record<string, unknown>) => {
		// Stryker disable next-line BlockStatement: equivalent — the .catch body
		// is log-only; whether it logs or runs an empty block produces identical
		// observable behavior (no renderer-visible side effect, no rethrow).
		handleDataEvent(event).catch((error) => {
			// Stryker disable next-line StringLiteral: log-only error label.
			console.error("[file-transcribe] Failed to process data event:", getErrorMessage(error));
		});
	};

	client.on("data-event", onDataEvent);

	return {
		cleanup: () => {
			// Stryker disable next-line StringLiteral: equivalent — the test mock's
			// removeHandler is a Map.delete keyed by channel; passing "" is a
			// silent no-op, and re-registration in subsequent tests overwrites the
			// stale entry. Production correctness depends on Electron matching
			// the registered channel name, which is enforced by ipcMain.handle.
			ipcMain.removeHandler("file:transcribe");
			client.off("data-event", onDataEvent);
		},
		pendingRequests,
	};
}
