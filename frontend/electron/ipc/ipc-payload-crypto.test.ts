import { describe, expect, test } from "bun:test";
import {
	decryptIpcPayload,
	type EncryptedIpcPayload,
	encryptIpcPayload,
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
});
