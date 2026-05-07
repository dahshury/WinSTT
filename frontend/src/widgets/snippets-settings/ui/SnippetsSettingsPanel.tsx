"use client";

import { Note01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { SnippetsTable } from "@/features/manage-snippets";

export function SnippetsSettingsPanel() {
	const snippets = useSettingsStore((s) => s.settings.snippets) ?? [];
	const updateSnippets = useSettingsStore((s) => s.updateSnippets);
	const t = useTranslations("snippets");

	return (
		<SettingSection icon={Note01Icon} title={t("title")}>
			<div className="py-2">
				<p className="mb-3 text-body-sm text-foreground-muted">{t("description")}</p>
				<SnippetsTable
					entries={snippets}
					onAdd={(entry) => {
						updateSnippets([...snippets, { ...entry, id: crypto.randomUUID() }]);
					}}
					onClearAll={() => {
						updateSnippets([]);
					}}
					onRemove={(id) => {
						updateSnippets(snippets.filter((e) => e.id !== id));
					}}
				/>
			</div>
		</SettingSection>
	);
}
