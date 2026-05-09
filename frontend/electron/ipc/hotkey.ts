import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { UiohookKey, uIOhook } from "uiohook-napi";
import { dbg, dbgVerbose } from "../lib/debug-log";
import { createSafeSender } from "../lib/ipc-helpers";
import { codesToNames, KEYCODE_TO_NAME, parseAccelerator } from "../lib/keycodes";
import { playRecordingSound } from "../lib/sound";
import { getStoreValue } from "../lib/store";
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

export function setupHotkeyHandlers(win: BrowserWindow, sttClient: SttClient): () => void {
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

	const safeSend = createSafeSender(win);

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

	const updatePeakSnapshot = () => {
		if (recordingPressed.size > peakSnapshot.length && recordingPressed.size <= MAX_COMBO_KEYS) {
			peakSnapshot = [...recordingPressed];
		}
	};

	const handleRecordingKeyDown = (code: number) => {
		// Escape cancels recording
		if (code === UiohookKey.Escape) {
			recordingSend("hotkey:recording-done", { combo: null });
			resetRecording();
			return;
		}

		recordingPressed.add(code);
		updatePeakSnapshot();
		recordingSend("hotkey:recording-update", {
			keys: codesToNames(peakSnapshot),
		});
	};

	const allComboKeysReleased = (codes: Set<number>): boolean => {
		for (const c of codes) {
			if (pressedKeys.has(c)) {
				return false;
			}
		}
		return true;
	};

	const canMarkComboFullyReleased = (): boolean => {
		if (comboFullyReleased) {
			return false;
		}
		if (!targetKeyCodes) {
			return false;
		}
		return allComboKeysReleased(targetKeyCodes);
	};

	const updateComboReleaseState = () => {
		if (canMarkComboFullyReleased()) {
			comboFullyReleased = true;
		}
	};

	const fireDeferredReleaseIfNeeded = () => {
		if (!isActive || checkCombo()) {
			return;
		}
		isActive = false;
		dbg("hotkey", "RELEASED (deferred — key released during paste guard)");
		safeSend("hotkey:released");
	};

	/** Check if combo keys were released and fire hotkey:released if needed. */
	const checkDeferredRelease = () => {
		fireDeferredReleaseIfNeeded();
		updateComboReleaseState();
	};

	const logComboKeyDown = (code: number) => {
		if (!targetKeyCodes?.has(code)) {
			return;
		}
		const name = KEYCODE_TO_NAME[code] ?? `?${code}`;
		const held = [...pressedKeys].map((c) => KEYCODE_TO_NAME[c] ?? `?${c}`).join("+");
		const need = [...targetKeyCodes].map((c) => KEYCODE_TO_NAME[c] ?? `?${c}`).join("+");
		dbgVerbose(
			"hotkey",
			`combo-key DOWN: ${name} | held=[${held}] need=[${need}] isActive=${isActive}`
		);
	};

	const shouldPlayRecordingSound = (mode: unknown): boolean =>
		mode !== "listen" && sttClient.isConnected;

	const canActivateCombo = (): boolean => !isActive && comboFullyReleased && checkCombo();

	const tryActivateCombo = () => {
		if (!canActivateCombo()) {
			return;
		}
		isActive = true;
		comboFullyReleased = false;
		const mode = getStoreValue("general.recordingMode");
		dbg("hotkey", `PRESSED — combo matched, mode=${mode}, connected=${sttClient.isConnected}`);
		if (shouldPlayRecordingSound(mode)) {
			playRecordingSound();
		}
		safeSend("hotkey:pressed");
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
		logComboKeyDown(code);
		tryActivateCombo();
	};

	const handleRecordingKeyUp = (code: number) => {
		recordingPressed.delete(code);
		// Send live update (shows currently held keys, peak preserved)
		recordingSend("hotkey:recording-update", {
			keys: codesToNames(peakSnapshot),
		});
		// Do NOT auto-finalize — wait for explicit stop from renderer
	};

	const releaseHotkeyIfNeeded = () => {
		if (!isActive || checkCombo()) {
			return;
		}
		isActive = false;
		dbg("hotkey", "RELEASED");
		safeSend("hotkey:released");
	};

	const onKeyUp = (e: { keycode: number }) => {
		const code = e.keycode;
		if (isRecording) {
			handleRecordingKeyUp(code);
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
		releaseHotkeyIfNeeded();
		updateComboReleaseState();
	};

	uIOhook.on("keydown", onKeyDown);
	uIOhook.on("keyup", onKeyUp);

	if (!hotkeyStarted) {
		uIOhook.start();
		hotkeyStarted = true;
	}

	const extractAcceleratorString = (acc: unknown): string | null =>
		typeof acc === "string" && acc !== "" ? acc : null;

	const extractAccelerator = (p: unknown): string | null => {
		if (!p || typeof p !== "object") {
			return null;
		}
		return extractAcceleratorString((p as { accelerator?: unknown }).accelerator);
	};

	const handleRegister = (
		_event: Electron.IpcMainInvokeEvent,
		payload: { accelerator: string }
	) => {
		const accelerator = extractAccelerator(payload);
		if (!accelerator) {
			dbg("hotkey", "Register FAILED — invalid payload");
			return false;
		}
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
	};

	const handleUnregister = () => {
		targetKeyCodes = null;
		pressedKeys.clear();
		isActive = false;
		comboFullyReleased = true;
	};

	const handleStartRecording = (event: Electron.IpcMainInvokeEvent) => {
		isRecording = true;
		recordingPressed.clear();
		peakSnapshot = [];
		recordingSender = event.sender;
		// Temporarily disable hotkey detection while recording
		pressedKeys.clear();
		isActive = false;
		return true;
	};

	const handleStopRecording = () => {
		if (isRecording && peakSnapshot.length > 0) {
			const names = codesToNames(peakSnapshot);
			const combo = names.join("+");
			recordingSend("hotkey:recording-done", { combo });
		} else {
			// No keys were captured — cancel
			recordingSend("hotkey:recording-done", { combo: null });
		}
		resetRecording();
	};

	ipcMain.removeHandler("hotkey:register");
	ipcMain.removeHandler("hotkey:start-recording");
	ipcMain.removeAllListeners("hotkey:unregister");
	ipcMain.removeAllListeners("hotkey:stop-recording");
	ipcMain.on("hotkey:unregister", handleUnregister);
	ipcMain.on("hotkey:stop-recording", handleStopRecording);
	ipcMain.handle("hotkey:register", handleRegister);
	ipcMain.handle("hotkey:start-recording", handleStartRecording);

	return () => {
		uIOhook.off("keydown", onKeyDown);
		uIOhook.off("keyup", onKeyUp);
		ipcMain.removeHandler("hotkey:register");
		ipcMain.removeHandler("hotkey:start-recording");
		ipcMain.off("hotkey:unregister", handleUnregister);
		ipcMain.off("hotkey:stop-recording", handleStopRecording);
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
