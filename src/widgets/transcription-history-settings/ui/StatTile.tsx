import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { surfaceBg, useSurface } from "@/shared/lib/surface";

export interface StatTileData {
	icon: IconSvgElement;
	label: string;
	unit?: string | undefined;
	value: string;
}

interface StatTileProps extends StatTileData {
	/** Stagger ordinal — drives the fade-in delay so tiles cascade in. */
	index: number;
}

/**
 * One muted, fluidfunctionalism-grayscale stat tile: a neutral surface lifted a
 * single step above its section, with the icon chip lifted one step further so
 * it reads as its own surface rather than a tinted badge. Shared by the
 * History "Overall Stats" summary and the "AI Impact" section so both rows are
 * pixel-identical — no per-tile hue, coloured rail, or gradient wash.
 */
export function StatTile({ icon, label, unit, value, index }: StatTileProps) {
	const substrate = useSurface();
	const tileBg = surfaceBg(Math.min(substrate + 1, 8));
	const chipBg = surfaceBg(Math.min(substrate + 2, 8));

	return (
		<div
			className={`group relative overflow-hidden rounded-lg border border-divider ${tileBg} opacity-0 shadow-surface-2 transition-[border-color,transform,box-shadow] duration-200 hover:-translate-y-px hover:border-border-hover hover:shadow-md`}
			style={{ animation: `fade-in 320ms ease-out ${index * 70}ms forwards` }}
		>
			<div className="flex flex-col gap-2 px-2.5 py-2.5">
				<div className="flex items-center gap-2">
					<div
						className={`flex size-[22px] shrink-0 items-center justify-center rounded-md ring-1 ring-inset ring-divider ${chipBg}`}
					>
						<HugeiconsIcon
							aria-hidden
							className="text-foreground-muted"
							icon={icon}
							size={12}
							strokeWidth={1.75}
						/>
					</div>
					<div className="line-clamp-2 min-w-0 break-words font-mono text-[9.5px] text-foreground-muted uppercase leading-[1.25] tracking-[0.08em]">
						{label}
					</div>
				</div>
				<div className="flex items-baseline gap-1">
					<span className="font-mono font-semibold text-[18px] text-foreground tabular-nums leading-none tracking-tight">
						{value}
					</span>
					{unit ? (
						<span className="font-mono text-[9.5px] text-foreground-muted uppercase tracking-[0.1em]">
							{unit}
						</span>
					) : null}
				</div>
			</div>
		</div>
	);
}
