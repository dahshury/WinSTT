/**
 * Exclusive global "re-paste last transcription" shortcut.
 *
 * Unlike the PTT / TTS / transform hotkeys (passive uiohook listeners that
 * only OBSERVE keys), this one is registered through Electron's
 * `globalShortcut`, which SWALLOWS the accelerator system-wide. That is
 * deliberate: pressing the combo must ONLY re-inject WinSTT's last
 * transcription — it must not also trigger the focused app's native binding
 * for the same combo (e.g. Ctrl+Shift+V = paste-without-formatting / terminal
 * paste), which would double-paste. The trade-off (the combo loses its native
 * meaning everywhere while WinSTT runs) is the point of "exclusive" and is why
 * the binding is user-rebindable / clearable in Settings.
 *
 * The combo is persisted in the same uiohook-style accelerator format the
 * HotkeyRecorder produces (`LCtrl+LShift+V`); it's converted to an Electron
 * accelerator at registration. An empty / unconvertible value simply leaves
 * the shortcut unregistered (feature off) instead of throwing.
 *
 * Re-paste reuses `pasteText` so it inherits the same delivery path as
 * dictation auto-paste: per-character typing (clipboard untouched), the
 * paste-guard / pacing / circuit-breaker, and the clipboard fallback.
 */

import { globalShortcut } from "electron";
import { dbg } from "../lib/debug-log";
import { uiohookAcceleratorToElectron } from "../lib/keycodes";
import { getLastTranscription } from "../lib/last-transcription";
import { pasteText } from "../lib/paste";
import { store } from "../lib/store";

interface ListenerHandle {
	dispose: () => void;
}

let listenerInstalled = false;
/** The Electron accelerator currently registered, or null when none. */
let registeredAccelerator: string | null = null;
let storeUnsubscribe: (() => void) | null = null;

function loadHotkey(): string {
	const raw = store.get("general.repasteHotkey");
	return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Re-paste handler. Mirrors dictation auto-paste exactly (trailing space) so
 * a re-paste is indistinguishable from the original. A no-op when nothing has
 * been dictated yet — we never paste a stale empty string.
 */
function handleTrigger(): void {
	const text = getLastTranscription();
	if (text.trim() === "") {
		dbg("repaste-hotkey", "triggered but no transcription recorded yet — ignoring");
		return;
	}
	dbg("repaste-hotkey", `re-pasting last transcription (${text.length} chars)`);
	pasteText(`${text} `);
}

/** Unregister whatever accelerator is currently held (idempotent). */
function unregisterCurrent(): void {
	if (registeredAccelerator === null) {
		return;
	}
	try {
		globalShortcut.unregister(registeredAccelerator);
	} catch (err) {
		dbg("repaste-hotkey", `unregister threw: ${(err as Error).message}`);
	}
	registeredAccelerator = null;
}

/**
 * Reconcile the registered shortcut with the persisted setting. Always clears
 * the previous registration first so a rebind doesn't leave the old combo
 * hijacked. Tolerates an empty/unconvertible setting (feature off) and a
 * failed `register` (combo already owned by the OS / another app).
 */
function rebuild(): void {
	unregisterCurrent();
	const hotkey = loadHotkey();
	if (hotkey === "") {
		dbg("repaste-hotkey", "no hotkey configured — re-paste shortcut disabled");
		return;
	}
	const accelerator = uiohookAcceleratorToElectron(hotkey);
	if (accelerator === null) {
		dbg("repaste-hotkey", `"${hotkey}" is not a valid Electron accelerator — not registered`);
		return;
	}
	let ok = false;
	try {
		ok = globalShortcut.register(accelerator, handleTrigger);
	} catch (err) {
		dbg("repaste-hotkey", `register threw for "${accelerator}": ${(err as Error).message}`);
		return;
	}
	if (!ok) {
		dbg(
			"repaste-hotkey",
			`register failed for "${accelerator}" — combo likely owned by the OS or another app`
		);
		return;
	}
	registeredAccelerator = accelerator;
	dbg("repaste-hotkey", `armed exclusive re-paste shortcut "${hotkey}" → "${accelerator}"`);
}

function cleanup(): void {
	unregisterCurrent();
	if (storeUnsubscribe) {
		storeUnsubscribe();
		storeUnsubscribe = null;
	}
	listenerInstalled = false;
}

/**
 * Install the exclusive re-paste global shortcut. Idempotent; returns a
 * handle whose `dispose` unregisters the accelerator and unsubscribes.
 */
export function setupRepasteHotkey(): ListenerHandle {
	if (listenerInstalled) {
		return { dispose: cleanup };
	}
	listenerInstalled = true;

	rebuild();

	let lastFingerprint = loadHotkey();
	storeUnsubscribe = store.onDidChange("general", () => {
		const next = loadHotkey();
		if (next === lastFingerprint) {
			return;
		}
		lastFingerprint = next;
		rebuild();
	});

	return { dispose: cleanup };
}
