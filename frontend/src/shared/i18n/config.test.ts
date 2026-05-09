import { describe, expect, test } from "bun:test";
import { DEFAULT_LOCALE, isLocale, LOCALE_NAMES, LOCALES } from "./config";

describe("LOCALES", () => {
	test("is a non-empty list of unique strings", () => {
		expect(LOCALES.length).toBeGreaterThan(0);
		expect(new Set(LOCALES).size).toBe(LOCALES.length);
	});

	test("contains the default locale", () => {
		expect(LOCALES as readonly string[]).toContain(DEFAULT_LOCALE);
	});
});

describe("isLocale", () => {
	test("returns true for every advertised locale", () => {
		for (const locale of LOCALES) {
			expect(isLocale(locale)).toBe(true);
		}
	});

	test("returns false for non-locale strings", () => {
		expect(isLocale("klingon")).toBe(false);
		expect(isLocale("")).toBe(false);
		expect(isLocale("EN")).toBe(false); // case-sensitive
	});
});

describe("LOCALE_NAMES", () => {
	test("has an entry for every locale with non-empty name and native", () => {
		for (const locale of LOCALES) {
			const entry = LOCALE_NAMES[locale];
			expect(entry).toBeDefined();
			expect(entry.name.length).toBeGreaterThan(0);
			expect(entry.native.length).toBeGreaterThan(0);
		}
	});

	test("English entry uses 'English' for both", () => {
		expect(LOCALE_NAMES.en).toEqual({ name: "English", native: "English" });
	});
});
