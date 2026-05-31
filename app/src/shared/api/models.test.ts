import { describe, expect, test } from "bun:test";
import type { AudioDevice, GpuInfo, ServerStatus } from "./models";

describe("models type aliases", () => {
	test("AudioDevice can be assigned a typical shape", () => {
		const dev: AudioDevice = {
			index: 0,
			name: "Microphone",
			isDefault: true,
			maxInputChannels: 2,
		};
		expect(dev.index).toBe(0);
	});

	test("GpuInfo accepts a typical shape", () => {
		const gpu: GpuInfo = {
			name: "RTX 4090",
			available: true,
		};
		expect(gpu.available).toBe(true);
	});

	test("ServerStatus accepts canonical values", () => {
		const s1: ServerStatus = "idle";
		const s2: ServerStatus = "running";
		expect([s1, s2].length).toBe(2);
	});
});
