import { describe, expect, test } from "bun:test";
import { LOCALES } from "./config";
import { messages } from "./messages";

describe("messages bundle", () => {
	test("has an entry for every advertised locale", () => {
		for (const locale of LOCALES) {
			expect(messages[locale]).toBeDefined();
			expect(typeof messages[locale]).toBe("object");
		}
	});

	test("English locale has at least one top-level key", () => {
		const enKeys = Object.keys(messages.en as Record<string, unknown>);
		expect(enKeys.length).toBeGreaterThan(0);
	});
});
