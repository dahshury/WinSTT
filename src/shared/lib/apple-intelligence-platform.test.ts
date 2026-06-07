import { describe, expect, test } from "bun:test";
import {
	classifyAppleIntelligencePlatform,
	detectAppleIntelligencePlatform,
} from "./apple-intelligence-platform";

describe("classifyAppleIntelligencePlatform", () => {
	test("returns 'other' on Windows", () => {
		expect(
			classifyAppleIntelligencePlatform({
				platform: "Win32",
				userAgent:
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
			}),
		).toBe("other");
	});

	test("returns 'other' on Linux", () => {
		expect(
			classifyAppleIntelligencePlatform({
				platform: "Linux x86_64",
				userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0",
			}),
		).toBe("other");
	});

	test("returns 'apple-silicon' when Mac + arm tokens present", () => {
		expect(
			classifyAppleIntelligencePlatform({
				platform: "MacIntel",
				userAgent: "Mozilla/5.0 (Macintosh; ARM Mac OS X 14_0) AppleWebKit/605",
			}),
		).toBe("apple-silicon");
	});

	test("returns 'apple-silicon' when userAgentData reports arm64", () => {
		expect(
			classifyAppleIntelligencePlatform({
				platform: "macOS arm64",
				userAgent: "irrelevant",
			}),
		).toBe("apple-silicon");
	});

	test("returns 'intel-mac' on Intel Mac userAgent", () => {
		expect(
			classifyAppleIntelligencePlatform({
				platform: "MacIntel",
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605",
			}),
		).toBe("intel-mac");
	});

	test("handles empty inputs gracefully", () => {
		expect(classifyAppleIntelligencePlatform({})).toBe("other");
	});

	test("recognises 'apple silicon' phrasing", () => {
		// Some WebView/Safari builds embed the phrase verbatim
		// when running natively on M-series hardware.
		expect(
			classifyAppleIntelligencePlatform({
				platform: "MacIntel",
				userAgent: "Mozilla/5.0 (Macintosh; Apple Silicon Mac OS X 14_0)",
			}),
		).toBe("apple-silicon");
	});
});

describe("detectAppleIntelligencePlatform — guards undefined navigator", () => {
	test("returns 'other' when navigator is undefined (Node / Bun test runner)", () => {
		// Bun's `bun:test` runner doesn't expose a window/navigator by
		// default — the function MUST short-circuit safely so callers can
		// pre-compute the option list during SSR / static rendering.
		expect(detectAppleIntelligencePlatform()).toBe("other");
	});
});
