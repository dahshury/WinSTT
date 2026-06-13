import { BookOpenTextIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import type { DictionaryEntry } from "@/shared/config/settings-schema";
import { generateId } from "@/shared/lib/generate-id";
import { Badge } from "@/shared/ui/badge";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { dictionaryContainsTerm } from "../lib/dictionary-terms";
import { AutoAddSuggestions } from "./AutoAddSuggestions";
import { DictionaryTable } from "./DictionaryTable";

export function DictionarySettingsPanel() {
	const dictionary = useSettingsStore((s) => s.settings.dictionary) ?? [];
	const updateDictionary = useSettingsStore((s) => s.updateDictionary);
	const general = useSettingsStore((s) => s.settings.general);
	const updateGeneralSettings = useSettingsStore(
		(s) => s.updateGeneralSettings,
	);
	const t = useTranslations("dictionary");

	// Compute existing terms inline (React Compiler memoises this — per
	// project convention, no manual useMemo).
	const existingTerms = dictionary.map((e) => e.term);
	const threshold =
		general?.wordCorrectionThreshold ??
		DEFAULT_SETTINGS.general.wordCorrectionThreshold;

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
				{/* Threshold for the server-side deterministic fuzzy corrector. The
				    matcher runs BEFORE the LLM modifier pipeline, so the LLM still
				    sees post-dictionary text and can fix anything the deterministic
				    pass missed. Lower = stricter; 0.18 is the reference default. */}
				<SettingField
					defaultValue={DEFAULT_SETTINGS.general.wordCorrectionThreshold}
					label={t("thresholdLabel")}
					layout="row"
					onReset={() =>
						updateGeneralSettings({
							wordCorrectionThreshold:
								DEFAULT_SETTINGS.general.wordCorrectionThreshold,
						})
					}
					tooltip={`${t("thresholdTooltip")} ${t("thresholdCaption")}`}
					value={threshold}
				>
					<ElevatedSurface className="w-fit" inline>
						<NumberStepper
							max={1.0}
							min={0.0}
							onChange={(v) =>
								updateGeneralSettings({ wordCorrectionThreshold: v })
							}
							step={0.02}
							value={threshold}
						/>
					</ElevatedSurface>
				</SettingField>
			</div>
		</SettingSection>
	);
}
