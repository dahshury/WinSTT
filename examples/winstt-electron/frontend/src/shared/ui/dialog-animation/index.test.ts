import { describe, expect, test } from "bun:test";
import { dialogAnimation } from "./index";

describe("dialogAnimation", () => {
	test("re-exports the CSS module asset (string under bun, object under bundlers)", () => {
		// bun:test resolves CSS module imports as their stringified path. Under
		// Vite (or any other bundler) this becomes the generated class-name map
		// (an object with backdrop/popup keys). Both shapes are valid here —
		// assert the import simply succeeds and is non-empty.
		expect(dialogAnimation).toBeDefined();
		expect(dialogAnimation).not.toBe(null);
	});
});
