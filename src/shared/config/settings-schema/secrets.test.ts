import { describe, expect, test } from "bun:test";
import {
	displaySecretValue,
	isProbedSecretCurrent,
	isSecretPresent,
	SECRET_CLEAR_SENTINEL,
	SECRET_PRESENT_SENTINEL,
	secretHint,
} from "./secrets";

// The masked wire format the backend emits when it can also surface a hint.
// Built from the exported sentinel rather than hardcoded so a sentinel rename
// fails the byte-identity test below instead of silently skewing every case.
const HINTED_SENTINEL = `${SECRET_PRESENT_SENTINEL}:4f2a`;

describe("sentinels", () => {
	// The Rust side compares against these exact bytes
	// (`preserve_masked_secret` in `src-tauri/src/winstt/settings_store.rs`).
	// A rename here is a silent cross-boundary break, so pin the literals.
	test("are byte-identical to the backend's", () => {
		expect(SECRET_PRESENT_SENTINEL).toBe("__WINSTT_SECRET_PRESENT__");
		expect(SECRET_CLEAR_SENTINEL).toBe("__WINSTT_SECRET_CLEAR__");
	});
});

describe("isSecretPresent", () => {
	test("true for the bare sentinel (short key, or the settings-export path)", () => {
		expect(isSecretPresent(SECRET_PRESENT_SENTINEL)).toBe(true);
	});

	test("true for the hinted sentinel", () => {
		expect(isSecretPresent(HINTED_SENTINEL)).toBe(true);
	});

	test("false for a real plaintext key", () => {
		expect(isSecretPresent("sk-or-v1-abcdef0123456789")).toBe(false);
	});

	test("false for the clear sentinel", () => {
		expect(isSecretPresent(SECRET_CLEAR_SENTINEL)).toBe(false);
	});

	test("false for the empty string", () => {
		expect(isSecretPresent("")).toBe(false);
	});

	test("false when a value merely CONTAINS the sentinel", () => {
		// Prefix test, not substring: a key that happens to embed the sentinel is
		// still key material and must never be treated as "already masked",
		// which would leak it past the mask-aware display paths.
		expect(isSecretPresent(`sk-${SECRET_PRESENT_SENTINEL}`)).toBe(false);
		expect(isSecretPresent(` ${SECRET_PRESENT_SENTINEL}`)).toBe(false);
	});
});

describe("secretHint", () => {
	test("returns the last4 for a hinted sentinel", () => {
		expect(secretHint(HINTED_SENTINEL)).toBe("4f2a");
	});

	test("returns null for the bare sentinel", () => {
		// No hint is emitted for keys under 8 characters, and the settings-export
		// path always emits the bare sentinel because that file leaves the
		// machine. Both must read as "present, but nothing to show".
		expect(secretHint(SECRET_PRESENT_SENTINEL)).toBeNull();
	});

	test("returns null for a real plaintext key", () => {
		expect(secretHint("sk-or-v1-abcdef0123456789")).toBeNull();
	});

	test("returns null for the clear sentinel", () => {
		expect(secretHint(SECRET_CLEAR_SENTINEL)).toBeNull();
	});

	test("returns null for the empty string", () => {
		expect(secretHint("")).toBeNull();
	});

	test("returns null when a value merely CONTAINS the sentinel", () => {
		expect(secretHint(`sk-${HINTED_SENTINEL}`)).toBeNull();
	});

	test("returns null for a malformed hint payload", () => {
		// Anything that is not exactly four characters behind the separator
		// degrades to the bare mask rather than rendering a bigger slice of the
		// key than the contract allows.
		expect(secretHint(`${SECRET_PRESENT_SENTINEL}:`)).toBeNull();
		expect(secretHint(`${SECRET_PRESENT_SENTINEL}:4f`)).toBeNull();
		expect(secretHint(`${SECRET_PRESENT_SENTINEL}:0123456789`)).toBeNull();
		expect(secretHint(`${SECRET_PRESENT_SENTINEL}4f2a`)).toBeNull();
	});
});

describe("displaySecretValue", () => {
	test("renders the clear sentinel as an empty field", () => {
		expect(displaySecretValue(SECRET_CLEAR_SENTINEL)).toBe("");
	});

	test("passes every other value through unchanged", () => {
		// Unchanged by the hint work: masking/formatting is the caller's job, so
		// both mask shapes must survive this helper verbatim.
		expect(displaySecretValue(SECRET_PRESENT_SENTINEL)).toBe(
			SECRET_PRESENT_SENTINEL,
		);
		expect(displaySecretValue(HINTED_SENTINEL)).toBe(HINTED_SENTINEL);
		expect(displaySecretValue("sk-or-abc")).toBe("sk-or-abc");
		expect(displaySecretValue("")).toBe("");
	});
});

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

	test("true when the masked broadcast carries a last-4 hint", () => {
		// The hinted mask is the common case now; an exact sentinel comparison
		// here would reinstate the forever-spinning pill.
		expect(isProbedSecretCurrent(HINTED_SENTINEL, "sk-or-abc")).toBe(true);
	});

	test("false when the stored value is a different real key", () => {
		expect(isProbedSecretCurrent("sk-or-new", "sk-or-old")).toBe(false);
	});

	test("false when the key was cleared/removed mid-probe", () => {
		expect(isProbedSecretCurrent("", "sk-or-abc")).toBe(false);
		expect(isProbedSecretCurrent(SECRET_CLEAR_SENTINEL, "sk-or-abc")).toBe(
			false,
		);
	});

	test("false when the stored key merely CONTAINS the sentinel", () => {
		expect(isProbedSecretCurrent(`sk-${HINTED_SENTINEL}`, "sk-or-abc")).toBe(
			false,
		);
	});
});
