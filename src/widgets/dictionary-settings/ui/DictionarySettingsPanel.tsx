import { BookOpenTextIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import type { DictionaryEntry } from "@/shared/config/settings-schema";
import { generateId } from "@/shared/lib/generate-id";
import { Badge } from "@/shared/ui/badge";
import { dictionaryContainsTerm } from "../lib/dictionary-terms";
import { AutoAddSuggestions } from "./AutoAddSuggestions";
import { DictionaryTable } from "./DictionaryTable";

export function DictionarySettingsPanel() {
	const dictionary = useSettingsStore((s) => s.settings.dictionary) ?? [];
	const updateDictionary = useSettingsStore((s) => s.updateDictionary);
	const t = useTranslations("dictionary");

	// Compute existing terms inline (React Compiler memoises this — per
	// project convention, no manual useMemo).
	const existingTerms = dictionary.map((e) => e.term);

	const handleAdd = (entry: Omit<DictionaryEntry, "id">): void => {
		const term = entry.term.trim();
		const currentDictionary =
			useSettingsStore.getState().settings.dictionary ?? [];
		if (!term || dictionaryContainsTerm(currentDictionary, term)) {
			return;
		}
		updateDictionary([
			...currentDictionary,
			{ ...entry, term, id: generateId() },
		]);
	};

	return (
		<SettingSection
			description={t("description")}
			headerAction={
				dictionary.length > 0 ? (
					<Badge
						aria-hidden="true"
						className="tabular-nums"
						variant="secondary"
					>
						{dictionary.length}
					</Badge>
				) : undefined
			}
			icon={BookOpenTextIcon}
			title={t("title")}
		>
			<div className="flex flex-col gap-3 py-2">
				<AutoAddSuggestions
					existingTerms={existingTerms}
					onAccept={(term) => handleAdd({ term, autoAdded: true })}
				/>
				<DictionaryTable entries={dictionary} onChange={updateDictionary} />
			</div>
		</SettingSection>
	);
}
