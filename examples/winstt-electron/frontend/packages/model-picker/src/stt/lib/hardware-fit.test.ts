import { describe, expect, test } from "bun:test";
import type { FitAssessmentEntry, ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import { isUncomfortable, severityFor } from "./hardware-fit";

function assessment(severity: FitAssessmentEntry["severity"]): FitAssessmentEntry {
	return {
		severity,
		target: "gpu",
		required_bytes: 1,
		available_bytes: 1,
		reasons: [],
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
		cache: { state: "not_cached", downloaded_bytes: 0, progress: 0, total_bytes: 1 },
		...overrides,
	};
}

function sys(gpuCount = 0): SystemInfoEntry {
	return {
		total_ram_bytes: 16_000_000_000,
		gpus: Array.from({ length: gpuCount }, (_, i) => ({
			name: `GPU${i}`,
			total_vram_bytes: 8_000_000_000,
		})),
	};
}

describe("isUncomfortable", () => {
	test("false when there is no state entry", () => {
		expect(isUncomfortable(undefined, sys(1))).toBe(false);
	});

	test("false when the footprint is unknown (estimated_bytes <= 0)", () => {
		expect(isUncomfortable(entry({ estimated_bytes: 0 }), sys(1))).toBe(false);
	});

	test("false when comfortable on CPU regardless of GPU", () => {
		expect(
			isUncomfortable(entry({ comfortable_on_cpu: true, comfortable_on_gpu: false }), null)
		).toBe(false);
	});

	test("false when a GPU is present and comfortable on GPU", () => {
		expect(
			isUncomfortable(entry({ comfortable_on_cpu: false, comfortable_on_gpu: true }), sys(1))
		).toBe(false);
	});

	test("true when fits nowhere with no GPU", () => {
		expect(
			isUncomfortable(entry({ comfortable_on_cpu: false, comfortable_on_gpu: true }), null)
		).toBe(true);
	});

	test("true when fits nowhere with a GPU present but not GPU-comfortable", () => {
		expect(
			isUncomfortable(entry({ comfortable_on_cpu: false, comfortable_on_gpu: false }), sys(1))
		).toBe(true);
	});

	test("treats an empty gpus array as no GPU", () => {
		expect(
			isUncomfortable(entry({ comfortable_on_cpu: false, comfortable_on_gpu: true }), sys(0))
		).toBe(true);
	});

	test("live assessment wins over static comfortable flags (critical)", () => {
		// comfortable_on_* says fine, but the live verdict is critical.
		expect(
			isUncomfortable(
				entry({ comfortable_on_cpu: true, comfortable_on_gpu: true }),
				sys(1),
				assessment("critical")
			)
		).toBe(true);
	});

	test("live assessment wins over static comfortable flags (ok)", () => {
		// comfortable_on_* says won't fit, but live verdict says ok.
		expect(
			isUncomfortable(
				entry({ comfortable_on_cpu: false, comfortable_on_gpu: false }),
				sys(1),
				assessment("ok")
			)
		).toBe(false);
	});
});

describe("severityFor", () => {
	test("returns live severity when provided", () => {
		expect(severityFor(entry(), sys(1), assessment("warning"))).toBe("warning");
	});

	test("falls back to binary uncomfortable when no live data", () => {
		expect(severityFor(entry({ comfortable_on_cpu: false, comfortable_on_gpu: false }), null)).toBe(
			"critical"
		);
		expect(severityFor(entry({ comfortable_on_cpu: true, comfortable_on_gpu: true }), sys(1))).toBe(
			"ok"
		);
	});
});
