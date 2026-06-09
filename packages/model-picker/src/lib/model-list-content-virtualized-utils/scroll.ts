import type { ScrollToIndexOpts } from "virtua";
import type { VirtualizedItem } from "./items";

export const GROUP_HEADER_SCROLL_OFFSET_PX = 32;

interface ItemSizeHandle {
	getItemOffset: (index: number) => number;
	getItemSize: (index: number) => number;
}

export function findActiveVirtualIndex(
	handle: ItemSizeHandle,
	itemCount: number,
	offset: number,
): number {
	const threshold = offset + 1;
	for (let i = 0; i < itemCount; i++) {
		const start = handle.getItemOffset(i);
		const size = handle.getItemSize(i);
		if (start + size > threshold) {
			return i;
		}
	}
	return itemCount - 1;
}

export function findIndexByModelId(
	items: VirtualizedItem[],
	modelId: string | undefined,
): number {
	if (!modelId) {
		return -1;
	}
	return items.findIndex(
		(item) => item.type === "model" && item.model.id === modelId,
	);
}

export function findIndexByMaker(
	items: VirtualizedItem[],
	maker: string,
): number {
	return items.findIndex((item) => item.sectionId === maker);
}

export interface ScrollRequest {
	maker: string;
	modelId?: string | undefined;
	nonce: number;
	providerSlug?: string | undefined;
}

export function findScrollTargetIndex(
	items: VirtualizedItem[],
	request: ScrollRequest,
): number {
	const byProviderRow =
		request.modelId && request.providerSlug
			? items.findIndex(
					(item) =>
						item.type === "providers" && item.model.id === request.modelId,
				)
			: -1;
	if (byProviderRow >= 0) {
		return byProviderRow;
	}
	const byId = findIndexByModelId(items, request.modelId);
	if (byId >= 0) {
		return byId;
	}
	return findIndexByMaker(items, request.maker);
}

export function getScrollTargetOffset(
	items: VirtualizedItem[],
	targetIndex: number,
): number {
	return items[targetIndex]?.type === "header"
		? 0
		: -GROUP_HEADER_SCROLL_OFFSET_PX;
}

export function resolveActiveMaker(
	items: VirtualizedItem[],
	idx: number,
): string | null {
	return items[idx]?.sectionId ?? null;
}

export function shouldNotifyMaker(
	nextMaker: string | null,
	lastMaker: string | null,
): boolean {
	return nextMaker !== lastMaker;
}

export function isNewScrollNonce(
	lastNonce: number | null,
	nonce: number,
): boolean {
	return lastNonce !== nonce;
}

export function applyVirtualScrollMakerUpdate(
	handle: {
		getItemOffset: (i: number) => number;
		getItemSize: (i: number) => number;
	} | null,
	virtualItems: VirtualizedItem[],
	offset: number,
	lastNotifiedMaker: string | null,
	onActiveMakerChange: ((maker: string | null) => void) | undefined,
): string | null {
	if (!handle || virtualItems.length === 0) {
		return lastNotifiedMaker;
	}
	const activeIdx = findActiveVirtualIndex(handle, virtualItems.length, offset);
	const nextMaker = resolveActiveMaker(virtualItems, activeIdx);
	if (shouldNotifyMaker(nextMaker, lastNotifiedMaker)) {
		onActiveMakerChange?.(nextMaker);
		return nextMaker;
	}
	return lastNotifiedMaker;
}

export function applyScrollToMakerRequest(
	scrollToMakerRequest: ScrollRequest | null | undefined,
	lastNonce: number | null,
	virtualItems: VirtualizedItem[],
	scrollToIndex:
		| ((index: number, opts?: ScrollToIndexOpts) => void)
		| undefined,
): number | null {
	if (!scrollToMakerRequest) {
		return lastNonce;
	}
	if (!isNewScrollNonce(lastNonce, scrollToMakerRequest.nonce)) {
		return lastNonce;
	}
	if (!scrollToIndex) {
		return lastNonce;
	}
	const targetIndex = findScrollTargetIndex(virtualItems, scrollToMakerRequest);
	if (targetIndex < 0) {
		return lastNonce;
	}
	scrollToIndex(targetIndex, {
		align: "start",
		offset: getScrollTargetOffset(virtualItems, targetIndex),
	} satisfies ScrollToIndexOpts);
	return scrollToMakerRequest.nonce;
}
