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
	ariaLabel?: string | undefined;
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
		<output
			aria-label={ariaLabel}
			aria-live="polite"
			className="flex min-w-0 flex-1 items-center gap-1.5"
			data-slot="switching-from-to"
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
		</output>
	);
}
