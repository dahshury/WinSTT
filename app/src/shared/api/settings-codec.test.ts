import { describe, expect, test } from "bun:test";
import { decodeSettingsPayload } from "./settings-codec";

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

	// Regression: a main-process bug serialized `integrations.openai = ""`
	// (string) into the broadcast payload. The old "fail → return parse({})"
	// path silently reset `model.model` to the schema default ("tiny"), and
	// every receiving window then echoed tiny back, producing the
	// "switching never reaches the main window" cascade. Per-section
	// fallback means a corrupted section can't drag the rest down.
	test("one corrupt section does not cascade defaults to other sections", () => {
		const settings = decodeSettingsPayload({
			model: {
				model: "nemo-canary-180m-flash",
				backend: "onnx_asr",
			},
			integrations: {
				// The exact shape the secrets-walker bug produced — string
				// where the schema expects an object.
				openai: "",
				elevenlabs: "",
			},
		});
		// Surviving section preserves the user's pick:
		expect(settings.model.model).toBe("nemo-canary-180m-flash");
		expect(settings.model.backend).toBe("onnx_asr");
		// Corrupted section falls back to its OWN defaults, not the global:
		expect(typeof settings.integrations.openai).toBe("object");
		expect(settings.integrations.openai.apiKey).toBe("");
	});
});
