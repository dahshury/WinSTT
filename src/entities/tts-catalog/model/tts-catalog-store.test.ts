import { beforeEach, describe, expect, test } from "bun:test";
import { useTtsCatalogStore } from "./tts-catalog-store";

/** A minimally-populated server row — every other field relies on the schema's
 *  defaults, which is exactly the old-server shape we must stay compatible with. */
function row(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "qwen3-tts-1.7b-voicedesign",
		engine: "qwen3-tts",
		display_name: "Qwen3-TTS VoiceDesign",
		...extra,
	};
}

beforeEach(() => {
	useTtsCatalogStore.setState({ models: [], isLoaded: false });
});

describe("tts catalog — voice-design character budget", () => {
	test("carries the server's per-model budget through to the UI shape", () => {
		useTtsCatalogStore
			.getState()
			.setModels([row({ voice_design: true, voice_design_max_chars: 300 })]);

		const model = useTtsCatalogStore
			.getState()
			.getModel("qwen3-tts-1.7b-voicedesign");
		expect(model?.voiceDesign).toBe(true);
		expect(model?.voiceDesignMaxChars).toBe(300);
	});

	test("a row from a server that predates the field still parses (0 = no cap known)", () => {
		useTtsCatalogStore.getState().setModels([row({ voice_design: true })]);

		// The row must NOT be dropped: `applyRaw` uses safeParse and silently skips
		// failures, so a missing default would empty the picker with no error.
		const model = useTtsCatalogStore
			.getState()
			.getModel("qwen3-tts-1.7b-voicedesign");
		expect(model).toBeDefined();
		expect(model?.voiceDesignMaxChars).toBe(0);
	});

	test("non-voice-design rows report no budget", () => {
		useTtsCatalogStore
			.getState()
			.setModels([row({ id: "kokoro-82m", engine: "kokoro" })]);

		expect(useTtsCatalogStore.getState().getModel("kokoro-82m")).toMatchObject({
			voiceDesign: false,
			voiceDesignMaxChars: 0,
		});
	});
});

describe("tts catalog — cloning + inline-tag capabilities", () => {
	test("carries the clip budget and the tag vocabulary through to the UI shape", () => {
		useTtsCatalogStore.getState().setModels([
			row({
				id: "chatterbox-turbo",
				engine: "chatterbox",
				cloning: "zero_shot_audio",
				max_ref_clip_secs: 30,
				tag_syntax: "square",
				tags: ["laugh", "cough", "chuckle"],
			}),
		]);

		expect(
			useTtsCatalogStore.getState().getModel("chatterbox-turbo"),
		).toMatchObject({
			cloning: "zero_shot_audio",
			maxRefClipSecs: 30,
			tagSyntax: "square",
			tags: ["laugh", "cough", "chuckle"],
		});
	});

	test("a row from a server that predates the fields still parses", () => {
		// `applyRaw` safeParses and silently DROPS failures, so a missing default
		// would empty the picker with no error rather than losing one field.
		useTtsCatalogStore
			.getState()
			.setModels([row({ id: "kokoro-82m", engine: "kokoro" })]);

		expect(useTtsCatalogStore.getState().getModel("kokoro-82m")).toMatchObject({
			maxRefClipSecs: 0,
			tagSyntax: "none",
			tags: [],
		});
	});

	test("an unknown tag syntax drops the row rather than inventing delimiters", () => {
		// The delimiters are NOT interchangeable — a syntax this build can't render
		// must not silently fall back to one of the two it knows.
		useTtsCatalogStore
			.getState()
			.setModels([row({ id: "future", tag_syntax: "curly" })]);

		expect(useTtsCatalogStore.getState().getModel("future")).toBeUndefined();
	});
});
