import { describe, expect, test } from "bun:test";
import { DEFAULT_TARGET_LANG, findLanguage, LANGUAGES, type Language } from "./languages";

describe("LANGUAGES catalog", () => {
	test("is non-empty", () => {
		expect(LANGUAGES.length).toBeGreaterThan(0);
	});

	test("every entry has non-empty code / englishName / nativeName", () => {
		for (const lang of LANGUAGES) {
			expect(typeof lang.code).toBe("string");
			expect(lang.code.length).toBeGreaterThan(0);
			expect(typeof lang.englishName).toBe("string");
			expect(lang.englishName.length).toBeGreaterThan(0);
			expect(typeof lang.nativeName).toBe("string");
			expect(lang.nativeName.length).toBeGreaterThan(0);
		}
	});

	test("englishName is unique — it IS the persisted key, so dupes would collide in the lookup map", () => {
		const names = LANGUAGES.map((l) => l.englishName);
		expect(new Set(names).size).toBe(names.length);
	});

	test("ISO code is unique — the combobox badge must not be ambiguous", () => {
		const codes = LANGUAGES.map((l) => l.code);
		expect(new Set(codes).size).toBe(codes.length);
	});

	test("the documented default target language is present in the catalog", () => {
		expect(LANGUAGES.some((l) => l.englishName === DEFAULT_TARGET_LANG)).toBe(true);
	});

	test("includes the app's first-class UI locales (ar, en, es, fr, hi, zh)", () => {
		const codes = new Set(LANGUAGES.map((l) => l.code));
		for (const code of ["ar", "en", "es", "fr", "hi", "zh"]) {
			expect(codes.has(code)).toBe(true);
		}
	});

	test("no whitespace-padded names that would break a trimmed/exact persisted-key match", () => {
		for (const lang of LANGUAGES) {
			expect(lang.englishName).toBe(lang.englishName.trim());
		}
	});
});

describe("DEFAULT_TARGET_LANG", () => {
	test("is English (the safe universally-supported default)", () => {
		expect(DEFAULT_TARGET_LANG).toBe("English");
	});
});

describe("findLanguage", () => {
	test("resolves a known english name to its full catalog entry", () => {
		const spanish = findLanguage("Spanish");
		expect(spanish).toBeDefined();
		expect(spanish?.code).toBe("es");
		expect(spanish?.nativeName).toBe("Español");
	});

	test("resolves every catalog entry by its englishName (round-trip)", () => {
		for (const lang of LANGUAGES) {
			expect(findLanguage(lang.englishName)).toBe(lang as Language);
		}
	});

	test("returns undefined for an unknown / legacy value (caller falls back to raw string)", () => {
		expect(findLanguage("Klingon")).toBeUndefined();
	});

	test("returns undefined for undefined input (translate-without-explicit-choice path)", () => {
		expect(findLanguage(undefined)).toBeUndefined();
	});

	test("returns undefined for empty string (falsy short-circuit, not a map miss on '')", () => {
		expect(findLanguage("")).toBeUndefined();
	});

	test("is case-sensitive — persisted value must match the canonical name exactly", () => {
		// The combobox writes the canonical englishName, so a lowercased value is
		// treated as unknown. This documents the exact-match contract.
		expect(findLanguage("spanish")).toBeUndefined();
	});
});
