"use client";

import { Combobox } from "@base-ui/react/combobox";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import { PulseDot } from "@/shared/ui/pulse-dot";
import { scrollModelItemIntoView } from "./model-picker-scroll";

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
	"transition-[background-color,box-shadow] duration-150 ease-out",
	"hover:bg-[var(--color-surface-1)]/86",
	"focus-within:bg-[var(--color-surface-2)]/72 focus-within:shadow-[inset_0_-1px_0_0_rgba(255,255,255,0.055)]",
);
const SEARCH_ICON_BUTTON_CLASSES = cn(
	"inline-flex size-7 shrink-0 items-center justify-center rounded-md",
	"bg-foreground/[0.055] text-foreground-secondary outline-none transition-colors",
	"hover:bg-foreground/[0.09] hover:text-foreground",
	"focus-visible:ring-2 focus-visible:ring-accent/50",
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

	const renderCollection = inline || effectiveOpen;

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
		<>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-5 top-0 z-raised h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent"
			/>
			<div className="flex flex-col">
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
						ref={searchInputRef}
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
					{renderPanelControls && filtersMenuSlot ? (
						<div className={SEARCH_ICON_BUTTON_CLASSES}>{filtersMenuSlot}</div>
					) : renderPanelControls && effectiveSearch.trim() !== "" ? (
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
				{renderPanelControls && activeFiltersSlot ? (
					<div className="border-divider border-b bg-[var(--color-surface-1)]/42 px-2.5 py-2">
						{activeFiltersSlot}
					</div>
				) : null}
			</div>
			<div className="flex min-h-0 min-w-0 flex-1">
				{renderCollection ? sidebarSlot : null}
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
