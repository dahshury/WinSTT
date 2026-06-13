import {
	ArrowRight01Icon,
	FlashIcon,
	Note01Icon,
	StickyNote01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import type { SnippetEntry } from "@/bindings";
import { addSnippetEntrySchema } from "@/shared/config/settings-schema";
import { CrudTable } from "@/shared/ui/crud-table";

export interface SnippetsTableProps {
	entries: SnippetEntry[];
	onAdd: (entry: Omit<SnippetEntry, "id">) => void;
	onClearAll?: () => void;
	onRemove: (id: string) => void;
	onRemoveMany?: (ids: string[]) => void;
	onUpdate?: (id: string, entry: Omit<SnippetEntry, "id">) => void;
}

export function SnippetsTable({
	entries,
	onAdd,
	onRemove,
	onRemoveMany,
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
					editFieldName: "trigger",
					header: t("trigger"),
					render: (e) => (
						<code className="inline-block rounded bg-surface-5/70 px-1.5 py-0.5 font-mono text-2xs text-teal ring-1 ring-divider/70">
							{e.trigger}
						</code>
					),
					width: "w-1/3",
				},
				{
					cellClassName: "text-foreground-secondary",
					editFieldName: "expansion",
					header: t("expansion"),
					render: (e) => (
						<span className="inline-flex min-w-0 items-center gap-1.5">
							<HugeiconsIcon
								aria-hidden="true"
								className="shrink-0 text-foreground-dim"
								icon={ArrowRight01Icon}
								size={12}
							/>
							<span className="min-w-0 break-words">{e.expansion}</span>
						</span>
					),
				},
			]}
			deleteLabelFor={(e) => e.trigger}
			emptyIcon={StickyNote01Icon}
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
			{...(onRemoveMany ? { onRemoveMany } : {})}
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
