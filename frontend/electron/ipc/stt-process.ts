import type { ChildProcess } from "node:child_process";
import { execSync, spawn } from "node:child_process";
import path from "node:path";
import { app, ipcMain } from "electron";
import { store } from "../lib/store";

let sttProcess: ChildProcess | null = null;
let status: "idle" | "starting" | "running" | "error" = "idle";

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

		const { command, args } = resolveSpawnArgs(serverDir);

		// Pass the user's saved model from electron-store so the server starts with it
		const model = store.get("model.model") as string | undefined;
		if (model) {
			args.push("--model", model);
		}

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
