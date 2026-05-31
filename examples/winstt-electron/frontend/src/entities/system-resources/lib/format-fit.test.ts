import { describe, expect, test } from "bun:test";
import type { FitAssessmentEntry, FitSeverity, FitTarget } from "@/shared/api/ipc-client";
import { __format_fit_test_helpers__, badgeFor, rowHint } from "./format-fit";

const { hasUsableFootprint, labelBytes, targetLabel } = __format_fit_test_helpers__;

function entry(opts: Partial<FitAssessmentEntry> = {}): FitAssessmentEntry {
	return {
		severity: opts.severity ?? "ok",
		target: opts.target ?? "gpu",
		required_bytes: opts.required_bytes ?? 0,
		available_bytes: opts.available_bytes ?? 0,
		reasons: opts.reasons ?? [],
	};
}

/** Simple translator that echoes the key + serialized vars for assertion. */
function translator(key: string, vars?: Record<string, string | number>): string {
	if (!vars) {
		return key;
	}
	const parts = Object.entries(vars)
		.map(([k, v]) => `${k}=${v}`)
		.join(",");
	return `${key}(${parts})`;
}

describe("hasUsableFootprint", () => {
	test("returns false for null", () => {
		expect(hasUsableFootprint(null)).toBe(false);
	});

	test("returns false when required_bytes is 0", () => {
		expect(hasUsableFootprint(entry({ required_bytes: 0 }))).toBe(false);
	});

	test("returns false when required_bytes is negative", () => {
		expect(hasUsableFootprint(entry({ required_bytes: -1 }))).toBe(false);
	});

	test("returns true when required_bytes is positive", () => {
		expect(hasUsableFootprint(entry({ required_bytes: 1024 * 1024 }))).toBe(true);
	});
});

describe("labelBytes", () => {
	test("formats a positive byte count with MB minimum", () => {
		const out = labelBytes(600 * 1024 * 1024);
		expect(out).toBe("600 MB");
	});

	test("formats GB-scale values", () => {
		const out = labelBytes(2 * 1024 ** 3);
		// gbDecimals default = 1
		expect(out).toContain("GB");
	});

	test("returns sentinel '?' for zero (non-positive input)", () => {
		expect(labelBytes(0)).toBe("?");
	});

	test("returns sentinel '?' for negative input", () => {
		expect(labelBytes(-100)).toBe("?");
	});

	test("returns sentinel '?' for NaN", () => {
		expect(labelBytes(Number.NaN)).toBe("?");
	});
});

describe("targetLabel", () => {
	test.each<[FitTarget, string]>([
		["gpu", "targetGpu"],
		["cpu", "targetCpu"],
		["neither", "targetNeither"],
	])("maps %s → %s", (target, key) => {
		expect(targetLabel(target, translator)).toBe(key);
	});
});

describe("rowHint", () => {
	test("returns empty string for null assessment", () => {
		expect(rowHint(null, translator)).toBe("");
	});

	test("returns empty string when footprint is unknown (required=0)", () => {
		expect(rowHint(entry({ required_bytes: 0 }), translator)).toBe("");
	});

	const HINT_KEY_FOR: Record<FitSeverity, string> = {
		ok: "rowHintOk",
		warning: "rowHintWarning",
		critical: "rowHintCritical",
	};

	test.each<FitSeverity>([
		"ok",
		"warning",
		"critical",
	])("renders severity-specific hint key for %s", (severity) => {
		const out = rowHint(
			entry({
				severity,
				target: "gpu",
				required_bytes: 600 * 1024 * 1024,
				available_bytes: 24 * 1024 ** 3,
			}),
			translator
		);
		expect(out).toContain(HINT_KEY_FOR[severity]);
		expect(out).toContain("req=");
		expect(out).toContain("avail=");
		expect(out).toContain("target=targetGpu");
	});

	test("includes target label for cpu", () => {
		const out = rowHint(
			entry({
				severity: "warning",
				target: "cpu",
				required_bytes: 12 * 1024 ** 3,
				available_bytes: 16 * 1024 ** 3,
			}),
			translator
		);
		expect(out).toContain("target=targetCpu");
	});
});

describe("badgeFor", () => {
	test("returns null when no assessment", () => {
		expect(badgeFor(null)).toBeNull();
	});

	test("returns severity-specific badge", () => {
		const badge = badgeFor(entry({ severity: "warning" }));
		expect(badge?.severity).toBe("warning");
		expect(badge?.tone).toBe("warning");
	});
});
