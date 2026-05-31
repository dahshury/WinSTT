import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@/entities/model-catalog";
import { isRealtimeViable, parseSizeLabel } from "./realtime-viability";

function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
	return {
		id: "m",
		displayName: "M",
		family: "whisper",
		backend: "faster_whisper",
		languages: ["en"],
		supportsLanguageDetection: true,
		sizeLabel: "39M",
		supportsRealtime: true,
		onnxModelName: null,
		description: "",
		availableQuantizations: [""],
		...overrides,
	} as ModelInfo;
}

describe("parseSizeLabel", () => {
	test("parses M-suffixed labels to millions", () => {
		expect(parseSizeLabel("39M")).toBe(39_000_000);
		expect(parseSizeLabel("244M")).toBe(244_000_000);
	});

	test("parses B-suffixed labels to billions (case-insensitive)", () => {
		expect(parseSizeLabel("1.5B")).toBe(1_500_000_000);
		expect(parseSizeLabel("1.5b")).toBe(1_500_000_000);
	});

	test("handles fractional M values", () => {
		expect(parseSizeLabel("0.6M")).toBe(600_000);
	});

	test("returns null when the label does not match the size pattern", () => {
		expect(parseSizeLabel("")).toBeNull();
		expect(parseSizeLabel("abc")).toBeNull();
		expect(parseSizeLabel("39")).toBeNull();
		expect(parseSizeLabel("39MB")).toBeNull();
	});

	test("returns null when the numeric portion is not finite", () => {
		// "." matches [\d.]+ but parses to NaN.
		expect(parseSizeLabel(".M")).toBeNull();
	});
});

describe("isRealtimeViable", () => {
	test("false when the catalog flag is off", () => {
		expect(isRealtimeViable(model({ supportsRealtime: false }))).toBe(false);
	});

	test("true for a small, realtime-flagged model", () => {
		expect(isRealtimeViable(model({ sizeLabel: "39M" }))).toBe(true);
	});

	test("true at exactly the threshold", () => {
		expect(isRealtimeViable(model({ sizeLabel: "700M" }))).toBe(true);
	});

	test("false above the parameter threshold", () => {
		expect(isRealtimeViable(model({ sizeLabel: "769M" }))).toBe(false);
		expect(isRealtimeViable(model({ sizeLabel: "1.5B" }))).toBe(false);
	});

	test("falls back to the catalog flag when the label is unparseable", () => {
		expect(isRealtimeViable(model({ sizeLabel: "" }))).toBe(true);
		expect(isRealtimeViable(model({ sizeLabel: "unknown" }))).toBe(true);
	});
});
