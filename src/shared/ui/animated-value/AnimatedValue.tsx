import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";

const TEXT_SWAP_DUR_MS = 150;

function prefersReducedMotion(): boolean {
	return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function AnimatedText({ text, className }: { className?: string; text: string }) {
	const [displayed, setDisplayed] = useState(text);
	const [phase, setPhase] = useState<"" | "exit" | "enter">("");
	const prev = useRef(text);
	const rafRef = useRef<number | null>(null);
	const reduced = prefersReducedMotion();

	useEffect(() => {
		if (reduced || text === prev.current) {
			prev.current = text;
			if (reduced) {
				setDisplayed(text);
			}
			return;
		}
		prev.current = text;
		setPhase("exit");
		const exitTimer = window.setTimeout(() => {
			setDisplayed(text);
			setPhase("enter");
			rafRef.current = requestAnimationFrame(() => {
				rafRef.current = requestAnimationFrame(() => setPhase(""));
			});
		}, TEXT_SWAP_DUR_MS);
		return () => {
			window.clearTimeout(exitTimer);
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
		};
	}, [text, reduced]);

	return (
		<span
			className={cn(
				"t-text-swap",
				phase === "exit" && "is-exit",
				phase === "enter" && "is-enter-start",
				className
			)}
		>
			{reduced ? text : displayed}
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
	const [animating, setAnimating] = useState(true);
	const prev = useRef(text);

	useEffect(() => {
		if (text === prev.current || prefersReducedMotion()) {
			prev.current = text;
			return;
		}
		prev.current = text;
		setAnimating(false);
		const raf = requestAnimationFrame(() => {
			setAnimating(true);
		});
		return () => cancelAnimationFrame(raf);
	}, [text]);

	const chars = useMemo(() => [...text], [text]);
	const firstStaggerIndex = Math.max(chars.length - 2, 0);

	return (
		<span className={cn("inline-flex items-baseline", className)}>
			<span
				aria-hidden="true"
				className={cn("t-digit-group", animating && "is-animating")}
			>
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
	const parts = text.split(NUMERIC_SEGMENT_RE).filter((part) => part.length > 0);
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
