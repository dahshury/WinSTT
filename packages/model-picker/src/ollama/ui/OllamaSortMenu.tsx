"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import {
	ArrowUpDownIcon,
	Atom01Icon,
	HardDriveIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import { useTranslations } from "use-intl";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import {
	SurfaceProvider,
	surfaceBg,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { FilterMenuTriggerButton } from "../../core/FilterMenuTriggerButton";
import {
	OLLAMA_SORT_CHIP_LABEL,
	OLLAMA_SORT_KEYS,
	type OllamaSortKey,
	type OllamaSortValue,
} from "../lib/sort-state";

export interface OllamaSortMenuProps {
	onSortChange: (next: OllamaSortValue) => void;
	/** Active global sort key, or ``null`` for the default grouped view. */
	sort: OllamaSortValue;
}

/** Icon per sort dimension — kept in the UI layer so {@link OLLAMA_SORT_KEYS}
 *  (the lib) stays presentation-free. */
const SORT_ICON: Record<OllamaSortKey, IconSvgElement> = {
	name: TextFontIcon,
	size: HardDriveIcon,
	params: Atom01Icon,
};

function SortSection({
	value,
	onChange,
}: {
	onChange: (next: OllamaSortValue) => void;
	value: OllamaSortValue;
}) {
	const t = useTranslations("modelPicker");
	// Chips lift relative to the popup substrate (provided below) so each reads
	// as its own minimal surface; the active chip is the single app accent.
	const level = useSurface();
	const idleChip = cn(
		surfaceBg(Math.min(level + 1, 8)),
		surfaceHoverBg(Math.min(level + 2, 8)),
		"text-foreground-secondary ring-divider hover:text-foreground hover:ring-border",
	);
	return (
		<div className="flex flex-col gap-2 p-2">
			<div className="flex items-center gap-1.5">
				<HugeiconsIcon
					className="size-4 shrink-0 text-foreground-muted"
					icon={ArrowUpDownIcon}
				/>
				<span className="font-medium text-body-sm text-foreground">
					{t("sortBy")}
				</span>
			</div>
			<p className="text-[11px] text-foreground-muted leading-snug">
				{t("flattenInstalled")}
			</p>
			<div className="flex flex-wrap gap-1.5">
				{OLLAMA_SORT_KEYS.map((key) => {
					const isOn = value === key;
					return (
						<BaseButton
							className={cn(
								"inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 font-medium text-[11px] leading-none ring-1 transition-colors",
								isOn ? "bg-accent/15 text-accent ring-accent/40" : idleChip,
							)}
							key={key}
							onClick={() => onChange(isOn ? null : key)}
							type="button"
						>
							<HugeiconsIcon
								className="size-3 shrink-0"
								icon={SORT_ICON[key]}
							/>
							{OLLAMA_SORT_CHIP_LABEL[key]}
						</BaseButton>
					);
				})}
			</div>
		</div>
	);
}

/**
 * Sort-only menu for the Ollama picker — a small button that opens a Popover
 * containing just the Sort chips. Models the {@link import("../../stt/ui/SttFiltersMenu").SttFiltersMenu}
 * SortSection + TriggerButton, but the Ollama picker has no filter rows so this
 * is sort-only. The trigger carries a count badge (1 when a sort is active).
 */
export function OllamaSortMenu({ sort, onSortChange }: OllamaSortMenuProps) {
	const t = useTranslations("modelPicker");
	const level = Math.min(useSurface() + 1, 8);
	const count = sort === null ? 0 : 1;

	return (
		<Popover.Root>
			<Popover.Trigger
				nativeButton
				render={(props) => (
					<FilterMenuTriggerButton
						buttonProps={props as ComponentPropsWithoutRef<"button">}
						count={count}
						icon={ArrowUpDownIcon}
						label={t("sort")}
					/>
				)}
			/>
			<Popover.Portal>
				<Popover.Positioner
					align="end"
					sideOffset={6}
					style={{ zIndex: Z_INDEX.popover }}
				>
					<Popover.Popup
						className={cn(
							"select-popup w-[260px] origin-(--transform-origin) overflow-hidden rounded-md border border-border p-1 font-sans text-body text-foreground shadow-md transition-[transform,opacity] duration-150 ease-out data-[ending-style]:ease-in",
							surfaceBg(level),
						)}
						data-slot="ollama-sort-menu-content"
					>
						{/* Re-provide the popup's own surface level downward so the sort
						    chips lift relative to it. */}
						<SurfaceProvider value={level}>
							<div className="flex items-center justify-between px-2 py-1.5">
								<span className="font-semibold text-foreground-muted text-xs-tight uppercase tracking-wide">
									{t("sort")}
								</span>
								{count > 0 ? (
									<BaseButton
										className="text-[11px] text-foreground-secondary hover:text-foreground hover:underline"
										onClick={() => onSortChange(null)}
										type="button"
									>
										{t("clear")}
									</BaseButton>
								) : null}
							</div>
							<SortSection onChange={onSortChange} value={sort} />
						</SurfaceProvider>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
