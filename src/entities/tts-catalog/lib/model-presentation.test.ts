import { describe, expect, test } from "bun:test";
import {
	getEngineLabel,
	getEngineLogoSrc,
	getEngineMaker,
} from "./model-presentation";

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

	// Neither vendor publishes an SVG, so these two carry the canonical Hugging Face org
	// avatar as a PNG. They are asserted separately from the SVG table above so a future
	// SVG swap is an intentional edit here rather than a silent one.
	test.each([
		["neutts", "/provider-icons/neuphonic.png", "NeuTTS", "Neuphonic"],
		["omnivoice", "/provider-icons/k2-fsa.png", "OmniVoice", "k2-fsa"],
		["audio8", "/provider-icons/audio8.svg", "Audio8", "Audio8"],
	])("maps %s to its bundled PNG avatar", (engine, logo, label, maker) => {
		expect(getEngineLogoSrc(engine)).toBe(logo);
		expect(getEngineLabel(engine)).toBe(label);
		expect(getEngineMaker(engine)).toBe(maker);
	});
});
