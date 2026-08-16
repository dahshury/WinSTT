"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { NavList, NavPopover, NavRow } from "@/shared/ui/nav-popover";
import { FilterMenuTriggerButton } from "../core/FilterMenuTriggerButton";

/**
 * One filter dimension: a row on the root list plus the view behind it. Every
 * picker declares its own array of these, which is the whole reason the four
 * menus can share one shell despite having between two and five dimensions.
 */
export interface FilterNavSection {
	/** Count pill on the row — for multi-select dimensions ("3 languages"). */
	badge?: number | undefined;
	icon: IconSvgElement;
	/** Stable id: the view id, and the row focus returns to on the way back. */
	id: string;
	label: string;
	render: () => ReactNode;
	/** Summary chip on the row. Omit when the dimension is untouched. */
	value?: string | null | undefined;
	/** Widen the frame for this view only (long scrolling lists). */
	widthPx?: number | undefined;
}

/**
 * The sort + filter control shared by every model picker: a count-badged
 * trigger opening a drill-down popover whose root lists the filter dimensions
 * with their current values, one row each.
 *
 * The root list exists so the answer to "what is filtering this catalog right
 * now?" is visible without opening anything, and so pickers with nine
 * dimensions (TTS) and two (Ollama) present the same way. Dimension-specific
 * state stays in the caller — this owns only the shell and the two conventions
 * every menu repeated: the trigger badge folds the active sort into the filter
 * count, and "Clear all" is offered whenever anything is clearable.
 */
export function FilterNavMenu({
	activeFilterCount,
	canClear,
	clearLabel,
	dataSlot,
	label,
	onClearAll,
	sections,
	triggerClassName,
	widthPx = 300,
}: {
	activeFilterCount: number;
	canClear: boolean;
	clearLabel: string;
	dataSlot: string;
	label: string;
	onClearAll: () => void;
	sections: readonly FilterNavSection[];
	triggerClassName?: string | undefined;
	widthPx?: number | undefined;
}) {
	return (
		<NavPopover
			dataSlot={dataSlot}
			renderRoot={(push) => (
				<NavList ariaLabel={label}>
					{sections.map((section) => (
						<NavRow
							badge={section.badge}
							icon={section.icon}
							key={section.id}
							label={section.label}
							onOpen={push}
							value={section.value}
							viewId={section.id}
						/>
					))}
				</NavList>
			)}
			rootTitle={label}
			rootTrailing={
				canClear ? (
					<BaseButton
						className="rounded-sm text-[11px] text-foreground-secondary outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-accent"
						onClick={onClearAll}
						type="button"
					>
						{clearLabel}
					</BaseButton>
				) : null
			}
			trigger={(props) => (
				<FilterMenuTriggerButton
					buttonProps={props}
					className={triggerClassName}
					count={activeFilterCount}
					label={label}
				/>
			)}
			views={sections.map((section) => ({
				id: section.id,
				render: section.render,
				title: section.label,
				widthPx: section.widthPx,
			}))}
			widthPx={widthPx}
		/>
	);
}
