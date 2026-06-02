import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { matchesSearchQuery, useSettingsSearchKeywords } from "./settings-search";

function wrapper({ children }: { children: ReactNode }) {
	return <IntlProvider>{children}</IntlProvider>;
}

// Resolve a single tab's keyword string from the real i18n-backed hook.
function kw(tab: string): string {
	return renderHook(() => useSettingsSearchKeywords(), { wrapper }).result.current[tab] ?? "";
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
		expect(matchesSearchQuery(processing, "formatting")).toBe(true); // formatting section
	});

	test("Output keywords surface text-to-speech and paste behavior", () => {
		const output = kw("output");
		expect(matchesSearchQuery(output, "voice")).toBe(true); // TTS
		expect(matchesSearchQuery(output, "tts")).toBe(true); // acronym alias
		expect(matchesSearchQuery(output, "paste")).toBe(true); // paste behavior
	});

	test("Recording keywords surface VAD and the recording mode", () => {
		const recording = kw("recording");
		expect(matchesSearchQuery(recording, "vad")).toBe(true);
		expect(matchesSearchQuery(recording, "endpoint")).toBe(true);
	});

	test("Shortcuts keywords surface the hotkey configuration", () => {
		expect(matchesSearchQuery(kw("shortcuts"), "configuration")).toBe(true);
	});

	test("every tab has a non-empty keyword string", () => {
		for (const tab of [
			"recording",
			"model",
			"processing",
			"vocabulary",
			"output",
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
