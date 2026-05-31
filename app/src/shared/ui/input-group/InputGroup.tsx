import { Button as BaseButton } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import type { ComponentPropsWithRef, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceClasses, useSurface } from "@/shared/lib/surface";

type InputGroupSize = "sm" | "md";
export type InputGroupTone = "default" | "active" | "danger" | "muted";
/**
 * `elevated` — the original raised shell: substrate-lifted surface, a soft
 * drop shadow, and an accent glow + ring on focus. Right for prominent,
 * standalone controls (e.g. the hotkey recorder).
 *
 * `minimal` — the flat, muted fluidfunctionalism field: no shadow, no glow,
 * transparent at rest with only a hairline ring that firms to `border` on
 * focus and a faint background lift on hover/focus. Right for inline form
 * fields that should recede into a settings panel rather than float above it.
 */
export type InputGroupAppearance = "elevated" | "minimal";
type InputGroupAddonAlign = "inline-start" | "inline-end";

const SIZE_HEIGHT: Record<InputGroupSize, string> = {
	sm: "h-7 text-2xs",
	md: "h-10 text-xs",
};

const SIZE_RADIUS: Record<InputGroupSize, string> = {
	sm: "rounded-md",
	md: "rounded-xl",
};

// Per appearance × tone: a 1px ring plus (elevated only) a soft glow wash.
// The wash is a box-shadow (no extra DOM) so it shares the ring's transition.
// The minimal set drops every shadow/glow and stays neutral on focus — bg
// lifts a hair and the ring firms to `border`, never to accent.
const TONE_FRAME: Record<InputGroupAppearance, Record<InputGroupTone, string>> = {
	elevated: {
		default:
			"ring-1 ring-divider hover:ring-border focus-within:ring-accent/70 focus-within:shadow-[0_0_0_4px_var(--color-accent-glow),var(--shadow-elevated)]",
		active:
			"ring-1 ring-accent/40 shadow-[0_0_0_4px_var(--color-accent-glow),var(--shadow-elevated)]",
		danger:
			"ring-1 ring-error/45 shadow-[0_0_0_4px_oklch(59%_0.22_25/0.12),var(--shadow-elevated)]",
		muted: "ring-1 ring-divider/60 opacity-70",
	},
	minimal: {
		default:
			"ring-1 ring-divider bg-transparent hover:bg-foreground/[0.03] hover:ring-border focus-within:bg-foreground/[0.06] focus-within:ring-border-hover",
		active: "ring-1 ring-border bg-foreground/[0.06]",
		danger: "ring-1 ring-error/50 bg-error-dim/40 focus-within:bg-error-dim/50",
		muted: "ring-1 ring-divider/60 opacity-70",
	},
};

const TONE_TEXT: Record<InputGroupTone, string> = {
	default: "text-foreground",
	active: "text-foreground",
	danger: "text-error",
	muted: "text-foreground-dim",
};

export interface InputGroupProps extends HTMLAttributes<HTMLDivElement> {
	appearance?: InputGroupAppearance;
	children: ReactNode;
	size?: InputGroupSize;
	tone?: InputGroupTone;
}

/**
 * Shadcn-flavoured input-group built on Base UI primitives. Acts as a
 * shared "shell" that wraps content + addons inside a single frame.
 *
 * Substrate-aware: lifts +2 above the current surface AND re-provides the new
 * level downward so any nested popup / dropdown inside the group automatically
 * elevates another step. That's how `panel (s-3) → group (s-5) → popup (s-7)`
 * chains stay cohesive without hardcoded values. (The `minimal` appearance
 * keeps the substrate context for nested popups but renders a flat, muted
 * frame instead of a raised surface — see `InputGroupAppearance`.)
 */
export function InputGroup({
	appearance = "elevated",
	children,
	className,
	size = "md",
	tone = "default",
	...rest
}: InputGroupProps) {
	const substrate = useSurface();
	const level = Math.min(substrate + 2, 8);
	return (
		<SurfaceProvider value={level}>
			<div
				className={cn(
					"group/input-group relative inline-flex w-full items-stretch",
					"transition-[box-shadow,background-color,color] duration-150 ease-out",
					// Only the elevated shell paints a raised surface + drop shadow;
					// minimal stays transparent and lets the frame do the talking.
					appearance === "elevated" && cn("shadow-elevated", surfaceClasses(level)),
					SIZE_HEIGHT[size],
					SIZE_RADIUS[size],
					TONE_FRAME[appearance][tone],
					TONE_TEXT[tone],
					className
				)}
				data-appearance={appearance}
				data-size={size}
				data-tone={tone}
				{...rest}
			>
				{children}
			</div>
		</SurfaceProvider>
	);
}

export interface InputGroupContentProps extends HTMLAttributes<HTMLDivElement> {
	children: ReactNode;
}

/**
 * Non-input display slot — used when the content is a kbd combo, a
 * formatted value, or any other non-editable display. Mirrors the
 * padding/typography of `InputGroupInput` so swapping is seamless.
 */
export function InputGroupContent({ children, className, ...rest }: InputGroupContentProps) {
	return (
		<div
			className={cn(
				"flex min-w-0 flex-1 items-center justify-start overflow-hidden font-mono leading-none",
				"pr-2 pl-3",
				className
			)}
			{...rest}
		>
			{children}
		</div>
	);
}

export type InputGroupInputProps = ComponentPropsWithRef<typeof Input>;

/**
 * Editable input slot — the writable counterpart to `InputGroupContent`.
 * Renders Base UI's `Input` transparently so the group's surface, frame and
 * tone show through: the group owns the ring / glow / radius, the input owns
 * only the caret + placeholder. Flexes to fill the gap between addons, so the
 * common shape is `[start icon] [input] [end action]`.
 */
export function InputGroupInput({ className, ...rest }: InputGroupInputProps) {
	return (
		<Input
			className={cn(
				"min-w-0 flex-1 bg-transparent px-1 text-body text-foreground caret-accent outline-none",
				"placeholder:text-foreground-muted",
				"disabled:cursor-not-allowed disabled:opacity-60",
				className
			)}
			{...rest}
		/>
	);
}

export interface InputGroupAddonProps extends HTMLAttributes<HTMLDivElement> {
	align?: InputGroupAddonAlign;
	children: ReactNode;
}

const ADDON_ALIGN: Record<InputGroupAddonAlign, string> = {
	"inline-start": "order-first pl-2 pr-1",
	"inline-end": "order-last pr-1.5 pl-1",
};

/**
 * Slot for icons, text or buttons that flank the input. `align`
 * decides left vs right. Multiple addons on the same side stack in
 * declaration order.
 */
export function InputGroupAddon({
	align = "inline-start",
	children,
	className,
	...rest
}: InputGroupAddonProps) {
	return (
		<div
			className={cn(
				"flex shrink-0 items-center gap-2 text-foreground-secondary",
				ADDON_ALIGN[align],
				className
			)}
			data-align={align}
			{...rest}
		>
			{children}
		</div>
	);
}

export interface InputGroupTextProps extends HTMLAttributes<HTMLSpanElement> {
	children: ReactNode;
}

export function InputGroupText({ children, className, ...rest }: InputGroupTextProps) {
	return (
		<span
			className={cn(
				"select-none font-medium font-sans text-2xs text-foreground-muted uppercase leading-none tracking-[0.04em]",
				className
			)}
			{...rest}
		>
			{children}
		</span>
	);
}

export interface InputGroupButtonProps extends ComponentPropsWithRef<typeof BaseButton> {
	children: ReactNode;
	tone?: "default" | "danger" | "ghost";
}

// `default` / `danger`: filled disk + accent glow ring on hover. Sized to nest
// neatly inside an h-10 group with ~3px breathing room top/bottom.
// `ghost`: the flat, muted fluidfunctionalism action — transparent until hover,
// then a faint wash + the icon brightens from muted to foreground. No fill, no
// shadow; the right pairing for a `minimal` group.
const BUTTON_TONE: Record<NonNullable<InputGroupButtonProps["tone"]>, string> = {
	default: [
		"bg-accent text-white",
		"shadow-[inset_0_1px_0_0_oklch(100%_0_0/0.18),0_1px_2px_0_oklch(0%_0_0/0.45),0_6px_18px_-6px_var(--color-accent-glow-strong)]",
		"hover:bg-accent-hover hover:shadow-[inset_0_1px_0_0_oklch(100%_0_0/0.22),0_1px_2px_0_oklch(0%_0_0/0.45),0_10px_28px_-8px_var(--color-accent-glow-strong)]",
	].join(" "),
	danger: [
		"bg-error text-white",
		"shadow-[inset_0_1px_0_0_oklch(100%_0_0/0.18),0_1px_2px_0_oklch(0%_0_0/0.45),0_6px_18px_-6px_oklch(59%_0.22_25/0.5)]",
		"hover:bg-error/95 hover:shadow-[inset_0_1px_0_0_oklch(100%_0_0/0.22),0_1px_2px_0_oklch(0%_0_0/0.45),0_10px_28px_-8px_oklch(59%_0.22_25/0.6)]",
	].join(" "),
	ghost: "bg-transparent text-foreground-muted hover:bg-foreground/[0.06] hover:text-foreground",
};

/**
 * Round CTA that nests inside the group's addon slot. Always wraps Base
 * UI's `Button` so disabled / focus / pressed states stay consistent
 * across the system.
 */
export function InputGroupButton({
	children,
	className,
	tone = "default",
	type = "button",
	...rest
}: InputGroupButtonProps) {
	return (
		<BaseButton
			className={cn(
				"inline-flex size-7 cursor-pointer items-center justify-center rounded-lg outline-none",
				"transition-[background-color,box-shadow,color] duration-200 ease-out",
				"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1",
				"disabled:cursor-not-allowed disabled:opacity-40",
				BUTTON_TONE[tone],
				className
			)}
			type={type}
			{...rest}
		>
			{children}
		</BaseButton>
	);
}
