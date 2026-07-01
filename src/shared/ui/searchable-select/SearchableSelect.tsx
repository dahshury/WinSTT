import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import {
	SurfaceProvider,
	surfaceBg,
	surfaceClasses,
} from "@/shared/lib/surface";
import { cn } from "@/shared/lib/cn";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import { MenuHighlightLayer } from "@/shared/ui/menu-highlight";
import {
	CheckIcon,
	GroupHeaderContent,
	OptionBadge,
	type SelectOption,
	type SelectOptionGroup,
	StopBubble,
	usePopupSurfaceLevels,
} from "@/shared/ui/select";
import "./searchable-select.css";

// `SelectOptionGroup` now lives alongside `SelectOption` in `select/Select.tsx`
// (the more primitive layer, so the Menu-based `Select` can use it too without
// a circular import). Re-exported here so existing imports from
// `@/shared/ui/searchable-select` keep working.
export type { SelectOptionGroup } from "@/shared/ui/select";

export interface SearchableSelectProps {
	/** Width / state classes for the trigger (e.g. `w-52`). The control is
	 *  self-contained (no wrapping `ElevatedSurface`), so pass width here. */
	className?: string | undefined;
	/**
	 * Open the popup on mount (uncontrolled initial state). Used by the detached
	 * model-picker window, whose whole purpose is to show the options — there a
	 * closed combobox would force a pointless second click. Settings-panel usage
	 * omits this so the combobox stays closed until the user opens it.
	 */
	defaultOpen?: boolean;
	disabled?: boolean;
	/**
	 * Grouped options. When provided, the popup renders one sticky
	 * `Combobox.GroupLabel` header per group (the per-row badge is dropped —
	 * the header carries the shared attribute) and `options` is ignored for
	 * the list. The trigger's selected-value lookup still spans every group.
	 */
	groups?: readonly SelectOptionGroup[];
	/**
	 * Interactive node pinned inside the trigger, just left of the chevron —
	 * stays visible whether the popup is open or closed. Pointer/click events
	 * are stopped from bubbling so it can't toggle the popup. Used by the TTS
	 * voice picker for the "preview selected voice" play/stop control.
	 */
	inputTrailing?: ReactNode;
	onChange: (value: string) => void;
	onOpenChange?: (open: boolean) => void;
	/** Flat options. Mutually exclusive with `groups` (which takes precedence). */
	options?: readonly SelectOption[];
	placeholder?: string;
	/**
	 * Per-row trailing node rendered at the end of each option in the popup.
	 * Pointer/click events are stopped so pressing it previews that row
	 * without selecting (or closing) the combobox.
	 */
	renderItemTrailing?: (option: SelectOption) => ReactNode;
	value: string;
}

const EMPTY_OPTIONS: readonly SelectOption[] = [];

const groupedFlatOptionsCache = new WeakMap<
	readonly SelectOptionGroup[],
	readonly SelectOption[]
>();
const groupedComboboxItemsCache = new WeakMap<
	readonly SelectOptionGroup[],
	readonly { items: SelectOption[]; value: string }[]
>();
const groupMetaCache = new WeakMap<
	readonly SelectOptionGroup[],
	Map<string, SelectOptionGroup>
>();
const flatComboboxItemsCache = new WeakMap<
	readonly SelectOption[],
	readonly SelectOption[]
>();
const optionByIdCache = new WeakMap<
	readonly SelectOption[],
	Map<string, SelectOption>
>();

function flattenedGroupOptions(
	groups: readonly SelectOptionGroup[],
): readonly SelectOption[] {
	const cached = groupedFlatOptionsCache.get(groups);
	if (cached) {
		return cached;
	}
	const flat = groups.flatMap((g) => [...g.options]);
	groupedFlatOptionsCache.set(groups, flat);
	return flat;
}

function groupedComboboxItems(
	groups: readonly SelectOptionGroup[],
): readonly { items: SelectOption[]; value: string }[] {
	const cached = groupedComboboxItemsCache.get(groups);
	if (cached) {
		return cached;
	}
	const items = groups.map((g) => ({ value: g.value, items: [...g.options] }));
	groupedComboboxItemsCache.set(groups, items);
	return items;
}

function groupMetaByValue(
	groups: readonly SelectOptionGroup[],
): Map<string, SelectOptionGroup> {
	const cached = groupMetaCache.get(groups);
	if (cached) {
		return cached;
	}
	const meta = new Map(groups.map((g) => [g.value, g]));
	groupMetaCache.set(groups, meta);
	return meta;
}

function flatComboboxItems(
	options: readonly SelectOption[],
): readonly SelectOption[] {
	const cached = flatComboboxItemsCache.get(options);
	if (cached) {
		return cached;
	}
	const items = [...options];
	flatComboboxItemsCache.set(options, items);
	return items;
}

function optionById(
	options: readonly SelectOption[],
): Map<string, SelectOption> {
	const cached = optionByIdCache.get(options);
	if (cached) {
		return cached;
	}
	const byId = new Map(options.map((option) => [option.id, option]));
	optionByIdCache.set(options, byId);
	return byId;
}

function getItemLabel(item: SelectOption | null): string {
	return item ? item.label : "";
}

function optionMatchesQuery(item: SelectOption, query: string): boolean {
	return matchesFuzzySearch([item.label, item.id, item.badge ?? ""], query);
}

function OptionIcon({
	active,
	icon,
}: {
	active?: boolean;
	icon: NonNullable<SelectOption["icon"]>;
}) {
	return (
		<HugeiconsIcon
			aria-hidden="true"
			className="pointer-events-none shrink-0 text-foreground-muted"
			icon={icon}
			size={16}
			strokeWidth={active ? 2 : 1.5}
		/>
	);
}

function ItemTrailing({
	item,
	render,
}: {
	item: SelectOption;
	render: (option: SelectOption) => ReactNode;
}) {
	return (
		<StopBubble className="ml-auto flex shrink-0 items-center">
			{render(item)}
		</StopBubble>
	);
}

// Sticky section header for grouped mode — mirrors the STT model list's
// `AuthorLabel`. The trailing badge carries the group's short code (e.g.
// the country) so the per-row badge can be dropped.
function GroupHeader({
	badge,
	icon,
	label,
	level,
}: {
	badge?: string | undefined;
	icon?: ReactNode;
	label: string;
	level: number;
}) {
	return (
		<Combobox.GroupLabel
			// `z-overlay` (not `z-raised`): each `Row` is `relative z-raised`, so an
			// equal-z sticky header would be painted OVER by the rows scrolling under
			// it (later DOM, same z) — making the opaque header look transparent. A
			// higher z keeps the sticky header above its rows.
			className={`sticky top-0 z-overlay flex items-center gap-2 border-border/60 border-b px-2.5 py-1.5 ${surfaceBg(level)}`}
		>
			<GroupHeaderContent badge={badge} icon={icon} label={label} />
		</Combobox.GroupLabel>
	);
}

// One option row, shared by the flat and grouped list bodies. In grouped
// mode the per-row badge is suppressed (the `GroupHeader` carries it) and
// the row is indented a touch so it reads as nested under its header.
function Row({
	grouped,
	item,
	renderItemTrailing,
	value,
}: {
	grouped?: boolean | undefined;
	item: SelectOption;
	renderItemTrailing?: ((option: SelectOption) => ReactNode) | undefined;
	value: string;
}) {
	return (
		<Combobox.Item
			className={`searchable-select-item relative z-raised mx-1 flex cursor-pointer select-none items-center gap-2 rounded-xs py-2 pe-2 text-body text-foreground leading-normal outline-none data-[disabled]:cursor-not-allowed ${grouped ? "ps-4" : "ps-2"} data-[selected]:font-medium data-[selected]:text-foreground`}
			data-menu-option={item.id}
			disabled={item.disabled}
			value={item}
		>
			<span className="flex w-3 shrink-0 items-center justify-center">
				<Combobox.ItemIndicator>
					<CheckIcon />
				</Combobox.ItemIndicator>
			</span>
			{!grouped && item.badge ? <OptionBadge text={item.badge} /> : null}
			{item.icon ? (
				<OptionIcon active={item.id === value} icon={item.icon} />
			) : null}
			<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
				{item.label}
			</span>
			{renderItemTrailing ? (
				<ItemTrailing item={item} render={renderItemTrailing} />
			) : null}
		</Combobox.Item>
	);
}

export function SearchableSelect({
	options,
	groups,
	value,
	onChange,
	onOpenChange,
	placeholder = "Search…",
	className,
	disabled = false,
	defaultOpen = false,
	inputTrailing,
	renderItemTrailing,
}: SearchableSelectProps) {
	const t = useTranslations("common");
	// Grouped mode flattens to a single list for the selected-value lookup +
	// the Combobox value contract; the popup still renders grouped.
	const flatOptions = groups
		? flattenedGroupOptions(groups)
		: (options ?? EMPTY_OPTIONS);
	const selected = optionById(flatOptions).get(value) ?? null;
	// Base UI accepts either a flat item array or its grouped collection shape
	// (`{ value, items }[]`, auto-detected via the nested `items` key); the
	// leaf type is the same SelectOption either way. Group header label/badge
	// aren't part of that shape, so look them up by `value` at render time.
	const comboboxItems: readonly unknown[] = groups
		? groupedComboboxItems(groups)
		: flatComboboxItems(flatOptions);
	const groupMeta = groups ? groupMetaByValue(groups) : null;

	// Self-elevate +1 above the host panel so callers render a bare
	// <SearchableSelect/> with no wrapping `ElevatedSurface`. The input keeps its
	// own bg+shadow and now carries the ring it used to borrow from the wrapper;
	// the popup lifts +2. Width is passed via `className` onto the trigger box.
	const {
		substrate,
		triggerLevel: inputLevel,
		popupLevel,
		popupShadow,
	} = usePopupSurfaceLevels();

	// The popup is the `position: relative` scroll container the animated
	// selected/hover pills measure against (rows scroll inside it).
	const popupRef = useRef<HTMLDivElement | null>(null);

	// Measure the rendered badge/icon decoration so the input gets exactly
	// the right left-padding, regardless of how wide the badge text is
	// ("EN" vs "AUTO" vs "YUE"). A fixed estimate would either clip wider
	// badges or waste whitespace for short ones.
	const decorationRef = useRef<HTMLSpanElement>(null);
	const [decorationWidth, setDecorationWidth] = useState(0);
	const hasDecoration = Boolean(selected?.badge || selected?.icon);
	useLayoutEffect(() => {
		// When there's no decoration the measured width is irrelevant —
		// `decorationPadding` already short-circuits to 0 via `hasDecoration`,
		// so we skip the redundant state write and only sync on real nodes.
		const node = hasDecoration ? decorationRef.current : null;
		if (!node) {
			return;
		}
		const sync = () => setDecorationWidth(node.offsetWidth);
		sync();
		const observer = new ResizeObserver(sync);
		observer.observe(node);
		return () => {
			observer.disconnect();
		};
	}, [hasDecoration]);
	// 8px matches `left-2` on the decoration span; the trailing 8px is the
	// gap between the decoration and the typed text.
	const decorationPadding = hasDecoration ? 8 + decorationWidth + 8 : 0;

	return (
		<SurfaceProvider value={substrate}>
			<Combobox.Root
				defaultOpen={defaultOpen}
				defaultValue={selected}
				disabled={disabled}
				filter={optionMatchesQuery}
				isItemEqualToValue={(a: SelectOption | null, b: SelectOption | null) =>
					a?.id === b?.id
				}
				items={comboboxItems}
				itemToStringLabel={getItemLabel}
				onOpenChange={onOpenChange}
				onValueChange={(item: SelectOption | null) => {
					if (item) {
						onChange(item.id);
					}
				}}
				value={selected}
			>
				{/* `isolation-isolate` forces a stacking context on this wrapper so the
			    badge's positioned children can never escape and overlap other
			    comboboxes / popovers elsewhere on the page. */}
				<div
					className={cn("relative isolate flex w-full items-center", className)}
				>
					{hasDecoration ? (
						<span
							className="pointer-events-none absolute top-1/2 left-2 flex -translate-y-1/2 items-center gap-1.5"
							ref={decorationRef}
						>
							{selected?.badge ? <OptionBadge text={selected.badge} /> : null}
							{selected?.icon ? (
								<OptionIcon active icon={selected.icon} />
							) : null}
						</span>
					) : null}
					<Combobox.Input
						className={`flex h-8 w-full cursor-pointer items-center rounded-lg ${surfaceClasses(inputLevel)} ring-1 ring-divider ${inputTrailing ? "pr-16" : "pr-7"} pl-2.5 font-inherit text-body text-foreground leading-normal outline-none focus:cursor-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1 disabled:cursor-not-allowed disabled:opacity-40`}
						placeholder={placeholder}
						style={
							decorationPadding > 0
								? { paddingLeft: `${decorationPadding}px` }
								: undefined
						}
					/>
					{inputTrailing ? (
						<StopBubble className="absolute top-1/2 right-7 flex -translate-y-1/2 items-center">
							{inputTrailing}
						</StopBubble>
					) : null}
					<Combobox.Trigger
						aria-label="Open popup"
						className="absolute top-1/2 right-1.5 flex size-5 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent p-0 text-foreground-dim"
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
								// Top padding lives on the LIST, not here: a sticky group header pins to
								// the scroll container's padding edge, so a `pt` on this scroller would
								// leave a band ABOVE the header where scrolling rows leak through. Keeping
								// only `pb-1` lets the header pin flush to the popup's top edge.
								className={`searchable-select-popup relative w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-lg ${surfaceClasses(popupLevel, popupShadow)} pb-1 [max-height:min(15rem,var(--available-height))]`}
								ref={popupRef}
							>
								<MenuHighlightLayer containerRef={popupRef} value={value} />
								<Combobox.Empty className="searchable-select-empty">
									{t("noResults")}
								</Combobox.Empty>
								<Combobox.List className="pt-1 outline-none">
									{groups
										? (group: { items: SelectOption[]; value: string }) => {
												const meta = groupMeta?.get(group.value);
												return (
													<Combobox.Group
														className="flex flex-col"
														items={group.items}
														key={group.value}
													>
														<GroupHeader
															badge={meta?.badge}
															icon={meta?.icon}
															label={meta?.label ?? group.value}
															level={popupLevel}
														/>
														{group.items.map((item) => (
															<Row
																grouped
																item={item}
																key={item.id}
																renderItemTrailing={renderItemTrailing}
																value={value}
															/>
														))}
													</Combobox.Group>
												);
											}
										: (item: SelectOption) => (
												<Row
													item={item}
													key={item.id}
													renderItemTrailing={renderItemTrailing}
													value={value}
												/>
											)}
								</Combobox.List>
							</Combobox.Popup>
						</Combobox.Positioner>
					</SurfaceProvider>
				</Combobox.Portal>
			</Combobox.Root>
		</SurfaceProvider>
	);
}
