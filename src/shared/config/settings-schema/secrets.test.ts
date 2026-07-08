import { describe, expect, test } from "bun:test";
import { isProbedSecretCurrent, SECRET_PRESENT_SENTINEL } from "./secrets";

describe("isProbedSecretCurrent", () => {
	test("true when the stored value equals the probed key", () => {
		expect(isProbedSecretCurrent("sk-or-abc", "sk-or-abc")).toBe(true);
	});

	test("true when the store has been masked to the present sentinel", () => {
		// The backend seals the secret and broadcasts it back as the sentinel
		// while a verify probe is still in flight. That masked value IS the key
		// we probed, so it must NOT read as a stale/changed key — otherwise the
		// probe result is dropped and the pill spins on "verifying" forever.
		expect(isProbedSecretCurrent(SECRET_PRESENT_SENTINEL, "sk-or-abc")).toBe(
			true,
		);
	});

	test("false when the stored value is a different real key", () => {
		expect(isProbedSecretCurrent("sk-or-new", "sk-or-old")).toBe(false);
	});

	test("false when the key was cleared/removed mid-probe", () => {
		expect(isProbedSecretCurrent("", "sk-or-abc")).toBe(false);
	});
});
