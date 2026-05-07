import { describe, expect, test } from "bun:test";
import { decodeSettingsPayload } from "./settings-codec";

describe("decodeSettingsPayload", () => {
	test("returns schema defaults for undefined payload", () => {
		const settings = decodeSettingsPayload(undefined);
		expect(settings.general.recordingMode).toBe("ptt");
		expect(settings.model.model).toBe("large-v2");
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
});
