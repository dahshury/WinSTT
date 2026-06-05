import type { QuantDownloadState } from "./download-store";
import { useDownloadStore } from "./download-store";

interface DownloadEntry {
	modelId: string;
	percent: number | null;
}

/**
 * Aggregate view of every active download in ``quantDownloads`` plus the
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
	/** Count of active downloads (per-quant + the legacy singleton). */
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
function pickPrimary(entries: DownloadEntry[]): DownloadEntry {
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

/**
 * Flatten the legacy singleton slot + the per-quant map into one list of
 * ``{ modelId, percent }`` entries. Pure — extracted from the hook so the
 * reactive body stays a flat "read selectors → collect → aggregate" shape
 * and the branchy collection logic is independently testable.
 */
function collectEntries(
	quantDownloads: Record<string, QuantDownloadState>,
	singleton: { active: boolean; name: string | null; percent: number | null }
): DownloadEntry[] {
	const entries: DownloadEntry[] = [];
	if (singleton.active && singleton.name !== null) {
		entries.push({ modelId: singleton.name, percent: singleton.percent });
	}
	for (const key in quantDownloads) {
		if (!Object.hasOwn(quantDownloads, key)) {
			continue;
		}
		const entry = quantDownloads[key];
		if (entry === undefined || entry.paused) {
			continue;
		}
		entries.push({ modelId: entry.modelId, percent: entry.progress });
	}
	return entries;
}

/**
 * Mean of every entry with a known (numeric) percent, rounded to a whole
 * number. ``null`` when every entry is still indeterminate so the chip can
 * suppress the percent readout. Pure — paired with ``collectEntries``.
 */
function averageKnownPercent(entries: DownloadEntry[]): number | null {
	const numericPercents = entries
		.map((e) => e.percent)
		.filter((p): p is number => typeof p === "number");
	if (numericPercents.length === 0) {
		return null;
	}
	return Math.round(numericPercents.reduce((a, b) => a + b, 0) / numericPercents.length);
}

export function useDownloadAggregate(): DownloadAggregate | null {
	const quantDownloads = useDownloadStore((s) => s.quantDownloads);
	const singletonName = useDownloadStore((s) => s.modelName);
	const singletonActive = useDownloadStore((s) => s.isDownloading);
	const singletonPercent = useDownloadStore((s) => s.progress);

	const entries = collectEntries(quantDownloads, {
		active: singletonActive,
		name: singletonName,
		percent: singletonPercent,
	});
	if (entries.length === 0) {
		return null;
	}
	return {
		count: entries.length,
		averagePercent: averageKnownPercent(entries),
		primary: pickPrimary(entries),
	};
}
