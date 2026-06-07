"use client";

import { Combobox } from "@base-ui/react/combobox";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { cn } from "@/shared/lib/cn";
import { PulseDot } from "@/shared/ui/pulse-dot";

/**
 * Generic combobox shell shared by every model picker in the package.
 *
 * What it owns by default:
 *   - The `Combobox.Root` instance + open state + search-input state
 *   - The popup container (Portal → Positioner → Popup) with consistent
 *     border / background / radius / shadow / animation tokens
 *   - The search input row with optional `filtersMenu` addon + loading pulse dot
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
	/** Stable ``data-model-id`` key to scroll into view when the picker opens. */
	selectedItemKey?: string | null | undefined;
	/** Left sidebar slot — used by OpenRouter for the maker-rail. */
	sidebarSlot?: ReactNode;
	/** Trigger button — `<Combobox.Trigger>` + the closed-state UI. */
	trigger: ReactNode;
	/** Current value (string for primitive, item object for object-value mode). */
	value?: TValue;
}

const DEFAULT_POPUP_HEIGHT = "h-[min(620px,var(--available-height))]";
const DEFAULT_POPUP_WIDTH = "w-[max(520px,var(--anchor-width))]";
const POPUP_CLOSE_MS = 170;
const MODEL_LIST_SELECTOR = [
	'[data-slot="ollama-model-list"]',
	'[data-slot="stt-model-list"]',
	'[data-slot="tts-model-list"]',
].join(",");

const POPUP_BASE_CLASSES = cn(
	"t-dropdown relative z-popover flex flex-col overflow-hidden rounded-xl p-0",
	"max-w-[calc(100vw-32px)]",
	"bg-gradient-to-b from-[var(--color-surface-3)]/95 to-[var(--color-surface-2)]/98",
	"shadow-[0_12px_32px_-12px_rgba(2,3,8,0.65),inset_0_1px_0_0_rgba(255,255,255,0.06)]",
	"ring-1 ring-white/[0.08] ring-inset",
	"backdrop-blur-md backdrop-saturate-150",
);

const SEARCH_INPUT_CLASSES = cn(
	"h-11 flex-1 bg-transparent px-3",
	"font-inherit text-body text-foreground leading-normal outline-none",
	"transition-colors duration-150 ease-out",
	"placeholder:text-foreground-muted",
	"focus-visible:text-foreground",
);
const SEARCH_SHELL_CLASSES = cn(
	"relative flex min-h-12 w-full items-center border-divider border-b bg-[var(--color-surface-1)]/72 px-2",
	"shadow-[inset_0_1px_0_0_rgba(255,255,255,0.035)]",
	"ring-0 ring-accent/0 transition-[background-color,box-shadow,--tw-ring-color] duration-150 ease-out",
	"hover:bg-[var(--color-surface-1)]/86",
	"focus-within:bg-[var(--color-surface-2)]/72 focus-within:shadow-[inset_0_-1px_0_0_rgba(255,255,255,0.055)] focus-within:ring-2 focus-within:ring-accent/30",
);
const SEARCH_ICON_BUTTON_CLASSES = cn(
	"inline-flex size-7 shrink-0 items-center justify-center rounded-md",
	"bg-foreground/[0.055] text-foreground-secondary outline-none transition-colors",
	"hover:bg-foreground/[0.09] hover:text-foreground",
	"focus-visible:ring-2 focus-visible:ring-accent/50",
);

function findModelItem(root: ParentNode, modelId: string): HTMLElement | null {
	for (const item of root.querySelectorAll<HTMLElement>("[data-model-id]")) {
		if (item.dataset.modelId === modelId) {
			return item;
		}
	}
	return null;
}

function findModelListContainer(
	root: HTMLElement,
	target: HTMLElement,
): HTMLElement {
	const slottedList = target.closest<HTMLElement>(MODEL_LIST_SELECTOR);
	if (slottedList && root.contains(slottedList)) {
		return slottedList;
	}
	for (
		let element = target.parentElement;
		element;
		element = element.parentElement
	) {
		if (element.scrollHeight > element.clientHeight) {
			return element;
		}
		if (element === root) {
			break;
		}
	}
	return root;
}

export function scrollModelItemIntoView(
	root: HTMLElement,
	modelId: string,
): boolean {
	const target = findModelItem(root, modelId);
	if (!target) {
		return false;
	}
	const scrollContainer = findModelListContainer(root, target);
	const targetRect = target.getBoundingClientRect();
	const containerRect = scrollContainer.getBoundingClientRect();
	scrollContainer.scrollTop += targetRect.top - containerRect.top;
	return true;
}

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
	selectedItemKey,
	sidebarSlot,
	trigger,
	value,
}: ModelPickerProps<TItem, TValue>) {
	const [internalOpen, setInternalOpen] = useState(false);
	const [internalSearch, setInternalSearch] = useState("");
	const [popupContentReady, setPopupContentReady] = useState(false);
	const [popupClosing, setPopupClosing] = useState(false);
	// Side the popup opens toward. Recomputed on every open: the popup is
	// height-clamped to `--available-height`, so Base UI's flip never fires
	// (it always "fits" below by shrinking) — we instead pick whichever of
	// top / bottom has more room around the trigger so the list gets the most
	// vertical space. Driven by the layout effect + `triggerWrapperRef` below.
	const [popupSide, setPopupSide] = useState<"top" | "bottom">("bottom");
	const triggerWrapperRef = useRef<HTMLDivElement>(null);
	const popupNodeRef = useRef<HTMLElement | null>(null);
	const wasEffectivelyOpenRef = useRef(false);
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const isOpenControlled = controlledOpen !== undefined;
	const isSearchControlled = inputValue !== undefined;
	// Inline mode pins the combobox open — there is no trigger to toggle it,
	// the picker IS the surface.
	const controlledOrInternalOpen = isOpenControlled
		? controlledOpen
		: internalOpen;
	const effectiveOpen = inline ? true : controlledOrInternalOpen;
	const effectiveSearch = isSearchControlled ? inputValue : internalSearch;
	const popupOrigin = popupSide === "top" ? "bottom-left" : "top-left";
	const closingFromOpen =
		!inline && !effectiveOpen && wasEffectivelyOpenRef.current;
	const isClosingPopup =
		!inline && !effectiveOpen && (popupClosing || closingFromOpen);
	const popupStateClass = isClosingPopup
		? "is-closing"
		: effectiveOpen
			? "is-open"
			: "";

	const clearPopupCloseTimer = useCallback(() => {
		if (closeTimerRef.current !== null) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	}, []);

	const setPopupNode = useCallback(
		(node: HTMLElement | null) => {
			popupNodeRef.current = node;
			popupRef?.(node);
		},
		[popupRef],
	);

	const beginPopupClose = useCallback(() => {
		clearPopupCloseTimer();
		setPopupClosing(true);
		closeTimerRef.current = setTimeout(() => {
			setPopupClosing(false);
			closeTimerRef.current = null;
		}, POPUP_CLOSE_MS);
	}, [clearPopupCloseTimer]);

	useEffect(() => clearPopupCloseTimer, [clearPopupCloseTimer]);

	useEffect(() => {
		if (inline) {
			wasEffectivelyOpenRef.current = effectiveOpen;
			return;
		}
		if (effectiveOpen) {
			clearPopupCloseTimer();
			setPopupClosing(false);
		} else if (wasEffectivelyOpenRef.current) {
			beginPopupClose();
		}
		wasEffectivelyOpenRef.current = effectiveOpen;
	}, [beginPopupClose, clearPopupCloseTimer, effectiveOpen, inline]);

	// Measure the trigger when the popup opens and steer it toward the side with
	// more room (top vs bottom). Runs in a layout effect so the side is set
	// before paint — no visible bottom→top jump on open.
	useLayoutEffect(() => {
		if (inline || !effectiveOpen) {
			return;
		}
		const anchor = triggerWrapperRef.current;
		if (!anchor) {
			return;
		}
		const rect = anchor.getBoundingClientRect();
		const spaceAbove = rect.top;
		const spaceBelow = window.innerHeight - rect.bottom;
		setPopupSide(spaceAbove > spaceBelow ? "top" : "bottom");
	}, [effectiveOpen, inline]);

	useEffect(() => {
		if (inline) {
			setPopupContentReady(true);
			return;
		}
		if (!effectiveOpen || popupContentReady) {
			return;
		}
		setPopupContentReady(false);
		let secondFrame: number | null = null;
		const firstFrame = requestAnimationFrame(() => {
			secondFrame = requestAnimationFrame(() => setPopupContentReady(true));
		});
		return () => {
			cancelAnimationFrame(firstFrame);
			if (secondFrame !== null) {
				cancelAnimationFrame(secondFrame);
			}
		};
	}, [effectiveOpen, inline, popupContentReady]);

	const renderCollection = inline || popupContentReady;

	useEffect(() => {
		if (!effectiveOpen || !renderCollection || !selectedItemKey) {
			return;
		}
		const root = popupNodeRef.current;
		if (!root) {
			return;
		}
		let firstFrame = 0;
		let secondFrame = 0;
		let observer: MutationObserver | null = null;
		let observerTimer: ReturnType<typeof setTimeout> | null = null;

		const disconnectObserver = () => {
			observer?.disconnect();
			observer = null;
			if (observerTimer !== null) {
				clearTimeout(observerTimer);
				observerTimer = null;
			}
		};
		const tryScroll = (): boolean => {
			const didScroll = scrollModelItemIntoView(root, selectedItemKey);
			if (didScroll) {
				disconnectObserver();
			}
			return didScroll;
		};

		firstFrame = requestAnimationFrame(() => {
			secondFrame = requestAnimationFrame(() => {
				if (tryScroll() || typeof MutationObserver === "undefined") {
					return;
				}
				observer = new MutationObserver(() => {
					tryScroll();
				});
				observer.observe(root, { childList: true, subtree: true });
				observerTimer = setTimeout(disconnectObserver, 1000);
			});
		});

		return () => {
			cancelAnimationFrame(firstFrame);
			cancelAnimationFrame(secondFrame);
			disconnectObserver();
		};
	}, [effectiveOpen, renderCollection, selectedItemKey]);

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
				className="pointer-events-none absolute inset-x-5 top-0 z-raised h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent"
			/>
			<div className="flex flex-col">
				{/* Input group: the filter button sits INSIDE the search
				    input on the right edge, and the search itself fills the
				    whole top strip. There is no padded wrapper around it, so
				    the selector reads like one enlarged bezel-less search bar. */}
				<div className={SEARCH_SHELL_CLASSES}>
					<Combobox.Input
						className={cn(
							SEARCH_INPUT_CLASSES,
							isLoading &&
								!filtersMenuSlot &&
								effectiveSearch.trim() === "" &&
								"pe-6",
						)}
						dir="ltr"
						placeholder={searchPlaceholder}
					/>
					{isLoading ? (
						<PulseDot
							className={cn(
								"pointer-events-none absolute top-1/2 size-2.5 -translate-y-1/2 text-foreground-muted",
								filtersMenuSlot || effectiveSearch.trim() !== ""
									? "end-11"
									: "end-3",
							)}
						/>
					) : null}
					{filtersMenuSlot ? (
						<div className={SEARCH_ICON_BUTTON_CLASSES}>{filtersMenuSlot}</div>
					) : effectiveSearch.trim() !== "" ? (
						<button
							aria-label="Clear search"
							className={SEARCH_ICON_BUTTON_CLASSES}
							onClick={() => handleInputValueChange("")}
							type="button"
						>
							<HugeiconsIcon
								aria-hidden="true"
								className="size-3.5"
								icon={Cancel01Icon}
							/>
						</button>
					) : null}
				</div>
				{activeFiltersSlot ? (
					<div className="border-divider border-b bg-[var(--color-surface-1)]/42 px-2.5 py-2">
						{activeFiltersSlot}
					</div>
				) : null}
			</div>
			<div className="flex min-h-0 min-w-0 flex-1">
				{renderCollection ? sidebarSlot : null}
				{/* `min-w-0` is load-bearing: a flex child defaults to
				    `min-width: auto` (= its content's intrinsic min size), so
				    without this the list column refuses to shrink below the
				    widest card's non-shrinking right column (perf bars +
				    attribute badges + variant chevron) and the cards spill past
				    the fixed-width popup — most visible under the realtime
				    filter, whose surviving cards all carry that wide right
				    column. With `min-w-0` the column tracks the available width
				    and each card's own `min-w-0` left region truncates instead. */}
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					{renderCollection ? (
						list
					) : (
						<div
							aria-hidden="true"
							className="min-h-0 flex-1"
							data-slot="model-picker-list-warmup"
						/>
					)}
				</div>
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
				// Let Base UI see the real closed state. It keeps the popup mounted
				// during `data-ending-style`; `is-closing` is only our fallback class.
				open={effectiveOpen}
				value={value as never}
			>
				{inline ? (
					<div
						className={cn(
							POPUP_BASE_CLASSES,
							"is-open",
							popupHeightClass,
							popupWidthClass,
						)}
						data-origin="top-left"
						data-slot="model-picker-inline"
						ref={setPopupNode}
					>
						{panelBody}
					</div>
				) : (
					<>
						{/* Wrapper measures the trigger's viewport position so the popup
						    can open toward the side with more room — see triggerWrapperRef
						    and the open-side layout effect. It adds no visual box. */}
						<div className="w-full" ref={triggerWrapperRef}>
							{trigger}
						</div>
						<Combobox.Portal keepMounted>
							<Combobox.Positioner
								align="start"
								className="z-popover outline-none"
								side={popupSide}
								sideOffset={6}
							>
								<Combobox.Popup
									className={cn(
										POPUP_BASE_CLASSES,
										popupStateClass,
										popupHeightClass,
										popupWidthClass,
									)}
									data-origin={popupOrigin}
									data-slot="model-picker-popup"
									ref={setPopupNode}
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
