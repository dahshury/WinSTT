import {
	commands,
	type ObservabilityIssue as BindingObservabilityIssue,
	type Result,
} from "@/bindings";
import { callPlugin } from "../adapter/plugins";
import {
	checkAndDownloadUpdate,
	installPendingUpdateAndRelaunch,
} from "../adapter/updater";
import { NATIVE_EVENTS as IPC } from "../native-events";
import { commandOrDefault, noop, onCast } from "../native-boundary";

function unwrapResult<T, E>(result: Result<T, E>): T {
	if (result.status === "ok") {
		return result.data;
	}
	throw result.error;
}

// Dialog
export const dialogOpenFile = (
	filters?: Array<{ name: string; extensions: string[] }>,
	title?: string,
) =>
	commandOrDefault(
		"dialog_open_file",
		async () => (await callPlugin("dialog:open", { filters, title })) as string,
		null,
	);

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
	commandOrDefault<SoundLibraryAddResult>(
		"sound_library_add",
		async () =>
			(await commands.soundLibraryAdd(
				sourcePath,
				name ?? null,
			)) as SoundLibraryAddResult,
		{ ok: false, error: "IPC unavailable" },
	);

export const soundLibraryPickAndAdd = (name?: string) =>
	commandOrDefault<SoundLibraryAddResult>(
		"sound_library_pick_and_add",
		async () =>
			(await commands.soundLibraryPickAndAdd(
				name ?? null,
			)) as SoundLibraryAddResult,
		{ ok: false, error: "IPC unavailable" },
	);

export const soundLibraryRemove = (filePath: string) =>
	commandOrDefault<SoundLibraryRemoveResult>(
		"sound_library_remove",
		async () =>
			(await commands.soundLibraryRemove(filePath)) as SoundLibraryRemoveResult,
		{ ok: false, error: "IPC unavailable" },
	);

export const soundLibraryReadFile = (filePath: string) =>
	commandOrDefault(
		"sound_library_read_file",
		async () => {
			const bytes = await commands.soundLibraryReadFile(filePath);
			return bytes === null ? null : new Uint8Array(bytes);
		},
		null,
	);

type ClipboardOperateResponse =
	| { operation: "readText"; text: string }
	| { operation: "writeText" }
	| { operation: "clear" };

export const clipboardReadText = async () => {
	const result = await commandOrDefault<ClipboardOperateResponse>(
		"clipboard_read_text",
		async () =>
			(await callPlugin("clipboard:operate", {
				operation: "readText",
			})) as ClipboardOperateResponse,
		{ operation: "readText", text: "" },
	);
	return result.operation === "readText" && typeof result.text === "string"
		? result.text
		: "";
};

export const clipboardWriteText = (text: string) =>
	commandOrDefault<ClipboardOperateResponse>(
		"clipboard_write_text",
		async () =>
			(await callPlugin("clipboard:operate", {
				operation: "writeText",
				text,
			})) as ClipboardOperateResponse,
		{ operation: "writeText" },
	);

export const clipboardClear = () =>
	commandOrDefault<ClipboardOperateResponse>(
		"clipboard_clear",
		async () =>
			(await callPlugin("clipboard:operate", {
				operation: "clear",
			})) as ClipboardOperateResponse,
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
	commandOrDefault<UpdaterStatusEntry[]>(
		"winstt_updater_get_status_history",
		async () =>
			(await commands.winsttUpdaterGetStatusHistory()) as UpdaterStatusEntry[],
		[],
	);

export const updaterClearStatusHistory = () =>
	commandOrDefault<{ cleared: true }>(
		"winstt_updater_clear_status_history",
		async () => ({
			cleared: (await commands.winsttUpdaterClearStatusHistory())
				.cleared as true,
		}),
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
	commandOrDefault<UpdaterCheckNowResult>(
		"winstt_updater_check_and_download",
		async () =>
			(await checkAndDownloadUpdate(
				options?.includePrereleaseUpdates,
			)) as UpdaterCheckNowResult,
		{
			triggered: false,
		},
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
	commandOrDefault<UpdaterQuitAndInstallResult>(
		"winstt_updater_install",
		async () =>
			(await installPendingUpdateAndRelaunch()) as UpdaterQuitAndInstallResult,
		{ triggered: false },
	);

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
	/** Recorded post-processing error when the selected LLM failed soft. */
	llmError?: string;
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
	/**
	 * Wall-clock time the STT model spent finalizing this transcription after
	 * recording stopped. Distinct from `durationMs`, which is audio length.
	 */
	sttProcessingMs?: number;
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
	/**
	 * USD billed for the cloud STT upload that produced this transcription.
	 * Omitted for local decodes and entries recorded before cost tracking.
	 */
	sttCostUsd?: number;
	/**
	 * True when `sttCostUsd` is a client-side estimate (the provider reports
	 * no billed amount) rather than a provider-billed figure.
	 */
	sttCostIsEstimate?: boolean;
	/**
	 * USD cost of the cloud LLM post-processing pass, from the provider's
	 * native token accounting × catalog rates. Omitted for local LLMs.
	 */
	llmCostUsd?: number;
	/**
	 * Where the transcription came from: omitted = mic dictation, `"listen"` =
	 * a finished listen-mode session (enables session post-processing).
	 */
	source?: string;
}

export const fetchTranscriptionHistory = () =>
	commandOrDefault(
		"history_get_all",
		async () =>
			unwrapResult(
				await commands.historyGetAll(),
			) as TranscriptionHistoryEntry[],
		[],
	);

export const clearTranscriptionHistory = () =>
	commandOrDefault<{ cleared: true }>(
		"history_clear",
		async () => ({
			cleared: unwrapResult(await commands.historyClear()).cleared as true,
		}),
		{ cleared: true },
	);

export const deleteTranscriptionHistoryEntry = (id: string) =>
	commandOrDefault<{ deleted: boolean }>(
		"history_delete",
		async () => unwrapResult(await commands.historyDelete(id)),
		{ deleted: false },
	);

export interface TransformHistoryEntry extends TranscriptionHistoryEntry {
	/** Selection capture path used by the transform runtime. */
	source: string;
}

export const fetchTransformHistory = () =>
	commandOrDefault(
		"transform_history_get_all",
		async () =>
			unwrapResult(
				await commands.transformHistoryGetAll(),
			) as TransformHistoryEntry[],
		[],
	);

export const clearTransformHistory = () =>
	commandOrDefault<{ cleared: true }>(
		"transform_history_clear",
		async () => ({
			cleared: unwrapResult(await commands.transformHistoryClear())
				.cleared as true,
		}),
		{ cleared: true },
	);

export const deleteTransformHistoryEntry = (id: string) =>
	commandOrDefault<{ deleted: boolean }>(
		"transform_history_delete",
		async () => unwrapResult(await commands.transformHistoryDelete(id)),
		{ deleted: false },
	);

/** One text-to-speech read-aloud run, listed in the History tab beside STT. */
export interface TtsHistoryEntry {
	/**
	 * Absolute path on disk to the saved synthesis audio (WAV/MP3 under
	 * userData/recordings/). Omitted on entries created before TTS audio
	 * persistence shipped and on runs whose capture failed.
	 */
	audioFilePath?: string;
	/** Characters synthesized (the unit most TTS providers bill on). */
	characters: number;
	/**
	 * USD billed for the run. Omitted for local synthesis and cloud runs whose
	 * cost could not be resolved.
	 */
	costUsd?: number;
	/** True when `costUsd` is a client-side estimate. */
	costIsEstimate?: boolean;
	id: string;
	/** Engine id: `<provider>:<id>` for cloud synthesis, else the local model key. */
	model: string;
	/** Wall-clock synthesis time for the whole read-aloud session. */
	processingMs?: number;
	/** The text that was read aloud. */
	text: string;
	timestamp: number;
	voice?: string;
	wordCount: number;
}

export const fetchTtsHistory = () =>
	commandOrDefault(
		"tts_history_get_all",
		async () =>
			unwrapResult(await commands.ttsHistoryGetAll()) as TtsHistoryEntry[],
		[],
	);

export const clearTtsHistory = () =>
	commandOrDefault<{ cleared: true }>(
		"tts_history_clear",
		async () => ({
			cleared: unwrapResult(await commands.ttsHistoryClear()).cleared as true,
		}),
		{ cleared: true },
	);

export const deleteTtsHistoryEntry = (id: string) =>
	commandOrDefault<{ deleted: boolean }>(
		"tts_history_delete",
		async () => unwrapResult(await commands.ttsHistoryDelete(id)),
		{ deleted: false },
	);

export const onTtsHistoryAdded = (cb: (entry: TtsHistoryEntry) => void) =>
	onCast<TtsHistoryEntry>(IPC.TTS_HISTORY_ADDED, cb);

export const onTtsHistoryDeleted = (cb: (payload: { id: string }) => void) =>
	onCast<{ id: string }>(IPC.TTS_HISTORY_DELETED, cb);

/** Load the WAV for an entry as a data URI ready for an `<audio src>`. */
export const loadTranscriptionHistoryAudio = (id: string) =>
	commandOrDefault(
		"history_load_audio",
		async () => unwrapResult(await commands.historyLoadAudio(id)),
		null,
	);

/** Load a TTS run's saved synthesis audio as a data URI (WAV or MP3), or null. */
export const loadTtsHistoryAudio = (id: string) =>
	commandOrDefault(
		"tts_history_load_audio",
		async () => unwrapResult(await commands.ttsHistoryLoadAudio(id)),
		null,
	);

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
	commandOrDefault(
		"align_words",
		async () => unwrapResult(await commands.alignWords(id)) as WordTiming[],
		[],
	);

export interface HistoryListPage<TEntry = unknown> {
	entries: TEntry[];
	hasMore: boolean;
}

export const historyListPage = <TEntry = unknown>(options: {
	limit: number;
	offset: number;
}) =>
	commandOrDefault<HistoryListPage<TEntry>>(
		"history_list",
		async () =>
			unwrapResult(
				await commands.historyList(options.offset, options.limit),
			) as HistoryListPage<TEntry>,
		{ entries: [], hasMore: false },
	);

export const historyDeleteRow = (id: number) =>
	commandOrDefault<{ deleted: boolean }>(
		"history_delete_row",
		async () => unwrapResult(await commands.historyDeleteRow(id)),
		{ deleted: false },
	);

export const historyToggleRow = (id: number) =>
	commandOrDefault<{ saved: boolean | null }>(
		"history_toggle",
		async () => unwrapResult(await commands.historyToggle(id)),
		{ saved: null },
	);

export const historyLoadAudioByRow = (id: number) =>
	commandOrDefault(
		"history_load_audio_by_row",
		async () => unwrapResult(await commands.historyLoadAudioByRow(id)),
		null,
	);

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

export interface FileQueueDroppedFile {
	fileName: string;
	filePath: string;
}

export const fileQueueEnqueue = (files: FileQueueDroppedFile[]) =>
	commandOrDefault(
		"file_transcribe_enqueue",
		() => commands.fileTranscribeEnqueue(files as never[]),
		[],
	);

export const fileQueuePickAndEnqueue = () =>
	commandOrDefault(
		"file_transcribe_pick_and_enqueue",
		() => commands.fileTranscribePickAndEnqueue(),
		[],
	);

export const fileQueueCancel = (id: string) =>
	commandOrDefault(
		"file_transcribe_cancel",
		async () => {
			await commands.fileTranscribeCancel(id);
			return null;
		},
		null,
	);

export const fileQueueRetry = (id: string) =>
	commandOrDefault(
		"file_transcribe_retry",
		async () => {
			await commands.fileTranscribeRetry(id);
			return null;
		},
		null,
	);

export const fileQueueCopy = (id: string) =>
	commandOrDefault(
		"file_transcribe_copy",
		async () => {
			await commands.fileTranscribeCopy(id);
			return null;
		},
		null,
	);

/** Pause ONE file (the in-flight one); it parks and the queue moves to the next. */
export const fileQueuePause = (id: string) =>
	commandOrDefault(
		"file_transcribe_pause",
		async () => {
			await commands.fileTranscribePause(id);
			return null;
		},
		null,
	);

/** Resume ONE paused file — continues from where it stopped. */
export const fileQueueResume = (id: string) =>
	commandOrDefault(
		"file_transcribe_resume",
		async () => {
			await commands.fileTranscribeResume(id);
			return null;
		},
		null,
	);

/** Discard the whole queue (cancels the in-flight file) and return to the visualizer. */
export const fileQueueDiscardAll = () =>
	commandOrDefault(
		"file_transcribe_discard_all",
		async () => {
			await commands.fileTranscribeDiscardAll();
			return null;
		},
		null,
	);

/** One-shot read of the busy flag — for windows mounted after the edge-triggered broadcast. */
export const fileQueueGetActive = () =>
	commandOrDefault(
		"file_transcribe_get_active",
		() => commands.fileTranscribeGetActive(),
		false,
	);

export const onFileQueueUpdate = (
	cb: (data: { items: FileQueueItem[] }) => void,
) => onCast(IPC.FILE_QUEUE_UPDATE, cb);

export const onFileQueueProgress = (
	cb: (data: { id: string; progress: number; stage: string }) => void,
) => onCast(IPC.FILE_QUEUE_PROGRESS, cb);

export const onFileQueueActive = (cb: (data: { active: boolean }) => void) =>
	onCast(IPC.FILE_QUEUE_ACTIVE, cb);

// ── Transcript quick-actions ─────────────────────────────────────────
// Copy the most recent completed transcription to the clipboard (tray menu).
// Resolves `true` once the text is on the clipboard, `false` when there's no
// completed entry / it's empty / the clipboard write fails.
export const copyLastTranscript = (): Promise<boolean> =>
	commandOrDefault("copy_last_transcript", commands.copyLastTranscript, false);

// ── Diagnostics ──────────────────────────────────────────────────────
// Open the log folder in the OS file explorer through the direct native helper.
// The backend resolves, creates, and opens the portable-aware directory;
// `{ ok:false }` is a no-bridge/dev fallback.
export interface DiagOpenLogsFolderResult {
	error?: string | null;
	ok: boolean;
	path?: string | null;
}

export const diagOpenLogsFolder = (): Promise<DiagOpenLogsFolderResult> =>
	commandOrDefault(
		"diag_open_logs_folder",
		async () =>
			(await callPlugin("opener:logs", undefined)) as DiagOpenLogsFolderResult,
		{ ok: false, error: "IPC unavailable" },
	);

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
// Recent local operational issues for the About > Diagnostics panel.
export type ObservabilityIssue = BindingObservabilityIssue;

export const diagObservabilityTimeline = (
	limit = 20,
): Promise<ObservabilityIssue[]> =>
	commandOrDefault(
		"diag_observability_timeline",
		() => commands.diagObservabilityTimeline(limit),
		[],
	);

export const diagClearObservabilityTimeline = (): Promise<number> =>
	commandOrDefault(
		"diag_clear_observability_timeline",
		commands.diagClearObservabilityTimeline,
		0,
	);

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
		commandOrDefault(
			"open_custom_models_folder",
			async () =>
				(await callPlugin(
					"opener:custom-models",
					undefined,
				)) as OpenCustomModelsFolderResult,
			{ ok: false, error: "IPC unavailable" },
		);

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
