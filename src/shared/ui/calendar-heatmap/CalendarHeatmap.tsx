import { type CSSProperties, type ReactNode, useReducer } from "react";
import { cn } from "@/shared/lib/cn";
import {
	applyRangeClick,
	buildDateClassMap,
	buildWeightMap,
	categorizeDatesPerVariant,
	headerSegmentsFor,
	isDateValue,
	isRangeValue,
	resolveSelected,
	startOfDay,
} from "./calendar-grid";
import { getCalendarSystem } from "./calendar-system";
import {
	CalendarHeader,
	MonthGrid,
	PickerGrid,
	PresetList,
	TimeFields,
} from "./components";
import { calendarReducer } from "./reducer";
import type {
	CalendarHeatmapProps,
	CalendarPreset,
	DateRange,
	ViewMode,
} from "./types";

export type {
	CalendarHeatmapProps,
	CalendarMode,
	CalendarPreset,
	CalendarPresetGroup,
	DateRange,
	WeightedDateEntry,
} from "./types";

const YEAR_SPAN = 12;

export function CalendarHeatmap({
	className,
	numberOfMonths = 1,
	defaultMonth,
	month,
	onMonthChange,
	showOutsideDays = true,
	weekStartsOn = 0,
	prevMonthLabel = "Previous month",
	nextMonthLabel = "Next month",
	cellSize,
	calendarSystem = "gregorian",
	variantClassnames,
	datesPerVariant,
	weightedDates,
	formatTooltip,
	renderDayBadge,
	disabled,
	fillWidth = false,
	mode = "none",
	selected,
	onSelect,
	presets,
	withTime = false,
}: CalendarHeatmapProps) {
	const system = getCalendarSystem(calendarSystem);
	const classnames = variantClassnames ?? [];
	const resolvedVariants =
		datesPerVariant ??
		categorizeDatesPerVariant(weightedDates ?? [], classnames.length);
	const classMap = buildDateClassMap(classnames, resolvedVariants);
	const weightMap = buildWeightMap(weightedDates);

	const monthCount = Math.max(1, numberOfMonths);
	const [state, dispatch] = useReducer(calendarReducer, undefined, () => {
		const base = system.startOfDisplayMonth(
			month ?? defaultMonth ?? new Date(),
		);
		return {
			anchors: Array.from({ length: monthCount }, (_, i) =>
				system.addMonths(base, i),
			),
			hovered: null,
			internalSelected: null,
			syncedMonthTs: month
				? system.startOfDisplayMonth(month).getTime()
				: undefined,
			viewModes: Array.from({ length: monthCount }, () => "days" as ViewMode),
		};
	});
	const { internalSelected, hovered, anchors, viewModes, syncedMonthTs } =
		state;

	// React-canonical "adjust state when a prop changes" pattern (see
	// https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
	// Compare the incoming controlled `month` timestamp against the one we've
	// already synced to; on mismatch, rebuild anchors AND record the new
	// timestamp in the same dispatch so the next render is steady-state.
	const incomingMonthTs = month
		? system.startOfDisplayMonth(month).getTime()
		: undefined;
	if (incomingMonthTs !== syncedMonthTs) {
		const base = month ? system.startOfDisplayMonth(month) : null;
		const shouldRebuild =
			base !== null && anchors[0]?.getTime() !== base.getTime();
		dispatch({
			type: "monthProp/sync",
			incomingTs: incomingMonthTs,
			anchorsOverride: shouldRebuild
				? Array.from({ length: monthCount }, (_, i) =>
						system.addMonths(base, i),
					)
				: null,
		});
	}

	const currentSelected = resolveSelected(selected, internalSelected);

	const setSelected = (next: Date | DateRange | null) => {
		if (selected === undefined) {
			dispatch({ type: "selected/set", value: next });
		}
		onSelect?.(next);
	};

	const setHovered = (value: Date | null) =>
		dispatch({ type: "hovered/set", value });

	const today = startOfDay(new Date());

	const updateAnchor = (i: number, next: Date) => {
		const start = system.startOfDisplayMonth(next);
		dispatch({ type: "anchors/updateOne", index: i, value: start });
		if (i === 0) {
			onMonthChange?.(start);
		}
	};

	const updateViewMode = (i: number, v: ViewMode) => {
		dispatch({ type: "viewMode/setOne", index: i, value: v });
	};

	const handleDayClick = (date: Date) => {
		if (disabled?.(date)) {
			return;
		}
		if (mode === "single") {
			setSelected(date);
			return;
		}
		if (mode === "range") {
			setSelected(applyRangeClick(currentSelected, date));
		}
	};

	const handlePresetPick = (preset: CalendarPreset) => {
		setSelected({ from: preset.range.from, to: preset.range.to });
		if (preset.range.from) {
			const base = system.startOfDisplayMonth(preset.range.from);
			dispatch({
				type: "anchors/set",
				value: Array.from({ length: monthCount }, (_, i) =>
					system.addMonths(base, i),
				),
			});
			onMonthChange?.(base);
		}
	};

	const stepView = (i: number, dir: -1 | 1) => {
		const vMode = viewModes[i] ?? "days";
		const current = anchors[i] ?? new Date();
		let next: Date;
		if (vMode === "days") {
			next = system.addMonths(current, dir);
		} else if (vMode === "months") {
			next = system.addYears(current, dir);
		} else {
			next = system.addYears(current, dir * YEAR_SPAN);
		}
		updateAnchor(i, next);
	};

	const activePickDate = isDateValue(currentSelected) ? currentSelected : null;

	const handleTimeChange =
		(which: "from" | "to" | "single") => (next: Date) => {
			if (which === "single" && isDateValue(currentSelected)) {
				setSelected(next);
				return;
			}
			if (which !== "single" && isRangeValue(currentSelected)) {
				setSelected({
					from: which === "from" ? next : currentSelected.from,
					to: which === "to" ? next : currentSelected.to,
				});
			}
		};

	const containerStyle: CSSProperties = cellSize
		? ({ "--cell-size": cellSize } as CSSProperties)
		: {};
	const rootClass = cn(
		"flex flex-col gap-4 p-3 [--cell-size:2.25rem]",
		presets ? "sm:flex-row" : "sm:flex-row sm:gap-4",
		fillWidth && "w-full",
		className,
	);

	const renderMonth = (anchorDate: Date, i: number): ReactNode => {
		const vMode = viewModes[i] ?? "days";
		const segments = headerSegmentsFor(vMode, system, anchorDate, (v) =>
			updateViewMode(i, v),
		);

		let monthBody: ReactNode;
		if (vMode === "days") {
			monthBody = (
				<MonthGrid
					classMap={classMap}
					fillWidth={fillWidth}
					formatTooltip={formatTooltip}
					hovered={hovered}
					isDisabled={disabled}
					mode={mode}
					monthDate={anchorDate}
					onDayClick={handleDayClick}
					onDayHover={setHovered}
					renderDayBadge={renderDayBadge}
					selected={currentSelected}
					showOutsideDays={showOutsideDays}
					system={system}
					today={today}
					weekStartsOn={weekStartsOn}
					weightMap={weightMap}
				/>
			);
		} else if (vMode === "months") {
			monthBody = (
				<PickerGrid
					activeDate={activePickDate}
					cells={system.monthsOfYear(anchorDate)}
					onPick={(date) => {
						updateAnchor(i, date);
						updateViewMode(i, "days");
					}}
					today={today}
				/>
			);
		} else {
			monthBody = (
				<PickerGrid
					activeDate={activePickDate}
					cells={system.yearsAround(anchorDate, YEAR_SPAN)}
					onPick={(date) => {
						updateAnchor(i, date);
						updateViewMode(i, "months");
					}}
					today={today}
				/>
			);
		}

		return (
			<div
				className={cn("flex flex-col gap-1", fillWidth && "min-w-0 flex-1")}
				key={anchorDate.getTime()}
			>
				<CalendarHeader
					nextLabel={nextMonthLabel}
					onNext={() => stepView(i, 1)}
					onPrev={() => stepView(i, -1)}
					prevLabel={prevMonthLabel}
					segments={segments}
				/>
				{monthBody}
			</div>
		);
	};

	const monthsBlock = (
		<div className={cn("flex flex-row gap-4", fillWidth && "w-full")}>
			{anchors.map((anchorDate, i) => renderMonth(anchorDate, i))}
		</div>
	);

	const anyPickerOpen = viewModes.some((v) => v !== "days");
	const timeBlock =
		!anyPickerOpen && withTime
			? (
					<TimeFields
						makeHandler={handleTimeChange}
						mode={mode}
						selected={currentSelected}
					/>
				)
			: null;

	return (
		<div className={rootClass} style={containerStyle}>
			{presets && mode === "range" ? (
				<PresetList onPick={handlePresetPick} presets={presets} />
			) : null}
			<div
				className={cn(
					"flex flex-col gap-1",
					fillWidth ? "min-w-0 flex-1" : "min-w-(--cell-size)",
				)}
			>
				{monthsBlock}
				{timeBlock}
			</div>
		</div>
	);
}
