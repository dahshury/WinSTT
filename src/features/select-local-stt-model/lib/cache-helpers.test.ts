import { describe, expect, test } from "bun:test";
import type { ModelCacheInfo } from "@/shared/api/ipc-client";
import { getCachePillConfig, isCached } from "./cache-helpers";

function cacheInfo(overrides: Partial<ModelCacheInfo> = {}): ModelCacheInfo {
	return {
		state: "not_cached",
		downloaded_bytes: 0,
		progress: 0,
		total_bytes: 1_000_000,
		...overrides,
	};
}

describe("getCachePillConfig", () => {
	test("returns null when cache is undefined", () => {
		expect(getCachePillConfig(undefined)).toBeNull();
	});

	test("labels a cached model as Downloaded", () => {
		const config = getCachePillConfig(cacheInfo({ state: "cached" }));
		expect(config?.label).toBe("Downloaded");
		expect(config?.className).toContain("cache-complete");
		expect(config?.icon).toBeDefined();
	});

	test("labels a partial model with a rounded percentage", () => {
		const config = getCachePillConfig(
			cacheInfo({ state: "partial", progress: 0.426 }),
		);
		expect(config?.label).toBe("43%");
		expect(config?.className).toContain("cache-partial");
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
