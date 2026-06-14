import { BookOpenTextIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import type { DictionaryEntry } from "@/shared/config/settings-schema";
import { generateId } from "@/shared/lib/generate-id";
import { Badge } from "@/shared/ui/badge";
import { dictionaryContainsTerm } from "../lib/dictionary-terms";
import { AutoAddSuggestions } from "./AutoAddSuggestions";
import { DictionaryTable } from "./DictionaryTable";
import { EncoderModelCard } from "./EncoderModelCard";

export function DictionarySettingsPanel() {
	const dictionary = useSettingsStore((s) => s.settings.dictionary) ?? [];
	const updateDictionary = useSettingsStore((s) => s.updateDictionary);
	// When LLM cleanup is off, the dictionary is applied by the on-device encoder model — surface
	// its (opt-in) download here. When cleanup is on, the LLM does it and the card is hidden.
	const llmCleanupEnabled = useSettingsStore(
		(s) => s.settings.llm?.dictation?.enabled ?? false,
	);
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

	const handleUpdate = (
		id: string,
		entry: Omit<DictionaryEntry, "id">,
	): void => {
		const term = entry.term.trim();
		const currentDictionary =
			useSettingsStore.getState().settings.dictionary ?? [];
		if (
			!term ||
			dictionaryContainsTerm(
				currentDictionary.filter((e) => e.id !== id),
				term,
			)
		) {
			return;
		}
		updateDictionary(
			currentDictionary.map((existing) =>
				existing.id === id ? { ...existing, ...entry, term } : existing,
			),
		);
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
				{llmCleanupEnabled ? null : <EncoderModelCard />}
				<AutoAddSuggestions
					existingTerms={existingTerms}
					onAccept={(term) => handleAdd({ term, autoAdded: true })}
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
					onRemoveMany={(ids) => {
						const selected = new Set(ids);
						const currentDictionary =
							useSettingsStore.getState().settings.dictionary ?? [];
						updateDictionary(
							currentDictionary.filter((entry) => !selected.has(entry.id)),
						);
					}}
					onUpdate={handleUpdate}
				/>
			</div>
		</SettingSection>
	);
}
