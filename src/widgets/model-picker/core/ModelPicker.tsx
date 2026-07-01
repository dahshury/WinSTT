"use client";

import { Combobox } from "@base-ui/react/combobox";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import { ModelPickerPanelBody } from "./ModelPickerPanelBody";
import { useScrollSelectedIntoView } from "./use-scroll-selected-into-view";

export interface ModelPickerProps<TItem, TValue> {
	activeFiltersSlot?: ReactNode;
	belowListSlot?: ReactNode;
	disabled?: boolean;
	filter?: (item: TItem, query: string) => boolean;
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
const POPUP_BASE_CLASSES = cn(
	"t-dropdown relative z-popover flex flex-col overflow-hidden rounded-xl p-0",
	"max-w-[calc(100vw-32px)]",
	"bg-gradient-to-b from-surface-3/95 to-surface-2/98",
	"shadow-model-picker-popup ring-1 ring-overlay-foreground/[0.08] ring-inset",
	"backdrop-blur-md backdrop-saturate-150",
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
	selectedItemKey,
	sidebarSlot,
	trigger,
	value,
}: ModelPickerProps<TItem, TValue>) {
	const [internalOpen, setInternalOpen] = useState(false);
	const [internalSearch, setInternalSearch] = useState("");
	const [popupSide, setPopupSide] = useState<"top" | "bottom">("bottom");
	const triggerWrapperRef = useRef<HTMLDivElement>(null);
	const popupNodeRef = useRef<HTMLElement | null>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);

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
	const popupOrigin = popupSide === "top" ? "bottom-left" : "top-left";
	const popupStateClass =
		!inline && !effectiveOpen ? "is-closing" : effectiveOpen ? "is-open" : "";
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
	}, [effectiveOpen]);

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
	}, [effectiveOpen, hasRenderedCollection, inline]);

	const renderCollection = inline || hasRenderedCollection;

	useScrollSelectedIntoView(popupNodeRef, {
		effectiveOpen,
		renderCollection,
		selectedItemKey,
	});

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

	const panelBody = (
		<ModelPickerPanelBody
			activeFiltersSlot={activeFiltersSlot}
			effectiveSearch={effectiveSearch}
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
	);

	return (
		<div className="flex flex-col gap-2" data-slot="model-picker">
			<Combobox.Root
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
