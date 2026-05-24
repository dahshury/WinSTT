import { uIOhook } from "uiohook-napi";
import { dbg } from "../lib/debug-log";
import { parseAccelerator } from "../lib/keycodes";
import { store } from "../lib/store";
import { isPasteGuardActive } from "./hotkey";
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

function maybeFireCombo(): void {
	if (!combo || firedThisHold || !isComboHeld(combo)) {
		return;
	}
	firedThisHold = true;
	applyTransform().catch((err: unknown) => {
		dbg("transform-hotkeys", `apply failed: ${err instanceof Error ? err.message : String(err)}`);
	});
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
	maybeFireCombo();
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
	if (firedThisHold && combo && !isComboHeld(combo)) {
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
