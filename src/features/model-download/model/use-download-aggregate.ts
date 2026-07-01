import { useDownloadStore } from "./download-store";
import {
	aggregateDownloadEntries,
	collectDownloadEntries,
	type DownloadAggregate,
} from "./download-aggregate";

export type { DownloadAggregate };

export function useDownloadAggregate(): DownloadAggregate | null {
	const quantDownloads = useDownloadStore((s) => s.quantDownloads);
	const singletonName = useDownloadStore((s) => s.modelName);
	const singletonActive = useDownloadStore((s) => s.isDownloading);
	const singletonPercent = useDownloadStore((s) => s.progress);

	const entries = collectDownloadEntries(quantDownloads, {
		active: singletonActive,
		modelId: singletonName,
		percent: singletonPercent,
	});
	return aggregateDownloadEntries(entries);
}
