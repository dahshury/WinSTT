import { AlertCircleIcon, LockIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/shared/lib/cn";
import { TextField } from "./TextField";

const STORED_SECRET_VALUE = "********";

interface StoredSecretFieldProps
	extends Omit<
		ComponentPropsWithoutRef<"input">,
		"onChange" | "type" | "value"
	> {
	/**
	 * The stored key failed verification (probe returned `verified: false`).
	 * When set, the sealed lock is swapped for an error affordance — an alert
	 * glyph + error-token ring — so a rejected key no longer reads as
	 * sealed-and-good. Optional and off by default. Grayscale otherwise (no
	 * success-green, per the no-green-status preference); the error token is
	 * the project's one allowed status colour, reserved for failures.
	 */
	invalid?: boolean | undefined;
}

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
 * When `invalid`, the same sealed shell switches to the error token (alert glyph
 * + error ring/text) so a probe-rejected key doesn't masquerade as good.
 * Disabled + read-only; removal happens via the "Remove key" action by the label.
 */
export function StoredSecretField({
	className,
	invalid,
	...props
}: StoredSecretFieldProps) {
	return (
		<div className="relative w-full">
			<span
				aria-hidden="true"
				className={cn(
					"pointer-events-none absolute inset-y-0 left-0 z-raised flex items-center pl-2.5",
					invalid ? "text-error" : "text-foreground-secondary",
				)}
			>
				<HugeiconsIcon icon={invalid ? AlertCircleIcon : LockIcon} size={14} />
			</span>
			<TextField
				{...props}
				aria-invalid={invalid || undefined}
				className={cn(
					"cursor-not-allowed select-none pl-8 font-mono tracking-[0.3em] shadow-none ring-1 ring-inset",
					invalid
						? "text-error ring-error"
						: "text-foreground-secondary ring-divider-strong",
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
