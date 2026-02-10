"use client";

import { formatKeyName } from "@/shared/lib/format-key-name";
import { useHotkeyStore } from "../model/hotkey-store";

export function HotkeyDisplay() {
	const isPressed = useHotkeyStore((s) => s.isPressed);
	const accelerator = useHotkeyStore((s) => s.accelerator);
	const keys = accelerator.split("+").map(formatKeyName);

	return (
		<kbd
			className={`inline-flex items-center gap-px rounded border font-mono text-[10px] leading-none transition-all duration-150 ease-in-out ${
				isPressed
					? "border-border-accent bg-accent-dim text-accent shadow-[0_0_8px_rgba(245,158,11,0.12)]"
					: "border-border bg-surface-tertiary text-foreground-secondary"
			}`}
		>
			{keys.map((key, i) => (
				<span className="flex items-center" key={key}>
					{i > 0 && <span className="text-[8px] text-foreground-dim">+</span>}
					<span className="px-1 py-px">{key}</span>
				</span>
			))}
			{isPressed && (
				<span className="mr-1.5 inline-block size-1 animate-recording-pulse rounded-full bg-accent" />
			)}
		</kbd>
	);
}
