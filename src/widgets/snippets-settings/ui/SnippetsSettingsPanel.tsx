import { StickyNote01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { generateId } from "@/shared/lib/generate-id";
import { SnippetsTable } from "./SnippetsTable";

export function SnippetsSettingsPanel() {
	const snippets = useSettingsStore((s) => s.settings.snippets) ?? [];
	const updateSnippets = useSettingsStore((s) => s.updateSnippets);
	const t = useTranslations("snippets");

	return (
		<SettingSection
			description={t("description")}
			icon={StickyNote01Icon}
			title={t("title")}
		>
			<div className="py-2">
				<SnippetsTable
					entries={snippets}
					onAdd={(entry) => {
						updateSnippets([...snippets, { ...entry, id: generateId() }]);
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
