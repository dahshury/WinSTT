import { uIOhook } from "uiohook-napi";
import { dbg } from "../lib/debug-log";
import { parseAccelerator } from "../lib/keycodes";
import { store } from "../lib/store";
import { isPasteGuardActive } from "./hotkey";
import { isAnyHotkeyRecording } from "./recording-mode";
import { applyTransform } from "./transforms";

/**
 * Single uIOhook listener for the transforms hotkey. Unlike the old per-row
 * design (one combo per named transform), the transforms feature now has a
 * single composed prompt and a single global hotkey. uIOhook allows multiple
 * listeners; each fires independently on every keyboard event. We track the
 * global set of physically-pressed keys (synced with the OS via keydown/keyup)
 * and, on each keydown, fire when the registered combo is fully held.
 *
 * Single-shot semantics per hold: once the combo fires, it won't re-fire
 * until at least one of its keys is released — prevents auto-repeat from
 * firing the LLM call dozens of times per held press.
 */
interface ListenerHandle {
	dispose: () => void;
}

const pressed = new Set<number>();
let combo: Set<number> | null = null;
let firedThisHold = false;
let listenerInstalled = false;
let onKeyDown: ((event: { keycode: number }) => void) | null = null;
let onKeyUp: ((event: { keycode: number }) => void) | null = null;
let storeUnsubscribe: (() => void) | null = null;

function loadHotkey(): string {
	// Arm the combo ONLY while the transforms feature is enabled. The hotkey
	// string itself is always present (schema default Ctrl+Shift+T) so the
	// settings UI shows a combo, but a disabled feature must never capture the
	// global combo: Ctrl+Shift+T is a common shortcut (e.g. reopen-closed-tab),
	// and `applyTransform` would broadcast a "feature disabled" failure on every
	// press (see `requireEnabled` in transforms.ts). The `onDidChange("llm")`
	// subscription below rebuilds the combo when `enabled` flips, since this
	// result changes with it.
	if (store.get("llm.transforms.enabled") !== true) {
		return "";
	}
	return (store.get("llm.transforms.hotkey") ?? "").toString().trim();
}

function rebuildCombo(): void {
	const hotkey = loadHotkey();
	if (!hotkey) {
		combo = null;
		firedThisHold = false;
		dbg("transform-hotkeys", "no hotkey configured; combo cleared");
		return;
	}
	const parsed = parseAccelerator(hotkey);
	if (!parsed) {
		combo = null;
		firedThisHold = false;
		dbg("transform-hotkeys", `ignored unparseable hotkey "${hotkey}"`);
		return;
	}
	combo = parsed;
	firedThisHold = false;
	dbg("transform-hotkeys", `registered combo for hotkey "${hotkey}"`);
}

function isComboHeld(target: Set<number>): boolean {
	for (const code of target) {
		if (!pressed.has(code)) {
			return false;
		}
	}
	return true;
}

function isComboReady(target: Set<number> | null): target is Set<number> {
	return target !== null && !firedThisHold && isComboHeld(target);
}

function logApplyError(err: unknown): void {
	dbg("transform-hotkeys", `apply failed: ${err instanceof Error ? err.message : String(err)}`);
}

function maybeFireCombo(): void {
	if (!isComboReady(combo)) {
		return;
	}
	firedThisHold = true;
	applyTransform().catch(logApplyError);
}

function handleKeyDown(event: { keycode: number }): void {
	// Synthetic keystrokes from `winstt-paste.exe --type` flood this hook
	// at 2 events per character; skip the entire pipeline (Set mutation +
	// combo check) for the duration of the paste. The matching keyup is
	// also skipped, so the `pressed` set stays balanced.
	if (isPasteGuardActive()) {
		return;
	}
	pressed.add(event.keycode);
	// Same rationale as the TTS / re-paste listeners: while the user is
	// recording a NEW hotkey in the settings UI, the keystrokes they're
	// pressing must NOT also fire this listener's pipeline (which would run
	// the LLM transform on the active selection mid-recording).
	if (isAnyHotkeyRecording()) {
		return;
	}
	maybeFireCombo();
}

function shouldRearmCombo(target: Set<number> | null): target is Set<number> {
	return firedThisHold && target !== null && !isComboHeld(target);
}

function handleKeyUp(event: { keycode: number }): void {
	// See handleKeyDown — skip synthetic events from the paste binary so
	// the per-char flood doesn't churn the `pressed` set.
	if (isPasteGuardActive()) {
		return;
	}
	pressed.delete(event.keycode);
	// Clear the fired-flag once any combo key is released so a re-press
	// can re-fire. Without this guard, a user holding Ctrl+Shift+T forever
	// fires once but never re-arms.
	if (shouldRearmCombo(combo)) {
		firedThisHold = false;
	}
}

/**
 * Install the keyboard listener and start watching for the transforms combo.
 * Idempotent — second call is a no-op.
 *
 * The caller is responsible for calling the returned `dispose` on app exit.
 */
export function setupTransformHotkeys(): ListenerHandle {
	if (listenerInstalled) {
		return { dispose: cleanup };
	}
	listenerInstalled = true;

	rebuildCombo();
	onKeyDown = handleKeyDown;
	onKeyUp = handleKeyUp;
	uIOhook.on("keydown", onKeyDown);
	uIOhook.on("keyup", onKeyUp);

	// electron-store onDidChange fires whenever the persisted file changes.
	// The `settings:save` IPC handler rewrites every `llm.*` key on every
	// save (even transient ones triggered by VAD sensitivity adaptation
	// after each dictation), so a naive listener rebuilds the combo on
	// every PTT release. Gate on the hotkey string itself so identical
	// writes are a no-op.
	let lastHotkey = loadHotkey();
	storeUnsubscribe = store.onDidChange("llm", () => {
		const next = loadHotkey();
		if (next === lastHotkey) {
			return;
		}
		lastHotkey = next;
		rebuildCombo();
	});

	return { dispose: cleanup };
}

function detachKeyboardListeners(): void {
	if (onKeyDown) {
		uIOhook.off("keydown", onKeyDown);
	}
	if (onKeyUp) {
		uIOhook.off("keyup", onKeyUp);
	}
	onKeyDown = null;
	onKeyUp = null;
}

function detachStoreSubscription(): void {
	if (storeUnsubscribe) {
		storeUnsubscribe();
		storeUnsubscribe = null;
	}
}

function cleanup(): void {
	if (!listenerInstalled) {
		return;
	}
	listenerInstalled = false;
	detachKeyboardListeners();
	detachStoreSubscription();
	pressed.clear();
	combo = null;
	firedThisHold = false;
}

export const __transform_hotkeys_test_helpers__ = {
	rebuildCombo,
	maybeFireCombo,
	handleKeyDown,
	handleKeyUp,
	getCombo: () => (combo ? new Set(combo) : null),
	getPressed: () => new Set(pressed),
	getFired: () => firedThisHold,
	resetForTesting: cleanup,
};
