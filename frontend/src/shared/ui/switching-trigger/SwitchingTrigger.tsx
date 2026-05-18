"use client";

import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Spinner } from "@/shared/ui/spinner";

/**
 * Visual vocabulary for "this trigger is mid-swap" applied uniformly to any
 * picker that swaps a backend asset (STT model, Ollama model, future ones).
 * Three composable parts — body row, right-side pill, bottom sweep — plus a
 * className helper to keep the disabled-state opacity override consistent.
 *
 * Each call site keeps its own chip styling (STT uses AuthorChip, Ollama
 * uses PublisherChip) and passes them in via the `from` / `to` slots so the
 * primitive stays agnostic about the underlying model shape.
 */

interface SwitchingFromToRowProps {
	ariaLabel?: string;
	/** Left side — the model being left. Rendered dim + struck-through by the
	 *  caller's chip style. Omit when the swap was server-initiated and no
	 *  prior model is known; the row collapses to `◌ → to`. */
	from?: ReactNode;
	/** Right side — the destination model. Rendered with accent emphasis. */
	to?: ReactNode;
}

/** `[from] → ◌ → [to]` body row. Renders the spinner unconditionally so the
 *  switch reads as "active" even when one leg is unknown. */
export function SwitchingFromToRow({ from, to, ariaLabel }: SwitchingFromToRowProps) {
	return (
		<div
			aria-label={ariaLabel}
			aria-live="polite"
			className="flex min-w-0 flex-1 items-center gap-1.5"
			data-slot="switching-from-to"
			role="status"
		>
			{from ? (
				<>
					{from}
					<HugeiconsIcon
						aria-hidden="true"
						className="size-3 shrink-0 text-foreground-dim"
						icon={ArrowRight01Icon}
					/>
				</>
			) : null}
			<Spinner className="size-3.5 shrink-0 border-accent/30 border-t-accent" />
			{to ? (
				<>
					<HugeiconsIcon
						aria-hidden="true"
						className="size-3 shrink-0 text-accent"
						icon={ArrowRight01Icon}
					/>
					{to}
				</>
			) : null}
		</div>
	);
}

/** Compact uppercase pill (accent-glow background, pulsing dot, mono caps)
 *  intended to replace the trigger's chevron on the right edge while a swap
 *  is in flight. Single, calm state indicator — the bottom sweep carries the
 *  motion. */
export function SwitchingPill({ label = "Switching" }: { label?: string }) {
	return (
		<span className="ms-2 inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-glow px-2 py-0.5 font-mono font-semibold text-[10px] text-accent uppercase tracking-[0.12em]">
			<span className="size-1.5 animate-pulse rounded-full bg-accent" />
			{label}
		</span>
	);
}

/** Continuously sweeping accent bar pinned to the parent's bottom edge.
 *  Requires the parent to be `position: relative` and `overflow: hidden`. */
export function SwapSweepBar() {
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden bg-accent/15"
		>
			<span className="block h-full w-1/2 animate-swap-sweep bg-gradient-to-r from-transparent via-accent to-transparent" />
		</span>
	);
}

/** Suffix appended to a trigger's base className. Centralizes the
 *  disabled-opacity rule (override to full when switching, otherwise 50% as
 *  the disabled default) plus the accent tint that signals "active swap". */
export function buildSwitchingClassName(isSwitching: boolean): string {
	return isSwitching
		? "from-[oklch(62%_0.19_260/0.10)]! to-[var(--color-surface-2)]/95! opacity-100! ring-accent/40!"
		: "disabled:opacity-50";
}
