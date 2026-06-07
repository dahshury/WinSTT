import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/shared/ui/input-group";
import { useDataGrid } from "./data-grid-context";
import { DataGridColumnVisibility } from "./DataGridColumnVisibility";

export type DataGridToolbarAppearance = "elevated" | "minimal";

/**
 * Controls strip that rides ABOVE the add row: a global-search field shaped
 * like the table's own add-entry field — `[search icon] [input] [columns]` —
 * with the column-visibility trigger nested in the trailing addon slot, so the
 * search box and the columns button read as one grouped control rather than two
 * separate things. `appearance` mirrors the consumer's add form (`elevated` for
 * the separate layout, `minimal` for the joined layout) so the search and the
 * add field look like the same control family.
 *
 * Deliberately a plain input-group `<div>` (never `role="toolbar"`) so it never
 * collides with the add-form's button toolbar, and the search is a
 * `type="search"` input (role `searchbox`, not `textbox`) — the add field
 * relies on being the only `textbox`.
 */
export function DataGridToolbar({
	appearance = "minimal",
	columnControls = false,
	searchable = false,
}: {
	appearance?: DataGridToolbarAppearance;
	columnControls?: boolean;
	searchable?: boolean;
}) {
	const { labels, table } = useDataGrid();
	if (!(searchable || columnControls)) {
		return null;
	}
	const rawFilter = table.getState().globalFilter;
	const value = typeof rawFilter === "string" ? rawFilter : "";

	// Column-visibility only (no search): a lone trigger, right-aligned.
	if (!searchable) {
		return (
			<div className="flex items-center justify-end">
				<DataGridColumnVisibility label={labels.columns} table={table} />
			</div>
		);
	}

	return (
		<InputGroup appearance={appearance} className="h-9" size="sm">
			<InputGroupAddon align="inline-start">
				<HugeiconsIcon aria-hidden="true" icon={Search01Icon} size={14} />
			</InputGroupAddon>
			<InputGroupInput
				aria-label={labels.search}
				onChange={(event) => table.setGlobalFilter(event.target.value)}
				placeholder={labels.search}
				type="search"
				value={value}
			/>
			{columnControls ? (
				<InputGroupAddon align="inline-end">
					<DataGridColumnVisibility
						embedded
						label={labels.columns}
						table={table}
					/>
				</InputGroupAddon>
			) : null}
		</InputGroup>
	);
}
