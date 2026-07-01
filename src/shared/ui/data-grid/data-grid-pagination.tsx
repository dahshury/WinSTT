import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Table } from "@tanstack/react-table";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/data-grid/primitives/button";

interface DataGridPaginationProps<TData> {
	table: Table<TData>;
	className?: string;
}

/**
 * Compact page navigator shown beneath a paginated grid. Renders nothing while
 * the data fits a single page, so a short list reads as a plain table.
 */
export function DataGridPagination<TData>({
	table,
	className,
}: DataGridPaginationProps<TData>) {
	const t = useTranslations("dataGrid");
	const pageCount = table.getPageCount();
	if (pageCount <= 1) return null;
	const { pageIndex } = table.getState().pagination;

	return (
		<div className={cn("flex items-center gap-1", className)}>
			<span className="px-1.5 text-foreground-muted text-xs tabular-nums">
				{t("pageOf", { current: pageIndex + 1, total: pageCount })}
			</span>
			<Button
				aria-label={t("previousPage")}
				className="size-7"
				disabled={!table.getCanPreviousPage()}
				onClick={() => table.previousPage()}
				size="icon"
				variant="outline"
			>
				<HugeiconsIcon icon={ArrowLeft01Icon} size={15} />
			</Button>
			<Button
				aria-label={t("nextPage")}
				className="size-7"
				disabled={!table.getCanNextPage()}
				onClick={() => table.nextPage()}
				size="icon"
				variant="outline"
			>
				<HugeiconsIcon icon={ArrowRight01Icon} size={15} />
			</Button>
		</div>
	);
}
