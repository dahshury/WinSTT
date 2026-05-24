"use client";

import { Combobox } from "@base-ui/react/combobox";
import { StarIcon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/Tooltip";

export function filterByQuery(allProviders: string[], queryLower: string): string[] {
	if (!queryLower) {
		return allProviders;
	}
	return allProviders.filter((p) => p.toLowerCase().includes(queryLower));
}

export function getFavoriteTooltipText(isFavorite: boolean): string {
	return isFavorite ? "Remove from favorites" : "Add to favorites";
}

export function handleFavoriteButtonClick(
	event: React.MouseEvent,
	provider: string,
	onToggleFavorite: (maker: string) => void
): void {
	event.stopPropagation();
	onToggleFavorite(provider);
}

interface SelectedTickProps {
	isSelected: boolean;
}

function SelectedTick({ isSelected }: SelectedTickProps) {
	if (!isSelected) {
		return null;
	}
	return <HugeiconsIcon className="ms-2 size-4 text-accent" icon={Tick01Icon} />;
}

interface CountBadgeProps {
	count: number;
}

export function SelectedCountBadge({ count }: CountBadgeProps) {
	if (count <= 0) {
		return null;
	}
	return (
		<span className="ml-auto rounded-full bg-accent px-1.5 py-0.5 text-foreground text-xs-tight">
			{count}
		</span>
	);
}

interface FavoriteToggleButtonProps {
	isFavorite: boolean;
	onToggleFavorite?: ((maker: string) => void) | undefined;
	provider: string;
}

function FavoriteToggleButton({
	isFavorite,
	onToggleFavorite,
	provider,
}: FavoriteToggleButtonProps) {
	if (!onToggleFavorite) {
		return null;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<button
						{...(props as ComponentPropsWithoutRef<"button">)}
						className="ms-2 inline-flex size-5 items-center justify-center rounded-sm p-0 opacity-50 hover:opacity-100"
						onClick={(e) => handleFavoriteButtonClick(e, provider, onToggleFavorite)}
						type="button"
					>
						<HugeiconsIcon
							className={cn("size-3", isFavorite && "fill-amber-400 text-amber-400")}
							icon={StarIcon}
						/>
					</button>
				)}
			/>
			<TooltipContent>{getFavoriteTooltipText(isFavorite)}</TooltipContent>
		</Tooltip>
	);
}

interface AuthorComboboxItemProps {
	count: number;
	isFavorite: boolean;
	isSelected: boolean;
	onToggleFavorite?: ((maker: string) => void) | undefined;
	provider: string;
}

function AuthorComboboxItem({
	count,
	isFavorite,
	isSelected,
	onToggleFavorite,
	provider,
}: AuthorComboboxItemProps) {
	return (
		<Combobox.Item
			className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-body outline-none data-[highlighted]:bg-surface-hover"
			key={provider}
			value={provider}
		>
			<span className="flex-1">{provider}</span>
			<SelectedTick isSelected={isSelected} />
			<span className="text-2xs text-foreground-muted">({count})</span>
			<FavoriteToggleButton
				isFavorite={isFavorite}
				onToggleFavorite={onToggleFavorite}
				provider={provider}
			/>
		</Combobox.Item>
	);
}

export interface ItemContext {
	favoritesSet: Set<string>;
	onToggleFavorite?: ((maker: string) => void) | undefined;
	providerCounts: Map<string, number>;
	selectedSet: Set<string>;
}

export function renderAuthorItem(provider: string, ctx: ItemContext) {
	const count = ctx.providerCounts.get(provider) ?? 0;
	return (
		<AuthorComboboxItem
			count={count}
			isFavorite={ctx.favoritesSet.has(provider)}
			isSelected={ctx.selectedSet.has(provider)}
			onToggleFavorite={ctx.onToggleFavorite}
			provider={provider}
		/>
	);
}

export const __author_filter_submenu_test_helpers__ = {
	filterByQuery,
	getFavoriteTooltipText,
	handleFavoriteButtonClick,
	renderAuthorItem,
	SelectedCountBadge,
};
