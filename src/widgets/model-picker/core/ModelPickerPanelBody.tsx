"use client";

import { Combobox } from "@base-ui/react/combobox";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode, RefObject } from "react";
import { cn } from "@/shared/lib/cn";
import { PulseDot } from "@/shared/ui/pulse-dot";

const SEARCH_INPUT_CLASSES = cn(
	"h-11 flex-1 bg-transparent px-3",
	"font-inherit text-body text-foreground leading-normal outline-none",
	"transition-colors duration-150 ease-out",
	"placeholder:text-foreground-muted",
	"focus-visible:text-foreground",
);
const SEARCH_SHELL_CLASSES = cn(
	"relative flex min-h-12 w-full items-center border-divider border-b bg-surface-1/72 px-2",
	"shadow-model-picker-search",
	"transition-[background-color,box-shadow] duration-150 ease-out",
	"hover:bg-surface-1/86",
	"focus-within:bg-surface-2/72 focus-within:shadow-model-picker-search-focus",
);
const SEARCH_ICON_BUTTON_CLASSES = cn(
	"inline-flex size-7 shrink-0 items-center justify-center rounded-md",
	"bg-foreground/[0.055] text-foreground-secondary outline-none transition-colors",
	"hover:bg-foreground/[0.09] hover:text-foreground",
	"focus-visible:ring-2 focus-visible:ring-accent/50",
);

export interface ModelPickerPanelBodyProps {
	activeFiltersSlot?: ReactNode;
	effectiveSearch: string;
	filtersMenuSlot?: ReactNode;
	isLoading: boolean;
	list: ReactNode;
	onClearSearch: () => void;
	renderCollection: boolean;
	renderPanelControls: boolean;
	searchInputRef: RefObject<HTMLInputElement | null>;
	searchPlaceholder: string;
	sidebarSlot?: ReactNode;
}

export function ModelPickerPanelBody({
	activeFiltersSlot,
	effectiveSearch,
	filtersMenuSlot,
	isLoading,
	list,
	onClearSearch,
	renderCollection,
	renderPanelControls,
	searchInputRef,
	searchPlaceholder,
	sidebarSlot,
}: ModelPickerPanelBodyProps) {
	return (
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
							onClick={onClearSearch}
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
}
