import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { UiohookKey, uIOhook } from "uiohook-napi";
import { dbg } from "../lib/debug-log";
import { codesToNames, KEYCODE_TO_NAME, parseAccelerator } from "../lib/keycodes";
import { playRecordingSound } from "../lib/sound";
import { store } from "../lib/store";
import type { SttClient } from "../ws/stt-client";

const MAX_COMBO_KEYS = 3;

let hotkeyStarted = false;

/**
 * When true, onKeyDown/onKeyUp skip hotkey activation/deactivation logic
 * so that synthetic keybd_event releases from the paste script don't
 * trigger hotkey pressed/released.
 *
 * Key-up events still update pressedKeys so physical releases aren't lost.
 * When the guard is lifted, a deferred check fires the missed hotkey:released
 * if the combo keys were released during the guard window.
 */
let pasteGuard = false;
let onPasteGuardLifted: (() => void) | null = null;

export function setPasteGuard(active: boolean): void {
	pasteGuard = active;
	if (!active && onPasteGuardLifted) {
		onPasteGuardLifted();
		onPasteGuardLifted = null;
	}
}

export function setupHotkeyHandlers(win: BrowserWindow, sttClient: SttClient) {
	let targetKeyCodes: Set<number> | null = null;
	const pressedKeys = new Set<number>();
	let isActive = false;
	/** Prevents re-activation until ALL combo keys have been released. */
	let comboFullyReleased = true;

	// ── Recording state ─────────────────────────────────────────────
	let isRecording = false;
	const recordingPressed = new Set<number>();
	let peakSnapshot: number[] = [];
	/** The webContents that initiated recording (may be settings window, not main). */
	let recordingSender: Electron.WebContents | null = null;

	const checkCombo = (): boolean => {
		if (!targetKeyCodes) {
			return false;
		}
		for (const code of targetKeyCodes) {
			if (!pressedKeys.has(code)) {
				return false;
			}
		}
		return true;
	};

	const safeSend = (channel: string, ...args: unknown[]) => {
		if (!win.isDestroyed()) {
			win.webContents.send(channel, ...args);
		}
	};

	/** Send recording events to the window that started recording (settings or main). */
	const recordingSend = (channel: string, ...args: unknown[]) => {
		const target = recordingSender ?? win.webContents;
		if (!target.isDestroyed()) {
			target.send(channel, ...args);
		}
	};

	/** Clear all recording state back to idle. */
	const resetRecording = () => {
		isRecording = false;
		recordingPressed.clear();
		peakSnapshot = [];
		recordingSender = null;
	};

	const handleRecordingKeyDown = (code: number) => {
		// Escape cancels recording
		if (code === UiohookKey.Escape) {
			recordingSend("hotkey:recording-done", { combo: null });
			resetRecording();
			return;
		}

		recordingPressed.add(code);

		// Track the peak set of simultaneously pressed keys (up to max)
		if (recordingPressed.size > peakSnapshot.length && recordingPressed.size <= MAX_COMBO_KEYS) {
			peakSnapshot = [...recordingPressed];
		}

		// Send live preview
		recordingSend("hotkey:recording-update", {
			keys: codesToNames(peakSnapshot),
		});
	};

	/** Check if combo keys were released and fire hotkey:released if needed. */
	const checkDeferredRelease = () => {
		if (isActive && !checkCombo()) {
			isActive = false;
			dbg("hotkey", "RELEASED (deferred — key released during paste guard)");
			safeSend("hotkey:released");
		}
		if (!comboFullyReleased && targetKeyCodes) {
			const anyHeld = [...targetKeyCodes].some((c) => pressedKeys.has(c));
			if (!anyHeld) {
				comboFullyReleased = true;
			}
		}
	};

	const onKeyDown = (e: { keycode: number }) => {
		if (pasteGuard) {
			return;
		}
		const code = e.keycode;

		if (isRecording) {
			handleRecordingKeyDown(code);
			return;
		}

		// ── Normal hotkey detection ─────────────────────────────────
		pressedKeys.add(code);

		// Log when a combo key is pressed (diagnose whether uiohook sees it)
		if (targetKeyCodes?.has(code)) {
			const name = KEYCODE_TO_NAME[code] ?? `?${code}`;
			const held = [...pressedKeys].map((c) => KEYCODE_TO_NAME[c] ?? `?${c}`).join("+");
			const need = [...(targetKeyCodes ?? [])].map((c) => KEYCODE_TO_NAME[c] ?? `?${c}`).join("+");
			dbg("hotkey", `combo-key DOWN: ${name} | held=[${held}] need=[${need}] isActive=${isActive}`);
		}

		if (!isActive && comboFullyReleased && checkCombo()) {
			isActive = true;
			comboFullyReleased = false;
			const mode = store.get("general.recordingMode") as string;
			dbg("hotkey", `PRESSED — combo matched, mode=${mode}, connected=${sttClient.isConnected}`);
			// Skip recording sound in listen mode and when server is offline
			if (mode !== "listen" && sttClient.isConnected) {
				playRecordingSound();
			}
			safeSend("hotkey:pressed");
		}
	};

	const onKeyUp = (e: { keycode: number }) => {
		const code = e.keycode;

		// ── Recording mode ──────────────────────────────────────────
		if (isRecording) {
			recordingPressed.delete(code);

			// Send live update (shows currently held keys, peak preserved)
			recordingSend("hotkey:recording-update", {
				keys: codesToNames(peakSnapshot),
			});
			// Do NOT auto-finalize — wait for explicit stop from renderer
			return;
		}

		// Always track physical key releases, even during paste guard.
		// Synthetic keybd_event releases from the paste script target
		// specific VK codes (0xA0–0xA5, 0x5B–0x5C) that rarely overlap
		// with the hotkey combo, but real releases MUST be tracked so
		// we can fire the deferred hotkey:released when the guard lifts.
		pressedKeys.delete(code);

		if (pasteGuard) {
			// Schedule a deferred check — when the guard lifts,
			// setPasteGuard(false) will call checkDeferredRelease().
			onPasteGuardLifted = checkDeferredRelease;
			return;
		}

		// ── Normal hotkey detection ─────────────────────────────────
		if (isActive && !checkCombo()) {
			isActive = false;
			dbg("hotkey", "RELEASED");
			safeSend("hotkey:released");
		}

		// Allow next activation only after ALL combo keys are released
		if (!comboFullyReleased && targetKeyCodes) {
			const anyHeld = [...targetKeyCodes].some((c) => pressedKeys.has(c));
			if (!anyHeld) {
				comboFullyReleased = true;
			}
		}
	};

	uIOhook.on("keydown", onKeyDown);
	uIOhook.on("keyup", onKeyUp);

	if (!hotkeyStarted) {
		uIOhook.start();
		hotkeyStarted = true;
	}

	ipcMain.handle("hotkey:register", (_event, { accelerator }: { accelerator: string }) => {
		const codes = parseAccelerator(accelerator);
		if (!codes) {
			dbg("hotkey", `Register FAILED — unknown accelerator: "${accelerator}"`);
			return false;
		}
		targetKeyCodes = codes;
		pressedKeys.clear();
		isActive = false;
		comboFullyReleased = true;
		dbg("hotkey", `Registered: "${accelerator}" → keycodes:`, JSON.stringify([...codes]));
		return true;
	});

	ipcMain.on("hotkey:unregister", () => {
		targetKeyCodes = null;
		pressedKeys.clear();
		isActive = false;
		comboFullyReleased = true;
	});

	ipcMain.handle("hotkey:start-recording", (event) => {
		isRecording = true;
		recordingPressed.clear();
		peakSnapshot = [];
		recordingSender = event.sender;
		// Temporarily disable hotkey detection while recording
		pressedKeys.clear();
		isActive = false;
		return true;
	});

	ipcMain.on("hotkey:stop-recording", () => {
		if (isRecording && peakSnapshot.length > 0) {
			const names = codesToNames(peakSnapshot);
			const combo = names.join("+");
			recordingSend("hotkey:recording-done", { combo });
		} else {
			// No keys were captured — cancel
			recordingSend("hotkey:recording-done", { combo: null });
		}
		resetRecording();
	});

	return () => {
		uIOhook.off("keydown", onKeyDown);
		uIOhook.off("keyup", onKeyUp);
		targetKeyCodes = null;
		pressedKeys.clear();
		isActive = false;
		resetRecording();
		if (hotkeyStarted) {
			uIOhook.stop();
			hotkeyStarted = false;
		}
	};
}
