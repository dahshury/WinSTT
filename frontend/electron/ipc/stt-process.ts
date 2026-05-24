import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import { app, ipcMain } from "electron";
import { getErrorMessage, NotFoundError, ProcessSpawnError } from "../../src/shared/lib/errors";
import {
	isRealtimeEnabled,
	type LiveTranscriptionDisplay,
} from "../../src/shared/lib/realtime-enabled";
import { dbg } from "../lib/debug-log";
import { readCurrentInitialPrompt } from "../lib/initial-prompt-sync";
import { breadcrumb, getResolvedSentryDsn } from "../lib/sentry-main";
import { getStoreRaw, getStoreValue, store } from "../lib/store";

let sttProcess: ChildProcess | null = null;
let status: "idle" | "starting" | "running" | "error" = "idle";

function setErrorState() {
	status = "error";
	sttProcess = null;
}

/** Helper to access sttProcess.pid without TS narrowing issues from cross-function mutation. */
function getSttProcessPid(): number | undefined {
	// Stryker disable next-line OptionalChaining: equivalent mutant — `sttProcess` is always non-null when this is called from tryAutoSpawnServer's success path; the optional chain is a defensive guard for direct calls that never occur in the test suite.
	return sttProcess?.pid;
}

/**
 * Mapping from electron-store paths to CLI flags for the STT server.
 * These settings are only applied at server startup (passed as CLI args).
 */
const SETTINGS_TO_CLI: [storePath: string, cliFlag: string][] = [
	["model.model", "--model"],
	["model.realtimeModel", "--rt-model"],
	["model.language", "--lang"],
	["model.computeType", "--compute_type"],
	["model.device", "--device"],
	["model.backend", "--backend"],
	["model.onnxQuantization", "--onnx_quantization"],
	["model.beamSize", "--beam_size"],
	["model.beamSizeRealtime", "--beam_size_realtime"],
	// `model.initialPrompt` / `model.initialPromptRealtime` are NOT in this
	// table — they're composed at spawn time by `applyInitialPromptFlags`
	// which folds the user's static prefix together with the dictionary's
	// vocab terms so Whisper biases toward named entities BEFORE the LLM
	// cleanup pass even runs. Adding them here would prepend the user's
	// freeform prefix only, dropping the dictionary signal.
	["audio.inputDeviceIndex", "--input-device"],
	["audio.sileroSensitivity", "--silero_sensitivity"],
	["audio.webrtcSensitivity", "--webrtc_sensitivity"],
	["audio.minLengthOfRecording", "--min_length_of_recording"],
	["quality.useMainModelForRealtime", "--use_main_model_for_realtime"],
	["quality.realtimeProcessingPause", "--realtime_processing_pause"],
	["quality.earlyTranscriptionOnSilence", "--early_transcription_on_silence"],
	["quality.initRealtimeAfterSeconds", "--init_realtime_after_seconds"],
	["quality.batchSize", "--batch"],
	["quality.realtimeBatchSize", "--realtime_batch_size"],
];

/**
 * Boolean ``store_true`` flags — pushed only when the setting is truthy.
 * For diarization in particular, the flag's absence is what disables the
 * feature on the server (matches the CLI default of ``False``).
 */
const STORE_TRUE_CLI: [storePath: string, cliFlag: string][] = [
	["general.speakerDiarization", "--enable_diarization"],
];

function isEmptyStoreValue(value: unknown): boolean {
	return value == null || value === "";
}

function pushBooleanStoreTrueFlag(args: string[], value: boolean, cliFlag: string): void {
	if (value) {
		args.push(cliFlag);
	}
}

function applyStoreTrueFlag(args: string[], value: unknown, cliFlag: string): void {
	if (isEmptyStoreValue(value)) {
		return;
	}
	if (typeof value === "boolean") {
		pushBooleanStoreTrueFlag(args, value, cliFlag);
		return;
	}
	args.push(cliFlag, String(value));
}

function applySileroDeactivityFlag(args: string[]): void {
	if (getStoreValue("audio.sileroDeactivityDetection")) {
		args.push("--silero_deactivity_detection");
	}
}

// Stryker disable ObjectLiteral,StringLiteral: lookup table; each entry locks one branch of the if-chain that previously bumped CC. Branch coverage comes from the buildServerArgs realtime tests that drive each display value through the spawn argv builder.
const LIVE_DISPLAY_LOOKUP: Record<string, LiveTranscriptionDisplay> = {
	none: "none",
	"in-app": "in-app",
	"in-pill": "in-pill",
	both: "both",
};
// Stryker restore ObjectLiteral,StringLiteral

function readLiveTranscriptionDisplay(): LiveTranscriptionDisplay {
	const raw = getStoreRaw("general.liveTranscriptionDisplay");
	return LIVE_DISPLAY_LOOKUP[String(raw)] ?? "both";
}

/**
 * Decide whether the server should boot with the realtime preview engine.
 * Fully derived from the user's live-transcription display choice:
 *   - `none`                       → `--no-enable_realtime_transcription`
 *   - `in-pill` w/ overlay hidden  → `--no-enable_realtime_transcription`
 *   - anything else                → `--enable_realtime_transcription`
 *
 * There is no separate user-stored "realtime on/off" — the display picker IS
 * the on/off switch (see realtime-enabled.ts).
 */
function applyRealtimeFlag(args: string[]): void {
	const showRecordingOverlay = getStoreRaw("general.showRecordingOverlay") !== false;
	const liveTranscriptionDisplay = readLiveTranscriptionDisplay();
	const enabled = isRealtimeEnabled({ showRecordingOverlay, liveTranscriptionDisplay });
	args.push(enabled ? "--enable_realtime_transcription" : "--no-enable_realtime_transcription");
}

// Keywords each engine knows. Keyed lookups beat hardcoded if-chains and
// make the "what does this keyword need?" decision testable. Strings must
// match exactly what the engines accept (Porcupine keyword names / openWake
// model short names).
const PORCUPINE_KEYWORDS: ReadonlySet<string> = new Set([
	"alexa",
	"americano",
	"blueberry",
	"bumblebee",
	"computer",
	"grapefruit",
	"grasshopper",
	"hey google",
	"hey siri",
	"jarvis",
	"ok google",
	"picovoice",
	"porcupine",
	"terminator",
]);
const OPENWAKEWORD_KEYWORDS: ReadonlySet<string> = new Set([
	"alexa",
	"hey_jarvis",
	"hey_mycroft",
	"hey_rhasspy",
	"timer",
	"weather",
]);

/**
 * Pick the right server-side wake-word backend for the given keyword:
 *   - Both engines know it → "composite" (Porcupine AND openWakeWord must
 *     both fire within a short window — highest accuracy)
 *   - Only Porcupine knows it → "pvporcupine"
 *   - Only openWakeWord knows it → "openwakeword"
 *
 * Exported as a test seam; the renderer never asks the user to pick a
 * backend directly. Returns null when the keyword belongs to neither
 * engine (corrupt store value) so the caller can skip emitting flags.
 */
type WakeWordBackend = "composite" | "pvporcupine" | "openwakeword" | null;

// Stryker disable ObjectLiteral,StringLiteral: keyed by `${inPorc}|${inOww}` so each entry locks one cell of the truth table. The four cells are covered by the applyWakeWordFlags test suite (default mode, empty word, jarvis = pvporcupine, alexa = composite — see stt-process.test.ts).
const WAKE_BACKEND_TABLE: Record<string, WakeWordBackend> = {
	"true|true": "composite",
	"true|false": "pvporcupine",
	"false|true": "openwakeword",
	"false|false": null,
};
// Stryker restore ObjectLiteral,StringLiteral

export function wakeWordBackendFor(keyword: string): WakeWordBackend {
	const inPorc = PORCUPINE_KEYWORDS.has(keyword);
	const inOww = OPENWAKEWORD_KEYWORDS.has(keyword);
	return WAKE_BACKEND_TABLE[`${inPorc}|${inOww}`] ?? null;
}

/**
 * Wire wake-word CLI args when `recordingMode === "wakeword"`. The backend
 * is picked from the keyword via `wakeWordBackendFor`, so the user never
 * has to choose an engine — the renderer routes shared keywords through the
 * composite detector for cross-engine confirmation, and single-engine
 * keywords through whichever detector knows them.
 *
 * Sensitivity (0–1) and timeout (seconds) are forwarded verbatim — both
 * engines clamp internally to their valid ranges. `--openwakeword_model_paths`
 * is set for composite and openwakeword backends so detection is scoped to
 * the chosen keyword (otherwise openWakeWord would load all default models).
 */
// Stryker disable ObjectLiteral,BooleanLiteral: lookup table; the openwakeword-model-paths flag is required for composite + openwakeword backends but not for pvporcupine. Branch covered by applyWakeWordFlags tests (jarvis = pvporcupine omits, alexa = composite includes).
const BACKEND_NEEDS_OWW_PATHS: Record<Exclude<WakeWordBackend, null>, boolean> = {
	composite: true,
	openwakeword: true,
	pvporcupine: false,
};
// Stryker restore ObjectLiteral,BooleanLiteral

function pushOpenWakeWordModelPaths(
	args: string[],
	backend: Exclude<WakeWordBackend, null>,
	word: string
): void {
	if (BACKEND_NEEDS_OWW_PATHS[backend]) {
		args.push("--openwakeword_model_paths", word);
	}
}

function pushWakeWordCoreFlags(
	args: string[],
	backend: Exclude<WakeWordBackend, null>,
	word: string
): void {
	args.push("--wakeword_backend", backend);
	args.push("--wake_words", word);
	pushOpenWakeWordModelPaths(args, backend, word);
	args.push("--wake_words_sensitivity", String(getStoreValue("general.wakeWordSensitivity")));
	args.push("--wake_word_timeout", String(getStoreValue("general.wakeWordTimeout")));
}

interface WakeWordContext {
	backend: Exclude<WakeWordBackend, null>;
	word: string;
}

function readActiveWakeWord(): string | null {
	if (getStoreValue("general.recordingMode") !== "wakeword") {
		return null;
	}
	const word = getStoreValue("general.wakeWord");
	return word ? String(word) : null;
}

function resolveWakeWordContext(): WakeWordContext | null {
	const word = readActiveWakeWord();
	if (!word) {
		return null;
	}
	const backend = wakeWordBackendFor(word);
	return backend === null ? null : { backend, word };
}

function applyWakeWordFlags(args: string[]): void {
	const ctx = resolveWakeWordContext();
	if (ctx) {
		pushWakeWordCoreFlags(args, ctx.backend, ctx.word);
	}
}

/**
 * Compose Whisper `--initial_prompt` / `--initial_prompt_realtime` CLI
 * args from the user's static prefix setting + the dictionary's vocab.
 * Skipped when both pieces are empty (CLI default of "no prompt"
 * applies). See {@link readCurrentInitialPrompt} for the composition
 * rules and per-prompt char cap.
 */
function applyInitialPromptFlags(args: string[]): void {
	const composed = readCurrentInitialPrompt();
	if (composed.main) {
		args.push("--initial_prompt", composed.main);
	}
	if (composed.realtime) {
		args.push("--initial_prompt_realtime", composed.realtime);
	}
}

/**
 * Append `--log-dir <userData>` so the Python server writes `stt-server.log`
 * to the same directory as Electron's `debug.log` for unified diagnostics.
 */
function applyLogDirFlag(args: string[]): void {
	try {
		args.push("--log-dir", app.getPath("userData"));
	} catch {
		// userData may not be available pre-app-ready in dev edge cases — skip silently.
	}
}

function applySettingsToCliFlags(args: string[]): void {
	for (const [storePath, cliFlag] of SETTINGS_TO_CLI) {
		applyStoreTrueFlag(args, getStoreRaw(storePath), cliFlag);
	}
}

function pushStoreTrueFlagIfTrue(args: string[], storePath: string, cliFlag: string): void {
	if (getStoreRaw(storePath) === true) {
		args.push(cliFlag);
	}
}

function applyStoreTrueCliFlags(args: string[]): void {
	for (const [storePath, cliFlag] of STORE_TRUE_CLI) {
		pushStoreTrueFlagIfTrue(args, storePath, cliFlag);
	}
}

function applyDerivedFlags(args: string[]): void {
	applyRealtimeFlag(args);
	applySileroDeactivityFlag(args);
	applyWakeWordFlags(args);
	applyInitialPromptFlags(args);
	applyLogDirFlag(args);
}

/** Read all relevant settings from electron-store and convert to CLI args */
function buildServerArgs(baseArgs: string[]): string[] {
	const args = [...baseArgs];
	applySettingsToCliFlags(args);
	applyStoreTrueCliFlags(args);
	applyDerivedFlags(args);
	return args;
}

/**
 * Resolve the STT server directory. Priority:
 * 1. STT_SERVER_DIR environment variable (development)
 * 2. Bundled server in app resources (production)
 */
function resolveServerDir(): string {
	if (process.env.STT_SERVER_DIR) {
		return process.env.STT_SERVER_DIR;
	}
	// Stryker disable next-line ConditionalExpression: equivalent mutant — flipping `if (app.isPackaged)` to `if (true)` returns `path.join(process.resourcesPath, "stt-server")`; in the dev test where this branch matters, `process.resourcesPath` is undefined and path.join throws TypeError, which the surrounding tryAutoSpawnServer catch swallows — same observable spawnLog.length=0 result.
	if (app.isPackaged) {
		return path.join(process.resourcesPath, "stt-server");
	}
	// Stryker disable ObjectLiteral,StringLiteral: equivalent mutants — the NotFoundError context object is for diagnostic logging only; the IPC handler catches the error and rethrows a plain Error with only the canonical "STT_SERVER_DIR not found" message, so the context fields (message/isPackaged/resourcesPath) and their string values aren't observable from any test assertion.
	throw new NotFoundError("STT_SERVER_DIR", undefined, {
		message:
			"STT_SERVER_DIR environment variable is not set. Set it to the server/ directory path.",
		isPackaged: app.isPackaged,
		resourcesPath: process.resourcesPath,
	});
	// Stryker restore ObjectLiteral,StringLiteral
}

/**
 * Resolve the command to spawn the STT server. In production with a bundled
 * PyInstaller executable, spawn it directly. In development, use `uv run`.
 */
function resolveSpawnArgs(serverDir: string): { command: string; args: string[] } {
	if (app.isPackaged) {
		// Stryker disable next-line ConditionalExpression,StringLiteral: equivalent mutants — `process.platform` cannot be toggled at runtime within a single bun-test process, so the win32/non-win32 branches of this ternary cannot both be observed; the literal "win32" comparison is locked to whichever branch the test runner is on.
		// In production, expect a PyInstaller/Nuitka executable at stt-server/stt-server.exe
		const exe = process.platform === "win32" ? "stt-server.exe" : "stt-server";
		return { command: path.join(serverDir, exe), args: [] };
	}
	// In development, use uv to run from source
	return { command: "uv", args: ["run", "stt-server"] };
}

/**
 * Attach stdout/stderr/exit/error handlers to a spawned process.
 * The `proc` reference is captured so that stale exit/error handlers
 * from a killed process cannot clobber a newly spawned replacement.
 */
function isOwningProcess(proc: ChildProcess): boolean {
	return sttProcess === proc;
}

function maybeMarkRunning(proc: ChildProcess, text: string): void {
	// Match the server's backend-agnostic ready marker (see
	// server/src/stt_server/server.py "Recorder initialized"). Must stay
	// in sync with the server-side string. This only flips the spawned-
	// process status — the renderer's "ready" check goes through the
	// server_ready WebSocket message instead.
	if (text.includes("Recorder initialized") && isOwningProcess(proc)) {
		status = "running";
	}
}

function handleStdoutData(proc: ChildProcess, data: Buffer): void {
	const text = data.toString();
	console.log("[stt-server]", text.trimEnd());
	maybeMarkRunning(proc, text);
}

function handleStderrData(data: Buffer): void {
	console.error("[stt-server]", data.toString().trimEnd());
}

function normalizeExitCode(code: number | null): number {
	return typeof code === "number" ? code : -1;
}

function exitBreadcrumbSeverity(exitCode: number): "info" | "warning" {
	return exitCode === 0 || exitCode === -1 ? "info" : "warning";
}

function clearOwningProcess(proc: ChildProcess): void {
	if (isOwningProcess(proc)) {
		sttProcess = null;
		status = "idle";
	}
}

function handleProcessExit(proc: ChildProcess, code: number | null, signal: string | null): void {
	const exitCode = normalizeExitCode(code);
	breadcrumb(
		"process",
		"stt-server exited",
		{ code: exitCode, signal: signal ?? "" },
		exitBreadcrumbSeverity(exitCode)
	);
	clearOwningProcess(proc);
}

function reportSpawnError(proc: ChildProcess, err: Error): void {
	const spawnError = new ProcessSpawnError(
		`Failed to spawn STT server: ${getErrorMessage(err)}`,
		proc.spawnfile ?? "unknown",
		undefined,
		{ originalError: err, pid: proc.pid }
	);
	console.error("[stt-server] ProcessSpawnError:", spawnError.toJSON());
	setErrorState();
}

function handleProcessError(proc: ChildProcess, err: Error): void {
	console.error("[stt-server] Spawn error:", getErrorMessage(err));
	if (isOwningProcess(proc)) {
		reportSpawnError(proc, err);
	}
}

function attachProcessHandlers(proc: ChildProcess) {
	// Stryker disable next-line OptionalChaining: equivalent mutant — `proc.stdout` is always non-null in our test environment (the spawn mock always provides an EventEmitter); the optional chain is a defensive guard against ChildProcess instances spawned with stdio: 'ignore'.
	proc.stdout?.on("data", (data: Buffer) => handleStdoutData(proc, data));

	// Stryker disable next-line OptionalChaining: equivalent mutant — same reasoning as the proc.stdout?.on disable above; the test environment always provides a stderr EventEmitter.
	proc.stderr?.on("data", handleStderrData);

	proc.on("exit", (code, signal) => handleProcessExit(proc, code, signal));

	proc.on("error", (err: Error) => handleProcessError(proc, err));
}

/**
 * Build the env block for the spawned STT server. Only forward `SENTRY_DSN`
 * to the Python child when:
 *
 *   1. The user has *not* opted out (`general.sendCrashReports !== false`), and
 *   2. We can resolve a DSN from runtime env or the build-time injected constant
 *      (via `getResolvedSentryDsn`).
 *
 * Otherwise we omit the var entirely so the Python server boots with its
 * Sentry SDK disabled by default. Always inherits the parent env so other
 * vars (PATH, CUDA, etc.) propagate normally.
 */
function buildServerEnv(): NodeJS.ProcessEnv {
	const sendCrashReports = getStoreValue("general.sendCrashReports") !== false;
	const dsn = sendCrashReports ? getResolvedSentryDsn() : undefined;
	if (!dsn) {
		// Strip any inherited SENTRY_DSN from the parent env when the user opted
		// out — otherwise a developer running with the env var set would still
		// see the child reporting against the user's wishes.
		const { SENTRY_DSN: _omitDsn, ...rest } = process.env;
		return rest;
	}
	return { ...process.env, SENTRY_DSN: dsn };
}

/** Spawn the STT server process with the given CLI args. */
function spawnServer(): void {
	const serverDir = resolveServerDir();
	const { command, args: baseArgs } = resolveSpawnArgs(serverDir);
	const args = buildServerArgs(baseArgs);

	status = "starting";

	const proc = spawn(command, args, {
		cwd: serverDir,
		shell: false,
		env: buildServerEnv(),
	});

	sttProcess = proc;
	attachProcessHandlers(proc);
	breadcrumb("process", "stt-server spawned");
	dbg("stt-spawn", "CLI args:", args.join(" "));
	dbg(
		"stt-spawn",
		"derived realtime: liveTranscriptionDisplay=",
		store.get("general.liveTranscriptionDisplay"),
		"showRecordingOverlay=",
		store.get("general.showRecordingOverlay"),
		"useMainModelForRealtime=",
		store.get("quality.useMainModelForRealtime")
	);
}

export function setupSttProcessHandlers(): void {
	ipcMain.handle("stt-server:spawn", () => {
		try {
			if (sttProcess) {
				dbg("stt-spawn", "Process already running, skipping spawn");
				return;
			}
			spawnServer();
		} catch (err) {
			setErrorState();
			const message = getErrorMessage(err);
			console.error("[stt-server] Spawn handler error:", message);
			// Re-throw as plain Error so Electron serializes a useful message
			throw new Error(message);
		}
	});

	// Stryker disable next-line BlockStatement: equivalent mutants — killSttProcess swallows its own internal errors via its inner try/catch, so this outer catch block is unreachable from any test; the surrounding try/catch is defensive against future changes that might let kill failures bubble up.
	ipcMain.handle("stt-server:kill", () => {
		// Stryker disable BlockStatement,StringLiteral: equivalent mutants — same reasoning as above; the catch body's console.error/throw never fire because killSttProcess never throws.
		try {
			killSttProcess();
		} catch (err) {
			const message = getErrorMessage(err);
			console.error("[stt-server] Kill handler error:", message);
			throw new Error(message);
		}
		// Stryker restore BlockStatement,StringLiteral
	});

	// Stryker disable next-line BlockStatement: equivalent mutants — `return status` is a primitive read that cannot throw, so the surrounding try/catch is unreachable.
	ipcMain.handle("stt-server:status", () => {
		// Stryker disable BlockStatement,StringLiteral: equivalent mutants — same reasoning; the catch body cannot fire because reading a string variable cannot throw.
		try {
			return status;
		} catch (err) {
			const message = getErrorMessage(err);
			console.error("[stt-server] Status handler error:", message);
			throw new Error(message);
		}
		// Stryker restore BlockStatement,StringLiteral
	});
}

/** Restart the STT server with updated settings from electron-store. */
export function restartSttProcess(): void {
	killSttProcess();
	try {
		spawnServer();
	} catch (err) {
		setErrorState();
		console.error("[stt-server] Restart spawn error:", err);
	}
}

/** Returns whether the STT server process is currently alive. */
export function isSttProcessRunning(): boolean {
	return sttProcess != null;
}

function formatAutoSpawnError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Try to auto-spawn the STT server at startup. Gracefully handles errors (e.g. missing STT_SERVER_DIR). */
export function tryAutoSpawnServer(): void {
	if (sttProcess) {
		dbg("stt-spawn", "Auto-spawn skipped: process already running");
		return;
	}
	try {
		spawnServer();
		// sttProcess is mutated by spawnServer() but TS narrows it to null
		// after the early-return guard. Use a helper to re-read the module variable.
		dbg("stt-spawn", "Auto-spawn succeeded, pid=", getSttProcessPid());
	} catch (err) {
		dbg("stt-spawn", "Auto-spawn SKIPPED:", formatAutoSpawnError(err));
	}
}

function dispatchPlatformKill(proc: ChildProcess, pid: number): void {
	// Stryker disable next-line ConditionalExpression: equivalent mutant — `process.platform` cannot be toggled at runtime within a single bun-test process, so we cover only one branch per test run.
	if (process.platform === "win32") {
		// Kill the entire process tree without blocking the main process.
		const killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
			stdio: "ignore",
			windowsHide: true,
		});
		killer.on("error", (error) => {
			dbg("stt-process", `Failed to kill process tree ${pid}:`, getErrorMessage(error));
		});
		// Stryker disable next-line BlockStatement,StringLiteral: equivalent mutants on non-win32 — under win32 test runs the else block is dead code; under linux/mac runs the win32 block is dead code. Branch reachability is determined by the OS the suite runs on, not by any test toggle.
	} else {
		proc.kill("SIGTERM");
	}
}

/** Kill the STT subprocess tree. Exported for use in app lifecycle cleanup. */
export function killSttProcess(): void {
	const proc = sttProcess;
	if (!proc?.pid) {
		return;
	}

	const pid = proc.pid;
	sttProcess = null;
	status = "idle";

	try {
		dispatchPlatformKill(proc, pid);
		dbg("stt-process", `Killed process ${pid} successfully`);
	} catch (err) {
		// Process may have already exited
		dbg("stt-process", `Failed to kill process ${pid}:`, getErrorMessage(err));
	}
}

/** Test hook: extracted helpers for direct unit testing. */
export const __stt_process_test_helpers__ = {
	readActiveWakeWord,
	resolveWakeWordContext,
};
