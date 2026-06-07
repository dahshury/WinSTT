import { describe, expect, test } from "bun:test";
import {
	errorMessage,
	errorPatch,
	snapshotPatch,
} from "./system-resources-store";

describe("errorMessage", () => {
	test("returns the message of an Error instance", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
	});

	test("returns 'unknown' for a non-Error value", () => {
		expect(errorMessage("some string")).toBe("unknown");
	});

	test("returns 'unknown' for null", () => {
		expect(errorMessage(null)).toBe("unknown");
	});

	test("returns 'unknown' for an arbitrary object", () => {
		expect(errorMessage({ code: 42 })).toBe("unknown");
	});

	test("preserves message from a TypeError subclass instance", () => {
		expect(errorMessage(new TypeError("bad type"))).toBe("bad type");
	});
});

describe("errorPatch", () => {
	test("wraps an Error message into an isLoading=false patch", () => {
		const patch = errorPatch(new Error("nope"));
		expect(patch.isLoading).toBe(false);
		expect(patch.error).toBe("nope");
	});

	test("uses 'unknown' for non-Error inputs", () => {
		const patch = errorPatch(42);
		expect(patch.error).toBe("unknown");
	});
});

describe("snapshotPatch", () => {
	test("null snapshot patches error='no-snapshot' and clears loading", () => {
		const patch = snapshotPatch(null);
		expect(patch.liveResources).toBeNull();
		expect(patch.isLoading).toBe(false);
		expect(patch.error).toBe("no-snapshot");
		expect(typeof patch.lastFetchedAt).toBe("number");
	});

	test("valid snapshot patches liveResources + clears error", () => {
		const snapshot = {
			ram_total_bytes: 16 * 1024 ** 3,
			ram_available_bytes: 8 * 1024 ** 3,
			cpu_count_logical: 8,
			cpu_count_physical: 4,
			cpu_percent: 5,
			gpus: [],
		};
		const patch = snapshotPatch(snapshot);
		expect(patch.liveResources).toBe(snapshot);
		expect(patch.error).toBeNull();
		expect(patch.isLoading).toBe(false);
	});
});
