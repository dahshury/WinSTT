import { beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

// `safeStorage` calls flow through here. Tests flip the available/encrypt
// shape per-case to cover the happy path, the unavailable-keystore fallback,
// and the wrong-user / corrupt-blob decryption path.
const fake = {
	available: true,
	encrypt: (s: string) => Buffer.from(`E(${s})`, "utf8"),
	decrypt: (b: Buffer) => {
		const txt = b.toString("utf8");
		if (!(txt.startsWith("E(") && txt.endsWith(")"))) {
			throw new Error("bad blob");
		}
		return txt.slice(2, -1);
	},
};

// Spread `electronMock()` so the process-global mock leak this installs is
// semantically complete — partial shims would make every later test importing
// `app` / `BrowserWindow` / etc. from `electron` throw "Export named X not
// found". Only `safeStorage` needs a custom impl here.
mock.module("electron", () => ({
	...electronMock(),
	safeStorage: {
		isEncryptionAvailable: () => fake.available,
		encryptString: (s: string) => fake.encrypt(s),
		decryptString: (b: Buffer) => fake.decrypt(b),
	},
}));

const mod = await import("./secret-storage");
const { encryptSecret, decryptSecret, isEncryptedSecret, isSecretDotPath } = mod;

beforeEach(() => {
	fake.available = true;
	fake.encrypt = (s: string) => Buffer.from(`E(${s})`, "utf8");
	fake.decrypt = (b: Buffer) => {
		const txt = b.toString("utf8");
		if (!(txt.startsWith("E(") && txt.endsWith(")"))) {
			throw new Error("bad blob");
		}
		return txt.slice(2, -1);
	};
});

describe("isSecretDotPath", () => {
	test("identifies the openrouter key path", () => {
		expect(isSecretDotPath("llm.openrouterApiKey")).toBe(true);
	});

	test("identifies cloud STT integration key paths", () => {
		expect(isSecretDotPath("integrations.openai.apiKey")).toBe(true);
		expect(isSecretDotPath("integrations.elevenlabs.apiKey")).toBe(true);
	});

	test("returns false for non-secret paths", () => {
		expect(isSecretDotPath("llm.endpoint")).toBe(false);
		expect(isSecretDotPath("general.recordingMode")).toBe(false);
		expect(isSecretDotPath("integrations.openai.verified")).toBe(false);
	});
});

describe("isEncryptedSecret", () => {
	test("recognizes the v1 envelope prefix", () => {
		expect(isEncryptedSecret("enc:v1:abc==")).toBe(true);
	});

	test("rejects plaintext, empty, and non-strings", () => {
		expect(isEncryptedSecret("sk-or-v1-deadbeef")).toBe(false);
		expect(isEncryptedSecret("")).toBe(false);
		expect(isEncryptedSecret(undefined)).toBe(false);
		expect(isEncryptedSecret(123)).toBe(false);
	});
});

describe("encryptSecret", () => {
	test("wraps plaintext with the enc:v1 prefix", () => {
		const out = encryptSecret("sk-or-v1-foo");
		expect(out.startsWith("enc:v1:")).toBe(true);
	});

	test("empty input passes through without invoking safeStorage", () => {
		let called = 0;
		fake.encrypt = (s: string) => {
			called++;
			return Buffer.from(`E(${s})`, "utf8");
		};
		expect(encryptSecret("")).toBe("");
		expect(called).toBe(0);
	});

	test("falls back to plaintext when keystore is unavailable", () => {
		fake.available = false;
		expect(encryptSecret("sk-or-v1-foo")).toBe("sk-or-v1-foo");
	});
});

describe("decryptSecret", () => {
	test("round-trips through encrypt", () => {
		const sealed = encryptSecret("sk-or-v1-foo");
		expect(decryptSecret(sealed)).toBe("sk-or-v1-foo");
	});

	test("passes through legacy plaintext (no prefix)", () => {
		expect(decryptSecret("sk-or-v1-legacy")).toBe("sk-or-v1-legacy");
	});

	test("returns empty for empty / non-strings", () => {
		expect(decryptSecret("")).toBe("");
		expect(decryptSecret(undefined)).toBe("");
		expect(decryptSecret(null)).toBe("");
		expect(decryptSecret(42)).toBe("");
	});

	test("returns empty when keystore is unavailable for a sealed value", () => {
		const sealed = encryptSecret("sk-or-v1-foo");
		fake.available = false;
		expect(decryptSecret(sealed)).toBe("");
	});

	test("returns empty when decryption throws (corrupt / wrong-user blob)", () => {
		fake.decrypt = () => {
			throw new Error("DPAPI: wrong user");
		};
		// Manually wrap a base64 blob — decryptSecret will pass it through to the
		// (now-throwing) safeStorage and must swallow the error.
		const bogus = `enc:v1:${Buffer.from("not-mine", "utf8").toString("base64")}`;
		expect(decryptSecret(bogus)).toBe("");
	});
});
