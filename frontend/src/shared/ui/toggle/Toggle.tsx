import { Switch } from "@base-ui/react/switch";
import {
	animate,
	domAnimation,
	LazyMotion,
	m as motion,
	useMotionValue,
	useReducedMotion,
} from "motion/react";
import {
	type HTMLAttributes,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { cn } from "@/shared/lib/cn";
import { springs } from "@/shared/lib/springs";
import { surfaceBg, useSurface } from "@/shared/lib/surface";

export interface ToggleProps {
	"aria-label"?: string | undefined;
	checked: boolean;
	disabled?: boolean | undefined;
	label?: string | undefined;
	onCheckedChange: (checked: boolean) => void;
}

// Geometry of the track + thumb (ported from the fluidfunctionalism switch).
// The thumb is absolutely positioned and driven by a spring `MotionValue` so it
// can be dragged as well as toggled — the distinctive feel of that component.
const TRACK_WIDTH = 34;
const TRACK_HEIGHT = 20;
const THUMB_SIZE = 16;
const THUMB_OFFSET = 2;
const THUMB_TRAVEL = TRACK_WIDTH - THUMB_SIZE - THUMB_OFFSET * 2;
const PILL_EXTEND = 2; // hover: thumb stretches into a pill
const PRESS_EXTEND = 4; // press: thumb stretches wider …
const PRESS_SHRINK = 4; // … and squishes shorter
const DRAG_DEAD_ZONE = 2; // px of slop before a press becomes a drag

// Stable transition references so the travel effect below only re-runs when the
// target moves (or the reduced-motion preference flips), never on every render.
const NO_MOTION = { duration: 0 } as const;

// Press wins over hover: a held thumb stretches widest, a hovered one pills out,
// otherwise it sits at its base size.
function thumbWidthFor(pressed: boolean, hovered: boolean): number {
	if (pressed) {
		return THUMB_SIZE + PRESS_EXTEND;
	}
	if (hovered) {
		return THUMB_SIZE + PILL_EXTEND;
	}
	return THUMB_SIZE;
}

export function Toggle({
	checked,
	onCheckedChange,
	disabled,
	"aria-label": ariaLabel,
	label,
}: ToggleProps) {
	const substrate = useSurface();
	// Two-step lift on the track + four-step lift on the off-state thumb so even
	// on a high substrate (inside an ElevatedSurface) the pill reads as a real
	// raised control rather than blending. The hairline ring picks out the edge.
	const trackLevel = Math.min(substrate + 2, 8);
	const thumbLevel = Math.min(substrate + 4, 8);

	const reduceMotion = useReducedMotion();
	const travelTransition = reduceMotion ? NO_MOTION : springs.moderate;

	const hasMounted = useRef(false);
	const [hovered, setHovered] = useState(false);
	const [pressed, setPressed] = useState(false);

	const dragging = useRef(false);
	const didDrag = useRef(false);
	const pointerStart = useRef<{ clientX: number; originX: number } | null>(null);

	const motionX = useMotionValue(checked ? THUMB_OFFSET + THUMB_TRAVEL : THUMB_OFFSET);

	useEffect(() => {
		hasMounted.current = true;
	}, []);

	const thumbWidth = thumbWidthFor(pressed, hovered);
	const thumbHeight = pressed ? THUMB_SIZE - PRESS_SHRINK : THUMB_SIZE;
	const thumbY = pressed ? THUMB_OFFSET + PRESS_SHRINK / 2 : THUMB_OFFSET;
	// Keep the on-state thumb flush with the right edge as it widens.
	const extraWidth = thumbWidth - THUMB_SIZE;
	const thumbX = checked ? THUMB_OFFSET + THUMB_TRAVEL - extraWidth : THUMB_OFFSET;

	// Spring the thumb to its resting position whenever `checked`/hover/press
	// changes — unless a drag is currently driving `motionX` by hand.
	useEffect(() => {
		if (dragging.current) {
			return;
		}
		if (hasMounted.current) {
			animate(motionX, thumbX, travelTransition);
		} else {
			motionX.set(thumbX);
		}
	}, [thumbX, motionX, travelTransition]);

	function handlePointerDown(e: ReactPointerEvent<HTMLSpanElement>) {
		if (disabled) {
			return;
		}
		if (e.pointerType === "mouse" && e.button !== 0) {
			return;
		}
		setPressed(true);
		dragging.current = false;
		didDrag.current = false;
		pointerStart.current = { clientX: e.clientX, originX: motionX.get() };
		e.currentTarget.setPointerCapture(e.pointerId);
	}

	function handlePointerMove(e: ReactPointerEvent<HTMLSpanElement>) {
		const start = pointerStart.current;
		if (!start) {
			return;
		}
		const delta = e.clientX - start.clientX;
		if (!dragging.current) {
			if (Math.abs(delta) < DRAG_DEAD_ZONE) {
				return;
			}
			dragging.current = true;
		}
		const dragMax = TRACK_WIDTH - THUMB_OFFSET - (THUMB_SIZE + PRESS_EXTEND);
		const rawX = start.originX + delta;
		motionX.set(Math.max(THUMB_OFFSET, Math.min(dragMax, rawX)));
	}

	function handlePointerUp() {
		if (!pointerStart.current) {
			return;
		}
		setPressed(false);
		if (dragging.current) {
			didDrag.current = true;
			dragging.current = false;
			const dragMax = TRACK_WIDTH - THUMB_OFFSET - (THUMB_SIZE + PRESS_EXTEND);
			const midpoint = (THUMB_OFFSET + dragMax) / 2;
			const shouldBeOn = motionX.get() > midpoint;
			if (shouldBeOn === checked) {
				// Snap back: the parent value didn't change, so re-seat the thumb.
				animate(motionX, checked ? THUMB_OFFSET + THUMB_TRAVEL : THUMB_OFFSET, travelTransition);
			} else {
				onCheckedChange(shouldBeOn);
			}
			// Outlive the synthetic click Base UI fires after a drag-release so the
			// drag's toggle isn't doubled by the click's `onCheckedChange`.
			requestAnimationFrame(() => {
				didDrag.current = false;
			});
		}
		pointerStart.current = null;
	}

	const switchEl = (
		<Switch.Root
			aria-label={ariaLabel ?? label}
			checked={checked}
			className={cn(
				// `inline-flex` is load-bearing: Base UI's Switch.Root renders a
				// <span> (default display:inline), and inline boxes ignore the
				// width/height we set via `style`. Without an explicit display the
				// track collapses to 0×0 wherever its parent isn't a flex container
				// that would blockify it (e.g. SettingSection's plain-div header).
				"relative inline-flex shrink-0 cursor-pointer touch-none rounded-full outline-none ring-1 ring-divider-strong ring-inset transition-colors duration-150 ease-linear motion-reduce:transition-none",
				"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
				surfaceBg(trackLevel),
				// On-state fills with teal so it reads from across the panel.
				"data-[checked]:bg-teal data-[checked]:ring-teal-hover",
				disabled && "cursor-not-allowed opacity-50"
			)}
			disabled={disabled}
			onCheckedChange={(next) => {
				if (didDrag.current) {
					return;
				}
				onCheckedChange(next);
			}}
			onPointerDown={handlePointerDown}
			onPointerEnter={(e) => {
				if (e.pointerType === "mouse" && !disabled) {
					setHovered(true);
				}
			}}
			onPointerLeave={() => setHovered(false)}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			style={{ width: TRACK_WIDTH, height: TRACK_HEIGHT }}
		>
			<Switch.Thumb
				render={(thumbProps) => {
					// Drop Base UI's `style`/`className` and the React drag/animation
					// handlers whose typings clash with motion's — we own all of those.
					const {
						style: _baseStyle,
						onDrag: _onDrag,
						onDragStart: _onDragStart,
						onDragEnd: _onDragEnd,
						onAnimationStart: _onAnimationStart,
						onAnimationEnd: _onAnimationEnd,
						onAnimationIteration: _onAnimationIteration,
						className: _className,
						...rest
					} = thumbProps as HTMLAttributes<HTMLSpanElement>;
					return (
						<motion.span
							{...rest}
							animate={{ y: thumbY, width: thumbWidth, height: thumbHeight }}
							className={cn(
								"absolute top-0 left-0 block rounded-full shadow-sm ring-1",
								checked ? "bg-white ring-white/40" : cn(surfaceBg(thumbLevel), "ring-foreground/15")
							)}
							initial={false}
							style={{ x: motionX }}
							transition={hasMounted.current ? travelTransition : NO_MOTION}
						/>
					);
				}}
			/>
		</Switch.Root>
	);

	if (!label) {
		return (
			<LazyMotion features={domAnimation} strict={true}>
				{switchEl}
			</LazyMotion>
		);
	}

	return (
		<LazyMotion features={domAnimation} strict={true}>
			<span className="inline-flex select-none items-center gap-2">
				{switchEl}
				<button
					aria-hidden="true"
					className={cn(
						"text-body transition-colors duration-150",
						checked ? "text-foreground" : "text-foreground-muted",
						disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
					)}
					disabled={disabled}
					onClick={() => onCheckedChange(!checked)}
					tabIndex={-1}
					type="button"
				>
					{label}
				</button>
			</span>
		</LazyMotion>
	);
}
