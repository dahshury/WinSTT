import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Table } from "@tanstack/react-table";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import { ButtonGroup } from "@/shared/ui/button-group";
import { Button } from "@/shared/ui/data-grid/primitives/button";

interface DataGridPaginationProps<TData> {
	table: Table<TData>;
	className?: string;
}

type PaginationItem = number | "ellipsis-start" | "ellipsis-end";

function range(start: number, end: number): number[] {
	return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function getPaginationItems(
	pageIndex: number,
	pageCount: number,
): PaginationItem[] {
	const currentPage = pageIndex + 1;
	if (pageCount <= 7) {
		return range(1, pageCount);
	}
	if (currentPage <= 3) {
		return [1, 2, 3, "ellipsis-end", pageCount];
	}
	if (currentPage >= pageCount - 2) {
		return [1, "ellipsis-start", pageCount - 2, pageCount - 1, pageCount];
	}
	return [
		1,
		"ellipsis-start",
		currentPage - 1,
		currentPage,
		currentPage + 1,
		"ellipsis-end",
		pageCount,
	];
}

/**
 * Complete page navigator shown beneath a paginated grid. Renders nothing while
 * the data fits a single page, so a short list reads as a plain table.
 */
export function DataGridPagination<TData>({
	table,
	className,
}: DataGridPaginationProps<TData>) {
	const t = useTranslations("dataGrid");
	const pageCount = table.getPageCount();
	if (pageCount <= 1) {
		return null;
	}
	const { pageIndex } = table.getState().pagination;
	const items = getPaginationItems(pageIndex, pageCount);

	return (
		<nav
			aria-label={t("pageOf", { current: pageIndex + 1, total: pageCount })}
			className={cn("flex items-center", className)}
		>
			<ButtonGroup
				aria-label={t("pageOf", { current: pageIndex + 1, total: pageCount })}
				connected
			>
				<Button
					aria-label={t("previousPage")}
					className="h-7 min-w-7 px-2"
					disabled={!table.getCanPreviousPage()}
					onClick={() => table.previousPage()}
					size="sm"
					variant="outline"
				>
					<HugeiconsIcon icon={ArrowLeft01Icon} size={13} />
				</Button>
				{items.map((item) => {
					if (typeof item !== "number") {
						return (
							<span
								aria-hidden="true"
								className="flex h-7 min-w-7 select-none items-center justify-center px-2 text-foreground-muted text-xs"
								key={item}
							>
								...
							</span>
						);
					}
					const itemIndex = item - 1;
					const active = itemIndex === pageIndex;
					return (
						<Button
							aria-current={active ? "page" : undefined}
							aria-label={t("pageOf", { current: item, total: pageCount })}
							className="h-7 min-w-7 px-2 font-mono tabular-nums"
							key={item}
							onClick={() => table.setPageIndex(itemIndex)}
							size="sm"
							variant={active ? "default" : "outline"}
						>
							{item}
						</Button>
					);
				})}
				<Button
					aria-label={t("nextPage")}
					className="h-7 min-w-7 px-2"
					disabled={!table.getCanNextPage()}
					onClick={() => table.nextPage()}
					size="sm"
					variant="outline"
				>
					<HugeiconsIcon icon={ArrowRight01Icon} size={13} />
				</Button>
			</ButtonGroup>
		</nav>
	);
}
