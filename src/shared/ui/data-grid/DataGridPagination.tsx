import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Select } from "@/shared/ui/select";
import { useDataGrid } from "./data-grid-context";

const PAGE_SIZE_OPTIONS = [5, 10, 25, 50] as const;

const PAGER_BUTTON_CLASS =
	"rounded p-1 text-foreground-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-foreground-muted";

/**
 * Page-size selector + previous/next controls + a "{from}–{to} of {count}"
 * readout. Reads the live table instance from context; the host only renders
 * this when pagination is enabled. `showPageSize={false}` drops the
 * rows-per-page selector entirely — for consumers that pin a fixed page size
 * (the page count isn't user-tunable, so the readout + pager stand alone).
 */
export function DataGridPagination({
	showPageSize = true,
}: {
	showPageSize?: boolean;
}) {
	const { labels, table } = useDataGrid();
	const { pageIndex, pageSize } = table.getState().pagination;
	const count = table.getFilteredRowModel().rows.length;
	const from = count === 0 ? 0 : pageIndex * pageSize + 1;
	const to = Math.min((pageIndex + 1) * pageSize, count);
	const options = PAGE_SIZE_OPTIONS.map((size) => ({
		id: String(size),
		label: String(size),
	}));

	return (
		<div
			className={cn(
				"flex items-center gap-3 pt-1",
				showPageSize ? "justify-between" : "justify-end",
			)}
		>
			{showPageSize ? (
				<div className="flex items-center gap-2">
					<span className="shrink-0 text-2xs text-foreground-secondary">
						{labels.rowsPerPage}
					</span>
					<div className="w-[4.5rem]">
						<Select
							aria-label={labels.rowsPerPage}
							onChange={(next) => table.setPageSize(Number(next))}
							options={options}
							value={String(pageSize)}
						/>
					</div>
				</div>
			) : null}
			<div className="flex items-center gap-2">
				<span className="text-2xs text-foreground-secondary tabular-nums">
					{labels.formatPaginationInfo({ count, from, to })}
				</span>
				<Button
					aria-label={labels.previousPage}
					className={PAGER_BUTTON_CLASS}
					disabled={!table.getCanPreviousPage()}
					onClick={() => table.previousPage()}
				>
					<HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
				</Button>
				<Button
					aria-label={labels.nextPage}
					className={PAGER_BUTTON_CLASS}
					disabled={!table.getCanNextPage()}
					onClick={() => table.nextPage()}
				>
					<HugeiconsIcon icon={ArrowRight01Icon} size={16} />
				</Button>
			</div>
		</div>
	);
}
