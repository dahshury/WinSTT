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
 * Separator between the present-sentinel and its optional non-secret last-4
 * hint: `__WINSTT_SECRET_PRESENT__:4f2a`. The backend appends the hint only when
 * the plaintext key is long enough that four trailing characters are not a
 * meaningful fraction of it, so a masked value may arrive with or without one
 * and every consumer must tolerate both shapes.
 *
 * NOT exported: the wire format is owned by
 * `src-tauri/src/winstt/settings_store.rs`, and callers should go through
 * {@link isSecretPresent}/{@link secretHint} rather than re-parse it.
 */
const SECRET_HINT_SEPARATOR = ":";

/**
 * Length of the hint the backend emits. Anything else is treated as "no hint"
 * rather than rendered: the hint is only safe to show because it is capped at
 * four characters, so an unexpected payload must degrade to the bare mask
 * instead of leaking a larger slice of the key into the UI.
 */
const SECRET_HINT_LENGTH = 4;

/**
 * Sentinel a deliberate user "remove key" action writes into the settings store
 * so the debounced save carries an explicit CLEAR to the backend. Must be
 * byte-identical to `SECRET_CLEAR_SENTINEL` in
 * `src-tauri/src/winstt/settings_store.rs`.
 *
 * The backend now treats an EMPTY incoming secret as "keep the stored key" (so a
 * pre-hydration/programmatic save can't wipe a real DPAPI-sealed key). An empty
 * string is therefore no longer a wipe — a genuine removal must post this
 * sentinel, which `preserve_masked_secret` maps to a real clear.
 */
export const SECRET_CLEAR_SENTINEL = "__WINSTT_SECRET_CLEAR__";

/**
 * Whether a stored secret value is the backend's mask for a sealed key — i.e.
 * "a key is registered, but its material stays on the native side".
 *
 * A prefix test, not an equality test: the mask may carry a last-4 hint
 * (`__WINSTT_SECRET_PRESENT__:4f2a`), and an exact comparison would classify
 * every hinted value as real key material. Callers that only need "is a key
 * registered?" must use this instead of comparing to
 * {@link SECRET_PRESENT_SENTINEL}.
 */
export function isSecretPresent(value: string): boolean {
	return value.startsWith(SECRET_PRESENT_SENTINEL);
}

/**
 * The non-secret last-4 hint carried by a masked secret, or `null` when there is
 * none — a bare sentinel (the backend withholds the hint for short keys, and the
 * settings-export path never emits one), a plaintext key, or any other value.
 *
 * Deliberately returns `null` rather than `""` for the hintless case so callers
 * render `sk-or-v1-********` vs `sk-or-v1-********4f2a` off a single check.
 */
export function secretHint(value: string): string | null {
	if (!isSecretPresent(value)) {
		return null;
	}
	const suffix = value.slice(SECRET_PRESENT_SENTINEL.length);
	if (!suffix.startsWith(SECRET_HINT_SEPARATOR)) {
		return null;
	}
	const hint = suffix.slice(SECRET_HINT_SEPARATOR.length);
	// Counted in CODE POINTS, not UTF-16 units: the backend builds the hint with
	// `chars().skip(n - 4)` (settings_store.rs), so a key ending in a non-BMP
	// character yields four characters whose JS `.length` is more than four. A
	// `.length` check would reject that as malformed and silently drop the hint.
	return [...hint].length === SECRET_HINT_LENGTH ? hint : null;
}

/**
 * Normalize a stored secret for DISPLAY. A remove action transiently parks
 * {@link SECRET_CLEAR_SENTINEL} in the store until the backend's cleared
 * broadcast lands; the field must render as empty (no key) during that window,
 * never as a present/locked key or as the raw sentinel text.
 */
export function displaySecretValue(value: string): string {
	return value === SECRET_CLEAR_SENTINEL ? "" : value;
}

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
 *
 * Matches the mask by prefix ({@link isSecretPresent}), never by equality: the
 * broadcast value usually carries a last-4 hint, and an exact comparison would
 * read that as "a different key" and strand the pill on "verifying".
 */
export function isProbedSecretCurrent(stored: string, probed: string): boolean {
	return stored === probed || isSecretPresent(stored);
}
