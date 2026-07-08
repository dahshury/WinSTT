/**
 * Sentinel the backend substitutes for a sealed API-key secret before handing
 * settings to the renderer (see `sanitize_settings_for_renderer` in
 * `src-tauri/src/winstt/settings_store.rs`). The real key material never
 * crosses the IPC boundary; a registered-but-hidden key surfaces as this exact
 * string. It is intentionally non-empty so `apiKey.trim().length > 0` still
 * reports "a key is registered" for locking the field.
 */
export const SECRET_PRESENT_SENTINEL = "__WINSTT_SECRET_PRESENT__";

/**
 * Whether a stored secret value still represents the key a verify probe is
 * checking.
 *
 * The verify-credentials probe carries the plaintext key it is validating. By
 * the time the probe resolves, a debounced settings save can round-trip through
 * the backend, which seals the secret and broadcasts it back masked as
 * {@link SECRET_PRESENT_SENTINEL} — overwriting the store's plaintext copy. The
 * stale-check at each verify call site must treat that masked value as
 * still-current, otherwise it drops the probe result and the status pill spins
 * on "verifying" forever. A genuinely newer key (user typed/pasted again, or
 * removed the key) is still caught by the request-id guard at the call sites.
 */
export function isProbedSecretCurrent(stored: string, probed: string): boolean {
	return stored === probed || stored === SECRET_PRESENT_SENTINEL;
}
