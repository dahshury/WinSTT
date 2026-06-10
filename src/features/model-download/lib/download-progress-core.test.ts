import { describe, expect, test } from "bun:test";
import {
	mergeProgressIntoSnapshot,
	mergeSeedIntoSnapshot,
	monotonicPercent,
	percentFromFraction,
	quantDownloadSeedFromCache,
	seedDownloadedBytes,
	seedProgress,
	seedTotalBytes,
} from "./download-progress-core";

describe("percentFromFraction", () => {
	test("scales a 0–1 fraction to an integer 0–100", () => {
		expect(percentFromFraction(0.456)).toBe(46);
	});
	test("clamps below 0 and above 1", () => {
		expect(percentFromFraction(-0.5)).toBe(0);
		expect(percentFromFraction(2)).toBe(100);
	});
});

describe("monotonicPercent", () => {
	test("takes next when there is no prior observation", () => {
		expect(monotonicPercent(null, 30)).toBe(30);
		expect(monotonicPercent(undefined, 30)).toBe(30);
	});
	test("never goes backwards", () => {
		expect(monotonicPercent(60, 10)).toBe(60);
		expect(monotonicPercent(60, 80)).toBe(80);
	});
});

describe("seed scalar helpers", () => {
	test("seedProgress keeps the prior when the seed has none", () => {
		expect(
			seedProgress(40, { downloadedBytes: 0, totalBytes: 0, progress: null }),
		).toBe(40);
		expect(seedProgress(null, undefined)).toBeNull();
	});
	test("seedProgress is monotonic", () => {
		expect(
			seedProgress(40, { downloadedBytes: 0, totalBytes: 0, progress: 20 }),
		).toBe(40);
		expect(
			seedProgress(40, { downloadedBytes: 0, totalBytes: 0, progress: 70 }),
		).toBe(70);
	});
	test("seedDownloadedBytes/seedTotalBytes stay monotonic and floored", () => {
		expect(
			seedDownloadedBytes(500, {
				downloadedBytes: 300,
				totalBytes: 0,
				progress: null,
			}),
		).toBe(500);
		// total floored at downloadedBytes
		expect(
			seedTotalBytes(
				800,
				{ downloadedBytes: 0, totalBytes: 600, progress: null },
				900,
			),
		).toBe(900);
	});
});

describe("quantDownloadSeedFromCache", () => {
	test("returns undefined unless the cache is partial", () => {
		expect(quantDownloadSeedFromCache(null)).toBeUndefined();
		expect(quantDownloadSeedFromCache({ state: "cached" })).toBeUndefined();
	});
	test("caps a partial cache at 99% and reads snake_case bytes", () => {
		expect(
			quantDownloadSeedFromCache({
				state: "partial",
				downloaded_bytes: 990,
				total_bytes: 1000,
			}),
		).toEqual({ downloadedBytes: 990, totalBytes: 1000, progress: 99 });
	});
	test("derives progress from bytes when no explicit progress", () => {
		expect(
			quantDownloadSeedFromCache({
				state: "partial",
				downloadedBytes: 250,
				totalBytes: 1000,
			}),
		).toEqual({ downloadedBytes: 250, totalBytes: 1000, progress: 25 });
	});
});

describe("mergeProgressIntoSnapshot", () => {
	test("scales the fraction and keeps the bar monotonic", () => {
		const merged = mergeProgressIntoSnapshot(
			{ downloadedBytes: 600, totalBytes: 1000, progress: 60 },
			{ downloadedBytes: 100, totalBytes: 900, progress: 0.1 },
		);
		expect(merged).toEqual({
			downloadedBytes: 600,
			totalBytes: 1000,
			progress: 60,
		});
	});
	test("seeds the snapshot when there is no prior", () => {
		expect(
			mergeProgressIntoSnapshot(undefined, {
				downloadedBytes: 1200,
				totalBytes: 1000,
				progress: 1,
			}),
		).toEqual({ downloadedBytes: 1200, totalBytes: 1200, progress: 100 });
	});
});

describe("mergeSeedIntoSnapshot", () => {
	test("merges a seed into an existing snapshot monotonically", () => {
		expect(
			mergeSeedIntoSnapshot(
				{ downloadedBytes: 600, totalBytes: 1000, progress: 60 },
				{ downloadedBytes: 100, totalBytes: 900, progress: 20 },
			),
		).toEqual({ downloadedBytes: 600, totalBytes: 1000, progress: 60 });
	});
	test("uses the seed as the initial snapshot when no prior", () => {
		expect(
			mergeSeedIntoSnapshot(undefined, {
				downloadedBytes: 250,
				totalBytes: 1000,
				progress: 25,
			}),
		).toEqual({ downloadedBytes: 250, totalBytes: 1000, progress: 25 });
	});
	test("an absent seed and prior yields an empty snapshot", () => {
		expect(mergeSeedIntoSnapshot(undefined, undefined)).toEqual({
			downloadedBytes: 0,
			totalBytes: 0,
			progress: null,
		});
	});
});
