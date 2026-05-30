import { describe, expect, test } from "bun:test";
import { isCanvasSurface, pruneAxHtmlForLlm } from "./ax-prune";
import { APP_FIXTURES } from "./context-app-fixtures";

/**
 * Regression harness over the 22 per-app UIA fixtures produced by the
 * context-parser-app-profiles workflow. Asserts the Tier-3 pruner keeps real
 * content and drops chrome for every non-canvas app. These are SYNTHESIZED
 * fixtures; the live per-app phase validates against real captures, but this
 * locks in the pruner's behaviour so future tweaks can't silently regress an app.
 */

/** Chrome strings that must NEVER survive pruning, regardless of app. */
const UNIVERSAL_CHROME = [
	"Address and search bar",
	"Bookmark this tab",
	"New Tab",
	"Minimize",
	"Reload",
];

describe("APP_FIXTURES", () => {
	test("covers 22 apps", () => {
		expect(APP_FIXTURES.length).toBe(22);
	});
});

describe("Tier-3 pruner across app fixtures", () => {
	for (const fx of APP_FIXTURES) {
		const canvas =
			isCanvasSurface(fx.exe, undefined) ||
			fx.surfaceType === "canvas" ||
			fx.surfaceType === "grid";
		if (canvas) {
			test(`${fx.app}: canvas/grid surface — pruner yields little/no tree (OCR tier)`, () => {
				// Canvas apps route to OCR; the pruner may still surface a few chrome
				// labels, but the caller's isCanvasSurface gate suppresses the tree.
				// Here we just assert it never emits a large bogus body.
				const pruned = pruneAxHtmlForLlm(fx.exampleAxHtml);
				expect(pruned.length).toBeLessThan(200);
			});
			continue;
		}

		test(`${fx.app}: keeps real content, drops chrome`, () => {
			const pruned = pruneAxHtmlForLlm(fx.exampleAxHtml);
			// Non-trivial body for every content app.
			expect(pruned.length).toBeGreaterThanOrEqual(40);
			// Far smaller than the raw tree (the whole point).
			expect(pruned.length).toBeLessThan(fx.exampleAxHtml.length);
			// No universal browser/window chrome leaks through.
			for (const chrome of UNIVERSAL_CHROME) {
				expect(pruned).not.toContain(chrome);
			}
		});
	}
});
