import { describe, expect, test } from "bun:test";
import { formatBytes } from "./format-bytes";

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

describe("formatBytes", () => {
	test("returns null for non-positive / non-finite / nullish input", () => {
		expect(formatBytes(0)).toBeNull();
		expect(formatBytes(-1)).toBeNull();
		expect(formatBytes(Number.NaN)).toBeNull();
		expect(formatBytes(Number.POSITIVE_INFINITY)).toBeNull();
		expect(formatBytes(null)).toBeNull();
		expect(formatBytes(undefined)).toBeNull();
	});

	test("default options: sub-GB rounded to integer MB (no KB/B)", () => {
		expect(formatBytes(423 * MIB)).toBe("423 MB");
		expect(formatBytes(MIB)).toBe("1 MB");
		expect(formatBytes(1.4 * MIB)).toBe("1 MB");
		expect(formatBytes(1.6 * MIB)).toBe("2 MB");
		// Sub-MB still expressed in MB when minUnit defaults to "MB".
		expect(formatBytes(512 * KIB)).toBe("1 MB");
		expect(formatBytes(100)).toBe("0 MB");
	});

	test("default options: GB tier with one decimal", () => {
		expect(formatBytes(2.1 * GIB)).toBe("2.1 GB");
		expect(formatBytes(GIB)).toBe("1.0 GB");
	});

	test("model-settings shape (one-decimal GB, integer MB)", () => {
		expect(formatBytes(8_000_000_000)).toBe("7.5 GB");
		expect(formatBytes(500 * MIB)).toBe("500 MB");
	});

	test("download-overlay ladder: minUnit B with KB/MB/GB decimals", () => {
		const opts = { minUnit: "B", mbDecimals: 1, gbDecimals: 2, kbDecimals: 1 } as const;
		expect(formatBytes(512, opts)).toBe("512 B");
		expect(formatBytes(1023, opts)).toBe("1023 B");
		expect(formatBytes(KIB, opts)).toBe("1.0 KB");
		expect(formatBytes(1536, opts)).toBe("1.5 KB");
		expect(formatBytes(5 * MIB, opts)).toBe("5.0 MB");
		expect(formatBytes(2.5 * GIB, opts)).toBe("2.50 GB");
	});

	test("minUnit KB stops at KB tier", () => {
		expect(formatBytes(512, { minUnit: "KB", kbDecimals: 2 })).toBe("0.50 KB");
		expect(formatBytes(2 * KIB, { minUnit: "KB" })).toBe("2.0 KB");
	});

	test("custom decimal counts are honoured per tier", () => {
		expect(formatBytes(3 * MIB, { mbDecimals: 2 })).toBe("3.00 MB");
		expect(formatBytes(4 * GIB, { gbDecimals: 0 })).toBe("4 GB");
	});
});
