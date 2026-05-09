import { describe, expect, test } from "bun:test";
import {
	COMPUTE_TYPES,
	DEFAULT_HOTKEY,
	LANGUAGES,
	STT_CONTROL_PORT,
	STT_DATA_PORT,
	WHISPER_MODELS,
} from "./defaults";

describe("WHISPER_MODELS", () => {
	test("contains the canonical Whisper model variants", () => {
		expect(WHISPER_MODELS).toContain("tiny");
		expect(WHISPER_MODELS).toContain("large-v3");
		expect(WHISPER_MODELS).toContain("large-v3-turbo");
	});

	test("entries are unique", () => {
		expect(new Set(WHISPER_MODELS).size).toBe(WHISPER_MODELS.length);
	});

	test("includes both English-only and multilingual variants for tiny/base/small/medium", () => {
		for (const base of ["tiny", "base", "small", "medium"] as const) {
			expect(WHISPER_MODELS).toContain(base);
			expect(WHISPER_MODELS).toContain(`${base}.en` as (typeof WHISPER_MODELS)[number]);
		}
	});
});

describe("COMPUTE_TYPES", () => {
	test("includes default + auto + numeric precisions", () => {
		expect(COMPUTE_TYPES).toContain("default");
		expect(COMPUTE_TYPES).toContain("auto");
		expect(COMPUTE_TYPES).toContain("float16");
		expect(COMPUTE_TYPES).toContain("float32");
	});

	test("entries are unique", () => {
		expect(new Set(COMPUTE_TYPES).size).toBe(COMPUTE_TYPES.length);
	});
});

describe("LANGUAGES", () => {
	test("first entry is the auto-detect placeholder with empty code", () => {
		expect(LANGUAGES[0]).toEqual({ code: "", name: "Auto-detect" });
	});

	test("contains English with code 'en'", () => {
		expect(LANGUAGES.some((l) => l.code === "en" && l.name === "English")).toBe(true);
	});

	test("language codes are unique", () => {
		const codes = LANGUAGES.map((l) => l.code);
		expect(new Set(codes).size).toBe(codes.length);
	});

	test("every entry has a non-empty name and a string code", () => {
		for (const entry of LANGUAGES) {
			expect(typeof entry.code).toBe("string");
			expect(entry.name.length).toBeGreaterThan(0);
		}
	});
});

describe("port and hotkey defaults", () => {
	test("default hotkey is LCtrl+LMeta", () => {
		expect(DEFAULT_HOTKEY).toBe("LCtrl+LMeta");
	});

	test("control and data ports are distinct integers", () => {
		expect(Number.isInteger(STT_CONTROL_PORT)).toBe(true);
		expect(Number.isInteger(STT_DATA_PORT)).toBe(true);
		expect(STT_CONTROL_PORT).not.toBe(STT_DATA_PORT);
	});
});
