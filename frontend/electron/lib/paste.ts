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
		logBinaryResolution(cachedBinary);
	}
	return cachedBinary;
}
// Stryker restore StringLiteral,BlockStatement,ConditionalExpression

function logBinaryResolution(resolved: string | null): void {
	if (resolved) {
		dbg("paste", `using ${resolved}`);
		return;
	}
	dbg(
		"paste",
		"winstt-paste.exe not found — build it via `node scripts/native/build-winstt-paste.cjs`"
	);
}

/**
 * Mutable closure state for a single paste binary invocation.
 * Extracted so the inner helpers (finish, timeout, close handlers) can be
 * unit-tested in isolation without re-entering the spawn flow.
 */
interface BinaryRun {
	child: ChildProcess | null;
	done: boolean;
	killTimer: ReturnType<typeof setTimeout> | null;
	resolve: (value: { ok: boolean; reason?: string }) => void;
	stderrBuf: string;
}

/** Idempotent settle of a BinaryRun: clears the timer and resolves once. */
export function finishBinaryRun(run: BinaryRun, ok: boolean, reason: string | undefined): void {
	if (run.done) {
		return;
	}
	run.done = true;
	if (run.killTimer) {
		clearTimeout(run.killTimer);
		run.killTimer = null;
	}
	run.resolve({ ok, reason });
}

/** Best-effort kill on timeout. Wrapped so SIGKILL throws don't escape. */
export function killBinaryOnTimeout(run: BinaryRun): void {
	try {
		run.child?.kill("SIGKILL");
	} catch {
		// best-effort
	}
	finishBinaryRun(run, false, `timed out after ${PASTE_TIMEOUT_MS}ms`);
}

/** Translate the child's exit code into a finish reason. */
export function closeBinaryRun(run: BinaryRun, code: number | null): void {
	if (code === 0) {
		finishBinaryRun(run, true, undefined);
		return;
	}
	const detail = run.stderrBuf ? `: ${run.stderrBuf.trim()}` : "";
	finishBinaryRun(run, false, `exit ${code}${detail}`);
}

/**
 * Spawn the binary into the existing run. On failure, finish the run with a
 * descriptive reason and return false so the caller can stop wiring handlers.
 * Returns true on a successful spawn (caller should attach child handlers).
 */
export function spawnInto(run: BinaryRun, binPath: string): boolean {
	try {
		run.child = spawn(binPath, [], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		return true;
	} catch (err) {
		finishBinaryRun(run, false, `spawn failed: ${(err as Error).message}`);
		return false;
	}
}

/**
 * Attach the standard child handlers (stderr accumulator, error → finish,
 * close → result) to a successfully-spawned BinaryRun.
 */
export function attachChildHandlers(run: BinaryRun): void {
	const child = run.child;
	if (!child) {
		return;
	}
	child.stderr?.on("data", (chunk: Buffer) => {
		run.stderrBuf += chunk.toString();
	});
	child.on("error", (err) => {
		finishBinaryRun(run, false, `process error: ${err.message}`);
	});
	child.on("close", (code) => closeBinaryRun(run, code));
}

/** Construct an empty BinaryRun bound to the given resolve callback. */
export function makeBinaryRun(
	resolve: (value: { ok: boolean; reason?: string }) => void
): BinaryRun {
	return {
		child: null,
		done: false,
		killTimer: null,
		resolve,
		stderrBuf: "",
	};
}

/**
 * Body of the runBinary Promise — extracted so it can be unit-tested directly
 * (the bun coverage reporter has trouble merging hits inside Promise IIFEs).
 */
export function startBinaryRun(
	resolve: (value: { ok: boolean; reason?: string }) => void,
	binPath: string
): BinaryRun {
	const run = makeBinaryRun(resolve);
	run.killTimer = setTimeout(() => killBinaryOnTimeout(run), PASTE_TIMEOUT_MS);
	if (spawnInto(run, binPath)) {
		attachChildHandlers(run);
	}
	return run;
}

function runBinary(binPath: string): Promise<{ ok: boolean; reason?: string }> {
	return new Promise((resolve) => startBinaryRun(resolve, binPath));
}

/** Write text to clipboard, returning false if it fails. */
export function writeClipboard(text: string): boolean {
	try {
		clipboard.writeText(text);
		return true;
	} catch (err) {
		dbg("paste", `clipboard.writeText failed: ${(err as Error).message}`);
		return false;
	}
}

/** Enforce the minimum inter-paste gap. Returns once the gap has elapsed. */
export async function enforcePaceGap(): Promise<void> {
	const wait = computePaceWait(Date.now(), lastSpawnFinishedAt);
	if (wait > 0) {
		dbg("paste", `pacing: waiting ${wait}ms before next paste (input-queue safety)`);
		await new Promise<void>((r) => setTimeout(r, wait));
	}
}

/** Returns the ms to wait before the next paste, or 0 if no wait needed. */
export function computePaceWait(now: number, lastFinishedAt: number): number {
	const sinceLast = now - lastFinishedAt;
	const wait = PASTE_MIN_GAP_MS - sinceLast;
	return wait > 0 ? wait : 0;
}

export function isSlowPaste(waitedMs: number, elapsed: number): boolean {
	return waitedMs > 250 || elapsed > 300;
}

/** Log paste outcome and update the cooldown if the binary failed. */
export function handleBinaryResult(
	result: { ok: boolean; reason?: string },
	elapsed: number,
	waitedMs: number
): void {
	if (result.ok) {
		logIfSlow(waitedMs, elapsed);
		return;
	}
	tripCooldown(result.reason, elapsed);
}

function tripCooldown(reason: string | undefined, elapsed: number): void {
	dbg("paste", `failed after ${elapsed}ms: ${reason ?? "unknown"}`);
	cooldownUntil = Date.now() + PASTE_COOLDOWN_MS;
	dbg("paste", `entering cooldown for ${PASTE_COOLDOWN_MS}ms`);
}

function logIfSlow(waitedMs: number, elapsed: number): void {
	if (isSlowPaste(waitedMs, elapsed)) {
		dbg("paste", `ok in ${elapsed}ms (queued for ${waitedMs}ms, depth=${queueDepth})`);
	}
}

/**
 * Resolve the binary path + cooldown state into a "what should we do now"
 * decision. Returning the path means "spawn the binary"; returning null
 * means "the clipboard write was enough — skip the spawn".
 */
export function decideSpawnTarget(now: number): string | null {
	const binPath = getBinary();
	if (!binPath) {
		// No binary — text is on the clipboard but we can't auto-paste.
		return null;
	}
	if (now < cooldownUntil) {
		const remaining = cooldownUntil - now;
		dbg("paste", `in cooldown (${remaining}ms left) — text on clipboard, use Ctrl+V`);
		return null;
	}
	return binPath;
}

async function runPasteOnce(text: string, enqueuedAt: number): Promise<void> {
	const waitedMs = Date.now() - enqueuedAt;
	if (!writeClipboard(text)) {
		return;
	}
	const binPath = decideSpawnTarget(Date.now());
	if (!binPath) {
		return;
	}
	await enforcePaceGap();
	await spawnPasteWithGuard(binPath, waitedMs);
}

async function spawnPasteWithGuard(binPath: string, waitedMs: number): Promise<void> {
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

/** Returns true when the caller should skip queuing the paste entirely. */
export function shouldSkipPaste(text: string): boolean {
	if (!text) {
		return true;
	}
	return process.platform !== "win32";
}

export function pasteText(text: string): void {
	if (shouldSkipPaste(text)) {
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

/** Test hook: directly set cooldownUntil to exercise the cooldown branch. */
export function __setCooldownUntilForTesting__(epochMs: number): void {
	cooldownUntil = epochMs;
}

/** Test hook: read the current cooldownUntil (epoch ms; 0 = no cooldown). */
export function __getCooldownUntilForTesting__(): number {
	return cooldownUntil;
}

/** Test hook: read the last-spawn timestamp (epoch ms; 0 = never). */
export function __getLastSpawnFinishedAtForTesting__(): number {
	return lastSpawnFinishedAt;
}

/** Test hook: directly set lastSpawnFinishedAt to test pace-gap branches. */
export function __setLastSpawnFinishedAtForTesting__(epochMs: number): void {
	lastSpawnFinishedAt = epochMs;
}

/** Test hook: build a BinaryRun stub so the finish/kill/close helpers can be exercised. */
export function __makeBinaryRunForTesting__(
	resolve: (value: { ok: boolean; reason?: string }) => void
): BinaryRun {
	return makeBinaryRun(resolve);
}
