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
	return (
		<span className={cn("inline-flex flex-wrap items-baseline", className)}>
			{parts.map((part, index) => {
				return NUMERIC_SEGMENT_ONLY_RE.test(part) ? (
					<AnimatedNumber key={`${index}-${part}`} value={part} />
				) : (
					<span key={`${index}-${part}`}>{part}</span>
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
