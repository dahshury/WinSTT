import { describe, expect, test } from "bun:test";
import { getEngineLogoSrc } from "./model-presentation";

describe("TTS engine logos", () => {
	test.each([
		["orpheus", "/provider-icons/canopylabs.svg"],
		["spark", "/provider-icons/sparkaudio.jpg"],
	])("maps %s to its bundled maker logo", (engine, expectedLogo) => {
		expect(getEngineLogoSrc(engine)).toBe(expectedLogo);
	});

	test("keeps the generic glyph fallback for unknown engines", () => {
		expect(getEngineLogoSrc("future-engine")).toBeNull();
	});
});
