import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export function AnimatedText({
	text,
	className,
}: {
	className?: string;
	text: string;
}) {
	return (
		<span className={cn("t-text-swap", className)} key={text}>
			{text}
		</span>
	);
}

export function AnimatedNumber({
	className,
	value,
}: {
	className?: string;
	value: number | string;
}) {
	const text = String(value);
	const chars = [...text];
	const firstStaggerIndex = Math.max(chars.length - 2, 0);

	return (
		<span className={cn("inline-flex items-baseline", className)} key={text}>
			<span aria-hidden="true" className="t-digit-group is-animating">
				{chars.map((ch, index) => {
					const stagger =
						chars.length > 1 && index >= firstStaggerIndex
							? String(index - firstStaggerIndex + 1)
							: undefined;
					return (
						<span
							className="t-digit"
							data-stagger={stagger}
							key={`${index}-${ch}`}
						>
							{ch}
						</span>
					);
				})}
			</span>
			<span className="sr-only">{text}</span>
		</span>
	);
}

const NUMERIC_SEGMENT_RE = /(\d+(?:[.,]\d+)?%?)/g;
const NUMERIC_SEGMENT_ONLY_RE = /^\d+(?:[.,]\d+)?%?$/;

export function AnimatedValueText({
	className,
	text,
}: {
	className?: string;
	text: string;
}) {
	const parts = text
		.split(NUMERIC_SEGMENT_RE)
		.filter((part) => part.length > 0);
	const hasNumber = parts.some((part) => NUMERIC_SEGMENT_ONLY_RE.test(part));
	if (!hasNumber) {
		const cls = className === undefined ? {} : { className };
		return <AnimatedText {...cls} text={text} />;
	}
	// Precomputed character offset of each segment in the source string — a stable,
	// unique positional identity that survives re-renders without keying on the bare
	// array index (segments can repeat, so content alone isn't unique). Built
	// immutably up front so the map body never mutates a captured variable.
	const charOffsets = parts.reduce<number[]>((acc, _part, i) => {
		acc.push(i === 0 ? 0 : (acc[i - 1] ?? 0) + (parts[i - 1]?.length ?? 0));
		return acc;
	}, []);
	return (
		<span className={cn("inline-flex flex-wrap items-baseline", className)}>
			{parts.map((part, index) => {
				const key = `${charOffsets[index] ?? 0}-${part}`;
				return NUMERIC_SEGMENT_ONLY_RE.test(part) ? (
					<AnimatedNumber key={key} value={part} />
				) : (
					<span key={key}>{part}</span>
				);
			})}
		</span>
	);
}

export function IconSwap({
	a,
	b,
	className,
	state,
}: {
	a: ReactNode;
	b: ReactNode;
	className?: string;
	state: "a" | "b";
}) {
	return (
		<span className={cn("t-icon-swap", className)} data-state={state}>
			<span className="t-icon" data-icon="a">
				{a}
			</span>
			<span className="t-icon" data-icon="b">
				{b}
			</span>
		</span>
	);
}
