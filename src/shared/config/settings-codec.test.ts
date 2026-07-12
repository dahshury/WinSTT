import { describe, expect, test } from "bun:test";
import {
	decodeSettingsPayload,
	decodeSettingsWithDiagnostics,
} from "./settings-codec";

describe("decodeSettingsPayload", () => {
	test("returns schema defaults for undefined payload", () => {
		const settings = decodeSettingsPayload(undefined);
		expect(settings.general.recordingMode).toBe("ptt");
		expect(settings.model.model).toBe("tiny");
	});

	test("preserves valid payload values while filling defaults", () => {
		const settings = decodeSettingsPayload({
			general: {
				recordingMode: "toggle",
			},
		});
		expect(settings.general.recordingMode).toBe("toggle");
		expect(settings.general.minimizeToTray).toBe(true);
	});

	test("falls back to defaults for invalid payload shape", () => {
		const settings = decodeSettingsPayload("invalid");
		expect(settings.general.recordingMode).toBe("ptt");
	});

	// Regression: a main-process bug serialized `integrations.elevenlabs = ""`
	// (string) into the broadcast payload. The old "fail → return parse({})"
	// path silently reset `model.model` to the schema default ("tiny"), and
	// every receiving window then echoed tiny back, producing the
	// "switching never reaches the main window" cascade. Per-section
	// fallback means a corrupted section can't drag the rest down.
	test("one corrupt section does not cascade defaults to other sections", () => {
		const settings = decodeSettingsPayload({
			model: {
				model: "nemo-canary-180m-flash",
			},
			integrations: {
				// The exact shape the secrets-walker bug produced — string
				// where the schema expects an object.
				elevenlabs: "",
			},
		});
		// Surviving section preserves the user's pick:
		expect(settings.model.model).toBe("nemo-canary-180m-flash");
		// Corrupted section falls back to its OWN defaults, not the global:
		expect(typeof settings.integrations.elevenlabs).toBe("object");
		expect(settings.integrations.elevenlabs.apiKey).toBe("");
	});

	test("section fallback still migrates legacy model unload timeout to global", () => {
		const settings = decodeSettingsPayload({
			model: {
				modelUnloadTimeout: "hour1",
			},
			integrations: {
				elevenlabs: "",
			},
		});
		expect(settings.global.modelUnloadTimeout).toBe("hour1");
		expect("modelUnloadTimeout" in settings.model).toBe(false);
	});

	// Audit #19/#20: the OpenAI→OpenRouter STT rewrite must run on the
	// per-section recovery path too. A corrupt unrelated section forces
	// partialDecodeBySections, which previously bypassed this migration.
	test("section fallback still migrates a legacy openai STT model selection", () => {
		const settings = decodeSettingsPayload({
			model: { model: "openai:whisper-1" },
			integrations: { elevenlabs: "" },
		});
		expect(settings.model.model).toBe("openrouter:openai/whisper-1");
	});
});

describe("decodeSettingsWithDiagnostics", () => {
	test("reports no recovery for a clean payload", () => {
		const { diagnostics } = decodeSettingsWithDiagnostics({
			general: { recordingMode: "toggle" },
		});
		expect(diagnostics.defaultedSections).toEqual([]);
		expect(diagnostics.hotkeyRewrites).toEqual([]);
	});

	// Audit #45: a section that fails to parse and falls back to defaults must be
	// REPORTED so the app can warn instead of silently healing corruption into
	// permanent loss on the next save.
	test("reports the section it had to default when one is corrupt", () => {
		const { settings, diagnostics } = decodeSettingsWithDiagnostics({
			model: { model: "nemo-canary-180m-flash" },
			integrations: { elevenlabs: "" },
		});
		expect(diagnostics.defaultedSections).toContain("integrations");
		// The surviving section is untouched.
		expect(settings.model.model).toBe("nemo-canary-180m-flash");
	});

	// Audit #26: colliding hotkeys that the resolver reset must be reported.
	test("reports hotkey rewrites when a colliding hotkey is reset", () => {
		const { diagnostics } = decodeSettingsWithDiagnostics({
			hotkey: { pushToTalkKey: "LCtrl+LShift+V" },
			general: { repasteHotkey: "LCtrl+LShift+V" },
		});
		expect(diagnostics.hotkeyRewrites).toContain("repasteHotkey");
	});
});
