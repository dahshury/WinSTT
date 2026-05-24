import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	type AuthorGroup,
	type FamilyKey,
	getAuthorLabel,
	getFamilyConfig,
} from "../lib/family-helpers";

export interface SttFamilyRailProps {
	/** Family currently in view at the top of the scroller (drives the
	 *  active tile highlight). ``null`` while the list is loading. */
	activeFamily: FamilyKey | null;
	/** Filtered author groups — only families that have at least one
	 *  card visible after the menu/search filter are rendered as tiles. */
	groups: readonly AuthorGroup[];
	/** Click handler — selector scrolls the cards to this family. */
	onSelect: (family: FamilyKey) => void;
}

const TILE_BASE = cn(
	"group/tile relative flex h-11 w-11 shrink-0 items-center justify-center rounded-md border transition-colors",
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
);
const TILE_ACTIVE = "border-accent/50 bg-accent/15 text-accent shadow-sm";
const TILE_IDLE = cn(
	"border-transparent text-foreground-muted",
	"hover:bg-surface-hover hover:text-foreground"
);

/**
 * Vertical strip of family icons rendered on the left of the picker
 * popup. Click → scroll the model list to that family; scrolling the
 * model list updates ``activeFamily`` (scroll-spy), so the rail's
 * highlighted tile always reflects what's at the top of the visible
 * model rows.
 *
 * The rail is hidden by the selector when only one family is visible
 * (after filters), since a single-section list doesn't need navigation.
 */
export function SttFamilyRail({ activeFamily, groups, onSelect }: SttFamilyRailProps) {
	return (
		<div
			aria-orientation="vertical"
			className={cn(
				"flex w-12 shrink-0 flex-col self-stretch",
				"border-border/60 border-r bg-surface-secondary/40"
			)}
			role="tablist"
		>
			<div
				className={cn(
					"min-h-0 flex-1 overflow-y-auto",
					"[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				)}
			>
				<div className="flex flex-col items-center gap-1.5 px-1 py-2">
					{groups.map((group) => (
						<RailTile
							family={group.value}
							isActive={group.value === activeFamily}
							key={group.value}
							onSelect={onSelect}
						/>
					))}
				</div>
			</div>
		</div>
	);
}

function RailTile({
	family,
	isActive,
	onSelect,
}: {
	family: FamilyKey;
	isActive: boolean;
	onSelect: (family: FamilyKey) => void;
}) {
	const config = getFamilyConfig(family);
	const author = getAuthorLabel(family);
	return (
		<Tooltip content={`${author} · ${config.label}`} side="right">
			<button
				aria-label={`${author} · ${config.label}`}
				aria-selected={isActive}
				className={cn(TILE_BASE, isActive ? TILE_ACTIVE : TILE_IDLE)}
				onClick={() => onSelect(family)}
				role="tab"
				type="button"
			>
				<span
					className={cn(
						"flex size-6 items-center justify-center rounded",
						isActive ? "" : config.chip
					)}
				>
					<HugeiconsIcon className="size-3.5" icon={config.icon} />
				</span>
			</button>
		</Tooltip>
	);
}
