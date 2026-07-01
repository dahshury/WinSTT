export interface DownloadEntry {
	modelId: string;
	percent: number | null;
}

export interface DownloadAggregate {
	averagePercent: number | null;
	count: number;
	primary: DownloadEntry;
}

interface SingletonDownload {
	active: boolean;
	modelId: string | null;
	percent: number | null;
}

interface DownloadRecord {
	modelId: string;
	paused?: boolean;
	progress: number | null;
}

export function collectDownloadEntries<TEntry extends DownloadRecord>(
	quantDownloads: Record<string, TEntry>,
	singleton: SingletonDownload,
	options: {
		includeQuant?: ((entry: TEntry) => boolean) | undefined;
		includeSingleton?: boolean;
	} = {},
): DownloadEntry[] {
	const { includeQuant, includeSingleton = true } = options;
	const entries: DownloadEntry[] = [];
	if (includeSingleton && singleton.active && singleton.modelId !== null) {
		entries.push({ modelId: singleton.modelId, percent: singleton.percent });
	}
	for (const key in quantDownloads) {
		if (!Object.hasOwn(quantDownloads, key)) {
			continue;
		}
		const entry = quantDownloads[key];
		if (entry === undefined || entry.paused) {
			continue;
		}
		if (includeQuant === undefined || includeQuant(entry)) {
			entries.push({ modelId: entry.modelId, percent: entry.progress });
		}
	}
	return entries;
}

export function aggregateDownloadEntries(
	entries: readonly DownloadEntry[],
): DownloadAggregate | null {
	const primary = pickPrimary(entries);
	if (primary === null) {
		return null;
	}
	return {
		count: entries.length,
		averagePercent: averageKnownPercent(entries),
		primary,
	};
}

function pickPrimary(entries: readonly DownloadEntry[]): DownloadEntry | null {
	let best = entries[0] ?? null;
	for (let i = 1; i < entries.length; i += 1) {
		const candidate = entries[i];
		if (candidate === undefined) {
			continue;
		}
		if ((candidate.percent ?? -1) > (best?.percent ?? -1)) {
			best = candidate;
		}
	}
	return best;
}

function averageKnownPercent(entries: readonly DownloadEntry[]): number | null {
	const numericPercents = entries
		.map((entry) => entry.percent)
		.filter((percent): percent is number => typeof percent === "number");
	if (numericPercents.length === 0) {
		return null;
	}
	return Math.round(
		numericPercents.reduce((a, b) => a + b, 0) / numericPercents.length,
	);
}
