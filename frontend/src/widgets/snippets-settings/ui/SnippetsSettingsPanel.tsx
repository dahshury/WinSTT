"use client";

import { useTranslations } from "next-intl";
import { SettingSection } from "@/entities/setting";
import { SnippetsTable } from "@/features/manage-snippets";
import { useSettingsStore } from "@/features/update-settings";

export function SnippetsSettingsPanel() {
	const snippets = useSettingsStore((s) => s.settings.snippets) ?? [];
	const setSettings = useSettingsStore((s) => s.setSettings);
	const settings = useSettingsStore((s) => s.settings);
	const t = useTranslations("snippets");

	return (
		<SettingSection title={t("title")}>
			<div className="py-2">
				<p className="mb-3 text-[12px] text-foreground-muted">{t("description")}</p>
				<SnippetsTable
					entries={snippets}
					onAdd={(entry) => {
						setSettings({
							...settings,
							snippets: [...snippets, { ...entry, id: crypto.randomUUID() }],
						});
					}}
					onClearAll={() => {
						setSettings({ ...settings, snippets: [] });
					}}
					onRemove={(id) => {
						setSettings({
							...settings,
							snippets: snippets.filter((e) => e.id !== id),
						});
					}}
				/>
			</div>
		</SettingSection>
	);
}
