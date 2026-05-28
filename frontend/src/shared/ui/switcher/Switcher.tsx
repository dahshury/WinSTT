import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { IconSvgElement } from "@hugeicons/react";
import { AnimatePresence, domAnimation, LazyMotion, m as motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { springs } from "@/shared/lib/springs";
import { surfaceBg, surfaceShadow, useSurface } from "@/shared/lib/surface";
import { SwitcherBadge } from "./SwitcherBadge";
import { SwitcherOptionToggle } from "./SwitcherOptionToggle";

export interface SwitcherOption<T extends string = string> {
	/** Optional small icon rendered as a corner badge over the option (e.g. a
	 * lock icon to mark a tab that's disabled until some prerequisite is met).
	 * Becomes interactive when `badgeTooltip` or `onBadgeClick` is also
	 * provided — the badge floats above the (possibly disabled) Toggle so
	 * hover/click events reach it regardless of the Toggle's disabled state. */
	badgeIcon?: IconSvgElement;
	/** Optional tooltip shown when the badge is hovered/focused — typically
	 * explains why the option is currently disabled. */
	badgeTooltip?: string;
	/** Optional per-option accent color (hex). When set, the active-segment
	 * indicator fills with this color when the option is selected, and the
	 * unselected label is tinted with the same color. */
	color?: string;
	/** When true the option is dimmed and cannot be selected */
	disabled?: boolean;
	/** Optional leading icon shown before the label */
	icon?: IconSvgElement;
	label: string;
	/** Optional click handler invoked when the badge is pressed. Makes the
	 * badge render as a button instead of a presentational span. */
	onBadgeClick?: () => void;
	value: T;
}

export interface SwitcherProps<T extends string = string> {
	/** Stretch the group to fill its container; each option shares space equally */
	fullWidth?: boolean;
	onChange: (value: T) => void;
	options: readonly SwitcherOption<T>[];
	value: T;
}

interface SegmentRect {
	height: number;
	left: number;
	top: number;
	width: number;
}

function rectFromElement(el: HTMLElement, containerRect: DOMRect): SegmentRect {
	const r = el.getBoundingClientRect();
	return {
		top: r.top - containerRect.top,
		left: r.left - containerRect.left,
		width: r.width,
		height: r.height,
	};
}

function rectsEqual(a: Record<number, SegmentRect>, b: Record<number, SegmentRect>): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) {
		return false;
	}
	for (const k of aKeys) {
		const ra = a[k as unknown as number];
		const rb = b[k as unknown as number];
		if (!rb) {
			return false;
		}
		if (
			ra?.top !== rb.top ||
			ra.left !== rb.left ||
			ra.width !== rb.width ||
			ra.height !== rb.height
		) {
			return false;
		}
	}
	return true;
}

export function Switcher<T extends string = string>({
	options,
	value,
	onChange,
	fullWidth,
}: SwitcherProps<T>) {
	// The active-segment indicator pops three surface levels above the
	// substrate (matches the CheckboxGroup pop). On a substrate-3 panel that
	// lands on surface-6; inside a deeper dialog it lifts further so the pill
	// reads as elevated no matter where the Switcher is mounted.
	const substrate = useSurface();
	const indicatorLevel = Math.min(substrate + 3, 8);
	const indicatorBgClass = surfaceBg(indicatorLevel);
	const indicatorShadowClass = surfaceShadow(indicatorLevel);

	const containerRef = useRef<HTMLDivElement | null>(null);
	const [rects, setRects] = useState<Record<number, SegmentRect>>({});
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

	const selectedIndex = options.findIndex((o) => o.value === value);
	const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;

	// One-shot key that changes only when the option set changes — drives the
	// observer setup + initial measurement below.
	const optionsKey = options.map((o) => o.value).join("|");

	// Single ResizeObserver per option-set change. Items are discovered via
	// `[data-switcher-index]` (stamped by `SwitcherOptionToggle`) so we never
	// touch React's callback-ref machinery for the per-option buttons. That
	// avoids the failure mode the prior design had: inline callback refs
	// created a new identity per render, so React called cleanup+setup on
	// EVERY render, which re-created the ResizeObserver, which fired measure,
	// which called setRects with a new object reference, which scheduled
	// another render — a tight microtask cycle that hung the settings window
	// on the first extra interaction. setRects also short-circuits when the
	// next rect map is value-equal so an idle resize tick can't trigger a
	// no-op re-render.
	// biome-ignore lint/correctness/useExhaustiveDependencies: optionsKey is the intentional cache key — biome can't see that the queried `[data-switcher-index]` items change when options change, so it thinks the dep is unused; removing it would leave the observer stuck on the original option set
	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const items = Array.from(container.querySelectorAll<HTMLElement>("[data-switcher-index]"));
		const measure = () => {
			const containerRect = container.getBoundingClientRect();
			const next: Record<number, SegmentRect> = {};
			for (const el of items) {
				const idx = Number(el.dataset.switcherIndex);
				if (!Number.isNaN(idx)) {
					next[idx] = rectFromElement(el, containerRect);
				}
			}
			setRects((prev) => (rectsEqual(prev, next) ? prev : next));
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(container);
		for (const el of items) {
			ro.observe(el);
		}
		return () => ro.disconnect();
	}, [optionsKey]);

	const selectedRect = selectedIndex >= 0 ? rects[selectedIndex] : undefined;
	const hoverRect = hoveredIndex === null ? undefined : rects[hoveredIndex];
	const focusRect = focusedIndex === null ? undefined : rects[focusedIndex];
	const isHoveringSelected = hoveredIndex === selectedIndex;
	const isHoveringOther = hoveredIndex !== null && !isHoveringSelected;
	const usesColor = selectedOption?.color !== undefined;

	return (
		<LazyMotion features={domAnimation} strict={true}>
			<ToggleGroup
				className={cn("relative isolate select-none", fullWidth ? "flex w-full" : "inline-flex")}
				onValueChange={(groupValue) => {
					const next = groupValue[0] as T | undefined;
					if (next != null) {
						onChange(next);
					}
				}}
				ref={containerRef}
				value={[value]}
			>
				<AnimatePresence>
					{selectedRect ? (
						<motion.div
							animate={{
								left: selectedRect.left,
								top: selectedRect.top,
								width: selectedRect.width,
								height: selectedRect.height,
								opacity: isHoveringOther ? 0.85 : 1,
							}}
							className={cn(
								"pointer-events-none absolute rounded-sm",
								indicatorShadowClass,
								usesColor ? null : indicatorBgClass
							)}
							initial={false}
							key="active-indicator"
							{...(usesColor && selectedOption?.color
								? { style: { backgroundColor: selectedOption.color } }
								: {})}
							transition={{ ...springs.moderate, opacity: { duration: 0.08 } }}
						/>
					) : null}
				</AnimatePresence>

				<AnimatePresence>
					{hoverRect && !isHoveringSelected ? (
						<motion.div
							animate={{
								left: hoverRect.left,
								top: hoverRect.top,
								width: hoverRect.width,
								height: hoverRect.height,
								opacity: 0.5,
							}}
							className="pointer-events-none absolute rounded-sm bg-foreground/[0.06]"
							exit={{ opacity: 0, transition: { duration: 0.08 } }}
							initial={{
								left: hoverRect.left,
								top: hoverRect.top,
								width: hoverRect.width,
								height: hoverRect.height,
								opacity: 0,
							}}
							transition={{ ...springs.fast, opacity: { duration: 0.08 } }}
						/>
					) : null}
				</AnimatePresence>

				<AnimatePresence>
					{focusRect ? (
						<motion.div
							animate={{
								left: focusRect.left - 2,
								top: focusRect.top - 2,
								width: focusRect.width + 4,
								height: focusRect.height + 4,
							}}
							className="pointer-events-none absolute z-overlay rounded-sm border border-accent"
							exit={{ opacity: 0, transition: { duration: 0.06 } }}
							initial={false}
							transition={{ ...springs.fast, opacity: { duration: 0.08 } }}
						/>
					) : null}
				</AnimatePresence>

				{options.map((opt, index) => (
					<SwitcherOptionToggle
						dataIndex={index}
						fullWidth={fullWidth}
						isHovered={hoveredIndex === index && !opt.disabled}
						isSelected={opt.value === value}
						key={opt.value}
						onBlur={(e) => {
							const nextTarget = e.relatedTarget as Node | null;
							if (nextTarget && containerRef.current?.contains(nextTarget)) {
								return;
							}
							setFocusedIndex(null);
							setHoveredIndex((current) => (current === index ? null : current));
						}}
						onFocus={(e) => {
							setHoveredIndex(index);
							setFocusedIndex(e.currentTarget.matches(":focus-visible") ? index : null);
						}}
						onMouseEnter={() => {
							if (!opt.disabled) {
								setHoveredIndex(index);
							}
						}}
						onMouseLeave={() => {
							setHoveredIndex((current) => (current === index ? null : current));
						}}
						option={opt}
					/>
				))}

				{options.map((opt, index) => {
					const rect = rects[index];
					if (!(opt.badgeIcon && rect)) {
						return null;
					}
					return <SwitcherBadge key={`${opt.value}-badge`} option={opt} rect={rect} />;
				})}
			</ToggleGroup>
		</LazyMotion>
	);
}
