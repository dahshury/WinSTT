import { uIOhook } from "uiohook-napi";
import { dbg } from "../lib/debug-log";
import { parseAccelerator } from "../lib/keycodes";
import { store } from "../lib/store";
import { applyTransform } from "./transforms";

interface RegisteredCombo {
	combo: Set<number>;
	transformId: string;
}

/**
 * Active uIOhook listener for transform hotkeys, separate from the PTT
 * listener in hotkey.ts. uIOhook allows multiple listeners; each fires
 * independently on every keyboard event. We track the global set of
 * physically-pressed keys (synced with the OS via keydown/keyup) and,
 * on each keydown, fire any transform whose combo is now fully held.
 *
 * Single-shot semantics per hold: once a combo fires, it won't re-fire
 * until at least one of its keys is released — prevents auto-repeat
 * from firing the LLM call dozens of times per held press.
 */
interface ListenerHandle {
	dispose: () => void;
}

const pressed = new Set<number>();
let combos: RegisteredCombo[] = [];
const firedThisHold = new Set<string>();
let listenerInstalled = false;
let onKeyDown: ((event: { keycode: number }) => void) | null = null;
let onKeyUp: ((event: { keycode: number }) => void) | null = null;
let storeUnsubscribe: (() => void) | null = null;

interface RawTransform {
	hotkey: string;
	id: string;
}

function loadRawTransforms(): RawTransform[] {
	return (store.get("llm.transforms") ?? []) as RawTransform[];
}

/**
 * Parse a (non-empty) hotkey string into a key set, logging when the
 * accelerator can't be parsed. Returns `null` on failure. Pulled out of
 * `tryRegisterTransform` so the latter stays at CC ≤ 3.
 */
function parseHotkeyOrLog(hotkey: string, transformId: string): Set<number> | null {
	const combo = parseAccelerator(hotkey);
	if (combo) {
		return combo;
	}
	dbg("transform-hotkeys", `ignored unparseable hotkey "${hotkey}" for ${transformId}`);
	return null;
}

/**
 * Resolve a single raw transform entry to a registered combo, or `null` when
 * the hotkey is blank or unparseable. Extracted from `rebuildCombos` to keep
 * that function's cyclomatic complexity inside the CRAP-≤-4 budget.
 */
function normalizeHotkey(raw: string | undefined): string {
	return (raw ?? "").trim();
}

function tryRegisterTransform(entry: RawTransform): RegisteredCombo | null {
	const hotkey = normalizeHotkey(entry.hotkey);
	if (!hotkey) {
		return null;
	}
	const combo = parseHotkeyOrLog(hotkey, entry.id);
	return combo ? { transformId: entry.id, combo } : null;
}

function rebuildCombos(): void {
	const next: RegisteredCombo[] = [];
	for (const entry of loadRawTransforms()) {
		const registered = tryRegisterTransform(entry);
		if (registered) {
			next.push(registered);
		}
	}
	combos = next;
	firedThisHold.clear();
	dbg("transform-hotkeys", `rebuilt ${combos.length} transform combos`);
}

function isComboHeld(combo: Set<number>): boolean {
	for (const code of combo) {
		if (!pressed.has(code)) {
			return false;
		}
	}
	return true;
}

/**
 * True when `entry` is freshly held: combo fully pressed and not already fired
 * within this hold. Pulled out of `maybeFireCombos` so the orchestrator's
 * cyclomatic complexity stays at CC ≤ 3.
 */
function isComboReadyToFire(entry: RegisteredCombo): boolean {
	return !firedThisHold.has(entry.transformId) && isComboHeld(entry.combo);
}

function maybeFireCombos(): void {
	for (const entry of combos.filter(isComboReadyToFire)) {
		const { transformId } = entry;
		firedThisHold.add(transformId);
		applyTransform(transformId).catch((err: unknown) => {
			dbg(
				"transform-hotkeys",
				`apply(${transformId}) failed: ${err instanceof Error ? err.message : String(err)}`
			);
		});
	}
}

function handleKeyDown(event: { keycode: number }): void {
	pressed.add(event.keycode);
	maybeFireCombos();
}

/**
 * True when this combo previously fired but is no longer fully held — i.e.
 * the fired-flag is stale and must be cleared so re-press can re-fire.
 * Pulled out of `handleKeyUp` so the orchestrator stays at CC ≤ 3.
 */
function isFiredFlagStale(entry: RegisteredCombo): boolean {
	return firedThisHold.has(entry.transformId) && !isComboHeld(entry.combo);
}

function handleKeyUp(event: { keycode: number }): void {
	pressed.delete(event.keycode);
	// Clear any fired-flag whose combo is no longer fully held — once the
	// user releases part of the combo, allow re-fire on next full press.
	for (const entry of combos.filter(isFiredFlagStale)) {
		firedThisHold.delete(entry.transformId);
	}
}

/**
 * Install the keyboard listener and start listening for transform combos.
 * Idempotent — second call is a no-op.
 *
 * The caller is responsible for calling the returned `dispose` on app exit.
 */
export function setupTransformHotkeys(): ListenerHandle {
	if (listenerInstalled) {
		return { dispose: cleanup };
	}
	listenerInstalled = true;

	rebuildCombos();
	onKeyDown = handleKeyDown;
	onKeyUp = handleKeyUp;
	uIOhook.on("keydown", onKeyDown);
	uIOhook.on("keyup", onKeyUp);

	// electron-store onDidChange fires whenever the persisted file changes.
	// `unknown` reaches us as `unknown` (electron-store v11 stops typing
	// arbitrary key paths), so we just rebuild on any change to llm.transforms.
	storeUnsubscribe = store.onDidChange("llm", () => {
		rebuildCombos();
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
	combos = [];
	firedThisHold.clear();
}

export const __transform_hotkeys_test_helpers__ = {
	rebuildCombos,
	maybeFireCombos,
	handleKeyDown,
	handleKeyUp,
	getCombos: () => combos.slice(),
	getPressed: () => new Set(pressed),
	getFired: () => new Set(firedThisHold),
	resetForTesting: cleanup,
};
