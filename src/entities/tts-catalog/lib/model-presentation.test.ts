import { describe, expect, test } from "bun:test";
import {
	getEngineLabel,
	getEngineLogoSrc,
	getEngineMaker,
} from "./model-presentation";

describe("TTS engine logos", () => {
	test.each([
		["maya1", "/provider-icons/maya-research.webp"],
		["qwen3tts", "/provider-icons/qwen.svg"],
	])("maps %s to its bundled maker logo", (engine, expectedLogo) => {
		expect(getEngineLogoSrc(engine)).toBe(expectedLogo);
	});

	test("keeps the generic glyph fallback for unknown engines", () => {
		expect(getEngineLogoSrc("future-engine")).toBeNull();
		// Spark-TTS was removed (replaced by Qwen3-TTS Base); its engine key is unknown now.
		expect(getEngineLogoSrc("spark")).toBeNull();
	});

	// Paradee's author publishes no mark: the engine keeps its glyph, but still
	// gets its own label + maker rather than the anonymous "Speech" fallback.
	test("labels Paradee without a bundled logo", () => {
		expect(getEngineLogoSrc("paradee")).toBeNull();
		expect(getEngineLabel("paradee")).toBe("Paradee");
		expect(getEngineMaker("paradee")).toBe("Sahil Mahendrakar");
	});

	// Neither vendor publishes an SVG, so these two carry the canonical Hugging Face org
	// avatar as a PNG. They are asserted separately from the SVG table above so a future
	// SVG swap is an intentional edit here rather than a silent one.
	test.each([
		["neutts", "/provider-icons/neuphonic.png", "NeuTTS", "Neuphonic"],
		["omnivoice", "/provider-icons/k2-fsa.png", "OmniVoice", "k2-fsa"],
		["audio8", "/provider-icons/audio8.svg", "Audio8", "Audio8"],
		[
			"cosyvoice3",
			"/provider-icons/funaudiollm.png",
			"CosyVoice3",
			"FunAudioLLM",
		],
	])("maps %s to its bundled PNG avatar", (engine, logo, label, maker) => {
		expect(getEngineLogoSrc(engine)).toBe(logo);
		expect(getEngineLabel(engine)).toBe(label);
		expect(getEngineMaker(engine)).toBe(maker);
	});

	test("maps Magpie to the bundled NVIDIA mark", () => {
		expect(getEngineLogoSrc("magpie")).toBe("/provider-icons/nvidia.svg");
		expect(getEngineLabel("magpie")).toBe("Magpie");
		expect(getEngineMaker("magpie")).toBe("NVIDIA");
	});
});
