import type { CapabilityId } from "../model/provider-capabilities";

/**
 * Capability id → `integrations` message key.
 *
 * The capability model exposes stable ids and no user-facing English at all, so
 * this is the single place the two vocabularies meet. A literal `Record` rather
 * than a computed key (`` t(`capability${id}`) ``) so the i18n literal check and
 * a plain `rg` can both see every message key this widget consumes.
 *
 * `as const satisfies` rather than an annotated `Record<CapabilityId, string>`:
 * `useTranslations` only accepts the literal union of real message keys, so the
 * values must stay literal types while `satisfies` still enforces that every
 * capability id is covered.
 */
export const CAPABILITY_MESSAGE = {
	cloudStt: "capabilityCloudStt",
	cloudTts: "capabilityCloudTts",
	dictation: "capabilityDictation",
	readAloud: "capabilityReadAloud",
	transforms: "capabilityTransforms",
} as const satisfies Record<CapabilityId, string>;
