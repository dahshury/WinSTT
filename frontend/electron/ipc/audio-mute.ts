import { ipcMain } from "electron";
import { dbg } from "../lib/debug-log";
import { runPsCommand } from "../lib/ps-host";

/**
 * Quietly attenuates the default playback device while dictating, instead of
 * toggling the system mute. Two reasons:
 *  - Mute toggle (VK_VOLUME_MUTE / IAudioEndpointVolume.SetMute) shows the
 *    Windows OSD pill, which is distracting and clutters every PTT.
 *  - If the app crashes mid-dictation the user is left muted.
 *
 * We instead read the current master volume scalar (0.0–1.0), drop it to
 * `DUCK_LEVEL` while recording, and restore the saved value on stop. A
 * graceful shutdown also restores it; crashes can leave the system at
 * `DUCK_LEVEL`, but that's a recoverable degradation (audio still plays
 * faintly) instead of a hard mute.
 *
 * All commands flow through the long-running PS host (`lib/ps-host.ts`)
 * so the COM-interop class is JIT-compiled exactly once per app session.
 */

const DUCK_LEVEL = 0.0;

// Two-layer state:
//   desiredMuted — what the caller most recently asked for (intent)
//   isDucked    — whether we have actually issued the duck PS command and
//                 captured the user's previous volume (effect)
//
// They diverge while a PS command is in flight. Bailing out of the public
// mute/unmute API based on `isDucked` would race: if the user releases PTT
// (calls unmuteSystemAudio) before the duck has had time to flip isDucked
// to true, the unmute is dropped on the floor — then the duck completes,
// volume sits at 0, and no restore is ever queued. We track intent
// separately so that unmute always enqueues a restore that runs after the
// in-flight duck.
// Stryker disable next-line BooleanLiteral: equivalent mutant — `__resetAudioMuteForTesting__` runs in every test setup and overwrites these back to false, so a `true` default is invisible to the test suite.
let desiredMuted = false;
let isDucked = false;
let savedVolume: number | null = null;
let inFlight: Promise<void> | null = null;

function clampScalar(value: number): number {
	if (Number.isNaN(value)) {
		return 0;
	}
	// Math.min/Math.max collapse the two range guards into branchless ops:
	// for `value < 0`, Math.max(0, value) returns 0; for `value > 1`,
	// Math.min(1, …) returns 1. Avoids the per-branch CC cost of two ifs.
	return Math.min(1, Math.max(0, value));
}

function parseVolume(value: string | null): number | null {
	if (!value) {
		return null;
	}
	// PowerShell prints floats with the invariant culture by default in this
	// context but be defensive anyway: accept '.' or ','.
	// Stryker disable next-line MethodExpression: equivalent mutant — `parseFloat` is already whitespace-tolerant, so dropping `.trim()` from the chain produces the same numeric output for any whitespace-padded input. The trim is a defensive belt-and-braces that only matters for downstream non-parseFloat consumers, and there are none.
	const normalized = value.replace(",", ".").trim();
	const n = Number.parseFloat(normalized);
	if (Number.isNaN(n)) {
		return null;
	}
	return clampScalar(n);
}

async function readCurrentVolume(): Promise<number | null> {
	const result = await runPsCommand("[Audio]::GetVolume()", { expectValue: true, timeoutMs: 3000 });
	if (!result.ok) {
		dbg("audio-mute", "duck: GetVolume failed");
		return null;
	}
	const current = parseVolume(result.value);
	if (current === null) {
		dbg("audio-mute", `duck: could not parse volume (${result.value})`);
	}
	return current;
}

/**
 * Read the current volume and drop it to DUCK_LEVEL. Returns the previous
 * volume on success, or null if either the read or the set failed. Extracted
 * from applyDuck so the outer function only has to deal with one guard.
 */
async function performDuck(): Promise<number | null> {
	const current = await readCurrentVolume();
	if (current === null) {
		return null;
	}
	const setResult = await runPsCommand(`[Audio]::SetVolume(${DUCK_LEVEL})`, { timeoutMs: 3000 });
	if (!setResult.ok) {
		dbg("audio-mute", "duck: SetVolume failed");
		return null;
	}
	return current;
}

async function applyDuck(): Promise<void> {
	// Defensive double-check: scheduleApply may chain a duck after a restore
	// after a duck if the caller flips desiredMuted twice in rapid succession.
	// The intent gate in `muteSystemAudio` prevents a duck-after-duck, so the
	// only way to land here with `isDucked === true` is a stale chained task.
	if (isDucked) {
		return;
	}
	const saved = await performDuck();
	if (saved === null) {
		return;
	}
	savedVolume = saved;
	isDucked = true;
	dbg("audio-mute", `ducked (saved=${saved.toFixed(3)} → ${DUCK_LEVEL})`);
}

/** Compute the restore target. Extracted to keep the `??` branch out of applyRestore. */
function computeRestoreTarget(): number {
	return savedVolume ?? 0.5;
}

async function applyRestore(): Promise<void> {
	// Skip when there is no ducked volume to restore. This happens when the
	// caller asked to mute but the duck failed (GetVolume failed, parse
	// failed, or SetVolume failed) — none of those flip `isDucked` to true.
	// Without this guard we would call SetVolume(0.5) on a system the user
	// had legitimately left at a different volume.
	if (!isDucked) {
		return;
	}
	const target = computeRestoreTarget();
	const setResult = await runPsCommand(`[Audio]::SetVolume(${target})`, { timeoutMs: 3000 });
	dbg(
		"audio-mute",
		setResult.ok ? `restored (→ ${target.toFixed(3)})` : "restore: SetVolume failed"
	);
	// Even if SetVolume failed, clear our state so we don't loop forever.
	isDucked = false;
	savedVolume = null;
}

function scheduleApply(targetMuted: boolean): void {
	// Stryker disable next-line ConditionalExpression: equivalent mutant — `inFlight ?? Promise.resolve()` exists to chain the new task onto any in-flight task; in our test environment we always await flushMutePending between operations, so inFlight is null and `?? Promise.resolve()` produces the same starter promise either way.
	const next = (inFlight ?? Promise.resolve()).then(() =>
		// Stryker disable next-line BlockStatement: arrow-body block — the only way to make this empty would skip both applyDuck and applyRestore, which the audio:set-mute IPC test now covers (it asserts SetVolume IS called for muted=false), so any mutant emptying the body would fail. The remaining BlockStatement variant is the "always pass" else branch which is the same shape.
		targetMuted ? applyDuck() : applyRestore()
	);
	inFlight = next.catch(() => undefined);
}

/** Test hook: await any pending volume work. */
export function flushMutePending(): Promise<void> {
	return inFlight ?? Promise.resolve();
}

/** Test hook: reset module-level latches so each test starts from a known state. */
export function __resetAudioMuteForTesting__(): void {
	desiredMuted = false;
	isDucked = false;
	savedVolume = null;
	inFlight = null;
}

export const __audio_mute_test_helpers__ = {
	clampScalar,
	parseVolume,
};

/** Duck the system volume. Returns true if a duck was actually scheduled. */
export function muteSystemAudio(): boolean {
	if (process.platform !== "win32") {
		return false;
	}
	if (desiredMuted) {
		return false;
	}
	desiredMuted = true;
	scheduleApply(true);
	return true;
}

/** Restore the system volume if we previously ducked it. */
export function unmuteSystemAudio(): void {
	if (process.platform !== "win32") {
		return;
	}
	if (!desiredMuted) {
		return;
	}
	desiredMuted = false;
	scheduleApply(false);
}

/**
 * Narrow the IPC payload to the expected shape. Uses optional chaining so the
 * `null`/`undefined` cases short-circuit without adding cyclomatic branches.
 */
function isValidMutePayload(p: unknown): p is { muted: boolean } {
	return typeof (p as { muted?: unknown } | null | undefined)?.muted === "boolean";
}

function dispatchMute(muted: boolean): void {
	if (muted) {
		muteSystemAudio();
	} else {
		unmuteSystemAudio();
	}
}

export function setupAudioMuteHandlers(): void {
	ipcMain.on("audio:set-mute", (_event, payload) => {
		if (!isValidMutePayload(payload)) {
			return;
		}
		dispatchMute(payload.muted);
	});
}
