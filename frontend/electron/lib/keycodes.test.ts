import { describe, expect, mock, test } from "bun:test";
import { uiohookMock } from "@test/mocks/uiohook-napi";

// Mock uiohook-napi at module load — its native binary may not load under bun:test.
// Use the SHARED shim so other test files mocking uiohook-napi don't poison
// keycodes.ts's module-init iteration of `Object.entries(KEYCODE_TO_NAME)`.
mock.module("uiohook-napi", () => uiohookMock());

const {
	codesToNames,
	KEYCODE_TO_NAME,
	MODIFIER_ORDER,
	modifierOrderOf,
	NAME_TO_KEYCODE,
	parseAccelerator,
	sortKeycodes,
} = await import("./keycodes");

describe("KEYCODE_TO_NAME / NAME_TO_KEYCODE", () => {
	test("modifier keys map both directions", () => {
		expect(KEYCODE_TO_NAME[1]).toBe("LCtrl");
		expect(NAME_TO_KEYCODE.LCtrl).toBe(1);
		expect(KEYCODE_TO_NAME[8]).toBe("RMeta");
		expect(NAME_TO_KEYCODE.RMeta).toBe(8);
	});

	test("letters map both directions", () => {
		expect(KEYCODE_TO_NAME[30]).toBe("A");
		expect(NAME_TO_KEYCODE.A).toBe(30);
	});
});

describe("parseAccelerator", () => {
	test("parses a single modifier", () => {
		expect(parseAccelerator("LCtrl")).toEqual(new Set([1]));
	});

	test("parses a compound accelerator", () => {
		const codes = parseAccelerator("LCtrl+LAlt+A");
		expect(codes).toEqual(new Set([1, 3, 30]));
	});

	test("trims whitespace around each part", () => {
		expect(parseAccelerator(" LCtrl + A ")).toEqual(new Set([1, 30]));
	});

	test("falls back to capitalized lookup (e.g. 'lctrl' → 'LCtrl' fails capital fallback)", () => {
		// 'lctrl' uppercased becomes 'LCTRL' (not 'LCtrl'), which is not in the map.
		// charAt(0).toUpperCase() + slice(1) becomes 'Lctrl', also not in the map.
		// So this returns null — verifies the fallback logic does not over-match.
		expect(parseAccelerator("lctrl")).toBeNull();
	});

	test("returns null for an unknown segment", () => {
		expect(parseAccelerator("LCtrl+ZZ")).toBeNull();
	});

	test("returns null for an empty string", () => {
		expect(parseAccelerator("")).toBeNull();
	});

	test("a single lowercase letter is matched via uppercase fallback", () => {
		expect(parseAccelerator("a")).toEqual(new Set([30]));
	});
});

describe("MODIFIER_ORDER and sortKeycodes", () => {
	test("modifier order keeps Ctrl before Alt before Shift before Meta", () => {
		expect(MODIFIER_ORDER[1]).toBeLessThan(MODIFIER_ORDER[3] ?? 999);
		expect(MODIFIER_ORDER[3]).toBeLessThan(MODIFIER_ORDER[5] ?? 999);
		expect(MODIFIER_ORDER[5]).toBeLessThan(MODIFIER_ORDER[7] ?? 999);
	});

	test("sortKeycodes places modifiers before non-modifiers", () => {
		const sorted = sortKeycodes([30, 1, 5]); // A, LCtrl, LShift
		expect(sorted).toEqual([1, 5, 30]);
	});

	test("non-modifier keys are sorted by numeric code", () => {
		const sorted = sortKeycodes([55, 30, 40]); // Z, A, K
		expect(sorted).toEqual([30, 40, 55]);
	});

	test("modifierOrderOf returns the slot for a known modifier", () => {
		// LCtrl (1) sits in slot 0.
		expect(modifierOrderOf(1)).toBe(0);
		// RMeta (8) sits in slot 7 (last modifier).
		expect(modifierOrderOf(8)).toBe(7);
	});

	test("modifierOrderOf returns 100 for a non-modifier keycode", () => {
		// 30 is the letter 'A' — not in MODIFIER_ORDER, so the `?? 100`
		// fallback fires. Asserting the exact sentinel kills mutants that
		// would swap the literal (e.g. `?? 0`, `?? 99`, `?? 101`).
		expect(modifierOrderOf(30)).toBe(100);
		expect(modifierOrderOf(9999)).toBe(100);
	});

	test("sortKeycodes is stable when two non-modifiers share the order rank", () => {
		// 30 (A) and 40 (K) both default to 100, so the comparator's
		// `if (oa !== ob)` branch is skipped and `a - b` decides the order.
		// Exercises the second `return` in compareKeycodes (and kills
		// equality-flip mutants on `oa !== ob`).
		expect(sortKeycodes([40, 30])).toEqual([30, 40]);
	});
});

describe("codesToNames", () => {
	test("maps and sorts codes into name strings", () => {
		expect(codesToNames([30, 1, 5])).toEqual(["LCtrl", "LShift", "A"]);
	});

	test("filters out unknown codes", () => {
		expect(codesToNames([1, 9999, 30])).toEqual(["LCtrl", "A"]);
	});

	test("filters out unknown codes and array length is exactly the known count (kills L194 if(true) mutant that pushes undefined)", () => {
		// If `if (name != null)` is mutated to `if (true)`, the unknown code (9999)
		// would push `undefined` into the array, lengthening it by 1.
		const result = codesToNames([1, 9999, 30]);
		expect(result.length).toBe(2);
		// And every entry must be a string — undefined would smuggle in.
		for (const item of result) {
			expect(typeof item).toBe("string");
		}
	});

	test("returns empty array for empty input", () => {
		expect(codesToNames([])).toEqual([]);
	});
});
