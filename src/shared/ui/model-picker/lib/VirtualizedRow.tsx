import type { VirtualizedItem } from "./model-list-content-virtualized-utils/items";
import { ModelHeader } from "./model-list-model-header";
import { ProvidersRow } from "./model-list-provider-grid";
import { SectionHeader } from "./SectionHeader";

export function VirtualizedRow({
	item,
	parsedModelId,
	parsedProviderSlug,
	onToggleModelExpanded,
	onSelectModel,
	isFavoriteModel,
	onToggleModelFavorite,
}: {
	item: VirtualizedItem;
	parsedModelId: string | undefined;
	parsedProviderSlug: string | undefined;
	onToggleModelExpanded: (modelId: string, nextOpen?: boolean) => void;
	onSelectModel: (modelId: string | undefined, providerSlug?: string) => void;
	isFavoriteModel?: ((id: string) => boolean) | undefined;
	onToggleModelFavorite?: ((id: string) => void) | undefined;
}) {
	if (item.type === "header") {
		return (
			<SectionHeader
				count={item.count}
				label={item.label}
				sectionId={item.sectionId}
			/>
		);
	}
	if (item.type === "model") {
		return (
			<div key={`model-${item.model.id}`}>
				<ModelHeader
					hasProviders={item.hasProviders}
					isExpanded={item.isExpanded}
					isFavorite={isFavoriteModel}
					model={item.model}
					onToggleExpanded={onToggleModelExpanded}
					onToggleFavorite={onToggleModelFavorite}
					parsedModelId={parsedModelId}
					parsedProviderSlug={parsedProviderSlug}
				/>
			</div>
		);
	}
	return (
		<div key={`providers-${item.model.id}`}>
			<ProvidersRow
				endpoints={item.endpoints}
				isOpen={item.isOpen}
				model={item.model}
				onSelectModel={onSelectModel}
				parsedModelId={parsedModelId}
				parsedProviderSlug={parsedProviderSlug}
			/>
		</div>
	);
}
