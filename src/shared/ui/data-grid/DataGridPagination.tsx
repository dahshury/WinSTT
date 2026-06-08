import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ButtonGroup } from "@/shared/ui/button-group";
import { Select } from "@/shared/ui/select";
import { useDataGrid } from "./data-grid-context";

const PAGE_SIZE_OPTIONS = [5, 10, 25, 50] as const;

const PAGER_BUTTON_CLASS =
	"h-7 gap-1.5 bg-transparent px-2 text-2xs text-foreground-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-foreground-muted";
const PAGE_BUTTON_CLASS =
	"h-7 min-w-7 bg-transparent px-2 text-2xs text-foreground-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-foreground";

function visiblePages(currentPage: number, totalPages: number): number[] {
	const size = Math.min(totalPages, 5);
	const start = Math.max(1, Math.min(currentPage - 2, totalPages - size + 1));
	return Array.from({ length: size }, (_, index) => start + index);
}

/**
 * Page-size selector + numbered page controls + a "{from}-{to} of {count}"
 * readout. Reads the live table instance from context; the host only renders
 * this when pagination is enabled. `showPageSize={false}` drops the
 * rows-per-page selector entirely for fixed-size tables.
 */
export function DataGridPagination({
	actions,
	showPageSize = true,
}: {
	actions?: ReactNode;
	showPageSize?: boolean;
}) {
	const { labels, table } = useDataGrid();
	const { pageIndex, pageSize } = table.getState().pagination;
	const count = table.getFilteredRowModel().rows.length;
	const from = count === 0 ? 0 : pageIndex * pageSize + 1;
	const to = Math.min((pageIndex + 1) * pageSize, count);
	const totalPages = Math.max(table.getPageCount(), 1);
	const currentPage = Math.min(pageIndex + 1, totalPages);
	const pages = visiblePages(currentPage, totalPages);
	const options = PAGE_SIZE_OPTIONS.map((size) => ({
		id: String(size),
		label: String(size),
	}));

	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-3 pt-1",
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
			<div className="ml-auto flex flex-wrap items-center justify-end gap-2">
				<span className="text-2xs text-foreground-secondary tabular-nums">
					{labels.formatPaginationInfo({ count, from, to })}
				</span>
				<ButtonGroup aria-label="Pagination" connected>
					<Button
						aria-label={labels.previousPage}
						className={PAGER_BUTTON_CLASS}
						disabled={!table.getCanPreviousPage()}
						onClick={() => table.previousPage()}
					>
						<HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
						<span>{labels.previousPage}</span>
					</Button>
					{pages.map((page) => {
						const isCurrent = page === currentPage;
						return (
							<Button
								aria-current={isCurrent ? "page" : undefined}
								aria-label={`Page ${page}`}
								className={cn(
									PAGE_BUTTON_CLASS,
									isCurrent &&
										"bg-accent text-white hover:bg-accent-hover hover:text-white",
								)}
								key={page}
								onClick={() => table.setPageIndex(page - 1)}
							>
								{page}
							</Button>
						);
					})}
					<Button
						aria-label={labels.nextPage}
						className={PAGER_BUTTON_CLASS}
						disabled={!table.getCanNextPage()}
						onClick={() => table.nextPage()}
					>
						<span>{labels.nextPage}</span>
						<HugeiconsIcon icon={ArrowRight01Icon} size={14} />
					</Button>
				</ButtonGroup>
				{actions}
			</div>
		</div>
	);
}
