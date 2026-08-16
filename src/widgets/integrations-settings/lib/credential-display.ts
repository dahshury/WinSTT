import type { CredentialStatusKind } from "@/features/verify-credentials";
import { secretHint } from "@/shared/config/settings-schema";

/**
 * Every state a provider's status pill can be in. Distinct from
 * {@link CredentialStatusKind}, which only describes the *probe*: the pill also
 * has to answer "is there a credential at all?" and "what did the last probe say
 * before this window was remounted?", neither of which the probe union carries.
 *
 * There is deliberately no "nothing to show" member — a card whose pill renders
 * nothing reads as broken, which is exactly the bug this replaces.
 */
export type CredentialPillState =
	| "connected"
	| "notConnected"
	| "rejected"
	| "unreachable"
	| "unverified"
	| "verifying";

export interface CredentialPillInput {
	/** A key is registered (or, for Ollama, the endpoint is usable). */
	hasCredential: boolean;
	/**
	 * The last verdict that outlived the probe store — `integrations.<provider>
	 * .verified` for ElevenLabs, `null` for providers with no persisted field.
	 * Consulted ONLY when the live probe is idle, so a fresh probe always wins.
	 */
	persistedVerified: boolean | null;
	status: CredentialStatusKind;
}

/**
 * Collapse "is a key present", "what is the probe doing" and "what did the last
 * probe conclude" into the single state the pill renders.
 *
 * `verifying` outranks everything (including "no credential"): the manual
 * "Test connection" action can be fired against a sealed key whose plaintext
 * only the backend holds, and the spinner must not be suppressed by a
 * presence check on the masked value.
 */
export function resolveCredentialPillState({
	hasCredential,
	persistedVerified,
	status,
}: CredentialPillInput): CredentialPillState {
	if (status === "verifying") {
		return "verifying";
	}
	if (!hasCredential) {
		return "notConnected";
	}
	if (status === "verified") {
		return "connected";
	}
	if (status === "invalid") {
		return "rejected";
	}
	if (status === "offline") {
		return "unreachable";
	}
	// Probe idle — this is a fresh mount, so fall back to the persisted verdict.
	// Without this a rejected key reads as merely "not verified" (or, in the old
	// pill, as nothing at all) every time the settings window is reopened.
	if (persistedVerified === true) {
		return "connected";
	}
	if (persistedVerified === false) {
		return "rejected";
	}
	return "unverified";
}

/** The fixed asterisk run standing in for the key's hidden middle. */
const MASK_BODY = "********";

/**
 * The sealed key as the user sees it: `sk-or-v1-********4f2a`.
 *
 * `prefix` comes from the provider catalog (`getApiKeyPrefix`), NOT from the
 * i18n key-shape placeholder — the placeholder is a translatable catalog entry,
 * and this string is a claim about what the user's stored key really starts
 * with, which a translation pass must not be able to change.
 *
 * `storedValue` is whatever settings currently hold for the key, which is one
 * of three things — the backend's hinted mask, its bare mask, or a plaintext
 * key the user just typed that has not round-tripped through the backend yet.
 * Only {@link secretHint} may ever contribute characters from the key itself,
 * so the plaintext case degrades to the hintless form rather than leaking: this
 * function can never emit the raw sentinel or the raw key.
 */
export function maskedKeyDisplay(prefix: string, storedValue: string): string {
	return `${prefix}${MASK_BODY}${secretHint(storedValue) ?? ""}`;
}
