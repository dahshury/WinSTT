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
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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
		// A clean exit (code 0, no signal) is a USER quit — the tray "Quit" button
		// runs app.exit(0)/app.quit(). A dev-initiated hot-reload restart instead
		// kills electron via `taskkill /F` (or SIGTERM), which surfaces as a
		// non-zero code or a signal. During heavy editing tsup rebuilds constantly,
		// so `restarting` is often set; without this guard a Quit that lands in that
		// window is swallowed into an endless relaunch (electron reboots HIDDEN into
		// the tray) — the process never exits, dev-electron never propagates, and
		// `bun dev` never returns to the prompt. Honour the clean exit instead.
		const userQuit = code === 0 && !signal;
		if (restarting && !userQuit) {
			restarting = false;
			// Wait for a build NEWER than the one this electron ran before relaunching.
			void startElectron(launchedMtimeMs);
			return;
		}
		restarting = false;
		if (shuttingDown) {
			return;
		}
		// Clean electron exit (e.g. the tray "Quit" button). before-quit →
		// killSttProcess fires an ASYNC taskkill that can lose the race against
		// electron's exit, orphaning the STT server tree; sweep it synchronously
		// so nothing outlives `bun dev`.
		reapSttServers();
		// Arm the out-of-tree backstop: concurrently's `-k` teardown is unreliable
		// with this deep Windows tree, so a clean exit here often still leaves
		// vite/tsup (and `bun dev`) running. The detached, delayed taskkill returns
		// the prompt even when concurrently wedges (no-ops when it tears down clean).
		scheduleDevSessionNuke();
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

/**
 * Tear down the electron child AND its entire descendant tree.
 *
 * Node's `child.kill()` is a single-process `TerminateProcess` on Windows — it
 * does NOT cascade to descendants. The child we spawn is
 * `node electron/cli.js` → `electron.exe` → (in dev) `uv run stt-server` →
 * `stt-server.exe` → `python`. A bare `child.kill()` hard-kills electron (cli.js
 * forwards the signal as a hard kill, so electron's `before-quit` —and thus
 * `killSttProcess()`— never runs), but the OS leaves the STT server subtree
 * orphaned on the bound ports (8011/8012), holding the GPU/model in RAM. That is
 * the exact class `reclaimOrphanStttServers()` exists to mop up on the NEXT
 * spawn — but on the final session-end there is no next spawn, so it survives
 * `bun dev`. `taskkill /T` walks the whole tree by pid and force-kills every
 * descendant, so a hot-reload restart or a Ctrl+C leaves nothing behind. POSIX
 * already cascades child death via the process group, so a plain kill suffices.
 */
function killChildTree(): void {
	const proc = child;
	if (!proc?.pid) {
		return;
	}
	if (process.platform !== "win32") {
		proc.kill();
		return;
	}
	try {
		spawnSync("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
			stdio: "ignore",
			windowsHide: true,
			timeout: 5000,
		});
	} catch {
		proc.kill(); // best-effort fallback if taskkill is missing/blocked
	}
}

/**
 * Sweep any leftover `stt-server.exe` (the venv console-script launcher the dev
 * server runs via `uv run stt-server`). Mirrors electron's
 * `reclaimOrphanStttServers()` but runs on the way OUT, as a synchronous net for
 * the *clean* electron-exit path (the tray "Quit" button): there before-quit →
 * killSttProcess fires an ASYNC `taskkill` that can lose the race against
 * electron's own exit, and by then the server tree is already orphaned (its
 * parent electron is gone) so a pid tree-kill can't find it. An image-name kill
 * reaps it regardless of parent. `stt-server.exe` is WinSTT-specific, so this
 * can't touch unrelated processes; `/T` takes its python children with it.
 * No-op off Windows.
 */
function reapSttServers(): void {
	if (process.platform !== "win32") {
		return;
	}
	try {
		spawnSync("taskkill", ["/F", "/T", "/IM", "stt-server.exe"], {
			stdio: "ignore",
			windowsHide: true,
			timeout: 3000,
		});
	} catch {
		// Best-effort: a missing/blocked taskkill leaves it for the next
		// `bun dev` to reclaim via reclaimOrphanStttServers().
	}
}

/**
 * Backstop that guarantees `bun dev` returns to the prompt on a user Quit.
 *
 * dev-electron lives deep inside the orchestrator tree
 * (`concurrently → cmd.exe → bun run electron:start → bun run dev-electron →
 * electron`). On Windows, concurrently's `-k` teardown intermittently fails to
 * react when this "app" command exits — verified live: the whole app chain was
 * gone yet concurrently + vite + tsup kept running and never returned the prompt
 * (only Ctrl+C, which kills the tree, worked). So a clean dev-electron exit is
 * NOT enough on its own.
 *
 * We walk up our own ancestors to find the `concurrently` pid, then have WMI
 * (`Win32_Process.Create`) spawn a detached, slightly-delayed killer that runs
 * `taskkill /F /T /IM stt-server.exe` (reaps the orphaned server tree, which
 * reparents out from under every pid-based kill) AND `taskkill /F /T /PID <cc>`.
 * Key properties:
 *   • OUT-OF-TREE — created by WmiPrvSE, not as our child — so the killer isn't
 *     taken down together with the very tree it is killing.
 *   • WINDOW-LESS — `Win32_ProcessStartup.ShowWindow = SW_HIDE (0)`, so the
 *     helper cmd runs with a hidden console and never flashes a terminal.
 *     (Don't use CreateFlags: CREATE_NO_WINDOW / 0x08000000 is rejected by WMI
 *     with "invalid parameter", and DETACHED_PROCESS / 8 gives the cmd NO console
 *     at all, which silently breaks the taskkill inside it — verified live.
 *     SW_HIDE keeps a real (hidden) console so taskkill still works.)
 *   • DELAYED ~1s — if concurrently DOES tear down cleanly (the common case),
 *     its tree is already gone and the taskkill no-ops; the kill only matters
 *     when the teardown wedged.
 *   • SCOPED to one concurrently pid, so a second `bun dev` is untouched.
 * Killing concurrently force-closes vite + tsup + the app chain; its parents
 * (`bun run electron:dev` → `bun dev`) then exit on their own, returning the
 * prompt. No-op when there's no concurrently ancestor (dev-electron run
 * standalone) or off Windows.
 */
function scheduleDevSessionNuke(): void {
	if (process.platform !== "win32") {
		return;
	}
	const ps =
		`$me=${process.pid};$all=Get-CimInstance Win32_Process;$cur=$me;$cc=$null;` +
		"for($i=0;$i -lt 16;$i++){$p=$all|Where-Object{$_.ProcessId -eq $cur};if(-not $p){break};" +
		"if($p.CommandLine -match 'concurrently'){$cc=$p.ProcessId;break};$cur=$p.ParentProcessId};" +
		"if($cc){$si=([wmiclass]'Win32_ProcessStartup').CreateInstance();$si.ShowWindow=0;" +
		"([wmiclass]'Win32_Process').Create('cmd /c ping -n 2 127.0.0.1 >nul " +
		"& taskkill /F /T /IM stt-server.exe & taskkill /F /T /PID '+$cc,$null,$si)|Out-Null}";
	try {
		spawnSync("powershell", ["-NoProfile", "-Command", ps], {
			stdio: "ignore",
			windowsHide: true,
			timeout: 4000,
		});
	} catch {
		// Best-effort backstop — if it can't arm, the clean process.exit below
		// plus concurrently's own teardown are the only recourse.
	}
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
		killChildTree();
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
	// Hard-kill the whole electron tree (cli.js → electron → uv → stt-server →
	// python) synchronously, then sweep any stray stt-server.exe by image name,
	// so an abrupt `bun dev` end (Ctrl+C, closed terminal, a sibling command
	// dying under `concurrently -k`) never leaves the STT server running.
	killChildTree();
	reapSttServers();
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

// First launch: baseline is the (possibly stale) bundle currently on disk, so
// we wait for tsup's initial rebuild to land before booting — no first-launch
// race against a leftover bundle from a previous session.
void startElectron(mainBundleMtimeMs());
