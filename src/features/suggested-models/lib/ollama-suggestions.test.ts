import { describe, expect, it } from "bun:test";
import type { MemoryBudgets } from "@/entities/model-suggestion";
import {
	buildOllamaSuggestions,
	ollamaParamCountB,
} from "./ollama-suggestions";

const GB = 1024 ** 3;

const budgets = (overrides: Partial<MemoryBudgets>): MemoryBudgets => ({
	hasGpu: false,
	ramBytes: 0,
	vramBytes: 0,
	...overrides,
});

describe("ollamaParamCountB", () => {
	it("parses billion labels", () => {
		expect(ollamaParamCountB("4B")).toBe(4);
		expect(ollamaParamCountB("1.2b")).toBe(1.2);
	});

	it("parses million labels and Gemma effective sizes", () => {
		expect(ollamaParamCountB("540M")).toBeCloseTo(0.54);
		expect(ollamaParamCountB("e2b")).toBe(2);
	});

	it("returns 0 for unknown/unparseable labels", () => {
		expect(ollamaParamCountB(null)).toBe(0);
		expect(ollamaParamCountB("")).toBe(0);
		expect(ollamaParamCountB("mini")).toBe(0);
	});
});

describe("buildOllamaSuggestions().fits — either-pool rule (plan 3.3)", () => {
	it("fits when the RAM budget covers it even though VRAM does not", () => {
		// A big-RAM / small-VRAM box: the legacy VRAM-only warning-chip rule
		// would reject this — Suggested must not (Ollama CPU/partial offload).
		const s = buildOllamaSuggestions(
			budgets({ hasGpu: true, vramBytes: 8 * GB, ramBytes: 44 * GB }),
		);
		expect(s.fits(20 * GB)).toBe(true);
	});

	it("fits when only the VRAM budget covers it", () => {
		const s = buildOllamaSuggestions(
			budgets({ hasGpu: true, vramBytes: 16 * GB, ramBytes: 4 * GB }),
		);
		expect(s.fits(10 * GB)).toBe(true);
	});

	it("rejects when neither pool covers the runtime footprint", () => {
		const s = buildOllamaSuggestions(
			budgets({ hasGpu: true, vramBytes: 8 * GB, ramBytes: 8 * GB }),
		);
		// 20 GB GGUF × headroom exceeds both pools.
		expect(s.fits(20 * GB)).toBe(false);
	});

	it("applies the KV/activation headroom (a GGUF at exactly the budget fails)", () => {
		const s = buildOllamaSuggestions(budgets({ ramBytes: 8 * GB }));
		expect(s.fits(8 * GB)).toBe(false);
	});

	it("stays lenient on unknown sizes", () => {
		const s = buildOllamaSuggestions(budgets({}));
		expect(s.fits(0)).toBe(true);
		expect(s.fits(-1)).toBe(true);
	});
});

describe("buildOllamaSuggestions().score — proxy ranking (plan 3.4)", () => {
	const s = buildOllamaSuggestions(
		budgets({ hasGpu: true, vramBytes: 16 * GB, ramBytes: 44 * GB }),
	);
	const score = (paramSizeLabel: string, sizeBytes: number, name = "m:x") =>
		s.score({ displayName: name, name, paramSizeLabel, sizeBytes });

	it("prefers more parameters at equal footprint (log-param accuracy proxy)", () => {
		expect(score("8B", 5 * GB)).toBeGreaterThan(score("2B", 5 * GB));
	});

	it("prefers a smaller footprint at equal parameters (pool-occupancy speed proxy)", () => {
		expect(score("8B", 5 * GB)).toBeGreaterThan(score("8B", 12 * GB));
	});

	it("scores 0 for a model whose only candidate does not fit", () => {
		const tiny = buildOllamaSuggestions(budgets({ ramBytes: 2 * GB }));
		expect(
			tiny.score({
				displayName: "Big",
				name: "big:70b",
				paramSizeLabel: "70B",
				sizeBytes: 40 * GB,
			}),
		).toBe(0);
	});

	it("ranks a fitting q8 tag above the same-size q4 default (tier flows through)", () => {
		// Same bytes + params: only the quant tier differs; the int8 tier's
		// smaller accuracy penalty must beat q4's larger speed bonus in the
		// accuracy-weighted harmonic mean. (12B, not 8B — the 8B midpoint maps
		// to the 0.5 unknown sentinel, which passes through tiers untouched.)
		expect(score("12B", 6 * GB, "m:12b-q8_0")).toBeGreaterThan(
			score("12B", 6 * GB, "m:12b"),
		);
	});
});
