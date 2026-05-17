"use client";

import { StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/Tooltip";

/**
 * A single rail tile descriptor. Pickers compute these from their own
 * grouping function (maker for OpenRouter, family for STT + Ollama) and
 * supply their own icon node — the rail itself doesn't know about
 * provider PNGs vs Hugeicons vs initial letters.
 */
export interface GroupRailItem {
	/** Optional badge in the tile's top-right (e.g. model count). Tiny. */
	badge?: ReactNode;
	/** Icon node (PNG `<img>`, Hugeicon, initial letter — caller's choice). */
	icon?: ReactNode;
	/** Stable id used by `activeId` + onClick. Usually a slug. */
	id: string;
	/** Tooltip label shown on hover. */
	label: string;
}

export interface GroupRailProps {
	/** Currently-active group id (selected model's group, or null). */
	activeId: string | null;
	/**
	 * Optional set of "favorited" group ids. When supplied, the rail
	 * partitions into a favorites section at top + the rest below, and
	 * renders a star toggle on every tile. Mirrors the OpenRouter picker's
	 * existing rail behavior so consumers don't lose that feature when
	 * they adopt the shared rail.
	 */
	favorites?: readonly string[];
	/** Tiles to render, in display order. */
	items: readonly GroupRailItem[];
	/** Called when the user clicks a tile — typically scrolls the list. */
	onClick: (id: string) => void;
	/** Called when the user toggles the star button on a tile. */
	onToggleFavorite?: (id: string) => void;
}

const TILE_BASE_CLASSES = cn(
	"group/tile relative flex h-11 w-11 shrink-0 items-center justify-center rounded-md border transition-colors",
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
);

const TILE_ACTIVE = "border-accent/50 bg-accent/15 text-accent shadow-sm";
const TILE_IDLE = cn(
	"border-transparent text-foreground-muted",
	"hover:bg-[var(--color-surface-2)]/60 hover:text-foreground"
);

const STAR_FAVORITED = "text-amber-500 opacity-100";
const STAR_IDLE = cn(
	"text-foreground-muted opacity-0",
	"focus-visible:opacity-100 group-hover/tile:opacity-100"
);

/**
 * Shared vertical group rail for every picker in the package. Replaces the
 * "OpenRouter has a left panel, STT + Ollama don't" disparity — every
 * picker now gets the same maker / family sidebar with the same tile
 * vocabulary, the same active-state styling, the same favorites toggle,
 * and the same click-to-jump affordance.
 */
export function GroupRail({
	activeId,
	favorites,
	items,
	onClick,
	onToggleFavorite,
}: GroupRailProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const root = containerRef.current;
		if (!(root && activeId)) {
			return;
		}
		const tile = root.querySelector<HTMLElement>(`[data-rail-id="${CSS.escape(activeId)}"]`);
		tile?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, [activeId]);

	const favoritesSet = new Set(favorites ?? []);
	const hasFavorites = favoritesSet.size > 0;
	const favoriteItems = hasFavorites ? items.filter((it) => favoritesSet.has(it.id)) : [];
	const otherItems = hasFavorites ? items.filter((it) => !favoritesSet.has(it.id)) : items;
	const showDivider = favoriteItems.length > 0 && otherItems.length > 0;

	return (
		<div
			aria-orientation="vertical"
			className={cn(
				"flex w-14 shrink-0 flex-col self-stretch",
				"border-divider border-e bg-[var(--color-surface-1)]/40"
			)}
			role="tablist"
		>
			<div
				className={cn(
					"min-h-0 flex-1 overflow-y-auto",
					"[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				)}
				ref={containerRef}
				style={{ WebkitOverflowScrolling: "touch", touchAction: "pan-y" }}
			>
				<div className="flex flex-col items-center gap-1.5 px-1 py-2">
					{favoriteItems.map((item) => (
						<GroupRailTile
							isActive={item.id === activeId}
							isFavorited
							item={item}
							key={item.id}
							onClick={onClick}
							onToggleFavorite={onToggleFavorite}
						/>
					))}
					{showDivider ? (
						<div aria-hidden="true" className="my-1 h-px w-7 shrink-0 bg-divider/80" />
					) : null}
					{otherItems.map((item) => (
						<GroupRailTile
							isActive={item.id === activeId}
							isFavorited={false}
							item={item}
							key={item.id}
							onClick={onClick}
							onToggleFavorite={onToggleFavorite}
						/>
					))}
				</div>
			</div>
		</div>
	);
}

interface GroupRailTileProps {
	isActive: boolean;
	isFavorited: boolean;
	item: GroupRailItem;
	onClick: (id: string) => void;
	onToggleFavorite?: (id: string) => void;
}

function GroupRailTile({
	isActive,
	isFavorited,
	item,
	onClick,
	onToggleFavorite,
}: GroupRailTileProps) {
	const handleFavoriteClick = (event: React.MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		onToggleFavorite?.(item.id);
	};
	return (
		<div className="group/tile relative shrink-0" data-rail-id={item.id}>
			<Tooltip>
				<TooltipTrigger
					render={(props) => (
						<button
							{...(props as ComponentPropsWithoutRef<"button">)}
							aria-label={item.label}
							aria-selected={isActive}
							className={cn(TILE_BASE_CLASSES, isActive ? TILE_ACTIVE : TILE_IDLE)}
							onClick={() => onClick(item.id)}
							role="tab"
							type="button"
						>
							<span className="flex size-6 items-center justify-center">
								{item.icon ?? <FallbackInitial label={item.label} />}
							</span>
							{item.badge ? (
								<span className="absolute -end-1 -bottom-1 z-raised flex h-4 min-w-4 items-center justify-center rounded-full border border-divider bg-[var(--color-surface-2)] px-1 font-semibold text-[9px] text-foreground-secondary tabular-nums leading-none">
									{item.badge}
								</span>
							) : null}
						</button>
					)}
				/>
				<TooltipContent side="right">{item.label}</TooltipContent>
			</Tooltip>
			{onToggleFavorite ? (
				<button
					aria-label={isFavorited ? `Unfavorite ${item.label}` : `Favorite ${item.label}`}
					aria-pressed={isFavorited}
					className={cn(
						"absolute -end-1 -top-1 z-raised flex size-5 items-center justify-center rounded-full border border-divider bg-[var(--color-surface-2)] shadow-sm transition-opacity",
						isFavorited ? STAR_FAVORITED : STAR_IDLE
					)}
					onClick={handleFavoriteClick}
					type="button"
				>
					<HugeiconsIcon
						className={cn("size-3", isFavorited && "fill-amber-500")}
						icon={StarIcon}
					/>
				</button>
			) : null}
		</div>
	);
}

/**
 * Fallback when a group has no provider icon — use the first letter of
 * the label inside a tinted circle. Keeps the rail visually balanced
 * (Ollama families don't ship with logos, so most tiles get this).
 */
function FallbackInitial({ label }: { label: string }) {
	const letter = label.trim().charAt(0).toUpperCase() || "?";
	return (
		<span className="flex size-5 items-center justify-center rounded-full bg-[var(--color-surface-3)] font-semibold text-[11px] text-foreground-secondary">
			{letter}
		</span>
	);
}
