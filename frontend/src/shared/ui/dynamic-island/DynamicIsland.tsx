import { AnimatePresence, type HTMLMotionProps, m } from "motion/react";
import { createContext, type ReactNode, useContext, useEffect, useReducer } from "react";

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
	initialAnimation = [],
}: DynamicIslandProviderProps) {
	const [state, dispatch] = useReducer(reducer, {
		size: initialSize,
		previousSize: undefined,
		animationQueue: initialAnimation,
		isAnimating: initialAnimation.length > 0,
	});

	const setSize = (size: SizePresets) => dispatch({ type: "set", size });
	const scheduleAnimation = (steps: AnimationStep[]) => dispatch({ type: "schedule", steps });

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

	return <DynamicIslandContext.Provider value={value}>{children}</DynamicIslandContext.Provider>;
}

export function useDynamicIslandSize(): ContextValue {
	const ctx = useContext(DynamicIslandContext);
	if (!ctx) {
		throw new Error("useDynamicIslandSize must be used within a DynamicIslandProvider");
	}
	return ctx;
}

/**
 * Queue a sequence of size transitions on mount. `steps` is captured in a
 * ref so step-array identity changes on subsequent renders don't restart
 * the queue — the schedule is a one-shot, mount-time behavior.
 */
const shellTransition = { type: "spring" as const, stiffness: 420, damping: 32, mass: 1 };

export interface DynamicIslandProps extends Omit<HTMLMotionProps<"div">, "id"> {
	children?: ReactNode;
	/**
	 * Let children drive the island's height (and any width past the preset's
	 * own width). Skips `height` in the animate target and renders children
	 * in normal flow so the parent grows to wrap them. Combined with the
	 * `layout` prop (which needs `domMax` features in the parent
	 * `<LazyMotion>`), height changes animate smoothly — every wrapped line
	 * of text extends the shell by exactly one line's worth.
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
 * The animated capsule shell. Width / height / borderRadius are driven by
 * the active preset by default. With `fitContent` the height becomes
 * intrinsic and grows / shrinks with children (smoothly when the parent
 * `<LazyMotion>` loads `domMax`'s layout-animation feature).
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

	const baseClasses = [
		"relative overflow-hidden bg-black text-white",
		"shadow-[0_10px_30px_-10px_rgba(0,0,0,0.7)] ring-1 ring-white/[0.06] ring-inset",
		isVisible ? "opacity-100" : "pointer-events-none opacity-0",
	];
	if (className) {
		baseClasses.push(className);
	}

	// Four-corner radii so `flatTop` can pin the top corners to 0 without
	// touching the bottom. When flatTop is false this collapses to a uniform
	// radius — equivalent to the old `borderRadius: preset.borderRadius`.
	const topRadius = flatTop ? 0 : preset.borderRadius;
	const animateTarget: Record<string, number> = {
		width: preset.width,
		borderTopLeftRadius: topRadius,
		borderTopRightRadius: topRadius,
		borderBottomLeftRadius: preset.borderRadius,
		borderBottomRightRadius: preset.borderRadius,
	};
	if (!fitContent) {
		animateTarget.height = preset.height;
	}

	return (
		<m.div
			animate={animateTarget}
			className={baseClasses.join(" ")}
			id={id}
			initial={false}
			layout={fitContent}
			transition={shellTransition}
			{...(style !== undefined && { style })}
			{...rest}
		>
			{fitContent ? (
				// Normal-flow children push the shell's height. No
				// AnimatePresence here because state.size *also* changes
				// width — letting the shell tween its own width while
				// children swap inline keeps both axes coherent.
				children
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
	);
}
