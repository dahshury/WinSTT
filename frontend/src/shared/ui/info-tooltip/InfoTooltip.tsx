"use client";

import { Tooltip } from "@base-ui/react/tooltip";

export interface InfoTooltipProps {
	/** The help text shown on hover/focus */
	content: string;
}

export function InfoTooltip({ content }: InfoTooltipProps) {
	return (
		<Tooltip.Root>
			<Tooltip.Trigger
				aria-label="More info"
				className="inline-flex cursor-default items-center justify-center rounded-full text-foreground-muted transition-colors hover:text-foreground-secondary focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
			>
				<svg
					aria-hidden="true"
					fill="none"
					height="13"
					stroke="currentColor"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={2}
					viewBox="0 0 24 24"
					width="13"
					xmlns="http://www.w3.org/2000/svg"
				>
					<circle cx="12" cy="12" r="10" />
					<path d="M12 16v-4" />
					<path d="M12 8h.01" />
				</svg>
			</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Positioner sideOffset={6} style={{ zIndex: 200 }}>
					<Tooltip.Popup className="max-w-[260px] origin-(--transform-origin) rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 font-sans text-[11.5px] text-foreground-secondary leading-[16px] shadow-md transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-[instant]:transition-none">
						{content}
					</Tooltip.Popup>
				</Tooltip.Positioner>
			</Tooltip.Portal>
		</Tooltip.Root>
	);
}
