import { Checkbox } from "@base-ui/react/checkbox";
import {
	AnimatePresence,
	domAnimation,
	LazyMotion,
	m as motion,
} from "motion/react";
import {
	createContext,
	type HTMLAttributes,
	type PointerEvent as ReactPointerEvent,
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
import {
	SurfaceProvider,
	surfaceBg,
	surfaceShadow,
	useSurface,
} from "@/shared/lib/surface";
import { useProximityHover } from "@/shared/lib/use-proximity-hover";
import { Tooltip } from "@/shared/ui/tooltip";

interface CheckboxGroupContextValue {
	activeIndex: number | null;
	registerItem: (index: number, element: HTMLElement | null) => void;
}

const CheckboxGroupContext = createContext<CheckboxGroupContextValue | null>(
	null,
);

function useCheckboxGroupCtx(): CheckboxGroupContextValue {
	const ctx = use(CheckboxGroupContext);
	if (!ctx) {
		throw new Error("CheckboxItem must be rendered within a CheckboxGroup");
	}
	return ctx;
}

export interface CheckboxGroupProps extends HTMLAttributes<HTMLFieldSetElement> {
	checkedIndices: Set<number>;
	children: ReactNode;
	/** Paint the standalone settings frame (self-elevated bg + p-1.5 gutter +
	 *  ring + shadow) the group used to get from a wrapping `ElevatedSurface`.
	 *  Default OFF — the group stays a transparent fieldset so it sits flush
	 *  inside a popup or another framed surface (language picker, filter menus,
	 *  modifier list). */
	framed?: boolean;
	ref?: Ref<HTMLFieldSetElement>;
}

interface CheckedRun {
	end: number;
	id: number;
	start: number;
}

/** Group checked indices into contiguous runs so adjacent selections merge into one bg. */
function groupContiguous(
	checkedIndices: ReadonlySet<number>,
	prevGroupMap: ReadonlyMap<number, number>,
	startingNextId: number,
): { groups: CheckedRun[]; nextGroupMap: Map<number, number>; nextId: number } {
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
	let nextId = startingNextId;
	const groups: CheckedRun[] = runs.map((run) => {
		let stableId: number | null = null;
		for (let i = run.start; i <= run.end; i++) {
			const prev = prevGroupMap.get(i);
			if (prev !== undefined && !usedIds.has(prev)) {
				stableId = prev;
				break;
			}
		}
		const id = stableId ?? nextId++;
		usedIds.add(id);
		for (let i = run.start; i <= run.end; i++) {
			nextGroupMap.set(i, id);
		}
		return { ...run, id };
	});
	return { groups, nextGroupMap, nextId };
}

function mapsEqual(
	a: ReadonlyMap<number, number>,
	b: ReadonlyMap<number, number>,
): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const [k, v] of a) {
		if (b.get(k) !== v) {
			return false;
		}
	}
	return true;
}

interface GroupingState {
	idCounter: number;
	prevGroupMap: ReadonlyMap<number, number>;
}

const EMPTY_GROUPING_STATE: GroupingState = {
	prevGroupMap: new Map<number, number>(),
	idCounter: 0,
};

export function CheckboxGroup({
	checkedIndices,
	children,
	className,
	framed = false,
	ref,
	...props
}: CheckboxGroupProps) {
	// `framed` self-elevates +1 and paints the standalone container (bg + p-1.5
	// gutter + ring + shadow) — the look a wrapping `ElevatedSurface` used to give
	// in settings panels. Unframed (default) stays a transparent fieldset at the
	// host level so the group sits flush inside a popup / another framed surface.
	const substrate = Math.min(useSurface() + (framed ? 1 : 0), 8);
	const hoverLevel = Math.min(substrate + 1, 8);
	const selectedLevel = Math.min(substrate + 2, 8);
	const containerClass = framed
		? cn(
				"rounded-lg p-1.5 shadow-elevated ring-1 ring-divider",
				surfaceBg(substrate),
			)
		: "p-0";
	const hoverBgClass = surfaceBg(hoverLevel);
	const selectedBgClass = surfaceBg(selectedLevel);
	const selectedShadowClass = surfaceShadow(selectedLevel);
	const containerRef = useRef<HTMLDivElement | null>(null);

	const {
		activeIndex,
		handlers,
		itemRects,
		measureItems,
		registerItem,
		setActiveIndex,
	} = useProximityHover(containerRef);

	// Re-measure on children identity change (rows added/removed).
	useEffect(() => {
		measureItems();
	}, [children, measureItems]);

	// Stable group-id state computed at render time and reconciled via the
	// React-documented "store info from previous renders" pattern: compare the
	// snapshot built this render against the one we stored last render, and
	// call setState during render iff they differ. This avoids the ref
	// read/write-during-render anti-pattern while still keeping AnimatePresence
	// keys stable across re-renders.
	const [groupingState, setGroupingState] =
		useState<GroupingState>(EMPTY_GROUPING_STATE);
	const grouped = groupContiguous(
		checkedIndices,
		groupingState.prevGroupMap,
		groupingState.idCounter,
	);
	const checkedGroups = grouped.groups;
	if (
		!mapsEqual(groupingState.prevGroupMap, grouped.nextGroupMap) ||
		groupingState.idCounter !== grouped.nextId
	) {
		setGroupingState({
			prevGroupMap: grouped.nextGroupMap,
			idCounter: grouped.nextId,
		});
	}

	// `session` is bumped each time the cursor re-enters the container so the
	// active-indicator gets a fresh AnimatePresence key (preventing it from
	// tweening across an unrelated re-entry). Kept as state — not a ref — so
	// the JSX can read it during render without tripping the refs rule.
	const [session, setSession] = useState(0);

	const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
	const activeRect = activeIndex === null ? null : itemRects[activeIndex];
	const focusRect = focusedIndex === null ? null : itemRects[focusedIndex];
	const isHoveringOther =
		activeIndex !== null && !checkedIndices.has(activeIndex);

	const setRef = (node: HTMLDivElement | null) => {
		containerRef.current = node;
	};

	const contextValue: CheckboxGroupContextValue = { registerItem, activeIndex };

	// Semantic grouping (<fieldset>) wraps an inner interactive container
	// (<div>) so the proximity-hover handlers don't sit on the non-interactive
	// fieldset element. The fieldset receives the forwarded ref and ...props
	// since it's the public element; the inner div owns the hover/focus/key
	// behaviour and the ref the proximity hook measures against.
	return (
		<CheckboxGroupContext.Provider value={contextValue}>
			<SurfaceProvider value={substrate}>
				<LazyMotion features={domAnimation} strict={true}>
					<fieldset
						className={cn(
							"relative m-0 select-none border-0",
							containerClass,
							className,
						)}
						ref={ref}
						{...props}
					>
						{/* biome-ignore lint/a11y/noStaticElementInteractions: presentational wrapper for proximity tracking; the parent <fieldset> carries the semantic grouping, the CheckboxItem children carry the interactive semantics */}
						<div
							className="relative flex flex-col"
							onBlur={(e) => {
								if (
									containerRef.current?.contains(e.relatedTarget as Node | null)
								) {
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
								setFocusedIndex(
									(e.target as HTMLElement).matches(":focus-visible")
										? idx
										: null,
								);
							}}
							onKeyDown={(e) => {
								const items = Array.from(
									containerRef.current?.querySelectorAll<HTMLElement>(
										"[data-proximity-index]",
									) ?? [],
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
							onMouseEnter={() => {
								setSession((prev) => prev + 1);
								handlers.onMouseEnter();
							}}
							onMouseLeave={handlers.onMouseLeave}
							onMouseMove={handlers.onMouseMove}
							ref={setRef}
							role="presentation"
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
											className={cn(
												"pointer-events-none absolute rounded-lg ring-1 ring-divider-strong ring-inset",
												selectedBgClass,
												selectedShadowClass,
											)}
											exit={{ opacity: 0, transition: { duration: 0.12 } }}
											initial={false}
											key={`group-${group.id}`}
											transition={{
												...springs.moderate,
												opacity: { duration: 0.08 },
											}}
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
										className={cn(
											"pointer-events-none absolute rounded-lg ring-1 ring-divider ring-inset",
											hoverBgClass,
										)}
										exit={{ opacity: 0, transition: { duration: 0.06 } }}
										initial={{
											top: activeRect.top,
											left: activeRect.left,
											width: activeRect.width,
											height: activeRect.height,
											opacity: 0,
										}}
										key={session}
										transition={{
											...springs.fast,
											opacity: { duration: 0.08 },
										}}
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
										className="pointer-events-none absolute z-overlay rounded-[10px] border border-accent"
										exit={{ opacity: 0, transition: { duration: 0.06 } }}
										initial={false}
										transition={{
											...springs.fast,
											opacity: { duration: 0.08 },
										}}
									/>
								) : null}
							</AnimatePresence>

							{children}
						</div>
					</fieldset>
				</LazyMotion>
			</SurfaceProvider>
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
	/** Rich hover tooltip anchored on the row label (e.g. what a modifier
	 *  does, with an example). */
	tooltip?: ReactNode;
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
	tooltip,
	trailing,
}: CheckboxItemProps) {
	const internalRef = useRef<HTMLDivElement | null>(null);
	const checkboxRef = useRef<HTMLElement | null>(null);
	const { activeIndex, registerItem } = useCheckboxGroupCtx();

	useEffect(() => {
		if (disabled) {
			registerItem(index, null);
			return;
		}
		registerItem(index, internalRef.current);
		return () => registerItem(index, null);
	}, [disabled, index, registerItem]);

	const isActive = !disabled && activeIndex === index;

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

	const handleRowPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		const target = event.target;
		if (target instanceof HTMLInputElement) {
			return;
		}

		event.preventDefault();
		if (disabled) {
			return;
		}

		checkboxRef.current?.focus({ preventScroll: true });
		if (target instanceof HTMLElement && target.closest('[role="checkbox"]')) {
			return;
		}
		onToggle();
	};

	return (
		// Row text clicks focus the visible checkbox without scrolling; direct
		// checkbox clicks still go through Base UI's own controlled path.
		// biome-ignore lint/a11y/noStaticElementInteractions: full-row activation mirrors a native checkbox label; the Base UI checkbox owns the a11y semantics
		// react-doctor-disable-next-line react-doctor/no-static-element-interactions -- pointer-forwarding label-proxy wrapper: onPointerUp skips the interactive checkbox descendant and just redirects row-text clicks to the Base UI Checkbox.Root, which already carries role="checkbox", aria-label, and full keyboard support; adding role+tabIndex would create a spurious competing tab stop.
		// react-doctor-disable-next-line react-doctor/click-events-have-key-events -- same label-proxy wrapper: keyboard activation is owned by the inner Checkbox.Root; the row only forwards pointer events to mirror a native checkbox label.
		<div
			aria-disabled={disabled || undefined}
			className={cn(
				"relative z-raised flex min-w-0 items-center gap-2.5 rounded-lg px-3 py-1.5 outline-none",
				disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
				className,
			)}
			data-proximity-index={disabled ? undefined : index}
			onPointerUp={handleRowPointerUp}
			ref={setRef}
		>
			<Checkbox.Root
				aria-label={label}
				checked={checked}
				className={cn(
					"relative h-[15px] w-[15px] shrink-0 appearance-none border-0 bg-transparent p-0 outline-none",
					disabled ? "cursor-not-allowed" : "cursor-pointer",
				)}
				disabled={disabled}
				onCheckedChange={handleToggle}
				ref={checkboxRef}
			>
				<span
					className={cn(
						"absolute inset-0 rounded-[5px] border-[1.5px] border-solid transition-colors duration-[80ms]",
						// Checked = no box at all; the foreground-coloured check carries the state.
						checked && "border-transparent",
						// Unchecked boxes are drawn with a foreground-tinted edge (not the
						// near-substrate `border-*` tokens, which vanish against the
						// elevated surface these rows sit on): `foreground-dim` at rest is
						// a clearly-visible empty box, `foreground-muted` brightens it on
						// hover / keyboard focus.
						!checked && isActive && "border-foreground-muted",
						!(checked || isActive) && "border-foreground-dim",
					)}
				/>
				{/* `AnimatePresence initial={false}` suppresses the very-first-paint
				    draw animation on items that mount already checked (replaces the
				    old `hasMounted` ref/state gate); subsequent toggles still play
				    the path-draw exit/enter. */}
				<AnimatePresence initial={false}>
					{checked ? (
						<Checkbox.Indicator keepMounted={true}>
							<motion.svg
								animate={{ opacity: 1 }}
								className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-foreground"
								exit={{ opacity: 1 }}
								fill="none"
								height={18}
								initial={{ opacity: 1 }}
								stroke="currentColor"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								viewBox="0 0 24 24"
								width={18}
							>
								<motion.path
									animate={{
										pathLength: 1,
										transition: { duration: 0.08, ease: "easeOut" },
									}}
									d="M6 12L10 16L18 8"
									exit={{
										pathLength: 0,
										transition: { duration: 0.04, ease: "easeIn" },
									}}
									initial={{ pathLength: 0 }}
								/>
							</motion.svg>
						</Checkbox.Indicator>
					) : null}
				</AnimatePresence>
			</Checkbox.Root>

			{leading ? (
				// Leading icons render solid white (foreground) regardless of checked state
				// so their thin strokes stay legible on the elevated surface substrate.
				// The icon itself uses currentColor (no own text-* class), so this wins.
				<span
					className={cn(
						"flex shrink-0 transition-colors duration-100",
						"text-foreground",
					)}
				>
					{leading}
				</span>
			) : null}

			{(() => {
				const labelBlock = (
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
								checked || isActive
									? "text-foreground"
									: "text-foreground-secondary",
							)}
							style={{
								fontVariationSettings: checked
									? fontWeights.semibold
									: fontWeights.normal,
							}}
						>
							{label}
						</span>
					</span>
				);
				return tooltip ? (
					<Tooltip content={tooltip} side="top">
						{labelBlock}
					</Tooltip>
				) : (
					labelBlock
				);
			})()}

			{trailing ? (
				// Stop click/keydown from bubbling to the row so the inner
				// control (e.g. the level switcher) owns its own interaction
				// without re-triggering onToggle. Must use React's synthetic
				// handlers, NOT native addEventListener: React 19 delegates
				// events to the root, so a native stopPropagation here would
				// fire before the root and swallow the inner control's own
				// React onClick entirely (the switcher would never change).
				// Synthetic bubbling runs the inner handler first, then this.
				// biome-ignore lint/a11y/noNoninteractiveElementInteractions: presentational wrapper; interactive semantics live on the inner control and the row
				// biome-ignore lint/a11y/noStaticElementInteractions: the handlers are a propagation barrier only — not an interactive affordance; a11y semantics live on the inner control and the row
				<span
					className="shrink-0"
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
				>
					{trailing}
				</span>
			) : null}
		</div>
	);
}
