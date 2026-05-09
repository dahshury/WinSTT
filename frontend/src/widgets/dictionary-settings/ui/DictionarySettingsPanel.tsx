"use client";

import { TextIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { DictionaryTable } from "@/features/manage-dictionary";
import { generateId } from "@/shared/lib/generate-id";

export function DictionarySettingsPanel() {
	const dictionary = useSettingsStore((s) => s.settings.dictionary) ?? [];
	const updateDictionary = useSettingsStore((s) => s.updateDictionary);
	const t = useTranslations("dictionary");

	return (
		<SettingSection icon={TextIcon} title={t("title")}>
			<div className="py-2">
				<p className="mb-3 text-body-sm text-foreground-muted">{t("description")}</p>
				<DictionaryTable
					entries={dictionary}
					onAdd={(entry) => {
						updateDictionary([...dictionary, { ...entry, id: generateId() }]);
					}}
					onClearAll={() => {
						updateDictionary([]);
					}}
					onRemove={(id) => {
						updateDictionary(dictionary.filter((e) => e.id !== id));
					}}
					onUpdate={(id, patch) => {
						updateDictionary(dictionary.map((e) => (e.id === id ? { ...e, ...patch } : e)));
					}}
				/>
			</div>
		</SettingSection>
	);
}
