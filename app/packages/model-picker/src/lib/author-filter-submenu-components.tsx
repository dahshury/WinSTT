"use client";

import { Combobox } from "@base-ui/react/combobox";
import { StarIcon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/Tooltip";
import { getFavoriteTooltipText, handleFavoriteButtonClick } from "./author-filter-submenu-utils";

interface SelectedTickProps {
	isSelected: boolean;
}

export function SelectedTick({ isSelected }: SelectedTickProps) {
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
		<span className="ml-auto rounded-full bg-foreground/[0.10] px-1.5 py-0.5 text-foreground-secondary text-xs-tight tabular-nums">
			{count}
		</span>
	);
}

interface FavoriteToggleButtonProps {
	isFavorite: boolean;
	onToggleFavorite?: ((maker: string) => void) | undefined;
	provider: string;
}

export function FavoriteToggleButton({
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

export function AuthorComboboxItem({
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
