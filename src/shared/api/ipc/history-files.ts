import { commands } from "@/bindings";
import { IPC } from "../ipc-channels";
import {
	commandOrDefault,
	invokeOrDefault,
	invokeSecureOrDefault,
	noop,
	onCast,
	onTyped,
} from "../ipc-transport";

// Dialog
export const dialogOpenFile = (
	filters?: Array<{ name: string; extensions: string[] }>,
	title?: string,
) =>
	invokeOrDefault<string | null>(IPC.DIALOG_OPEN_FILE, null, {
		filters,
		title,
	});

// Sound library — custom recording-sound files persisted under userData/sounds/.
interface SoundLibraryEntryDTO {
	id: string;
	name: string;
	path: string;
}

export interface SoundLibraryAddResult {
	cancelled?: boolean;
	entry?: SoundLibraryEntryDTO;
	error?: string;
	ok: boolean;
}

export interface SoundLibraryRemoveResult {
	error?: string;
	ok: boolean;
}

export const soundLibraryAdd = (sourcePath: string, name?: string) =>
	invokeOrDefault<SoundLibraryAddResult>(
		IPC.SOUND_LIBRARY_ADD,
		{ ok: false, error: "IPC unavailable" },
		{ sourcePath, name },
	);

export const soundLibraryPickAndAdd = (name?: string) =>
	invokeOrDefault<SoundLibraryAddResult>(
		IPC.SOUND_LIBRARY_PICK_AND_ADD,
		{ ok: false, error: "IPC unavailable" },
		{ name },
	);

export const soundLibraryRemove = (filePath: string) =>
	invokeOrDefault<SoundLibraryRemoveResult>(
		IPC.SOUND_LIBRARY_REMOVE,
		{ ok: false, error: "IPC unavailable" },
		{ path: filePath },
	);

export const soundLibraryReadFile = (filePath: string) =>
	invokeOrDefault<Uint8Array | null>(IPC.SOUND_LIBRARY_READ_FILE, null, {
		path: filePath,
	});

type ClipboardOperateResponse =
	| { operation: "readText"; text: string }
	| { operation: "writeText" }
	| { operation: "clear" };

export const clipboardReadText = async () => {
	const result = await invokeSecureOrDefault<ClipboardOperateResponse>(
		IPC.CLIPBOARD_OPERATE,
		{
			operation: "readText",
		},
		{ operation: "readText", text: "" },
	);
	return result.operation === "readText" ? result.text : "";
};

export const clipboardWriteText = (text: string) =>
	invokeSecureOrDefault<ClipboardOperateResponse>(
		IPC.CLIPBOARD_OPERATE,
		{
			operation: "writeText",
			text,
		},
		{ operation: "writeText" },
	);

export const clipboardClear = () =>
	invokeSecureOrDefault<ClipboardOperateResponse>(
		IPC.CLIPBOARD_OPERATE,
		{
			operation: "clear",
		},
		{ operation: "clear" },
	);

export interface UpdaterStatusEntry {
	/** Only present when status === "downloading". Pass-through from
	 *  the updater's `download-progress` payload. */
	bytesPerSecond?: number;
	message?: string;
	percent?: number;
	status:
		| "idle"
		| "checking"
		| "available"
		| "downloading"
		| "not-available"
		| "downloaded"
		| "error";
	timestamp: number;
	total?: number;
	transferred?: number;
	version?: string;
}

export const updaterGetStatusHistory = () =>
	invokeSecureOrDefault<UpdaterStatusEntry[]>(
		IPC.UPDATER_GET_STATUS_HISTORY,
		{},
		[],
	);

export const updaterClearStatusHistory = () =>
	invokeSecureOrDefault<{ cleared: true }>(
		IPC.UPDATER_CLEAR_STATUS_HISTORY,
		{},
		{ cleared: true },
	);

export const onUpdaterStatus = (cb: (entry: UpdaterStatusEntry) => void) =>
	onCast(IPC.UPDATER_STATUS, cb);

export interface UpdaterCheckNowResult {
	reason?: string;
	triggered: boolean;
}

export interface UpdaterCheckNowOptions {
	includePrereleaseUpdates?: boolean;
}

export const updaterCheckNow = (options?: UpdaterCheckNowOptions) =>
	invokeOrDefault<UpdaterCheckNowResult>(
		IPC.UPDATER_CHECK_NOW,
		{
			triggered: false,
		},
		options,
	);

export interface UpdaterQuitAndInstallResult {
	reason?: string;
	triggered: boolean;
}

/**
 * Tell the main process to relaunch into the downloaded update. The promise
 * resolves with `{ triggered: true }` immediately before quitAndInstall fires;
 * the actual quit happens asynchronously on the main side, so the renderer
 * may never see this resolve in practice. Falsy `triggered` means the updater
 * wasn't initialized (dev mode / disabled).
 */
export const updaterQuitAndInstall = () =>
	invokeOrDefault<UpdaterQuitAndInstallResult>(IPC.UPDATER_QUIT_AND_INSTALL, {
		triggered: false,
	});

// Transcription history
export interface TranscriptionHistoryEntry {
	/**
	 * Absolute path on disk to the saved WAV (under userData/recordings/).
	 * Omitted on entries created before audio-saving shipped, and on
	 * cloud-STT entries (no PCM ever touches our process).
	 */
	audioFilePath?: string;
	/** Deterministic dictionary replacement-pair substitutions applied. */
	dictionaryFixes?: number;
	durationMs: number;
	/** Fixed category classified by the dictation LLM. */
	historyTag?: string;
	id: string;
	/**
	 * Provider/model used for LLM post-processing (e.g. an Ollama model name
	 * like `qwen2.5:7b`). Omitted when no LLM ran.
	 */
	llmModel?: string;
	/**
	 * LLM post-processing wall-time in ms (the history footer's "processing
	 * time"). Omitted when no LLM ran.
	 */
	llmProcessingMs?: number;
	/**
	 * LLM generation speed (output tokens / processing second). Omitted when no
	 * LLM ran or the provider didn't report token usage.
	 */
	llmTokensPerSecond?: number;
	/** Pre-LLM text (post-processing applied). Omitted when no LLM ran. */
	originalText?: string;
	/** Fixed sensitive-data categories; never raw sensitive values. */
	privacyMarkers?: string[];
	/**
	 * Friendly name of the STT ("main") model that produced this transcription
	 * (e.g. `Whisper Tiny`, or a cloud `provider:model` id). Omitted on entries
	 * recorded before this shipped and on renderer-driven manual adds.
	 */
	sttModel?: string;
	/** Final text (after LLM correction if configured). */
	text: string;
	timestamp: number;
	wordCount: number;
}

export const fetchTranscriptionHistory = () =>
	invokeOrDefault<TranscriptionHistoryEntry[]>(IPC.HISTORY_GET_ALL, []);

export const clearTranscriptionHistory = () =>
	invokeOrDefault<{ cleared: true }>(IPC.HISTORY_CLEAR, { cleared: true });

export const deleteTranscriptionHistoryEntry = (id: string) =>
	invokeOrDefault<{ deleted: boolean }>(
		IPC.HISTORY_DELETE,
		{ deleted: false },
		id,
	);

export interface TransformHistoryEntry extends TranscriptionHistoryEntry {
	/** Selection capture path used by the transform runtime. */
	source: string;
}

export const fetchTransformHistory = () =>
	invokeOrDefault<TransformHistoryEntry[]>(IPC.TRANSFORM_HISTORY_GET_ALL, []);

export const clearTransformHistory = () =>
	invokeOrDefault<{ cleared: true }>(IPC.TRANSFORM_HISTORY_CLEAR, {
		cleared: true,
	});

export const deleteTransformHistoryEntry = (id: string) =>
	invokeOrDefault<{ deleted: boolean }>(
		IPC.TRANSFORM_HISTORY_DELETE,
		{ deleted: false },
		{ id },
	);

/** Load the WAV for an entry as a data URI ready for an `<audio src>`. */
export const loadTranscriptionHistoryAudio = (id: string) =>
	invokeOrDefault<string | null>(IPC.HISTORY_LOAD_AUDIO, null, id);

/** Per-word playback timing (seconds) for highlight-while-playing. */
export interface WordTiming {
	end: number;
	start: number;
	text: string;
}

/**
 * Lazily align an entry's WAV to per-word timestamps (the server runs a small
 * timestamped-Whisper export via cross-attention DTW). Returns `[]` when the
 * entry has no audio or alignment fails — highlighting is best-effort.
 */
export const alignTranscriptionHistoryAudio = (id: string) =>
	invokeOrDefault<WordTiming[]>(IPC.HISTORY_ALIGN_AUDIO, [], id);

export interface HistoryListPage<TEntry = unknown> {
	entries: TEntry[];
	hasMore: boolean;
}

export const historyListPage = <TEntry = unknown>(options: {
	limit: number;
	offset: number;
}) =>
	invokeOrDefault<HistoryListPage<TEntry>>(
		IPC.HISTORY_LIST,
		{ entries: [], hasMore: false },
		options,
	);

export const historyDeleteRow = (id: number) =>
	invokeOrDefault<{ deleted: boolean }>(
		IPC.HISTORY_DELETE_ROW,
		{ deleted: false },
		{ id },
	);

export const historyToggleRow = (id: number) =>
	invokeOrDefault<{ saved: boolean | null }>(
		IPC.HISTORY_TOGGLE,
		{ saved: null },
		{ id },
	);

export const historyLoadAudioByRow = (id: number) =>
	invokeOrDefault<string | null>(IPC.HISTORY_LOAD_AUDIO_BY_ROW, null, { id });

export const onHistoryRowAdded = <TEntry = unknown>(
	cb: (entry: TEntry) => void,
) => onCast<TEntry>(IPC.HISTORY_ROW_ADDED, cb);

export const onHistoryRowDeleted = (cb: (payload: { id?: number }) => void) =>
	onCast<{ id?: number }>(IPC.HISTORY_ROW_DELETED, cb);

export const onHistoryRowToggled = (
	cb: (payload: { id?: number; saved?: boolean }) => void,
) => onCast<{ id?: number; saved?: boolean }>(IPC.HISTORY_ROW_TOGGLED, cb);

export const onTranscriptionHistoryAdded = (
	cb: (entry: TranscriptionHistoryEntry) => void,
) => onCast<TranscriptionHistoryEntry>(IPC.HISTORY_ADDED, cb);

export const onTranscriptionHistoryDeleted = (
	cb: (payload: { id: string }) => void,
) => onCast<{ id: string }>(IPC.HISTORY_DELETED, cb);

export const onTransformHistoryAdded = (
	cb: (entry: TransformHistoryEntry) => void,
) => onCast<TransformHistoryEntry>(IPC.TRANSFORM_HISTORY_ADDED, cb);

export const onTransformHistoryDeleted = (
	cb: (payload: { id: string }) => void,
) => onCast<{ id: string }>(IPC.TRANSFORM_HISTORY_DELETED, cb);

export const onFileTranscriptionProgress = (
	cb: (data: { fileName: string; progress: number; message: string }) => void,
) => onCast(IPC.FILE_TRANSCRIPTION_PROGRESS, cb);

export const onFileTranscriptionComplete = (
	cb: (data: {
		requestId: string;
		fileName: string;
		text: string;
		outputPath: string;
	}) => void,
) => onCast(IPC.FILE_TRANSCRIPTION_COMPLETE, cb);

export const onFileTranscriptionError = (
	cb: (data: { requestId: string; fileName: string; error: string }) => void,
) => onCast(IPC.FILE_TRANSCRIPTION_ERROR, cb);

// Multi-file transcription queue
export type FileQueueStatus =
	| "queued"
	| "transcribing"
	| "complete"
	| "error"
	| "paused"
	| "canceled";

export interface FileQueueItem {
	fileName: string;
	id: string;
	message: string;
	/** 0..1 */
	progress: number;
	stage: string;
	status: FileQueueStatus;
}

export const fileQueuePickAndEnqueue = () =>
	invokeOrDefault<string[]>(IPC.FILE_QUEUE_PICK_AND_ENQUEUE, []);

export const fileQueueCancel = (id: string) =>
	invokeOrDefault<null>(IPC.FILE_QUEUE_CANCEL, null, { id });

export const fileQueueRetry = (id: string) =>
	invokeOrDefault<null>(IPC.FILE_QUEUE_RETRY, null, { id });

export const fileQueueCopy = (id: string) =>
	invokeOrDefault<null>(IPC.FILE_QUEUE_COPY, null, { id });

/** Pause ONE file (the in-flight one); it parks and the queue moves to the next. */
export const fileQueuePause = (id: string) =>
	invokeOrDefault<null>(IPC.FILE_QUEUE_PAUSE, null, { id });

/** Resume ONE paused file — continues from where it stopped. */
export const fileQueueResume = (id: string) =>
	invokeOrDefault<null>(IPC.FILE_QUEUE_RESUME, null, { id });

/** Discard the whole queue (cancels the in-flight file) and return to the visualizer. */
export const fileQueueDiscardAll = () =>
	invokeOrDefault<null>(IPC.FILE_QUEUE_DISCARD_ALL, null);

/** One-shot read of the busy flag — for windows mounted after the edge-triggered broadcast. */
export const fileQueueGetActive = () =>
	invokeOrDefault<boolean>(IPC.FILE_QUEUE_GET_ACTIVE, false);

export const onFileQueueUpdate = (
	cb: (data: { items: FileQueueItem[] }) => void,
) => onCast(IPC.FILE_QUEUE_UPDATE, cb);

export const onFileQueueProgress = (
	cb: (data: { id: string; progress: number; stage: string }) => void,
) => onCast(IPC.FILE_QUEUE_PROGRESS, cb);

export const onFileQueueActive = (cb: (data: { active: boolean }) => void) =>
	onCast(IPC.FILE_QUEUE_ACTIVE, cb);

// ── Diarization ─────────────────────────────────────────────────────
export interface SpeakerSegmentPayload {
	end: number;
	speaker: number;
	start: number;
}

export const onSpeakerSegments = (
	cb: (segments: SpeakerSegmentPayload[]) => void,
) =>
	onTyped(
		IPC.STT_SPEAKER_SEGMENTS,
		(d: { segments: SpeakerSegmentPayload[] }) => d.segments,
		cb,
	);

// ── Transcript quick-actions ─────────────────────────────────────────
// Copy the most recent completed transcription to the clipboard (tray menu).
// Resolves `true` once the text is on the clipboard, `false` when there's no
// completed entry / it's empty / the clipboard write fails.
export const copyLastTranscript = (): Promise<boolean> =>
	commandOrDefault("copy_last_transcript", commands.copyLastTranscript, false);

// ── Diagnostics ──────────────────────────────────────────────────────
// Open the log folder in the OS file explorer through the native adapter route.
// The backend resolves, creates, and opens the portable-aware directory;
// `{ ok:false }` is a no-bridge/dev fallback.
export interface DiagOpenLogsFolderResult {
	error?: string | null;
	ok: boolean;
	path?: string | null;
}

export const diagOpenLogsFolder = (): Promise<DiagOpenLogsFolderResult> =>
	invokeOrDefault(IPC.DIAG_OPEN_LOGS_FOLDER, {
		ok: false,
		error: "IPC unavailable",
	});

// Prompt the user to save a zip containing debug.log + stt-server.log +
// system-info.txt. `cancelled === true` means the user dismissed the save
// dialog; `ok === true` means the zip was written to disk.
// Mirrors the generated `DiagSaveBundleResult` (tauri-specta serializes Rust
// `Option<T>` as `T | null`) so the wrapper can return the binding result
// without a lossy re-map.
export interface DiagSaveBundleResult {
	cancelled?: boolean | null;
	error?: string | null;
	ok: boolean;
	path?: string | null;
}

export const diagSaveBundle = (): Promise<DiagSaveBundleResult> =>
	commandOrDefault("diag_save_bundle", commands.diagSaveBundle, {
		ok: false,
		error: "IPC unavailable",
	});

// ── Custom models folder ─────────────────────────────────────────────
// Open the user's custom-models drop folder (`{userData}/models/custom/`)
// in the OS file manager so they can drag in HuggingFace-style ONNX
// bundles. The directory is created lazily here on first click.
export const webviewDiagLog = (
	label: string,
	level: "info" | "warn" | "error",
	message: string,
): void => {
	// Fire-and-forget: a failed diag log must never throw into the caller (and
	// outside a Tauri runtime the generated invoke rejects).
	void commands.winsttDiag(label, level, message).catch(noop);
};

export interface OpenCustomModelsFolderResult {
	error?: string;
	ok: boolean;
	path?: string;
}

export const openCustomModelsFolder =
	(): Promise<OpenCustomModelsFolderResult> =>
		invokeOrDefault(IPC.CUSTOM_MODELS_OPEN_FOLDER, {
			ok: false,
			error: "IPC unavailable",
		});

// ── About ───────────────────────────────────────────────────────────
export interface AboutAppInfo {
	copyright: string;
	version: string;
}

const ABOUT_APP_INFO_FALLBACK: AboutAppInfo = {
	copyright: "",
	version: "",
};

export const aboutGetAppInfo = (): Promise<AboutAppInfo> =>
	commandOrDefault(
		"about_get_app_info",
		commands.aboutGetAppInfo,
		ABOUT_APP_INFO_FALLBACK,
	);
