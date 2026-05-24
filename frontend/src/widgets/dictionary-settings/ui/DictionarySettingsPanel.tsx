import { TextIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import type { DictionaryEntry } from "@/shared/config/settings-schema";
import { generateId } from "@/shared/lib/generate-id";
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
		updateDictionary([...dictionary, { ...entry, id: generateId() }]);
	};

	return (
		<SettingSection icon={TextIcon} title={t("title")}>
			<div className="flex flex-col gap-3 py-2">
				<p className="text-body-sm text-foreground-muted">{t("description")}</p>
				<AutoAddSuggestions
					existingTerms={existingTerms}
					onAccept={(term) => handleAdd({ term })}
				/>
				<DictionaryTable
					entries={dictionary}
					onAdd={handleAdd}
					onClearAll={() => {
						updateDictionary([]);
					}}
					onRemove={(id) => {
						updateDictionary(dictionary.filter((e) => e.id !== id));
					}}
				/>
			</div>
		</SettingSection>
	);
}
