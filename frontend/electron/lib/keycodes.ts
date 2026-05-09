import { UiohookKey } from "uiohook-napi";

// ── Keycode → name mapping (used during recording) ─────────────────

export const KEYCODE_TO_NAME: Record<number, string> = {
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

export const NAME_TO_KEYCODE: Record<string, number> = {};
for (const [code, name] of Object.entries(KEYCODE_TO_NAME)) {
	NAME_TO_KEYCODE[name] = Number(code);
}

/**
 * Parse a compound accelerator like "LCtrl+LAlt+A" into a set of keycodes.
 * Returns null if any part is unrecognized.
 */
export function parseAccelerator(accelerator: string): Set<number> | null {
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

export const MODIFIER_ORDER: Record<number, number> = {
	[UiohookKey.Ctrl]: 0,
	[UiohookKey.CtrlRight]: 1,
	[UiohookKey.Alt]: 2,
	[UiohookKey.AltRight]: 3,
	[UiohookKey.Shift]: 4,
	[UiohookKey.ShiftRight]: 5,
	[UiohookKey.Meta]: 6,
	[UiohookKey.MetaRight]: 7,
};

export function sortKeycodes(codes: readonly number[]): number[] {
	return codes.toSorted((a, b) => {
		const oa = MODIFIER_ORDER[a] ?? 100;
		const ob = MODIFIER_ORDER[b] ?? 100;
		if (oa !== ob) {
			return oa - ob;
		}
		return a - b;
	});
}

export function codesToNames(codes: readonly number[]): string[] {
	const out: string[] = [];
	for (const c of sortKeycodes(codes)) {
		const name = KEYCODE_TO_NAME[c];
		if (name != null) {
			out.push(name);
		}
	}
	return out;
}
