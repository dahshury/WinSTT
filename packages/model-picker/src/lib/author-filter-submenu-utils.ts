export function filterByQuery(
	allProviders: string[],
	queryLower: string,
): string[] {
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
	onToggleFavorite: (maker: string) => void,
): void {
	event.stopPropagation();
	onToggleFavorite(provider);
}

export interface ItemContext {
	favoritesSet: Set<string>;
	onToggleFavorite?: ((maker: string) => void) | undefined;
	providerCounts: Map<string, number>;
	selectedSet: Set<string>;
}
