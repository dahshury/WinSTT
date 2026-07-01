import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const HERE = import.meta.dir;

function readSettingsEntry(): string {
	return readFileSync(join(HERE, "settings.tsx"), "utf8");
}

describe("settings entry bootstrap", () => {
	test("uses HtmlLang as the shared native bridge bootstrap", () => {
		const source = readSettingsEntry();

		expect(source).toContain("<HtmlLang />");
		expect(source).not.toContain("installNativeBridge()");
	});

	test("hydrates GPU info for the settings compute-device selector", () => {
		const source = readSettingsEntry();

		expect(source).toContain("useGpuInfo()");
		expect(source).toContain('from "@/entities/connection"');
	});
});
