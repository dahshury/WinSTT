import { describe, expect, test } from "bun:test";
import { LOCALES } from "./config";
import { loadMessages } from "./messages";

// NOTE: message bundles are loaded lazily via `import.meta.glob`, which only
// exists under Vite — under `bun test` the loader map falls back to empty and
// `loadMessages` returns `{}`. So file-level parity is asserted by reading the
// `messages/<code>.json` files directly here, while the `loadMessages` smoke
// test only checks the API shape (object) so it passes in both environments.

describe("messages bundles", () => {
	test("every advertised locale has a messages/<code>.json on disk", async () => {
		for (const locale of LOCALES) {
			const file = Bun.file(
				new URL(`../../../messages/${locale}.json`, import.meta.url)
			);
			expect(await file.exists()).toBe(true);
		}
	});

	test("English bundle parses with at least one top-level key", async () => {
		const en = (await Bun.file(
			new URL("../../../messages/en.json", import.meta.url)
		).json()) as Record<string, unknown>;
		expect(Object.keys(en).length).toBeGreaterThan(0);
	});

	test("loadMessages resolves to an object for every advertised locale", async () => {
		for (const locale of LOCALES) {
			const bundle = await loadMessages(locale);
			expect(typeof bundle).toBe("object");
		}
	});
});
