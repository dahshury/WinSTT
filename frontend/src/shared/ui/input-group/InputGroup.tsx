import { Button as BaseButton } from "@base-ui/react/button";
import { Input as BaseInput } from "@base-ui/react/input";
import type {
	ComponentPropsWithoutRef,
	ComponentPropsWithRef,
	HTMLAttributes,
	ReactNode,
	Ref,
} from "react";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceClasses, useSurface } from "@/shared/lib/surface";

export type InputGroupSize = "sm" | "md";
export type InputGroupTone = "default" | "active" | "danger" | "muted";
export type InputGroupAddonAlign = "inline-start" | "inline-end";

const SIZE_HEIGHT: Record<InputGroupSize, string> = {
	sm: "h-7 text-2xs",
	md: "h-10 text-xs",
};

const SIZE_RADIUS: Record<InputGroupSize, string> = {
	sm: "rounded-md",
	md: "rounded-xl",
};

// Each tone draws a 1px ring + a soft outer wash. The wash is rendered
// via box-shadow (no extra DOM) so it inherits the same transition
// timing as the ring colour and feels like a single "atmosphere" shift.
const TONE_FRAME: Record<InputGroupTone, string> = {
	default:
		"ring-1 ring-divider hover:ring-border focus-within:ring-accent/70 focus-within:shadow-[0_0_0_4px_var(--color-accent-glow),var(--shadow-elevated)]",
	active:
		"ring-1 ring-accent/40 shadow-[0_0_0_4px_var(--color-accent-glow),var(--shadow-elevated)]",
	danger: "ring-1 ring-error/45 shadow-[0_0_0_4px_oklch(59%_0.22_25/0.12),var(--shadow-elevated)]",
	muted: "ring-1 ring-divider/60 opacity-70",
};

const TONE_TEXT: Record<InputGroupTone, string> = {
	default: "text-foreground",
	active: "text-foreground",
	danger: "text-error",
	muted: "text-foreground-dim",
};

export interface InputGroupProps extends HTMLAttributes<HTMLDivElement> {
	children: ReactNode;
	size?: InputGroupSize;
	tone?: InputGroupTone;
}

/**
 * Shadcn-flavoured input-group built on Base UI primitives. Acts as a
 * shared "shell" that wraps content + addons inside a single elevated
 * surface.
 *
 * Substrate-aware (fluidfunctionalism recipe): lifts +2 above the
 * current surface AND re-provides the new level downward so any nested
 * popup / dropdown inside the group automatically elevates another
 * step. That's how `panel (s-3) → group (s-5) → popup (s-7)` chains
 * stay cohesive without hardcoded values.
 */
export function InputGroup({
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
					"group/input-group relative inline-flex w-full items-stretch shadow-elevated",
					"transition-[box-shadow,background-color,color] duration-200 ease-out",
					surfaceClasses(level),
					SIZE_HEIGHT[size],
					SIZE_RADIUS[size],
					TONE_FRAME[tone],
					TONE_TEXT[tone],
					className
				)}
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

export interface InputGroupInputProps extends ComponentPropsWithoutRef<"input"> {
	ref?: Ref<HTMLInputElement>;
}

/**
 * Input slot. Uses Base UI `Input` so it carries the same a11y +
 * field-context behaviour as the rest of the system. Renders flush
 * inside the group — no own border or background.
 */
export function InputGroupInput({ className, ref, ...rest }: InputGroupInputProps) {
	return (
		<BaseInput
			className={cn(
				"min-w-0 flex-1 border-none bg-transparent px-3 font-sans text-body caret-accent outline-none",
				"placeholder:text-foreground-muted disabled:cursor-not-allowed",
				className
			)}
			ref={ref}
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
	tone?: "default" | "danger";
}

// Inner CTA: filled disk + accent glow ring on hover. Sized to nest
// neatly inside an h-10 group with ~3px breathing room top/bottom.
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
