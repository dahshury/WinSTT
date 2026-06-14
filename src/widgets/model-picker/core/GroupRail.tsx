"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { Grid3X3Icon, StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { cn } from "@/shared/lib/cn";
import {
	SurfaceProvider,
	surfaceBg,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/Tooltip";
import { FAVORITES_GROUP_VALUE } from "./favorites";

export const ALL_AUTHORS_RAIL_ID = "__all_authors__";

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
	/**
	 * Pinned tiles sit at the very top of the rail in their given order and are
	 * never starred or moved into the favorites partition — the special "jump"
	 * tiles (Favorites / Recommended / Sorted) that aren't authors.
	 */
	pinned?: boolean;
	/**
	 * Author tiles are starrable by default. Set `false` for non-author tiles
	 * that should keep their position but show no star and never float into the
	 * favorites partition (e.g. Ollama's "Ollama Library" section + its
	 * per-publisher browse tiles).
	 */
	starrable?: boolean;
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
	favorites?: readonly string[] | undefined;
	/** Tiles to render, in display order. */
	items: readonly GroupRailItem[];
	/** Called when the user clicks a tile — typically scrolls the list. */
	onClick: (id: string) => void;
	/** Called when the user toggles the star button on a tile. */
	onToggleFavorite?: ((id: string) => void) | undefined;
}

const TILE_BASE_CLASSES = cn(
	"group/tile relative flex h-12 w-12 shrink-0 items-center justify-center rounded-md ring-1 transition-colors",
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
);

// Selected tile: the single app accent (tint + accent ring + accent icon) —
// the same restrained selection treatment the model cards use.
const TILE_ACTIVE = "bg-accent/15 text-accent ring-accent/40 shadow-sm";

const STAR_FAVORITED = "text-amber-400 opacity-100";
const STAR_IDLE = cn(
	"text-foreground-muted opacity-0",
	"focus-visible:opacity-100 group-hover/tile:opacity-100",
);

/**
 * Shared vertical group rail for every picker in the package. Replaces the
 * "OpenRouter has a left panel, STT + Ollama don't" disparity — every
 * picker now gets the same maker / family sidebar with the same tile
 * vocabulary, the same active-state styling, the same favorites toggle,
 * and the same click-to-jump affordance.
 *
 * Surfaces: the rail column is transparent (it shares the popup substrate and
 * is delineated only by its end divider); every tile is a surface lifted one
 * step above that substrate, so the provider icons sit *on* a surface of their
 * own instead of floating directly on the rail. Count badge / favorite star /
 * fallback initial each lift a further step so they read as their own small
 * surfaces stacked on the tile, never as bare pills.
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
		const tile = root.querySelector<HTMLElement>(
			`[data-rail-id="${CSS.escape(activeId)}"]`,
		);
		tile?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, [activeId]);

	// Pinned "jump" tiles (Favorites / Recommended / Sorted / Library) always sit
	// at the very top in their given order, never starred or partitioned. The
	// remaining (author) tiles partition into a favorited section + the rest so
	// starred authors float up — the same affordance OpenRouter's maker rail had,
	// now shared by every picker.
	const favoritesSet = new Set(favorites ?? []);
	const isStarredAuthor = (it: GroupRailItem) =>
		it.starrable !== false && favoritesSet.has(it.id);
	const pinnedItems = items.filter((it) => it.pinned);
	const authorItems = items.filter((it) => !it.pinned);
	const favoriteItems = authorItems.filter(isStarredAuthor);
	const otherItems = authorItems.filter((it) => !isStarredAuthor(it));
	const showDivider = favoriteItems.length > 0 && otherItems.length > 0;

	return (
		// Fixed surface baseline so the rail looks IDENTICAL regardless of where the
		// picker is embedded: STT opens in its own (substrate-1) window, while Ollama
		// nests in the LLM settings panel (a higher substrate) — which otherwise made
		// Ollama's author tiles render lighter/washed than STT's. Pinning to 1 yields
		// a recessed surface-1 sidebar with surface-2 tiles in every picker.
		<SurfaceProvider value={1}>
			<div
				aria-orientation="vertical"
				className={cn(
					"flex w-16 shrink-0 flex-col self-stretch border-divider border-e",
					surfaceBg(1),
				)}
				role="tablist"
			>
				<div
					className={cn(
						"min-h-0 flex-1 overflow-y-auto",
						"[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
					)}
					ref={containerRef}
					style={{ WebkitOverflowScrolling: "touch", touchAction: "pan-y" }}
				>
					<div className="flex flex-col items-center gap-2 px-1.5 py-2.5">
						{pinnedItems.map((item) => (
							<GroupRailTile
								isActive={item.id === activeId}
								isFavorited={false}
								item={item}
								key={item.id}
								onClick={onClick}
							/>
						))}
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
							<div
								aria-hidden="true"
								className="my-1 h-px w-7 shrink-0 bg-divider/80"
							/>
						) : null}
						{otherItems.map((item) => (
							<GroupRailTile
								isActive={item.id === activeId}
								isFavorited={false}
								item={item}
								key={item.id}
								onClick={onClick}
								onToggleFavorite={
									item.starrable === false ? undefined : onToggleFavorite
								}
							/>
						))}
					</div>
				</div>
			</div>
		</SurfaceProvider>
	);
}

interface GroupRailTileProps {
	isActive: boolean;
	isFavorited: boolean;
	item: GroupRailItem;
	onClick: (id: string) => void;
	onToggleFavorite?: ((id: string) => void) | undefined;
}

function GroupRailTile({
	isActive,
	isFavorited,
	item,
	onClick,
	onToggleFavorite,
}: GroupRailTileProps) {
	const level = useSurface();
	// Idle tile: its own hairline-ringed surface lifted one step above the rail
	// substrate, brightening another step on hover.
	const idleTile = cn(
		surfaceBg(Math.min(level + 1, 8)),
		surfaceHoverBg(Math.min(level + 2, 8)),
		"text-foreground-muted ring-divider hover:text-foreground hover:ring-border",
	);
	// Corner badge / star lift a couple of steps further so they read as small
	// surfaces stacked on the tile, not bare pills.
	const cornerSurface = surfaceBg(Math.min(level + 3, 8));
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
						<BaseButton
							{...(props as ComponentPropsWithoutRef<"button">)}
							aria-label={item.label}
							aria-selected={isActive}
							className={cn(
								TILE_BASE_CLASSES,
								isActive ? TILE_ACTIVE : idleTile,
							)}
							onClick={() => onClick(item.id)}
							role="tab"
							type="button"
						>
							<span className="flex size-6 items-center justify-center">
								{item.icon ?? <FallbackInitial label={item.label} />}
							</span>
							{item.badge ? (
								<span
									className={cn(
										"absolute -end-1 -bottom-1 z-raised flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-semibold text-[9px] text-foreground-secondary tabular-nums leading-none ring-1 ring-divider",
										cornerSurface,
									)}
								>
									{item.badge}
								</span>
							) : null}
						</BaseButton>
					)}
				/>
				<TooltipContent side="right">{item.label}</TooltipContent>
			</Tooltip>
			{onToggleFavorite ? (
				<BaseButton
					aria-label={
						isFavorited ? `Unfavorite ${item.label}` : `Favorite ${item.label}`
					}
					aria-pressed={isFavorited}
					className={cn(
						"absolute -end-1 -top-1 z-raised flex size-5 items-center justify-center rounded-full shadow-sm ring-1 ring-divider transition-opacity",
						cornerSurface,
						isFavorited ? STAR_FAVORITED : STAR_IDLE,
					)}
					onClick={handleFavoriteClick}
					type="button"
				>
					<HugeiconsIcon
						className={cn("size-3", isFavorited && "fill-amber-400")}
						icon={StarIcon}
					/>
				</BaseButton>
			) : null}
		</div>
	);
}

/**
 * The neutral / favorite "icon chip" every picker drops a Hugeicon into for its
 * non-logo rail tiles (Favorites, Recommended, Sorted, family fallbacks, …).
 * Centralised here so the maker rail looks IDENTICAL across STT / Ollama /
 * OpenRouter: a `size-5 rounded` chip — neutral grey, or amber for the
 * Favorites tile. A semi-transparent foreground tint, so it reads correctly on
 * any tile shade without needing the substrate level.
 */
/**
 * The pinned "All authors" rail tile. Selecting it returns the picker to its
 * normal grouped view (Favorites / sort / sections), while author tiles narrow
 * the list to that author only.
 */
export function buildAllAuthorsRailItem(count: number): GroupRailItem {
	return {
		id: ALL_AUTHORS_RAIL_ID,
		label: "All authors",
		pinned: true,
		starrable: false,
		badge: count,
		icon: (
			<RailIconChip>
				<HugeiconsIcon className="size-3" icon={Grid3X3Icon} />
			</RailIconChip>
		),
	};
}

export function RailIconChip({
	children,
	tone = "neutral",
}: {
	children: ReactNode;
	tone?: "neutral" | "favorite";
}) {
	return (
		<span
			className={cn(
				"flex size-5 items-center justify-center rounded",
				tone === "favorite"
					? "bg-amber-400/[0.12] text-amber-400"
					: "bg-foreground/[0.06] text-foreground-muted",
			)}
		>
			{children}
		</span>
	);
}

/**
 * Fallback when a group has no icon at all — the first letter of the label in
 * the same neutral chip as {@link RailIconChip}, so an iconless tile still
 * matches the rest of the rail instead of standing out as a bare circle.
 */
function FallbackInitial({ label }: { label: string }) {
	const letter = label.trim().charAt(0).toUpperCase() || "?";
	return (
		<span className="flex size-5 items-center justify-center rounded bg-foreground/[0.06] font-semibold text-[11px] text-foreground-secondary">
			{letter}
		</span>
	);
}
