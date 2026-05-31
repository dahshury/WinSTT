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
	test("General keywords contain the Display section name (the reported bug)", () => {
		// End-to-end: the real General-tab keyword string, built from live
		// messages, must contain "Display" so the sidebar surfaces it.
		expect(matchesSearchQuery(kw("general"), "display")).toBe(true);
	});

	test("Model keywords pull in the LLM + TTS section terms it hosts", () => {
		const model = kw("model");
		expect(matchesSearchQuery(model, "voice")).toBe(true); // TTS
		expect(matchesSearchQuery(model, "openrouter")).toBe(true); // LLM provider
		expect(matchesSearchQuery(model, "ollama")).toBe(true); // LLM provider
		expect(matchesSearchQuery(model, "tts")).toBe(true); // acronym alias
	});

	test("Audio keywords surface VAD and the hotkey configuration", () => {
		const audio = kw("audio");
		expect(matchesSearchQuery(audio, "vad")).toBe(true);
		expect(matchesSearchQuery(audio, "configuration")).toBe(true);
	});

	test("every tab has a non-empty keyword string", () => {
		for (const tab of ["general", "model", "audio", "quality", "about"]) {
			expect(kw(tab).trim().length).toBeGreaterThan(0);
		}
	});
});
