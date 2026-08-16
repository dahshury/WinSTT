"use client";

import { Combobox } from "@base-ui/react/combobox";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import { ModelPickerShortcutContext } from "./model-picker-shortcuts";
import { ModelPickerPanelBody } from "./ModelPickerPanelBody";
import { useScrollSelectedIntoView } from "./use-scroll-selected-into-view";

export interface ModelPickerProps<TItem, TValue> {
	activeFiltersSlot?: ReactNode;
	belowListSlot?: ReactNode;
	disabled?: boolean;
	compact?: boolean;
	filter?: (item: TItem, query: string) => boolean;
	/** Rendered in the search shell just before the filter trigger (no
	 *  icon-button chrome) — e.g. the STT "Suggested" chip. */
	filtersLeadingSlot?: ReactNode;
	filtersMenuSlot?: ReactNode;
	inline?: boolean;
	inputValue?: string;
	isItemEqualToValue?: (a: TItem | null, b: TItem | null) => boolean;
	isLoading?: boolean;
	items?: readonly unknown[];
	itemToStringLabel?: (item: TItem | null) => string;
	list: ReactNode;
	onInputValueChange?: (value: string) => void;
	onOpen?: () => void;
	onOpenChange?: (open: boolean, eventDetails?: unknown) => void;
	onValueChange?: (next: TValue, eventDetails?: unknown) => void;
	open?: boolean;
	popupHeightClass?: string;
	popupRef?: (node: HTMLElement | null) => void;
	popupWidthClass?: string;
	searchPlaceholder?: string;
	selectedItemKey?: string | null | undefined;
	sidebarSlot?: ReactNode;
	trigger: ReactNode;
	value?: TValue;
}

const DEFAULT_POPUP_HEIGHT = "h-[min(620px,var(--available-height))]";
const DEFAULT_POPUP_WIDTH = "w-[max(520px,var(--anchor-width))]";
const PANEL_SURFACE_CLASSES = cn(
	"relative z-popover flex flex-col overflow-hidden rounded-xl p-0",
	"max-w-[calc(100vw-32px)]",
	"bg-gradient-to-b from-surface-3/95 to-surface-2/98",
	"shadow-model-picker-popup ring-1 ring-overlay-foreground/[0.08] ring-inset",
	"backdrop-blur-md backdrop-saturate-150",
);
const POPUP_BASE_CLASSES = cn("t-dropdown", PANEL_SURFACE_CLASSES);

const MODEL_SHORTCUT_COUNT = 9;
const HIDDEN_SHORTCUT_LABELS: ReadonlyMap<string, string> = new Map();

function flattenPickerItems<TItem>(
	items: readonly unknown[] | undefined,
): TItem[] {
	if (!items) {
		return [];
	}
	const flattened: TItem[] = [];
	for (const item of items) {
		if (
			typeof item === "object" &&
			item !== null &&
			"items" in item &&
			Array.isArray(item.items)
		) {
			flattened.push(...flattenPickerItems<TItem>(item.items));
		} else {
			flattened.push(item as TItem);
		}
	}
	return flattened;
}

function defaultItemKey<TItem>(
	item: TItem,
	itemToStringLabel: ((item: TItem | null) => string) | undefined,
): string {
	if (typeof item === "string") {
		return item;
	}
	if (typeof item === "object" && item !== null) {
		if ("id" in item && typeof item.id === "string") {
			return item.id;
		}
		if ("name" in item && typeof item.name === "string") {
			return item.name;
		}
	}
	return itemToStringLabel?.(item) ?? String(item);
}

function selectableItemMap<TItem>(
	items: readonly unknown[] | undefined,
	filter: (item: TItem, query: string) => boolean,
	query: string,
	itemToStringLabel: ((item: TItem | null) => string) | undefined,
): Map<string, TItem> {
	const itemByKey = new Map<string, TItem>();
	for (const item of flattenPickerItems<TItem>(items)) {
		if (!filter(item, query)) {
			continue;
		}
		const key = defaultItemKey(item, itemToStringLabel);
		if (!itemByKey.has(key)) {
			itemByKey.set(key, item);
		}
	}
	return itemByKey;
}

function renderedModelKeys(
	root: HTMLElement | null,
	selectableKeys?: ReadonlySet<string>,
): string[] {
	if (!root) {
		return [];
	}
	const keys: string[] = [];
	const seen = new Set<string>();
	for (const node of root.querySelectorAll<HTMLElement>("[data-model-id]")) {
		if (
			node.closest("[inert]") ||
			node.closest('[aria-disabled="true"]') ||
			node.closest("[data-disabled]")
		) {
			continue;
		}
		const key = node.dataset["modelId"]?.trim();
		if (!key || seen.has(key) || (selectableKeys && !selectableKeys.has(key))) {
			continue;
		}
		seen.add(key);
		keys.push(key);
		if (keys.length === MODEL_SHORTCUT_COUNT) {
			break;
		}
	}
	return keys;
}

function shortcutLabelsForKeys(
	keys: readonly string[],
): ReadonlyMap<string, string> {
	return new Map(
		keys
			.slice(0, MODEL_SHORTCUT_COUNT)
			.map((key, index) => [key, `Ctrl+${index + 1}`]),
	);
}

function mapsEqual(
	a: ReadonlyMap<string, string>,
	b: ReadonlyMap<string, string>,
): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const [key, value] of a) {
		if (b.get(key) !== value) {
			return false;
		}
	}
	return true;
}

export function ModelPicker<TItem, TValue = TItem | null>({
	activeFiltersSlot,
	belowListSlot,
	compact = false,
	disabled = false,
	filter,
	filtersLeadingSlot,
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
	const popupNodeRef = useRef<HTMLElement | null>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const [shortcutLabels, setShortcutLabels] = useState<
		ReadonlyMap<string, string>
	>(new Map());
	const [isControlPressed, setIsControlPressed] = useState(false);

	const isOpenControlled = controlledOpen !== undefined;
	const isSearchControlled = inputValue !== undefined;
	const controlledOrInternalOpen = isOpenControlled
		? controlledOpen
		: internalOpen;
	const effectiveOpen = inline ? true : controlledOrInternalOpen;
	const effectiveSearch = isSearchControlled ? inputValue : internalSearch;
	const effectiveFilter =
		filter ??
		((item: TItem, query: string) =>
			matchesFuzzySearch(itemToStringLabel?.(item) ?? String(item), query));
	const popupStateClass =
		inline || effectiveOpen ? (effectiveOpen ? "is-open" : "") : "is-closing";
	const renderPanelControls = inline || effectiveOpen;
	const [hasRenderedCollection, setHasRenderedCollection] = useState(false);

	const setPopupNode = (node: HTMLElement | null) => {
		popupNodeRef.current = node;
		popupRef?.(node);
	};

	useLayoutEffect(() => {
		if (!effectiveOpen) {
			return;
		}
		const focusSearchInput = () => {
			searchInputRef.current?.focus({ preventScroll: true });
		};
		focusSearchInput();
		const frame = requestAnimationFrame(focusSearchInput);
		return () => {
			cancelAnimationFrame(frame);
		};
		// react-doctor-disable-next-line react-doctor/exhaustive-deps -- `effectiveOpen` is the derived boolean this effect gates on; react-doctor unwraps it to its four render-primitive sources, but depending on those would re-run (and re-steal focus) while the popup is already open, so the derived value is the correct minimal dependency.
	}, [effectiveOpen]);

	useEffect(() => {
		if (inline || !effectiveOpen || hasRenderedCollection) {
			return;
		}
		let firstFrame = 0;
		let secondFrame = 0;
		firstFrame = requestAnimationFrame(() => {
			secondFrame = requestAnimationFrame(() => {
				// eslint-disable-next-line react-hooks-js/set-state-in-effect -- deliberate two-frame deferral: heavy collection is rendered only after the popup paints/animates open, not derivable during render
				setHasRenderedCollection(true);
			});
		});
		return () => {
			cancelAnimationFrame(firstFrame);
			cancelAnimationFrame(secondFrame);
		};
		// react-doctor-disable-next-line react-doctor/exhaustive-deps -- `effectiveOpen` is the derived open-state boolean; react-doctor unwraps it to its render-primitive sources, but the deferral is guarded by `!effectiveOpen` and `hasRenderedCollection`, so the derived value is the correct minimal dependency and adding the sources would only add redundant re-runs.
	}, [effectiveOpen, hasRenderedCollection, inline]);

	const renderCollection = inline || hasRenderedCollection;

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Control" || event.ctrlKey) {
				setIsControlPressed(true);
			}
		};
		const handleKeyUp = (event: KeyboardEvent) => {
			if (event.key === "Control" || !event.ctrlKey) {
				setIsControlPressed(false);
			}
		};
		const handleBlur = () => setIsControlPressed(false);
		window.addEventListener("keydown", handleKeyDown, true);
		window.addEventListener("keyup", handleKeyUp, true);
		window.addEventListener("blur", handleBlur);
		return () => {
			window.removeEventListener("keydown", handleKeyDown, true);
			window.removeEventListener("keyup", handleKeyUp, true);
			window.removeEventListener("blur", handleBlur);
		};
	}, []);

	useScrollSelectedIntoView(popupNodeRef, {
		effectiveOpen,
		renderCollection,
		selectedItemKey,
	});

	useLayoutEffect(() => {
		if (!(effectiveOpen && renderCollection)) {
			setShortcutLabels((current) =>
				current.size === 0 ? current : new Map(),
			);
			return;
		}
		const updateShortcutLabels = () => {
			const selectableKeys = new Set(
				selectableItemMap(
					items,
					effectiveFilter,
					effectiveSearch,
					itemToStringLabel,
				).keys(),
			);
			const next = shortcutLabelsForKeys(
				renderedModelKeys(popupNodeRef.current, selectableKeys),
			);
			setShortcutLabels((current) =>
				mapsEqual(current, next) ? current : next,
			);
		};
		updateShortcutLabels();
		const frame = requestAnimationFrame(updateShortcutLabels);
		const observer = new MutationObserver(updateShortcutLabels);
		if (popupNodeRef.current) {
			observer.observe(popupNodeRef.current, {
				attributes: true,
				attributeFilter: ["aria-disabled", "data-model-id", "inert"],
				childList: true,
				subtree: true,
			});
		}
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	}, [
		effectiveFilter,
		effectiveOpen,
		effectiveSearch,
		itemToStringLabel,
		items,
		list,
		renderCollection,
	]);

	const handleOpenChange = (next: boolean, eventDetails?: unknown) => {
		if (inline) {
			onOpenChange?.(next, eventDetails);
			return;
		}
		if (!isOpenControlled) {
			setInternalOpen(next);
			if (next) {
				onOpen?.();
			} else if (!isSearchControlled) {
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
		if (inline && !isSearchControlled) {
			queueMicrotask(() => setInternalSearch(""));
		}
	};

	useEffect(() => {
		if (!(effectiveOpen && renderCollection) || disabled) {
			return;
		}
		const handleShortcut = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.repeat ||
				!event.ctrlKey ||
				event.altKey ||
				event.metaKey ||
				event.shiftKey ||
				!/^[1-9]$/.test(event.key)
			) {
				return;
			}
			const shortcutIndex = Number(event.key) - 1;
			const itemByKey = selectableItemMap(
				items,
				effectiveFilter,
				effectiveSearch,
				itemToStringLabel,
			);
			const renderedKeys = renderedModelKeys(
				popupNodeRef.current,
				new Set(itemByKey.keys()),
			);
			const fallbackKeys = [...itemByKey.keys()].slice(0, MODEL_SHORTCUT_COUNT);
			const key = (renderedKeys.length > 0 ? renderedKeys : fallbackKeys)[
				shortcutIndex
			];
			const item = key ? itemByKey.get(key) : undefined;
			if (item === undefined) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			const details = {
				reason: "keyboard-shortcut",
				shortcut: `Ctrl+${event.key}`,
			};
			handleValueChange(item as TValue, details);
			if (!inline) {
				handleOpenChange(false, details);
			}
		};
		window.addEventListener("keydown", handleShortcut, true);
		return () => {
			window.removeEventListener("keydown", handleShortcut, true);
		};
	}, [
		disabled,
		effectiveFilter,
		effectiveOpen,
		effectiveSearch,
		inline,
		itemToStringLabel,
		items,
		renderCollection,
	]);

	const panelBody = (
		<ModelPickerShortcutContext.Provider
			value={isControlPressed ? shortcutLabels : HIDDEN_SHORTCUT_LABELS}
		>
			<ModelPickerPanelBody
				activeFiltersSlot={activeFiltersSlot}
				compact={compact}
				effectiveSearch={effectiveSearch}
				filtersLeadingSlot={filtersLeadingSlot}
				filtersMenuSlot={filtersMenuSlot}
				isLoading={isLoading}
				list={list}
				onClearSearch={() => handleInputValueChange("")}
				renderCollection={renderCollection}
				renderPanelControls={renderPanelControls}
				searchInputRef={searchInputRef}
				searchPlaceholder={searchPlaceholder}
				sidebarSlot={sidebarSlot}
			/>
		</ModelPickerShortcutContext.Provider>
	);

	return (
		<div className="flex flex-col gap-2" data-slot="model-picker">
			<Combobox.Root
				disabled={disabled}
				filter={effectiveFilter as never}
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
						className={cn(
							PANEL_SURFACE_CLASSES,
							popupHeightClass,
							popupWidthClass,
						)}
						data-slot="model-picker-inline"
						ref={setPopupNode}
					>
						{panelBody}
					</div>
				) : (
					<>
						<div className="w-full">{trigger}</div>
						<Combobox.Portal keepMounted>
							<Combobox.Positioner
								align="start"
								className="z-popover outline-none"
								collisionPadding={8}
								side="bottom"
								sideOffset={6}
							>
								<Combobox.Popup
									className={cn(
										POPUP_BASE_CLASSES,
										popupStateClass,
										popupHeightClass,
										popupWidthClass,
									)}
									data-origin="top-left"
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
