import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

const DEFAULT_STAGGER_DURATION_MS = 500;
const DEFAULT_STAGGER_DELAY_MS = 40;
const STAGGER_SETTLE_BUFFER_MS = 50;

function cssDurationToMs(value: string, fallbackMs: number): number {
	const trimmed = value.trim();
	if (!trimmed) {
		return fallbackMs;
	}
	const first = trimmed.split(",")[0]?.trim() ?? "";
	const amount = Number.parseFloat(first);
	if (!Number.isFinite(amount)) {
		return fallbackMs;
	}
	return first.endsWith("ms") ? amount : amount * 1000;
}

function revealDurationMs(element: HTMLElement): number {
	const style = getComputedStyle(element);
	const duration = cssDurationToMs(
		style.getPropertyValue("--stagger-dur"),
		DEFAULT_STAGGER_DURATION_MS,
	);
	const delay = cssDurationToMs(
		style.getPropertyValue("--stagger-stagger"),
		DEFAULT_STAGGER_DELAY_MS,
	);
	return duration + delay + STAGGER_SETTLE_BUFFER_MS;
}

export function StaggerReveal({
	active,
	children,
	className,
	contentClassName,
	onComplete,
}: {
	active: boolean;
	children: ReactNode;
	className?: string;
	contentClassName?: string;
	onComplete?: () => void;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const onCompleteRef = useRef(onComplete);

	useEffect(() => {
		onCompleteRef.current = onComplete;
	}, [onComplete]);

	useEffect(() => {
		if (!active) {
			return;
		}
		const root = rootRef.current;
		if (!root) {
			return;
		}

		let completeTimer = 0;
		root.classList.remove("is-hiding");
		root.classList.remove("is-shown");
		void root.offsetHeight;

		const frame = window.requestAnimationFrame(() => {
			root.classList.add("is-shown");
			completeTimer = window.setTimeout(() => {
				onCompleteRef.current?.();
			}, revealDurationMs(root));
		});

		return () => {
			window.cancelAnimationFrame(frame);
			window.clearTimeout(completeTimer);
		};
	}, [active]);

	return (
		<div
			className={cn(active && "t-stagger", className)}
			data-live-entry-reveal={active ? "" : undefined}
			ref={rootRef}
		>
			<div className={cn(active && "t-stagger-line", contentClassName)}>
				{children}
			</div>
		</div>
	);
}
