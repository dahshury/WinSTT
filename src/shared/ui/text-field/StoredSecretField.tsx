import { LockIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/shared/lib/cn";
import { TextField } from "./TextField";

const STORED_SECRET_VALUE = "********";

/**
 * A saved, sealed credential. Shown in place of the editable field once a key is
 * stored, styled so it reads as UNMISTAKABLY filled-and-locked rather than a dim
 * empty box (the two used to look nearly identical). Grayscale only — no
 * success-green (see the no-green-status preference):
 *   - a leading lock glyph (the editable field instead carries a trailing reveal
 *     eye, so the two mirror each other and never collide),
 *   - solid, spaced mono dots in `foreground-secondary` — clearly real content,
 *     not the `foreground-muted` placeholder of an empty field,
 *   - a flat, inset-ringed surface (`shadow-none` + inner `divider-strong` ring)
 *     so it looks sealed, not like a lifted, focus-ready input.
 * Disabled + read-only; removal happens via the "Remove key" action by the label.
 */
export function StoredSecretField({
	className,
	...props
}: Omit<ComponentPropsWithoutRef<"input">, "onChange" | "type" | "value">) {
	return (
		<div className="relative w-full">
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-y-0 left-0 z-raised flex items-center pl-2.5 text-foreground-secondary"
			>
				<HugeiconsIcon icon={LockIcon} size={14} />
			</span>
			<TextField
				{...props}
				className={cn(
					"cursor-not-allowed select-none pl-8 font-mono tracking-[0.3em] text-foreground-secondary shadow-none ring-1 ring-divider-strong ring-inset",
					className,
				)}
				disabled
				readOnly
				type="password"
				value={STORED_SECRET_VALUE}
			/>
		</div>
	);
}
