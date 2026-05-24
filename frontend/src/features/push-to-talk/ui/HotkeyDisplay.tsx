import { useTranslations } from "next-intl";
import { formatKeyName } from "@/shared/lib/format-key-name";
import type { InputGroupTone } from "@/shared/ui/input-group";
import { Tooltip } from "@/shared/ui/tooltip";
import { useHotkeyStore } from "../model/hotkey-store";

interface HotkeyDisplayProps {
	isConnected: boolean;
}

const FOOTER_TOOLTIP_DELAY = 1500;

const TONE_TEXT: Record<InputGroupTone, string> = {
	default: "text-foreground",
	active: "text-foreground",
	danger: "text-error",
	muted: "text-foreground-dim opacity-70",
};

export function resolveTone(isConnected: boolean, isPressed: boolean): InputGroupTone {
	if (!isConnected) {
		return "muted";
	}
	if (isPressed) {
		return "active";
	}
	return "default";
}

export function HotkeyDisplay({ isConnected }: HotkeyDisplayProps) {
	const isPressed = useHotkeyStore((s) => s.isPressed);
	const accelerator = useHotkeyStore((s) => s.accelerator);
	const keys = accelerator.split("+").map(formatKeyName);
	const t = useTranslations("hotkey");

	const tooltipContent = isConnected ? t("displayTooltip") : t("displayTooltipDisconnected");
	const tone: InputGroupTone = resolveTone(isConnected, isPressed);
	const showPulse = isPressed && isConnected;

	return (
		<Tooltip content={tooltipContent} delay={FOOTER_TOOLTIP_DELAY} side="top">
			<div className="inline-flex cursor-help">
				{/* biome-ignore lint/a11y/useSemanticElements: keeps the chip flat — a <fieldset> would add native form styling/inset border that re-introduces the embossed look the footer is trying to avoid */}
				<div
					aria-label={tooltipContent}
					className={`inline-flex items-center gap-1 bg-transparent px-1 py-[1px] text-2xs leading-none ${TONE_TEXT[tone]}`}
					data-disconnected={!isConnected || undefined}
					data-pressed={showPulse || undefined}
					data-tone={tone}
					role="group"
				>
					<kbd className="inline-flex items-center gap-1 font-mono text-2xs leading-none">
						{keys.map((key, i) => (
							<span className="flex items-center gap-1" key={key}>
								{i > 0 && (
									<span aria-hidden className="text-[8px] text-foreground-dim">
										＋
									</span>
								)}
								<span
									className={`rounded-[4px] bg-surface-1/60 px-1 py-px ring-1 ring-divider/60 ${
										isConnected ? "" : "line-through"
									}`}
								>
									{key}
								</span>
							</span>
						))}
					</kbd>
					{showPulse && (
						<span
							aria-hidden
							className="ml-0.5 inline-block size-1.5 animate-recording-pulse rounded-full bg-accent shadow-[0_0_6px_1px_var(--color-accent-glow-strong)]"
						/>
					)}
				</div>
			</div>
		</Tooltip>
	);
}
