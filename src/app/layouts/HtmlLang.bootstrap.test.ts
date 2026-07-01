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

	// Regression guard: the native bridge MUST be installed synchronously at module
	// load, before any sibling module in a window's import graph evaluates. Some
	// stores subscribe to main→renderer push events at module-load time
	// (e.g. llm-catalog-store's onOllamaPullProgress); an async install (top-level
	// `await` / `await import(... native-bridge-adapter ...)`) lets them evaluate
	// first while window.nativeBridge is still null, so their on() calls no-op —
	// the bug behind "Ollama download stuck at 0% / combobox never shows downloading".
	test("installs the native bridge synchronously (statically imported, no await before the call)", () => {
		const source = readHtmlLang();

		// Statically imported (so the call is a synchronous module-load side effect).
		expect(source).toContain(
			'import { installNativeBridge } from "@/shared/api/native-bridge-adapter"',
		);
		// Never dynamically imported / awaited — that is what reintroduces the race.
		expect(source).not.toMatch(/await\s+import\([^)]*native-bridge-adapter/);
		// No top-level await precedes the install call.
		const bridgeInstallIndex = source.indexOf("installNativeBridge();");
		expect(bridgeInstallIndex).toBeGreaterThanOrEqual(0);
		const beforeInstall = source.slice(0, bridgeInstallIndex);
		expect(beforeInstall).not.toMatch(/(^|\n)\s*await\b/);
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
