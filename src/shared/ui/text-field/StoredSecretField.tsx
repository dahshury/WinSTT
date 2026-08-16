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
	/**
	 * Pre-masked, NON-SECRET display text — e.g. `sk-or-v1-********4f2a`, built
	 * from the provider's key prefix plus the backend's last-4 hint. Defaults to
	 * a bare asterisk run when the caller has nothing identifying to show.
	 *
	 * Masking is the CALLER's job: this field renders whatever it is handed
	 * verbatim, so never pass a raw key or the presence sentinel. See
	 * `maskedKeyDisplay` in the integrations widget for the one supported way to
	 * build this string.
	 */
	maskedValue?: string | undefined;
}

/**
 * A saved, sealed credential. Shown in place of the editable field once a key is
 * stored, styled so it reads as UNMISTAKABLY filled-and-locked rather than a dim
 * empty box (the two used to look nearly identical). Grayscale only — no
 * success-green (see the no-green-status preference):
 *   - a leading lock glyph (the editable field instead carries a trailing reveal
 *     eye, so the two mirror each other and never collide),
 *   - solid, spaced mono characters in `foreground-secondary` — clearly real
 *     content, not the `foreground-muted` placeholder of an empty field,
 *   - a flat, inset-ringed surface (`shadow-none` + inner `divider-strong` ring)
 *     so it looks sealed, not like a lifted, focus-ready input.
 * When `invalid`, the same sealed shell switches to the error token (alert glyph
 * + error ring/text) so a probe-rejected key doesn't masquerade as good.
 * Disabled + read-only; removal and replacement happen via the actions beside it.
 *
 * The input is `type="text"`, not `type="password"`: the value here is ALREADY a
 * mask, and a password input would re-dot it — hiding the very last-4 hint that
 * tells the user which key is saved.
 */
export function StoredSecretField({
	"aria-label": ariaLabel,
	className,
	invalid,
	maskedValue,
	...props
}: StoredSecretFieldProps) {
	const value = maskedValue ?? STORED_SECRET_VALUE;
	return (
		<div className="relative w-full">
			{/* The mask is a PICTURE of a key, not text worth reading out: an
			    `aria-label` on the input would only set its NAME, leaving the value
			    to be announced character by character as a run of asterisks. So the
			    input is hidden from assistive tech (safe — it is `disabled`, so it
			    holds no focusable descendant) and the caller's label becomes the
			    real announced content, e.g. "Saved key ending in 4f2a". The rejected
			    state is deliberately NOT repeated here; the status pill is the one
			    live region that owns it. */}
			<span className="sr-only">{ariaLabel}</span>
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
				aria-hidden="true"
				aria-invalid={invalid || undefined}
				className={cn(
					"cursor-not-allowed select-none pl-8 font-mono shadow-none ring-1 ring-inset",
					// A bare asterisk run needs the wide letter-spacing to read as a
					// deliberate seal; a prefixed/hinted value is real text and would
					// only overflow at that tracking.
					maskedValue === undefined ? "tracking-[0.3em]" : "tracking-[0.06em]",
					invalid
						? "text-error ring-error"
						: "text-foreground-secondary ring-divider-strong",
					className,
				)}
				disabled
				readOnly
				type="text"
				value={value}
			/>
		</div>
	);
}
