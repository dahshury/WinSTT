import { describe, expect, test } from "bun:test";
import { buildWakeWordOptions, DEFAULT_WAKE_WORD } from "./general-settings-panel-test-helpers";

// buildWakeWordOptions() drives the private engineBadge() over the fixed unified
// wake-word list. The list spans all three engines, so one build exercises every
// engineBadge branch:
//   composite  (word in BOTH keyword sets, e.g. "alexa")     -> "2x"
//   openwakeword (OWW-only, e.g. "hey_jarvis")               -> "OWW"
//   porcupine  (porcupine-only / neither, e.g. "picovoice")  -> "PVP"
describe("buildWakeWordOptions / engineBadge", () => {
	const options = buildWakeWordOptions();
	const badgeOf = (id: string): string | undefined => options.find((o) => o.id === id)?.badge;

	test("every engine badge branch is represented", () => {
		expect(new Set(options.map((o) => o.badge))).toEqual(new Set(["2x", "OWW", "PVP"]));
	});

	test("composite keyword (in both sets) badges as 2x", () => {
		expect(badgeOf("alexa")).toBe("2x");
	});

	test("openwakeword-only keyword badges as OWW", () => {
		expect(badgeOf("hey_jarvis")).toBe("OWW");
	});

	test("porcupine-only keyword badges as PVP", () => {
		expect(badgeOf("picovoice")).toBe("PVP");
	});

	test("labels are human-formatted (underscores -> spaces) while id stays raw", () => {
		const jarvis = options.find((o) => o.id === "hey_jarvis");
		expect(jarvis?.label).toBe("hey jarvis");
	});

	test("DEFAULT_WAKE_WORD is a known option", () => {
		expect(DEFAULT_WAKE_WORD).toBe("alexa");
		expect(options.some((o) => o.id === DEFAULT_WAKE_WORD)).toBe(true);
	});
});
