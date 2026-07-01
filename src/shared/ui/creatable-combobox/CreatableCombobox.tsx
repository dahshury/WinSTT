import { Combobox } from "@base-ui/react/combobox";
import {
	ArrowDown01Icon,
	Delete02Icon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState } from "react";
import { SurfaceProvider, surfaceClasses } from "@/shared/lib/surface";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import { IconButton } from "@/shared/ui/icon-button";
import { MenuHighlightLayer } from "@/shared/ui/menu-highlight";
import {
	CheckIcon,
	StopBubble,
	usePopupSurfaceLevels,
} from "@/shared/ui/select";

export interface CreatableComboboxItem {
	/** When true the row shows an inline delete button (wired to `onDelete`). */
	deletable?: boolean;
	id: string;
	label: string;
	meta?: string | undefined;
}
interface Row {
	deletable: boolean;
	id: string;
	isCreate: boolean;
	label: string;
	meta?: string | undefined;
}

interface CreatableComboboxProps {
	/** Wrapper width/placement classes (e.g. "ml-auto w-56"). */
	className?: string;
	/** Row label for the synthesized "create" affordance. */
	createLabel: (name: string) => string;
	deleteAriaLabel?: string;
	disabled?: boolean;
	emptyLabel: string;
	items: readonly CreatableComboboxItem[];
	/** Shown when the typed text doesn't match an existing item. Omit to make
	 *  the combobox select-only (no create row). */
	onCreate?: (name: string) => void;
	onDelete?: (id: string) => void;
	onSelect: (id: string) => void;
	placeholder: string;
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
	className,
	createLabel,
	deleteAriaLabel,
	disabled = false,
	emptyLabel,
	items,
	onCreate,
	onDelete,
	onSelect,
	placeholder,
	value,
}: CreatableComboboxProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");

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
			deletable: Boolean(i.deletable),
			isCreate: false,
		})),
		...(canCreate
			? [{ id: CREATE_ID, label: trimmed, deletable: false, isCreate: true }]
			: []),
	];
	const selectedRow: Row | null = selected
		? {
				id: selected.id,
				label: selected.label,
				meta: selected.meta,
				deletable: Boolean(selected.deletable),
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
						className={`h-8 w-full rounded-lg ${surfaceClasses(inputLevel)} ps-2.5 pe-7 font-inherit text-body text-foreground leading-normal outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1 ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
						placeholder={placeholder}
					/>
					<Combobox.Trigger
						aria-label={placeholder}
						className={`absolute end-1.5 flex size-5 shrink-0 items-center justify-center rounded-xs border-none bg-transparent p-0 text-foreground-dim ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"}`}
					>
						<HugeiconsIcon icon={ArrowDown01Icon} size={14} />
					</Combobox.Trigger>
				</div>

				<Combobox.Portal>
					<SurfaceProvider value={popupLevel}>
						<Combobox.Positioner
							className="z-popover outline-none"
							collisionPadding={8}
							sideOffset={4}
						>
							<Combobox.Popup
								className={`relative w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-lg ${surfaceClasses(popupLevel, popupShadow)} py-1 [max-height:min(14rem,var(--available-height))]`}
								ref={popupRef}
							>
								<MenuHighlightLayer
									containerRef={popupRef}
									value={selectedRow?.id ?? ""}
								/>
								<Combobox.Empty className="px-2.5 py-2 text-body-sm text-foreground-muted">
									{emptyLabel}
								</Combobox.Empty>
								<Combobox.List className="outline-none">
									{(row: Row) => (
										<Combobox.Item
											className="relative z-raised mx-1 flex cursor-pointer select-none items-center gap-1.5 rounded-xs py-[7px] ps-2.5 pe-1.5 text-body text-foreground leading-normal outline-none"
											data-menu-option={row.id}
											key={row.id}
											value={row}
										>
											<RowContent
												createLabel={createLabel}
												deleteAriaLabel={deleteAriaLabel}
												onDelete={onDelete}
												row={row}
											/>
										</Combobox.Item>
									)}
								</Combobox.List>
							</Combobox.Popup>
						</Combobox.Positioner>
					</SurfaceProvider>
				</Combobox.Portal>
			</Combobox.Root>
		</div>
	);
}

function RowContent({
	createLabel,
	deleteAriaLabel,
	onDelete,
	row,
}: {
	createLabel: (name: string) => string;
	deleteAriaLabel?: string | undefined;
	onDelete?: ((id: string) => void) | undefined;
	row: Row;
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
	return (
		<>
			<span className="flex w-3 shrink-0 items-center justify-center">
				<Combobox.ItemIndicator>
					<CheckIcon />
				</Combobox.ItemIndicator>
			</span>
			<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
				{row.label}
			</span>
			{row.meta ? (
				<span className="shrink-0 rounded-xs bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning leading-none">
					{row.meta}
				</span>
			) : null}
			{row.deletable && onDelete ? (
				<StopBubble className="ml-auto flex shrink-0 items-center">
					<IconButton
						aria-label={deleteAriaLabel ?? "Delete"}
						icon={<HugeiconsIcon icon={Delete02Icon} size={14} />}
						onClick={() => onDelete(row.id)}
					/>
				</StopBubble>
			) : null}
		</>
	);
}
