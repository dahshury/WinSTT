import { describe, expect, test } from "bun:test";
import { fontWeights } from "./font-weight";

describe("fontWeights", () => {
	test("exposes variation-settings strings for each weight", () => {
		expect(fontWeights.normal).toBe('"wght" 400');
		expect(fontWeights.medium).toBe('"wght" 450');
		expect(fontWeights.semibold).toBe('"wght" 550');
		expect(fontWeights.bold).toBe('"wght" 700');
	});
});
