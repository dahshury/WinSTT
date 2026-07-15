import { describe, expect, test } from "bun:test";
import {
	bangForBuck,
	OLLAMA_PARAM_LOG_MIDPOINT_B,
	ollamaProxyAccuracy,
	ollamaProxySpeed,
} from "./bang-for-buck";
import { UNKNOWN_SCORE_SENTINEL } from "./quant-tiers";

const GB = 1024 ** 3;

describe("bangForBuck", () => {
	test("harmonic form punishes near-zero speed: 0.9/0.05 ranks below 0.7/0.6", () => {
		expect(bangForBuck(0.9, 0.05)).toBeLessThan(bangForBuck(0.7, 0.6));
	});

	test("beta = 0.5 weights accuracy 2x speed: swapping favors accuracy", () => {
		expect(bangForBuck(0.9, 0.6)).toBeGreaterThan(bangForBuck(0.6, 0.9));
	});

	test("equal inputs return that value (mean identity)", () => {
		expect(bangForBuck(0.5, 0.5)).toBeCloseTo(0.5);
		expect(bangForBuck(1, 1)).toBeCloseTo(1);
	});

	test("zero speed or zero accuracy scores 0", () => {
		expect(bangForBuck(0.9, 0)).toBe(0);
		expect(bangForBuck(0, 0.9)).toBe(0);
		expect(bangForBuck(0, 0)).toBe(0);
	});

	test("monotonic in both inputs", () => {
		expect(bangForBuck(0.8, 0.6)).toBeGreaterThan(bangForBuck(0.7, 0.6));
		expect(bangForBuck(0.8, 0.6)).toBeGreaterThan(bangForBuck(0.8, 0.5));
	});
});

describe("ollamaProxyAccuracy", () => {
	test("monotonically increasing in param count", () => {
		expect(ollamaProxyAccuracy(1)).toBeLessThan(ollamaProxyAccuracy(4));
		expect(ollamaProxyAccuracy(4)).toBeLessThan(ollamaProxyAccuracy(8));
		expect(ollamaProxyAccuracy(8)).toBeLessThan(ollamaProxyAccuracy(70));
	});

	test("midpoint param count scores exactly 0.5", () => {
		expect(ollamaProxyAccuracy(OLLAMA_PARAM_LOG_MIDPOINT_B)).toBe(0.5);
	});

	test("clamped to [0, 1] at the extremes", () => {
		expect(ollamaProxyAccuracy(0.01)).toBe(0);
		expect(ollamaProxyAccuracy(100_000)).toBe(1);
	});

	test("unknown param count lands mid-pack at the sentinel", () => {
		expect(ollamaProxyAccuracy(0)).toBe(UNKNOWN_SCORE_SENTINEL);
		expect(ollamaProxyAccuracy(-1)).toBe(UNKNOWN_SCORE_SENTINEL);
	});
});

describe("ollamaProxySpeed", () => {
	test("monotonically decreasing in required bytes", () => {
		const budget = 16 * GB;
		expect(ollamaProxySpeed(2 * GB, budget)).toBeGreaterThan(
			ollamaProxySpeed(8 * GB, budget),
		);
		expect(ollamaProxySpeed(8 * GB, budget)).toBeGreaterThan(
			ollamaProxySpeed(15 * GB, budget),
		);
	});

	test("clamped at 0 when the model exceeds the pool", () => {
		expect(ollamaProxySpeed(32 * GB, 16 * GB)).toBe(0);
	});

	test("zero budget scores 0", () => {
		expect(ollamaProxySpeed(2 * GB, 0)).toBe(0);
	});

	test("unknown size lands mid-pack at the sentinel", () => {
		expect(ollamaProxySpeed(0, 16 * GB)).toBe(UNKNOWN_SCORE_SENTINEL);
	});
});
