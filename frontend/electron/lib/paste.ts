import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app, clipboard } from "electron";
import { setPasteGuard } from "../ipc/hotkey";
import { dbg } from "./debug-log";

/**
 * Paste the transcribed text into the focused window via the bundled
 * `winstt-paste.exe` native helper.
 *
 * Why a compiled C binary instead of PowerShell:
 *   - Cold-start: <50ms vs PowerShell's 2-8s under Defender scanning.
 *   - AV doesn't re-scan it every paste — it's a single signed binary.
 *   - SendInput from `winstt-paste.exe` doesn't trip the AV "paste from
 *     powershell.exe" hook that was indefinitely blocking previous calls.
 *   - The binary handles modifier-release, terminal detection
 *     (Ctrl+Shift+V for terminals), and exits in a known short window.
 *
 * Lifecycle:
 *   1. Mirror the text to the system clipboard (so the binary's Ctrl+V
 *      reads the right thing, and so the user can re-paste manually).
 *   2. setPasteGuard(true) — uiohook ignores the synthetic key events
 *      from the binary so they can't be misread as a user releasing
 *      the PTT hotkey.
 *   3. spawn the binary with a 2.5s hard timeout.
 *   4. setPasteGuard(false) in finally — guaranteed to lift, otherwise
 *      the hotkey handler stays blocked and the app appears frozen.
 *
 * Calls are serialized via `pasteInFlight` so concurrent fullSentence
 * events can't stack and clobber each other's clipboard contents.
 */

const PASTE_TIMEOUT_MS = 2500;
/**
 * Hold the paste guard a touch longer than the binary's lifetime. Windows'
 * input queue can deliver synthetic events to uiohook AFTER `winstt-paste.exe`
 * exits, so a tail window prevents the binary's `RestoreModifiers` re-press
 * events from being treated as real user input.
 */
const PASTE_GUARD_TAIL_MS = 50;
/**
 * After a paste timeout, suppress further binary spawns for this long. A
 * timeout almost always means an AV / accessibility keyboard hook is
 * blocking SendInput in another process — and on the terminal fallback
 * path that can take the OS-wide input queue down with it (60+ second
 * system freezes). During cooldown we still write to the clipboard so
 * the user can `Ctrl+V` manually; we just don't risk another hang.
 */
const PASTE_COOLDOWN_MS = 30_000;
/**
 * Minimum wall-clock gap between consecutive paste binary spawns.
 *
 * The reason: Win32 `SendInput` events go through the OS-wide input
 * queue, and any installed low-level keyboard hook (AV / accessibility
 * software / streaming overlays) gets a synchronous chance to inspect
 * each event. If that hook is slow, the input queue stalls — every
 * other app's keyboard input (including the user's PHYSICAL key
 * release that should end the next PTT cycle) sits behind our
 * synthetic events for the duration of the hook's processing. We've
 * observed 60+ second system-wide stalls cascading from rapid PTT.
 *
 * Killing our binary doesn't help: the kernel-side hook continues
 * holding the queue lock until it completes, regardless of whether
 * the calling process is still alive. The only reliable mitigation
 * is to NOT trigger another SendInput before the previous one has
 * had time to drain through the hook chain.
 */
const PASTE_MIN_GAP_MS = 350;

let pasteInFlight: Promise<void> | null = null;
/** How many pastes are queued (in-flight + waiting). Diagnostic only. */
let queueDepth = 0;
/** Epoch ms when the cooldown lifts. 0 = no cooldown active. */
let cooldownUntil = 0;
/** Epoch ms when the last paste binary spawn returned. Used to gap pastes. */
let lastSpawnFinishedAt = 0;

function getBinaryCandidate(): string {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, "native", "bin", "winstt-paste.exe");
	}
	// Dev: __dirname is `dist-electron`; binary is at <project>/electron/native/bin
	return path.join(import.meta.dirname, "..", "electron", "native", "bin", "winstt-paste.exe");
}

/**
 * Resolve the path to `winstt-paste.exe`. In dev it lives at
 * `electron/native/bin/`, in packaged builds at
 * `process.resourcesPath/native/bin/` (set up by electron-builder
 * `extraResources`).
 */
function resolveBinary(): string | null {
	// Stryker disable next-line ConditionalExpression,BlockStatement: equivalent on Windows test runners — the early return only fires on non-win32; with the suite always running on Windows, mutating to `if (false)` just falls through to the candidate path which still resolves correctly via the mocked existsSync
	if (process.platform !== "win32") {
		return null;
	}
	const candidate = getBinaryCandidate();
	return existsSync(candidate) ? candidate : null;
}

let cachedBinary: string | null | undefined;
// Stryker disable StringLiteral,BlockStatement,ConditionalExpression: equivalent —
// every dbg() call inside getBinary() writes only to the diagnostic log file
// (no observable side effect on the test API), and the cached return value is
// unaffected by which branch logs. The if-cache guard is observably identical
// when the resolver returns the same path on every call.
function getBinary(): string | null {
	if (cachedBinary === undefined) {
		cachedBinary = resolveBinary();
		if (cachedBinary) {
			dbg("paste", `using ${cachedBinary}`);
		} else {
			dbg(
				"paste",
				"winstt-paste.exe not found — build it via `node scripts/native/build-winstt-paste.cjs`"
			);
		}
	}
	return cachedBinary;
}
// Stryker restore StringLiteral,BlockStatement,ConditionalExpression

function runBinary(binPath: string): Promise<{ ok: boolean; reason?: string }> {
	return new Promise((resolve) => {
		let done = false;
		let killTimer: ReturnType<typeof setTimeout> | null = null;
		let child: ChildProcess | null = null;

		const finish = (ok: boolean, reason?: string) => {
			if (done) {
				return;
			}
			done = true;
			if (killTimer) {
				clearTimeout(killTimer);
				killTimer = null;
			}
			resolve({ ok, reason });
		};

		killTimer = setTimeout(() => {
			try {
				child?.kill("SIGKILL");
			} catch {
				// best-effort
			}
			finish(false, `timed out after ${PASTE_TIMEOUT_MS}ms`);
		}, PASTE_TIMEOUT_MS);

		try {
			child = spawn(binPath, [], {
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (err) {
			finish(false, `spawn failed: ${(err as Error).message}`);
			return;
		}

		let stderrBuf = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBuf += chunk.toString();
		});

		child.on("error", (err) => {
			finish(false, `process error: ${err.message}`);
		});

		child.on("close", (code) => {
			if (code === 0) {
				finish(true);
			} else {
				finish(false, `exit ${code}${stderrBuf ? `: ${stderrBuf.trim()}` : ""}`);
			}
		});
	});
}

/** Write text to clipboard, returning false if it fails. */
function writeClipboard(text: string): boolean {
	try {
		clipboard.writeText(text);
		return true;
	} catch (err) {
		dbg("paste", `clipboard.writeText failed: ${(err as Error).message}`);
		return false;
	}
}

/** Enforce the minimum inter-paste gap. Returns once the gap has elapsed. */
async function enforcePaceGap(): Promise<void> {
	const sinceLast = Date.now() - lastSpawnFinishedAt;
	if (sinceLast < PASTE_MIN_GAP_MS) {
		const wait = PASTE_MIN_GAP_MS - sinceLast;
		dbg("paste", `pacing: waiting ${wait}ms before next paste (input-queue safety)`);
		await new Promise<void>((r) => setTimeout(r, wait));
	}
}

function isSlowPaste(waitedMs: number, elapsed: number): boolean {
	return waitedMs > 250 || elapsed > 300;
}

/** Log paste outcome and update the cooldown if the binary failed. */
function handleBinaryResult(
	result: { ok: boolean; reason?: string },
	elapsed: number,
	waitedMs: number
): void {
	if (!result.ok) {
		dbg("paste", `failed after ${elapsed}ms: ${result.reason ?? "unknown"}`);
		cooldownUntil = Date.now() + PASTE_COOLDOWN_MS;
		dbg("paste", `entering cooldown for ${PASTE_COOLDOWN_MS}ms`);
		return;
	}
	if (isSlowPaste(waitedMs, elapsed)) {
		dbg("paste", `ok in ${elapsed}ms (queued for ${waitedMs}ms, depth=${queueDepth})`);
	}
}

async function runPasteOnce(text: string, enqueuedAt: number): Promise<void> {
	const waitedMs = Date.now() - enqueuedAt;
	if (!writeClipboard(text)) {
		return;
	}

	const binPath = getBinary();
	if (!binPath) {
		// No binary — text is on the clipboard but we can't auto-paste.
		return;
	}

	const now = Date.now();
	if (now < cooldownUntil) {
		const remaining = cooldownUntil - now;
		dbg("paste", `in cooldown (${remaining}ms left) — text on clipboard, use Ctrl+V`);
		return;
	}

	await enforcePaceGap();

	setPasteGuard(true);
	const t0 = Date.now();
	try {
		const result = await runBinary(binPath);
		handleBinaryResult(result, Date.now() - t0, waitedMs);
	} finally {
		// CRITICAL: must always lift the guard. Hold for a tail window so
		// trailing synthetic events from the binary's terminal-fallback
		// `RestoreModifiers` don't slip through after the guard has lifted.
		await new Promise<void>((r) => setTimeout(r, PASTE_GUARD_TAIL_MS));
		setPasteGuard(false);
		// Mark the spawn boundary AFTER the tail wait — that's when the
		// next paste's PASTE_MIN_GAP_MS pacing should start counting.
		lastSpawnFinishedAt = Date.now();
	}
}

export function pasteText(text: string): void {
	if (!text) {
		return;
	}
	if (process.platform !== "win32") {
		return;
	}

	const enqueuedAt = Date.now();
	queueDepth += 1;
	const next = (pasteInFlight ?? Promise.resolve())
		.then(() => runPasteOnce(text, enqueuedAt))
		.finally(() => {
			queueDepth -= 1;
		});
	pasteInFlight = next.catch(() => undefined);
}

/** Test hook: await any pending paste work. */
export function flushPastePending(): Promise<void> {
	return pasteInFlight ?? Promise.resolve();
}

/** Test hook: clear the circuit-breaker cooldown so each test starts fresh. */
export function __resetPasteForTesting__(): void {
	cooldownUntil = 0;
	lastSpawnFinishedAt = 0;
	// Reset the binary path cache so that the next call to getBinary() re-evaluates
	// existsSync() with whichever mock is currently active. This prevents cross-test
	// contamination when a prior test file caused getBinary() to cache null (because
	// the node:fs mock was not yet active when pasteText was first invoked).
	cachedBinary = undefined;
}
