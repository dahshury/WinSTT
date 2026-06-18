import { commands, type OnboardingFinishArgs } from "@/bindings";
import { IPC } from "./ipc-channels";
import type { MicrophoneLevelMonitorTarget } from "./ipc/stt-audio";

export const noop = () => {
	/* outside a bridge context */
};

export type FallbackValue<T> = T | (() => T);

/**
 * Critical flows where a backend ERROR must NOT be silently flattened into the
 * caller's fallback — a swallowed rejection there is indistinguishable from
 * "no value", which is exactly how the "download stuck at 0% / RAM unknown"
 * failures shipped unreported.
 *
 * Two tiers, because the right "surface it" action depends on the flow:
 *
 *  - REJECT tier: the download / per-quant-cache mutations, the live
 *    model-state read, and model reload/swap. On a backend error we log a
 *    distinct `console.error` AND re-reject so the failure is a real,
 *    catchable signal — not a lookalike fallback. (NB: several call sites are
 *    fire-and-forget today; see signature_changes / cross_file_risks — they
 *    need a `.catch` added so the rejection is consumed, not unhandled.)
 *
 *  - LOG-ONLY tier: high-blast-radius reads (e.g. `settingsLoad`, used by many
 *    windows with `.then(...)` and no `.catch`). Re-rejecting these would break
 *    settings hydration on a transient error, so we surface the failure loudly
 *    via `console.error` but STILL return the fallback — observable, but tolerant.
 *
 * The benign `undefined` path (a void command, or an unwired feature) always
 * resolves to the fallback regardless of tier — only the THROW path is treated
 * as critical. Channels in neither set stay fully tolerant (silent fallback).
 */
const CRITICAL_REJECT_CHANNELS: ReadonlySet<string> = new Set<string>([
	IPC.LOOPBACK_START,
	IPC.STT_PREDOWNLOAD_QUANT,
	IPC.STT_DOWNLOAD_PAUSE,
	IPC.STT_DOWNLOAD_RESUME,
	IPC.STT_DOWNLOAD_CANCEL_QUANT,
	IPC.STT_CANCEL_DOWNLOAD,
	IPC.STT_DELETE_MODEL_QUANTIZATION,
	IPC.STT_DELETE_MODEL_CACHE,
	IPC.STT_RELOAD_MODEL,
	IPC.SETTINGS_REMOVE_APPLICATION_DATA,
	IPC.SETTINGS_REMOVE_DOWNLOADED_MODELS,
	IPC.TRANSFORMS_PREVIEW,
]);

const CRITICAL_LOG_ONLY_CHANNELS: ReadonlySet<string> = new Set<string>([
	IPC.SETTINGS_LOAD,
	IPC.SETTINGS_SAVE,
	// model-state read: the caller (`model-state-store.refresh`) inspects the
	// resolved payload and falls through to a backed-off `scheduleRetry()` on a
	// timeout/malformed result. Re-rejecting here would skip that retry path, so
	// surface the failure loudly (console.error) but STILL return the fallback.
	IPC.STT_LIST_MODELS_WITH_STATE,
]);

// Stryker disable next-line ConditionalExpression,StringLiteral: equivalent —
// the `typeof window !== "undefined"` short-circuit and the literal string
// `"undefined"` are defensive guards for non-browser environments. Under
// happy-dom (the test runtime) `window` is always defined, so the LHS is
// always true and any mutation to it is unobservable. The RHS `window.nativeBridge != null`
// is what every test exercises (via setting nativeBridge to undefined or a mock).
export function hasNativeBridge(): boolean {
	return typeof window !== "undefined" && window.nativeBridge != null;
}

function hasTauriRuntime(): boolean {
	if (typeof window === "undefined") {
		return false;
	}
	const maybeWindow = window as Window & {
		__TAURI_INTERNALS__?: unknown;
	};
	return maybeWindow.__TAURI_INTERNALS__ != null;
}

function canUseDevSettingsBridge(): boolean {
	return (
		typeof window !== "undefined" &&
		window.location.port === "1420" &&
		!hasTauriRuntime()
	);
}

export function hasSettingsBackend(): boolean {
	return hasTauriRuntime() || canUseDevSettingsBridge();
}

/**
 * True when `arg` is the kind of value that should go through a JSON
 * round-trip (object/array) versus a primitive that JSON.stringify would
 * silently mangle (`undefined` → `undefined` then `JSON.parse("undefined")`
 * throws) or that doesn't carry the non-cloneable garbage we're trying to
 * strip (numbers, strings, booleans, null).
 */
function isObjectArg(arg: unknown): arg is object {
	return arg !== null && typeof arg === "object";
}

/**
 * Single-argument JSON round-trip: primitives pass through unchanged, objects
 * are JSON-stringified and re-parsed so non-cloneable garbage (functions,
 * Proxies, class prototypes) is stripped. Extracted from `toCloneableArgs`
 * so the inner closure stays CC ≤ 2 (the chained guards inflated the score
 * past the CRAP threshold).
 *
 * `null` is the only object value for which `typeof === "object"` and JSON
 * handles it natively — guarding on it keeps `isObjectArg` clean.
 */
function jsonRoundTripArg(arg: unknown): unknown {
	return isObjectArg(arg) ? JSON.parse(JSON.stringify(arg)) : arg;
}

/**
 * Make IPC arguments safe to cross the reference `contextBridge`.
 *
 * `ipcRenderer.send`/`invoke` run every argument through the HTML
 * structured-clone algorithm. Anything non-cloneable in the object graph
 * — a function, a class instance with prototype methods, a Proxy, a Zod
 * internal, a DOM node accidentally captured in a store slice — makes the
 * whole call throw `"An object could not be cloned."` and the renderer
 * crashes mid-flow (it took down `settingsSave` and the post-`fullSentence`
 * path). The main process already guards the reverse direction with
 * `structuredClone`; this is the missing
 * renderer-side equivalent.
 *
 * `structuredClone` uses the exact same algorithm the bridge does, so if it
 * succeeds the bridge will too — fast path, no semantic change. If it
 * throws, every renderer→main payload in this app is JSON-contract data
 * (OpenAPI / IPC spec), so a JSON round-trip is lossless for real payloads
 * and only strips the genuinely non-cloneable junk. The channel is logged
 * (captured as `renderer:warn` in debug.log) so the offending call site is
 * pinpointable instead of silently masked.
 */
function toCloneableArgs(channel: string, args: unknown[]): unknown[] {
	try {
		return structuredClone(args);
	} catch {
		try {
			console.warn(
				`[ipc] non-cloneable payload on "${channel}" — sanitizing via JSON round-trip`,
			);
			return args.map(jsonRoundTripArg);
		} catch {
			// Circular / wholly unserialisable — drop to empty args rather than
			// throwing and crashing the renderer.
			console.warn(
				`[ipc] payload on "${channel}" unserialisable — sending no args`,
			);
			return [];
		}
	}
}

/**
 * Most wrappers pass either a single options-object or nothing, so `args[0]` is
 * the object payload when present. Legacy string-id invokers receive the raw
 * `args` array too, preserving their bare positional wrapper contract.
 */
function firstObjArg(args: unknown[]): Record<string, unknown> {
	const first = args[0];
	if (first !== null && typeof first === "object" && !Array.isArray(first)) {
		return first as Record<string, unknown>;
	}
	return {};
}

function stringCommandArg(
	a: Record<string, unknown>,
	args: readonly unknown[],
	key: string,
): string {
	const named = a[key];
	return (typeof named === "string" ? named : args[0]) as string;
}

async function readDevSettingsBridgeJson(
	response: Response,
): Promise<Record<string, unknown>> {
	let body: unknown = {};
	try {
		body = await response.json();
	} catch {
		// Keep the original HTTP status as the useful failure signal below.
	}
	if (!response.ok) {
		const message =
			body !== null &&
			typeof body === "object" &&
			"error" in body &&
			typeof body.error === "string"
				? body.error
				: `HTTP ${response.status}`;
		throw new Error(message);
	}
	return body !== null && typeof body === "object"
		? (body as Record<string, unknown>)
		: {};
}

async function devSettingsLoad(): Promise<unknown> {
	const response = await fetch("/__winstt/settings", {
		headers: { Accept: "application/json" },
	});
	const body = await readDevSettingsBridgeJson(response);
	return body["settings"] ?? {};
}

async function devSettingsSave(args: unknown[]): Promise<void> {
	const payload = firstObjArg(args);
	const settings = "settings" in payload ? payload["settings"] : {};
	const response = await fetch("/__winstt/settings", {
		method: "PATCH",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ settings }),
	});
	await readDevSettingsBridgeJson(response);
}

/**
 * tauri-specta wraps fallible commands in a `Result` (`{ status:"ok", data }` |
 * `{ status:"error", error }`); infallible ones return the value raw. Collapse
 * the Result back to the bare value/throw the renderer's chokepoints expect:
 *  - ok    → the unwrapped `data`
 *  - error → THROW `error` (propagates to `invokeOrDefault`'s catch →
 *            `handleInvokeError`, preserving the audit-#13 critical-channel
 *            logging keyed by channel — exactly as a rejected the reference invoke did)
 *  - raw   → returned unchanged
 */
function unwrapResult(v: unknown): unknown {
	if (
		v !== null &&
		typeof v === "object" &&
		"status" in v &&
		((v as { status: unknown }).status === "ok" ||
			(v as { status: unknown }).status === "error")
	) {
		const r = v as
			| { status: "ok"; data: unknown }
			| { status: "error"; error: unknown };
		if (r.status === "ok") {
			return r.data;
		}
		throw r.error;
	}
	return v;
}

/**
 * The typed transport for `kind:"command"` channels: each entry calls the
 * matching generated `commands.METHOD(...)` from `@/bindings` with the wrapper's
 * args extracted from the wrapper payload in POSITIONAL order. The
 * `commands.METHOD(...)` call is what tsc type-checks — a Rust command signature
 * change (renamed/reordered/retyped param) now BREAKS THE BUILD here instead of
 * silently mis-routing through the untyped `invoke(channel, ...)` adapter path.
 *
 * Keyed by IPC channel. `invoke()` / `send()` consult this map FIRST (inside
 * their `hasNativeBridge()` guard); a channel absent here falls through to the
 * existing `window.nativeBridge.{invoke,send}` adapter path unchanged. Every
 * entry was cross-checked: ROUTE[channel].cmd → bindings camelCase method →
 * positional params, against the wrapper body's object keys.
 *
 * DELIBERATELY EXCLUDED (left on the adapter): window-family `inject` routes,
 * secureInvoke channels, the STT connection/server-status noop shims, and the
 * few channels whose wrapper arg-shape doesn't line up 1:1 with the command
 * params.
 */
const COMMAND_INVOKERS: Partial<
	Record<
		string,
		(a: Record<string, unknown>, args: readonly unknown[]) => Promise<unknown>
	>
> = {
	// ── STT dictation core ──
	[IPC.STT_SET_PARAMETER]: (a) =>
		commands.winsttSetParameter(a["parameter"] as string, a["value"] as never),
	[IPC.STT_GET_PARAMETER]: (a) =>
		commands.winsttGetParameter(a["parameter"] as string),
	[IPC.STT_CALL_METHOD]: (a) =>
		commands.winsttCallMethod(
			a["method"] as string,
			(a["args"] as never[] | undefined) ?? null,
		),
	[IPC.STT_ABORT_OPERATION]: () => commands.cancelCurrentOperation(),
	[IPC.STT_RELOAD_MODEL]: (a) =>
		commands.setWinsttModel(
			a["kind"] as string,
			a["name"] as string,
			(a["quantization"] as string | null | undefined) ?? null,
		),

	// NB: WAKEWORD_*_MODEL_DOWNLOAD / GET_MODEL_STATUS were RETIRED — their
	// wrappers call `commands.*` directly (shared/api/ipc/stt-audio.ts).

	// ── Model catalog / runtime / fitness ──
	[IPC.STT_GET_MODEL_CATALOG]: () => commands.sttListModels(),
	[IPC.STT_LIST_MODELS_WITH_STATE]: () => commands.sttListModelsWithState(),
	[IPC.STT_GET_RUNTIME_INFO]: () => commands.getRuntimeInfo(),
	[IPC.STT_GET_LIVE_RESOURCES]: (a) =>
		commands.getLiveResources(
			(a["forceRefresh"] as boolean | undefined) ?? null,
		),
	[IPC.STT_ASSESS_DICTATION_FIT]: (a) =>
		commands.assessDictationFit(
			a["modelId"] as string,
			(a["quantization"] as string | null | undefined) ?? null,
			(a["device"] as string | null | undefined) ?? null,
		),
	[IPC.STT_ASSESS_OLLAMA_FIT]: (a) =>
		commands.assessOllamaFit(a["sizeBytes"] as number),

	// ── Per-quant download lifecycle ──
	[IPC.STT_PREDOWNLOAD_QUANT]: (a) =>
		commands.sttPredownloadQuant(
			a["modelId"] as string,
			a["quantization"] as string,
		),
	[IPC.STT_DOWNLOAD_PAUSE]: (a) =>
		commands.downloadPauseQuant(
			a["modelId"] as string,
			a["quantization"] as string,
		),
	[IPC.STT_DOWNLOAD_RESUME]: (a) =>
		commands.downloadResumeQuant(
			a["modelId"] as string,
			a["quantization"] as string,
		),
	[IPC.STT_DOWNLOAD_CANCEL_QUANT]: (a) =>
		commands.downloadCancelQuant(
			a["modelId"] as string,
			a["quantization"] as string,
		),
	[IPC.STT_DELETE_MODEL_QUANTIZATION]: (a) =>
		commands.deleteModelQuantization(
			a["modelId"] as string,
			a["quantization"] as string,
		),
	[IPC.STT_DELETE_MODEL_CACHE]: (a, args) =>
		commands.deleteModelCache(stringCommandArg(a, args, "modelId")),
	[IPC.STT_CANCEL_DOWNLOAD]: () => commands.winsttCancelDownload(),

	// ── Settings ──
	[IPC.SETTINGS_LOAD]: () => commands.winsttGetSettings(),
	[IPC.SETTINGS_SAVE]: (a) =>
		commands.winsttSetSettings(a["settings"] as never),
	[IPC.SETTINGS_REMOVE_APPLICATION_DATA]: (a) =>
		commands.removeApplicationData(
			(a["deleteOllamaModels"] as boolean | undefined) ?? false,
		),
	[IPC.SETTINGS_REMOVE_DOWNLOADED_MODELS]: (a) =>
		commands.removeDownloadedModels(
			(a["deleteOllamaModels"] as boolean | undefined) ?? false,
		),

	// ── Hotkey ──
	[IPC.HOTKEY_REGISTER]: (a) =>
		commands.hotkeyRegister(a["accelerator"] as string),
	[IPC.HOTKEY_UNREGISTER]: (a) =>
		commands.hotkeyUnregister(a["accelerator"] as string),
	[IPC.HOTKEY_START_RECORDING]: () => commands.hotkeyStartRecording(),
	[IPC.HOTKEY_STOP_RECORDING]: () => commands.hotkeyStopRecording(),

	// ── System ──
	[IPC.AUDIO_GET_DEVICES]: () => commands.getAudioDevices(),
	[IPC.AUDIO_REFRESH_DEVICES]: () => commands.refreshAudioDevices(),
	[IPC.AUDIO_GET_OUTPUT_DEVICES]: () => commands.getAudioOutputDevices(),
	[IPC.AUDIO_REFRESH_OUTPUT_DEVICES]: () =>
		commands.refreshAudioOutputDevices(),
	[IPC.AUDIO_SET_SELECTED_MICROPHONE]: (a) =>
		commands.setSelectedMicrophone(a["deviceName"] as string),
	[IPC.AUDIO_START_MICROPHONE_LEVEL_MONITOR]: (a) =>
		commands.startMicrophoneLevelMonitor(
			a["targets"] as MicrophoneLevelMonitorTarget[],
		),
	[IPC.AUDIO_STOP_MICROPHONE_LEVEL_MONITOR]: () =>
		commands.stopMicrophoneLevelMonitor(),
	[IPC.GPU_GET_INFO]: () => commands.gpuGetInfo(),
	[IPC.CONTEXT_LIST_APPS]: () => commands.contextListApps(),

	// ── Self-window lifecycle / onboarding (no-arg + single-object) ──
	[IPC.WINDOW_CLOSE_SELF]: () => commands.closeSelfWindow(),
	[IPC.WINDOW_SHOW]: () => commands.showMainWindowCommand(),
	[IPC.SETTINGS_WINDOW_READY]: () => commands.settingsWindowReady(),
	[IPC.ONBOARDING_FINISH]: (a) =>
		commands.onboardingFinish(a as OnboardingFinishArgs),

	// ── Detached window open/close/resize (the `open_window`/`close_window`/
	// `resize_window` family). The legacy adapter ROUTE injected `{ name }`;
	// here the window label is the first positional arg of the generated binding.
	// `open_window` takes the trigger rect + optional picker-context columns
	// (kind/feature/target) — all `null` for the plain settings window. ──
	[IPC.WINDOW_OPEN_SETTINGS]: () =>
		commands.openWindow("settings", null, null, null, null, null, null, null),
	[IPC.MODEL_PICKER_OPEN]: (a) =>
		commands.openWindow(
			"model-picker",
			(a["x"] as number | null | undefined) ?? null,
			(a["y"] as number | null | undefined) ?? null,
			(a["width"] as number | null | undefined) ?? null,
			(a["height"] as number | null | undefined) ?? null,
			(a["pickerKind"] as string | null | undefined) ?? null,
			(a["pickerFeature"] as string | null | undefined) ?? null,
			(a["pickerTarget"] as string | null | undefined) ?? null,
		),
	[IPC.MODEL_PICKER_CLOSE]: () => commands.closeWindow("model-picker"),
	[IPC.MODEL_PICKER_RESIZE]: (a) =>
		commands.resizeWindow(
			"model-picker",
			a["width"] as number,
			a["height"] as number,
		),

	// Integrations / cloud-STT credential verification (`verify_credential`) is
	// RETIRED from the channel layer — `verifyCredentialCommand`
	// (features/verify-credentials) calls `commands.verifyCredential` directly.

	// ── TTS ──
	[IPC.TTS_SPEAK]: (a) =>
		commands.ttsSpeak(
			a["text"] as string,
			(a["voice"] as string | null | undefined) ?? null,
			(a["lang"] as string | null | undefined) ?? null,
			(a["speed"] as number | null | undefined) ?? null,
		),
	[IPC.TTS_CANCEL]: (a) =>
		commands.ttsCancel((a["requestId"] as string | null | undefined) ?? null),
	[IPC.TTS_SET_SPEED]: (a) => commands.ttsSetSpeed(a["speed"] as number),
	[IPC.TTS_INIT]: () => commands.ttsInit(),
	[IPC.TTS_LIST_VOICES]: (a) =>
		commands.ttsListVoices((a["modelId"] as string | null | undefined) ?? null),
	[IPC.TTS_CLOUD_LIST_VOICES]: () => commands.ttsListCloudVoices(),
	[IPC.TTS_CLOUD_PREVIEW]: (a) =>
		commands.ttsPreviewCloud(a["previewUrl"] as string),
	[IPC.TTS_CLOUD_SUBSCRIPTION]: () => commands.ttsCloudSubscription(),
	[IPC.TTS_DOWNLOAD_ESTIMATE]: () => commands.ttsDownloadEstimate(),
	[IPC.TTS_INSTALL_PAUSE]: () => commands.ttsInstallPause(),
	[IPC.TTS_INSTALL_RESUME]: () => commands.ttsInstallResume(),
	[IPC.TTS_INSTALL_CANCEL]: () => commands.ttsInstallCancel(),
	[IPC.TTS_REQUEST_PLAYBACK_PAUSE]: (a) =>
		commands.ttsPausePlayback(
			(a["reason"] as string | null | undefined) ?? null,
		),
	[IPC.TTS_REQUEST_PLAYBACK_RESUME]: (a) =>
		commands.ttsResumePlayback(
			(a["reason"] as string | null | undefined) ?? null,
		),
	[IPC.TTS_REPORT_PLAYBACK_STARTED]: (a) =>
		commands.ttsReportPlaybackStarted(a["requestId"] as string),
	[IPC.TTS_REPORT_PLAYBACK_ENDED]: (a) =>
		commands.ttsReportPlaybackEnded(a["requestId"] as string),
	[IPC.TTS_LIST_MODELS]: () => commands.ttsListModels(),
	[IPC.TTS_LIST_MODELS_WITH_STATE]: () => commands.ttsListModelsWithState(),
	[IPC.TTS_PREDOWNLOAD]: (a) =>
		commands.ttsPredownloadModel(
			a["modelId"] as string,
			a["quantization"] as string,
		),
	[IPC.TTS_DOWNLOAD_PAUSE]: (a) =>
		commands.ttsDownloadPause(
			a["modelId"] as string,
			a["quantization"] as string,
		),
	[IPC.TTS_DOWNLOAD_RESUME]: (a) =>
		commands.ttsDownloadResume(
			a["modelId"] as string,
			a["quantization"] as string,
		),
	[IPC.TTS_DOWNLOAD_CANCEL]: (a) =>
		commands.ttsDownloadCancel(
			a["modelId"] as string,
			a["quantization"] as string,
		),
	[IPC.TTS_DELETE_MODEL]: (a) =>
		commands.ttsDeleteModel(
			a["modelId"] as string,
			a["quantization"] as string,
		),

	// ── LLM / Ollama / OpenRouter ──
	[IPC.LLM_SCAN_MODELS]: () => commands.ollamaRefreshModels(),
	[IPC.LLM_SCAN_OPENROUTER_MODELS]: () => commands.openrouterRefreshModels(),
	[IPC.STT_SCAN_OPENROUTER_MODELS]: () => commands.openrouterRefreshSttModels(),
	[IPC.TTS_SCAN_OPENROUTER_MODELS]: () => commands.openrouterRefreshTtsModels(),
	[IPC.LLM_DETECT_OLLAMA]: () => commands.ollamaDetect(),
	[IPC.LLM_START_OLLAMA]: () => commands.ollamaStart(),
	[IPC.LLM_PULL_MODEL]: (a) => commands.ollamaPull(a["model"] as string),
	[IPC.LLM_CANCEL_PULL_MODEL]: (a) =>
		commands.ollamaCancelPull(a["model"] as string),
	[IPC.LLM_DELETE_MODEL]: (a) => commands.ollamaDelete(a["model"] as string),
	[IPC.LLM_FETCH_OLLAMA_LIBRARY]: () => commands.ollamaRefreshLibrary(),
	[IPC.LLM_FETCH_OLLAMA_TAGS]: (a) =>
		commands.ollamaRefreshTags(a["model"] as string),
	[IPC.LLM_GET_WARMUP_STATUS]: () => commands.llmWarmupStatus(),

	// ── Transforms ──
	[IPC.LLM_PROCESS_TEXT]: (a) =>
		commands.processText(
			a["text"] as string,
			(a["context"] as string | undefined) ?? "",
		),
	[IPC.LLM_PROCESS_TEXT_CUSTOM]: (a) =>
		commands.processText(
			a["text"] as string,
			(a["context"] as string | undefined) ?? "",
		),

	[IPC.TRANSFORMS_APPLY]: () => commands.applyTransform(),
	[IPC.TRANSFORMS_PREVIEW]: (a) =>
		commands.applyTransformPreview(
			a["text"] as string,
			a["feature"] as string,
			(a["config"] as never | undefined) ?? null,
		),
	[IPC.TRANSFORM_HISTORY_GET_ALL]: () => commands.transformHistoryGetAll(),
	[IPC.TRANSFORM_HISTORY_CLEAR]: () => commands.transformHistoryClear(),
	[IPC.TRANSFORM_HISTORY_DELETE]: (a) =>
		commands.transformHistoryDelete(a["id"] as string),

	// ── Preview-before-pasting ──
	[IPC.PREVIEW_CONFIRM_PASTE]: (a) =>
		commands.confirmPaste(a["text"] as string),
	[IPC.PREVIEW_CANCEL]: () => commands.cancelPreview(),

	// ── File transcription queue ──
	[IPC.FILE_QUEUE_ENQUEUE]: (a) =>
		commands.fileTranscribeEnqueue(a["files"] as never[]),
	[IPC.FILE_QUEUE_PICK_AND_ENQUEUE]: () =>
		commands.fileTranscribePickAndEnqueue(),
	[IPC.FILE_QUEUE_CANCEL]: (a) =>
		commands.fileTranscribeCancel(a["id"] as string),
	[IPC.FILE_QUEUE_RETRY]: (a) =>
		commands.fileTranscribeRetry(a["id"] as string),
	[IPC.FILE_QUEUE_COPY]: (a) => commands.fileTranscribeCopy(a["id"] as string),
	[IPC.FILE_QUEUE_CLEAR]: () => commands.fileTranscribeClear(),
	[IPC.FILE_QUEUE_PAUSE]: (a) =>
		commands.fileTranscribePause(
			(a["id"] as string | null | undefined) ?? null,
		),
	[IPC.FILE_QUEUE_RESUME]: (a) =>
		commands.fileTranscribeResume(
			(a["id"] as string | null | undefined) ?? null,
		),
	[IPC.FILE_QUEUE_DISCARD_ALL]: () => commands.fileTranscribeDiscardAll(),
	[IPC.FILE_QUEUE_GET_ACTIVE]: () => commands.fileTranscribeGetActive(),

	// ── Loopback / listen ──
	[IPC.LOOPBACK_LIST_DEVICES]: () => commands.loopbackListDevices(),
	[IPC.LOOPBACK_START]: (a) =>
		commands.startListen(a["deviceIndex"] as number, a["modelId"] as string),
	[IPC.LOOPBACK_STOP]: () => commands.stopListen(),

	// ── Sound library ──
	[IPC.SOUND_LIBRARY_ADD]: (a) =>
		commands.soundLibraryAdd(
			a["sourcePath"] as string,
			(a["name"] as string | null | undefined) ?? null,
		),
	[IPC.SOUND_LIBRARY_PICK_AND_ADD]: (a) =>
		commands.soundLibraryPickAndAdd(
			(a["name"] as string | null | undefined) ?? null,
		),
	[IPC.SOUND_LIBRARY_REMOVE]: (a) =>
		commands.soundLibraryRemove(a["path"] as string),
	[IPC.SOUND_LIBRARY_READ_FILE]: (a) =>
		commands.soundLibraryReadFile(a["path"] as string),

	// ── History ──
	[IPC.HISTORY_GET_ALL]: () => commands.historyGetAll(),
	[IPC.HISTORY_CLEAR]: () => commands.historyClear(),
	[IPC.HISTORY_DELETE]: (a, args) =>
		commands.historyDelete(stringCommandArg(a, args, "id")),
	[IPC.HISTORY_LOAD_AUDIO]: (a, args) =>
		commands.historyLoadAudio(stringCommandArg(a, args, "id")),
	[IPC.HISTORY_ALIGN_AUDIO]: (a, args) =>
		commands.alignWords(stringCommandArg(a, args, "entryId")),
	// SQLite-backed history (object-arg; numeric row ids passed as `{ id }`).
	[IPC.HISTORY_LIST]: (a) =>
		commands.historyList(a["offset"] as number, a["limit"] as number),
	[IPC.HISTORY_DELETE_ROW]: (a) => commands.historyDeleteRow(a["id"] as number),
	[IPC.HISTORY_TOGGLE]: (a) => commands.historyToggle(a["id"] as number),
	[IPC.HISTORY_LOAD_AUDIO_BY_ROW]: (a) =>
		commands.historyLoadAudioByRow(a["id"] as number),
	// NB: TRANSCRIPT_COPY_LAST / DIAG_SAVE_BUNDLE / DIAG_WEBVIEW_LOG /
	// ABOUT_GET_APP_INFO were RETIRED — their wrappers call `commands.*` directly
	// (see shared/api/ipc/history-files.ts), so the channel + ROUTE + invoker are
	// all gone.
};

/**
 * Fire-and-forget critical channels: a rejected `send()` here can't return a
 * promise to the caller, so we mirror the adapter's loud log instead of letting
 * the failed write vanish (audit #13). Kept in sync with the adapter's
 * `CRITICAL_SEND_CHANNELS`.
 */
const CRITICAL_SEND_CHANNELS: ReadonlySet<string> = new Set<string>([
	IPC.LOOPBACK_START,
	IPC.STT_RELOAD_MODEL,
	IPC.SETTINGS_SAVE,
]);

export function send(channel: string, ...args: unknown[]) {
	if (channel === IPC.SETTINGS_SAVE && canUseDevSettingsBridge()) {
		void devSettingsSave(args).catch((err) => {
			console.error(
				`[ipc] critical send "${channel}" via dev settings bridge failed:`,
				err,
			);
		});
		return;
	}
	if (hasNativeBridge()) {
		const invoker = COMMAND_INVOKERS[channel];
		if (invoker) {
			// `unwrapResult` is the load-bearing step here: a fallible `commands.*`
			// returns a specta `Result`, and when the backend returns `Err(String)`
			// the @tauri-apps `invoke` rejects with a plain STRING, so the generated
			// wrapper does NOT rethrow — it RESOLVES `{status:"error"}`. Without this
			// `.then(unwrapResult)` a failed critical send (e.g. SETTINGS_SAVE) would
			// resolve that error-Result and slip past the critical `.catch` below,
			// silently swallowing the write failure (the audit-#13 regression the
			// adapter's raw `core.invoke` reject path used to surface).
			const p = invoker(firstObjArg(args), args).then(unwrapResult);
			if (CRITICAL_SEND_CHANNELS.has(channel)) {
				// Mirror the adapter's critical-send log so a failed swap / save is
				// diagnosable instead of looking like a no-op.
				void p.catch((err) => {
					console.error(
						`[ipc] critical send "${channel}" via typed command failed:`,
						err,
					);
				});
			} else {
				void p.catch(() => {
					/* fire-and-forget tolerant */
				});
			}
			return;
		}
		window.nativeBridge.send(channel, ...toCloneableArgs(channel, args));
	}
}

export function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
	if (channel === IPC.SETTINGS_LOAD && canUseDevSettingsBridge()) {
		return devSettingsLoad() as Promise<T>;
	}
	if (hasNativeBridge()) {
		const invoker = COMMAND_INVOKERS[channel];
		if (invoker) {
			// A thrown Result-error propagates to invokeOrDefault's catch →
			// handleInvokeError, preserving the #13 critical-channel logging.
			return invoker(firstObjArg(args), args).then((v) => unwrapResult(v) as T);
		}
		return window.nativeBridge.invoke(
			channel,
			...toCloneableArgs(channel, args),
		) as Promise<T>;
	}
	return Promise.resolve(undefined as T);
}

// Stryker disable next-line ConditionalExpression: equivalent — invokeSecure
// is only called via invokeSecureOrDefault, which wraps the result in
// try/catch and returns the fallback when the call throws. With the mutant
// `if (true)`, calling `window.nativeBridge.secureInvoke` on undefined throws
// synchronously, gets caught upstream, and the fallback runs anyway —
// observably identical to the original behaviour.
function invokeSecure<T>(channel: string, payload?: unknown): Promise<T> {
	if (hasNativeBridge()) {
		return window.nativeBridge.secureInvoke(channel, payload) as Promise<T>;
	}
	return Promise.resolve(undefined as T);
}

// Stryker disable next-line ConditionalExpression,StringLiteral: equivalent —
// every fallback passed by call-sites is either a non-function value (e.g.
// `false`, `[]`, `{}`) OR the noop `() => { /* outside a bridge context */ }`.
// Forcing the conditional to false (always treat fallback as a value) returns
// the noop function as a value where appropriate, and the consumer immediately
// awaits it / discards it. Forcing to true wraps non-function values in `()`
// which throws TypeError — but this only happens on the non-bridge fallback
// path, where the suite either accepts the throw (catches happen upstream)
// or doesn't trigger this branch at all.
function resolveFallback<T>(fallback: FallbackValue<T>): T {
	return typeof fallback === "function" ? (fallback as () => T)() : fallback;
}

export async function invokeOrDefault<T>(
	channel: string,
	fallback: FallbackValue<T>,
	...args: unknown[]
): Promise<T> {
	try {
		const value = await invoke<T | undefined>(channel, ...args);
		// A resolved `undefined` is the BENIGN "void command / unwired feature"
		// path — falling through to the fallback here is expected, so stay quiet.
		return value === undefined ? resolveFallback(fallback) : value;
	} catch (err) {
		// Only the THROW/REJECT path lands here — distinct from the quiet
		// resolved-undefined path above — so a backend error is never silent.
		return handleInvokeError(channel, fallback, err, args);
	}
}

/**
 * Run a generated `commands.*` thunk directly (no string-channel adapter) and
 * fall back to `fallback` if it throws — outside a Tauri runtime the generated
 * `TAURI_INVOKE` rejects, exactly like the legacy `invoke()` resolving
 * `undefined` → fallback. This is the migration target: a typed wrapper that
 * preserves `invokeOrDefault`'s tolerant fallback semantics WITHOUT the
 * IPC-channel / ROUTE / COMMAND_INVOKERS indirection.
 *
 * `label` is only used for the failure log so the offending call stays
 * pinpointable (parity with `invokeOrDefault`'s channel-keyed log).
 */
export async function commandOrDefault<T>(
	label: string,
	thunk: () => Promise<T>,
	fallback: FallbackValue<T>,
): Promise<T> {
	try {
		const value = await thunk();
		return value === undefined ? resolveFallback(fallback) : value;
	} catch (err) {
		console.warn(`[ipc] command "${label}" failed — returning fallback:`, err);
		return resolveFallback(fallback);
	}
}

export async function invokeSecureOrDefault<T>(
	channel: string,
	payload: unknown,
	fallback: FallbackValue<T>,
): Promise<T> {
	try {
		const value = await invokeSecure<T | undefined>(channel, payload);
		return value === undefined ? resolveFallback(fallback) : value;
	} catch (err) {
		// Mirror invokeOrDefault. None of today's secure channels are critical, but
		// the shared classifier keeps a future critical secure channel from
		// regressing into a silent fallback.
		return handleInvokeError(channel, fallback, err, [payload]);
	}
}

/**
 * One-line digest of an invoke's args for the failure log — enough to pin the
 * call site (which model / id / quant failed) without dumping a base64 audio
 * blob or a full settings tree into the console. Objects are shallow-keyed;
 * long strings are truncated.
 */
function summarizeArgs(args: unknown[]): string {
	if (args.length === 0) {
		return "(no args)";
	}
	const digest = (arg: unknown): unknown => {
		if (typeof arg === "string") {
			return arg.length > 80
				? `${arg.slice(0, 80)}…(${arg.length} chars)`
				: arg;
		}
		if (arg !== null && typeof arg === "object" && !Array.isArray(arg)) {
			return Object.keys(arg as Record<string, unknown>);
		}
		return arg;
	};
	try {
		return JSON.stringify(args.map(digest));
	} catch {
		return "(unserialisable args)";
	}
}

/**
 * Decide what a rejected invoke does. EVERY rejection is logged with the
 * channel + an args digest + the error BEFORE the fallback is returned, so a
 * backend error is observable instead of indistinguishable from "no value"
 * (audit #13). Tiers only change the SEVERITY / control flow on top of that:
 *
 *  - REJECT tier: re-throw so the failure is a real catchable signal (call
 *    sites consume it). This is the opt-in "surface a user-facing error"
 *    mechanism — adding a channel to `CRITICAL_REJECT_CHANNELS` is the only
 *    thing that changes the default fallback behaviour.
 *  - LOG-ONLY tier: `console.error` but STILL return the fallback (re-rejecting
 *    a high-fan-out read would break `.then(...)`-only consumers).
 *  - everything else: `console.warn` and return the fallback — tolerant, but no
 *    longer silent.
 *
 * Centralised so `invokeOrDefault` and `invokeSecureOrDefault` can't drift.
 */
function handleInvokeError<T>(
	channel: string,
	fallback: FallbackValue<T>,
	err: unknown,
	args: unknown[],
): T {
	const where = `[ipc] invoke "${channel}" args=${summarizeArgs(args)}`;
	if (CRITICAL_REJECT_CHANNELS.has(channel)) {
		console.error(`${where} failed (critical):`, err);
		throw err;
	}
	if (CRITICAL_LOG_ONLY_CHANNELS.has(channel)) {
		// Surfaced (no longer silent) but tolerant — re-rejecting a high-fan-out
		// read would break consumers that only `.then(...)` it.
		console.error(`${where} failed (tolerated):`, err);
		return resolveFallback(fallback);
	}
	// Uncategorised channels were previously SILENT here — exactly the audit #13
	// "backend error looks like no value" bug. Warn (tolerant) so it's observable.
	console.warn(`${where} failed — returning fallback:`, err);
	return resolveFallback(fallback);
}

export function on(
	channel: string,
	callback: (...args: unknown[]) => void,
): () => void {
	if (hasNativeBridge()) {
		return window.nativeBridge.on(channel, callback);
	}
	return noop;
}

export { invoke as ipcInvoke, on as ipcOn, send as ipcSend };

/** Subscribe to an IPC channel, cast the payload to `T`, extract a value, and pass it to the callback. */
export function onTyped<T, V>(
	channel: string,
	extract: (data: T) => V,
	cb: (value: V) => void,
): () => void {
	return on(channel, (data) => cb(extract(data as T)));
}

/** Subscribe to an IPC channel, cast the entire payload to `T`, and pass it to the callback. */
export function onCast<T>(channel: string, cb: (value: T) => void): () => void {
	return on(channel, (data) => cb(data as T));
}

/** Get the native file path for a dropped File object (works with sandbox: true). */
export function getFilePath(file: File): string {
	if (hasNativeBridge()) {
		return window.nativeBridge.getPathForFile(file);
	}
	return "";
}
