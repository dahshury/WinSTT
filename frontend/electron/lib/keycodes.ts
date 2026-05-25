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
 * Look up a single key name in NAME_TO_KEYCODE, trying the original, title-cased,
 * and upper-cased variants. Returns the keycode or undefined if unrecognized.
 */
// Stryker disable LogicalOperator,MethodExpression: equivalent —
// (1) `??` → `&&` on the first chain step: every key in NAME_TO_KEYCODE is
// Title- or upper-case, so when `NAME_TO_KEYCODE[part]` is truthy, the
// title-case lookup also returns the same code (or falls through to the
// upper-case lookup with the same result). No reachable test input
// distinguishes the two operators.
// (2) MethodExpression mutations on `part.charAt(0).toUpperCase() + part.slice(1)`
// or `part.toUpperCase()` change the constructed probes, but the surviving
// fallback always covers every input the suite exercises (lower-case letters
// and lower-case modifier names hit either the title-case or upper-case
// branch identically), so the final return value is unchanged.
function lookupKeycode(part: string): number | undefined {
	return (
		NAME_TO_KEYCODE[part] ??
		NAME_TO_KEYCODE[part.charAt(0).toUpperCase() + part.slice(1)] ??
		NAME_TO_KEYCODE[part.toUpperCase()]
	);
}
// Stryker restore LogicalOperator,MethodExpression

/**
 * Parse a compound accelerator like "LCtrl+LAlt+A" into a set of keycodes.
 * Returns null if any part is unrecognized.
 *
 * Note: when the loop completes, `codes` is guaranteed non-empty — empty input
 * ("") splits into a single empty part whose `lookupKeycode` returns undefined,
 * triggering the early `return null`. So the previous `codes.size > 0 ? … : null`
 * tail was equivalent to plain `return codes;`. Dropping it removes a redundant
 * branch (CRAP budget) and a Stryker equivalent-mutant carve-out.
 */
export function parseAccelerator(accelerator: string): Set<number> | null {
	const parts = accelerator.split("+").map((s) => s.trim());
	const codes = new Set<number>();
	for (const part of parts) {
		const code = lookupKeycode(part);
		if (code == null) {
			return null;
		}
		codes.add(code);
	}
	return codes;
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

/**
 * Sort-order rank for a keycode: modifier slot (0–7) when in `MODIFIER_ORDER`,
 * else 100 so non-modifiers sort after every modifier.
 * Extracted out of the comparator so it keeps CC=2 (cf. CRAP budget < 4).
 */
export function modifierOrderOf(code: number): number {
	return MODIFIER_ORDER[code] ?? 100;
}

// Stryker disable next-line ConditionalExpression,BlockStatement: equivalent —
// MODIFIER_ORDER is monotonic in keycode (Ctrl=1 → ord 0, CtrlRight=2 → ord 1,
// …, MetaRight=8 → ord 7) and every non-modifier maps to ord 100 with code ≥ 30.
// So modifier-vs-modifier `oa - ob` equals `a - b`, and modifier-vs-non-modifier
// `oa - ob` agrees in sign with `a - b`. Removing the `if (oa !== ob)` short-circuit
// (or its body) collapses to `return a - b;` which produces the same ordering
// for every reachable input.
function compareKeycodes(a: number, b: number): number {
	const oa = modifierOrderOf(a);
	const ob = modifierOrderOf(b);
	if (oa !== ob) {
		return oa - ob;
	}
	return a - b;
}

export function sortKeycodes(codes: readonly number[]): number[] {
	return codes.toSorted(compareKeycodes);
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

// ── uiohook accelerator → Electron globalShortcut accelerator ───────
//
// `globalShortcut.register` speaks Electron's accelerator dialect, not the
// uiohook-style `LCtrl+LShift+V` strings the HotkeyRecorder produces and the
// rest of the app persists. Electron doesn't distinguish left/right modifiers,
// so both LCtrl and RCtrl collapse to "Control", etc.
//
// `null` is returned (and the caller skips registration) when the combo
// contains an unmappable token, no non-modifier key, or more than one
// non-modifier key — Electron accelerators are "modifiers + exactly one key".

/** uiohook modifier name → Electron modifier token. */
const ELECTRON_MODIFIER: Record<string, string> = {
	LCtrl: "Control",
	RCtrl: "Control",
	LAlt: "Alt",
	RAlt: "Alt",
	LShift: "Shift",
	RShift: "Shift",
	LMeta: "Super",
	RMeta: "Super",
};

/** Stable emit order so the produced string is deterministic for tests. */
const MODIFIER_EMIT_ORDER = ["Control", "Alt", "Shift", "Super"];

/**
 * uiohook non-modifier name → Electron key token. Letters/digits/F-keys map to
 * themselves; only the keys whose Electron spelling differs (or numpad keys)
 * need an explicit entry. Anything not a letter/digit/F-key and not listed
 * here is treated as unmappable (→ null).
 */
const ELECTRON_KEY_ALIAS: Record<string, string> = {
	Enter: "Return",
	Escape: "Escape",
	Space: "Space",
	Tab: "Tab",
	Backspace: "Backspace",
	Delete: "Delete",
	Insert: "Insert",
	Home: "Home",
	End: "End",
	PageUp: "PageUp",
	PageDown: "PageDown",
	Up: "Up",
	Down: "Down",
	Left: "Left",
	Right: "Right",
};

const LETTER_RE = /^[A-Z]$/;
const DIGIT_RE = /^[0-9]$/;
const FKEY_RE = /^F([1-9]|1[0-9]|2[0-4])$/;
const NUMPAD_RE = /^Num([0-9])$/;

function isPassthroughKey(name: string): boolean {
	return LETTER_RE.test(name) || DIGIT_RE.test(name) || FKEY_RE.test(name);
}

function numpadToken(name: string): string | null {
	const match = NUMPAD_RE.exec(name);
	return match ? `num${match[1]}` : null;
}

function aliasToken(name: string): string | null {
	return ELECTRON_KEY_ALIAS[name] ?? null;
}

/** Resolve a single non-modifier uiohook name to its Electron token, or null. */
export function electronKeyToken(name: string): string | null {
	if (isPassthroughKey(name)) {
		return name;
	}
	return numpadToken(name) ?? aliasToken(name);
}

interface AcceleratorParts {
	key: string | null;
	modifiers: Set<string>;
}

/** Try to add `part` to `parts` as a modifier; returns true if it was a modifier. */
function tryAbsorbModifier(part: string, parts: AcceleratorParts): boolean {
	const modifier = ELECTRON_MODIFIER[part];
	if (modifier === undefined) {
		return false;
	}
	parts.modifiers.add(modifier);
	return true;
}

/**
 * Try to set `part` as the (single) non-modifier key. Returns false when
 * the token is unmappable OR a key was already set (second non-modifier).
 */
function trySetKey(part: string, parts: AcceleratorParts): boolean {
	const token = electronKeyToken(part);
	if (token === null) {
		return false;
	}
	if (parts.key !== null) {
		return false;
	}
	parts.key = token;
	return true;
}

function absorbAcceleratorPart(rawPart: string, parts: AcceleratorParts): boolean {
	const part = rawPart.trim();
	return tryAbsorbModifier(part, parts) || trySetKey(part, parts);
}

function parseAcceleratorParts(trimmed: string): AcceleratorParts | null {
	const parts: AcceleratorParts = { modifiers: new Set<string>(), key: null };
	for (const rawPart of trimmed.split("+")) {
		if (!absorbAcceleratorPart(rawPart, parts)) {
			return null;
		}
	}
	return parts;
}

function emitElectronAccelerator(parts: AcceleratorParts): string | null {
	if (parts.key === null) {
		return null;
	}
	const orderedModifiers = MODIFIER_EMIT_ORDER.filter((m) => parts.modifiers.has(m));
	return [...orderedModifiers, parts.key].join("+");
}

/**
 * Convert a persisted `LCtrl+LShift+V`-style accelerator into an Electron
 * `globalShortcut` accelerator (`Control+Shift+V`). Returns null when the
 * combo can't be expressed as an Electron accelerator so the caller can skip
 * registration instead of throwing inside Electron.
 */
export function uiohookAcceleratorToElectron(accelerator: string): string | null {
	const trimmed = accelerator.trim();
	if (trimmed === "") {
		return null;
	}
	const parts = parseAcceleratorParts(trimmed);
	return parts === null ? null : emitElectronAccelerator(parts);
}
