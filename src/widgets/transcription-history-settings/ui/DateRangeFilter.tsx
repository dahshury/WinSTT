import { Button as BaseButton } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import { Calendar03Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceBg, useSurface } from "@/shared/lib/surface";
import type { DateRange } from "@/shared/ui/calendar-heatmap";
import type { TranscriptionHistoryEntry } from "../model/history-store";
import { ActivityHeatmap } from "./ActivityHeatmap";

interface DateRangeFilterProps {
	entries: TranscriptionHistoryEntry[];
	onRangeChange: (range: DateRange | null) => void;
	selectedRange: DateRange | null;
}

function formatShortDate(date: Date): string {
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}

/**
 * The tab-wide date-range filter: a compact header chip that opens the
 * interactive calendar in a popover. Everything from the Overview section down
 * (stats, voice profile, usage, table) follows the picked range; the chip
 * label shows the active range so the filtered state is never invisible, and
 * the × beside it clears without reopening the calendar.
 */
export function DateRangeFilter({
	entries,
	onRangeChange,
	selectedRange,
}: DateRangeFilterProps) {
	const t = useTranslations("history");
	const level = Math.min(useSurface() + 1, 8);
	const from = selectedRange?.from ?? null;
	const to = selectedRange?.to ?? null;
	const active = from !== null && to !== null;
	// Plain string concat, NOT cn(): twMerge misreads the custom `text-xs-tight`
	// font-size token as a text-color and drops it when a real color class is
	// merged in (memory: twmerge-drops-custom-font-size-tokens).
	const triggerClass = `flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium text-xs-tight transition-colors ${
		active
			? "bg-activity/15 text-foreground"
			: "bg-surface-elevated text-foreground-secondary hover:text-foreground"
	}`;

	return (
		<div className="flex items-center gap-1">
			<Popover.Root>
				<Popover.Trigger
					aria-label={t("filterDateRange")}
					className={triggerClass}
				>
					<HugeiconsIcon icon={Calendar03Icon} size={14} />
					{active && from && to
						? `${formatShortDate(from)} – ${formatShortDate(to)}`
						: t("filterAllTime")}
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Positioner
						align="end"
						sideOffset={6}
						style={{ zIndex: Z_INDEX.popover }}
					>
						<Popover.Popup
							className={cn(
								"w-[36rem] max-w-[95vw] origin-(--transform-origin) rounded-md border border-border p-3 shadow-md transition-[transform,opacity] duration-150 ease-out data-[ending-style]:ease-in",
								surfaceBg(level),
							)}
						>
							<SurfaceProvider value={level}>
								<ActivityHeatmap
									entries={entries}
									onRangeChange={onRangeChange}
									selectedRange={selectedRange}
								/>
							</SurfaceProvider>
						</Popover.Popup>
					</Popover.Positioner>
				</Popover.Portal>
			</Popover.Root>
			{active ? (
				<BaseButton
					aria-label={t("heatmapClearRange")}
					className="rounded-md p-1 text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground"
					onClick={() => onRangeChange(null)}
					type="button"
				>
					<HugeiconsIcon icon={Cancel01Icon} size={12} />
				</BaseButton>
			) : null}
		</div>
	);
}
