const IPC_PAYLOAD_ALGORITHM = "aes-256-gcm";
const IPC_KEY_BYTES = 32;
const IPC_IV_BYTES = 12;
const IPC_AUTH_TAG_BYTES = 16;
const IPC_AAD_BYTES = new TextEncoder().encode("winstt:ipc-payload:v1");

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface EncryptedIpcPayload {
	algorithm: typeof IPC_PAYLOAD_ALGORITHM;
	authTag: string;
	ciphertext: string;
	iv: string;
}

function assertKeyLength(key: Uint8Array): void {
	if (key.byteLength !== IPC_KEY_BYTES) {
		throw new Error(`IPC payload crypto requires a 32-byte key, got ${key.byteLength} bytes`);
	}
}

function importAesGcmKey(key: Uint8Array): Promise<CryptoKey> {
	assertKeyLength(key);
	return crypto.subtle.importKey("raw", key as BufferSource, { name: "AES-GCM" }, false, [
		"encrypt",
		"decrypt",
	]);
}

function decodeBase64urlSegment(value: string, segment: string): Uint8Array<ArrayBuffer> {
	if (!value) {
		throw new Error(`Encrypted IPC payload is missing ${segment}`);
	}
	const source = Buffer.from(value, "base64url");
	const copy = new Uint8Array(source.byteLength);
	copy.set(source);
	return copy;
}

function toBase64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

export function generateIpcPayloadKey(): Buffer {
	const key = new Uint8Array(IPC_KEY_BYTES);
	crypto.getRandomValues(key);
	return Buffer.from(key);
}

export async function encryptIpcPayload<T>(
	payload: T,
	key: Uint8Array
): Promise<EncryptedIpcPayload> {
	const cryptoKey = await importAesGcmKey(key);
	const iv = new Uint8Array(IPC_IV_BYTES);
	crypto.getRandomValues(iv);

	const plaintext = new TextEncoder().encode(JSON.stringify(payload));
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt(
			{
				name: "AES-GCM",
				iv,
				additionalData: IPC_AAD_BYTES,
				tagLength: IPC_AUTH_TAG_BYTES * 8,
			},
			cryptoKey,
			plaintext
		)
	);

	// Web Crypto returns ciphertext || authTag concatenated.
	const ciphertext = sealed.subarray(0, sealed.byteLength - IPC_AUTH_TAG_BYTES);
	const authTag = sealed.subarray(sealed.byteLength - IPC_AUTH_TAG_BYTES);

	return {
		algorithm: IPC_PAYLOAD_ALGORITHM,
		iv: toBase64url(iv),
		ciphertext: toBase64url(ciphertext),
		authTag: toBase64url(authTag),
	};
}

export async function decryptIpcPayload<T>(
	payload: EncryptedIpcPayload,
	key: Uint8Array
): Promise<T> {
	if (payload.algorithm !== IPC_PAYLOAD_ALGORITHM) {
		throw new Error(`Unsupported IPC payload algorithm: ${payload.algorithm}`);
	}

	const iv = decodeBase64urlSegment(payload.iv, "iv");
	const ciphertext = decodeBase64urlSegment(payload.ciphertext, "ciphertext");
	const authTag = decodeBase64urlSegment(payload.authTag, "authTag");

	if (iv.byteLength !== IPC_IV_BYTES) {
		throw new Error(`Encrypted IPC payload has invalid iv length: ${iv.byteLength}`);
	}
	if (authTag.byteLength !== IPC_AUTH_TAG_BYTES) {
		throw new Error(`Encrypted IPC payload has invalid authTag length: ${authTag.byteLength}`);
	}

	const cryptoKey = await importAesGcmKey(key);
	const sealed = new Uint8Array(ciphertext.byteLength + authTag.byteLength);
	sealed.set(ciphertext, 0);
	sealed.set(authTag, ciphertext.byteLength);

	let plaintext: ArrayBuffer;
	try {
		plaintext = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv,
				additionalData: IPC_AAD_BYTES,
				tagLength: IPC_AUTH_TAG_BYTES * 8,
			},
			cryptoKey,
			sealed as BufferSource
		);
	} catch {
		throw new Error("IPC payload authentication failed");
	}

	try {
		return JSON.parse(new TextDecoder().decode(plaintext)) as T;
	} catch {
		throw new Error("Decrypted IPC payload is not valid JSON");
	}
}
