import { describe, expect, test } from "bun:test";
import { DEMO_PREVIEW_BASE, demoPreviewUrl } from "./demo-preview";

describe("demoPreviewUrl", () => {
	test("resolves a demo name to its remote .webm URL on the docs CDN", () => {
		expect(demoPreviewUrl("ptt")).toBe("https://winstt.app/demos/ptt.webm");
		expect(demoPreviewUrl("ptt")).toBe(`${DEMO_PREVIEW_BASE}/ptt.webm`);
	});

	test("passes the name through verbatim (no encoding/normalization)", () => {
		expect(demoPreviewUrl("llm-dictation")).toBe(
			`${DEMO_PREVIEW_BASE}/llm-dictation.webm`,
		);
	});
});
