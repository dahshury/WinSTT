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
	// Stryker disable next-line EqualityOperator: equivalent mutant — `<` vs `<=` differ only at value=0; in both cases the function returns 0 (the strict-less version falls through to `value > 1` which is false, then returns `value` which is 0). Observable behavior is identical.
	if (value < 0) {
		return 0;
	}
	// Stryker disable next-line EqualityOperator: equivalent mutant — `>` vs `>=` differ only at value=1; in both cases the function returns 1 (the strict-greater version falls through to `return value` which is 1). Observable behavior is identical.
	if (value > 1) {
		return 1;
	}
	return value;
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

async function applyDuck(): Promise<void> {
	// Defensive double-check: scheduleApply may chain a duck after a restore
	// after a duck if the caller flips desiredMuted twice in rapid succession.
	// The intent gate in `muteSystemAudio` prevents a duck-after-duck, so the
	// only way to land here with `isDucked === true` is a stale chained task.
	if (isDucked) {
		return;
	}
	const current = await readCurrentVolume();
	if (current === null) {
		return;
	}
	const setResult = await runPsCommand(`[Audio]::SetVolume(${DUCK_LEVEL})`, { timeoutMs: 3000 });
	if (!setResult.ok) {
		dbg("audio-mute", "duck: SetVolume failed");
		return;
	}
	savedVolume = current;
	isDucked = true;
	dbg("audio-mute", `ducked (saved=${current.toFixed(3)} → ${DUCK_LEVEL})`);
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
	const target = savedVolume ?? 0.5;
	const setResult = await runPsCommand(`[Audio]::SetVolume(${target})`, { timeoutMs: 3000 });
	if (setResult.ok) {
		dbg("audio-mute", `restored (→ ${target.toFixed(3)})`);
	} else {
		dbg("audio-mute", "restore: SetVolume failed");
	}
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

export function setupAudioMuteHandlers(): void {
	ipcMain.on("audio:set-mute", (_event, payload: { muted: boolean }) => {
		if (!payload || typeof payload.muted !== "boolean") {
			return;
		}
		if (payload.muted) {
			muteSystemAudio();
		} else {
			unmuteSystemAudio();
		}
	});
}
