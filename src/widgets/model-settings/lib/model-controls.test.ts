import { describe, expect, test } from "bun:test";
import {
	isLocalTtsActive,
	resolveModelControlVisibility,
} from "./model-controls";

const eleven = (apiKey = "", verified = false) =>
	({ apiKey, verified }) as never;
const tts = (source: "local" | "cloud", enabled = true) =>
	({ enabled, source }) as never;

describe("model control visibility", () => {
	test("keeps device and unload policy visible for cloud STT plus local TTS", () => {
		const localTts = isLocalTtsActive(tts("local"), eleven(), "");
		expect(resolveModelControlVisibility(true, "hidden", localTts)).toEqual({
			showDevice: true,
			showLanguage: false,
			showLifetime: true,
		});
	});

	test("hides local compute controls when STT and ElevenLabs TTS are cloud", () => {
		const localTts = isLocalTtsActive(
			tts("cloud"),
			eleven("eleven-key", true),
			"",
		);
		expect(resolveModelControlVisibility(true, "hidden", localTts)).toEqual({
			showDevice: false,
			showLanguage: false,
			showLifetime: false,
		});
	});

	test("recognizes OpenRouter-only cloud TTS as cloud", () => {
		expect(isLocalTtsActive(tts("cloud"), eleven(), "or-key")).toBe(false);
	});

	test("always exposes local model controls for local STT", () => {
		expect(resolveModelControlVisibility(false, "single", false)).toEqual({
			showDevice: true,
			showLanguage: true,
			showLifetime: true,
		});
	});
});
