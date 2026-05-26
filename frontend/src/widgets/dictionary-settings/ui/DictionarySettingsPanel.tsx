import { TextIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { DEFAULT_SETTINGS, SettingSection, useSettingsStore } from "@/entities/setting";
import type { DictionaryEntry } from "@/shared/config/settings-schema";
import { generateId } from "@/shared/lib/generate-id";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { AutoAddSuggestions } from "./AutoAddSuggestions";
import { DictionaryTable } from "./DictionaryTable";

export function DictionarySettingsPanel() {
	const dictionary = useSettingsStore((s) => s.settings.dictionary) ?? [];
	const updateDictionary = useSettingsStore((s) => s.updateDictionary);
	const general = useSettingsStore((s) => s.settings.general);
	const updateGeneralSettings = useSettingsStore((s) => s.updateGeneralSettings);
	const t = useTranslations("dictionary");

	// Compute existing terms inline (React Compiler memoises this — per
	// project convention, no manual useMemo).
	const existingTerms = dictionary.map((e) => e.term);
	const threshold =
		general?.wordCorrectionThreshold ?? DEFAULT_SETTINGS.general.wordCorrectionThreshold;

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
				{/* Threshold for the server-side deterministic fuzzy corrector. The
				    matcher runs BEFORE the LLM modifier pipeline, so the LLM still
				    sees post-dictionary text and can fix anything the deterministic
				    pass missed. Lower = stricter; 0.18 mirrors Handy's reference. */}
				<FormControl
					caption={t("thresholdCaption")}
					label={t("thresholdLabel")}
					tooltip={t("thresholdTooltip")}
				>
					<ElevatedSurface className="w-fit" inline>
						<NumberStepper
							max={1.0}
							min={0.0}
							onChange={(v) => updateGeneralSettings({ wordCorrectionThreshold: v })}
							step={0.02}
							value={threshold}
						/>
					</ElevatedSurface>
				</FormControl>
			</div>
		</SettingSection>
	);
}
