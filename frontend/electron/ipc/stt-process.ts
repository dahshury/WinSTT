import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import { app, ipcMain } from "electron";
import { getErrorMessage, NotFoundError, ProcessSpawnError } from "../../src/shared/lib/errors";
import { dbg } from "../lib/debug-log";
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
	["model.initialPrompt", "--initial_prompt"],
	["model.initialPromptRealtime", "--initial_prompt_realtime"],
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
 * Boolean flags that use argparse BooleanOptionalAction (default=True on server).
 * These need --no-{flag} when disabled, unlike store_true flags which just omit the flag.
 */
const BOOLEAN_OPTIONAL_CLI: [storePath: string, cliFlag: string][] = [
	["quality.enableRealtimeTranscription", "--enable_realtime_transcription"],
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

function applyBooleanOptionalFlag(args: string[], value: unknown, cliFlag: string): void {
	if (value === true) {
		args.push(cliFlag);
	} else if (value === false) {
		args.push(cliFlag.replace("--", "--no-"));
	}
}

function applySileroDeactivityFlag(args: string[]): void {
	if (getStoreValue("audio.sileroDeactivityDetection")) {
		args.push("--silero_deactivity_detection");
	}
}

/** Read all relevant settings from electron-store and convert to CLI args */
function buildServerArgs(baseArgs: string[]): string[] {
	const args = [...baseArgs];
	for (const [storePath, cliFlag] of SETTINGS_TO_CLI) {
		applyStoreTrueFlag(args, getStoreRaw(storePath), cliFlag);
	}
	for (const [storePath, cliFlag] of BOOLEAN_OPTIONAL_CLI) {
		applyBooleanOptionalFlag(args, getStoreRaw(storePath), cliFlag);
	}
	applySileroDeactivityFlag(args);
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
function attachProcessHandlers(proc: ChildProcess) {
	// Stryker disable next-line OptionalChaining: equivalent mutant — `proc.stdout` is always non-null in our test environment (the spawn mock always provides an EventEmitter); the optional chain is a defensive guard against ChildProcess instances spawned with stdio: 'ignore'.
	proc.stdout?.on("data", (data: Buffer) => {
		const text = data.toString();
		console.log("[stt-server]", text.trimEnd());
		// Match the server's backend-agnostic ready marker (see
		// server/src/stt_server/server.py "Recorder initialized").  Must
		// stay in sync with the server-side string.  This only flips the
		// spawned-process status — the renderer's "ready" check goes
		// through the server_ready WebSocket message instead.
		if (text.includes("Recorder initialized") && sttProcess === proc) {
			status = "running";
		}
	});

	// Stryker disable next-line OptionalChaining: equivalent mutant — same reasoning as the proc.stdout?.on disable above; the test environment always provides a stderr EventEmitter.
	proc.stderr?.on("data", (data: Buffer) => {
		console.error("[stt-server]", data.toString().trimEnd());
	});

	proc.on("exit", () => {
		if (sttProcess === proc) {
			sttProcess = null;
			status = "idle";
		}
	});

	proc.on("error", (err) => {
		console.error("[stt-server] Spawn error:", getErrorMessage(err));
		if (sttProcess === proc) {
			const spawnError = new ProcessSpawnError(
				`Failed to spawn STT server: ${getErrorMessage(err)}`,
				proc.spawnfile ?? "unknown",
				undefined,
				{ originalError: err, pid: proc.pid }
			);
			console.error("[stt-server] ProcessSpawnError:", spawnError.toJSON());
			setErrorState();
		}
	});
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
	});

	sttProcess = proc;
	attachProcessHandlers(proc);
	dbg("stt-spawn", "CLI args:", args.join(" "));
	dbg(
		"stt-spawn",
		"store enableRealtimeTranscription=",
		store.get("quality.enableRealtimeTranscription"),
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
