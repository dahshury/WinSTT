"use client";

import { Checkbox } from "@base-ui/react/checkbox";
import { AnimatePresence, domAnimation, LazyMotion, m as motion } from "motion/react";
import {
	createContext,
	type HTMLAttributes,
	type ReactNode,
	type Ref,
	use,
	useEffect,
	useRef,
	useState,
} from "react";
import { cn } from "@/shared/lib/cn";
import { fontWeights } from "@/shared/lib/font-weight";
import { springs } from "@/shared/lib/springs";
import { useProximityHover } from "@/shared/lib/use-proximity-hover";

interface CheckboxGroupContextValue {
	activeIndex: number | null;
	registerItem: (index: number, element: HTMLElement | null) => void;
}

const CheckboxGroupContext = createContext<CheckboxGroupContextValue | null>(null);

function useCheckboxGroupCtx(): CheckboxGroupContextValue {
	const ctx = use(CheckboxGroupContext);
	if (!ctx) {
		throw new Error("CheckboxItem must be rendered within a CheckboxGroup");
	}
	return ctx;
}

export interface CheckboxGroupProps extends HTMLAttributes<HTMLDivElement> {
	checkedIndices: Set<number>;
	children: ReactNode;
	ref?: Ref<HTMLDivElement>;
}

interface CheckedRun {
	end: number;
	id: number;
	start: number;
}

/** Group checked indices into contiguous runs so adjacent selections merge into one bg. */
function groupContiguous(
	checkedIndices: ReadonlySet<number>,
	prevGroupMap: Map<number, number>,
	nextId: () => number
): { groups: CheckedRun[]; nextGroupMap: Map<number, number> } {
	const sorted = [...checkedIndices].toSorted((a, b) => a - b);
	const runs: Array<{ end: number; start: number }> = [];
	for (const idx of sorted) {
		const last = runs.at(-1);
		if (last && idx === last.end + 1) {
			last.end = idx;
		} else {
			runs.push({ start: idx, end: idx });
		}
	}
	const usedIds = new Set<number>();
	const nextGroupMap = new Map<number, number>();
	const groups: CheckedRun[] = runs.map((run) => {
		let stableId: number | null = null;
		for (let i = run.start; i <= run.end; i++) {
			const prev = prevGroupMap.get(i);
			if (prev !== undefined && !usedIds.has(prev)) {
				stableId = prev;
				break;
			}
		}
		const id = stableId ?? nextId();
		usedIds.add(id);
		for (let i = run.start; i <= run.end; i++) {
			nextGroupMap.set(i, id);
		}
		return { ...run, id };
	});
	return { groups, nextGroupMap };
}

export function CheckboxGroup({
	checkedIndices,
	children,
	className,
	ref,
	...props
}: CheckboxGroupProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const groupIdCounter = useRef(0);
	const prevGroupMap = useRef(new Map<number, number>());

	const {
		activeIndex,
		handlers,
		itemRects,
		measureItems,
		registerItem,
		sessionRef,
		setActiveIndex,
	} = useProximityHover(containerRef);

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when item set changes
	useEffect(() => {
		measureItems();
	}, [children]);

	const { groups: checkedGroups, nextGroupMap } = groupContiguous(
		checkedIndices,
		prevGroupMap.current,
		() => ++groupIdCounter.current
	);
	prevGroupMap.current = nextGroupMap;

	const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
	const activeRect = activeIndex === null ? null : itemRects[activeIndex];
	const focusRect = focusedIndex === null ? null : itemRects[focusedIndex];
	const isHoveringOther = activeIndex !== null && !checkedIndices.has(activeIndex);

	const setRef = (node: HTMLDivElement | null) => {
		containerRef.current = node;
		if (typeof ref === "function") {
			ref(node);
		} else if (ref) {
			(ref as { current: HTMLDivElement | null }).current = node;
		}
	};

	return (
		<CheckboxGroupContext.Provider value={{ registerItem, activeIndex }}>
			<LazyMotion features={domAnimation} strict={true}>
				{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: container hosts mouse tracking for the proximity-hover backgrounds; semantics live on the CheckboxItem children */}
				{/* biome-ignore lint/a11y/useSemanticElements: <fieldset> brings unwanted default styling; role="group" + the CheckboxItem semantics are sufficient here */}
				<div
					className={cn("relative flex select-none flex-col", className)}
					onBlur={(e) => {
						if (containerRef.current?.contains(e.relatedTarget as Node | null)) {
							return;
						}
						setFocusedIndex(null);
						setActiveIndex(null);
					}}
					onFocus={(e) => {
						const indexAttr = (e.target as HTMLElement)
							.closest("[data-proximity-index]")
							?.getAttribute("data-proximity-index");
						if (indexAttr === null || indexAttr === undefined) {
							return;
						}
						const idx = Number(indexAttr);
						setActiveIndex(idx);
						setFocusedIndex((e.target as HTMLElement).matches(":focus-visible") ? idx : null);
					}}
					onKeyDown={(e) => {
						const items = Array.from(
							containerRef.current?.querySelectorAll<HTMLElement>("[data-proximity-index]") ?? []
						);
						const currentIdx = items.indexOf(e.target as HTMLElement);
						if (currentIdx === -1) {
							return;
						}
						if (e.key === "ArrowDown" || e.key === "ArrowUp") {
							e.preventDefault();
							const next =
								e.key === "ArrowDown"
									? (currentIdx + 1) % items.length
									: (currentIdx - 1 + items.length) % items.length;
							items[next]?.focus();
						} else if (e.key === "Home") {
							e.preventDefault();
							items[0]?.focus();
						} else if (e.key === "End") {
							e.preventDefault();
							items.at(-1)?.focus();
						}
					}}
					onMouseEnter={handlers.onMouseEnter}
					onMouseLeave={handlers.onMouseLeave}
					onMouseMove={handlers.onMouseMove}
					ref={setRef}
					role="group"
					{...props}
				>
					<AnimatePresence>
						{checkedGroups.map((group) => {
							const startRect = itemRects[group.start];
							const endRect = itemRects[group.end];
							if (!(startRect && endRect)) {
								return null;
							}
							return (
								<motion.div
									animate={{
										top: startRect.top,
										left: Math.min(startRect.left, endRect.left),
										width: Math.max(startRect.width, endRect.width),
										height: endRect.top + endRect.height - startRect.top,
										opacity: isHoveringOther ? 0.8 : 1,
									}}
									className="pointer-events-none absolute rounded-sm bg-accent/20 ring-1 ring-accent/40 ring-inset"
									exit={{ opacity: 0, transition: { duration: 0.12 } }}
									initial={false}
									key={`group-${group.id}`}
									transition={{ ...springs.moderate, opacity: { duration: 0.08 } }}
								/>
							);
						})}
					</AnimatePresence>

					<AnimatePresence>
						{activeRect ? (
							<motion.div
								animate={{
									top: activeRect.top,
									left: activeRect.left,
									width: activeRect.width,
									height: activeRect.height,
									opacity: 1,
								}}
								className="pointer-events-none absolute rounded-sm bg-foreground/[0.06] ring-1 ring-divider ring-inset"
								exit={{ opacity: 0, transition: { duration: 0.06 } }}
								initial={{
									top: activeRect.top,
									left: activeRect.left,
									width: activeRect.width,
									height: activeRect.height,
									opacity: 0,
								}}
								key={sessionRef.current}
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

					{children}
				</div>
			</LazyMotion>
		</CheckboxGroupContext.Provider>
	);
}

export interface CheckboxItemProps {
	checked: boolean;
	className?: string;
	disabled?: boolean;
	index: number;
	label: string;
	leading?: ReactNode;
	onToggle: () => void;
	ref?: Ref<HTMLDivElement>;
	trailing?: ReactNode;
}

export function CheckboxItem({
	checked,
	className,
	disabled = false,
	index,
	label,
	leading,
	onToggle,
	ref,
	trailing,
}: CheckboxItemProps) {
	const internalRef = useRef<HTMLDivElement | null>(null);
	const hasMounted = useRef(false);
	const { activeIndex, registerItem } = useCheckboxGroupCtx();

	useEffect(() => {
		if (disabled) {
			registerItem(index, null);
			return;
		}
		registerItem(index, internalRef.current);
		return () => registerItem(index, null);
	}, [disabled, index, registerItem]);

	useEffect(() => {
		hasMounted.current = true;
	}, []);

	const isActive = !disabled && activeIndex === index;
	const skipAnimation = !hasMounted.current;

	const setRef = (node: HTMLDivElement | null) => {
		internalRef.current = node;
		if (typeof ref === "function") {
			ref(node);
		} else if (ref) {
			(ref as { current: HTMLDivElement | null }).current = node;
		}
	};

	const handleToggle = () => {
		if (disabled) {
			return;
		}
		onToggle();
	};

	// Stop click/keydown from bubbling to the row so the inner control
	// (e.g. level switcher) owns its own interaction without re-triggering
	// onToggle. Wired via native listeners on the wrapper element so the
	// wrapper stays a non-interactive presentational node.
	const setTrailingRef = (node: HTMLSpanElement) => {
		const stop = (e: Event) => e.stopPropagation();
		node.addEventListener("click", stop);
		node.addEventListener("keydown", stop);
		return () => {
			node.removeEventListener("click", stop);
			node.removeEventListener("keydown", stop);
		};
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: native <input type="checkbox"> can't host the proximity-hover row layout; aria-checked + role lives here, Checkbox.Root provides the form-bound hidden input
		<div
			aria-checked={checked}
			aria-disabled={disabled || undefined}
			aria-label={label}
			className={cn(
				"relative z-raised flex min-w-0 items-center gap-2.5 rounded-sm px-3 py-2 outline-none",
				disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
				className
			)}
			data-proximity-index={disabled ? undefined : index}
			onClick={handleToggle}
			onKeyDown={(e) => {
				if (disabled) {
					return;
				}
				if (e.key === " " || e.key === "Enter") {
					e.preventDefault();
					onToggle();
				}
			}}
			ref={setRef}
			role="checkbox"
			tabIndex={disabled ? -1 : 0}
		>
			<Checkbox.Root
				aria-hidden="true"
				checked={checked}
				className={cn(
					"relative h-[15px] w-[15px] shrink-0 appearance-none border-0 bg-transparent p-0 outline-none",
					disabled ? "cursor-not-allowed" : "cursor-pointer"
				)}
				disabled={disabled}
				onCheckedChange={handleToggle}
				onClick={(e) => e.stopPropagation()}
				tabIndex={-1}
			>
				<span
					className={cn(
						"absolute inset-0 rounded-[5px] border-[1.5px] border-solid shadow-[inset_0_1px_2px_rgb(0_0_0/0.25)] transition-[border-color,background-color,box-shadow] duration-100",
						// Filled accent box with no inner shadow when checked.
						checked && "border-transparent bg-accent shadow-none",
						// Brighter edge on hover/keyboard focus so the unchecked
						// box pops against the bright elevated substrate.
						!checked && isActive && "border-foreground/45 bg-surface-1",
						!(checked || isActive) && "border-foreground/25 bg-surface-1"
					)}
				/>
				<AnimatePresence>
					{checked ? (
						<Checkbox.Indicator keepMounted={true}>
							<motion.svg
								animate={{ opacity: 1 }}
								className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white"
								exit={{ opacity: 1 }}
								fill="none"
								height={14}
								initial={{ opacity: 1 }}
								stroke="currentColor"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2.4}
								viewBox="0 0 24 24"
								width={14}
							>
								<motion.path
									animate={{
										pathLength: 1,
										transition: { duration: 0.12, ease: "easeOut" },
									}}
									d="M6 12L10 16L18 8"
									exit={{
										pathLength: 0,
										transition: { duration: 0.06, ease: "easeIn" },
									}}
									initial={{ pathLength: skipAnimation ? 1 : 0 }}
								/>
							</motion.svg>
						</Checkbox.Indicator>
					) : null}
				</AnimatePresence>
			</Checkbox.Root>

			{leading}

			<span className="grid min-w-0 flex-1 overflow-hidden text-body-sm">
				<span
					aria-hidden="true"
					className="invisible col-start-1 row-start-1 truncate"
					style={{ fontVariationSettings: fontWeights.semibold }}
				>
					{label}
				</span>
				<span
					className={cn(
						"col-start-1 row-start-1 truncate transition-[color,font-variation-settings] duration-100",
						checked || isActive ? "text-foreground" : "text-foreground-muted"
					)}
					style={{
						fontVariationSettings: checked ? fontWeights.semibold : fontWeights.normal,
					}}
				>
					{label}
				</span>
			</span>

			{trailing ? (
				<span className="shrink-0" ref={setTrailingRef}>
					{trailing}
				</span>
			) : null}
		</div>
	);
}
