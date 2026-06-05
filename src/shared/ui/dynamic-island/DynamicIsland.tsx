import { AnimatePresence, type HTMLMotionProps, m } from "motion/react";
import {
	createContext,
	type ReactNode,
	type RefObject,
	use,
	useEffect,
	useReducer,
	useRef,
	useState,
} from "react";

/**
 * DynamicIsland — composable, animated capsule primitives for adaptive
 * notification / status / action surfaces. Adapted from cult-ui's reference,
 * converted to `motion/react`'s `m.*` so it slots inside the renderer's
 * existing `<LazyMotion features={domAnimation} strict>` wrapper without
 * needing the full `motion.*` feature bundle.
 *
 * Public API exposed via `index.ts`:
 *   - `DynamicIslandProvider`  — wraps the tree, owns size state + queue
 *   - `DynamicIsland`          — animated shell (width / height / radius)
 *   - `DynamicContainer`       — animated wrapper for a state view
 *   - `DynamicTitle`           — animated `<h3>`
 *   - `DynamicDescription`     — animated `<p>`
 *   - `DynamicDiv`             — animated `<div>` block
 *   - `useDynamicIslandSize`   — read state + `setSize` / `scheduleAnimation`
 *   - `useScheduledAnimations` — queue timed transitions on mount
 *   - `presets`                — raw preset dimensions
 *   - types: `SizePresets`, `AnimationStep`, `Preset`
 */

export type SizePresets =
	| "default"
	| "compact"
	| "compactLong"
	| "compactMedium"
	| "large"
	| "long"
	| "medium"
	| "tall"
	| "ultra"
	| "massive"
	| "minimalLeading"
	| "minimalTrailing"
	| "reset"
	| "empty";

interface Preset {
	borderRadius: number;
	height: number;
	width: number;
}

// Numbers picked to approximate Apple's Dynamic Island proportions: a wide,
// short capsule at rest (`default`/`compact`) that can grow downward for
// multi-line content (`tall`/`ultra`/`massive`). `empty` collapses the shell
// to a 0×0 box used to hide the island without unmounting the tree.
const presets: Record<SizePresets, Preset> = {
	default: { width: 150, height: 36, borderRadius: 28 },
	compact: { width: 240, height: 36, borderRadius: 28 },
	compactLong: { width: 360, height: 36, borderRadius: 28 },
	compactMedium: { width: 280, height: 56, borderRadius: 28 },
	large: { width: 360, height: 88, borderRadius: 28 },
	long: { width: 460, height: 72, borderRadius: 28 },
	medium: { width: 380, height: 110, borderRadius: 28 },
	tall: { width: 380, height: 200, borderRadius: 28 },
	ultra: { width: 460, height: 200, borderRadius: 28 },
	massive: { width: 520, height: 280, borderRadius: 28 },
	minimalLeading: { width: 56, height: 36, borderRadius: 28 },
	minimalTrailing: { width: 56, height: 36, borderRadius: 28 },
	reset: { width: 150, height: 36, borderRadius: 28 },
	empty: { width: 0, height: 0, borderRadius: 0 },
};

export interface AnimationStep {
	delay: number;
	size: SizePresets;
}

// Module-level constant so the default `initialAnimation` prop doesn't allocate
// a fresh array on every render of `DynamicIslandProvider`.
const EMPTY_ANIMATION_STEPS: AnimationStep[] = [];

interface State {
	animationQueue: AnimationStep[];
	isAnimating: boolean;
	previousSize: SizePresets | undefined;
	size: SizePresets;
}

type Action =
	| { type: "set"; size: SizePresets }
	| { type: "schedule"; steps: AnimationStep[] }
	| { type: "advanceQueue" };

function reducer(state: State, action: Action): State {
	switch (action.type) {
		case "set":
			if (state.size === action.size) {
				return state;
			}
			return { ...state, previousSize: state.size, size: action.size };
		case "schedule":
			return {
				...state,
				animationQueue: action.steps,
				isAnimating: action.steps.length > 0,
			};
		case "advanceQueue":
			return state.animationQueue.length > 1
				? { ...state, animationQueue: state.animationQueue.slice(1) }
				: { ...state, animationQueue: [], isAnimating: false };
		default:
			return state;
	}
}

export interface ContextValue {
	presets: typeof presets;
	scheduleAnimation: (steps: AnimationStep[]) => void;
	setSize: (size: SizePresets) => void;
	state: State;
}

const DynamicIslandContext = createContext<ContextValue | null>(null);

export interface DynamicIslandProviderProps {
	children: ReactNode;
	initialAnimation?: AnimationStep[];
	initialSize?: SizePresets;
}

export function DynamicIslandProvider({
	children,
	initialSize = "default",
	initialAnimation = EMPTY_ANIMATION_STEPS,
}: DynamicIslandProviderProps) {
	const [state, dispatch] = useReducer(reducer, {
		size: initialSize,
		previousSize: undefined,
		animationQueue: initialAnimation,
		isAnimating: initialAnimation.length > 0,
	});

	const setSize = (size: SizePresets) => dispatch({ type: "set", size });
	const scheduleAnimation = (steps: AnimationStep[]) =>
		dispatch({ type: "schedule", steps });

	// Drive the queue: when isAnimating, wait the head step's delay, commit
	// its size, then advance. The effect re-runs after each advance so the
	// next step picks up its own delay.
	useEffect(() => {
		if (!state.isAnimating || state.animationQueue.length === 0) {
			return;
		}
		const head = state.animationQueue[0];
		if (!head) {
			return;
		}
		const timer = setTimeout(() => {
			dispatch({ type: "set", size: head.size });
			dispatch({ type: "advanceQueue" });
		}, head.delay);
		return () => clearTimeout(timer);
	}, [state.isAnimating, state.animationQueue]);

	const value: ContextValue = {
		state,
		setSize,
		scheduleAnimation,
		presets,
	};

	return (
		<DynamicIslandContext.Provider value={value}>
			{children}
		</DynamicIslandContext.Provider>
	);
}

export function useDynamicIslandSize(): ContextValue {
	const ctx = use(DynamicIslandContext);
	if (!ctx) {
		throw new Error(
			"useDynamicIslandSize must be used within a DynamicIslandProvider",
		);
	}
	return ctx;
}

/**
 * Queue a sequence of size transitions on mount. `steps` is captured in a
 * ref so step-array identity changes on subsequent renders don't restart
 * the queue — the schedule is a one-shot, mount-time behavior.
 */
const shellTransition = {
	type: "spring" as const,
	stiffness: 420,
	damping: 32,
	mass: 1,
};

export interface DynamicIslandProps extends Omit<HTMLMotionProps<"div">, "id"> {
	children?: ReactNode;
	/**
	 * Let children drive the island's height. The children are rendered in
	 * normal flow inside a measured wrapper; their intrinsic pixel height is
	 * tracked (ResizeObserver) and fed into the animate target so the shell
	 * tweens its `height` CSS PROPERTY — every wrapped line extends the shell
	 * by one line's worth, smoothly.
	 *
	 * NB: height is deliberately animated as a property (layout reflow), NOT
	 * via Framer's `layout`/FLIP. `layout` morphs the box with a `transform:
	 * scale`, and scaling the box scale-distorts (stretches) the text rendered
	 * inside it. Animating the height property reflows instead, so the island
	 * still visibly stretches while the text stays pixel-crisp.
	 */
	fitContent?: boolean;
	/**
	 * Flatten the TOP corners — used when the island is docked flush against
	 * the top bezel of the desktop so it visually "hangs" from the edge.
	 * Bottom corners keep `preset.borderRadius`; top corners animate to 0.
	 */
	flatTop?: boolean;
	id: string;
}

/**
 * Measure the intrinsic pixel height of the `fitContent` children and return a
 * ref to attach to the content wrapper plus the height the shell should animate
 * to. The height is tweened as a CSS PROPERTY (not Framer `layout`/FLIP) so the
 * shell stretches by reflow instead of `transform: scale`, which would
 * scale-distort the text inside. Extracted from `DynamicIsland` to keep that
 * component under the cognitive-complexity gate.
 */
function useFitContentHeight(
	fitContent: boolean,
	isVisible: boolean,
): {
	contentRef: RefObject<HTMLDivElement | null>;
	sizingHeight: number | null;
} {
	const contentRef = useRef<HTMLDivElement | null>(null);
	const [contentHeight, setContentHeight] = useState<number | null>(null);
	useEffect(() => {
		if (!fitContent) {
			return;
		}
		const el = contentRef.current;
		if (!el) {
			return;
		}
		const measure = () => setContentHeight(el.offsetHeight);
		measure();
		// Guarded for the test env / any webview without ResizeObserver — the
		// one-shot `measure()` above still seeds an initial height there.
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [fitContent]);
	// Freeze the last on-screen height so the close tween animates from the real
	// size instead of collapsing to 0 when the content unmounts (mirrors
	// `lastVisiblePreset`). A measured 0 means "content gone / not yet measured",
	// so it never overwrites the frozen value.
	const [lastVisibleHeight, setLastVisibleHeight] = useState<number | null>(
		null,
	);
	const measuredHeight =
		contentHeight && contentHeight > 0 ? contentHeight : null;
	if (
		isVisible &&
		measuredHeight !== null &&
		measuredHeight !== lastVisibleHeight
	) {
		setLastVisibleHeight(measuredHeight);
	}
	// While visible, prefer the fresh measurement but fall back to the frozen
	// height during the first frame after a re-open (before ResizeObserver
	// re-measures) so the island never flashes collapsed.
	const sizingHeight = isVisible
		? (measuredHeight ?? lastVisibleHeight)
		: lastVisibleHeight;
	return { contentRef, sizingHeight };
}

/**
 * The animated capsule shell. Width / height / borderRadius are driven by
 * the active preset by default. With `fitContent` the height instead tracks
 * the measured intrinsic height of the children and animates as a CSS property
 * (no Framer `layout`/FLIP — see the `fitContent` prop doc), so the shell grows
 * / shrinks smoothly without scale-distorting the text inside.
 */
export function DynamicIsland({
	id,
	children,
	className,
	style,
	flatTop = false,
	fitContent = false,
	...rest
}: DynamicIslandProps) {
	const { state, presets: p } = useDynamicIslandSize();
	const preset = p[state.size];
	// In fitContent mode, the preset's height is ignored — visibility is
	// gated on width alone so the `empty` preset (0×0) still collapses the
	// shell out of view.
	const isVisible = preset.width > 0 && (fitContent || preset.height > 0);

	// Freeze the last visible preset so the reveal animation is a pure
	// translate+opacity+blur tween at the box's final size — without this
	// the empty (0×0) preset would spring its width/height up to the new
	// preset while opacity is still ramping, recreating the "expand from
	// the middle" feel the panel-slide reveal is meant to replace.
	//
	// State (not a ref) holds the snapshot so reads aren't done during render
	// on a mutable container. A layout effect captures the latest preset
	// whenever the island is visible; when the next render flips `isVisible`
	// to false, the state still holds the preset from the previous visible
	// render and the closing tween animates at that final size.
	const [lastVisiblePreset, setLastVisiblePreset] = useState<Preset | null>(
		null,
	);
	if (isVisible && lastVisiblePreset !== preset) {
		setLastVisiblePreset(preset);
	}
	const sizingPreset = isVisible ? preset : (lastVisiblePreset ?? p.default);

	// fitContent height is intrinsic (driven by wrapped text); it's measured and
	// tweened as a CSS property (NOT Framer `layout`/FLIP) so the shell stretches
	// by reflow without scale-distorting the text. See `useFitContentHeight` and
	// the `fitContent` prop doc.
	const { contentRef, sizingHeight } = useFitContentHeight(
		fitContent,
		isVisible,
	);

	const baseClasses = [
		"relative overflow-hidden bg-black text-white",
		"shadow-[0_10px_30px_-10px_rgba(0,0,0,0.7)] ring-1 ring-white/[0.06] ring-inset",
		isVisible ? null : "pointer-events-none",
	].filter(Boolean);
	if (className) {
		baseClasses.push(className);
	}

	// Four-corner radii so `flatTop` can pin the top corners to 0 without
	// touching the bottom. When flatTop is false this collapses to a uniform
	// radius — equivalent to the old `borderRadius: preset.borderRadius`.
	const topRadius = flatTop ? 0 : sizingPreset.borderRadius;
	const animateTarget: Record<string, number | string> = {
		width: sizingPreset.width,
		borderTopLeftRadius: topRadius,
		borderTopRightRadius: topRadius,
		borderBottomLeftRadius: sizingPreset.borderRadius,
		borderBottomRightRadius: sizingPreset.borderRadius,
	};
	if (fitContent) {
		// Animated as a CSS property (reflow) — never via transform scale, so
		// the text never stretches. Omitted until first measured so the very
		// first paint sizes to the intrinsic (auto) height with no jump.
		if (sizingHeight !== null) {
			animateTarget.height = sizingHeight;
		}
	} else {
		animateTarget.height = sizingPreset.height;
	}

	const transition = {
		default: shellTransition,
	};
	const motionStyle = style ?? {};

	return (
		// Panel reveal opacity lives on this wrapper; width and height live on
		// the inner Motion shell so content updates cannot replay the fade.
		<div className="t-panel-slide-top" data-open={isVisible ? "true" : "false"}>
			<m.div
				animate={animateTarget}
				className={baseClasses.join(" ")}
				id={id}
				initial={false}
				style={motionStyle}
				transition={transition}
				{...rest}
			>
				{fitContent ? (
					// Normal-flow children in a measured wrapper; its intrinsic
					// height drives the shell's animated `height` (see the
					// ResizeObserver above). The shell stays `relative`, so the
					// absolute-positioned cancel button among `children` still
					// anchors to the shell, not this static wrapper.
					<div ref={contentRef}>{children}</div>
				) : (
					<AnimatePresence initial={false} mode="popLayout">
						<m.div
							animate={{ opacity: 1 }}
							className="absolute inset-0"
							exit={{ opacity: 0 }}
							initial={{ opacity: 0 }}
							key={state.size}
							transition={{ duration: 0.16 }}
						>
							{children}
						</m.div>
					</AnimatePresence>
				)}
			</m.div>
		</div>
	);
}
