import { describe, expect, test } from "bun:test";
import {
	compareHotkeys,
	type HotkeyRelation,
	type HotkeyTriple,
	isHotkeyConflict,
	resolveHotkeyTriple,
} from "./hotkey-conflict";

const DEFAULTS: HotkeyTriple = {
	pushToTalkKey: "LCtrl+LMeta",
	repasteHotkey: "LCtrl+LShift+V",
	ttsHotkey: "LMeta+LShift+E",
};

describe("compareHotkeys", () => {
	test("identical combos compare as 'equal'", () => {
		expect(compareHotkeys("LCtrl+LShift+V", "LCtrl+LShift+V")).toBe("equal");
	});

	test("key order does not matter — 'A+LCtrl' equals 'LCtrl+A'", () => {
		expect(compareHotkeys("LCtrl+A", "A+LCtrl")).toBe("equal");
	});

	test("case differences do not matter — 'lctrl+a' equals 'LCtrl+A'", () => {
		expect(compareHotkeys("lctrl+a", "LCtrl+A")).toBe("equal");
	});

	test("a ⊂ b returns 'subset' (pressing b would also satisfy a)", () => {
		expect(compareHotkeys("LCtrl+LShift", "LCtrl+LShift+V")).toBe("subset");
	});

	test("a ⊃ b returns 'superset' (pressing a would also satisfy b)", () => {
		expect(compareHotkeys("LCtrl+LShift+V", "LCtrl+LShift")).toBe("superset");
	});

	test("combos that share keys but each has a unique one are 'disjoint'", () => {
		// LCtrl+A vs LCtrl+B — neither set contains the other.
		expect(compareHotkeys("LCtrl+A", "LCtrl+B")).toBe("disjoint");
	});

	test("fully different combos are 'disjoint'", () => {
		expect(compareHotkeys("LCtrl+A", "LAlt+B")).toBe("disjoint");
	});

	test("empty input on either side resolves to 'disjoint' (no collision possible)", () => {
		expect(compareHotkeys("", "LCtrl+A")).toBe("disjoint");
		expect(compareHotkeys("LCtrl+A", "")).toBe("disjoint");
		expect(compareHotkeys("", "")).toBe("disjoint");
	});

	test("whitespace-only tokens are dropped before comparison", () => {
		// "LCtrl +  + A" should normalize to {lctrl, a} — same as "LCtrl+A".
		expect(compareHotkeys("LCtrl +  + A", "LCtrl+A")).toBe("equal");
	});

	test("relation is symmetric in the disjoint case", () => {
		expect(compareHotkeys("LCtrl+A", "LAlt+B")).toBe("disjoint");
		expect(compareHotkeys("LAlt+B", "LCtrl+A")).toBe("disjoint");
	});

	test("relation flips between subset and superset when args swap", () => {
		expect(compareHotkeys("LCtrl+LShift", "LCtrl+LShift+V")).toBe("subset");
		expect(compareHotkeys("LCtrl+LShift+V", "LCtrl+LShift")).toBe("superset");
	});

	test("single-key combo is subset of any compound that contains it", () => {
		expect(compareHotkeys("V", "LCtrl+LShift+V")).toBe("subset");
	});
});

describe("isHotkeyConflict", () => {
	test("returns false only for 'disjoint'", () => {
		const all: HotkeyRelation[] = ["disjoint", "equal", "subset", "superset"];
		expect(all.map(isHotkeyConflict)).toEqual([false, true, true, true]);
	});
});

describe("resolveHotkeyTriple", () => {
	test("disjoint defaults pass through unchanged with no rewrites reported", () => {
		const r = resolveHotkeyTriple({ ...DEFAULTS }, DEFAULTS);
		expect(r.values).toEqual(DEFAULTS);
		expect(r.rewrites).toEqual([]);
	});

	test("resets repaste when it equals PTT", () => {
		const r = resolveHotkeyTriple(
			{ pushToTalkKey: "LCtrl+A", repasteHotkey: "LCtrl+A", ttsHotkey: "LMeta+T" },
			DEFAULTS
		);
		expect(r.values.repasteHotkey).toBe(DEFAULTS.repasteHotkey);
		expect(r.rewrites).toContain("repasteHotkey");
	});

	test("resets repaste when PTT is a subset of it", () => {
		// PTT ⊂ repaste — pressing repaste would also fire PTT, so repaste must change.
		const r = resolveHotkeyTriple(
			{ pushToTalkKey: "LCtrl+LShift", repasteHotkey: "LCtrl+LShift+V", ttsHotkey: "LMeta+T" },
			DEFAULTS
		);
		expect(r.values.repasteHotkey).toBe(DEFAULTS.repasteHotkey);
		expect(r.rewrites).toContain("repasteHotkey");
	});

	test("resets TTS when it conflicts with PTT (and only TTS, not repaste)", () => {
		const r = resolveHotkeyTriple(
			{
				pushToTalkKey: "LCtrl+A",
				repasteHotkey: "LCtrl+LShift+V",
				ttsHotkey: "LCtrl+A+B", // superset of PTT
			},
			DEFAULTS
		);
		expect(r.values.ttsHotkey).toBe(DEFAULTS.ttsHotkey);
		expect(r.values.repasteHotkey).toBe("LCtrl+LShift+V");
		expect(r.rewrites).toEqual(["ttsHotkey"]);
	});

	test("resets TTS when it conflicts with the (newly-settled) repaste binding", () => {
		// repaste is fine vs PTT; TTS overlaps with repaste.
		const r = resolveHotkeyTriple(
			{
				pushToTalkKey: "LCtrl+A",
				repasteHotkey: "LCtrl+LShift+V",
				ttsHotkey: "LCtrl+LShift", // subset of repaste
			},
			DEFAULTS
		);
		expect(r.values.ttsHotkey).toBe(DEFAULTS.ttsHotkey);
		expect(r.rewrites).toEqual(["ttsHotkey"]);
	});

	test("resets both repaste and TTS when both clash with PTT", () => {
		const r = resolveHotkeyTriple(
			{
				pushToTalkKey: "LCtrl+LShift+V",
				repasteHotkey: "LCtrl+LShift+V", // equal
				ttsHotkey: "LCtrl+LShift", // subset
			},
			DEFAULTS
		);
		expect(r.values.repasteHotkey).toBe(DEFAULTS.repasteHotkey);
		expect(r.values.ttsHotkey).toBe(DEFAULTS.ttsHotkey);
		expect(r.rewrites).toEqual(["repasteHotkey", "ttsHotkey"]);
	});

	test("PTT is never rewritten — even when it is the anchor of all conflicts", () => {
		const candidate = {
			pushToTalkKey: "LCtrl+LShift+V",
			repasteHotkey: "LCtrl+LShift+V",
			ttsHotkey: "LCtrl+LShift+V",
		};
		const r = resolveHotkeyTriple(candidate, DEFAULTS);
		expect(r.values.pushToTalkKey).toBe(candidate.pushToTalkKey);
		expect(r.rewrites).not.toContain("pushToTalkKey");
	});
});
