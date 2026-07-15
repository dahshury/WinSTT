import { describe, expect, test } from "bun:test";
import { LANGUAGE_MISMATCH_FACTOR } from "./bang-for-buck";
import type { MemoryBudgets } from "./memory-budget";
import type { QuantCandidate } from "./per-quant-fit";
import { sttQuantCandidates } from "./per-quant-fit";
import { type SuggestModelInput, suggestModel, suggestModels } from "./suggest";

const GB = 1024 ** 3;

function budgetsOf(opts: Partial<MemoryBudgets> = {}): MemoryBudgets {
	return {
		hasGpu: true,
		ramBytes: 16 * GB,
		vramBytes: 8 * GB,
		...opts,
	};
}

function modelOf(
	opts: Partial<SuggestModelInput> & { id: string },
): SuggestModelInput {
	return {
		name: opts.id,
		baseAccuracy: 0.7,
		baseSpeed: 0.7,
		quants: [{ quant: "", bytes: 1 * GB, device: "gpu" }],
		...opts,
	};
}

describe("suggestModel", () => {
	test("no fitting quant -> not visible, no best quant, score 0", () => {
		const result = suggestModel(
			modelOf({
				id: "huge",
				quants: [{ quant: "", bytes: 64 * GB, device: "gpu" }],
			}),
			budgetsOf(),
		);
		expect(result.visible).toBe(false);
		expect(result.bestQuant).toBeNull();
		expect(result.score).toBe(0);
		expect(result.fittingQuants.size).toBe(0);
	});

	test("headline bug: big model visible with an int8-only fitting set", () => {
		const result = suggestModel(
			modelOf({
				id: "big",
				quants: sttQuantCandidates({
					estimatedBytes: 4 * GB,
					availableQuantizations: ["", "int8"],
					hasGpu: true,
				}),
			}),
			budgetsOf({ vramBytes: 2 * GB, ramBytes: 8 * GB }),
		);
		expect(result.visible).toBe(true);
		expect([...result.fittingQuants]).toEqual(["int8"]);
		expect(result.bestQuant).toBe("int8");
	});

	test("bestQuant is the highest-scoring FITTING quant, not the highest overall", () => {
		// fp16 on GPU would score best, but it doesn't fit — int8 (CPU) must win.
		const quants: QuantCandidate[] = [
			{ quant: "fp16", bytes: 12 * GB, device: "gpu" }, // > 8 GB VRAM
			{ quant: "int8", bytes: 2 * GB, device: "cpu" },
			{ quant: "q4", bytes: 1 * GB, device: "cpu" },
		];
		const result = suggestModel(modelOf({ id: "m", quants }), budgetsOf());
		expect(result.fittingQuants.has("fp16")).toBe(false);
		// int8 (accuracy -0.03, cpu speed +0.08) beats q4 (accuracy -0.08,
		// cpu speed +0.12) under the accuracy-weighted harmonic score.
		expect(result.bestQuant).toBe("int8");
	});

	test("scoreFactor de-ranks without hiding (TTS language mismatch)", () => {
		const base = modelOf({ id: "tts" });
		const matched = suggestModel(base, budgetsOf());
		const mismatched = suggestModel(
			{ ...base, scoreFactor: LANGUAGE_MISMATCH_FACTOR },
			budgetsOf(),
		);
		expect(mismatched.visible).toBe(true);
		expect(mismatched.score).toBeCloseTo(
			matched.score * LANGUAGE_MISMATCH_FACTOR,
		);
	});
});

describe("suggestModels", () => {
	test("order is bang-for-buck descending with unfit models dropped", () => {
		const result = suggestModels(
			[
				modelOf({ id: "slow-accurate", baseAccuracy: 0.9, baseSpeed: 0.05 }),
				modelOf({ id: "balanced", baseAccuracy: 0.7, baseSpeed: 0.6 }),
				modelOf({
					id: "unfit",
					baseAccuracy: 1,
					baseSpeed: 1,
					quants: [{ quant: "", bytes: 64 * GB, device: "gpu" }],
				}),
			],
			budgetsOf(),
		);
		expect(result.order).toEqual(["balanced", "slow-accurate"]);
		expect(result.byId.get("unfit")?.visible).toBe(false);
	});

	test("ties break alphabetically by display name (base sensitivity)", () => {
		const result = suggestModels(
			[modelOf({ id: "b", name: "beta" }), modelOf({ id: "a", name: "Alpha" })],
			budgetsOf(),
		);
		expect(result.order).toEqual(["a", "b"]);
	});

	test("unknown-score models (0.5 sentinel) land mid-pack, not top or bottom", () => {
		const result = suggestModels(
			[
				modelOf({ id: "good", baseAccuracy: 0.9, baseSpeed: 0.8 }),
				modelOf({ id: "unknown", baseAccuracy: 0.5, baseSpeed: 0.5 }),
				modelOf({ id: "bad", baseAccuracy: 0.2, baseSpeed: 0.2 }),
			],
			budgetsOf(),
		);
		expect(result.order).toEqual(["good", "unknown", "bad"]);
	});

	test("every model gets a verdict in byId, visible or not", () => {
		const models = [
			modelOf({ id: "x" }),
			modelOf({
				id: "y",
				quants: [{ quant: "", bytes: 64 * GB, device: "gpu" }],
			}),
		];
		const result = suggestModels(models, budgetsOf());
		expect(result.byId.size).toBe(2);
	});
});
