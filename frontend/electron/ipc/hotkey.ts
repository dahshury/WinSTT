import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { UiohookKey, uIOhook } from "uiohook-napi";
import { dbg } from "../lib/debug-log";
import { playRecordingSound } from "../lib/sound";
import { store } from "../lib/store";

// ── Keycode → name mapping (used during recording) ─────────────────

const KEYCODE_TO_NAME: Record<number, string> = {
	// Left modifiers
	[UiohookKey.Ctrl]: "LCtrl",
	[UiohookKey.Alt]: "LAlt",
	[UiohookKey.Shift]: "LShift",
	[UiohookKey.Meta]: "LMeta",

	// Right modifiers
	[UiohookKey.CtrlRight]: "RCtrl",
	[UiohookKey.AltRight]: "RAlt",
	[UiohookKey.ShiftRight]: "RShift",
	[UiohookKey.MetaRight]: "RMeta",

	// Letters
	[UiohookKey.A]: "A",
	[UiohookKey.B]: "B",
	[UiohookKey.C]: "C",
	[UiohookKey.D]: "D",
	[UiohookKey.E]: "E",
	[UiohookKey.F]: "F",
	[UiohookKey.G]: "G",
	[UiohookKey.H]: "H",
	[UiohookKey.I]: "I",
	[UiohookKey.J]: "J",
	[UiohookKey.K]: "K",
	[UiohookKey.L]: "L",
	[UiohookKey.M]: "M",
	[UiohookKey.N]: "N",
	[UiohookKey.O]: "O",
	[UiohookKey.P]: "P",
	[UiohookKey.Q]: "Q",
	[UiohookKey.R]: "R",
	[UiohookKey.S]: "S",
	[UiohookKey.T]: "T",
	[UiohookKey.U]: "U",
	[UiohookKey.V]: "V",
	[UiohookKey.W]: "W",
	[UiohookKey.X]: "X",
	[UiohookKey.Y]: "Y",
	[UiohookKey.Z]: "Z",

	// Digits
	[UiohookKey[1]]: "1",
	[UiohookKey[2]]: "2",
	[UiohookKey[3]]: "3",
	[UiohookKey[4]]: "4",
	[UiohookKey[5]]: "5",
	[UiohookKey[6]]: "6",
	[UiohookKey[7]]: "7",
	[UiohookKey[8]]: "8",
	[UiohookKey[9]]: "9",
	[UiohookKey[0]]: "0",

	// Special keys
	[UiohookKey.Space]: "Space",
	[UiohookKey.Tab]: "Tab",
	[UiohookKey.Backspace]: "Backspace",
	[UiohookKey.Delete]: "Delete",
	[UiohookKey.Enter]: "Enter",
	[UiohookKey.Escape]: "Escape",
	[UiohookKey.CapsLock]: "CapsLock",
	[UiohookKey.Insert]: "Insert",
	[UiohookKey.Home]: "Home",
	[UiohookKey.End]: "End",
	[UiohookKey.PageUp]: "PageUp",
	[UiohookKey.PageDown]: "PageDown",

	// Function keys
	[UiohookKey.F1]: "F1",
	[UiohookKey.F2]: "F2",
	[UiohookKey.F3]: "F3",
	[UiohookKey.F4]: "F4",
	[UiohookKey.F5]: "F5",
	[UiohookKey.F6]: "F6",
	[UiohookKey.F7]: "F7",
	[UiohookKey.F8]: "F8",
	[UiohookKey.F9]: "F9",
	[UiohookKey.F10]: "F10",
	[UiohookKey.F11]: "F11",
	[UiohookKey.F12]: "F12",
	[UiohookKey.F13]: "F13",
	[UiohookKey.F14]: "F14",
	[UiohookKey.F15]: "F15",
	[UiohookKey.F16]: "F16",
	[UiohookKey.F17]: "F17",
	[UiohookKey.F18]: "F18",
	[UiohookKey.F19]: "F19",
	[UiohookKey.F20]: "F20",
	[UiohookKey.F21]: "F21",
	[UiohookKey.F22]: "F22",
	[UiohookKey.F23]: "F23",
	[UiohookKey.F24]: "F24",

	// Arrow keys
	[UiohookKey.ArrowUp]: "Up",
	[UiohookKey.ArrowDown]: "Down",
	[UiohookKey.ArrowLeft]: "Left",
	[UiohookKey.ArrowRight]: "Right",

	// Numpad
	[UiohookKey.Numpad0]: "Num0",
	[UiohookKey.Numpad1]: "Num1",
	[UiohookKey.Numpad2]: "Num2",
	[UiohookKey.Numpad3]: "Num3",
	[UiohookKey.Numpad4]: "Num4",
	[UiohookKey.Numpad5]: "Num5",
	[UiohookKey.Numpad6]: "Num6",
	[UiohookKey.Numpad7]: "Num7",
	[UiohookKey.Numpad8]: "Num8",
	[UiohookKey.Numpad9]: "Num9",

	// Punctuation / symbols
	[UiohookKey.Semicolon]: ";",
	[UiohookKey.Equal]: "=",
	[UiohookKey.Comma]: ",",
	[UiohookKey.Minus]: "-",
	[UiohookKey.Period]: ".",
	[UiohookKey.Slash]: "/",
	[UiohookKey.Backquote]: "`",
	[UiohookKey.BracketLeft]: "[",
	[UiohookKey.Backslash]: "\\",
	[UiohookKey.BracketRight]: "]",
	[UiohookKey.Quote]: "'",
};

// ── Name → keycode mapping (used for hotkey registration) ───────────

const NAME_TO_KEYCODE: Record<string, number> = {};
for (const [code, name] of Object.entries(KEYCODE_TO_NAME)) {
	NAME_TO_KEYCODE[name] = Number(code);
}

/**
 * Parse a compound accelerator like "LCtrl+LAlt+A" into a set of keycodes.
 * Returns null if any part is unrecognized.
 */
function parseAccelerator(accelerator: string): Set<number> | null {
	const parts = accelerator.split("+").map((s) => s.trim());
	const codes = new Set<number>();
	for (const part of parts) {
		const code =
			NAME_TO_KEYCODE[part] ??
			NAME_TO_KEYCODE[part.charAt(0).toUpperCase() + part.slice(1)] ??
			NAME_TO_KEYCODE[part.toUpperCase()];
		if (code == null) {
			return null;
		}
		codes.add(code);
	}
	return codes.size > 0 ? codes : null;
}

// ── Modifier sort order (for consistent combo display) ──────────────

const MODIFIER_ORDER: Record<number, number> = {
	[UiohookKey.Ctrl]: 0,
	[UiohookKey.CtrlRight]: 1,
	[UiohookKey.Alt]: 2,
	[UiohookKey.AltRight]: 3,
	[UiohookKey.Shift]: 4,
	[UiohookKey.ShiftRight]: 5,
	[UiohookKey.Meta]: 6,
	[UiohookKey.MetaRight]: 7,
};

function sortKeycodes(codes: number[]): number[] {
	return codes.sort((a, b) => {
		const oa = MODIFIER_ORDER[a] ?? 100;
		const ob = MODIFIER_ORDER[b] ?? 100;
		if (oa !== ob) {
			return oa - ob;
		}
		return a - b;
	});
}

const MAX_COMBO_KEYS = 3;

let hotkeyStarted = false;

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

	const codesToNames = (codes: number[]): string[] =>
		sortKeycodes(codes)
			.map((c) => KEYCODE_TO_NAME[c])
			.filter(Boolean) as string[];

	const onKeyDown = (e: { keycode: number }) => {
		const code = e.keycode;

		// ── Recording mode ──────────────────────────────────────────
		if (isRecording) {
			// Escape cancels recording
			if (code === UiohookKey.Escape) {
				isRecording = false;
				recordingPressed.clear();
				peakSnapshot = [];
				recordingSend("hotkey:recording-done", { combo: null });
				recordingSender = null;
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
			isRecording = false;
			recordingPressed.clear();
			peakSnapshot = [];
			recordingSend("hotkey:recording-done", { combo });
		} else {
			// No keys were captured — cancel
			isRecording = false;
			recordingPressed.clear();
			peakSnapshot = [];
			recordingSend("hotkey:recording-done", { combo: null });
		}
		recordingSender = null;
	});

	return () => {
		uIOhook.off("keydown", onKeyDown);
		uIOhook.off("keyup", onKeyUp);
		targetKeyCodes = null;
		pressedKeys.clear();
		isActive = false;
		isRecording = false;
		recordingPressed.clear();
		peakSnapshot = [];
		recordingSender = null;
		if (hotkeyStarted) {
			uIOhook.stop();
			hotkeyStarted = false;
		}
	};
}
