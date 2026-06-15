import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import {
	matchesSearchQuery,
	useSettingsSearchKeywords,
} from "./settings-search";

function wrapper({ children }: { children: ReactNode }) {
	return <IntlProvider>{children}</IntlProvider>;
}

// Resolve a single tab's keyword string from the real i18n-backed hook.
function kw(tab: string): string {
	return (
		renderHook(() => useSettingsSearchKeywords(), { wrapper }).result.current[
			tab
		] ?? ""
	);
}

describe("useSettingsSearchKeywords (real i18n wiring)", () => {
	test("Appearance keywords contain the Display section name (the reported bug)", () => {
		// End-to-end: the real Appearance-tab keyword string, built from live
		// messages, must contain "Display" so the sidebar surfaces it.
		expect(matchesSearchQuery(kw("appearance"), "display")).toBe(true);
	});

	test("Processing keywords pull in the LLM provider + transform terms it hosts", () => {
		const processing = kw("processing");
		expect(matchesSearchQuery(processing, "openrouter")).toBe(true); // LLM provider
		expect(matchesSearchQuery(processing, "ollama")).toBe(true); // LLM provider
		expect(matchesSearchQuery(processing, "context")).toBe(true); // context awareness
	});

	test("Output keywords surface paste, playback device, and ducking controls", () => {
		const output = kw("output");
		expect(matchesSearchQuery(output, "paste")).toBe(true); // paste behavior
		expect(matchesSearchQuery(output, "srt")).toBe(true); // file export format
		expect(matchesSearchQuery(output, "speaker")).toBe(true); // shared playback/audio controls
		expect(matchesSearchQuery(output, "ducking")).toBe(true); // system audio reduction
		expect(matchesSearchQuery(output, "chime")).toBe(false); // recording sound lives in Recording
	});

	test("Read Aloud keywords surface text-to-speech controls", () => {
		const readAloud = kw("readAloud");
		expect(matchesSearchQuery(readAloud, "voice")).toBe(true);
		expect(matchesSearchQuery(readAloud, "tts")).toBe(true); // acronym alias
		expect(matchesSearchQuery(readAloud, "speaker")).toBe(false);
	});

	test("Recording keywords surface VAD and the recording mode", () => {
		const recording = kw("recording");
		expect(matchesSearchQuery(recording, "vad")).toBe(true);
		expect(matchesSearchQuery(recording, "endpoint")).toBe(true);
		expect(matchesSearchQuery(recording, "chime")).toBe(true);
	});

	test("Shortcuts keywords surface the hotkey configuration", () => {
		expect(matchesSearchQuery(kw("shortcuts"), "configuration")).toBe(true);
	});

	test("About keywords surface settings import/export actions", () => {
		const about = kw("about");
		expect(matchesSearchQuery(about, "export")).toBe(true);
		expect(matchesSearchQuery(about, "import")).toBe(true);
	});

	test("every tab has a non-empty keyword string", () => {
		for (const tab of [
			"recording",
			"model",
			"processing",
			"vocabulary",
			"output",
			"readAloud",
			"shortcuts",
			"appearance",
			"history",
			"integrations",
			"about",
		]) {
			expect(kw(tab).trim().length).toBeGreaterThan(0);
		}
	});
});
