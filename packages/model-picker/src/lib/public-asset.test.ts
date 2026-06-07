import { describe, expect, test } from "bun:test";
import { resolvePublicAsset } from "./public-asset";

describe("resolvePublicAsset (model-picker copy)", () => {
	test("non-file origin (dev server) returns the absolute path unchanged", () => {
		expect(
			resolvePublicAsset(
				"/provider-icons/openai.png",
				"http:",
				"http://localhost:3000/",
			),
		).toBe("/provider-icons/openai.png");
	});

	test("file:// main window resolves against the renderer root", () => {
		expect(
			resolvePublicAsset(
				"/provider-icons/openai.png",
				"file:",
				"file:///C:/app/renderer/index.html",
			),
		).toBe("file:///C:/app/renderer/provider-icons/openai.png");
	});

	test("file:// detached picker window climbs out of windows/ to the renderer root", () => {
		expect(
			resolvePublicAsset(
				"/provider-icons/cohere.png",
				"file:",
				"file:///C:/app/renderer/windows/model-picker.html",
			),
		).toBe("file:///C:/app/renderer/provider-icons/cohere.png");
	});
});
