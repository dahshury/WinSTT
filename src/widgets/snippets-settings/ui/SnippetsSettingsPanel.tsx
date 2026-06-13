import { StickyNote01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { generateId } from "@/shared/lib/generate-id";
import { Badge } from "@/shared/ui/badge";
import { SnippetsTable } from "./SnippetsTable";

export function SnippetsSettingsPanel() {
	const snippets = useSettingsStore((s) => s.settings.snippets) ?? [];
	const updateSnippets = useSettingsStore((s) => s.updateSnippets);
	const t = useTranslations("snippets");

	return (
		<SettingSection
			description={t("description")}
			headerAction={
				snippets.length > 0 ? (
					<Badge
						aria-hidden="true"
						className="tabular-nums"
						variant="secondary"
					>
						{snippets.length}
					</Badge>
				) : undefined
			}
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
					onRemoveMany={(ids) => {
						const selected = new Set(ids);
						const currentSnippets =
							useSettingsStore.getState().settings.snippets ?? [];
						updateSnippets(
							currentSnippets.filter((entry) => !selected.has(entry.id)),
						);
					}}
					onUpdate={(id, entry) => {
						const currentSnippets =
							useSettingsStore.getState().settings.snippets ?? [];
						updateSnippets(
							currentSnippets.map((existing) =>
								existing.id === id ? { ...existing, ...entry } : existing,
							),
						);
					}}
				/>
			</div>
		</SettingSection>
	);
}
