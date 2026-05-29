import { describe, expect, test } from "bun:test";
import { isFailOpenUpdateReason } from "./update-gate";

describe("isFailOpenUpdateReason", () => {
	test("fail-open: verification could not RUN", () => {
		expect(isFailOpenUpdateReason("minisign pubkey not found at /x")).toBe(true);
		expect(isFailOpenUpdateReason("sidecar fetch failed: HTTP 404")).toBe(true);
		expect(isFailOpenUpdateReason("sidecar fetch failed: HTTP 410")).toBe(true);
	});

	test("fail-closed: signature ran and was REJECTED", () => {
		expect(isFailOpenUpdateReason("signature mismatch")).toBe(false);
		expect(isFailOpenUpdateReason("global signature: expected 64 bytes, got 10")).toBe(false);
		expect(isFailOpenUpdateReason("HTTP 500")).toBe(false);
		expect(isFailOpenUpdateReason("")).toBe(false);
	});
});
