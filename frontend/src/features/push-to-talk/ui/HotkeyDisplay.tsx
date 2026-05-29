import { useTranslations } from "use-intl";
import { formatKeyName } from "@/shared/lib/format-key-name";
import type { InputGroupTone } from "@/shared/ui/input-group";
import { Tooltip } from "@/shared/ui/tooltip";
import { FOOTER_TOOLTIP_DELAY, resolveTone, TONE_TEXT } from "../lib/hotkey-display-helpers";
import { useHotkeyStore } from "../model/hotkey-store";

interface HotkeyDisplayProps {
	isConnected: boolean;
	/** Tooltip side. Defaults to "top" (footer placement); pass "bottom" when
	 *  the badge sits at the top edge of a window so the tooltip stays
	 *  on-screen. */
	side?: "top" | "bottom";
}

export function HotkeyDisplay({ isConnected, side = "top" }: HotkeyDisplayProps) {
	const isPressed = useHotkeyStore((s) => s.isPressed);
	const accelerator = useHotkeyStore((s) => s.accelerator);
	const keys = accelerator.split("+").map(formatKeyName);
	const t = useTranslations("hotkey");

	const tooltipContent = isConnected ? t("displayTooltip") : t("displayTooltipDisconnected");
	const tone: InputGroupTone = resolveTone(isConnected, isPressed);
	const showPulse = isPressed && isConnected;

	return (
		<Tooltip content={tooltipContent} delay={FOOTER_TOOLTIP_DELAY} side={side}>
			<div className="inline-flex cursor-help">
				<kbd
					aria-label={tooltipContent}
					className={`inline-flex items-center gap-1 bg-transparent px-1 py-[1px] font-mono text-2xs leading-none ${TONE_TEXT[tone]}`}
					data-disconnected={!isConnected || undefined}
					data-pressed={showPulse || undefined}
					data-tone={tone}
				>
					{keys.map((key, i) => (
						<span className="flex items-center gap-1" key={key}>
							{i > 0 && (
								<span aria-hidden className="text-[8px] text-foreground-dim">
									＋
								</span>
							)}
							<kbd
								className={`rounded-[4px] bg-surface-1/60 px-1 py-px ring-1 ring-divider/60 ${
									isConnected ? "" : "line-through"
								}`}
							>
								{key}
							</kbd>
						</span>
					))}
					{showPulse && (
						<span
							aria-hidden
							className="ml-0.5 inline-block size-1.5 animate-recording-pulse rounded-full bg-accent shadow-[0_0_6px_1px_var(--color-accent-glow-strong)]"
						/>
					)}
				</kbd>
			</div>
		</Tooltip>
	);
}
