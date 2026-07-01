import { describe, expect, test } from "bun:test";
import type { ModelCacheInfo, ModelStateEntry } from "@/shared/api/ipc-client";
import { resolveEffectiveQuant, resolveQuantCache } from "./quant-cache";

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
		(e as { cache_by_quantization?: unknown }).cache_by_quantization =
			undefined;
		expect(resolveQuantCache(e, "int8")).toBe(flat);
	});
});

describe("resolveEffectiveQuant", () => {
	test("re-resolves the auto sentinel to the server's effective precision", () => {
		// canary-1b-flash: user is on "auto", but the server loads int8 on non-CUDA.
		// Checking the auto sentinel directly would skip the download prompt; we must
		// target the resolved int8 instead.
		const e = entry({ effective_quantization: "int8" });
		expect(resolveEffectiveQuant(e, "auto")).toBe("int8");
	});

	test("resolves the auto sentinel to fp32 when that IS the recommended pick", () => {
		// whisper-base on a roomy machine: effective_quantization is "" (fp32). The
		// empty string is falsy, so this guards against a truthiness regression — auto
		// must still resolve to "" (fp32), not pass the raw "auto" through.
		const e = entry({ effective_quantization: "" });
		expect(resolveEffectiveQuant(e, "auto")).toBe("");
	});

	test("passes a concrete pick through unchanged (incl fp32)", () => {
		const e = entry({ effective_quantization: "int8" });
		expect(resolveEffectiveQuant(e, "fp16")).toBe("fp16");
		// "" is now EXPLICIT fp32, a concrete pick — NOT re-resolved to effective.
		expect(resolveEffectiveQuant(e, "")).toBe("");
	});

	test("falls back to the raw auto sentinel when the field is absent (older server)", () => {
		const e = entry();
		expect(resolveEffectiveQuant(e, "auto")).toBe("auto");
	});

	test("falls back to the raw selection when there is no entry", () => {
		expect(resolveEffectiveQuant(undefined, "auto")).toBe("auto");
	});
});
