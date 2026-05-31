import { describe, expect, test } from "bun:test";
import { DEFAULT_LOCALE, isLocale, LOCALE_NAMES, LOCALES, pickLocaleFromSystem } from "./config";

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

describe("pickLocaleFromSystem", () => {
	test("maps each supported locale's bare primary tag back to itself", () => {
		for (const loc of LOCALES) {
			expect(pickLocaleFromSystem(loc)).toBe(loc);
		}
	});

	test("strips the region subtag from every supported locale (BCP-47 hyphen)", () => {
		for (const loc of LOCALES) {
			expect(pickLocaleFromSystem(`${loc}-US`)).toBe(loc);
			expect(pickLocaleFromSystem(`${loc}-001`)).toBe(loc);
		}
	});

	test("accepts POSIX-style underscore separators for every supported locale", () => {
		for (const loc of LOCALES) {
			expect(pickLocaleFromSystem(`${loc}_US`)).toBe(loc);
		}
	});

	test("is case-insensitive on the primary tag for every supported locale", () => {
		for (const loc of LOCALES) {
			expect(pickLocaleFromSystem(loc.toUpperCase())).toBe(loc);
			expect(pickLocaleFromSystem(`${loc.toUpperCase()}-XX`)).toBe(loc);
		}
	});

	test("falls back to the default locale for languages not in LOCALES", () => {
		// Pick synthetic two-letter codes that are guaranteed to be outside LOCALES,
		// so adding a new translation can't accidentally invalidate this test.
		const candidates = ["xx", "qq", "zz", "yy", "ww"] as const;
		const unsupported = candidates.filter((code) => !(LOCALES as readonly string[]).includes(code));
		expect(unsupported.length).toBeGreaterThan(0);
		for (const code of unsupported) {
			expect(pickLocaleFromSystem(code)).toBe(DEFAULT_LOCALE);
			expect(pickLocaleFromSystem(`${code}-XX`)).toBe(DEFAULT_LOCALE);
		}
	});

	test("falls back to the default locale for empty / nullish input", () => {
		expect(pickLocaleFromSystem("")).toBe(DEFAULT_LOCALE);
		expect(pickLocaleFromSystem(null)).toBe(DEFAULT_LOCALE);
		expect(pickLocaleFromSystem(undefined)).toBe(DEFAULT_LOCALE);
	});
});
