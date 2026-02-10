"use client";

import { useTranslations } from "next-intl";
import { SettingSection } from "@/entities/setting";
import { DictionaryTable } from "@/features/manage-dictionary";
import { useSettingsStore } from "@/features/update-settings";

export function DictionarySettingsPanel() {
	const dictionary = useSettingsStore((s) => s.settings.dictionary) ?? [];
	const setSettings = useSettingsStore((s) => s.setSettings);
	const settings = useSettingsStore((s) => s.settings);
	const t = useTranslations("dictionary");

	return (
		<SettingSection title={t("title")}>
			<div style={{ padding: "8px 0" }}>
				<p
					style={{
						color: "var(--color-text-muted)",
						fontSize: "12px",
						marginBottom: "12px",
					}}
				>
					{t("description")}
				</p>
				<DictionaryTable
					entries={dictionary}
					onAdd={(entry) => {
						setSettings({
							...settings,
							dictionary: [...dictionary, { ...entry, id: crypto.randomUUID() }],
						});
					}}
					onClearAll={() => {
						setSettings({ ...settings, dictionary: [] });
					}}
					onRemove={(id) => {
						setSettings({
							...settings,
							dictionary: dictionary.filter((e) => e.id !== id),
						});
					}}
					onUpdate={(id, patch) => {
						setSettings({
							...settings,
							dictionary: dictionary.map((e) => (e.id === id ? { ...e, ...patch } : e)),
						});
					}}
				/>
			</div>
		</SettingSection>
	);
}
