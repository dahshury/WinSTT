import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const HERE = import.meta.dir;

function readHtmlLang(): string {
	return readFileSync(join(HERE, "HtmlLang.tsx"), "utf8");
}

describe("HtmlLang bootstrap", () => {
	test("initializes the STT catalog after installing the native bridge", () => {
		const source = readHtmlLang();

		const bridgeInstallIndex = source.indexOf("installNativeBridge();");
		const catalogInitIndex = source.indexOf("initCatalogStore();");

		expect(bridgeInstallIndex).toBeGreaterThanOrEqual(0);
		expect(catalogInitIndex).toBeGreaterThan(bridgeInstallIndex);
	});
});
