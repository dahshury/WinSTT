import { Menu } from "@base-ui/react/menu";
import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/shared/lib/cn";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { HTMLAttributes, ReactNode, Ref } from "react";
import { useRef, useState } from "react";
import { OptionDragHandle, SortableOptionRows } from "./sortable-option-rows";
import { SurfaceProvider, surfaceClasses } from "@/shared/lib/surface";
import { MenuHighlightLayer } from "@/shared/ui/menu-highlight";
import { GroupHeaderContent } from "./group-header";
import { OptionBadge } from "./option-badge";
import { StopBubble } from "./stop-bubble";
import { usePopupSurfaceLevels } from "./use-popup-surface-levels";

export interface SelectOption {
	/** Optional short badge text shown before the label (e.g. "US", "中") */
	badge?: string;
	/** When true the option is shown but can't be selected (e.g. a premium TTS
	 *  voice on a free plan). Row-trailing controls (preview) still work. */
	disabled?: boolean;
	/** Optional leading icon shown before the label */
	icon?: IconSvgElement;
	id: string;
	label: string;
	/** When true (and the Select has `onReorder`), the row can be drag-sorted
	 *  via a leading grip handle. Rows without it (e.g. a pinned "system
	 *  default" row) stay put. */
	sortable?: boolean;
	/** Optional compact content rendered at the far end of popup rows only. */
	trailing?: ReactNode;
}

/**
 * A labelled section of options rendered with a group header — the grouped-mode
 * counterpart of a flat `options` list. Shared by both pickers: `Select` renders
 * it with Base UI `Menu.Group`/`Menu.GroupLabel`, `SearchableSelect` with
 * `Combobox.Group`/`GroupLabel`. The wake-word picker passes one group per
 * engine, the cloud-STT picker one per provider, the TTS voice picker one per
 * country — the header's trailing badge carries the shared code so the per-row
 * badge can be dropped.
 *
 * Lives here (the more primitive layer) rather than in `SearchableSelect` so
 * `Select` can import it without a circular dependency; `SearchableSelect`
 * re-exports it for back-compat.
 */
export interface SelectOptionGroup {
	/** Optional short code shown as a badge at the header's trailing edge (e.g. "PVP"). */
	badge?: string;
	/** Optional leading icon node shown before the header label (e.g. a provider
	 *  brand mark). */
	icon?: ReactNode;
	/** Header text for the section (e.g. "Porcupine"). */
	label: string;
	options: readonly SelectOption[];
	/** Stable group identity. */
	value: string;
}

export interface SelectProps {
	"aria-label"?: string;
	/** Width / state classes for the trigger (e.g. `w-52`). The control is
	 *  self-contained (no wrapping `ElevatedSurface`), so pass width here. */
	className?: string | undefined;
	disabled?: boolean;
	/**
	 * Grouped options rendered with one `Menu.Group` header per section.
	 * Mutually exclusive with `options` (groups take precedence); the trigger's
	 * selected-value lookup still spans every group.
	 */
	groups?: readonly SelectOptionGroup[];
	onChange: (value: string) => void;
	onOpenChange?: (open: boolean) => void;
	/**
	 * Enables drag-to-sort on rows marked `sortable` (flat `options` mode
	 * only). Rows grow a leading grip handle; after a drop this is called
	 * with the sortable rows' ids in their new display order.
	 */
	onReorder?: (orderedIds: string[]) => void;
	/** Flat options. Ignored when `groups` is provided. */
	options?: readonly SelectOption[];
	/** Accessible label for the per-row drag handle (reorder mode). */
	reorderHandleLabel?: string;
	value: string;
}

// Leading badge + icon + label, shared by the trigger (current value) and the
// option rows. `active` marks the selected/highlighted state so the leading
// icon thickens (strokeWidth 2) — the fluidfunctionalism dropdown's active cue.
export function SelectOptionContent({
	active,
	option,
}: {
	active?: boolean;
	option: SelectOption;
}) {
	return (
		<>
			{option.badge ? <OptionBadge text={option.badge} /> : null}
			{option.icon && (
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-foreground-muted"
					icon={option.icon}
					size={16}
					strokeWidth={active ? 2 : 1.5}
				/>
			)}
			<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
				{option.label}
			</span>
		</>
	);
}

// One option row, shared by the flat and grouped popup bodies. Stamped with
// `data-menu-option` — the contract the animated `MenuHighlightLayer` measures
// against (it scans the radio-group subtree, so rows nested inside a
// `Menu.Group` are found exactly like flat ones). Group headers deliberately
// carry no such attribute, so they are never measured as selectable rows.
function SelectRow({
	className,
	handleLabel,
	option,
	reorderable,
	value,
	...sortableProps
}: {
	handleLabel?: string | undefined;
	option: SelectOption;
	reorderable?: boolean;
	value: string;
} & HTMLAttributes<HTMLDivElement> & {
		ref?: Ref<HTMLDivElement> | undefined;
	}) {
	const active = option.id === value;
	// In reorder mode the row is rendered inside `SortableItem asChild`, which
	// clones it with dnd-kit's ref/style/attribute props — `sortableProps`
	// forwards those onto the RadioItem so the row itself is the draggable.
	// The leading handle is ALWAYS visible on sortable rows (hover-reveal made
	// the list look unsortable); non-sortable rows in the same list (the pinned
	// "system default") get an equal-width spacer so labels stay aligned.
	return (
		<Menu.RadioItem
			{...sortableProps}
			className={cn(
				"relative z-raised mx-1 flex cursor-pointer select-none items-center gap-2 rounded-lg px-3 py-2.5 text-body text-foreground leading-normal outline-none data-[checked]:font-medium data-[checked]:text-foreground data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
				className,
			)}
			closeOnClick
			data-menu-option={option.id}
			disabled={option.disabled}
			value={option.id}
		>
			{reorderable ? (
				option.sortable ? (
					<OptionDragHandle className="-ml-1" label={handleLabel} />
				) : (
					<span aria-hidden="true" className="-ml-1 size-5 shrink-0" />
				)
			) : null}
			<SelectOptionContent active={active} option={option} />
			{active ? (
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-accent"
					icon={Tick02Icon}
					size={16}
				/>
			) : null}
			{option.trailing ? (
				<StopBubble className="shrink-0">{option.trailing}</StopBubble>
			) : null}
		</Menu.RadioItem>
	);
}

// Section header for grouped mode — mirrors the SearchableSelect `GroupHeader`
// so the two pickers read as one family. The trailing badge carries the
// group's short code (engine / provider) so the per-row badge can be dropped.
function SelectGroupHeader({
	badge,
	icon,
	label,
}: {
	badge?: string | undefined;
	icon?: ReactNode;
	label: string;
}) {
	return (
		<Menu.GroupLabel className="flex items-center gap-2 border-border/60 border-b px-2 py-1.5">
			<GroupHeaderContent badge={badge} icon={icon} label={label} />
		</Menu.GroupLabel>
	);
}

export function Select({
	options,
	groups,
	value,
	onChange,
	onOpenChange,
	onReorder,
	reorderHandleLabel,
	"aria-label": ariaLabel,
	className,
	disabled,
}: SelectProps) {
	// While a row is being drag-sorted, menu items go pointer-events-none so
	// Base UI can't interpret the drop's pointerup over a row as a selection
	// (which would switch the value AND close the popup mid-sort). dnd-kit
	// tracks the drag on window listeners, so it is unaffected.
	const [dragSorting, setDragSorting] = useState(false);
	// Grouped mode flattens for the trigger's selected-value lookup; the popup
	// still renders grouped.
	const flat = groups ? groups.flatMap((g) => [...g.options]) : (options ?? []);
	const selected = flat.find((o) => o.id === value);
	const selectedLabel = selected?.label ?? value;

	// Self-elevate +1 above the host panel so callers render a bare <Select/> with
	// no wrapping `ElevatedSurface`. Trigger then lifts +1 (its own bg+shadow; the
	// ring it used to borrow from the wrapper now lives on the trigger) and the
	// popup +2, re-providing substrate so option rows highlight against it.
	const { substrate, triggerLevel, popupLevel, popupShadow } =
		usePopupSurfaceLevels();

	// The radio group is the `position: relative` anchor the animated
	// selected/hover pills measure against (rows scroll inside `Menu.Popup`).
	const radioGroupRef = useRef<HTMLDivElement | null>(null);

	return (
		<SurfaceProvider value={substrate}>
			<Menu.Root onOpenChange={onOpenChange}>
				<Menu.Trigger
					aria-label={ariaLabel}
					className={cn(
						`flex h-8 w-full cursor-pointer select-none items-center justify-between gap-1.5 rounded-lg ${surfaceClasses(triggerLevel)} px-2.5 text-[13px] text-foreground leading-normal outline-none ring-1 ring-divider focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1 disabled:cursor-not-allowed disabled:opacity-60`,
						className,
					)}
					disabled={disabled}
				>
					<span className="flex min-w-0 flex-1 items-center gap-2">
						{selected ? (
							<SelectOptionContent active option={selected} />
						) : (
							<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
								{selectedLabel}
							</span>
						)}
					</span>
					<HugeiconsIcon
						className="shrink-0"
						icon={ArrowDown01Icon}
						size={14}
					/>
				</Menu.Trigger>
				<Menu.Portal>
					<SurfaceProvider value={popupLevel}>
						<Menu.Positioner
							className="z-popover outline-none"
							collisionPadding={8}
							sideOffset={4}
						>
							<Menu.Popup
								className={`select-popup min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-lg ${surfaceClasses(popupLevel, popupShadow)} py-1.5 [max-height:min(15rem,var(--available-height))] [max-width:var(--available-width)]`}
							>
								<Menu.RadioGroup
									className={cn(
										"relative",
										dragSorting && "[&_[data-menu-option]]:pointer-events-none",
									)}
									onValueChange={(v: string) => onChange(v)}
									ref={radioGroupRef}
									value={value}
								>
									<MenuHighlightLayer
										containerRef={radioGroupRef}
										value={value}
									/>
									{groups ? (
										groups.map((group) => (
											<Menu.Group className="flex flex-col" key={group.value}>
												<SelectGroupHeader
													badge={group.badge}
													icon={group.icon}
													label={group.label}
												/>
												{group.options.map((opt) => (
													<SelectRow key={opt.id} option={opt} value={value} />
												))}
											</Menu.Group>
										))
									) : onReorder ? (
										<SortableOptionRows
											onReorder={onReorder}
											onSortingChange={setDragSorting}
											options={flat}
											renderRow={(opt) => (
												<SelectRow
													handleLabel={reorderHandleLabel}
													option={opt}
													reorderable
													value={value}
												/>
											)}
										/>
									) : (
										flat.map((opt) => (
											<SelectRow key={opt.id} option={opt} value={value} />
										))
									)}
								</Menu.RadioGroup>
							</Menu.Popup>
						</Menu.Positioner>
					</SurfaceProvider>
				</Menu.Portal>
			</Menu.Root>
		</SurfaceProvider>
	);
}
