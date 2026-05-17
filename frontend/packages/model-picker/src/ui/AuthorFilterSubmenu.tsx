"use client";

import { Combobox } from "@base-ui/react/combobox";
import { SparklesIcon, StarIcon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import { useState } from "react";
import { cn } from "@/shared/lib/cn";
import { DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "./DropdownMenu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip";

const AUTHOR_RENDER_LIMIT = 100;

export interface AuthorFilterSubmenuProps {
	allProviders: string[];
	favoriteProviders: string[];
	onMakersChange: (makers: string[]) => void;
	onToggleFavorite?: (maker: string) => void;
	providerCounts: Map<string, number>;
	selectedMakers: string[];
}

function filterByQuery(allProviders: string[], queryLower: string): string[] {
	if (!queryLower) {
		return allProviders;
	}
	return allProviders.filter((p) => p.toLowerCase().includes(queryLower));
}

function getFavoriteTooltipText(isFavorite: boolean): string {
	return isFavorite ? "Remove from favorites" : "Add to favorites";
}

function handleFavoriteButtonClick(
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

function SelectedCountBadge({ count }: CountBadgeProps) {
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
	onToggleFavorite?: (maker: string) => void;
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
	onToggleFavorite?: (maker: string) => void;
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

interface ItemContext {
	favoritesSet: Set<string>;
	onToggleFavorite?: (maker: string) => void;
	providerCounts: Map<string, number>;
	selectedSet: Set<string>;
}

function renderAuthorItem(provider: string, ctx: ItemContext) {
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

export function AuthorFilterSubmenu({
	allProviders,
	providerCounts,
	selectedMakers,
	favoriteProviders,
	onMakersChange,
	onToggleFavorite,
}: AuthorFilterSubmenuProps) {
	const [search, setSearch] = useState("");

	const favoritesSet = new Set(favoriteProviders);
	const selectedSet = new Set(selectedMakers);
	const queryLower = search.toLowerCase();
	const filtered = filterByQuery(allProviders, queryLower);

	const itemCtx: ItemContext = {
		favoritesSet,
		onToggleFavorite,
		providerCounts,
		selectedSet,
	};

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<HugeiconsIcon className="me-2 size-4" icon={SparklesIcon} />
				<span>Model Author</span>
				<SelectedCountBadge count={selectedMakers.length} />
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="w-64 p-0">
				<Combobox.Root
					inline
					items={filtered}
					limit={AUTHOR_RENDER_LIMIT}
					multiple
					onInputValueChange={setSearch}
					onValueChange={(values: string[]) => onMakersChange(values)}
					open
					value={selectedMakers}
				>
					<div className="flex h-full flex-col">
						<div className="p-2">
							<Combobox.Input
								className="h-8 w-full rounded-sm border border-border bg-surface-tertiary px-2.5 font-inherit text-body text-foreground leading-normal outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
								placeholder="Search authors"
							/>
						</div>
						<Combobox.Empty className="py-4 text-center text-body text-foreground-muted">
							No authors found.
						</Combobox.Empty>
						<Combobox.List className="h-64 overflow-y-auto">
							<Combobox.Collection>
								{(provider: string) => renderAuthorItem(provider, itemCtx)}
							</Combobox.Collection>
						</Combobox.List>
					</div>
				</Combobox.Root>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}

export const __author_filter_submenu_test_helpers__ = {
	filterByQuery,
	getFavoriteTooltipText,
	handleFavoriteButtonClick,
	renderAuthorItem,
	SelectedCountBadge,
};
