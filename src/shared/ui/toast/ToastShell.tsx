import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ElementType, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";

/** Border accent for a toast card, mapped to a semantic tone. */
export type ToastTone = "neutral" | "error" | "success";

const TONE_BORDER: Record<ToastTone, string> = {
	neutral: "border-border",
	error: "border-error/40",
	success: "border-success/40",
};

interface ToastShellProps {
	/** Live-region politeness (mapped to `aria-live`). */
	ariaLive?: "assertive" | "polite";
	/** Toast content (icon, headline, body, action footer, …). */
	children: ReactNode;
	/** Extra classes appended to the card. */
	className?: string;
	/**
	 * Element to render as. Defaults to `div`. Toasts that are status
	 * confirmations (no error semantics) use `output`.
	 */
	as?: ElementType;
	/** Optional `role` (e.g. `alert` for error toasts). */
	role?: string;
}

/**
 * Presentational card chrome shared by every transient toast: an elevated
 * surface (`useSurface() + 3`), a tone-driven border, rounded corners and a
 * drop shadow. Callers supply the inner layout (icon / headline / body /
 * actions) and the outer positioning container (single fixed card vs. a
 * stacked list).
 */
export function ToastShell({
	ariaLive,
	as: Component = "div",
	children,
	className,
	role,
	tone = "neutral",
}: ToastShellProps & { tone?: ToastTone }) {
	const level = Math.min(useSurface() + 3, 8);
	return (
		<Component
			aria-live={ariaLive}
			className={cn(
				"rounded-md border p-3 shadow-lg",
				TONE_BORDER[tone],
				surfaceBg(level),
				className,
			)}
			role={role}
		>
			{children}
		</Component>
	);
}

interface ToastDismissButtonProps {
	/** Accessible label. Defaults to "Dismiss". */
	label?: string;
	onClick: () => void;
}

/**
 * The small top-right "×" close button shared by dismissible toasts.
 */
export function ToastDismissButton({
	label = "Dismiss",
	onClick,
}: ToastDismissButtonProps) {
	return (
		<Button
			aria-label={label}
			className="rounded p-1 text-foreground-muted hover:bg-surface-tertiary hover:text-foreground"
			onClick={onClick}
		>
			<HugeiconsIcon icon={Cancel01Icon} size={12} />
		</Button>
	);
}
