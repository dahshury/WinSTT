import type { ReactNode } from "react";
import { OptionBadge } from "./option-badge";

/**
 * Inner content of a grouped-mode section header — an optional leading icon
 * (e.g. a provider brand mark), the uppercase label, plus an optional trailing
 * badge carrying the group's short code (engine / provider / country). Wrapped
 * by each picker in its own header element (`Select` uses `Menu.GroupLabel`,
 * `SearchableSelect` a sticky `Combobox.GroupLabel`) so the two read as one
 * family while keeping their layer-specific chrome.
 */
export function GroupHeaderContent({
	badge,
	icon,
	label,
}: {
	badge?: string | undefined;
	icon?: ReactNode;
	label: string;
}) {
	return (
		<>
			{icon ? (
				<span
					aria-hidden="true"
					className="flex shrink-0 items-center text-foreground-muted"
				>
					{icon}
				</span>
			) : null}
			<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold text-[11px] text-foreground-muted uppercase tracking-[0.12em]">
				{label}
			</span>
			{badge ? <OptionBadge text={badge} /> : null}
		</>
	);
}
