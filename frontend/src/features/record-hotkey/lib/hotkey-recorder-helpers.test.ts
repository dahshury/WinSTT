import { describe, expect, test } from "bun:test";
import {
	type ForbiddenCombo,
	findConflict,
	formatCombo,
	resolveDisplayText,
} from "./hotkey-recorder-helpers";

describe("formatCombo", () => {
	test("maps internal modifier names to human labels joined by ' + '", () => {
		expect(formatCombo("LCtrl+LShift+V")).toBe("L Ctrl + L Shift + V");
	});

	test("passes through keys with no display label unchanged", () => {
		expect(formatCombo("A")).toBe("A");
		expect(formatCombo("F5")).toBe("F5");
	});

	test("formats each side of every modifier variant", () => {
		expect(formatCombo("RCtrl+RAlt+RShift+RMeta")).toBe("R Ctrl + R Alt + R Shift + R Win");
		expect(formatCombo("LAlt+LMeta")).toBe("L Alt + L Win");
	});

	test("empty string yields empty (split('+') on '' gives ['']→formatted '')", () => {
		// "".split("+") === [""], formatKeyName("") === "" (no label), join → "".
		expect(formatCombo("")).toBe("");
	});

	test("a single trailing '+' produces an empty second token", () => {
		// "Ctrl+".split("+") === ["Ctrl",""] → "Ctrl + ".
		expect(formatCombo("Ctrl+")).toBe("Ctrl + ");
	});
});

describe("resolveDisplayText", () => {
	const PRESS_LABEL = "Press keys…";

	test("not recording → formats the persisted currentKey", () => {
		expect(resolveDisplayText(false, [], "LCtrl+V", PRESS_LABEL)).toBe("L Ctrl + V");
	});

	test("not recording ignores liveKeys entirely", () => {
		// Even if liveKeys somehow has content, the !recording branch wins.
		expect(resolveDisplayText(false, ["LAlt"], "LCtrl+V", PRESS_LABEL)).toBe("L Ctrl + V");
	});

	test("recording with live keys → formats the live key list", () => {
		expect(resolveDisplayText(true, ["LCtrl", "LShift", "A"], "LCtrl+V", PRESS_LABEL)).toBe(
			"L Ctrl + L Shift + A"
		);
	});

	test("recording with a single live key → that key's label", () => {
		expect(resolveDisplayText(true, ["RMeta"], "LCtrl+V", PRESS_LABEL)).toBe("R Win");
	});

	test("recording but no live keys yet → the press-keys prompt", () => {
		expect(resolveDisplayText(true, [], "LCtrl+V", PRESS_LABEL)).toBe(PRESS_LABEL);
	});

	test("recording + empty liveKeys returns the prompt VERBATIM (i18n string passthrough)", () => {
		const localized = "اضغط المفاتيح";
		expect(resolveDisplayText(true, [], "LCtrl+V", localized)).toBe(localized);
	});
});

describe("findConflict", () => {
	const combos = (entries: Array<{ combo: string; label: string }>): readonly ForbiddenCombo[] =>
		entries;

	test("returns null when forbiddenCombos is undefined", () => {
		expect(findConflict("LCtrl+V", undefined)).toBeNull();
	});

	test("returns null for an empty forbidden list", () => {
		expect(findConflict("LCtrl+V", [])).toBeNull();
	});

	test("returns null when the candidate is disjoint from every entry", () => {
		const list = combos([
			{ combo: "LAlt+S", label: "Save" },
			{ combo: "RCtrl+P", label: "Print" },
		]);
		expect(findConflict("LCtrl+V", list)).toBeNull();
	});

	test("detects an exact-equal conflict", () => {
		const list = combos([{ combo: "LCtrl+V", label: "Paste" }]);
		expect(findConflict("LCtrl+V", list)?.label).toBe("Paste");
	});

	test("detects a subset conflict (candidate ⊂ entry)", () => {
		// Pressing the larger bound combo also satisfies the smaller candidate.
		const list = combos([{ combo: "LCtrl+LShift+V", label: "RePaste" }]);
		expect(findConflict("LCtrl+V", list)?.label).toBe("RePaste");
	});

	test("detects a superset conflict (candidate ⊃ entry)", () => {
		const list = combos([{ combo: "LCtrl", label: "Modifier-only" }]);
		expect(findConflict("LCtrl+V", list)?.label).toBe("Modifier-only");
	});

	test("is order/case-insensitive via the underlying comparator", () => {
		const list = combos([{ combo: "v+lctrl", label: "Lower+Reordered" }]);
		expect(findConflict("LCtrl+V", list)?.label).toBe("Lower+Reordered");
	});

	test("returns the FIRST conflicting entry, not a later one", () => {
		const list = combos([
			{ combo: "LAlt+Q", label: "First (disjoint)" },
			{ combo: "LCtrl+V", label: "Second (equal)" },
			{ combo: "LCtrl", label: "Third (superset)" },
		]);
		// Skips the disjoint #1, matches the equal #2, never reaches #3.
		expect(findConflict("LCtrl+V", list)?.label).toBe("Second (equal)");
	});

	test("empty candidate cannot conflict (comparator treats empty as disjoint)", () => {
		const list = combos([{ combo: "LCtrl+V", label: "Paste" }]);
		expect(findConflict("", list)).toBeNull();
	});
});
