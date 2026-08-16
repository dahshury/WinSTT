import { formatInlineTagList, type TtsModelInfo } from "@/entities/tts-catalog";

/**
 * Why the "Inline tags" row is not usable right now, or `null` when it is.
 *
 * `"unsupported"` is not a *blocked* state so much as a *missing capability*:
 * the selected engine ships no tag vocabulary at all, so the row hides rather
 * than nagging. `"post-processing"` is genuinely blocked — the model CAN speak
 * tags, we just have no LLM configured to insert them — so the row stays
 * visible, disabled, and says so.
 */
export type InlineTagsBlocker = "unsupported" | "post-processing";

export interface InlineTagsGate {
	/** `null` when the toggle is live; otherwise why it is not. */
	blockedBy: InlineTagsBlocker | null;
	/**
	 * `false` for every engine without a tag vocabulary — the caller renders
	 * nothing at all in that case (see {@link InlineTagsBlocker}).
	 */
	supported: boolean;
	/**
	 * The model's whole vocabulary in ITS OWN delimiters (`"<laugh> <sigh>"` for
	 * Orpheus, `"[laugh] [cough]"` for Chatterbox Turbo), for the row's tooltip.
	 * `""` when unsupported. NEVER assemble this from a literal bracket — the two
	 * shipped syntaxes are not interchangeable and the wrong one is spoken aloud.
	 */
	tagList: string;
}

export interface InlineTagsGateInput {
	/** The selected TTS model's catalog row; `undefined` before the catalog
	 *  loads, or when the persisted id is not a catalog row. */
	model: Pick<TtsModelInfo, "tagSyntax" | "tags"> | undefined;
	/** `isPostProcessingReady(...)` — the SAME gate every other LLM-assisted
	 *  voice affordance in this tab uses, never a second derivation of it. */
	postProcessingReady: boolean;
	/**
	 * `true` while the Cloud source is active. Cloud voices are not catalog rows
	 * and have no tag vocabulary, so annotating for them would only make the
	 * provider read the delimiters out loud. Mirrors the backend hook, which
	 * skips annotation unless `tts.source` is local.
	 */
	cloud: boolean;
}

/**
 * Availability of the read-aloud "Inline tags" toggle.
 *
 * Two independent halves, matching the backend's own refusal order in
 * `annotate_for_read_aloud`: the ENGINE must have a tag vocabulary (a catalog
 * fact), and the POST-PROCESSING LLM must be runnable (a settings fact). Both
 * must hold — the feature is "rewrite the text with an LLM, then speak it".
 */
export function deriveInlineTagsGate({
	cloud,
	model,
	postProcessingReady,
}: InlineTagsGateInput): InlineTagsGate {
	const tagList = cloud || !model ? "" : formatInlineTagList(model);
	if (tagList === "") {
		return { blockedBy: "unsupported", supported: false, tagList: "" };
	}
	return {
		blockedBy: postProcessingReady ? null : "post-processing",
		supported: true,
		tagList,
	};
}
