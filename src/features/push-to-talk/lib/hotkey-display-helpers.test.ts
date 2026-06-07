import { describe, expect, test } from "bun:test";
import {
	FOOTER_TOOLTIP_DELAY,
	resolveTone,
	TONE_TEXT,
} from "./hotkey-display-helpers";

describe("FOOTER_TOOLTIP_DELAY", () => {
	test("is the documented 1500ms hover delay", () => {
		expect(FOOTER_TOOLTIP_DELAY).toBe(1500);
	});
});

describe("TONE_TEXT", () => {
	// The four keys here MUST stay in sync with the InputGroupTone union
	// ("default" | "active" | "danger" | "muted"); InputGroup.tsx indexes this
	// map by tone, so a missing key would render `undefined` as a className.
	const EXPECTED_TONES = ["default", "active", "danger", "muted"] as const;

	test("has exactly one entry per InputGroupTone", () => {
		expect(Object.keys(TONE_TEXT).sort()).toEqual([...EXPECTED_TONES].sort());
	});

	test("every value is a non-empty Tailwind class string", () => {
		for (const tone of EXPECTED_TONES) {
			expect(typeof TONE_TEXT[tone]).toBe("string");
			expect(TONE_TEXT[tone].length).toBeGreaterThan(0);
		}
	});

	test("danger tone carries the error colour", () => {
		expect(TONE_TEXT.danger).toBe("text-error");
	});

	test("muted tone is dimmed (opacity hint present)", () => {
		expect(TONE_TEXT.muted).toContain("text-foreground-dim");
		expect(TONE_TEXT.muted).toContain("opacity-70");
	});

	test("default rests muted; active brightens to plain foreground", () => {
		expect(TONE_TEXT.default).toBe("text-foreground-muted");
		expect(TONE_TEXT.active).toBe("text-foreground");
	});
});

describe("resolveTone", () => {
	test("disconnected → 'muted' regardless of pressed state", () => {
		// !isConnected is checked first, so isPressed cannot override it.
		expect(resolveTone(false, false)).toBe("muted");
		expect(resolveTone(false, true)).toBe("muted");
	});

	test("connected + pressed → 'active'", () => {
		expect(resolveTone(true, true)).toBe("active");
	});

	test("connected + not pressed → 'default'", () => {
		expect(resolveTone(true, false)).toBe("default");
	});

	test("never returns 'danger' (resolveTone never picks the danger tone)", () => {
		// danger is reserved for conflict states surfaced elsewhere; this
		// resolver only emits muted/active/default. Document that contract.
		const outputs = [
			resolveTone(false, false),
			resolveTone(false, true),
			resolveTone(true, false),
			resolveTone(true, true),
		];
		expect(outputs).not.toContain("danger");
	});

	test("every resolveTone result is a valid key of TONE_TEXT", () => {
		for (const connected of [true, false]) {
			for (const pressed of [true, false]) {
				const tone = resolveTone(connected, pressed);
				expect(TONE_TEXT[tone]).toBeDefined();
			}
		}
	});
});
