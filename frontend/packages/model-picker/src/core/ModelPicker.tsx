"use client";

import { Combobox } from "@base-ui/react/combobox";
import type { ReactNode } from "react";
import { useState } from "react";
import { cn } from "@/shared/lib/cn";
import { Spinner } from "@/shared/ui/spinner";

/**
 * Generic combobox shell shared by every model picker in the package.
 *
 * What it owns by default:
 *   - The `Combobox.Root` instance + open state + search-input state
 *   - The popup container (Portal → Positioner → Popup) with consistent
 *     border / background / radius / shadow / animation tokens
 *   - The search input row with optional `filtersMenu` addon + loading spinner
 *   - The optional left sidebar slot (provider-rail style)
 *   - The optional active-filters bar below the search row
 *   - The optional content slot rendered below the popup (e.g. reasoning controls)
 *   - Auto-clear of the search query when the popup closes
 *   - `onOpen` lazy-refresh callback (used by Ollama + OpenRouter)
 *
 * Controlled mode: when `open` is supplied, the shell becomes fully
 * controlled — the consumer manages open transitions via `onOpenChange`.
 * Same for `inputValue` / `onInputValueChange`. OpenRouter uses this to
 * intercept "click in nested submenu" events so the popup doesn't close
 * when the user opens its filters menu.
 *
 * What the consumer supplies:
 *   - `trigger`: the closed-state button (rendered via `Combobox.Trigger`)
 *   - `list`:    the open-state list (typically `Combobox.List` + items)
 *   - The Combobox.Root passthrough props (`items`, `value`, `filter`,
 *     `isItemEqualToValue`, `itemToStringLabel`, `onValueChange`) — these vary
 *     per provider's data shape so the shell keeps them generic instead of
 *     enforcing a single normalized `UniModel`.
 *
 * The same shell renders the OpenRouter, STT, and Ollama pickers — each
 * provider just composes it with its own row chip vocabulary.
 */
export interface ModelPickerProps<TItem, TValue> {
	/** Optional bar shown directly below the search row (Active filters etc.). */
	activeFiltersSlot?: ReactNode;
	/** Optional content rendered below the popup (e.g. ReasoningControls). */
	belowListSlot?: ReactNode;
	disabled?: boolean;
	/** Combobox.Root `filter` — return true for items that pass search. */
	filter?: (item: TItem, query: string) => boolean;
	/** Optional menu rendered inside the search input row (right-aligned). */
	filtersMenuSlot?: ReactNode;
	/**
	 * Inline/panel mode. Renders the search row + sidebar + list directly
	 * (no trigger, no Portal/Positioner/Popup) with the combobox forced
	 * open, so the picker can fill a dedicated host (e.g. the detached
	 * model-picker window) instead of floating off a trigger.
	 */
	inline?: boolean;
	/**
	 * Controlled search-input value. When supplied, `onInputValueChange`
	 * must also be supplied; the shell stops managing search state.
	 */
	inputValue?: string;
	/**
	 * Combobox.Root `isItemEqualToValue`. Required when `value` is an object
	 * (e.g. STT picker's selected ModelInfo) — omit when `value` is a string.
	 */
	isItemEqualToValue?: (a: TItem | null, b: TItem | null) => boolean;
	isLoading?: boolean;
	/**
	 * Combobox.Root `items` — flat array OR Base UI's grouped collection
	 * shape (`{ items: TItem[]; value?: unknown }[]`). Typed as `unknown[]`
	 * here because the shell pipes the value through to Combobox.Root which
	 * handles both shapes natively.
	 */
	items?: readonly unknown[];
	/**
	 * Combobox.Root `itemToStringLabel` — used by Base UI for keyboard
	 * typeahead and accessibility narration of the selected item.
	 */
	itemToStringLabel?: (item: TItem | null) => string;
	/** List body — typically `<Combobox.List>` + group headers + rows. */
	list: ReactNode;
	/** Called when the search input value changes (controlled mode). */
	onInputValueChange?: (value: string) => void;
	/**
	 * Lazy-refresh hook fired the moment the popup opens — used by Ollama
	 * (re-scan `/api/tags`) and OpenRouter (re-scan the catalog). In
	 * controlled mode, callers can call this from their own `onOpenChange`.
	 */
	onOpen?: () => void;
	/**
	 * Called on every open transition. In uncontrolled mode the shell also
	 * updates its own state; in controlled mode (when `open` is supplied)
	 * the shell delegates entirely to this callback.
	 */
	onOpenChange?: (open: boolean, eventDetails?: unknown) => void;
	/** Called with the selected item (or null for clear). */
	onValueChange?: (next: TValue, eventDetails?: unknown) => void;
	/**
	 * Controlled open state. When supplied, the shell stops managing open
	 * state — use this when the consumer needs to intercept close events
	 * (e.g. OpenRouter's nested-submenu click suppression).
	 */
	open?: boolean;
	/** Height class for the popup container. Tunable per picker. */
	popupHeightClass?: string;
	/**
	 * Callback receiving the popup DOM node. Used by OpenRouter to wire its
	 * click-tracking ref so clicks inside the nested filters submenu don't
	 * cause the popup to close.
	 */
	popupRef?: (node: HTMLElement | null) => void;
	/** Width class for the popup container. Tunable per picker. */
	popupWidthClass?: string;
	/** Localized search-input placeholder. */
	searchPlaceholder?: string;
	/** Left sidebar slot — used by OpenRouter for the maker-rail. */
	sidebarSlot?: ReactNode;
	/** Trigger button — `<Combobox.Trigger>` + the closed-state UI. */
	trigger: ReactNode;
	/** Current value (string for primitive, item object for object-value mode). */
	value?: TValue;
}

const DEFAULT_POPUP_HEIGHT = "h-[min(620px,var(--available-height))]";
const DEFAULT_POPUP_WIDTH = "w-[max(520px,var(--anchor-width))]";

const POPUP_BASE_CLASSES = cn(
	"select-popup relative z-popover flex flex-col overflow-hidden rounded-xl p-0",
	"max-w-[calc(100vw-32px)] origin-(--transform-origin)",
	"bg-gradient-to-b from-[var(--color-surface-3)]/95 to-[var(--color-surface-2)]/98",
	"shadow-[0_12px_32px_-12px_rgba(2,3,8,0.65),inset_0_1px_0_0_rgba(255,255,255,0.06)]",
	"ring-1 ring-white/[0.08] ring-inset",
	"backdrop-blur-md backdrop-saturate-150",
	"transition-[transform,opacity] duration-150 ease-out data-[ending-style]:ease-in"
);

const SEARCH_INPUT_CLASSES = cn(
	"h-9 flex-1 rounded-md bg-[var(--color-surface-1)]/70 px-3",
	"font-inherit text-body text-foreground leading-normal outline-none",
	"shadow-[inset_0_1px_0_0_rgba(0,0,0,0.20),inset_0_0_0_1px_rgba(255,255,255,0.04)]",
	"ring-1 ring-white/[0.04] ring-inset",
	"transition-[box-shadow,background-color] duration-150 ease-out",
	"placeholder:text-foreground-muted",
	"hover:bg-[var(--color-surface-1)]/85",
	"focus-visible:bg-[var(--color-surface-2)]/80 focus-visible:ring-2 focus-visible:ring-accent/60"
);

export function ModelPicker<TItem, TValue = TItem | null>({
	activeFiltersSlot,
	belowListSlot,
	filter,
	filtersMenuSlot,
	inline = false,
	inputValue,
	isItemEqualToValue,
	isLoading = false,
	items,
	itemToStringLabel,
	list,
	onInputValueChange,
	onOpen,
	onOpenChange,
	onValueChange,
	open: controlledOpen,
	popupHeightClass = DEFAULT_POPUP_HEIGHT,
	popupRef,
	popupWidthClass = DEFAULT_POPUP_WIDTH,
	searchPlaceholder = "Search models",
	sidebarSlot,
	trigger,
	value,
}: ModelPickerProps<TItem, TValue>) {
	const [internalOpen, setInternalOpen] = useState(false);
	const [internalSearch, setInternalSearch] = useState("");

	const isOpenControlled = controlledOpen !== undefined;
	const isSearchControlled = inputValue !== undefined;
	// Inline mode pins the combobox open — there is no trigger to toggle it,
	// the picker IS the surface.
	const controlledOrInternalOpen = isOpenControlled ? controlledOpen : internalOpen;
	const effectiveOpen = inline ? true : controlledOrInternalOpen;
	const effectiveSearch = isSearchControlled ? inputValue : internalSearch;

	const handleOpenChange = (next: boolean, eventDetails?: unknown) => {
		// Inline mode never actually closes the combobox; it just forwards
		// the intent (e.g. Esc) so the host can dismiss its window.
		if (inline) {
			onOpenChange?.(next, eventDetails);
			return;
		}
		if (!isOpenControlled) {
			setInternalOpen(next);
			if (next) {
				onOpen?.();
			} else if (!isSearchControlled) {
				// Clear search on close so the next open starts fresh.
				setInternalSearch("");
			}
		}
		onOpenChange?.(next, eventDetails);
	};

	const handleInputValueChange = (next: string) => {
		if (!isSearchControlled) {
			setInternalSearch(next);
		}
		onInputValueChange?.(next);
	};

	const handleValueChange = (next: TValue, eventDetails?: unknown) => {
		onValueChange?.(next, eventDetails);
		// Selecting an item makes Base UI write that item's label into the
		// search input. A normal popup hides this (it closes, then clears on
		// close), but an always-open inline panel would stay filtered down to
		// just the picked model. Clear the query after Base UI's synchronous
		// input write so the full list comes back.
		if (inline && !isSearchControlled) {
			queueMicrotask(() => setInternalSearch(""));
		}
	};

	const panelBody = (
		<>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-5 top-0 z-raised h-px bg-gradient-to-r from-transparent via-accent/55 to-transparent"
			/>
			<div className="flex flex-col gap-2 border-divider border-b p-2.5">
				{/* Input group: the filter button sits INSIDE the search
				    input on the right edge, sharing the same surface so
				    they read as one control instead of "input + button".
				    Same pattern across all three pickers. Input gets
				    end-padding when either the loading spinner or the
				    filters menu is present to leave room. */}
				<div className="relative flex w-full items-center">
					<Combobox.Input
						className={cn(
							SEARCH_INPUT_CLASSES,
							filtersMenuSlot && "pe-12",
							!filtersMenuSlot && isLoading && "pe-9"
						)}
						dir="ltr"
						placeholder={searchPlaceholder}
					/>
					{isLoading ? (
						<Spinner
							className={cn(
								"pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-foreground-muted",
								filtersMenuSlot ? "end-11" : "end-3"
							)}
						/>
					) : null}
					{filtersMenuSlot ? (
						<div className="absolute end-1.5 top-1/2 -translate-y-1/2">{filtersMenuSlot}</div>
					) : null}
				</div>
				{activeFiltersSlot}
			</div>
			<div className="flex min-h-0 min-w-0 flex-1">
				{sidebarSlot}
				{/* `min-w-0` is load-bearing: a flex child defaults to
				    `min-width: auto` (= its content's intrinsic min size), so
				    without this the list column refuses to shrink below the
				    widest card's non-shrinking right column (perf bars +
				    attribute badges + variant chevron) and the cards spill past
				    the fixed-width popup — most visible under the realtime
				    filter, whose surviving cards all carry that wide right
				    column. With `min-w-0` the column tracks the available width
				    and each card's own `min-w-0` left region truncates instead. */}
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">{list}</div>
			</div>
		</>
	);

	return (
		<div className="flex flex-col gap-2" data-slot="model-picker">
			<Combobox.Root
				filter={filter as never}
				inputValue={effectiveSearch}
				isItemEqualToValue={isItemEqualToValue as never}
				items={items as never}
				itemToStringLabel={itemToStringLabel as never}
				modal={false}
				onInputValueChange={handleInputValueChange}
				onOpenChange={handleOpenChange}
				onValueChange={handleValueChange as never}
				open={effectiveOpen}
				value={value as never}
			>
				{inline ? (
					<div
						className={cn(POPUP_BASE_CLASSES, popupHeightClass, popupWidthClass)}
						data-slot="model-picker-inline"
						ref={popupRef}
					>
						{panelBody}
					</div>
				) : (
					<>
						{trigger}
						<Combobox.Portal>
							<Combobox.Positioner align="start" className="z-popover outline-none" sideOffset={6}>
								<Combobox.Popup
									className={cn(POPUP_BASE_CLASSES, popupHeightClass, popupWidthClass)}
									ref={popupRef}
								>
									{panelBody}
								</Combobox.Popup>
							</Combobox.Positioner>
						</Combobox.Portal>
					</>
				)}
			</Combobox.Root>
			{belowListSlot}
		</div>
	);
}
