import { describe, expect, test } from "bun:test";
import {
	decryptIpcPayload,
	type EncryptedIpcPayload,
	encryptIpcPayload,
	generateIpcPayloadKey,
} from "./ipc-payload-crypto";

function tamperSegment(segment: string): string {
	const bytes = Buffer.from(segment, "base64url");
	const firstByte = bytes[0];
	if (firstByte === undefined) {
		throw new Error("Cannot tamper empty segment");
	}
	bytes[0] = (firstByte + 1) % 256;
	return bytes.toString("base64url");
}

describe("ipc-payload-crypto", () => {
	test("encrypts and decrypts JSON payloads", async () => {
		const key = Buffer.alloc(32, 7);
		const payload = {
			command: "start-recording",
			meta: {
				retry: 2,
				flags: ["mute", "overlay"],
			},
		};

		const encrypted = await encryptIpcPayload(payload, key);
		const decrypted = await decryptIpcPayload<typeof payload>(encrypted, key);

		expect(decrypted).toEqual(payload);
	});

	test("detects tampering in ciphertext", async () => {
		const key = Buffer.alloc(32, 9);
		const encrypted = await encryptIpcPayload({ ok: true }, key);
		const tampered: EncryptedIpcPayload = {
			...encrypted,
			ciphertext: tamperSegment(encrypted.ciphertext),
		};

		await expect(decryptIpcPayload(tampered, key)).rejects.toThrow("authentication failed");
	});

	test("detects tampering in auth tag", async () => {
		const key = Buffer.alloc(32, 10);
		const encrypted = await encryptIpcPayload({ ok: true }, key);
		const tampered: EncryptedIpcPayload = {
			...encrypted,
			authTag: tamperSegment(encrypted.authTag),
		};

		await expect(decryptIpcPayload(tampered, key)).rejects.toThrow("authentication failed");
	});

	test("rejects invalid key length", async () => {
		const shortKey = Buffer.alloc(16, 1);

		await expect(encryptIpcPayload({ ok: true }, shortKey)).rejects.toThrow("32-byte key");
	});

	test("generateIpcPayloadKey returns a 32-byte Buffer", () => {
		const key = generateIpcPayloadKey();
		expect(key).toBeInstanceOf(Buffer);
		expect(key.byteLength).toBe(32);
	});

	test("generateIpcPayloadKey produces different values on each call", () => {
		const k1 = generateIpcPayloadKey();
		const k2 = generateIpcPayloadKey();
		// Two random keys should not be equal (astronomically unlikely to collide)
		expect(k1.equals(k2)).toBe(false);
	});

	test("decryptIpcPayload rejects mismatched algorithm", async () => {
		const key = Buffer.alloc(32, 7);
		const encrypted = await encryptIpcPayload({ ok: true }, key);
		const tampered = { ...encrypted, algorithm: "aes-128-cbc" as typeof encrypted.algorithm };
		await expect(decryptIpcPayload(tampered, key)).rejects.toThrow(/Unsupported/);
	});

	test("decryptIpcPayload rejects missing iv segment", async () => {
		const key = Buffer.alloc(32, 7);
		const encrypted = await encryptIpcPayload({ ok: true }, key);
		const tampered = { ...encrypted, iv: "" };
		await expect(decryptIpcPayload(tampered, key)).rejects.toThrow(/missing iv/);
	});

	test("decryptIpcPayload rejects missing ciphertext segment", async () => {
		const key = Buffer.alloc(32, 7);
		const encrypted = await encryptIpcPayload({ ok: true }, key);
		const tampered = { ...encrypted, ciphertext: "" };
		await expect(decryptIpcPayload(tampered, key)).rejects.toThrow(/missing ciphertext/);
	});

	test("decryptIpcPayload rejects missing authTag segment", async () => {
		const key = Buffer.alloc(32, 7);
		const encrypted = await encryptIpcPayload({ ok: true }, key);
		const tampered = { ...encrypted, authTag: "" };
		await expect(decryptIpcPayload(tampered, key)).rejects.toThrow(/missing authTag/);
	});

	test("decryptIpcPayload rejects wrong iv length", async () => {
		const key = Buffer.alloc(32, 7);
		const encrypted = await encryptIpcPayload({ ok: true }, key);
		// 8 bytes instead of 12
		const tampered = { ...encrypted, iv: Buffer.alloc(8).toString("base64url") };
		await expect(decryptIpcPayload(tampered, key)).rejects.toThrow(/invalid iv length/);
	});

	test("decryptIpcPayload rejects wrong authTag length", async () => {
		const key = Buffer.alloc(32, 7);
		const encrypted = await encryptIpcPayload({ ok: true }, key);
		// 8 bytes instead of 16
		const tampered = { ...encrypted, authTag: Buffer.alloc(8).toString("base64url") };
		await expect(decryptIpcPayload(tampered, key)).rejects.toThrow(/invalid authTag length/);
	});

	test("decryptIpcPayload rejects payloads whose plaintext is not valid JSON", async () => {
		// Locks down the parseJsonPayload catch block at L117-118. We hand-roll
		// an encrypted blob with non-JSON plaintext to bypass encryptIpcPayload's
		// JSON.stringify, then assert decrypt surfaces the JSON-parse error.
		const key = Buffer.alloc(32, 7);
		const algorithm = { name: "AES-GCM" } as const;
		const cryptoKey = await crypto.subtle.importKey(
			"raw",
			key as unknown as BufferSource,
			algorithm,
			false,
			["encrypt", "decrypt"]
		);
		const iv = new Uint8Array(12);
		crypto.getRandomValues(iv);
		const aad = new TextEncoder().encode("winstt:ipc-payload:v1");
		const plaintext = new TextEncoder().encode("not valid json {");
		const sealed = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
				cryptoKey,
				plaintext
			)
		);
		const ciphertext = sealed.subarray(0, sealed.byteLength - 16);
		const authTag = sealed.subarray(sealed.byteLength - 16);
		const payload = {
			algorithm: "aes-256-gcm" as const,
			iv: Buffer.from(iv).toString("base64url"),
			ciphertext: Buffer.from(ciphertext).toString("base64url"),
			authTag: Buffer.from(authTag).toString("base64url"),
		};
		await expect(decryptIpcPayload(payload, key)).rejects.toThrow(/not valid JSON/);
	});
});
