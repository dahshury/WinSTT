import { useTranslations } from "use-intl";
import { formatKeyName } from "@/shared/lib/format-key-name";
import { Elevated } from "@/shared/lib/surface";
import type { InputGroupTone } from "@/shared/ui/input-group";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	FOOTER_TOOLTIP_DELAY,
	resolveTone,
	TONE_TEXT,
} from "../lib/hotkey-display-helpers";
import { useHotkeyStore } from "../model/hotkey-store";

// Decorative, aria-hidden separator glyph between keycaps — a visual symbol,
// not translatable copy. Held in a constant so it isn't flagged as user-facing.
const PLUS_GLYPH = "＋";

interface HotkeyDisplayProps {
	isConnected: boolean;
	/** Tooltip side. Defaults to "top" (footer placement); pass "bottom" when
	 *  the badge sits at the top edge of a window so the tooltip stays
	 *  on-screen. */
	side?: "top" | "bottom";
}

export function HotkeyDisplay({
	isConnected,
	side = "top",
}: HotkeyDisplayProps) {
	const micPhase = useHotkeyStore((s) => s.micPhase);
	const accelerator = useHotkeyStore((s) => s.accelerator);
	const keys = accelerator.split("+").map(formatKeyName);
	const t = useTranslations("hotkey");

	const tooltipContent = isConnected
		? t("displayTooltip")
		: t("displayTooltipDisconnected");
	// The recording state is conveyed ENTIRELY by how light the badge rectangle is
	// — no dots, no motion. "opening" = the mic is being opened (Windows hasn't
	// confirmed audio yet) → one surface step lighter; "live" = the recorder
	// captured its first frame → full-on, the lightest. Idle rests at the base
	// surface. Lightness is driven by the Elevated surface level (each +1 step is
	// ~+4% L); the shadow is pinned so only the fill brightens.
	const isOpening = micPhase === "opening" && isConnected;
	const isLive = micPhase === "live" && isConnected;
	const isArmed = isOpening || isLive;
	const tone: InputGroupTone = resolveTone(isConnected, isArmed);
	const surfaceOffset = isLive ? 4 : isOpening ? 2 : 1;

	return (
		<Tooltip content={tooltipContent} delay={FOOTER_TOOLTIP_DELAY} side={side}>
			<Elevated
				className={`inline-flex h-4 w-auto max-w-[min(48vw,18rem)] cursor-help items-center overflow-hidden rounded-xs px-1.5 ring-1 transition-colors duration-150 ${
					isLive
						? "ring-foreground/25"
						: isOpening
							? "ring-foreground/15"
							: "ring-divider/60"
				}`}
				data-disconnected={!isConnected || undefined}
				data-phase={isArmed ? micPhase : undefined}
				data-pressed={isArmed || undefined}
				offset={surfaceOffset}
				shadowLevel={1}
			>
				<kbd
					aria-label={tooltipContent}
					className={`inline-flex min-w-0 items-center gap-1 overflow-hidden bg-transparent font-mono text-2xs leading-none ${TONE_TEXT[tone]}`}
					data-disconnected={!isConnected || undefined}
					data-pressed={isArmed || undefined}
					data-tone={tone}
				>
					{keys.map((key, i) => (
						<span
							className="flex min-w-0 items-center gap-1"
							key={`${key}-${i}`}
						>
							{i > 0 && (
								<span aria-hidden className="text-[8px] text-foreground-dim">
									{PLUS_GLYPH}
								</span>
							)}
							<span
								className={`inline-flex min-w-0 items-center justify-center bg-transparent p-0 font-medium shadow-none ring-0 ${
									isConnected ? "" : "line-through decoration-foreground-dim/80"
								}`}
							>
								{key}
							</span>
						</span>
					))}
				</kbd>
			</Elevated>
		</Tooltip>
	);
}
