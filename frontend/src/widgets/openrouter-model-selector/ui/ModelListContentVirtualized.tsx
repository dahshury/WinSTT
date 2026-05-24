import { Combobox } from "@base-ui/react/combobox";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { VList, type VListHandle } from "virtua";
import type { OpenRouterModel } from "@/shared/api/models";
import {
	applyScrollToMakerRequest,
	applyVirtualScrollMakerUpdate,
	buildVirtualItems,
	EmptyState,
	getRowKey,
	VirtualizedRow,
} from "../lib/model-list-content-virtualized-test-helpers";

export interface ModelListContentVirtualizedProps {
	expandedModels: Set<string>;
	groupedModels: [string, OpenRouterModel[]][];
	hasActiveFilters: boolean;
	onActiveMakerChange?: ((maker: string | null) => void) | undefined;
	onSelectModel: (modelId: string | undefined, providerSlug?: string) => void;
	onToggleModelExpanded: (modelId: string, nextOpen?: boolean) => void;
	parsedModelId: string | undefined;
	parsedProviderSlug: string | undefined;
	scrollToMakerRequest?:
		| {
				maker: string;
				modelId?: string | undefined;
				nonce: number;
		  }
		| null
		| undefined;
}

export const ModelListContentVirtualized = memo(function ModelListContentVirtualized({
	groupedModels,
	expandedModels,
	parsedModelId,
	parsedProviderSlug,
	onToggleModelExpanded,
	onSelectModel,
	hasActiveFilters,
	scrollToMakerRequest,
	onActiveMakerChange,
}: ModelListContentVirtualizedProps): ReactNode {
	const virtualizerHandleRef = useRef<VListHandle>(null);

	const virtualItems = useMemo(
		() => buildVirtualItems(groupedModels, expandedModels),
		[groupedModels, expandedModels]
	);

	const onActiveMakerChangeRef = useRef(onActiveMakerChange);
	onActiveMakerChangeRef.current = onActiveMakerChange;
	const lastNotifiedMakerRef = useRef<string | null>(null);
	const handleVirtualScroll = useCallback(
		(offset: number) => {
			lastNotifiedMakerRef.current = applyVirtualScrollMakerUpdate(
				virtualizerHandleRef.current,
				virtualItems,
				offset,
				lastNotifiedMakerRef.current,
				onActiveMakerChangeRef.current
			);
		},
		[virtualItems]
	);

	const lastNonceRef = useRef<number | null>(null);
	useEffect(() => {
		lastNonceRef.current = applyScrollToMakerRequest(
			scrollToMakerRequest,
			lastNonceRef.current,
			virtualItems,
			virtualizerHandleRef.current?.scrollToIndex
		);
	}, [scrollToMakerRequest, virtualItems]);

	if (groupedModels.length === 0) {
		return (
			<Combobox.List
				className="min-h-0 flex-1 overflow-hidden p-0"
				data-slot="model-list-content"
				data-state="empty"
			>
				<div className="flex items-center justify-center p-8">
					<EmptyState hasActiveFilters={hasActiveFilters} />
				</div>
			</Combobox.List>
		);
	}

	return (
		<Combobox.List
			className="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
			data-slot="model-list-content"
		>
			<VList
				className="min-h-0 flex-1 overscroll-contain"
				data-slot="model-list-scroll-container"
				onScroll={handleVirtualScroll}
				ref={virtualizerHandleRef}
				style={{ touchAction: "pan-y", WebkitOverflowScrolling: "touch" }}
			>
				{virtualItems.map((item) => (
					<VirtualizedRow
						item={item}
						key={getRowKey(item)}
						onSelectModel={onSelectModel}
						onToggleModelExpanded={onToggleModelExpanded}
						parsedModelId={parsedModelId}
						parsedProviderSlug={parsedProviderSlug}
					/>
				))}
			</VList>
		</Combobox.List>
	);
});
