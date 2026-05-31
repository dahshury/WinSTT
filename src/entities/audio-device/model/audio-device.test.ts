import { describe, expect, test } from "bun:test";
import type { AudioDevice } from "./audio-device";

describe("AudioDevice type alias", () => {
	test("can be assigned a typical audio-device shape", () => {
		const dev: AudioDevice = {
			index: 0,
			name: "Microphone",
			isDefault: true,
			maxInputChannels: 2,
		};
		expect(dev.name).toBe("Microphone");
	});
});
