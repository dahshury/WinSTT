import { DragDropVerticalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, type ReactElement } from "react";
import { cn } from "@/shared/lib/cn";
import {
	surfaceDraggingBg,
	surfaceDraggingShadow,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
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
	// A grabbed row leaves the list and becomes a card, so it needs its own
	// plate (rows are transparent — without one the rows it flies over would
	// read straight through it) plus a shadow a level further up to sell the
	// height. Only this layer knows the popup's substrate, hence not in the
	// `SortableItem` primitive.
	const substrate = useSurface();
	const liftClasses = cn(
		surfaceDraggingBg(substrate + 2),
		surfaceDraggingShadow(substrate + 3),
	);
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
						<SortableItem
							asChild
							className={liftClasses}
							key={opt.id}
							value={opt.id}
						>
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

/** Footprint of the grip — non-sortable rows in the same list reserve exactly
 *  this much so every label stays on one vertical line. */
export const OPTION_DRAG_HANDLE_SIZE = "size-6";

/**
 * Leading (left-side) grip that activates dnd-kit sorting. Always visible so
 * the sortability of the list is discoverable — muted at rest, and it fills in
 * to a real button (plate + full-color icon) on hover, focus and while held, so
 * the target announces itself before you press it. Wrapped in a bubble-phase
 * event fence: dnd-kit's own listeners live on the handle button (target, fires
 * first), then the fence stops propagation so a popup menu's item handlers
 * never see the press — otherwise grabbing the handle would select the row and
 * close the popup.
 */
export function OptionDragHandle({
	className,
	label,
}: {
	className?: string;
	label?: string | undefined;
}) {
	const substrate = useSurface();
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
				className={cn(
					`flex ${OPTION_DRAG_HANDLE_SIZE} items-center justify-center rounded-md text-foreground-dim`,
					"transition-[color,background-color] duration-160 ease-[var(--drag-ease)]",
					// The focus ring is load-bearing: keyboard reorder is "focus the
					// grip → Space → arrows", so the ring is the only thing marking
					// which row is about to move.
					"hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent data-dragging:text-foreground",
					// A step above the hover pill behind the row, so the grip still
					// reads as a raised chip on a hovered or lifted row.
					surfaceHoverBg(substrate + 3),
				)}
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
