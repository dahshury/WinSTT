/**
 * Global TTS hotkey listener. When the configured combo fires, capture
 * the active selection in the focused window and dispatch a TTS
 * synthesis request through the same pipeline the renderer-side
 * "Speak selection" button uses.
 *
 * Mirrors the structure of ``transform-hotkeys.ts`` but for a single
 * combo (``tts.hotkey``) instead of a per-prompt list. Single-shot per
 * hold via ``firedThisHold`` to avoid OS auto-repeat firing dozens of
 * synthesis requests during one held press.
 */

import { randomUUID } from "node:crypto";
import { UiohookKey, uIOhook } from "uiohook-napi";
import { dbg } from "../lib/debug-log";
import { parseAccelerator } from "../lib/keycodes";
import { captureSelection } from "../lib/selection-capture";
import { store } from "../lib/store";
import type { SttClient } from "../ws/stt-client";
import { isPasteGuardActive } from "./hotkey";
import { triggerTtsCancelAll } from "./tts";

/** uiohook keycode for Backspace — the "stop reading" modifier on the combo. */
const BACKSPACE_KEYCODE = UiohookKey.Backspace;

interface ListenerHandle {
	dispose: () => void;
}

const pressed = new Set<number>();
let currentCombo: Set<number> | null = null;
let firedThisHold = false;
let listenerInstalled = false;
let onKeyDown: ((event: { keycode: number }) => void) | null = null;
let onKeyUp: ((event: { keycode: number }) => void) | null = null;
let storeUnsubscribe: (() => void) | null = null;
let activeClient: SttClient | null = null;

function loadHotkey(): string {
	const raw = store.get("tts.hotkey");
	return typeof raw === "string" ? raw.trim() : "";
}

function rebuildCombo(): void {
	const hotkey = loadHotkey();
	if (!hotkey) {
		currentCombo = null;
		firedThisHold = false;
		dbg("tts-hotkey", "no hotkey configured");
		return;
	}
	const parsed = parseAccelerator(hotkey);
	if (!parsed) {
		currentCombo = null;
		dbg("tts-hotkey", `ignored unparseable hotkey "${hotkey}"`);
		return;
	}
	currentCombo = parsed;
	firedThisHold = false;
	dbg("tts-hotkey", `armed hotkey "${hotkey}" (${parsed.size} keys)`);
}

function isComboHeld(combo: Set<number>): boolean {
	for (const code of combo) {
		if (!pressed.has(code)) {
			return false;
		}
	}
	return true;
}

function isTtsEnabled(): boolean {
	return store.get("tts.enabled") === true;
}

function dispatchSpeak(): void {
	if (!activeClient) {
		return;
	}
	const client = activeClient;
	const requestId = randomUUID();
	const voice = (store.get("tts.voice") as string) || "af_heart";
	const lang = (store.get("tts.lang") as string) || "en-us";
	const speedRaw = store.get("tts.speed");
	const speed = Math.max(0.5, Math.min(2.0, typeof speedRaw === "number" ? speedRaw : 1.0));

	captureSelection()
		.then((selection) => {
			if (!selection.text.trim()) {
				dbg("tts-hotkey", "no selection captured");
				return;
			}
			client.ttsSynthesize({
				requestId,
				text: selection.text,
				voice,
				lang,
				speed,
			});
		})
		.catch((err: unknown) => {
			dbg("tts-hotkey", `captureSelection failed: ${(err as Error).message}`);
		});
}

function maybeFire(): void {
	if (firedThisHold || !currentCombo || !isTtsEnabled()) {
		return;
	}
	if (!isComboHeld(currentCombo)) {
		return;
	}
	firedThisHold = true;
	dispatchSpeak();
}

/**
 * Stop gesture: the configured combo held together with Backspace cancels
 * any in-flight / buffered TTS playback. Returns true when it handled the
 * event so the caller skips the normal "start reading" path.
 *
 * Works whether or not a read was started this hold — it always cancels
 * (server-side cooperative cancel + an optimistic renderer-queue stop, so
 * already-buffered audio halts immediately, not just future generation).
 */
function maybeStop(): boolean {
	if (!(currentCombo && isTtsEnabled())) {
		return false;
	}
	if (!(isComboHeld(currentCombo) && pressed.has(BACKSPACE_KEYCODE))) {
		return false;
	}
	// Suppress any pending start for this hold so we don't read-then-stop.
	firedThisHold = true;
	triggerTtsCancelAll();
	dbg("tts-hotkey", "stop gesture (combo + Backspace) — cancelled TTS");
	return true;
}

function handleKeyDown(event: { keycode: number }): void {
	if (isPasteGuardActive()) {
		return;
	}
	pressed.add(event.keycode);
	if (maybeStop()) {
		return;
	}
	maybeFire();
}

function handleKeyUp(event: { keycode: number }): void {
	if (isPasteGuardActive()) {
		return;
	}
	pressed.delete(event.keycode);
	if (firedThisHold && currentCombo && !isComboHeld(currentCombo)) {
		firedThisHold = false;
	}
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

function cleanup(): void {
	detachKeyboardListeners();
	if (storeUnsubscribe) {
		storeUnsubscribe();
		storeUnsubscribe = null;
	}
	pressed.clear();
	currentCombo = null;
	firedThisHold = false;
	listenerInstalled = false;
	activeClient = null;
}

/**
 * Install the global hotkey listener for TTS. Idempotent.
 *
 * Pass the active ``SttClient`` so the listener can dispatch synthesis
 * requests directly without going through the renderer-IPC bounce.
 */
export function setupTtsHotkey(sttClient: SttClient): ListenerHandle {
	if (listenerInstalled) {
		return { dispose: cleanup };
	}
	listenerInstalled = true;
	activeClient = sttClient;

	rebuildCombo();
	onKeyDown = handleKeyDown;
	onKeyUp = handleKeyUp;
	uIOhook.on("keydown", onKeyDown);
	uIOhook.on("keyup", onKeyUp);

	let lastFingerprint = JSON.stringify({
		hotkey: store.get("tts.hotkey"),
		enabled: store.get("tts.enabled"),
	});
	storeUnsubscribe = store.onDidChange("tts", () => {
		const next = JSON.stringify({
			hotkey: store.get("tts.hotkey"),
			enabled: store.get("tts.enabled"),
		});
		if (next === lastFingerprint) {
			return;
		}
		lastFingerprint = next;
		rebuildCombo();
	});

	return { dispose: cleanup };
}
