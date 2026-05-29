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
import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const watchDir = path.join(projectRoot, "dist-electron");
const mainBundle = path.join(watchDir, "main.js");
const preloadBundle = path.join(watchDir, "preload.cjs");

// Bundle-settle gate (see waitForBundleReady). tsup emits ~30 chunk files per
// build and writes the 2.7 MB main.js LAST, while fs.watch fires on the FIRST
// chunk — so a naive relaunch races a half-written / previous-build main.js.
// These bound the "is the bundle done writing AND newer than what we had?"
// poll loop.
const SETTLE_POLL_MS = 100;
const SETTLE_STABLE_POLLS = 3; // ~300 ms of unchanged size+mtime ⇒ tsup done
const SETTLE_FRESH_WINDOW_MS = 5_000; // a build this recent counts as "fresh"
const SETTLE_TIMEOUT_MS = 10_000; // never block the dev loop forever

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
// mtime of the main.js the CURRENTLY-running electron was launched against.
// Restarts wait for a build NEWER than this before relaunching.
let launchedMtimeMs = 0;

function log(message: string): void {
	console.log(`[dev-electron] ${message}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function mainBundleMtimeMs(): number {
	try {
		return statSync(mainBundle).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Block until the electron-main bundle is safe to launch:
 *   1. both main.js and preload.cjs exist,
 *   2. main.js's (size, mtime) have held steady for SETTLE_STABLE_POLLS
 *      consecutive polls (tsup finished writing — not mid-build), and
 *   3. it's either NEWER than `baselineMtimeMs` (the rebuild we were waiting
 *      for has landed) or was written within the last few seconds (already
 *      fresh — a clean first build, nothing more to wait for).
 *
 * tsup emits ~30 chunk files per build and writes the 2.7 MB main.js LAST,
 * but fs.watch fires on the FIRST chunk. Without this gate a relaunch races a
 * main.js that is still the previous build's file (tsup hasn't reached it) or
 * half-written — exactly what spawned the STT server with a since-removed CLI
 * flag and hung the window on "connecting". Bounded by a timeout so a build
 * that legitimately doesn't rewrite main.js (or a fresh checkout) still
 * launches instead of hanging.
 */
async function waitForBundleReady(baselineMtimeMs: number): Promise<void> {
	const startedAt = Date.now();
	let lastSig = "";
	let stablePolls = 0;
	while (Date.now() - startedAt < SETTLE_TIMEOUT_MS) {
		if (shuttingDown) {
			return;
		}
		let mainStat: ReturnType<typeof statSync> | null = null;
		let bothPresent = true;
		try {
			mainStat = statSync(mainBundle);
			statSync(preloadBundle);
		} catch {
			bothPresent = false;
		}
		if (mainStat && bothPresent) {
			const sig = `${mainStat.size}:${mainStat.mtimeMs}`;
			if (sig === lastSig) {
				stablePolls += 1;
			} else {
				stablePolls = 1;
				lastSig = sig;
			}
			const settled = stablePolls >= SETTLE_STABLE_POLLS;
			const fresh =
				mainStat.mtimeMs > baselineMtimeMs ||
				Date.now() - mainStat.mtimeMs < SETTLE_FRESH_WINDOW_MS;
			if (settled && fresh) {
				return;
			}
		} else {
			stablePolls = 0;
			lastSig = "";
		}
		await sleep(SETTLE_POLL_MS);
	}
	log("bundle did not settle within timeout — launching with the current build");
}

async function startElectron(baselineMtimeMs: number): Promise<void> {
	// Gate the launch on a settled, current bundle so we never boot Electron
	// against a half-written or previous-build main.js (see waitForBundleReady).
	await waitForBundleReady(baselineMtimeMs);
	if (shuttingDown) {
		return;
	}
	launchedMtimeMs = mainBundleMtimeMs();
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
			// Wait for a build NEWER than the one this electron ran before relaunching.
			void startElectron(launchedMtimeMs);
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

// First launch: baseline is the (possibly stale) bundle currently on disk, so
// we wait for tsup's initial rebuild to land before booting — no first-launch
// race against a leftover bundle from a previous session.
void startElectron(mainBundleMtimeMs());
