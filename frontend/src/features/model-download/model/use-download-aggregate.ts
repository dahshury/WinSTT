import { useDownloadStore } from "./download-store";

/**
 * Aggregate view of every in-flight download in ``quantDownloads`` plus the
 * legacy singleton slot. Consumed by the model-selector trigger AND the
 * main window's status-bar chip so both surfaces show consistent
 * "Downloading N items · X%" chrome when more than one ``(model, quant)``
 * is streaming at once.
 *
 * Design notes:
 *
 * - Server-side, :class:`StreamingDownloadRegistry` already keys one
 *   :class:`DownloadController` per ``(model_id, quantization)`` on its own
 *   daemon thread — parallel downloads are a supported primitive, not a
 *   hack — so the renderer just needs to render the resulting fan-out
 *   without collapsing entries.
 * - ``primary`` is the entry the single-download view should render (its
 *   modelId + percent). Picking the highest-progress download as primary
 *   means the user gets a "we're close" signal on the chip even when a
 *   long-tail download is co-pending; ties fall back to the first entry
 *   in iteration order so the chip doesn't flicker between identical
 *   percents.
 * - ``averagePercent`` is the mean of every download with a known percent
 *   (entries still in their indeterminate first-tick window are skipped),
 *   rounded to a whole number for stable tabular display. ``null`` when
 *   every active download is still indeterminate.
 */
export interface DownloadAggregate {
	/** Mean percent across every download with a known percent; null when
	 *  all active downloads are still indeterminate. */
	averagePercent: number | null;
	/** Count of in-flight downloads (per-quant + the legacy singleton). */
	count: number;
	/** The download to show in the "single-item" view — highest progress,
	 *  ties broken by iteration order. */
	primary: { modelId: string; percent: number | null };
}

/**
 * Pick the entry with the highest known percent — ties break on first
 * iteration order. Entries with ``null`` percent rank below any numeric
 * percent so the chip doesn't lock onto an indeterminate download when
 * one's already reporting bytes.
 */
function pickPrimary(entries: { modelId: string; percent: number | null }[]): {
	modelId: string;
	percent: number | null;
} {
	let best = entries[0];
	if (best === undefined) {
		throw new Error("pickPrimary called with no entries");
	}
	for (let i = 1; i < entries.length; i += 1) {
		const candidate = entries[i];
		if (candidate === undefined) {
			continue;
		}
		const bestPct = best.percent ?? -1;
		const candidatePct = candidate.percent ?? -1;
		if (candidatePct > bestPct) {
			best = candidate;
		}
	}
	return best;
}

export function useDownloadAggregate(): DownloadAggregate | null {
	const quantDownloads = useDownloadStore((s) => s.quantDownloads);
	const singletonName = useDownloadStore((s) => s.modelName);
	const singletonActive = useDownloadStore((s) => s.isDownloading);
	const singletonPercent = useDownloadStore((s) => s.progress);

	const entries: { modelId: string; percent: number | null }[] = [];
	if (singletonActive && singletonName !== null) {
		entries.push({ modelId: singletonName, percent: singletonPercent });
	}
	for (const key in quantDownloads) {
		if (!Object.hasOwn(quantDownloads, key)) {
			continue;
		}
		const entry = quantDownloads[key];
		if (entry === undefined) {
			continue;
		}
		entries.push({ modelId: entry.modelId, percent: entry.progress });
	}
	if (entries.length === 0) {
		return null;
	}
	const numericPercents = entries
		.map((e) => e.percent)
		.filter((p): p is number => typeof p === "number");
	const averagePercent =
		numericPercents.length === 0
			? null
			: Math.round(numericPercents.reduce((a, b) => a + b, 0) / numericPercents.length);
	return {
		count: entries.length,
		averagePercent,
		primary: pickPrimary(entries),
	};
}
