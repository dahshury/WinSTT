"use client";

import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, domAnimation, LazyMotion, m as motion } from "motion/react";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { fontWeights } from "@/shared/lib/font-weight";
import { springs } from "@/shared/lib/springs";
import { surfaceBg, surfaceShadow, useSurface } from "@/shared/lib/surface";

export interface SwitcherOption<T extends string = string> {
	/** Optional per-option accent color (hex). When set, the active-segment
	 * indicator fills with this color when the option is selected, and the
	 * unselected label is tinted with the same color. */
	color?: string;
	/** When true the option is dimmed and cannot be selected */
	disabled?: boolean;
	/** Optional leading icon shown before the label */
	icon?: IconSvgElement;
	label: string;
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

type SwitcherCssVars = CSSProperties & { "--switcher-color"?: string };

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
	const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
	const [rects, setRects] = useState<Record<number, SegmentRect>>({});
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

	const selectedIndex = options.findIndex((o) => o.value === value);
	const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
	const optionsKey = options.map((o) => o.value).join("|");

	const measure = (): void => {
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const containerRect = container.getBoundingClientRect();
		const next: Record<number, SegmentRect> = {};
		for (const [idx, el] of itemRefs.current.entries()) {
			next[idx] = rectFromElement(el, containerRect);
		}
		setRects(next);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when option set changes
	useLayoutEffect(() => {
		measure();
	}, [optionsKey]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-observe items when option set changes
	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const ro = new ResizeObserver(() => measure());
		ro.observe(container);
		for (const el of itemRefs.current.values()) {
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

	const setItemRef = (index: number) => (node: HTMLButtonElement | null) => {
		if (node) {
			itemRefs.current.set(index, node);
		} else {
			itemRefs.current.delete(index);
		}
	};

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
							style={
								usesColor && selectedOption?.color
									? { backgroundColor: selectedOption.color }
									: undefined
							}
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

				{options.map((opt, index) => {
					const isSelected = opt.value === value;
					const isHovered = hoveredIndex === index && !opt.disabled;
					const colored = opt.color !== undefined;
					const style: SwitcherCssVars | undefined = colored
						? { "--switcher-color": opt.color }
						: undefined;
					const textClass = (() => {
						if (colored && isSelected) {
							return "text-surface-1";
						}
						if (colored) {
							return "text-[var(--switcher-color)]";
						}
						if (isSelected || isHovered) {
							return "text-foreground";
						}
						return "text-foreground-dim";
					})();
					return (
						<Toggle
							className={cn(
								"relative z-raised inline-flex items-center justify-center gap-1.5 bg-transparent px-3 py-1 font-medium text-body-sm outline-none transition-colors focus-visible:outline-none",
								textClass,
								opt.disabled && "cursor-not-allowed opacity-40",
								fullWidth && "flex-1"
							)}
							disabled={opt.disabled}
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
							ref={setItemRef(index)}
							style={style}
							value={opt.value}
						>
							{opt.icon ? (
								<HugeiconsIcon aria-hidden="true" className="shrink-0" icon={opt.icon} size={13} />
							) : null}
							<span className="inline-grid whitespace-nowrap">
								<span
									aria-hidden="true"
									className="invisible col-start-1 row-start-1"
									style={{ fontVariationSettings: fontWeights.semibold }}
								>
									{opt.label}
								</span>
								<span
									className="col-start-1 row-start-1 transition-[font-variation-settings] duration-100"
									style={{
										fontVariationSettings: isSelected ? fontWeights.semibold : fontWeights.normal,
									}}
								>
									{opt.label}
								</span>
							</span>
						</Toggle>
					);
				})}
			</ToggleGroup>
		</LazyMotion>
	);
}
