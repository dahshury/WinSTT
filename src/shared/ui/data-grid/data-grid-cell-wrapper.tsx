import * as React from "react";
import { useComposedRefs } from "@/shared/ui/data-grid/lib/compose-refs";
import { getCellKey } from "@/shared/ui/data-grid/lib/data-grid";
import { cn } from "@/shared/lib/cn";
import type { DataGridCellProps } from "@/shared/ui/data-grid/types";

interface DataGridCellWrapperProps<TData>
	extends DataGridCellProps<TData>, React.ComponentProps<"div"> {}

export function DataGridCellWrapper<TData>({
	tableMeta,
	rowIndex,
	columnId,
	state,
	rowHeight,
	className,
	onClick: onClickProp,
	onKeyDown: onKeyDownProp,
	ref,
	...props
}: DataGridCellWrapperProps<TData>) {
	const {
		isEditing,
		isFocused,
		isSelected,
		isSearchMatch,
		isActiveSearchMatch,
		readOnly,
	} = state;
	const cellMapRef = tableMeta?.cellMapRef;

	const onCellChange = (node: HTMLDivElement | null) => {
		if (!cellMapRef) return;

		const cellKey = getCellKey(rowIndex, columnId);

		if (node) {
			cellMapRef.current.set(cellKey, node);
		} else {
			cellMapRef.current.delete(cellKey);
		}
	};

	const composedRef = useComposedRefs(ref, onCellChange);

	const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
		if (!isEditing) {
			event.preventDefault();
			onClickProp?.(event);
			if (isFocused && !readOnly) {
				tableMeta?.onCellEditingStart?.(rowIndex, columnId);
			} else {
				tableMeta?.onCellClick?.(rowIndex, columnId, event);
			}
		}
	};

	const onContextMenu = (event: React.MouseEvent) => {
		if (!isEditing) {
			tableMeta?.onCellContextMenu?.(rowIndex, columnId, event);
		}
	};

	const onDoubleClick = (event: React.MouseEvent) => {
		if (!isEditing) {
			event.preventDefault();
			tableMeta?.onCellDoubleClick?.(rowIndex, columnId);
		}
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		onKeyDownProp?.(event);

		if (event.defaultPrevented) return;

		if (
			event.key === "ArrowUp" ||
			event.key === "ArrowDown" ||
			event.key === "ArrowLeft" ||
			event.key === "ArrowRight" ||
			event.key === "Home" ||
			event.key === "End" ||
			event.key === "PageUp" ||
			event.key === "PageDown" ||
			event.key === "Tab"
		) {
			return;
		}

		if (isFocused && !isEditing && !readOnly) {
			if (event.key === "F2" || event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				tableMeta?.onCellEditingStart?.(rowIndex, columnId);
				return;
			}

			if (event.key === " ") {
				event.preventDefault();
				event.stopPropagation();
				tableMeta?.onCellEditingStart?.(rowIndex, columnId);
				return;
			}

			if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
				event.preventDefault();
				event.stopPropagation();
				tableMeta?.onCellEditingStart?.(rowIndex, columnId);
			}
		}
	};

	const onMouseDown = (event: React.MouseEvent) => {
		if (!isEditing) {
			tableMeta?.onCellMouseDown?.(rowIndex, columnId, event);
		}
	};

	const onMouseEnter = () => {
		if (!isEditing) {
			tableMeta?.onCellMouseEnter?.(rowIndex, columnId);
		}
	};

	const onMouseUp = () => {
		if (!isEditing) {
			tableMeta?.onCellMouseUp?.();
		}
	};

	return (
		<div
			// eslint-disable-next-line react-doctor/prefer-tag-over-role -- virtualized div grid cell hosting contentEditable content; a real <button> cannot contain interactive/editable children and breaks CSS-grid sizing/virtualization
			role="button"
			data-slot="grid-cell-wrapper"
			data-editing={isEditing ? "" : undefined}
			data-focused={isFocused ? "" : undefined}
			data-selected={isSelected ? "" : undefined}
			tabIndex={isFocused && !isEditing ? 0 : -1}
			{...props}
			ref={composedRef}
			className={cn(
				"size-full px-2 py-1.5 text-start text-sm outline-none has-data-[slot=checkbox]:pt-2.5",
				{
					"ring-1 ring-inset ring-ring": isFocused,
					"bg-favorite/20": isSearchMatch && !isActiveSearchMatch,
					"bg-favorite/45": isActiveSearchMatch,
					"bg-primary/10": isSelected && !isEditing,
					"cursor-default": !isEditing,
					"**:data-[slot=grid-cell-content]:line-clamp-1":
						!isEditing && rowHeight === "short",
					"**:data-[slot=grid-cell-content]:line-clamp-2":
						!isEditing && rowHeight === "medium",
					"**:data-[slot=grid-cell-content]:line-clamp-3":
						!isEditing && rowHeight === "tall",
					"**:data-[slot=grid-cell-content]:line-clamp-4":
						!isEditing && rowHeight === "extra-tall",
				},
				className,
			)}
			onClick={onClick}
			onContextMenu={onContextMenu}
			onDoubleClick={onDoubleClick}
			onMouseDown={onMouseDown}
			onMouseEnter={onMouseEnter}
			onMouseUp={onMouseUp}
			onKeyDown={onKeyDown}
		/>
	);
}
