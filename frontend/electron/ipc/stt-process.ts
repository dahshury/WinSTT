import type { ChildProcess } from "node:child_process";
import { execSync, spawn } from "node:child_process";
import path from "node:path";
import { app, ipcMain } from "electron";
import { getErrorMessage, NotFoundError, ProcessSpawnError } from "../../src/shared/lib/errors";
import { dbg } from "../lib/debug-log";
import { store } from "../lib/store";

let sttProcess: ChildProcess | null = null;
let status: "idle" | "starting" | "running" | "error" = "idle";

function setErrorState() {
	status = "error";
	sttProcess = null;
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

/** Read all relevant settings from electron-store and convert to CLI args */
function buildServerArgs(baseArgs: string[]): string[] {
	const args = [...baseArgs];
	for (const [storePath, cliFlag] of SETTINGS_TO_CLI) {
		const value = store.get(storePath) as string | number | boolean | undefined;
		if (value == null || value === "") {
			continue;
		}
		// Boolean flags from store use --flag (action="store_true") style
		if (typeof value === "boolean") {
			if (value) {
				args.push(cliFlag);
			}
			// false booleans: skip the flag entirely (server defaults to false)
			continue;
		}
		args.push(cliFlag, String(value));
	}

	// BooleanOptionalAction flags: --flag when true, --no-flag when false
	for (const [storePath, cliFlag] of BOOLEAN_OPTIONAL_CLI) {
		const value = store.get(storePath) as boolean | undefined;
		if (value === true) {
			args.push(cliFlag);
		} else if (value === false) {
			args.push(cliFlag.replace("--", "--no-"));
		}
		// undefined: let server use its default
	}

	// sileroDeactivityDetection is a boolean store_true flag
	const sileroDeact = store.get("audio.sileroDeactivityDetection") as boolean | undefined;
	if (sileroDeact) {
		args.push("--silero_deactivity_detection");
	}

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
	if (app.isPackaged) {
		return path.join(process.resourcesPath, "stt-server");
	}
	throw new NotFoundError("STT_SERVER_DIR", undefined, {
		message:
			"STT_SERVER_DIR environment variable is not set. Set it to the server/ directory path.",
		isPackaged: app.isPackaged,
		resourcesPath: process.resourcesPath,
	});
}

/**
 * Resolve the command to spawn the STT server. In production with a bundled
 * PyInstaller executable, spawn it directly. In development, use `uv run`.
 */
function resolveSpawnArgs(serverDir: string): { command: string; args: string[] } {
	if (app.isPackaged) {
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
	proc.stdout?.on("data", (data: Buffer) => {
		const text = data.toString();
		console.log("[stt-server]", text.trimEnd());
		if (text.includes("RealtimeSTT initialized") && sttProcess === proc) {
			status = "running";
		}
	});

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

export function setupSttProcessHandlers() {
	ipcMain.handle("stt-server:spawn", () => {
		try {
			if (sttProcess) {
				dbg("stt-spawn", "Process already running, skipping spawn");
				return;
			}
			spawnServer();
		} catch (err) {
			setErrorState();
			console.error("[stt-server] Spawn handler error:", getErrorMessage(err));
			throw err;
		}
	});

	ipcMain.handle("stt-server:kill", () => {
		try {
			killSttProcess();
		} catch (err) {
			console.error("[stt-server] Kill handler error:", getErrorMessage(err));
			throw err;
		}
	});

	ipcMain.handle("stt-server:status", () => {
		try {
			return status;
		} catch (err) {
			console.error("[stt-server] Status handler error:", getErrorMessage(err));
			throw err;
		}
	});
}

/** Restart the STT server with updated settings from electron-store. */
export function restartSttProcess() {
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

/** Try to auto-spawn the STT server at startup. Gracefully handles errors (e.g. missing STT_SERVER_DIR). */
export function tryAutoSpawnServer(): void {
	if (sttProcess) {
		dbg("stt-spawn", "Auto-spawn skipped: process already running");
		return;
	}
	try {
		spawnServer();
		dbg("stt-spawn", "Auto-spawn succeeded, pid=", (sttProcess as ChildProcess | null)?.pid);
	} catch (err) {
		dbg("stt-spawn", "Auto-spawn SKIPPED:", err instanceof Error ? err.message : String(err));
	}
}

/** Kill the STT subprocess tree. Exported for use in app lifecycle cleanup. */
export function killSttProcess() {
	if (!sttProcess?.pid) {
		return;
	}

	const pid = sttProcess.pid;
	try {
		if (process.platform === "win32") {
			// On Windows, kill the entire process tree
			execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" });
		} else {
			sttProcess.kill("SIGTERM");
		}
		dbg("stt-process", `Killed process ${pid} successfully`);
	} catch (err) {
		// Process may have already exited
		dbg("stt-process", `Failed to kill process ${pid}:`, getErrorMessage(err));
	} finally {
		sttProcess = null;
		status = "idle";
	}
}
