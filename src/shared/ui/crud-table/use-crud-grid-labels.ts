import { useTranslations } from "use-intl";
import type { DataGridLabels } from "@/shared/ui/data-grid";

/**
 * The DataGrid chrome strings for {@link CrudTable}: the grid-generic labels
 * come from the shared `common` namespace, while the table's own empty state is
 * caller-supplied. Extracted so the table shell stays a thin composition root.
 */
export function useCrudGridLabels(emptyState: string): DataGridLabels {
	const tGrid = useTranslations("common");
	return {
		columns: tGrid("columns"),
		emptyState,
		nextPage: tGrid("nextPage"),
		noResults: tGrid("noResults"),
		previousPage: tGrid("previousPage"),
		rowsPerPage: tGrid("rowsPerPage"),
		search: tGrid("search"),
		formatPaginationInfo: ({ count, from, to }) =>
			tGrid("paginationInfo", { count, from, to }),
		formatSortBy: (column) => tGrid("sortBy", { column }),
	};
}
