import { AiEditingIcon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	type UpdateGeneralFn,
} from "@/entities/setting";
import { Toggle } from "@/shared/ui/toggle";

export interface AiHandlingSectionProps {
	llmHandlesDictionary: boolean;
	llmHandlesSnippets: boolean;
	onChange: UpdateGeneralFn;
}

/**
 * Per-section routing between the cleanup AI and the deterministic paths, shown only while
 * dictation cleanup is on. Dictionary ON = terms + replacement pairs ride in the cleanup prompt
 * and the LLM fixes mis-hearings in context; OFF = they stay out of the prompt and the on-device
 * encoder model owns corrections (the encoder card reappears below). Snippets ON = the LLM
 * expands triggers contextually; OFF = the deterministic fuzzy matcher expands them after
 * cleanup. Persists to `general.llmHandlesDictionary` / `general.llmHandlesSnippets`.
 */
export function AiHandlingSection({
	llmHandlesDictionary,
	llmHandlesSnippets,
	onChange,
}: AiHandlingSectionProps): ReactNode {
	const t = useTranslations("dictionary");
	return (
		<SettingSection
			boxed
			description={t("aiHandlingDescription")}
			icon={AiEditingIcon}
			title={t("aiHandlingTitle")}
		>
			<SettingField
				defaultValue={DEFAULT_SETTINGS.general.llmHandlesDictionary}
				label={t("llmHandlesDictionaryLabel")}
				labelAddon={
					<Toggle
						checked={llmHandlesDictionary}
						onCheckedChange={(next) => onChange({ llmHandlesDictionary: next })}
					/>
				}
				onReset={() =>
					onChange({
						llmHandlesDictionary: DEFAULT_SETTINGS.general.llmHandlesDictionary,
					})
				}
				tooltip={t("llmHandlesDictionaryTooltip")}
				value={llmHandlesDictionary}
			/>
			<SettingField
				defaultValue={DEFAULT_SETTINGS.general.llmHandlesSnippets}
				label={t("llmHandlesSnippetsLabel")}
				labelAddon={
					<Toggle
						checked={llmHandlesSnippets}
						onCheckedChange={(next) => onChange({ llmHandlesSnippets: next })}
					/>
				}
				onReset={() =>
					onChange({
						llmHandlesSnippets: DEFAULT_SETTINGS.general.llmHandlesSnippets,
					})
				}
				tooltip={t("llmHandlesSnippetsTooltip")}
				value={llmHandlesSnippets}
			/>
		</SettingSection>
	);
}
