/**
 * Minimal, dependency-free `Calendar` for the vendored DiceUI grid.
 *
 * Upstream uses shadcn's react-day-picker calendar; WinSTT avoids that (and
 * date-fns) for a small single/range month picker covering the only callers
 * (the `date` cell variant and the filter menu's date operators). `captionLayout`
 * / `autoFocus` are accepted for API parity.
 */
import { useState } from "react";
import { cn } from "@/shared/lib/cn";
import { ChevronDown, ChevronUp } from "./icons";

export interface DateRange {
	from?: Date | undefined;
	to?: Date | undefined;
}

export interface CalendarProps {
	autoFocus?: boolean;
	captionLayout?: string;
	className?: string;
	defaultMonth?: Date;
	mode?: "single" | "range";
	// Method syntax (bivariant) so single-mode `(Date|undefined)` and range-mode
	// `(DateRange|undefined)` handlers both assign without variance errors.
	onSelect?(value: Date | DateRange | undefined): void;
	selected?: Date | DateRange | undefined;
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function startOfMonth(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, delta: number): Date {
	return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function isSameDay(a: Date | undefined, b: Date | undefined): boolean {
	return (
		!!a &&
		!!b &&
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

function asRange(value: CalendarProps["selected"]): DateRange | undefined {
	if (!value || value instanceof Date) return undefined;
	return value;
}

export function Calendar({
	className,
	defaultMonth,
	mode = "single",
	onSelect,
	selected,
}: CalendarProps) {
	const initial =
		defaultMonth ??
		(selected instanceof Date ? selected : asRange(selected)?.from) ??
		new Date();
	const [month, setMonth] = useState<Date>(() => startOfMonth(initial));

	const firstWeekday = month.getDay();
	const daysInMonth = new Date(
		month.getFullYear(),
		month.getMonth() + 1,
		0,
	).getDate();
	const cells: Array<Date | null> = [
		...Array.from<unknown, null>({ length: firstWeekday }, () => null),
		...Array.from(
			{ length: daysInMonth },
			(_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1),
		),
	];

	function isSelected(day: Date): boolean {
		if (mode === "single") return isSameDay(day, selected as Date | undefined);
		const range = asRange(selected);
		if (!range) return false;
		return isSameDay(day, range.from) || isSameDay(day, range.to);
	}

	function isInRange(day: Date): boolean {
		if (mode !== "range") return false;
		const range = asRange(selected);
		if (!range?.from || !range?.to) return false;
		return day > range.from && day < range.to;
	}

	function onDayClick(day: Date): void {
		if (mode === "single") {
			onSelect?.(day);
			return;
		}
		const range = asRange(selected);
		if (!range?.from || (range.from && range.to)) {
			onSelect?.({ from: day, to: undefined });
			return;
		}
		onSelect?.(
			day < range.from
				? { from: day, to: range.from }
				: { from: range.from, to: day },
		);
	}

	const monthLabel = month.toLocaleDateString(undefined, {
		month: "long",
		year: "numeric",
	});

	return (
		<div className={cn("w-[15rem] select-none p-2", className)}>
			<div className="flex items-center justify-between px-1 pb-2">
				<button
					aria-label="Previous month"
					className="flex size-7 items-center justify-center rounded-md text-foreground-secondary hover:bg-surface-hover"
					onClick={() => setMonth((m) => addMonths(m, -1))}
					type="button"
				>
					<ChevronUp className="-rotate-90 size-4" />
				</button>
				<span className="font-medium text-body text-foreground">
					{monthLabel}
				</span>
				<button
					aria-label="Next month"
					className="flex size-7 items-center justify-center rounded-md text-foreground-secondary hover:bg-surface-hover"
					onClick={() => setMonth((m) => addMonths(m, 1))}
					type="button"
				>
					<ChevronDown className="-rotate-90 size-4" />
				</button>
			</div>
			<div className="grid grid-cols-7 gap-0.5">
				{WEEKDAYS.map((day) => (
					<div
						className="flex h-7 items-center justify-center text-2xs text-foreground-muted"
						key={day}
					>
						{day}
					</div>
				))}
				{cells.map((day, index) =>
					day ? (
						<button
							className={cn(
								"flex h-7 items-center justify-center rounded-md text-body transition-colors",
								isSelected(day)
									? "bg-accent text-foreground"
									: isInRange(day)
										? "bg-accent/20 text-foreground"
										: "text-foreground-secondary hover:bg-surface-hover",
							)}
							key={day.toISOString()}
							onClick={() => onDayClick(day)}
							type="button"
						>
							{day.getDate()}
						</button>
					) : (
						// biome-ignore lint/suspicious/noArrayIndexKey: blank leading cells have no stable id
						<div className="h-7" key={`blank-${index}`} />
					),
				)}
			</div>
		</div>
	);
}
