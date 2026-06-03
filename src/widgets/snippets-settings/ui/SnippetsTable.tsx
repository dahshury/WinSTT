import { FlashIcon, Note01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import type { SnippetEntry } from "@/bindings";
import { addSnippetEntrySchema } from "@/shared/config/settings-schema";
import { CrudTable } from "@/shared/ui/crud-table";

export interface SnippetsTableProps {
	entries: SnippetEntry[];
	onAdd: (entry: Omit<SnippetEntry, "id">) => void;
	onClearAll?: () => void;
	onRemove: (id: string) => void;
}

export function SnippetsTable({ entries, onAdd, onRemove, onClearAll }: SnippetsTableProps) {
	const t = useTranslations("snippets");
	const tc = useTranslations("common");
	return (
		<CrudTable
			columns={[
				{
					cellClassName: "text-purple",
					header: t("trigger"),
					render: (e) => e.trigger,
					width: "w-1/3",
				},
				{ cellClassName: "text-foreground", header: t("expansion"), render: (e) => e.expansion },
			]}
			deleteLabelFor={(e) => e.trigger}
			entries={entries}
			fields={[
				{
					icon: FlashIcon,
					label: t("trigger"),
					name: "trigger",
					placeholder: t("triggerPlaceholder"),
					width: "w-1/3",
				},
				{
					icon: Note01Icon,
					label: t("expansion"),
					name: "expansion",
					placeholder: t("expansionPlaceholder"),
					width: "flex-1",
				},
			]}
			getId={(e) => e.id}
			labels={{
				add: tc("add"),
				clearDescription: t("clearDescription"),
				clearTitle: t("clearTitle"),
				delete: tc("delete"),
				deleteAll: tc("deleteAll"),
				emptyState: t("emptyState"),
			}}
			onAdd={onAdd}
			onRemove={onRemove}
			schema={addSnippetEntrySchema}
			{...(onClearAll ? { onClearAll } : {})}
		/>
	);
}
