import type { ChildProcess } from "node:child_process";
import { execSync, spawn } from "node:child_process";
import path from "node:path";
import { app, ipcMain } from "electron";
import { store } from "../lib/store";

let sttProcess: ChildProcess | null = null;
let status: "idle" | "starting" | "running" | "error" = "idle";

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
	["quality.enableRealtimeTranscription", "--enable_realtime_transcription"],
	["quality.useMainModelForRealtime", "--use_main_model_for_realtime"],
	["quality.realtimeProcessingPause", "--realtime_processing_pause"],
	["quality.earlyTranscriptionOnSilence", "--early_transcription_on_silence"],
	["quality.initRealtimeAfterSeconds", "--init_realtime_after_seconds"],
	["quality.batchSize", "--batch"],
	["quality.realtimeBatchSize", "--realtime_batch_size"],
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
	throw new Error(
		"STT_SERVER_DIR environment variable is not set. Set it to the server/ directory path."
	);
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

export function setupSttProcessHandlers() {
	ipcMain.handle("stt-server:spawn", () => {
		if (sttProcess) {
			return;
		}

		let serverDir: string;
		try {
			serverDir = resolveServerDir();
		} catch (err) {
			status = "error";
			throw err;
		}

		const { command, args: baseArgs } = resolveSpawnArgs(serverDir);
		const args = buildServerArgs(baseArgs);

		status = "starting";

		try {
			sttProcess = spawn(command, args, {
				cwd: serverDir,
				shell: false,
			});
		} catch (err) {
			status = "error";
			sttProcess = null;
			throw err;
		}

		sttProcess.stdout?.on("data", (data: Buffer) => {
			const text = data.toString();
			console.log("[stt-server]", text.trimEnd());
			if (text.includes("RealtimeSTT initialized")) {
				status = "running";
			}
		});

		sttProcess.stderr?.on("data", (data: Buffer) => {
			console.error("[stt-server]", data.toString().trimEnd());
		});

		sttProcess.on("exit", () => {
			sttProcess = null;
			status = "idle";
		});

		sttProcess.on("error", (err) => {
			console.error("[stt-server] Spawn error:", err);
			status = "error";
			sttProcess = null;
		});
	});

	ipcMain.handle("stt-server:kill", () => {
		killSttProcess();
	});

	ipcMain.handle("stt-server:status", () => {
		return status;
	});
}

/** Restart the STT server with updated settings from electron-store. */
export function restartSttProcess() {
	killSttProcess();
	// Re-trigger spawn via the same handler logic
	const serverDir = resolveServerDir();
	const { command, args: baseArgs } = resolveSpawnArgs(serverDir);
	const args = buildServerArgs(baseArgs);

	status = "starting";

	try {
		sttProcess = spawn(command, args, {
			cwd: serverDir,
			shell: false,
		});
	} catch (err) {
		status = "error";
		sttProcess = null;
		console.error("[stt-server] Restart spawn error:", err);
		return;
	}

	sttProcess.stdout?.on("data", (data: Buffer) => {
		const text = data.toString();
		console.log("[stt-server]", text.trimEnd());
		if (text.includes("RealtimeSTT initialized")) {
			status = "running";
		}
	});

	sttProcess.stderr?.on("data", (data: Buffer) => {
		console.error("[stt-server]", data.toString().trimEnd());
	});

	sttProcess.on("exit", () => {
		sttProcess = null;
		status = "idle";
	});

	sttProcess.on("error", (err) => {
		console.error("[stt-server] Spawn error:", err);
		status = "error";
		sttProcess = null;
	});

	console.log("[stt-server] Restarted with args:", args.join(" "));
}

/** Returns whether the STT server process is currently alive. */
export function isSttProcessRunning(): boolean {
	return sttProcess != null;
}

/** Kill the STT subprocess tree. Exported for use in app lifecycle cleanup. */
export function killSttProcess() {
	if (!sttProcess?.pid) {
		return;
	}

	try {
		if (process.platform === "win32") {
			// On Windows, kill the entire process tree
			execSync(`taskkill /T /F /PID ${sttProcess.pid}`, { stdio: "ignore" });
		} else {
			sttProcess.kill("SIGTERM");
		}
	} catch {
		// Process may have already exited
	}
	sttProcess = null;
	status = "idle";
}
