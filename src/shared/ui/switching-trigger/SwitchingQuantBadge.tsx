import { ArrowRight01Icon, BinaryCodeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

interface SwitchingQuantBadgeProps {
	/** Previous precision label (e.g. "FP32"). Omit when unknown — the chip
	 *  degrades to a bare "→ INT8" target. Rendered dim + struck-through. */
	from?: string | null | undefined;
	/** Target precision label (e.g. "INT8"), accent-emphasized. */
	to: string;
}

/**
 * Precision-transition chip for a mid-swap trigger: `[⣿] FP32 → INT8`.
 *
 * Shared by every picker that can hot-swap the quantization of a model (the STT
 * precision shelf, the Ollama quant tags) so a quant change reads the same
 * everywhere — and, crucially, so a PURE same-model quant swap (identical model
 * on both legs) still tells the user exactly which precision is being switched
 * to instead of showing a redundant "model → same model" row.
 *
 * Uses the same `warning` tone + {@link BinaryCodeIcon} as the selected-model
 * quant meta chip so the collapsed and switching states share one visual
 * vocabulary for "precision".
 */
export function SwitchingQuantBadge({ from, to }: SwitchingQuantBadgeProps) {
	return (
		<span
			className="inline-flex shrink-0 items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] leading-none"
			data-slot="switching-quant-badge"
		>
			<HugeiconsIcon
				aria-hidden="true"
				className="size-3 shrink-0 text-warning"
				icon={BinaryCodeIcon}
			/>
			{from ? (
				<>
					<span className="text-foreground-dim line-through decoration-foreground-dim/40">
						{from}
					</span>
					<HugeiconsIcon
						aria-hidden="true"
						className="size-2.5 shrink-0 text-foreground-dim"
						icon={ArrowRight01Icon}
					/>
				</>
			) : null}
			<span className="font-semibold text-warning tabular-nums">{to}</span>
		</span>
	);
}
