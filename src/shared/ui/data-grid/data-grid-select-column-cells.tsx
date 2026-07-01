import type { CellContext, HeaderContext } from "@tanstack/react-table";
import * as React from "react";
import { Checkbox } from "@/shared/ui/data-grid/primitives/checkbox";
import { cn } from "@/shared/lib/cn";

export type HitboxSize = "default" | "sm" | "lg";

interface DataGridSelectHitboxProps {
	htmlFor: string;
	children: React.ReactNode;
	size?: HitboxSize | undefined;
	debug?: boolean | undefined;
}

function DataGridSelectHitbox({
	htmlFor,
	children,
	size,
	debug,
}: DataGridSelectHitboxProps) {
	return (
		<div
			className={cn(
				"group relative -my-1.5 h-[calc(100%+0.75rem)] py-1.5",
				size === "default" && "-ms-3 -me-2 ps-3 pe-2",
				size === "sm" && "-ms-3 -me-1.5 ps-3 pe-1.5",
				size === "lg" && "-mx-3 px-3",
			)}
		>
			{children}
			{/* biome-ignore lint/a11y/noLabelWithoutControl: label is associated to the checkbox via htmlFor; this is an empty overlay click-target whose visible label lives in children */}
			{/* eslint-disable-next-line react-doctor/label-has-associated-control -- label is programmatically tied to the checkbox via htmlFor (id); it is an empty overlay click-target, the visible/accessible label is on the Checkbox itself */}
			<label
				htmlFor={htmlFor}
				className={cn(
					"absolute inset-0 cursor-pointer",
					debug && "border border-destructive border-dashed bg-destructive/20",
				)}
			/>
		</div>
	);
}

interface DataGridSelectCheckboxProps extends Omit<
	React.ComponentProps<typeof Checkbox>,
	"id"
> {
	rowNumber?: number | undefined;
	hitboxSize?: HitboxSize | undefined;
	debug?: boolean | undefined;
}

function DataGridSelectCheckbox({
	rowNumber,
	hitboxSize,
	debug,
	checked,
	className,
	...props
}: DataGridSelectCheckboxProps) {
	const id = React.useId();

	if (rowNumber !== undefined) {
		return (
			<DataGridSelectHitbox htmlFor={id} size={hitboxSize} debug={debug}>
				<div
					aria-hidden="true"
					className={cn(
						"pointer-events-none absolute start-3 top-1.5 flex size-4 items-center justify-center text-muted-foreground text-xs tabular-nums transition-opacity group-hover:opacity-0",
						checked && "opacity-0",
					)}
				>
					{rowNumber}
				</div>
				<Checkbox
					id={id}
					className={cn(
						"relative transition-[shadow,border,opacity] hover:border-primary/40",
						"opacity-0 group-hover:opacity-100 data-[state=checked]:opacity-100",
						className,
					)}
					checked={checked}
					{...props}
				/>
			</DataGridSelectHitbox>
		);
	}

	return (
		<DataGridSelectHitbox htmlFor={id} size={hitboxSize} debug={debug}>
			<Checkbox
				id={id}
				className={cn(
					"relative transition-[shadow,border] hover:border-primary/40",
					className,
				)}
				checked={checked}
				{...props}
			/>
		</DataGridSelectHitbox>
	);
}

interface DataGridSelectHeaderProps<TData> extends Pick<
	HeaderContext<TData, unknown>,
	"table"
> {
	hitboxSize?: HitboxSize;
	readOnly?: boolean;
	debug?: boolean;
}

export function DataGridSelectHeader<TData>({
	table,
	hitboxSize,
	readOnly,
	debug,
}: DataGridSelectHeaderProps<TData>) {
	const onCheckedChange = (value: boolean) =>
		table.toggleAllPageRowsSelected(value);

	if (readOnly) {
		return (
			<div className="mt-1 flex items-center ps-1 text-muted-foreground text-sm">
				#
			</div>
		);
	}

	return (
		<DataGridSelectCheckbox
			aria-label="Select all"
			checked={
				table.getIsAllPageRowsSelected() ||
				(table.getIsSomePageRowsSelected() && "indeterminate")
			}
			onCheckedChange={onCheckedChange}
			hitboxSize={hitboxSize}
			debug={debug}
		/>
	);
}

interface DataGridSelectCellProps<TData> extends Pick<
	CellContext<TData, unknown>,
	"row" | "table"
> {
	hitboxSize?: HitboxSize;
	enableRowMarkers?: boolean;
	readOnly?: boolean;
	debug?: boolean;
}

export function DataGridSelectCell<TData>({
	row,
	table,
	hitboxSize,
	enableRowMarkers,
	readOnly,
	debug,
}: DataGridSelectCellProps<TData>) {
	const meta = table.options.meta;
	const rowNumber = enableRowMarkers
		? (meta?.getVisualRowIndex?.(row.id) ?? row.index + 1)
		: undefined;

	const onCheckedChange = (value: boolean) => {
		if (meta?.onRowSelect) {
			meta.onRowSelect(row.id, value, false);
		} else {
			row.toggleSelected(value);
		}
	};

	const onClick = (event: React.MouseEvent<HTMLButtonElement>) => {
		if (event.shiftKey) {
			event.preventDefault();
			meta?.onRowSelect?.(row.id, !row.getIsSelected(), true);
		}
	};

	if (readOnly) {
		return (
			<div className="flex items-center ps-1 text-muted-foreground text-xs tabular-nums">
				{rowNumber ?? row.index + 1}
			</div>
		);
	}

	return (
		<DataGridSelectCheckbox
			aria-label={rowNumber ? `Select row ${rowNumber}` : "Select row"}
			checked={row.getIsSelected()}
			onCheckedChange={onCheckedChange}
			onClick={onClick}
			rowNumber={rowNumber}
			hitboxSize={hitboxSize}
			debug={debug}
		/>
	);
}
