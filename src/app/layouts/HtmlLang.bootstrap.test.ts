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
	test("initializes the STT catalog after native runtime setup", () => {
		const source = readHtmlLang();

		const runtimeInitIndex = source.indexOf("initializeNativeRuntime();");
		const catalogInitIndex = source.indexOf("initCatalogStore();");

		expect(runtimeInitIndex).toBeGreaterThanOrEqual(0);
		expect(catalogInitIndex).toBeGreaterThan(runtimeInitIndex);
	});

	// Regression guard: shared runtime effects must register synchronously at module
	// load. Domain listeners themselves now call Tauri directly and cannot lose a
	// subscription while waiting for a global bridge installation.
	test("initializes the native runtime synchronously", () => {
		const source = readHtmlLang();

		expect(source).toContain(
			'import { initializeNativeRuntime } from "@/shared/api/native-runtime"',
		);
		expect(source).not.toContain("native-bridge-adapter");
		const runtimeInitIndex = source.indexOf("initializeNativeRuntime();");
		expect(runtimeInitIndex).toBeGreaterThanOrEqual(0);
		expect(source.slice(0, runtimeInitIndex)).not.toMatch(/(^|\n)\s*await\b/);
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
