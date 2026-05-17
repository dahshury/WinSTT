/**
 * Secret-at-rest wrapper around Electron's `safeStorage` API.
 *
 * `safeStorage` ties encryption to the current OS user account via DPAPI
 * (Windows), Keychain (macOS), or libsecret (Linux). The wrapper:
 *   - Envelopes ciphertext as `enc:v1:<base64>` so legacy plaintext values
 *     can be detected and lazily re-encrypted.
 *   - Passes through legacy plaintext on read (so the renderer keeps working
 *     before the at-rest migration runs).
 *   - Refuses to encrypt empty strings (no point spending a DPAPI call on the
 *     "user hasn't set a key" state, and avoids re-encrypting on every save).
 *   - Falls back to plaintext (with a warning) when the platform lacks a
 *     working keystore — defense-in-depth, not a hard requirement.
 *
 * Only callable from the main process; the renderer must never see ciphertext.
 */
import { safeStorage } from "electron";

const ENC_PREFIX = "enc:v1:";

/** Dot-paths whose stored value should be encrypted at rest. */
export const SECRET_DOT_PATHS: readonly string[] = ["llm.openrouterApiKey"];

/** Returns true if the dot-path identifies a secret-at-rest field. */
export function isSecretDotPath(dotPath: string): boolean {
	return SECRET_DOT_PATHS.includes(dotPath);
}

/** Returns true if the value is already wrapped ciphertext. */
export function isEncryptedSecret(value: unknown): value is string {
	return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

/**
 * Encrypt a plaintext string for at-rest storage. Empty input returns "" —
 * we deliberately don't waste a DPAPI call on an empty key, and an empty
 * ciphertext on disk is interchangeable with "user hasn't set a key yet".
 */
export function encryptSecret(plain: string): string {
	if (plain === "") {
		return "";
	}
	if (!safeStorage.isEncryptionAvailable()) {
		console.warn("[secret-storage] safeStorage unavailable — storing plaintext");
		return plain;
	}
	const encrypted = safeStorage.encryptString(plain);
	return `${ENC_PREFIX}${encrypted.toString("base64")}`;
}

/**
 * Decrypt an at-rest value. Returns plaintext for both wrapped ciphertext
 * and legacy plaintext (callers can't tell them apart, and shouldn't need
 * to). Returns "" on decryption failure (corrupt blob, wrong user) so the
 * UI just shows an empty field and the user can re-enter their key.
 */
export function decryptSecret(stored: unknown): string {
	if (typeof stored !== "string" || stored === "") {
		return "";
	}
	if (!isEncryptedSecret(stored)) {
		return stored;
	}
	if (!safeStorage.isEncryptionAvailable()) {
		console.warn("[secret-storage] safeStorage unavailable — cannot decrypt");
		return "";
	}
	try {
		const buf = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
		return safeStorage.decryptString(buf);
	} catch (err) {
		console.warn("[secret-storage] decryption failed:", err);
		return "";
	}
}
