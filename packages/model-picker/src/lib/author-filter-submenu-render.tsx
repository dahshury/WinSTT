"use client";

import { AuthorComboboxItem } from "./author-filter-submenu-components";
import type { ItemContext } from "./author-filter-submenu-utils";

export function renderAuthorItem(provider: string, ctx: ItemContext) {
	const count = ctx.providerCounts.get(provider) ?? 0;
	return (
		<AuthorComboboxItem
			count={count}
			isFavorite={ctx.favoritesSet.has(provider)}
			isSelected={ctx.selectedSet.has(provider)}
			key={provider}
			onToggleFavorite={ctx.onToggleFavorite}
			provider={provider}
		/>
	);
}
