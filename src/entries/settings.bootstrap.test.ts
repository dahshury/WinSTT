import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const HERE = import.meta.dir;

function readSettingsEntry(): string {
	return readFileSync(join(HERE, "settings.tsx"), "utf8");
}

describe("settings entry bootstrap", () => {
	test("installs the native bridge before settings hooks use IPC", () => {
		const source = readSettingsEntry();

		expect(source).toContain("installNativeBridge()");
	});

	test("hydrates GPU info for the settings compute-device selector", () => {
		const source = readSettingsEntry();

		expect(source).toContain("gpuGetInfo()");
		expect(source).toContain("setGpuInfo(info)");
	});
});
