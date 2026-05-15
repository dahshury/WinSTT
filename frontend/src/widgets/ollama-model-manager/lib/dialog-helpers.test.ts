import { describe, expect, test } from "bun:test";
import type { OllamaPullProgress } from "@/shared/api/models";
import { buildPullsMap, computePullPercent, pullStatusToI18nKey } from "./dialog-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProgress(overrides: Partial<OllamaPullProgress> = {}): OllamaPullProgress {
	return {
		model: "llama3.2:1b",
		status: "pulling",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// pullStatusToI18nKey
// ---------------------------------------------------------------------------

describe("pullStatusToI18nKey", () => {
	test("maps downloading → pullStatusDownloading", () => {
		expect(pullStatusToI18nKey("downloading")).toBe("pullStatusDownloading");
	});

	test("maps verifying → pullStatusVerifying", () => {
		expect(pullStatusToI18nKey("verifying")).toBe("pullStatusVerifying");
	});

	test("maps writing → pullStatusWriting", () => {
		expect(pullStatusToI18nKey("writing")).toBe("pullStatusWriting");
	});

	test("maps success → pullStatusSuccess", () => {
		expect(pullStatusToI18nKey("success")).toBe("pullStatusSuccess");
	});

	test("maps pulling → pullStatusPulling (default)", () => {
		expect(pullStatusToI18nKey("pulling")).toBe("pullStatusPulling");
	});

	test("maps error → pullStatusPulling (default fallback)", () => {
		expect(pullStatusToI18nKey("error")).toBe("pullStatusPulling");
	});

	test("maps cancelled → pullStatusPulling (default fallback)", () => {
		expect(pullStatusToI18nKey("cancelled")).toBe("pullStatusPulling");
	});

	test("maps undefined → pullStatusPulling (default fallback)", () => {
		expect(pullStatusToI18nKey(undefined)).toBe("pullStatusPulling");
	});
});

// ---------------------------------------------------------------------------
// computePullPercent
// ---------------------------------------------------------------------------

describe("computePullPercent", () => {
	test("returns 0 when percent is undefined", () => {
		expect(computePullPercent(makeProgress({ percent: undefined }))).toBe(0);
	});

	test("returns 0 when percent is 0", () => {
		expect(computePullPercent(makeProgress({ percent: 0 }))).toBe(0);
	});

	test("rounds 50.4 to 50", () => {
		expect(computePullPercent(makeProgress({ percent: 50.4 }))).toBe(50);
	});

	test("rounds 50.5 to 51", () => {
		expect(computePullPercent(makeProgress({ percent: 50.5 }))).toBe(51);
	});

	test("returns 100 for complete progress", () => {
		expect(computePullPercent(makeProgress({ percent: 100 }))).toBe(100);
	});

	test("handles integer percent", () => {
		expect(computePullPercent(makeProgress({ percent: 75 }))).toBe(75);
	});
});

// ---------------------------------------------------------------------------
// buildPullsMap
// ---------------------------------------------------------------------------

describe("buildPullsMap", () => {
	test("returns empty object for empty input", () => {
		expect(buildPullsMap({})).toEqual({});
	});

	test("extracts progress from a single entry", () => {
		const progress = makeProgress({ status: "downloading", percent: 42 });
		const result = buildPullsMap({
			"llama3.2:1b": { progress, startedAt: 1000 },
		});
		expect(result["llama3.2:1b"]).toBe(progress);
	});

	test("extracts progress from multiple entries", () => {
		const p1 = makeProgress({ model: "llama3.2:1b", status: "downloading" });
		const p2 = makeProgress({ model: "gemma3:4b", status: "verifying" });
		const result = buildPullsMap({
			"llama3.2:1b": { progress: p1, startedAt: 1000 },
			"gemma3:4b": { progress: p2, startedAt: 2000 },
		});
		expect(result["llama3.2:1b"]).toBe(p1);
		expect(result["gemma3:4b"]).toBe(p2);
		expect(Object.keys(result)).toHaveLength(2);
	});

	test("discards startedAt metadata", () => {
		const progress = makeProgress();
		const result = buildPullsMap({
			"llama3.2:1b": { progress, startedAt: 9999 },
		});
		expect("startedAt" in (result["llama3.2:1b"] ?? {})).toBe(false);
	});

	test("result is a plain object (not same reference as input)", () => {
		const pulls = { "llama3.2:1b": { progress: makeProgress(), startedAt: 0 } };
		const result = buildPullsMap(pulls);
		expect(result).not.toBe(pulls);
	});
});
