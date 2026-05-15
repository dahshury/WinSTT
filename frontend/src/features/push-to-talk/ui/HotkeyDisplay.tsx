"use client";

import { useTranslations } from "next-intl";
import { formatKeyName } from "@/shared/lib/format-key-name";
import { Tooltip } from "@/shared/ui/tooltip";
import { useHotkeyStore } from "../model/hotkey-store";

interface HotkeyDisplayProps {
	isConnected: boolean;
}

const FOOTER_TOOLTIP_DELAY = 1500;

const KBD_CLASS_DISCONNECTED =
	"border-border/50 bg-surface-tertiary/50 text-foreground-dim opacity-60";
const KBD_CLASS_PRESSED =
	"border-orange/30 bg-orange-dim text-orange shadow-[0_0_8px_rgba(59,130,246,0.15)]";
const KBD_CLASS_IDLE = "border-border bg-surface-tertiary text-foreground-secondary";

export function resolveKbdClass(isConnected: boolean, isPressed: boolean): string {
	if (!isConnected) {
		return KBD_CLASS_DISCONNECTED;
	}
	if (isPressed) {
		return KBD_CLASS_PRESSED;
	}
	return KBD_CLASS_IDLE;
}

export function HotkeyDisplay({ isConnected }: HotkeyDisplayProps) {
	const isPressed = useHotkeyStore((s) => s.isPressed);
	const accelerator = useHotkeyStore((s) => s.accelerator);
	const keys = accelerator.split("+").map(formatKeyName);
	const t = useTranslations("hotkey");

	const className = resolveKbdClass(isConnected, isPressed);
	const tooltipContent = isConnected ? t("displayTooltip") : t("displayTooltipDisconnected");

	return (
		<Tooltip content={tooltipContent} delay={FOOTER_TOOLTIP_DELAY} side="top">
			<kbd
				className={`inline-flex cursor-help items-center gap-px rounded border font-mono text-2xs leading-none transition-all duration-150 ease-in-out ${className}`}
			>
				{keys.map((key, i) => (
					<span className="flex items-center" key={key}>
						{i > 0 && <span className="text-[8px] text-foreground-dim">+</span>}
						<span className={`px-1 py-px ${isConnected ? "" : "line-through"}`}>{key}</span>
					</span>
				))}
				{isPressed && isConnected && (
					<span className="mr-1.5 inline-block size-1 animate-recording-pulse rounded-full bg-orange" />
				)}
			</kbd>
		</Tooltip>
	);
}
