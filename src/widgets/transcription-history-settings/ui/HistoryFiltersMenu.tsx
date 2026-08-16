import { Button as BaseButton } from "@base-ui/react/button";
import {
	Calendar03Icon,
	FilterIcon,
	Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import type { DateRange } from "@/shared/ui/calendar-heatmap";
import { NavList, NavPopover, NavRow } from "@/shared/ui/nav-popover";
import type { HistoryKind, HistoryKindOption } from "../lib/history-kinds";
import type { TranscriptionHistoryEntry } from "../model/history-store";
import { ActivityHeatmap } from "./ActivityHeatmap";

interface HistoryFiltersMenuProps {
	entries: TranscriptionHistoryEntry[];
	historyKind: HistoryKind;
	historyKindOptions: HistoryKindOption[];
	onHistoryKindChange: (kind: HistoryKind) => void;
	onRangeChange: (range: DateRange | null) => void;
	selectedRange: DateRange | null;
}

function formatShortDate(date: Date): string {
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}

function KindView({
	onChange,
	options,
	value,
}: {
	onChange: (kind: HistoryKind) => void;
	options: HistoryKindOption[];
	value: HistoryKind;
}) {
	const t = useTranslations("history");
	return (
		<div className="flex flex-col gap-0.5 p-1 pt-0" data-nav-initial-focus>
			<p className="px-1.5 pb-1 text-[11px] text-foreground-muted leading-snug">
				{t("filterKindHint")}
			</p>
			{options.map((option) => {
				const isSelected = option.id === value;
				return (
					<BaseButton
						aria-pressed={isSelected}
						className={cn(
							"flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-body-sm outline-none transition-colors",
							"hover:bg-foreground/[0.045] focus-visible:ring-2 focus-visible:ring-accent",
							isSelected && "bg-accent/10 text-accent",
						)}
						key={option.id}
						onClick={() => onChange(option.id)}
						type="button"
					>
						<span className="min-w-0 flex-1 truncate">{option.label}</span>
						<span className="shrink-0 text-[10px] text-foreground-muted tabular-nums">
							{option.count}
						</span>
						{isSelected ? (
							<HugeiconsIcon
								aria-hidden="true"
								className="size-3.5 shrink-0"
								icon={Tick01Icon}
							/>
						) : null}
					</BaseButton>
				);
			})}
		</div>
	);
}

/**
 * The History tab's scope control: date range and history kind behind one
 * drill-down popover in the dashboard header.
 *
 * The two used to sit in different sections — the calendar in a 576px popover
 * up here, the kind in a `Select` down in the table header — even though both
 * narrow the same data. The trigger still spells out the active range rather
 * than hiding it behind a count, because every section below is scoped by it
 * and a filtered dashboard must never look like an unfiltered one.
 */
export function HistoryFiltersMenu({
	entries,
	historyKind,
	historyKindOptions,
	onHistoryKindChange,
	onRangeChange,
	selectedRange,
}: HistoryFiltersMenuProps) {
	const t = useTranslations("history");
	const from = selectedRange?.from ?? null;
	const to = selectedRange?.to ?? null;
	const rangeActive = from !== null && to !== null;
	const kindActive = historyKind !== "all";
	const rangeLabel =
		rangeActive && from && to
			? `${formatShortDate(from)} – ${formatShortDate(to)}`
			: t("filterAllTime");
	const activeKindLabel =
		historyKindOptions.find((option) => option.id === historyKind)?.label ?? "";

	return (
		<NavPopover
			dataSlot="history-filters-menu-content"
			renderRoot={(push) => (
				<NavList ariaLabel={t("filterHistory")}>
					<NavRow
						icon={Calendar03Icon}
						label={t("filterDateRange")}
						onOpen={push}
						value={rangeLabel}
						viewId="range"
					/>
					<NavRow
						icon={FilterIcon}
						label={t("filterKind")}
						onOpen={push}
						value={activeKindLabel}
						viewId="kind"
					/>
				</NavList>
			)}
			rootTitle={t("filterHistory")}
			rootTrailing={
				rangeActive || kindActive ? (
					<BaseButton
						className="rounded-sm text-[11px] text-foreground-secondary outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-accent"
						onClick={() => {
							onRangeChange(null);
							onHistoryKindChange("all");
						}}
						type="button"
					>
						{t("heatmapClearRange")}
					</BaseButton>
				) : null
			}
			trigger={(props) => (
				<button
					{...props}
					aria-label={t("filterHistory")}
					// Plain string concat, NOT cn(): twMerge misreads the custom
					// `text-xs-tight` font-size token as a text-color and drops it when
					// a real color class is merged in.
					className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium text-xs-tight transition-colors ${
						rangeActive || kindActive
							? "bg-activity/15 text-foreground"
							: "bg-surface-elevated text-foreground-secondary hover:text-foreground"
					}`}
					type="button"
				>
					<HugeiconsIcon icon={Calendar03Icon} size={14} />
					{rangeLabel}
					{kindActive ? (
						<span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent">
							{activeKindLabel}
						</span>
					) : null}
				</button>
			)}
			views={[
				{
					id: "range",
					render: () => (
						<div className="p-2 pt-0" data-nav-initial-focus>
							<ActivityHeatmap
								entries={entries}
								onRangeChange={onRangeChange}
								selectedRange={selectedRange}
							/>
						</div>
					),
					title: t("filterDateRange"),
					widthPx: 576,
				},
				{
					id: "kind",
					render: () => (
						<KindView
							onChange={onHistoryKindChange}
							options={historyKindOptions}
							value={historyKind}
						/>
					),
					title: t("filterKind"),
					widthPx: 280,
				},
			]}
			widthPx={300}
		/>
	);
}
