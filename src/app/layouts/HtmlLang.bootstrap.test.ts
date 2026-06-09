import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const HERE = import.meta.dir;
const ENTRIES_DIR = join(HERE, "..", "..", "entries");

function readHtmlLang(): string {
	return readFileSync(join(HERE, "HtmlLang.tsx"), "utf8");
}

function readEntry(entry: string): string {
	return readFileSync(join(ENTRIES_DIR, entry), "utf8");
}

describe("HtmlLang bootstrap", () => {
	test("initializes the STT catalog after installing the native bridge", () => {
		const source = readHtmlLang();

		const bridgeInstallIndex = source.indexOf("installNativeBridge();");
		const catalogInitIndex = source.indexOf("initCatalogStore();");

		expect(bridgeInstallIndex).toBeGreaterThanOrEqual(0);
		expect(catalogInitIndex).toBeGreaterThan(bridgeInstallIndex);
	});

	test("is mounted by every window entry", () => {
		const entries = readdirSync(ENTRIES_DIR)
			.filter((entry) => entry.endsWith(".tsx"))
			.sort();

		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			expect(readEntry(entry)).toContain("<HtmlLang />");
		}
	});
});
