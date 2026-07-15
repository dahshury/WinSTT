import { DragDropVerticalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, type ReactElement } from "react";
import { cn } from "@/shared/lib/cn";
import {
	Sortable,
	SortableContent,
	SortableItem,
	SortableItemHandle,
} from "@/shared/ui/data-grid/primitives/sortable";

/** Minimal option shape the sortable machinery needs. */
export interface SortableOptionLike {
	id: string;
	/** Rows with `sortable` get wrapped in a `SortableItem` and should render
	 *  an `OptionDragHandle`; other rows (e.g. a pinned "system default") stay
	 *  put. */
	sortable?: boolean;
}

export interface SortableOptionRowsProps<T extends SortableOptionLike> {
	/** Called after a drop with the sortable rows' ids in new display order. */
	onReorder: (orderedIds: string[]) => void;
	/** Drag-in-progress signal — popup menus use it to fence row pointer
	 *  events so the drop's pointerup can't select-and-close. */
	onSortingChange?: (sorting: boolean) => void;
	options: readonly T[];
	/** Renders one row. Sortable rows are wrapped in `SortableItem asChild`,
	 *  so the returned element must accept a forwarded ref/style (any DOM
	 *  element or Base UI component does). */
	renderRow: (option: T) => ReactElement;
}

/**
 * Shared drag-sortable option-list body for the mic pickers (settings
 * `Select` and footer `FooterMenuChip`). Rows
 * marked `sortable` become draggables; the row element itself carries the
 * sortable transform (`asChild`) so popup geometry (e.g. `data-menu-option`
 * highlight measurement) stays flat.
 */
export function SortableOptionRows<T extends SortableOptionLike>({
	onReorder,
	onSortingChange,
	options,
	renderRow,
}: SortableOptionRowsProps<T>) {
	// Typed against the supertype: TS can't resolve Sortable's conditional
	// `GetItemValue<T>` for an unbound generic, and the dnd wiring only needs
	// `id`.
	const sortableRows: SortableOptionLike[] = options.filter((o) => o.sortable);
	return (
		<Sortable
			getItemValue={(o: SortableOptionLike) => o.id}
			onDragCancel={() => onSortingChange?.(false)}
			onDragEnd={() => onSortingChange?.(false)}
			onDragStart={() => onSortingChange?.(true)}
			onValueChange={(items) => onReorder(items.map((o) => o.id))}
			value={sortableRows}
		>
			<SortableContent withoutSlot>
				{options.map((opt) =>
					opt.sortable ? (
						<SortableItem asChild key={opt.id} value={opt.id}>
							{renderRow(opt)}
						</SortableItem>
					) : (
						<Fragment key={opt.id}>{renderRow(opt)}</Fragment>
					),
				)}
			</SortableContent>
		</Sortable>
	);
}

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * Leading (left-side) grip that activates dnd-kit sorting. Always visible so
 * the sortability of the list is discoverable — muted at rest, full color on
 * hover/drag. Wrapped in a bubble-phase event fence: dnd-kit's own listeners
 * live on the handle button (target, fires first), then the fence stops
 * propagation so a popup menu's item handlers never see the press —
 * otherwise grabbing the handle would select the row and close the popup.
 */
export function OptionDragHandle({
	className,
	label,
}: {
	className?: string;
	label?: string | undefined;
}) {
	return (
		// react-doctor-disable-next-line react-doctor/no-static-element-interactions -- not an interactive control: this span is a bubble-phase propagation fence, and the real interactive element (the SortableItemHandle button below) carries the aria-label/keyboard semantics. A role here would misrepresent it to assistive tech.
		<span
			className={cn("shrink-0", className)}
			onClick={stop}
			onKeyDown={stop}
			onMouseDown={stop}
			onMouseUp={stop}
			onPointerDown={stop}
			onPointerUp={stop}
		>
			<SortableItemHandle
				aria-label={label}
				className="flex size-5 items-center justify-center rounded text-foreground-dim transition-colors hover:text-foreground data-dragging:text-foreground"
			>
				<HugeiconsIcon
					aria-hidden="true"
					icon={DragDropVerticalIcon}
					size={14}
				/>
			</SortableItemHandle>
		</span>
	);
}
