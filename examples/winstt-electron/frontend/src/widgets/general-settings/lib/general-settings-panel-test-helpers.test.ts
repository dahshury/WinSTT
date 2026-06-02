import { describe, expect, test } from "bun:test";
import { buildWakeWordGroups, DEFAULT_WAKE_WORD } from "./general-settings-panel-test-helpers";

// buildWakeWordGroups() partitions the fixed unified wake-word list into one
// section per engine, the engine badge riding on the group header (the per-row
// badge is dropped). The list spans all three engines, so one build exercises
// every engineBadge branch:
//   composite    (word in BOTH keyword sets, e.g. "alexa")      -> "2x"
//   openwakeword (OWW-only, e.g. "hey_jarvis")                  -> "OWW"
//   porcupine    (porcupine-only / neither, e.g. "picovoice")   -> "PVP"
describe("buildWakeWordGroups / engineBadge", () => {
	const groups = buildWakeWordGroups();
	const allRows = groups.flatMap((g) => [...g.options]);
	const groupOf = (id: string) => groups.find((g) => g.options.some((o) => o.id === id));

	test("every engine badge branch is represented on the group headers", () => {
		expect(new Set(groups.map((g) => g.badge))).toEqual(new Set(["2x", "OWW", "PVP"]));
	});

	test("composite keyword (in both sets) lands in the 2x group", () => {
		expect(groupOf("alexa")?.badge).toBe("2x");
	});

	test("openwakeword-only keyword lands in the OWW group", () => {
		expect(groupOf("hey_jarvis")?.badge).toBe("OWW");
	});

	test("porcupine-only keyword lands in the PVP group", () => {
		expect(groupOf("picovoice")?.badge).toBe("PVP");
	});

	test("composite section is listed first", () => {
		expect(groups[0]?.value).toBe("composite");
	});

	test("rows carry no per-row badge (the header carries the engine)", () => {
		expect(allRows.every((o) => o.badge === undefined)).toBe(true);
	});

	test("rows carry a leading icon", () => {
		expect(allRows.every((o) => o.icon !== undefined)).toBe(true);
	});

	test("labels are human-formatted (underscores -> spaces) while id stays raw", () => {
		const jarvis = allRows.find((o) => o.id === "hey_jarvis");
		expect(jarvis?.label).toBe("hey jarvis");
	});

	test("DEFAULT_WAKE_WORD is a known option", () => {
		expect(DEFAULT_WAKE_WORD).toBe("alexa");
		expect(allRows.some((o) => o.id === DEFAULT_WAKE_WORD)).toBe(true);
	});
});
