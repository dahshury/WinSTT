import type { ModelInfo } from "@/entities/model-catalog";
import { getFamilyConfig } from "./family-metadata";

/** Parameter-count tokens like "180M", "1B", "0.6B" embedded in a display
 *  name. The picker already surfaces the size in a dedicated 🧠 badge (and the
 *  model card lists it explicitly), so repeating it in the name is redundant
 *  noise that only makes the selector rows longer. Anchored on digits + an
 *  M/B magnitude suffix so version tokens ("v3") and product numbers
 *  ("Breeze ASR 25") are left intact. */
const PARAM_COUNT_TOKEN_RE = /\s*\b\d+(?:\.\d+)?[MB]\b/gi;

const LANGUAGE_QUALIFIER_RE =
	/\s*\((?:english|en|russian|ru|arabic|ar|chinese|zh|japanese|ja|korean|ko|french|fr|german|de|spanish|es|italian|it|portuguese|pt|hindi|hi|ukrainian|uk|vietnamese|vi)\)\s*$/i;

/** Collapse the whitespace run a mid-name token strip can leave behind. */
const COLLAPSE_WHITESPACE_RE = /\s{2,}/g;

/** Strip the leading family label from a name (e.g. "NeMo Canary 1B Flash" → "Canary 1B Flash"). */
function stripFamilyLabel(name: string, model: ModelInfo): string {
	const familyLabel = getFamilyConfig(model.family).label;
	const stripped = name.replace(new RegExp(`^${familyLabel}\\s+`), "").trim();
	return stripped.length > 0 ? stripped : name;
}

/** Drop parameter-count tokens and collapse the whitespace they leave behind. */
function stripSizeToken(name: string): string {
	return name
		.replace(PARAM_COUNT_TOKEN_RE, "")
		.replace(COLLAPSE_WHITESPACE_RE, " ")
		.trim();
}

/** Drop language-only suffixes such as "(English)" or "(EN)"; the language badge owns that fact. */
function stripLanguageQualifier(name: string): string {
	return name.replace(LANGUAGE_QUALIFIER_RE, "").trim();
}

/** Leading "Streaming" qualifier (e.g. "Streaming Zipformer"). Natively-streaming
 *  models carry a dedicated streaming badge, so repeating it in the name is
 *  redundant. Anchored to the start so a mid-name "streaming" is left intact. */
const STREAMING_PREFIX_RE = /^streaming\s+/i;

/** Drop a leading "Streaming " token — the streaming badge already marks it. */
function stripStreamingPrefix(name: string): string {
	return name.replace(STREAMING_PREFIX_RE, "").trim();
}

/** The display name with the leading family label, language qualifier, and the
 *  redundant "Streaming" prefix removed (but NOT the size token — the caller
 *  decides that per {@link variantDisplayName}'s peer-collision rule). */
function baseDisplayName(model: ModelInfo): string {
	// "Streaming" is stripped FIRST so a following family label (e.g. "Streaming
	// NeMo FastConformer" → "NeMo FastConformer" → "FastConformer") is then
	// caught by the family strip too.
	const withoutStreaming = stripStreamingPrefix(model.displayName);
	return stripLanguageQualifier(stripFamilyLabel(withoutStreaming, model));
}

/**
 * The model's name as shown in the picker, with the leading family label and
 * the redundant parameter-count token removed. The family is conveyed by the
 * author chip / group header and the size by a dedicated badge, so neither
 * belongs in the name itself (e.g. "NeMo Canary 180M Flash" → "Canary Flash").
 *
 * `peers` re-introduces the size token ONLY when dropping it would make this
 * model indistinguishable from another in the set — e.g. "Canary 180M Flash"
 * and "Canary 1B Flash" both collapse to "Canary Flash", so when they appear
 * together (same bundle / catalog) both keep their size. Without `peers`, or
 * when there's no collision, the size is always stripped.
 *
 * Falls back to the raw display name if stripping would empty it.
 */
export function variantDisplayName(
	model: ModelInfo,
	peers?: readonly ModelInfo[],
): string {
	const withFamily = baseDisplayName(model);
	const withoutSize = stripSizeToken(withFamily);
	if (withoutSize.length === 0) {
		return model.displayName;
	}
	if (
		withoutSize !== withFamily &&
		peers?.some(
			(p) =>
				p.id !== model.id && stripSizeToken(baseDisplayName(p)) === withoutSize,
		)
	) {
		return withFamily;
	}
	return withoutSize;
}
