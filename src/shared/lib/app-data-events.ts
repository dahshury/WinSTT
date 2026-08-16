/**
 * Renderer-local notification that one app-data category was just wiped from
 * disk.
 *
 * A category removal deletes FILES, but several features hold their own
 * in-memory (and localStorage-mirrored) record of what those files are. Left
 * alone, such a record outlives the audio or database it names and the feature
 * goes on offering entries that can only fail — which is exactly the incoherence
 * the removal was meant to resolve.
 *
 * A DOM event rather than a store import: the About tab must not reach into
 * another widget's model, and the owner of each record is the only thing that
 * knows how to drop it. Same-document only, which is enough — every owner
 * mirrors through localStorage, so a second window learns about the change from
 * the `storage` event that mirror write fires.
 */
export const APP_DATA_CATEGORY_REMOVED = "winstt:app-data-category-removed";

export interface AppDataCategoryRemovedDetail {
	/** The category key the backend was asked to remove (`voices`, `stt`, …). */
	key: string;
}

export function emitAppDataCategoryRemoved(key: string): void {
	if (typeof window === "undefined") {
		return;
	}
	window.dispatchEvent(
		new CustomEvent<AppDataCategoryRemovedDetail>(APP_DATA_CATEGORY_REMOVED, {
			detail: { key },
		}),
	);
}

/** Subscribe to removals of ONE category. Returns the unsubscribe. */
export function onAppDataCategoryRemoved(
	key: string,
	handler: () => void,
): () => void {
	if (typeof window === "undefined") {
		return () => undefined;
	}
	const listener = (event: Event): void => {
		if (
			(event as CustomEvent<AppDataCategoryRemovedDetail>).detail?.key === key
		) {
			handler();
		}
	};
	window.addEventListener(APP_DATA_CATEGORY_REMOVED, listener);
	return () => window.removeEventListener(APP_DATA_CATEGORY_REMOVED, listener);
}
