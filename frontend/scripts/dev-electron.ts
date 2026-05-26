#!/usr/bin/env bun
/**
 * Minimal electronmon replacement.
 *
 * Why this exists: electronmon stays alive after `app.quit()` to wait for file
 * changes, so a user clicking "Quit" in the dev session leaves the dev shell
 * hanging. This script spawns electron, watches `dist-electron/` for rebuilds,
 * restarts electron on change, and propagates the electron exit code — so a
 * clean `app.quit()` (code 0) terminates the dev orchestrator via
 * `concurrently -k`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, type FSWatcher, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const watchDir = path.join(projectRoot, "dist-electron");

// Default STT_SERVER_DIR to the repo's server/ checkout when the user hasn't
// set one explicitly. resolveServerDir in electron/ipc/stt-process.ts spawns
// `uv run stt-server` from this directory, so pointing it at our live source
// guarantees the dev Electron always boots the current server build — no more
// "outdated build / missing request_diarization_toggle" drift when a stale
// background uv-server process is running. Shell env wins if the user
// overrides it from their terminal.
const defaultServerDir = path.resolve(projectRoot, "..", "server");
if (!process.env.STT_SERVER_DIR && existsSync(path.join(defaultServerDir, "pyproject.toml"))) {
	process.env.STT_SERVER_DIR = defaultServerDir;
}

// node_modules/.bin/electron is the cross-platform launcher. Bun uses
// `.exe` shims on Windows; npm/pnpm use `.cmd`. Fall back across the variants.
function resolveElectronBinary(): string {
	const binDir = path.join(projectRoot, "node_modules", ".bin");
	const candidates =
		process.platform === "win32" ? ["electron.exe", "electron.cmd", "electron"] : ["electron"];
	for (const name of candidates) {
		const candidate = path.join(binDir, name);
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	throw new Error(`No electron launcher found in ${binDir}`);
}

const electronBinary = resolveElectronBinary();

let child: ChildProcess | null = null;
let restarting = false;
let shuttingDown = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

function log(message: string): void {
	console.log(`[dev-electron] ${message}`);
}

function startElectron(): void {
	log(`STT_SERVER_DIR = ${process.env.STT_SERVER_DIR ?? "(unset)"}`);
	log("starting electron .");
	const proc = spawn(electronBinary, ["."], {
		cwd: projectRoot,
		stdio: "inherit",
		shell: false,
	});
	child = proc;

	proc.once("exit", (code, signal) => {
		child = null;
		if (restarting) {
			restarting = false;
			startElectron();
			return;
		}
		if (shuttingDown) {
			return;
		}
		// Propagate the child's exit so the dev orchestrator can tear down.
		if (signal) {
			log(`electron exited via signal ${signal}`);
			process.exit(1);
		}
		log(`electron exited with code ${code ?? 0}`);
		process.exit(code ?? 0);
	});

	proc.once("error", (err) => {
		log(`failed to spawn electron: ${err.message}`);
		process.exit(1);
	});
}

function scheduleRestart(reason: string): void {
	if (shuttingDown || !child) {
		return;
	}
	if (restartTimer) {
		clearTimeout(restartTimer);
	}
	// Debounce: tsup writes the bundle and the sourcemap separately.
	restartTimer = setTimeout(() => {
		restartTimer = null;
		if (!child || shuttingDown) {
			return;
		}
		log(`restarting (${reason})`);
		restarting = true;
		child.kill();
	}, 150);
}

let watcher: FSWatcher | null = null;
try {
	watcher = watch(watchDir, { recursive: true }, (_event, filename) => {
		if (!filename) {
			return;
		}
		// Ignore sourcemaps; the bundle change is what matters.
		if (filename.endsWith(".map")) {
			return;
		}
		scheduleRestart(String(filename));
	});
} catch (err) {
	log(`watch failed (${(err as Error).message}); continuing without auto-reload`);
}

function shutdown(signal: NodeJS.Signals): void {
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;
	log(`received ${signal}, shutting down`);
	watcher?.close();
	if (child) {
		child.kill();
	} else {
		process.exit(0);
	}
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

startElectron();
