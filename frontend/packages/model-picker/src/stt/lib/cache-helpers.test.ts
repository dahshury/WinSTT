import { describe, expect, test } from "bun:test";
import type { ModelCacheInfo, ModelStateEntry } from "@/shared/api/ipc-client";
import {
	getCachePillConfig,
	isCached,
	resolveEffectiveQuant,
	resolveQuantCache,
} from "./cache-helpers";

function cacheInfo(overrides: Partial<ModelCacheInfo> = {}): ModelCacheInfo {
	return {
		state: "not_cached",
		downloaded_bytes: 0,
		progress: 0,
		total_bytes: 1_000_000,
		...overrides,
	};
}

function entry(overrides: Partial<ModelStateEntry> = {}): ModelStateEntry {
	return {
		id: "m",
		estimated_bytes: 1_000_000,
		comfortable_on_cpu: true,
		comfortable_on_gpu: true,
		available_quantizations: [""],
		cache_by_quantization: {},
		cache: cacheInfo(),
		...overrides,
	};
}

describe("resolveQuantCache", () => {
	test("returns undefined when there is no entry", () => {
		expect(resolveQuantCache(undefined, "int8")).toBeUndefined();
	});

	test("prefers the per-quantization cache when present", () => {
		const quantCache = cacheInfo({ state: "cached" });
		const e = entry({ cache_by_quantization: { int8: quantCache } });
		expect(resolveQuantCache(e, "int8")).toBe(quantCache);
	});

	test("falls back to the flat cache when no per-quant entry exists", () => {
		const flat = cacheInfo({ state: "partial" });
		const e = entry({ cache: flat, cache_by_quantization: {} });
		expect(resolveQuantCache(e, "int8")).toBe(flat);
	});

	test("falls back to the flat cache when cache_by_quantization is undefined", () => {
		const flat = cacheInfo({ state: "partial" });
		const e = entry({ cache: flat });
		(e as { cache_by_quantization?: unknown }).cache_by_quantization = undefined;
		expect(resolveQuantCache(e, "int8")).toBe(flat);
	});
});

describe("resolveEffectiveQuant", () => {
	test("re-resolves the default sentinel to the server's effective precision", () => {
		// canary-1b-flash: user is on auto (""), but the server loads int8 on
		// non-CUDA. Checking "" would hit the (cached) default export and skip
		// the download prompt; we must target int8 instead.
		const e = entry({ effective_quantization: "int8" });
		expect(resolveEffectiveQuant(e, "")).toBe("int8");
	});

	test("keeps the default sentinel when the server leaves it default", () => {
		// whisper-base on auto: effective_quantization is "" (default export).
		const e = entry({ effective_quantization: "" });
		expect(resolveEffectiveQuant(e, "")).toBe("");
	});

	test("passes a concrete pick through unchanged", () => {
		const e = entry({ effective_quantization: "int8" });
		expect(resolveEffectiveQuant(e, "fp16")).toBe("fp16");
	});

	test("falls back to the raw selection when the field is absent (older server)", () => {
		const e = entry();
		expect(resolveEffectiveQuant(e, "")).toBe("");
	});

	test("falls back to the raw selection when there is no entry", () => {
		expect(resolveEffectiveQuant(undefined, "")).toBe("");
	});
});

describe("getCachePillConfig", () => {
	test("returns null when cache is undefined", () => {
		expect(getCachePillConfig(undefined)).toBeNull();
	});

	test("labels a cached model as Downloaded", () => {
		const config = getCachePillConfig(cacheInfo({ state: "cached" }));
		expect(config?.label).toBe("Downloaded");
		expect(config?.className).toContain("emerald");
		expect(config?.icon).toBeDefined();
	});

	test("labels a partial model with a rounded percentage", () => {
		const config = getCachePillConfig(cacheInfo({ state: "partial", progress: 0.426 }));
		expect(config?.label).toBe("43%");
		expect(config?.className).toContain("amber");
	});

	test("labels a not-cached model as Not downloaded", () => {
		const config = getCachePillConfig(cacheInfo({ state: "not_cached" }));
		expect(config?.label).toBe("Not downloaded");
	});
});

describe("isCached", () => {
	test("true only for the cached state", () => {
		expect(isCached(cacheInfo({ state: "cached" }))).toBe(true);
		expect(isCached(cacheInfo({ state: "partial" }))).toBe(false);
		expect(isCached(cacheInfo({ state: "not_cached" }))).toBe(false);
		expect(isCached(undefined)).toBe(false);
	});
});
