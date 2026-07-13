import { Combobox } from "@base-ui/react/combobox";
import {
	ArrowDown01Icon,
	ArrowTurnBackwardIcon,
	Delete02Icon,
	DragDropVerticalIcon,
	FloppyDiskIcon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type DragEvent, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceClasses } from "@/shared/lib/surface";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import {
	COMBOBOX_EMPTY_CLASS,
	ComboboxPopupShell,
	comboboxPopupClassName,
} from "@/shared/ui/combobox-base";
import { IconButton } from "@/shared/ui/icon-button";
import { MenuHighlightLayer } from "@/shared/ui/menu-highlight";
import {
	CheckIcon,
	StopBubble,
	usePopupSurfaceLevels,
} from "@/shared/ui/select";
import "@/shared/ui/searchable-select/searchable-select.css";

export interface CreatableComboboxItem {
	/** When true the row shows an inline delete button (wired to `onDelete`). */
	deletable?: boolean;
	/** Optional leading glyph shown before the label (after the reorder handle). */
	icon?: IconSvgElement | undefined;
	id: string;
	label: string;
	meta?: string | undefined;
	/** When true this row is "dirty" (live state diverged from what it stores)
	 *  and reveals the save/reset actions — wired to `onSave` / `onReset`. */
	modified?: boolean;
}
interface Row {
	deletable: boolean;
	icon?: IconSvgElement | undefined;
	id: string;
	isCreate: boolean;
	label: string;
	meta?: string | undefined;
	modified: boolean;
}
type DropPlacement = "before" | "after";

interface CreatableComboboxProps {
	/** Drop the input's own surface fill + elevation shadow (renders
	 *  `bg-transparent` instead). For joined control groups where a wrapping
	 *  container carries ONE shared surface plate for every segment — the
	 *  surface can't be stripped after the fact via `inputClassName` because
	 *  twMerge doesn't know the custom `shadow-surface-N` scale, so appending
	 *  `shadow-none` leaves the elevation shadow intact. */
	bareInput?: boolean;
	/** Wrapper width/placement classes (e.g. "ml-auto w-56"). */
	className?: string;
	/** Row label for the synthesized "create" affordance. */
	createLabel: (name: string) => string;
	deleteAriaLabel?: string;
	disabled?: boolean;
	emptyLabel: string;
	/** Drop the selected-row checkmark column to reclaim horizontal space. The
	 *  selection is still shown by the row's background highlight. */
	hideSelectedCheck?: boolean;
	/** Extra classes merged onto the text input. Use to strip the input's own
	 *  rounding/surface (e.g. `rounded-none bg-transparent shadow-none`) when the
	 *  combobox is the middle segment of a joined control group. */
	inputClassName?: string;
	items: readonly CreatableComboboxItem[];
	/** Render the drag-reorder handle before the label (leading) instead of in
	 *  the trailing action cluster. */
	leadingReorderHandle?: boolean;
	/** Shown when the typed text doesn't match an existing item. Omit to make
	 *  the combobox select-only (no create row). */
	onCreate?: (name: string) => void;
	onDelete?: (id: string) => void;
	onReorder?: (
		draggedId: string,
		targetId: string,
		placement: DropPlacement,
	) => void;
	/** Revert a `modified` row's live state back to what it stores. */
	onReset?: (id: string) => void;
	/** Overwrite a `modified` row's stored state with the current live state. */
	onSave?: (id: string) => void;
	onSelect: (id: string) => void;
	placeholder: string;
	reorderAriaLabel?: (item: CreatableComboboxItem) => string;
	resetAriaLabel?: string;
	saveAriaLabel?: string;
	/** The selected item's id ("" = none). Drives the checkmark and the closed
	 *  display value. */
	value: string;
}

const CREATE_ID = "__create__";

/**
 * Single-select creatable combobox (Base UI). Type to filter; when the text
 * doesn't match an existing item a "Create …" row appears (calls `onCreate`).
 * Selecting an item calls `onSelect`; deletable rows carry an inline delete
 * button. The selected row shows a check and its label fills the field when
 * closed.
 *
 * Robustness notes (the creatable pattern is finicky on Base UI):
 *  - `filter={null}` + controlled `inputValue` so we own filtering AND can
 *    synthesize the create row from the live query.
 *  - The query is cleared on CLOSE (never on open). Clearing on open races the
 *    first keystroke that auto-opens the popup and silently eats it — which is
 *    exactly what made "type a name and create" feel broken.
 *  - Controlled `value` with id-based `isItemEqualToValue` (the SearchableSelect
 *    pattern) so a fresh value object per render never triggers a re-select loop.
 */
export function CreatableCombobox({
	bareInput = false,
	className,
	createLabel,
	deleteAriaLabel,
	disabled = false,
	emptyLabel,
	hideSelectedCheck = false,
	inputClassName,
	items,
	leadingReorderHandle = false,
	onCreate,
	onDelete,
	onReorder,
	onReset,
	onSave,
	onSelect,
	placeholder,
	reorderAriaLabel,
	resetAriaLabel,
	saveAriaLabel,
	value,
}: CreatableComboboxProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [draggedId, setDraggedId] = useState<string | null>(null);
	const [dropTarget, setDropTarget] = useState<{
		id: string;
		placement: DropPlacement;
	} | null>(null);

	const selected = items.find((i) => i.id === value) ?? null;
	const trimmed = query.trim();
	const needle = trimmed.toLowerCase();
	const filtered = items.filter((i) =>
		matchesFuzzySearch([i.label, i.id, i.meta ?? ""], needle),
	);
	const exactExists = items.some(
		(i) => i.label.trim().toLowerCase() === needle,
	);
	const canCreate = Boolean(onCreate) && trimmed.length > 0 && !exactExists;
	const rows: Row[] = [
		...filtered.map((i) => ({
			id: i.id,
			label: i.label,
			meta: i.meta,
			icon: i.icon,
			deletable: Boolean(i.deletable),
			modified: Boolean(i.modified),
			isCreate: false,
		})),
		...(canCreate
			? [
					{
						id: CREATE_ID,
						label: trimmed,
						deletable: false,
						modified: false,
						isCreate: true,
					},
				]
			: []),
	];
	const selectedRow: Row | null = selected
		? {
				id: selected.id,
				label: selected.label,
				meta: selected.meta,
				icon: selected.icon,
				deletable: Boolean(selected.deletable),
				modified: Boolean(selected.modified),
				isCreate: false,
			}
		: null;

	const handleValue = (row: Row | null) => {
		if (!row) {
			return;
		}
		if (row.isCreate) {
			onCreate?.(row.label);
		} else {
			onSelect(row.id);
		}
		setOpen(false);
		setQuery("");
	};
	const clearDragState = () => {
		setDraggedId(null);
		setDropTarget(null);
	};
	const handleDragStart = (event: DragEvent<HTMLElement>, row: Row) => {
		if (!onReorder || row.isCreate) {
			event.preventDefault();
			return;
		}
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/plain", row.id);
		setDraggedId(row.id);
	};
	const handleDragOver = (event: DragEvent<HTMLElement>, row: Row) => {
		if (!onReorder || row.isCreate || !draggedId || draggedId === row.id) {
			return;
		}
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		const bounds = event.currentTarget.getBoundingClientRect();
		const placement =
			event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
		setDropTarget({ id: row.id, placement });
	};
	const handleDrop = (event: DragEvent<HTMLElement>, row: Row) => {
		if (!onReorder || row.isCreate || !draggedId || draggedId === row.id) {
			clearDragState();
			return;
		}
		event.preventDefault();
		const placement =
			dropTarget?.id === row.id ? dropTarget.placement : "after";
		onReorder(draggedId, row.id, placement);
		clearDragState();
	};

	const {
		triggerLevel: inputLevel,
		popupLevel,
		popupShadow,
	} = usePopupSurfaceLevels({ selfElevate: false });
	const popupRef = useRef<HTMLDivElement | null>(null);

	return (
		<div className={className ?? "w-full"}>
			<Combobox.Root
				autoHighlight
				disabled={disabled}
				filter={null}
				inputValue={open ? query : (selectedRow?.label ?? "")}
				isItemEqualToValue={(a: Row | null, b: Row | null) => a?.id === b?.id}
				items={rows}
				itemToStringLabel={(row: Row) => row.label}
				onInputValueChange={setQuery}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) {
						setQuery("");
					}
				}}
				onValueChange={handleValue}
				open={open}
				value={selectedRow}
			>
				<div className="relative flex w-full items-center">
					<Combobox.Input
						className={cn(
							"h-8 w-full rounded-lg ps-2.5 pe-7 font-inherit text-body text-foreground leading-normal outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
							bareInput ? "bg-transparent" : surfaceClasses(inputLevel),
							disabled && "cursor-not-allowed opacity-40",
							inputClassName,
						)}
						placeholder={placeholder}
					/>
					<Combobox.Trigger
						aria-label={placeholder}
						className={`absolute end-1.5 flex size-5 shrink-0 items-center justify-center rounded-xs border-none bg-transparent p-0 text-foreground-dim ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"}`}
					>
						<HugeiconsIcon icon={ArrowDown01Icon} size={14} />
					</Combobox.Trigger>
				</div>

				<ComboboxPopupShell popupLevel={popupLevel}>
					<Combobox.Popup
						className={comboboxPopupClassName(
							popupLevel,
							popupShadow,
							"searchable-select-popup relative overflow-y-auto py-1 [max-height:min(14rem,var(--available-height))]",
						)}
						ref={popupRef}
					>
						<MenuHighlightLayer
							containerRef={popupRef}
							value={selectedRow?.id ?? ""}
						/>
						<Combobox.Empty className={COMBOBOX_EMPTY_CLASS}>
							{emptyLabel}
						</Combobox.Empty>
						<Combobox.List className="outline-none">
							{(row: Row) => (
								<Combobox.Item
									className={`relative z-raised mx-1 flex cursor-pointer select-none items-center gap-1.5 rounded-xs border-y py-[6px] ps-2.5 pe-1.5 text-body text-foreground leading-normal outline-none ${
										dropTarget?.id === row.id
											? dropTarget.placement === "before"
												? "border-t-accent border-b-transparent"
												: "border-t-transparent border-b-accent"
											: "border-transparent"
									} ${draggedId === row.id ? "opacity-50" : ""}`}
									data-menu-option={row.id}
									key={row.id}
									onDragLeave={(event) => {
										const nextTarget = event.relatedTarget as Node | null;
										if (event.currentTarget.contains(nextTarget)) {
											return;
										}
										if (dropTarget?.id === row.id) {
											setDropTarget(null);
										}
									}}
									onDragOver={(event) => handleDragOver(event, row)}
									onDrop={(event) => handleDrop(event, row)}
									value={row}
								>
									<RowContent
										createLabel={createLabel}
										deleteAriaLabel={deleteAriaLabel}
										hideSelectedCheck={hideSelectedCheck}
										leadingReorderHandle={leadingReorderHandle}
										onDelete={onDelete}
										onDragEnd={clearDragState}
										onDragStart={(event) => handleDragStart(event, row)}
										onReset={onReset}
										onSave={onSave}
										reorderAriaLabel={reorderAriaLabel}
										reorderable={Boolean(onReorder)}
										resetAriaLabel={resetAriaLabel}
										row={row}
										saveAriaLabel={saveAriaLabel}
									/>
								</Combobox.Item>
							)}
						</Combobox.List>
					</Combobox.Popup>
				</ComboboxPopupShell>
			</Combobox.Root>
		</div>
	);
}

function RowContent({
	createLabel,
	deleteAriaLabel,
	hideSelectedCheck,
	leadingReorderHandle,
	onDelete,
	onDragEnd,
	onDragStart,
	onReset,
	onSave,
	reorderAriaLabel,
	reorderable,
	resetAriaLabel,
	row,
	saveAriaLabel,
}: {
	createLabel: (name: string) => string;
	deleteAriaLabel?: string | undefined;
	hideSelectedCheck: boolean;
	leadingReorderHandle: boolean;
	onDelete?: ((id: string) => void) | undefined;
	onDragEnd: () => void;
	onDragStart: (event: DragEvent<HTMLElement>) => void;
	onReset?: ((id: string) => void) | undefined;
	onSave?: ((id: string) => void) | undefined;
	reorderAriaLabel?: ((item: CreatableComboboxItem) => string) | undefined;
	reorderable: boolean;
	resetAriaLabel?: string | undefined;
	row: Row;
	saveAriaLabel?: string | undefined;
}) {
	if (row.isCreate) {
		return (
			<>
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-accent"
					icon={PlusSignIcon}
					size={14}
				/>
				<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
					{createLabel(row.label)}
				</span>
			</>
		);
	}
	// One handle element, placed either leading (before the label) or in the
	// trailing action cluster. It carries a native HTML5 drag; the surrounding
	// StopBubble stops the pointer/click from selecting the row (drag still fires).
	const reorderHandle = reorderable ? (
		<button
			aria-label={reorderAriaLabel?.(row) ?? `Drag ${row.label} to reorder`}
			className="inline-flex size-7 shrink-0 cursor-grab items-center justify-center rounded-full bg-transparent p-0 text-foreground-muted hover:text-foreground-secondary active:cursor-grabbing"
			draggable
			onClick={(event) => event.preventDefault()}
			onDragEnd={onDragEnd}
			onDragStart={onDragStart}
			type="button"
		>
			<HugeiconsIcon icon={DragDropVerticalIcon} size={14} />
		</button>
	) : null;
	const showSave = Boolean(row.modified && onSave);
	const showReset = Boolean(row.modified && onReset);
	const trailingReorder = reorderable && !leadingReorderHandle;
	const hasTrailing =
		showSave ||
		showReset ||
		trailingReorder ||
		Boolean(row.deletable && onDelete);
	return (
		<>
			{leadingReorderHandle && reorderHandle ? (
				<StopBubble className="flex shrink-0 items-center">
					{reorderHandle}
				</StopBubble>
			) : hideSelectedCheck ? null : (
				<span className="flex w-3 shrink-0 items-center justify-center">
					<Combobox.ItemIndicator>
						<CheckIcon />
					</Combobox.ItemIndicator>
				</span>
			)}
			{row.icon ? (
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-foreground-secondary"
					icon={row.icon}
					size={15}
					strokeWidth={1.8}
				/>
			) : null}
			<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
				{row.label}
			</span>
			{row.meta ? (
				<span className="shrink-0 rounded-xs bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning leading-none">
					{row.meta}
				</span>
			) : null}
			{hasTrailing ? (
				<StopBubble className="ml-auto flex shrink-0 items-center gap-0.5">
					{showSave && onSave ? (
						<IconButton
							aria-label={saveAriaLabel ?? "Save changes"}
							icon={<HugeiconsIcon icon={FloppyDiskIcon} size={14} />}
							onClick={() => onSave(row.id)}
						/>
					) : null}
					{showReset && onReset ? (
						<IconButton
							aria-label={resetAriaLabel ?? "Reset changes"}
							icon={<HugeiconsIcon icon={ArrowTurnBackwardIcon} size={14} />}
							onClick={() => onReset(row.id)}
						/>
					) : null}
					{trailingReorder ? reorderHandle : null}
					{row.deletable && onDelete ? (
						<IconButton
							aria-label={deleteAriaLabel ?? "Delete"}
							icon={<HugeiconsIcon icon={Delete02Icon} size={14} />}
							onClick={() => onDelete(row.id)}
						/>
					) : null}
				</StopBubble>
			) : null}
		</>
	);
}
