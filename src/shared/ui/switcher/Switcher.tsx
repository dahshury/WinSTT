import { ToggleGroup } from "@base-ui/react/toggle-group";
import {
	AnimatePresence,
	domAnimation,
	LazyMotion,
	m as motion,
} from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { springs } from "@/shared/lib/springs";
import { surfaceBg, surfaceShadow, useSurface } from "@/shared/lib/surface";
import { SwitcherBadge } from "./SwitcherBadge";
import { SwitcherOptionToggle } from "./SwitcherOptionToggle";
import type { SwitcherOption } from "./switcher-option";

export type { SwitcherOption } from "./switcher-option";

export interface SwitcherProps<T extends string = string> {
	/** Render options as an N-column grid instead of a single row. The active /
	 *  hover / focus indicator already animates from measured rects, so it tracks
	 *  cells in 2-D for free — giving a compact 2×2 (etc.) segmented control for
	 *  tight surfaces like the tray menu. Implies a full-width grid. */
	columns?: number;
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

function rectFromElement(
	el: HTMLElement,
	containerRect: DOMRect,
	scaleX: number,
	scaleY: number,
): SegmentRect {
	const r = el.getBoundingClientRect();
	// `getBoundingClientRect` reports post-transform (visual) geometry, but the
	// absolute indicator is positioned in the container's *untransformed* layout
	// space. When an ancestor is scaled — e.g. the modal open animation
	// (`scale(0.96)`→`scale(1)`, see `--modal-scale` in globals.css) — the visual
	// offsets are compressed by that scale, so an indicator placed at the raw
	// offset would only travel `scale×` of the real range (fine on the first
	// option at left≈0, increasingly short on later ones). A transform change
	// never fires ResizeObserver, so we can't rely on a post-animation re-measure;
	// instead we divide every offset by the *live* ancestor scale here, recovering
	// layout-space coordinates that track each option exactly at any frame.
	return {
		top: (r.top - containerRect.top) / scaleY,
		left: (r.left - containerRect.left) / scaleX,
		width: r.width / scaleX,
		height: r.height / scaleY,
	};
}

function rectsEqual(
	a: Record<number, SegmentRect>,
	b: Record<number, SegmentRect>,
): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) {
		return false;
	}
	for (const k of aKeys) {
		// Object.keys() stringifies the numeric record keys; parse back to index.
		const idx = Number(k);
		const ra = a[idx];
		const rb = b[idx];
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
	columns,
}: SwitcherProps<T>) {
	// Grid mode: lay the options out in `columns` equal tracks instead of a single
	// row. Static class names (not an interpolated `grid-cols-${n}`) so Tailwind's
	// scanner keeps them.
	const isGrid = columns != null && columns > 1;
	const gridColsClass =
		columns === 4
			? "grid-cols-4"
			: columns === 3
				? "grid-cols-3"
				: "grid-cols-2";
	const layoutClass = isGrid
		? cn("grid w-full", gridColsClass)
		: fullWidth
			? "flex w-full"
			: "inline-flex";
	// The active-segment indicator pops two surface levels above the
	// substrate (matches the CheckboxGroup and Slider value bar). Hover uses the
	// intermediate level, so every selector shares the same rest -> hover ->
	// selected ladder no matter which settings surface it sits on.
	const substrate = useSurface();
	const hoverLevel = Math.min(substrate + 1, 8);
	const indicatorLevel = Math.min(substrate + 2, 8);
	const hoverBgClass = surfaceBg(hoverLevel);
	const indicatorBgClass = surfaceBg(indicatorLevel);
	const indicatorShadowClass = surfaceShadow(indicatorLevel);

	const containerRef = useRef<HTMLDivElement | null>(null);
	const [rects, setRects] = useState<Record<number, SegmentRect>>({});
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

	const selectedIndex = options.findIndex((o) => o.value === value);
	const selectedOption =
		selectedIndex >= 0 ? options[selectedIndex] : undefined;

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
		const items = Array.from(
			container.querySelectorAll<HTMLElement>("[data-switcher-index]"),
		);
		const measure = () => {
			const containerRect = container.getBoundingClientRect();
			// Cumulative ancestor scale = visual size (rect) ÷ layout size (offset).
			// 1 when untransformed; <1 mid modal-open animation. Guard the hidden
			// (offset 0) case so we never divide by zero.
			const scaleX = container.offsetWidth
				? containerRect.width / container.offsetWidth
				: 1;
			const scaleY = container.offsetHeight
				? containerRect.height / container.offsetHeight
				: 1;
			const next: Record<number, SegmentRect> = {};
			for (const el of items) {
				const idx = Number(el.dataset["switcherIndex"]);
				if (!Number.isNaN(idx)) {
					next[idx] = rectFromElement(el, containerRect, scaleX, scaleY);
				}
			}
			setRects((prev) => (rectsEqual(prev, next) ? prev : next));
		};
		// react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- not a prop→state mirror: this measures live DOM geometry (segment rects) which can't be derived during render; `optionsKey` is the re-measure cache key, not a value being copied into state
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
				className={cn("relative isolate select-none", layoutClass)}
				onValueChange={(groupValue) => {
					const next = groupValue[0] as T | undefined;
					if (next != null) {
						onChange(next);
					}
				}}
				ref={containerRef}
				value={[value]}
			>
				{/* Hairline separators between adjacent options (segmented-control
				    look). Rendered beneath the indicator pill — the opaque selected
				    pill covers the dividers touching it, so only the gaps between
				    unselected options show, matching a native segmented control. */}
				{options.map((opt, index) => {
					if (
						isGrid ||
						index === 0 ||
						index === selectedIndex ||
						index - 1 === selectedIndex
					) {
						return null;
					}
					const r = rects[index];
					if (!r) {
						return null;
					}
					return (
						<span
							aria-hidden="true"
							className="pointer-events-none absolute w-px bg-[var(--color-divider-strong)]"
							key={`sep-${opt.value}`}
							style={{
								left: r.left,
								top: r.top + 6,
								height: Math.max(r.height - 12, 0),
							}}
						/>
					);
				})}
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
								"pointer-events-none absolute rounded-sm ring-1 ring-divider-strong ring-inset",
								indicatorShadowClass,
								usesColor ? null : indicatorBgClass,
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
							className={cn(
								"pointer-events-none absolute rounded-sm ring-1 ring-divider ring-inset",
								hoverBgClass,
							)}
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
						grid={isGrid}
						isHovered={hoveredIndex === index && !opt.disabled}
						isSelected={opt.value === value}
						key={opt.value}
						onBlur={(e) => {
							const nextTarget = e.relatedTarget as Node | null;
							if (nextTarget && containerRef.current?.contains(nextTarget)) {
								return;
							}
							setFocusedIndex(null);
							setHoveredIndex((current) =>
								current === index ? null : current,
							);
						}}
						onFocus={(e) => {
							setHoveredIndex(index);
							setFocusedIndex(
								e.currentTarget.matches(":focus-visible") ? index : null,
							);
						}}
						onMouseEnter={() => {
							if (!opt.disabled) {
								setHoveredIndex(index);
							}
						}}
						onMouseLeave={() => {
							setHoveredIndex((current) =>
								current === index ? null : current,
							);
						}}
						option={opt}
					/>
				))}

				{options.map((opt, index) => {
					const rect = rects[index];
					if (!(opt.badgeIcon && rect)) {
						return null;
					}
					return (
						<SwitcherBadge
							key={`${opt.value}-badge`}
							option={opt}
							rect={rect}
						/>
					);
				})}
			</ToggleGroup>
		</LazyMotion>
	);
}
