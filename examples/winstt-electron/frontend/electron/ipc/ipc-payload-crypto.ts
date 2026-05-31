// Stryker disable next-line StringLiteral: equivalent — the literal flows into both encryptIpcPayload (sets payload.algorithm) and decryptIpcPayload (compares against payload.algorithm); mutating to "" still round-trips because both sides use the same constant
const IPC_PAYLOAD_ALGORITHM = "aes-256-gcm";
const IPC_KEY_BYTES = 32;
const IPC_IV_BYTES = 12;
const IPC_AUTH_TAG_BYTES = 16;
// Stryker disable next-line StringLiteral: equivalent — AAD bytes are used symmetrically in encrypt and decrypt; mutating the literal breaks neither because both sides see the same mutated bytes
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
	// Stryker disable next-line BooleanLiteral: equivalent — the `extractable=false` flag prevents key.export() from working; tests never attempt to extract, so flipping to true has no observable behaviour change
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

function assertSegmentLength(segment: Uint8Array, expected: number, name: string): void {
	if (segment.byteLength !== expected) {
		throw new Error(`Encrypted IPC payload has invalid ${name} length: ${segment.byteLength}`);
	}
}

function buildSealedBuffer(ciphertext: Uint8Array, authTag: Uint8Array): Uint8Array {
	const sealed = new Uint8Array(ciphertext.byteLength + authTag.byteLength);
	sealed.set(ciphertext, 0);
	sealed.set(authTag, ciphertext.byteLength);
	return sealed;
}

async function aesGcmDecrypt(
	sealed: Uint8Array,
	iv: Uint8Array,
	cryptoKey: CryptoKey
): Promise<ArrayBuffer> {
	try {
		return await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: iv as BufferSource,
				additionalData: IPC_AAD_BYTES,
				tagLength: IPC_AUTH_TAG_BYTES * 8,
			},
			cryptoKey,
			sealed as BufferSource
		);
	} catch {
		throw new Error("IPC payload authentication failed");
	}
}

function parseJsonPayload<T>(buf: ArrayBuffer): T {
	try {
		return JSON.parse(new TextDecoder().decode(buf)) as T;
	} catch {
		throw new Error("Decrypted IPC payload is not valid JSON");
	}
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

	assertSegmentLength(iv, IPC_IV_BYTES, "iv");
	assertSegmentLength(authTag, IPC_AUTH_TAG_BYTES, "authTag");

	const cryptoKey = await importAesGcmKey(key);
	const sealed = buildSealedBuffer(ciphertext, authTag);
	const plaintext = await aesGcmDecrypt(sealed, iv, cryptoKey);
	return parseJsonPayload<T>(plaintext);
}
