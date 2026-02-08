import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { UiohookKey, uIOhook } from "uiohook-napi";

/**
 * Map Electron accelerator key names to uiohook key codes.
 * Supports both single-key and compound accelerators (e.g. "Control+Alt+A").
 */
const ACCELERATOR_TO_KEYCODE: Record<string, number> = {
	// Letters
	A: UiohookKey.A,
	B: UiohookKey.B,
	C: UiohookKey.C,
	D: UiohookKey.D,
	E: UiohookKey.E,
	F: UiohookKey.F,
	G: UiohookKey.G,
	H: UiohookKey.H,
	I: UiohookKey.I,
	J: UiohookKey.J,
	K: UiohookKey.K,
	L: UiohookKey.L,
	M: UiohookKey.M,
	N: UiohookKey.N,
	O: UiohookKey.O,
	P: UiohookKey.P,
	Q: UiohookKey.Q,
	R: UiohookKey.R,
	S: UiohookKey.S,
	T: UiohookKey.T,
	U: UiohookKey.U,
	V: UiohookKey.V,
	W: UiohookKey.W,
	X: UiohookKey.X,
	Y: UiohookKey.Y,
	Z: UiohookKey.Z,

	// Special keys
	Space: UiohookKey.Space,
	Tab: UiohookKey.Tab,
	Backspace: UiohookKey.Backspace,
	Delete: UiohookKey.Delete,
	Enter: UiohookKey.Enter,
	Return: UiohookKey.Enter,
	Escape: UiohookKey.Escape,
	Esc: UiohookKey.Escape,
	CapsLock: UiohookKey.CapsLock,
	Insert: UiohookKey.Insert,
	Home: UiohookKey.Home,
	End: UiohookKey.End,
	PageUp: UiohookKey.PageUp,
	PageDown: UiohookKey.PageDown,

	// Function keys
	F1: UiohookKey.F1,
	F2: UiohookKey.F2,
	F3: UiohookKey.F3,
	F4: UiohookKey.F4,
	F5: UiohookKey.F5,
	F6: UiohookKey.F6,
	F7: UiohookKey.F7,
	F8: UiohookKey.F8,
	F9: UiohookKey.F9,
	F10: UiohookKey.F10,
	F11: UiohookKey.F11,
	F12: UiohookKey.F12,
	F13: UiohookKey.F13,
	F14: UiohookKey.F14,
	F15: UiohookKey.F15,
	F16: UiohookKey.F16,
	F17: UiohookKey.F17,
	F18: UiohookKey.F18,
	F19: UiohookKey.F19,
	F20: UiohookKey.F20,
	F21: UiohookKey.F21,
	F22: UiohookKey.F22,
	F23: UiohookKey.F23,
	F24: UiohookKey.F24,

	// Arrow keys
	Up: UiohookKey.ArrowUp,
	Down: UiohookKey.ArrowDown,
	Left: UiohookKey.ArrowLeft,
	Right: UiohookKey.ArrowRight,

	// Modifier keys (usable as standalone PTT keys)
	Ctrl: UiohookKey.Ctrl,
	Control: UiohookKey.Ctrl,
	Alt: UiohookKey.Alt,
	Shift: UiohookKey.Shift,
	Meta: UiohookKey.Meta,
	Super: UiohookKey.Meta,

	// Numpad
	num0: UiohookKey.Numpad0,
	num1: UiohookKey.Numpad1,
	num2: UiohookKey.Numpad2,
	num3: UiohookKey.Numpad3,
	num4: UiohookKey.Numpad4,
	num5: UiohookKey.Numpad5,
	num6: UiohookKey.Numpad6,
	num7: UiohookKey.Numpad7,
	num8: UiohookKey.Numpad8,
	num9: UiohookKey.Numpad9,
};

/** uiohook emits separate codes for left/right modifiers; normalize both to the generic code */
const MODIFIER_NORMALIZE: Record<number, number> = {
	[UiohookKey.CtrlRight]: UiohookKey.Ctrl,
	[UiohookKey.AltRight]: UiohookKey.Alt,
	[UiohookKey.ShiftRight]: UiohookKey.Shift,
	[UiohookKey.MetaRight]: UiohookKey.Meta,
};

function normalizeKeycode(keycode: number): number {
	return MODIFIER_NORMALIZE[keycode] ?? keycode;
}

/**
 * Parse a compound accelerator like "Control+Alt+A" into a set of keycodes.
 * Returns null if any part is unrecognized.
 */
function parseAccelerator(accelerator: string): Set<number> | null {
	const parts = accelerator.split("+").map((s) => s.trim());
	const codes = new Set<number>();
	for (const part of parts) {
		// Try exact match, then capitalized (e.g. "a" → "A", "control" → "Control")
		const normalized = part.charAt(0).toUpperCase() + part.slice(1);
		const code = ACCELERATOR_TO_KEYCODE[part] ?? ACCELERATOR_TO_KEYCODE[normalized] ?? ACCELERATOR_TO_KEYCODE[part.toUpperCase()];
		if (code == null) {
			return null;
		}
		codes.add(code);
	}
	return codes.size > 0 ? codes : null;
}

let hotkeyStarted = false;

export function setupHotkeyHandlers(win: BrowserWindow) {
	let targetKeyCodes: Set<number> | null = null;
	const pressedKeys = new Set<number>();
	let isActive = false;

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

	const onKeyDown = (e: { keycode: number }) => {
		const code = normalizeKeycode(e.keycode);
		pressedKeys.add(code);

		if (!isActive && checkCombo()) {
			isActive = true;
			if (!win.isDestroyed()) {
				win.webContents.send("hotkey:pressed");
			}
		}
	};

	const onKeyUp = (e: { keycode: number }) => {
		const code = normalizeKeycode(e.keycode);
		pressedKeys.delete(code);

		if (isActive && !checkCombo()) {
			isActive = false;
			if (!win.isDestroyed()) {
				win.webContents.send("hotkey:released");
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
			console.warn(`[hotkey] Unknown accelerator: "${accelerator}"`);
			return false;
		}
		targetKeyCodes = codes;
		pressedKeys.clear();
		isActive = false;
		return true;
	});

	ipcMain.on("hotkey:unregister", () => {
		targetKeyCodes = null;
		pressedKeys.clear();
		isActive = false;
	});

	return () => {
		uIOhook.off("keydown", onKeyDown);
		uIOhook.off("keyup", onKeyUp);
		targetKeyCodes = null;
		pressedKeys.clear();
		isActive = false;
		if (hotkeyStarted) {
			uIOhook.stop();
			hotkeyStarted = false;
		}
	};
}
