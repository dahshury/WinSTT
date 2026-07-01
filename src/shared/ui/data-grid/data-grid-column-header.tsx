import type {
	ColumnSort,
	Header,
	SortDirection,
	SortingState,
	Table,
} from "@tanstack/react-table";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	EyeOffIcon,
	PinIcon,
	PinOffIcon,
	XIcon,
} from "@/shared/ui/data-grid/primitives/icons";
import * as React from "react";
import { useTranslations } from "use-intl";

import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/shared/ui/data-grid/primitives/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/shared/ui/data-grid/primitives/tooltip";
import { getColumnVariant } from "@/shared/ui/data-grid/lib/data-grid";
import { cn } from "@/shared/lib/cn";

interface DataGridColumnHeaderProps<TData, TValue> extends React.ComponentProps<
	typeof DropdownMenuTrigger
> {
	header: Header<TData, TValue>;
	table: Table<TData>;
}

export function DataGridColumnHeader<TData, TValue>({
	header,
	table,
	className,
	onPointerDown,
	...props
}: DataGridColumnHeaderProps<TData, TValue>) {
	const t = useTranslations("dataGrid");
	const column = header.column;
	const label = column.columnDef.meta?.label
		? column.columnDef.meta.label
		: typeof column.columnDef.header === "string"
			? column.columnDef.header
			: column.id;

	const isAnyColumnResizing =
		table.getState().columnSizingInfo.isResizingColumn;

	const cellVariant = column.columnDef.meta?.cell;
	const columnVariant = getColumnVariant(cellVariant?.variant);

	const pinnedPosition = column.getIsPinned();
	const isPinnedLeft = pinnedPosition === "left";
	const isPinnedRight = pinnedPosition === "right";

	const onSortingChange = (direction: SortDirection) => {
		table.setSorting((prev: SortingState) => {
			const existingSortIndex = prev.findIndex((sort) => sort.id === column.id);
			const newSort: ColumnSort = {
				id: column.id,
				desc: direction === "desc",
			};

			if (existingSortIndex >= 0) {
				const updated = [...prev];
				updated[existingSortIndex] = newSort;
				return updated;
			} else {
				return [...prev, newSort];
			}
		});
	};

	const onSortRemove = () => {
		table.setSorting((prev: SortingState) =>
			prev.filter((sort) => sort.id !== column.id),
		);
	};

	const onLeftPin = () => {
		column.pin("left");
	};

	const onRightPin = () => {
		column.pin("right");
	};

	const onUnpin = () => {
		column.pin(false);
	};

	const onTriggerPointerDown = (
		event: React.PointerEvent<HTMLButtonElement>,
	) => {
		onPointerDown?.(event);
		if (event.defaultPrevented) return;

		if (event.button !== 0) {
			return;
		}
		table.options.meta?.onColumnClick?.(column.id);
	};

	return (
		<>
			<DropdownMenu modal={false}>
				<DropdownMenuTrigger
					className={cn(
						"flex size-full items-center justify-between gap-2 p-2 text-sm hover:bg-accent/40 data-[state=open]:bg-accent/40 [&_svg]:size-4",
						isAnyColumnResizing && "pointer-events-none",
						className,
					)}
					onPointerDown={onTriggerPointerDown}
					{...props}
				>
					<div className="flex min-w-0 flex-1 items-center gap-1.5">
						{columnVariant && (
							<Tooltip delayDuration={100}>
								<TooltipTrigger asChild>
									<columnVariant.icon className="size-3.5 shrink-0 text-muted-foreground" />
								</TooltipTrigger>
								<TooltipContent side="top">
									<p>{columnVariant.label}</p>
								</TooltipContent>
							</Tooltip>
						)}
						<span className="truncate">{label}</span>
					</div>
					<ChevronDownIcon className="shrink-0 text-muted-foreground" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" sideOffset={0} className="w-60">
					{column.getCanSort() && (
						<>
							<DropdownMenuCheckboxItem
								className="relative ltr:pr-8 ltr:pl-2 rtl:pr-2 rtl:pl-8 [&>span:first-child]:ltr:right-2 [&>span:first-child]:ltr:left-auto [&>span:first-child]:rtl:right-auto [&>span:first-child]:rtl:left-2 [&_svg]:text-muted-foreground"
								checked={column.getIsSorted() === "asc"}
								onSelect={() => onSortingChange("asc")}
							>
								<ChevronUpIcon />
								{t("sortAsc")}
							</DropdownMenuCheckboxItem>
							<DropdownMenuCheckboxItem
								className="relative ltr:pr-8 ltr:pl-2 rtl:pr-2 rtl:pl-8 [&>span:first-child]:ltr:right-2 [&>span:first-child]:ltr:left-auto [&>span:first-child]:rtl:right-auto [&>span:first-child]:rtl:left-2 [&_svg]:text-muted-foreground"
								checked={column.getIsSorted() === "desc"}
								onSelect={() => onSortingChange("desc")}
							>
								<ChevronDownIcon />
								{t("sortDesc")}
							</DropdownMenuCheckboxItem>
							{column.getIsSorted() && (
								<DropdownMenuItem onSelect={onSortRemove}>
									<XIcon />
									{t("removeSort")}
								</DropdownMenuItem>
							)}
						</>
					)}
					{column.getCanPin() && (
						<>
							{column.getCanSort() && <DropdownMenuSeparator />}

							{isPinnedLeft ? (
								<DropdownMenuItem
									className="[&_svg]:text-muted-foreground"
									onSelect={onUnpin}
								>
									<PinOffIcon />
									{t("unpinFromLeft")}
								</DropdownMenuItem>
							) : (
								<DropdownMenuItem
									className="[&_svg]:text-muted-foreground"
									onSelect={onLeftPin}
								>
									<PinIcon />
									{t("pinToLeft")}
								</DropdownMenuItem>
							)}
							{isPinnedRight ? (
								<DropdownMenuItem
									className="[&_svg]:text-muted-foreground"
									onSelect={onUnpin}
								>
									<PinOffIcon />
									{t("unpinFromRight")}
								</DropdownMenuItem>
							) : (
								<DropdownMenuItem
									className="[&_svg]:text-muted-foreground"
									onSelect={onRightPin}
								>
									<PinIcon />
									{t("pinToRight")}
								</DropdownMenuItem>
							)}
						</>
					)}
					{column.getCanHide() && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								className="[&_svg]:text-muted-foreground"
								onSelect={() => column.toggleVisibility(false)}
							>
								<EyeOffIcon />
								{t("hideColumn")}
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			{header.column.getCanResize() && (
				<DataGridColumnResizer header={header} table={table} label={label} />
			)}
		</>
	);
}

const DataGridColumnResizer = DataGridColumnResizerImpl;

interface DataGridColumnResizerProps<
	TData,
	TValue,
> extends DataGridColumnHeaderProps<TData, TValue> {
	label: string;
}

function DataGridColumnResizerImpl<TData, TValue>({
	header,
	table,
	label,
}: DataGridColumnResizerProps<TData, TValue>) {
	const defaultColumnDef = table._getDefaultColumnDef();

	const onDoubleClick = () => {
		header.column.resetSize();
	};

	return (
		<div
			// eslint-disable-next-line react-doctor/prefer-tag-over-role -- element is interactive (tabIndex + onDoubleClick/onMouseDown/onTouchStart drag handlers); the ARIA separator role is correct, a semantic tag would be non-interactive
			role="separator"
			aria-orientation="vertical"
			aria-label={`Resize ${label} column`}
			aria-valuenow={header.column.getSize()}
			aria-valuemin={defaultColumnDef.minSize}
			aria-valuemax={defaultColumnDef.maxSize}
			tabIndex={0}
			className={cn(
				"absolute -end-px top-0 z-overlay h-full w-0.5 cursor-ew-resize touch-none select-none bg-border transition-opacity after:absolute after:inset-y-0 after:start-1/2 after:h-full after:w-[18px] after:-translate-x-1/2 after:content-[''] hover:bg-primary focus:bg-primary focus:outline-none",
				header.column.getIsResizing()
					? "bg-primary"
					: "opacity-0 hover:opacity-100",
			)}
			onDoubleClick={onDoubleClick}
			onMouseDown={header.getResizeHandler()}
			onTouchStart={header.getResizeHandler()}
		/>
	);
}
