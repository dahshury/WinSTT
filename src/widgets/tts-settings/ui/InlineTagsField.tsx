import { DEFAULT_SETTINGS, SettingField } from "@/entities/setting";
import type { TranslateFn } from "@/shared/i18n/translation-types";
import { Toggle } from "@/shared/ui/toggle";
import type { InlineTagsBlocker } from "../lib/inline-tags-gate";

export interface InlineTagsFieldProps {
	/** Why the toggle can't run, or `null` when it can. `"unsupported"` never
	 *  reaches here — the parent renders nothing for an engine with no tags. */
	blockedBy: InlineTagsBlocker | null;
	/** Persisted `tts.inlineTags`. */
	enabled: boolean;
	onChange: (next: boolean) => void;
	t: TranslateFn;
	/** The engine's vocabulary in ITS OWN delimiters, from the catalog row. */
	tagList: string;
}

/**
 * The read-aloud "Inline tags" switch: run the text through the post-processing
 * LLM before synthesis so it can insert the SELECTED model's inline
 * paralinguistic tags (`<laugh>` on Orpheus, `[laugh]` on Chatterbox Turbo)
 * where the delivery calls for them.
 *
 * The tooltip quotes the model's real vocabulary — it arrives from the catalog
 * row via `formatInlineTagList`, so this component never spells a delimiter out
 * and the copy stays true when a future engine ships a third syntax.
 *
 * Blocked (post-processing off / no model) keeps the row VISIBLE with the switch
 * inert and the reason as a plain caption. Two deliberate choices there. The row
 * stays rather than vanishing, because the capability does exist on this engine
 * and a disappeared row tells the user nothing about what to fix. And only the
 * switch is disabled, not the whole `SettingField` — dimming the row would dim
 * the very sentence explaining how to unblock it.
 */
export function InlineTagsField({
	blockedBy,
	enabled,
	onChange,
	t,
	tagList,
}: InlineTagsFieldProps) {
	const blocked = blockedBy !== null;
	return (
		<SettingField
			// The caption carries whichever fact matters right now: how to unblock
			// the row, or — once it IS usable — the model's actual vocabulary, so the
			// user can also type a tag by hand without hunting for the picker card.
			caption={
				blocked
					? t("inlineTagsNeedsPostProcessing")
					: t("inlineTagsVocabulary", { tags: tagList })
			}
			defaultValue={DEFAULT_SETTINGS.tts.inlineTags}
			label={t("inlineTagsLabel")}
			// Shows the PERSISTED choice even while blocked, rather than faking an
			// off state: the user's intent survives toggling post-processing off and
			// back on, and the inert switch + caption already say it isn't running.
			// (The backend is fail-soft over the same window — it reads the text
			// unannotated instead of refusing to read it at all.)
			labelAddon={
				<Toggle
					aria-label={t("inlineTagsLabel")}
					checked={enabled}
					disabled={blocked}
					onCheckedChange={onChange}
				/>
			}
			layout="row"
			onReset={() => onChange(DEFAULT_SETTINGS.tts.inlineTags)}
			tooltip={t("inlineTagsTooltip", { tags: tagList })}
			value={enabled}
		/>
	);
}
