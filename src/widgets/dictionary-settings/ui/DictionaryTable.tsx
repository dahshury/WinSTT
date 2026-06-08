import { TextIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import {
	addDictionaryEntrySchema,
	type DictionaryEntry,
} from "@/shared/config/settings-schema";
import { Badge } from "@/shared/ui/badge";
import { CrudTable } from "@/shared/ui/crud-table";
import { dictionaryContainsTerm } from "../lib/dictionary-terms";

export interface DictionaryTableProps {
	entries: DictionaryEntry[];
	onAdd: (entry: Omit<DictionaryEntry, "id">) => void;
	onClearAll?: () => void;
	onRemove: (id: string) => void;
	onRemoveMany?: (ids: string[]) => void;
	onUpdate?: (id: string, entry: Omit<DictionaryEntry, "id">) => void;
}

export function DictionaryTable({
	entries,
	onAdd,
	onRemove,
	onRemoveMany,
	onClearAll,
	onUpdate,
}: DictionaryTableProps) {
	const t = useTranslations("dictionary");
	const tc = useTranslations("common");
	const addSchema = addDictionaryEntrySchema.superRefine((entry, ctx) => {
		if (dictionaryContainsTerm(entries, entry.term)) {
			ctx.addIssue({
				code: "custom",
				message: "Already added",
				path: ["term"],
			});
		}
	});
	const updateSchema = (current: DictionaryEntry) =>
		addDictionaryEntrySchema.superRefine((entry, ctx) => {
			if (
				dictionaryContainsTerm(
					entries.filter((e) => e.id !== current.id),
					entry.term,
				)
			) {
				ctx.addIssue({
					code: "custom",
					message: "Already added",
					path: ["term"],
				});
			}
		});

	return (
		<CrudTable
			columnControls
			columns={[
				{
					cellClassName: "text-foreground",
					editFieldName: "term",
					header: t("term"),
					render: (e) => e.term,
				},
				{
					accessor: (e) =>
						e.autoAdded === true ? t("sourceAuto") : t("sourceManual"),
					header: t("source"),
					render: (e) => (
						<Badge variant={e.autoAdded === true ? "default" : "outline"}>
							{e.autoAdded === true ? t("sourceAuto") : t("sourceManual")}
						</Badge>
					),
					width: "w-28",
				},
			]}
			deleteLabelFor={(e) => e.term}
			entries={entries}
			fields={[
				{
					icon: TextIcon,
					label: t("term"),
					name: "term",
					placeholder: t("termPlaceholder"),
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
			schema={addSchema}
			searchable
			sortable
			{...(onClearAll ? { onClearAll } : {})}
			{...(onUpdate ? { onUpdate, updateSchema } : {})}
		/>
	);
}
