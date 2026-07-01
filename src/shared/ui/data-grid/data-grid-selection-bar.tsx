import { Cancel01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Table } from "@tanstack/react-table";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/data-grid/primitives/button";

interface DataGridSelectionBarProps<TData> {
	table: Table<TData>;
	/** Delete the currently-selected rows. Selection is cleared afterwards. */
	onDeleteSelected?: (rows: TData[]) => void;
	className?: string;
}

/**
 * Floating action pill surfaced while rows are selected — mirrors the
 * tablecn data-table action bar. Shows the selection count, a clear button,
 * and a destructive Delete. Renders nothing when the selection is empty.
 */
export function DataGridSelectionBar<TData>({
	table,
	onDeleteSelected,
	className,
}: DataGridSelectionBarProps<TData>) {
	const t = useTranslations("dataGrid");
	const selectedRows = table.getSelectedRowModel().rows;
	const count = selectedRows.length;
	if (count === 0) return null;

	const clear = () => table.resetRowSelection();
	const deleteSelected = () => {
		onDeleteSelected?.(selectedRows.map((row) => row.original));
		table.resetRowSelection();
	};

	return (
		<div
			aria-label={t("selected", { count })}
			className={cn(
				"fade-in-0 zoom-in-95 flex animate-in items-center gap-1 rounded-full border border-border bg-surface-6 py-1 ps-3 pe-1 shadow-overlay",
				className,
			)}
			role="toolbar"
		>
			<span className="text-foreground text-xs tabular-nums">
				{t("selected", { count })}
			</span>
			<button
				aria-label={t("clearSelection")}
				className="flex size-5 items-center justify-center rounded-full text-foreground-muted outline-none transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
				onClick={clear}
				type="button"
			>
				<HugeiconsIcon icon={Cancel01Icon} size={13} />
			</button>
			<div className="mx-1 h-4 w-px bg-divider" />
			<Button
				className="h-7 text-error hover:bg-error/10 hover:text-error"
				onClick={deleteSelected}
				size="sm"
				variant="ghost"
			>
				<HugeiconsIcon icon={Delete02Icon} size={14} />
				{t("deleteRows")}
			</Button>
		</div>
	);
}
