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
	onUpdate?: (id: string, entry: Omit<SnippetEntry, "id">) => void;
}

export function SnippetsTable({
	entries,
	onAdd,
	onRemove,
	onClearAll,
	onUpdate,
}: SnippetsTableProps) {
	const t = useTranslations("snippets");
	const tc = useTranslations("common");
	return (
		<CrudTable
			addFormLayout="joined"
			columnControls
			columns={[
				{
					cellClassName: "text-purple",
					editFieldName: "trigger",
					header: t("trigger"),
					render: (e) => e.trigger,
					width: "w-1/3",
				},
				{
					cellClassName: "text-foreground",
					editFieldName: "expansion",
					header: t("expansion"),
					render: (e) => e.expansion,
				},
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
				cancel: tc("cancel"),
				clearDescription: t("clearDescription"),
				clearTitle: t("clearTitle"),
				delete: tc("delete"),
				deleteAll: tc("deleteAll"),
				edit: tc("edit"),
				emptyState: t("emptyState"),
				save: tc("save"),
			}}
			onAdd={onAdd}
			onRemove={onRemove}
			pageSize={5}
			paginated
			schema={addSnippetEntrySchema}
			searchable
			sortable
			{...(onClearAll ? { onClearAll } : {})}
			{...(onUpdate ? { onUpdate } : {})}
		/>
	);
}
