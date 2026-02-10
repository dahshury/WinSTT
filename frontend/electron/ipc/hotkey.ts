import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { UiohookKey, uIOhook } from "uiohook-napi";
import { dbg } from "../lib/debug-log";
import { codesToNames, KEYCODE_TO_NAME, parseAccelerator } from "../lib/keycodes";
import { playRecordingSound } from "../lib/sound";
import { store } from "../lib/store";

const MAX_COMBO_KEYS = 3;

let hotkeyStarted = false;

/**
 * When true, onKeyDown/onKeyUp skip all processing so that synthetic
 * keybd_event releases + re-presses from the paste script don't
 * trigger hotkey pressed/released or corrupt pressedKeys state.
 */
let pasteGuard = false;

export function setPasteGuard(active: boolean): void {
	pasteGuard = active;
}

export function setupHotkeyHandlers(win: BrowserWindow) {
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
			dbg("hotkey", `PRESSED — combo matched, mode=${mode}`);
			// Skip recording sound in listen mode — hotkey doesn't control recording
			if (mode !== "listen") {
				playRecordingSound();
			}
			safeSend("hotkey:pressed");
		}
	};

	const onKeyUp = (e: { keycode: number }) => {
		if (pasteGuard) {
			return;
		}
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

		// ── Normal hotkey detection ─────────────────────────────────
		pressedKeys.delete(code);

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
