import { describe, expect, test } from "bun:test";
import { resolvePublicAsset } from "./public-asset";

describe("resolvePublicAsset", () => {
	test("non-file origin (dev server) returns the absolute path unchanged", () => {
		expect(
			resolvePublicAsset("/icon.ico", "http:", "http://localhost:3000/"),
		).toBe("/icon.ico");
		expect(
			resolvePublicAsset(
				"/provider-icons/openai.png",
				"https:",
				"https://localhost:3000/",
			),
		).toBe("/provider-icons/openai.png");
	});

	test("normalises redundant leading slashes for non-file origins", () => {
		expect(
			resolvePublicAsset("///icon.ico", "http:", "http://localhost:3000/"),
		).toBe("/icon.ico");
	});

	test("file:// main window resolves against the renderer root", () => {
		expect(
			resolvePublicAsset(
				"/icon.ico",
				"file:",
				"file:///C:/app/renderer/index.html",
			),
		).toBe("file:///C:/app/renderer/icon.ico");
	});

	test("file:// secondary window climbs out of windows/ to the renderer root", () => {
		expect(
			resolvePublicAsset(
				"/provider-icons/openai.png",
				"file:",
				"file:///C:/app/renderer/windows/model-picker.html",
			),
		).toBe("file:///C:/app/renderer/provider-icons/openai.png");
	});
});
